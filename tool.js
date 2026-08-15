/**
 * BunMoji Sprite & Background Helpers
 * Provides sprite label fetching, background listing, and apply functions.
 * No ToolManager registration -- the sidecar handles selection.
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { getRequestHeaders, eventSource, event_types } from '../../../../script.js';
import { sendExpressionCall } from '../../expressions/index.js';
import { getSettings } from './index.js';

// ─── Sprite Label Cache ──────────────────────────────────────────

/** Sprite label cache per character folder name. */
let _spriteCache = new Map();

/**
 * Get the correct sprite folder name for the current character,
 * respecting ST's expression overrides.
 */
export function getSpriteFolderName() {
    const context = getContext();
    // Default to character display name (matches ST's sprite folder convention)
    let folderName = context.name2 || null;

    // Check for expression override by avatar filename
    const charId = context.characterId;
    if (charId !== undefined && charId !== null) {
        const char = context.characters[charId];
        if (char?.avatar) {
            const avatarKey = char.avatar.replace(/\.[^/.]+$/, '');
            const override = extension_settings.expressionOverrides?.find(e => e.name === avatarKey);
            if (override?.path) {
                folderName = override.path;
            }
        }
    }

    return folderName;
}

/**
 * Fetch sprite labels from server for a character folder.
 */
async function fetchSpriteLabels(folderName) {
    if (!folderName) return [];

    if (_spriteCache.has(folderName)) return _spriteCache.get(folderName);

    try {
        const url = `/api/sprites/get?name=${encodeURIComponent(folderName)}`;
        const res = await fetch(url, {
            headers: getRequestHeaders(),
        });
        if (!res.ok) return [];
        const sprites = await res.json();
        const labels = [...new Set(sprites.map(s => s.label))].sort();
        _spriteCache.set(folderName, labels);
        return labels;
    } catch (e) {
        console.error('[BunMoji] Failed to fetch sprites:', e);
        return [];
    }
}

export function invalidateCache() {
    _spriteCache.clear();
}

/**
 * Get cached sprite labels synchronously (for slash command enum providers).
 * Returns empty array if cache is not populated yet for the current character.
 * @returns {string[]}
 */
export function getCachedSpriteLabels() {
    let folderName = getSpriteFolderName();
    if (!folderName) {
        const context = getContext();
        folderName = context.name2 || null;
    }
    if (!folderName) {
        return [];
    }
    const cached = _spriteCache.get(folderName) || [];
    return cached;
}

/**
 * Pre-warm the sprite label cache for the current character.
 * Call on init and chat change so slash command autocomplete works immediately.
 * Tries getSpriteFolderName first, falls back to context.name2.
 */
export async function warmSpriteCache() {
    let folderName = getSpriteFolderName();
    if (!folderName) {
        const context = getContext();
        folderName = context.name2 || null;
    }
    if (folderName) {
        await fetchSpriteLabels(folderName);
    }
}

/**
 * Pre-warm sprite caches for ALL members of the current group.
 */
export async function warmGroupSpriteCache() {
    const context = getContext();
    if (!context.groupId) {
        return warmSpriteCache();
    }

    const group = context.groups?.find(g => g.id === context.groupId);
    if (!group?.members) return;

    const promises = [];
    for (const avatarFile of group.members) {
        const char = context.characters?.find(c => c.avatar === avatarFile);
        if (char?.name) {
            const folderName = getSpriteFolderName();
            if (folderName) {
                promises.push(fetchSpriteLabels(folderName));
            }
        }
    }
    await Promise.all(promises);
}

/**
 * Get available base sprite labels (without conditionals -- sidecar handles those).
 * Returns display labels (aliases where set, file labels otherwise).
 * @returns {Promise<string[]>}
 */
export async function getAvailableLabels() {
    const folderName = getSpriteFolderName();
    const fileLabels = await fetchSpriteLabels(folderName);
    const settings = getSettings();
    const aliases = settings.labelAliases || {};
    const disabled = new Set(settings.disabledLabels || []);

    return fileLabels
        .filter(fl => !disabled.has(fl))
        .map(fl => aliases[fl] || fl)
        .sort();
}

/**
 * Resolve a display label back to the original file label.
 * If no alias matches, returns the input unchanged (it may already be a file label).
 * @param {string} displayLabel - The label shown to the sidecar/user
 * @returns {string} The actual file-based label for sendExpressionCall
 */
export function resolveFileLabel(displayLabel) {
    if (!displayLabel) return displayLabel;
    const settings = getSettings();
    const aliases = settings.labelAliases || {};

    // Check if any file label has this as its alias
    for (const [fileLabel, alias] of Object.entries(aliases)) {
        if (alias === displayLabel) return fileLabel;
    }
    // No alias found — it's already a file label
    return displayLabel;
}

/**
 * Get the alias map: { fileLabel: displayLabel }
 * @returns {Object}
 */
export function getLabelAliases() {
    const settings = getSettings();
    return settings.labelAliases || {};
}

/**
 * Get the display label for a file label.
 * @param {string} fileLabel
 * @returns {string}
 */
export function getDisplayLabel(fileLabel) {
    const settings = getSettings();
    const aliases = settings.labelAliases || {};
    return aliases[fileLabel] || fileLabel;
}

// ─── Background Cache ────────────────────────────────────────────

let _bgCache = null;

/**
 * Fetch the list of available background filenames from ST's gallery.
 * @returns {Promise<string[]>}
 */
export async function fetchBackgroundsList() {
    if (_bgCache) return _bgCache;
    try {
        const res = await fetch('/api/backgrounds/all', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        if (!res.ok) return [];
        const data = await res.json();
        _bgCache = (data.images || []).map(img => typeof img === 'string' ? img : img.filename || img);
        return _bgCache;
    } catch (e) {
        console.error('[BunMoji] Failed to fetch backgrounds:', e);
        return [];
    }
}

export function invalidateBgCache() {
    _bgCache = null;
}

// ─── Apply Functions ─────────────────────────────────────────────

// Matches SillyTavern/public/scripts/backgrounds.js BG_METADATA_KEY -- the chat_metadata
// key holding the currently-locked background url for this chat.
const BG_METADATA_KEY = 'custom_background';

/**
 * Apply a background by emitting FORCE_SET_BACKGROUND.
 * No-ops if the target background is already the active one, to avoid piling up
 * duplicate entries in chat_metadata's background list (ST's handler has no dedup).
 * @param {string} filename - The background filename to set
 */
export async function applyBackground(filename) {
    if (!filename) return;
    const url = `url("backgrounds/${encodeURIComponent(filename)}")`;
    const context = getContext();
    if (context.chatMetadata?.[BG_METADATA_KEY] === url) return;
    await eventSource.emit(event_types.FORCE_SET_BACKGROUND, {
        url,
        path: filename,
    });
}

/**
 * Save a key/value pair to the last AI message's metadata.
 * @param {string} key - Metadata key (e.g. 'bunmoji_expression')
 * @param {*} value - Value to save
 */
export function saveToMetadata(key, value) {
    const context = getContext();
    const lastMsg = context.chat?.slice(-1)?.[0];
    if (lastMsg) {
        if (!lastMsg.extra) lastMsg.extra = {};
        lastMsg.extra[key] = value;
    }
}

// ─── Swipe Restoration Helpers ───────────────────────────────────

/**
 * Restore a saved expression label. Used by swipe/chat restoration.
 * Accepts either a display label (alias) or a file label -- resolves internally.
 * @param {string} expression - The expression label to restore (display or file label)
 */
export async function restoreExpression(expression) {
    if (!expression) return;
    const folderName = getSpriteFolderName();
    if (!folderName) return;
    // Resolve alias -- expression might be a display label
    const fileLabel = resolveFileLabel(expression);
    try {
        await sendExpressionCall(folderName, fileLabel, { force: true });
    } catch (e) {
        console.error('[BunMoji] restoreExpression: sendExpressionCall failed:', e);
    }
}
