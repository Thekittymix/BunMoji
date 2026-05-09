/**
 * BunMoji Sprite & Background Helpers
 * Provides sprite label fetching, background listing, and apply functions.
 * No ToolManager registration -- the sidecar handles selection.
 *
 * Modified: Group chat support — functions accept optional explicit character names.
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { getRequestHeaders, eventSource, event_types } from '../../../../script.js';
import { sendExpressionCall } from '../../expressions/index.js';
import { getSettings } from './index.js';

// ─── Sprite Label Cache ──────────────────────────────────────────

/** Sprite label cache per character folder name. */
let _spriteCache = new Map();

/**
 * Get the correct sprite folder name for a character,
 * respecting ST's expression overrides.
 * @param {string} [charName] - Explicit character name (for group chats). Falls back to context.name2.
 */
export function getSpriteFolderName(charName) {
    const context = getContext();
    // Default to provided name or character display name
    let folderName = charName || context.name2 || null;

    // Check for expression override by avatar filename
    // In group chats, characterId is undefined, so we search by name
    let char = null;
    if (charName) {
        // Find the character object by name
        char = context.characters?.find(c => c.name === charName);
    } else {
        const charId = context.characterId;
        if (charId !== undefined && charId !== null) {
            char = context.characters[charId];
        }
    }

    if (char?.avatar) {
        const avatarKey = char.avatar.replace(/\.[^/.]+$/, '');
        const override = extension_settings.expressionOverrides?.find(e => e.name === avatarKey);
        if (override?.path) {
            folderName = override.path;
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
 * @param {string} [charName] - Optional character name for group chats.
 * @returns {string[]}
 */
export function getCachedSpriteLabels(charName) {
    let folderName = getSpriteFolderName(charName);
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
 * @param {string} [charName] - Optional character name for group chats.
 */
export async function warmSpriteCache(charName) {
    let folderName = getSpriteFolderName(charName);
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
            const folderName = getSpriteFolderName(char.name);
            if (folderName) {
                promises.push(fetchSpriteLabels(folderName));
            }
        }
    }
    await Promise.all(promises);
}

/**
 * Get available base sprite labels (without conditionals).
 * @param {string} [charName] - Optional character name for group chats.
 * @returns {Promise<string[]>}
 */
export async function getAvailableLabels(charName) {
    const folderName = getSpriteFolderName(charName);
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
 * @param {string} displayLabel
 * @returns {string}
 */
export function resolveFileLabel(displayLabel) {
    if (!displayLabel) return displayLabel;
    const settings = getSettings();
    const aliases = settings.labelAliases || {};

    for (const [fileLabel, alias] of Object.entries(aliases)) {
        if (alias === displayLabel) return fileLabel;
    }
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

/**
 * Apply a background by emitting FORCE_SET_BACKGROUND.
 * @param {string} filename - The background filename to set
 */
export async function applyBackground(filename) {
    if (!filename) return;
    await eventSource.emit(event_types.FORCE_SET_BACKGROUND, {
        url: `url("backgrounds/${encodeURIComponent(filename)}")`,
        path: filename,
    });
}

/**
 * Save a key/value pair to the last AI message's metadata.
 * @param {string} key
 * @param {*} value
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
 * Restore a saved expression label.
 * @param {string} expression - The expression label to restore
 * @param {string} [charName] - Optional character name for group chats
 */
export async function restoreExpression(expression, charName) {
    if (!expression) return;
    const folderName = getSpriteFolderName(charName);
    if (!folderName) return;
    const fileLabel = resolveFileLabel(expression);
    try {
        await sendExpressionCall(folderName, fileLabel, { force: true });
    } catch (e) {
        console.error('[BunMoji] restoreExpression: sendExpressionCall failed:', e);
    }
}
