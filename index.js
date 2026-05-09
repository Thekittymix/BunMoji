/**
 * BunMoji -- Sidecar-Driven Sprite Expressions
 * A sidecar LLM picks character expressions and scene backgrounds before the main model generates.
 *
 * Modified: Group chat support + Expression Tool toggle (background-only mode)
 */

import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders, saveChatConditional } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { invalidateCache, invalidateBgCache, restoreExpression, applyBackground, getDisplayLabel, resolveFileLabel, getCachedSpriteLabels, warmSpriteCache, saveToMetadata, getSpriteFolderName, warmGroupSpriteCache } from './tool.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandArgument, ARGUMENT_TYPE } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue, enumTypes } from '../../../slash-commands/SlashCommandEnumValue.js';
import { runDiagnostics } from './diagnostics.js';
import { runSidecar } from './sidecar-eval.js';
import { initActivityFeed } from './activity-feed.js';
// llm-sidecar.js is used by sidecar-eval.js and diagnostics.js directly
import { EVALUABLE_TYPES, CONDITION_LABELS } from './conditions.js';

const EXTENSION_NAME = 'bunmoji';
const MODULE_NAME = 'BunMoji';

// ─── Generation State ────────────────────────────────────────────
let _savedExpressionApi = null;
let _slashCommandCooldown = 0;
/**
 * Track which character the sidecar already ran for this turn.
 * In solo chats: set to the single character name after running.
 * In group chats: set per-character, reset when a new user message arrives.
 */
let _sidecarRanForChars = new Set();
let _lastUserMessageId = -1;
let _pendingSidecarExpression = null;
let _pendingSidecarBackground = null;

// ─── Settings ────────────────────────────────────────────────────

const SETTING_DEFAULTS = {
    enabled: false,
    expressionToolEnabled: true, // NEW: toggle expressions separately from backgrounds
    conditionalSprites: [],
    connectionProfile: null,
    sidecarTemperature: 0.2,
    sidecarMaxTokens: 1024,
    fallbackExpression: 'neutral',
    bgToolEnabled: false,
    conditionalBackgrounds: [],
    labelAliases: {},
    disabledLabels: [],
    disabledConditionals: [],
    showCurrentState: true,
    contextMessages: 10,
    evalTiming: 'before',  // 'before' or 'after'
};

function ensureSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = {};
    }
    const s = extension_settings[EXTENSION_NAME];
    for (const [key, val] of Object.entries(SETTING_DEFAULTS)) {
        if (s[key] === undefined || s[key] === null) {
            s[key] = typeof val === 'object' && val !== null
                ? JSON.parse(JSON.stringify(val))
                : val;
        }
    }

    // Migrate old conditions[] + logic format to conditionGroups[][]
    for (const cs of (s.conditionalSprites || [])) {
        if (cs.conditions && !cs.conditionGroups) {
            cs.conditionGroups = cs.conditions.length > 0 ? [cs.conditions] : [];
            delete cs.conditions;
            delete cs.logic;
        }
    }
    for (const cb of (s.conditionalBackgrounds || [])) {
        if (cb.conditions && !cb.conditionGroups) {
            cb.conditionGroups = cb.conditions.length > 0 ? [cb.conditions] : [];
            delete cb.conditions;
            delete cb.logic;
        }
    }
}

export function getSettings() {
    ensureSettings();
    return extension_settings[EXTENSION_NAME];
}

export function saveSettings() {
    saveSettingsDebounced();
}

// ─── Group Chat Helpers ─────────────────────────────────────────

/**
 * Check if the current chat is a group chat.
 * @returns {boolean}
 */
export function isGroupChat() {
    const context = getContext();
    return !!context.groupId;
}

/**
 * Get all character names in the current group.
 * @returns {string[]}
 */
export function getGroupMemberNames() {
    const context = getContext();
    if (!context.groupId) return [];
    const group = context.groups?.find(g => g.id === context.groupId);
    if (!group?.members) return [];
    return group.members
        .map(avatarFile => {
            const char = context.characters?.find(c => c.avatar === avatarFile);
            return char?.name || null;
        })
        .filter(Boolean);
}

/**
 * Check if a chat has any active character (solo or group).
 * @returns {boolean}
 */
function hasActiveChat() {
    const context = getContext();
    if (context.groupId) return true; // Group chats always have members
    return context.characterId !== undefined && context.characterId !== null;
}

/**
 * Get the name of the character currently being responded for.
 * In solo chats, this is context.name2.
 * In group chats, this is also context.name2 (ST sets it to the current responder).
 * @returns {string|null}
 */
function getCurrentCharName() {
    const context = getContext();
    return context.name2 || null;
}

// ─── Connection Profile ──────────────────────────────────────────

/**
 * Look up a Connection Manager profile by ID (or name for backwards compat).
 */
export function findConnectionProfile(profileId) {
    if (!profileId) return null;
    const profiles = getConnectionProfiles();
    return profiles.find(p => p.id === profileId) || profiles.find(p => p.name === profileId) || null;
}

function getConnectionProfiles() {
    return extension_settings?.connectionManager?.profiles || [];
}

export function listConnectionProfiles() {
    return getConnectionProfiles().map(p => ({ id: p.id, name: p.name }));
}

/**
 * Store the sidecar's picks to be saved to the AI message when generation ends.
 * Called from sidecar-eval.js instead of saveToMetadata (which writes to the wrong message).
 */
export function setPendingSidecarResult(expression, background) {
    _pendingSidecarExpression = expression || null;
    _pendingSidecarBackground = background || null;
}

// ─── Classifier Suppression ──────────────────────────────────────

function suppressClassifier() {
    const settings = getSettings();
    // Only suppress if expression tool is enabled — otherwise let ST's classifier handle expressions
    if (!settings.expressionToolEnabled) return;

    if (extension_settings.expressions) {
        _savedExpressionApi = extension_settings.expressions.api;
        extension_settings.expressions.api = 99; // EXPRESSION_API.none
        console.log(`[${MODULE_NAME}] Suppressed ST classifier (was: ${_savedExpressionApi})`);
    }
}

function restoreClassifier() {
    if (_savedExpressionApi !== null && extension_settings.expressions) {
        extension_settings.expressions.api = _savedExpressionApi;
        console.log(`[${MODULE_NAME}] Restored ST classifier to: ${_savedExpressionApi}`);
        _savedExpressionApi = null;
    }
}

// ─── Slash Command Override ──────────────────────────────────────

/**
 * Register (or re-register) the /bm and /bunmoji slash commands under BunMoji.
 */
function registerSlashCommands() {
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'bm',
            aliases: ['bunmoji'],
            callback: async (_args, expression) => {
                _slashCommandCooldown = Date.now();
                expression = String(expression || '').trim();
                if (!expression) {
                    toastr.warning('No expression specified.', MODULE_NAME);
                    return '';
                }
                await restoreExpression(expression);
                // Save to metadata so swipe/reload restores this manual pick
                saveToMetadata('bunmoji_expression', expression);
                await saveChatConditional();
                return '';
            },
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: 'The expression label or alias to set.',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                    enumProvider: () => {
                        const settings = getSettings();
                        const fileLabels = getCachedSpriteLabels();
                        const disabled = new Set(settings.disabledLabels || []);

                        return fileLabels
                            .filter(fl => !disabled.has(fl))
                            .map(fl => {
                                const dl = getDisplayLabel(fl);
                                const isAlias = dl !== fl;
                                return new SlashCommandEnumValue(
                                    dl,
                                    isAlias ? `file: ${fl}` : null,
                                    enumTypes.enum,
                                    'D',
                                );
                            });
                    },
                }),
            ],
            helpString: 'Sets the character expression via BunMoji. Supports aliases.',
        }));
        console.log(`[${MODULE_NAME}] Registered /bm and /bunmoji slash commands.`);
    } catch (e) {
        console.error(`[${MODULE_NAME}] Failed to register slash commands:`, e);
    }
}

// ─── Sprite Upload ───────────────────────────────────────────────

function labelFromFilename(filename) {
    return filename.replace(/\.[^/.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

async function uploadSprite(file, label) {
    const context = getContext();
    const charName = context.name2;
    if (!charName) return;

    const form = new FormData();
    form.append('name', charName);
    form.append('label', label);
    form.append('avatar', file, file.name);

    const headers = getRequestHeaders();
    delete headers['Content-Type'];

    await fetch('/api/sprites/upload', {
        method: 'POST',
        headers,
        body: form,
    });

    // Register as a custom expression in ST so it appears in spriteCache
    ensureCustomExpression(label);
}

/**
 * Sync all current sprite labels to ST's custom expressions list.
 */
async function syncCustomExpressions() {
    const sprites = await fetchSprites();
    const labels = [...new Set(sprites.map(s => s.label))];
    let added = 0;
    for (const label of labels) {
        if (ensureCustomExpression(label)) added++;
    }
    if (added > 0) {
        eventSource.emit(event_types.CHAT_CHANGED);
    }
}

/**
 * @returns {boolean} true if a new custom expression was added
 */
function ensureCustomExpression(label) {
    if (!label) return false;
    const defaults = new Set([
        'admiration', 'amusement', 'anger', 'annoyance', 'approval', 'caring',
        'confusion', 'curiosity', 'desire', 'disappointment', 'disapproval', 'disgust',
        'embarrassment', 'excitement', 'fear', 'gratitude', 'grief', 'joy', 'love',
        'nervousness', 'optimism', 'pride', 'realization', 'relief', 'remorse',
        'sadness', 'surprise', 'neutral',
    ]);

    if (defaults.has(label.toLowerCase())) return false;

    if (!extension_settings.expressions) return false;
    if (!Array.isArray(extension_settings.expressions.custom)) {
        extension_settings.expressions.custom = [];
    }
    if (!extension_settings.expressions.custom.includes(label)) {
        extension_settings.expressions.custom.push(label);
        saveSettingsDebounced();
        return true;
    }
    return false;
}

async function handleFileUpload(files) {
    const context = getContext();
    if (!context.name2) {
        toastr.warning('No active character to upload sprites for.', MODULE_NAME);
        return;
    }

    let uploaded = 0;
    for (const file of files) {
        if (file.name.endsWith('.zip') || file.type === 'application/zip') {
            try {
                const count = await uploadSpriteZip(file);
                uploaded += count;
            } catch (e) {
                console.error(`[${MODULE_NAME}] Failed to upload ZIP ${file.name}:`, e);
                toastr.error(`ZIP upload failed: ${e.message}`, MODULE_NAME);
            }
        } else if (file.type.startsWith('image/')) {
            const label = labelFromFilename(file.name);
            try {
                await uploadSprite(file, label);
                uploaded++;
            } catch (e) {
                console.error(`[${MODULE_NAME}] Failed to upload ${file.name}:`, e);
            }
        }
    }

    if (uploaded > 0) {
        invalidateCache();
        await renderExpressionGrid();
        toastr.success(`Uploaded ${uploaded} sprite(s).`, MODULE_NAME);
    }
}

async function handleConditionalSpriteUpload(files) {
    const context = getContext();
    if (!context.name2) {
        toastr.warning('No active character to upload sprites for.', MODULE_NAME);
        return;
    }

    let added = 0;
    const settings = getSettings();

    for (const file of files) {
        if (file.name.endsWith('.zip') || file.type === 'application/zip') {
            try {
                const count = await uploadSpriteZip(file);
                added += count;
            } catch (e) {
                console.error(`[${MODULE_NAME}] Failed to upload ZIP ${file.name}:`, e);
                toastr.error(`ZIP upload failed: ${e.message}`, MODULE_NAME);
            }
        } else if (file.type.startsWith('image/')) {
            const label = labelFromFilename(file.name);
            try {
                await uploadSprite(file, label);

                const existing = settings.conditionalSprites.find(cs => cs.label === label);
                if (!existing) {
                    settings.conditionalSprites.push({ label, conditionGroups: [] });
                }
                added++;
            } catch (e) {
                console.error(`[${MODULE_NAME}] Failed to upload ${file.name}:`, e);
            }
        }
    }

    if (added > 0) {
        saveSettings();
        invalidateCache();
        await renderExpressionGrid();
        await renderConditionalSprites();
        toastr.success(`Added ${added} conditional sprite(s).`, MODULE_NAME);
    }
}

async function uploadSpriteZip(file) {
    const context = getContext();
    const charName = context.name2;
    if (!charName) return 0;

    const form = new FormData();
    form.append('name', charName);
    form.append('avatar', file, file.name);

    const headers = getRequestHeaders();
    delete headers['Content-Type'];

    const res = await fetch('/api/sprites/upload-zip', {
        method: 'POST',
        headers,
        body: form,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => 'Unknown error');
        throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const data = await res.json();
    return data.count || 0;
}

// ─── Event Handlers ──────────────────────────────────────────────

async function onChatCompletionReady(data) {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (settings.evalTiming === 'after') return; // After-gen mode — skip pre-gen

    const context = getContext();
    const lastMsg = context.chat?.slice(-1)?.[0];

    // Reset per-character tracking when a new user message arrives
    if (lastMsg?.is_user) {
        const msgId = context.chat.length - 1;
        if (msgId !== _lastUserMessageId) {
            _lastUserMessageId = msgId;
            _sidecarRanForChars.clear();
        }
    }

    const charName = getCurrentCharName();
    if (!charName) return;

    // Skip if we already ran sidecar for this character this turn
    if (_sidecarRanForChars.has(charName)) return;

    if (_slashCommandCooldown && Date.now() - _slashCommandCooldown < 3000) {
        _slashCommandCooldown = 0;
        return;
    }

    if (lastMsg?.extra?.tool_invocations != null) return;

    // Check if we have anything to do — need either sprites (if expressions enabled) or backgrounds
    const expressionsEnabled = settings.expressionToolEnabled;
    const backgroundsEnabled = settings.bgToolEnabled;

    if (expressionsEnabled) {
        const cached = getCachedSpriteLabels();
        if (cached.length === 0 && !backgroundsEnabled) return;
    } else if (!backgroundsEnabled) {
        return; // Neither expressions nor backgrounds enabled
    }

    _sidecarRanForChars.add(charName);
    await runSidecar(charName);
}


/**
 * Called on MESSAGE_RECEIVED — the AI message is now in chat.
 * Save the sidecar's pending picks to this message's metadata.
 */
async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;

    const context = getContext();
    const msg = context.chat?.[messageId];

    // After-gen mode: run sidecar now that the AI response is complete
    if (settings.evalTiming === 'after' && msg && !msg.is_user) {
        const charName = msg.name || getCurrentCharName();
        if (!charName) return;
        if (_sidecarRanForChars.has(charName)) return;

        const expressionsEnabled = settings.expressionToolEnabled;
        const backgroundsEnabled = settings.bgToolEnabled;

        if (expressionsEnabled) {
            if (getCachedSpriteLabels().length === 0 && !backgroundsEnabled) return;
        } else if (!backgroundsEnabled) {
            return;
        }

        if (_slashCommandCooldown && Date.now() - _slashCommandCooldown < 3000) {
            _slashCommandCooldown = 0;
            return;
        }
        _sidecarRanForChars.add(charName);
        await runSidecar(charName);
    }

    // Save pending sidecar picks to the new AI message
    if (msg && !msg.is_user && (_pendingSidecarExpression || _pendingSidecarBackground)) {
        if (!msg.extra) msg.extra = {};
        if (_pendingSidecarExpression) msg.extra.bunmoji_expression = _pendingSidecarExpression;
        if (_pendingSidecarBackground) msg.extra.bunmoji_background = _pendingSidecarBackground;
    }
    _pendingSidecarExpression = null;
    _pendingSidecarBackground = null;
}

async function applyFallbackIfNeeded() {
    const settings = getSettings();
    if (!settings.enabled || !settings.expressionToolEnabled) return;

    const context = getContext();
    const recentWithExpr = [...(context.chat || [])].reverse().find(m => m.extra?.bunmoji_expression);

    if (!recentWithExpr) {
        const fallback = settings.fallbackExpression || 'neutral';
        try {
            await restoreExpression(fallback);
        } catch (e) {
            console.error(`[${MODULE_NAME}] Failed to apply fallback expression:`, e);
        }
    }
}

// ─── Swipe / Chat Restoration ────────────────────────────────────

/**
 * Read the last AI message's metadata and re-apply saved expression/background.
 */
async function restoreFromMetadata() {
    if (!getSettings().enabled) return;

    const context = getContext();
    const settings = getSettings();

    // Expression restoration (only if expression tool is enabled)
    if (settings.expressionToolEnabled) {
        const recentWithExpr = [...(context.chat || [])].reverse().find(m => m.extra?.bunmoji_expression);
        const savedExpression = recentWithExpr?.extra?.bunmoji_expression;
        if (savedExpression) {
            await restoreExpression(savedExpression);
        }
    }

    // Background restoration
    const recentWithBg = [...(context.chat || [])].reverse().find(m => m.extra?.bunmoji_background);
    const savedBg = recentWithBg?.extra?.bunmoji_background;
    if (savedBg && settings.bgToolEnabled) {
        try {
            await applyBackground(savedBg);
        } catch (e) {
            console.error(`[${MODULE_NAME}] Failed to restore background:`, e);
        }
    }
}

// ─── UI Rendering ────────────────────────────────────────────────

async function fetchSprites() {
    const context = getContext();
    const charName = context.name2;
    if (!charName) return [];
    try {
        const res = await fetch(`/api/sprites/get?name=${encodeURIComponent(charName)}`, {
            headers: getRequestHeaders(),
        });
        return res.ok ? await res.json() : [];
    } catch { return []; }
}

async function renderExpressionGrid() {
    const $grid = $('#bm_label_grid');
    if (!$grid.length) return;

    const context = getContext();
    const hasChat = hasActiveChat();

    // Fade entire panel when no character/group is active
    $('#bm_main_controls').toggleClass('bm-no-character', !hasChat);

    if (!hasChat) {
        $grid.html(`
            <div class="bm-empty-state">
                <i class="fa-solid fa-comment-dots"></i>
                <div>Please open a chat to begin.</div>
            </div>
        `);
        return;
    }

    // In group chats, show info about the current character context
    const inGroup = isGroupChat();
    const charName = getCurrentCharName();

    if (inGroup && !charName) {
        $grid.html(`
            <div class="bm-empty-state">
                <i class="fa-solid fa-users"></i>
                <div>Group chat active. Sprites shown for the last responding character.</div>
            </div>
        `);
        return;
    }

    const sprites = await fetchSprites();
    const labels = [...new Set(sprites.map(s => s.label))].sort();
    const settings = getSettings();

    if (labels.length === 0) {
        $grid.html(`
            <div class="bm-empty-state">
                <i class="fa-solid fa-image"></i>
                <div>No sprites found for "${charName}".</div>
                <div>Upload images above or add sprites to the character's folder.</div>
            </div>
        `);
        return;
    }

    const conditionalLabels = new Set((settings.conditionalSprites || []).map(cs => cs.label));

    const cards = labels.map(label => {
        const sprite = sprites.find(s => s.label === label);
        const displayLabel = getDisplayLabel(label);
        const isDisabled = (settings.disabledLabels || []).includes(label);
        const isConditional = conditionalLabels.has(label);
        return `
            <div class="bm-sprite-card ${isDisabled ? 'bm-sprite-disabled' : ''}" data-label="${label}" title="${displayLabel}${isDisabled ? ' (disabled)' : ''}">
                <img class="bm-sprite-thumb" src="${sprite?.path || ''}" alt="${displayLabel}" />
                <span class="bm-sprite-label bm-editable-label" data-file-label="${label}">${displayLabel}</span>
                ${!isConditional ? `<button class="bm-sprite-promote" data-file-label="${label}" title="Move to conditionals"><i class="fa-solid fa-arrow-right"></i></button>` : ''}
                <button class="bm-sprite-toggle" data-file-label="${label}" title="${isDisabled ? 'Enable' : 'Disable'}">
                    <i class="fa-solid ${isDisabled ? 'fa-eye-slash' : 'fa-eye'}"></i>
                </button>
            </div>
        `;
    }).join('');

    // Add group indicator at top if in group chat
    let groupHeader = '';
    if (inGroup) {
        groupHeader = `<div class="bm-group-indicator" style="grid-column: 1 / -1; text-align: center; font-size: 10px; opacity: 0.6; padding: 4px 0;">
            <i class="fa-solid fa-users" style="margin-right: 4px;"></i>Group chat — showing sprites for: <strong>${charName}</strong>
        </div>`;
    }

    $grid.html(groupHeader + cards);

    // Populate fallback expression dropdown
    const $fallback = $('#bm_fallback_expression');
    if ($fallback.length && labels.length > 0) {
        let fallbackHtml = '';
        for (const label of labels) {
            const dl = getDisplayLabel(label);
            const selected = dl === (settings.fallbackExpression || 'neutral') ? 'selected' : '';
            fallbackHtml += `<option value="${dl}" ${selected}>${dl}</option>`;
        }
        $fallback.html(fallbackHtml);
    }
}

async function renderConditionalSprites() {
    const $list = $('#bm_conditional_sprites_list');
    if (!$list.length) return;

    const settings = getSettings();
    const conditionals = settings.conditionalSprites || [];

    if (conditionals.length === 0) {
        $list.html(`
            <div class="bm-empty-state">
                <div>No conditional sprites defined.</div>
                <div>Upload images above to add conditional sprites.</div>
            </div>
        `);
        return;
    }

    // Fetch sprites to get thumbnail paths
    const sprites = await fetchSprites();
    const spriteMap = {};
    for (const s of sprites) {
        if (!spriteMap[s.label]) spriteMap[s.label] = s.path;
    }

    const cards = conditionals.map((cs, i) => {
        const groups = cs.conditionGroups || [];
        const thumbPath = spriteMap[cs.label] || '';
        const displayLabel = getDisplayLabel(cs.label);
        const isCondDisabled = (settings.disabledConditionals || []).includes(cs.label);
        const pillsHtml = buildPillsHtml(groups, false);

        return `
            <div class="bm-cond-sprite-card ${isCondDisabled ? 'bm-cond-sprite-disabled' : ''}" data-cond-index="${i}">
                <div class="bm-cond-sprite-row">
                    ${thumbPath
                        ? `<img class="bm-cond-sprite-thumb" src="${thumbPath}" alt="${displayLabel}" />`
                        : `<div class="bm-cond-sprite-thumb" style="display:flex;align-items:center;justify-content:center;"><i class="fa-solid fa-image" style="opacity:0.3;"></i></div>`
                    }
                    <div class="bm-cond-sprite-info">
                        <div class="bm-cond-sprite-label">${displayLabel || '(unnamed)'}</div>
                        <div class="bm-cond-tags">${pillsHtml}</div>
                    </div>
                    <div class="bm-cond-sprite-actions">
                        <button class="bm-cond-toggle" data-file-label="${cs.label}" title="${isCondDisabled ? 'Enable' : 'Disable'}">
                            <i class="fa-solid ${isCondDisabled ? 'fa-eye-slash' : 'fa-eye'}"></i>
                        </button>
                        <button class="bm-cond-demote" title="Move to labels"><i class="fa-solid fa-arrow-up"></i></button>
                        <button class="bm-cond-edit" title="Edit conditions"><i class="fa-solid fa-plus-circle"></i></button>
                        <button class="bm-cond-remove" title="Remove"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    $list.html(cards);
}

// ─── Background Gallery & Conditionals ──────────────────────────

async function renderBgGallery() {
    const $gallery = $('#bm_bg_gallery');
    if (!$gallery.length) return;

    const settings = getSettings();

    try {
        const res = await fetch('/api/backgrounds/all', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        if (!res.ok) { $gallery.html(''); return; }
        const data = await res.json();
        const images = data.images || [];

        if (images.length === 0) {
            $gallery.html('<div class="bm-empty-state">No backgrounds found in gallery.</div>');
            return;
        }

        const conditioned = new Set((settings.conditionalBackgrounds || []).map(cb => cb.filename));

        const cards = images.map(img => {
            const filename = typeof img === 'string' ? img : img.filename || '';
            if (!filename) return '';
            const isConditioned = conditioned.has(filename);
            const thumbPath = `backgrounds/${encodeURIComponent(filename)}`;
            return `
                <div class="bm-bg-card ${isConditioned ? 'bm-bg-conditioned' : ''}" data-filename="${filename}" title="${filename}">
                    <img class="bm-bg-thumb" src="${thumbPath}" alt="${filename}" loading="lazy" />
                    <span class="bm-bg-label">${filename}</span>
                    ${!isConditioned ? '<button class="bm-bg-add-cond" title="Add conditions"><i class="fa-solid fa-plus"></i></button>' : ''}
                </div>
            `;
        }).join('');

        $gallery.html(cards);
    } catch {
        $gallery.html('');
    }
}

function renderConditionalBackgrounds() {
    const $list = $('#bm_bg_conditionals_list');
    if (!$list.length) return;

    const settings = getSettings();
    const conditionals = settings.conditionalBackgrounds || [];

    if (conditionals.length === 0) {
        $list.html('');
        return;
    }

    const cards = conditionals.map((cb, i) => {
        const groups = cb.conditionGroups || [];
        const pillsHtml = buildPillsHtml(groups, false);
        const thumbPath = `backgrounds/${encodeURIComponent(cb.filename || '')}`;
        return `
            <div class="bm-cond-bg-card" data-bg-index="${i}">
                <div class="bm-cond-sprite-row">
                    <img class="bm-cond-sprite-thumb" src="${thumbPath}" alt="${cb.filename || ''}" />
                    <div class="bm-cond-sprite-info">
                        <div class="bm-cond-sprite-label">${cb.filename || '(unnamed)'}</div>
                        <div class="bm-cond-tags">${pillsHtml}</div>
                    </div>
                    <div class="bm-cond-sprite-actions">
                        <button class="bm-bg-cond-edit" title="Edit conditions"><i class="fa-solid fa-plus-circle"></i></button>
                        <button class="bm-bg-cond-delete" title="Remove"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    $list.html(cards);
}


function renderConnectionProfiles() {
    const $select = $('#bm_connection_profile');
    if (!$select.length) return;

    const settings = getSettings();
    const profiles = listConnectionProfiles();

    let html = '<option value="">None (sidecar disabled)</option>';
    for (const p of profiles) {
        const selected = p.id === settings.connectionProfile ? 'selected' : '';
        html += `<option value="${p.id}" ${selected}>${p.name || p.id}</option>`;
    }
    $select.html(html);
}

// ─── Tag-Pill Condition Editor ────────────────────────────────────

/**
 * Build HTML for condition pills with OR separators between groups.
 */
function buildPillsHtml(groups, editable = false) {
    if (!groups || groups.length === 0) return '<span class="bm-cond-empty-hint">No conditions set</span>';

    let html = '';
    for (let g = 0; g < groups.length; g++) {
        if (g > 0) html += '<span class="bm-cond-or">OR</span>';
        const group = groups[g];
        for (let i = 0; i < group.length; i++) {
            const c = group[i];
            const typeLabel = CONDITION_LABELS[c.type] || c.type;
            const truncVal = c.value.length > 30 ? c.value.slice(0, 30) + '...' : c.value;
            const pillText = c.type === 'freeform'
                ? `${c.negated ? '!' : ''}"${truncVal}"`
                : `${c.negated ? '!' : ''}${typeLabel}: ${truncVal}`;
            const fullText = `${c.negated ? '!' : ''}${typeLabel}: ${c.value}`;
            html += `<span class="bm-cond-pill${c.negated ? ' bm-cond-negated' : ''}" data-group="${g}" data-idx="${i}" title="${fullText}">${pillText}${editable ? ' <span class="bm-pill-x">\u00d7</span>' : ''}</span>`;
        }
    }
    return html;
}

function toggleTagEditor(index) {
    const $card = $(`.bm-cond-sprite-card[data-cond-index="${index}"]`);
    if (!$card.length) return;

    // Close any existing editor
    $('.bm-tag-editor').remove();

    if ($card.data('editor-open')) {
        $card.data('editor-open', false);
        return;
    }

    $('.bm-cond-sprite-card').data('editor-open', false);
    $card.data('editor-open', true);

    const settings = getSettings();
    const cs = settings.conditionalSprites[index];
    if (!cs) return;

    const groups = cs.conditionGroups || [];
    const workingGroups = JSON.parse(JSON.stringify(groups));
    $card.data('working-groups', workingGroups);

    const pillsHtml = buildPillsHtml(workingGroups, true);

    const typeOptions = [...EVALUABLE_TYPES].map(t =>
        `<option value="${t}">${CONDITION_LABELS[t] || t}</option>`
    ).join('');

    const editorHtml = `
        <div class="bm-tag-editor" data-cond-index="${index}" data-cond-type="sprite">
            <div class="bm-tag-display">${pillsHtml}</div>
            <div class="bm-tag-add-row">
                <button class="bm-tag-negate-btn" title="Toggle NOT">!</button>
                <select class="bm-tag-type">${typeOptions}</select>
                <input class="bm-tag-value" placeholder="value..." />
                <button class="bm-tag-add-btn" title="Add to current group">+</button>
                <button class="bm-tag-or-btn" title="Start new OR group">OR</button>
            </div>
            <div class="bm-tag-actions">
                <button class="bm-tag-save bm-btn bm-btn-secondary" style="flex:1;">Save</button>
                <button class="bm-tag-cancel bm-btn bm-btn-secondary" style="flex:0 0 auto;">Cancel</button>
            </div>
        </div>
    `;

    $card.append(editorHtml);
}

function toggleBgTagEditor(index) {
    const $card = $(`.bm-cond-bg-card[data-bg-index="${index}"]`);
    if (!$card.length) return;

    $('.bm-tag-editor').remove();

    if ($card.data('editor-open')) {
        $card.data('editor-open', false);
        return;
    }

    $('.bm-cond-bg-card').data('editor-open', false);
    $card.data('editor-open', true);

    const settings = getSettings();
    const cb = settings.conditionalBackgrounds[index];
    if (!cb) return;

    const groups = cb.conditionGroups || [];
    const workingGroups = JSON.parse(JSON.stringify(groups));
    $card.data('working-groups', workingGroups);

    const pillsHtml = buildPillsHtml(workingGroups, true);

    const typeOptions = [...EVALUABLE_TYPES].map(t =>
        `<option value="${t}">${CONDITION_LABELS[t] || t}</option>`
    ).join('');

    const editorHtml = `
        <div class="bm-tag-editor" data-cond-index="${index}" data-cond-type="bg">
            <div class="bm-tag-display">${pillsHtml}</div>
            <div class="bm-tag-add-row">
                <button class="bm-tag-negate-btn" title="Toggle NOT">!</button>
                <select class="bm-tag-type">${typeOptions}</select>
                <input class="bm-tag-value" placeholder="value..." />
                <button class="bm-tag-add-btn" title="Add to current group">+</button>
                <button class="bm-tag-or-btn" title="Start new OR group">OR</button>
            </div>
            <div class="bm-tag-actions">
                <button class="bm-tag-save bm-btn bm-btn-secondary" style="flex:1;">Save</button>
                <button class="bm-tag-cancel bm-btn bm-btn-secondary" style="flex:0 0 auto;">Cancel</button>
            </div>
        </div>
    `;

    $card.append(editorHtml);
}

// ─── Event Bindings ──────────────────────────────────────────────

function bindUIEvents() {
    // Header toggle
    $('#bm_header_toggle').on('click', function () {
        $(this).toggleClass('expanded');
        $(this).closest('.bm-container').find('.bm-settings-body').slideToggle(200);
    });

    // Global enable
    $('#bm_global_enabled').on('change', async function () {
        const settings = getSettings();
        settings.enabled = $(this).prop('checked');
        saveSettings();
        $('#bm_main_controls').toggle(settings.enabled);
        if (settings.enabled) {
            suppressClassifier();
            registerSlashCommands();
            if (isGroupChat()) {
                await warmGroupSpriteCache();
            } else {
                await warmSpriteCache();
            }
            await syncCustomExpressions();
            await renderExpressionGrid();
            await renderConditionalSprites();
            if (settings.bgToolEnabled) {
                await renderBgGallery();
                renderConditionalBackgrounds();
            }
        } else {
            restoreClassifier();
        }
    });

    // Expression tool toggle
    $('#bm_expression_enabled').on('change', async function () {
        const settings = getSettings();
        settings.expressionToolEnabled = $(this).prop('checked');
        saveSettings();

        // Toggle classifier suppression based on expression tool state
        if (settings.enabled) {
            if (settings.expressionToolEnabled) {
                suppressClassifier();
            } else {
                restoreClassifier();
            }
        }

        // Toggle visibility of expression-related UI sections
        updateExpressionSectionsVisibility();
    });

    // Collapsible sections
    $('.bm-card-header-collapsible').on('click', function () {
        $(this).toggleClass('expanded');
        $(this).next('.bm-card-body').slideToggle(200);
    });

    // Drop zone
    const $dropZone = $('#bm_drop_zone');
    $dropZone.on('click', () => $('#bm_file_input').trigger('click'));
    $dropZone.on('dragover', (e) => { e.preventDefault(); $dropZone.addClass('dragover'); });
    $dropZone.on('dragleave drop', () => $dropZone.removeClass('dragover'));
    $dropZone.on('drop', async (e) => {
        e.preventDefault();
        const files = e.originalEvent.dataTransfer?.files;
        if (files?.length) await handleFileUpload(files);
    });

    // File input
    $('#bm_file_input').on('change', async function () {
        if (this.files?.length) await handleFileUpload(this.files);
        $(this).val('');
    });

    // Browse button
    $('#bm_upload_sprites').on('click', () => $('#bm_file_input').trigger('click'));

    // Refresh
    $('#bm_refresh_labels').on('click', async () => {
        invalidateCache();
        await renderExpressionGrid();
        toastr.info('Refreshed expressions.', MODULE_NAME);
    });

    // Conditional sprite drop zone
    const $condDropZone = $('#bm_cond_drop_zone');
    $condDropZone.on('click', () => $('#bm_cond_file_input').trigger('click'));
    $condDropZone.on('dragover', (e) => { e.preventDefault(); $condDropZone.addClass('dragover'); });
    $condDropZone.on('dragleave drop', () => $condDropZone.removeClass('dragover'));
    $condDropZone.on('drop', async (e) => {
        e.preventDefault();
        const files = e.originalEvent.dataTransfer?.files;
        if (files?.length) await handleConditionalSpriteUpload(files);
    });

    // Conditional sprite file input
    $('#bm_cond_file_input').on('change', async function () {
        if (this.files?.length) await handleConditionalSpriteUpload(this.files);
        $(this).val('');
    });

    // Conditional sprite browse button
    $('#bm_cond_upload').on('click', () => $('#bm_cond_file_input').trigger('click'));

    // Edit conditions on conditional sprite
    $(document).on('click', '.bm-cond-edit', function (e) {
        e.stopPropagation();
        const index = parseInt($(this).closest('.bm-cond-sprite-card').data('cond-index'), 10);
        toggleTagEditor(index);
    });

    // Tag editor: toggle NOT button
    $(document).on('click', '.bm-tag-negate-btn', function (e) {
        e.stopPropagation();
        $(this).toggleClass('active');
    });

    // Tag editor: add condition to current (last) group
    $(document).on('click', '.bm-tag-add-btn', function (e) {
        e.stopPropagation();
        const $editor = $(this).closest('.bm-tag-editor');
        const $card = $editor.closest('.bm-cond-sprite-card, .bm-cond-bg-card');
        const type = $editor.find('.bm-tag-type').val();
        const value = $editor.find('.bm-tag-value').val()?.trim();
        const negated = $editor.find('.bm-tag-negate-btn').hasClass('active');
        if (!type || !value) return;

        const workingGroups = $card.data('working-groups');
        if (!workingGroups) return;

        if (workingGroups.length === 0) workingGroups.push([]);
        workingGroups[workingGroups.length - 1].push({ type, value, negated });

        $editor.find('.bm-tag-display').html(buildPillsHtml(workingGroups, true));
        $editor.find('.bm-tag-value').val('');
        $editor.find('.bm-tag-negate-btn').removeClass('active');
    });

    // Tag editor: enter key in value input adds condition
    $(document).on('keydown', '.bm-tag-value', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            $(this).closest('.bm-tag-add-row').find('.bm-tag-add-btn').trigger('click');
        }
    });

    // Tag editor: start new OR group
    $(document).on('click', '.bm-tag-or-btn', function (e) {
        e.stopPropagation();
        const $editor = $(this).closest('.bm-tag-editor');
        const $card = $editor.closest('.bm-cond-sprite-card, .bm-cond-bg-card');
        const workingGroups = $card.data('working-groups');
        if (!workingGroups) return;

        workingGroups.push([]);
        $editor.find('.bm-tag-display').html(buildPillsHtml(workingGroups, true));
    });

    // Tag editor: remove a pill
    $(document).on('click', '.bm-pill-x', function (e) {
        e.stopPropagation();
        const $pill = $(this).closest('.bm-cond-pill');
        const $editor = $(this).closest('.bm-tag-editor');
        const $card = $editor.closest('.bm-cond-sprite-card, .bm-cond-bg-card');
        const g = parseInt($pill.data('group'), 10);
        const i = parseInt($pill.data('idx'), 10);

        const workingGroups = $card.data('working-groups');
        if (!workingGroups?.[g]) return;

        workingGroups[g].splice(i, 1);
        for (let gi = workingGroups.length - 1; gi >= 0; gi--) {
            if (workingGroups[gi].length === 0) workingGroups.splice(gi, 1);
        }

        $editor.find('.bm-tag-display').html(buildPillsHtml(workingGroups, true));
    });

    // Tag editor: save
    $(document).on('click', '.bm-tag-save', async function (e) {
        e.stopPropagation();
        const $editor = $(this).closest('.bm-tag-editor');
        const $card = $editor.closest('.bm-cond-sprite-card, .bm-cond-bg-card');
        const condType = $editor.data('cond-type');
        const index = parseInt($editor.data('cond-index'), 10);

        const workingGroups = $card.data('working-groups') || [];
        const cleanGroups = workingGroups.filter(grp => grp.length > 0);

        const settings = getSettings();
        if (condType === 'bg') {
            if (settings.conditionalBackgrounds[index]) {
                settings.conditionalBackgrounds[index].conditionGroups = cleanGroups;
                saveSettings();
            }
            renderConditionalBackgrounds();
        } else {
            if (settings.conditionalSprites[index]) {
                settings.conditionalSprites[index].conditionGroups = cleanGroups;
                saveSettings();
            }
            await renderConditionalSprites();
        }
        toastr.success('Conditions updated.', MODULE_NAME);
    });

    // Tag editor: cancel
    $(document).on('click', '.bm-tag-cancel', async function (e) {
        e.stopPropagation();
        const $editor = $(this).closest('.bm-tag-editor');
        const condType = $editor.data('cond-type');
        if (condType === 'bg') {
            renderConditionalBackgrounds();
        } else {
            await renderConditionalSprites();
        }
    });

    // Delete conditional sprite
    $(document).on('click', '.bm-cond-remove', async function (e) {
        e.stopPropagation();
        const index = parseInt($(this).closest('.bm-cond-sprite-card').data('cond-index'), 10);
        const settings = getSettings();
        settings.conditionalSprites.splice(index, 1);
        saveSettings();
        await renderConditionalSprites();
    });

    // Fallback expression
    $('#bm_fallback_expression').on('change', function () {
        const settings = getSettings();
        settings.fallbackExpression = $(this).val();
        saveSettings();
    });

    // Connection profile
    $('#bm_connection_profile').on('change', function () {
        const settings = getSettings();
        settings.connectionProfile = $(this).val() || null;
        saveSettings();
    });

    $('#bm_show_current_state').on('change', function () {
        const settings = getSettings();
        settings.showCurrentState = $(this).prop('checked');
        saveSettings();
    });

    $('#bm_context_messages').on('change', function () {
        const settings = getSettings();
        settings.contextMessages = Math.max(1, Math.min(50, parseInt($(this).val(), 10) || 10));
        $(this).val(settings.contextMessages);
        saveSettings();
    });

    $('#bm_eval_timing').on('change', function () {
        const settings = getSettings();
        settings.evalTiming = $(this).val();
        saveSettings();
    });

    // Background tool toggle
    $('#bm_bg_enabled').on('change', async function () {
        const settings = getSettings();
        settings.bgToolEnabled = $(this).prop('checked');
        saveSettings();
        if (settings.bgToolEnabled) {
            await renderBgGallery();
            renderConditionalBackgrounds();
        }
    });

    // Add conditional background
    $(document).on('click', '.bm-bg-add-cond', async function (e) {
        e.stopPropagation();
        const filename = $(this).closest('.bm-bg-card').data('filename');
        if (!filename) return;

        const settings = getSettings();
        const existing = settings.conditionalBackgrounds.find(cb => cb.filename === filename);
        if (!existing) {
            settings.conditionalBackgrounds.push({ filename, conditionGroups: [] });
            saveSettings();
        }

        await renderBgGallery();
        renderConditionalBackgrounds();

        const newIndex = settings.conditionalBackgrounds.findIndex(cb => cb.filename === filename);
        if (newIndex >= 0) {
            const $list = $('#bm_bg_conditionals_list');
            if ($list.length) {
                $list[0].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            toggleBgTagEditor(newIndex);
        }
    });

    // Edit conditions on a bg conditional card
    $(document).on('click', '.bm-bg-cond-edit', function (e) {
        e.stopPropagation();
        const index = parseInt($(this).closest('.bm-cond-bg-card').data('bg-index'), 10);
        toggleBgTagEditor(index);
    });

    // Delete conditional background
    $(document).on('click', '.bm-bg-cond-delete', function (e) {
        e.stopPropagation();
        const index = parseInt($(this).closest('.bm-cond-bg-card').data('bg-index'), 10);
        const settings = getSettings();
        settings.conditionalBackgrounds.splice(index, 1);
        saveSettings();
        renderConditionalBackgrounds();
        renderBgGallery();
    });

    // Inline label editing
    $(document).on('click', '.bm-editable-label', function (e) {
        e.stopPropagation();
        const $label = $(this);
        if ($label.find('input').length) return;

        const fileLabel = $label.data('file-label');
        const currentDisplay = $label.text();

        const $input = $('<input>', {
            type: 'text',
            value: currentDisplay,
            class: 'bm-label-edit-input',
            css: {
                width: '100%',
                fontSize: '10px',
                textAlign: 'center',
                padding: '1px 2px',
                border: '1px solid rgba(232, 149, 108, 0.5)',
                borderRadius: '3px',
                background: 'rgba(0,0,0,0.3)',
                color: 'inherit',
                outline: 'none',
            },
        });

        $label.html($input);
        $input.focus().select();

        const saveLabel = async () => {
            const newDisplay = $input.val().trim();
            const settings = getSettings();

            if (!settings.labelAliases) settings.labelAliases = {};

            if (!newDisplay || newDisplay === fileLabel) {
                delete settings.labelAliases[fileLabel];
            } else {
                settings.labelAliases[fileLabel] = newDisplay;
            }

            saveSettings();
            invalidateCache();
            await renderExpressionGrid();
            await renderConditionalSprites();
        };

        $input.on('blur', saveLabel);
        $input.on('keydown', function (ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); $(this).blur(); }
            if (ev.key === 'Escape') {
                $input.off('blur');
                $label.text(currentDisplay);
            }
        });
    });

    // Promote label sprite to conditional
    $(document).on('click', '.bm-sprite-promote', async function (e) {
        e.stopPropagation();
        const fileLabel = $(this).data('file-label');
        const settings = getSettings();

        if (!settings.conditionalSprites) settings.conditionalSprites = [];
        const existing = settings.conditionalSprites.find(cs => cs.label === fileLabel);
        if (!existing) {
            settings.conditionalSprites.push({ label: fileLabel, conditionGroups: [] });
        }

        saveSettings();
        await renderExpressionGrid();
        await renderConditionalSprites();
        toastr.info(`Moved "${getDisplayLabel(fileLabel)}" to conditionals.`, MODULE_NAME);
    });

    // Demote conditional sprite to label
    $(document).on('click', '.bm-cond-demote', async function (e) {
        e.stopPropagation();
        const index = parseInt($(this).closest('.bm-cond-sprite-card').data('cond-index'), 10);
        const settings = getSettings();
        const cs = settings.conditionalSprites[index];

        if (cs) {
            const fileLabel = cs.label;
            settings.conditionalSprites.splice(index, 1);

            if (settings.disabledConditionals) {
                const dcIdx = settings.disabledConditionals.indexOf(fileLabel);
                if (dcIdx >= 0) settings.disabledConditionals.splice(dcIdx, 1);
            }

            saveSettings();
            await renderExpressionGrid();
            await renderConditionalSprites();
            toastr.info(`Moved "${getDisplayLabel(fileLabel)}" back to labels.`, MODULE_NAME);
        }
    });

    // Sprite enable/disable toggle
    $(document).on('click', '.bm-sprite-toggle', async function (e) {
        e.stopPropagation();
        const fileLabel = $(this).data('file-label');
        const settings = getSettings();
        if (!settings.disabledLabels) settings.disabledLabels = [];

        const idx = settings.disabledLabels.indexOf(fileLabel);
        if (idx >= 0) {
            settings.disabledLabels.splice(idx, 1);
        } else {
            settings.disabledLabels.push(fileLabel);
        }

        saveSettings();
        await renderExpressionGrid();
    });

    // Conditional sprite eye toggle
    $(document).on('click', '.bm-cond-toggle', async function (e) {
        e.stopPropagation();
        const fileLabel = $(this).data('file-label');
        const settings = getSettings();
        if (!settings.disabledConditionals) settings.disabledConditionals = [];

        const idx = settings.disabledConditionals.indexOf(fileLabel);
        if (idx >= 0) {
            settings.disabledConditionals.splice(idx, 1);
        } else {
            settings.disabledConditionals.push(fileLabel);
        }

        saveSettings();
        await renderConditionalSprites();
    });

    // Diagnostics
    $('#bm_run_diagnostics').on('click', async () => {
        const $output = $('#bm_diagnostics_output');
        $output.show();
        $output.html('<div style="text-align: center; padding: 12px; opacity: 0.5;">Running diagnostics...</div>');

        const results = await runDiagnostics();

        const icons = { pass: 'fa-circle-check', warn: 'fa-triangle-exclamation', fail: 'fa-circle-xmark' };
        const colors = { pass: '#10b981', warn: '#f59e0b', fail: '#ef4444' };

        const html = results.map(r => `
            <div class="bm-diag-row" style="display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                <i class="fa-solid ${icons[r.status]}" style="color: ${colors[r.status]}; margin-top: 2px; flex-shrink: 0;"></i>
                <div style="flex: 1; min-width: 0;">
                    <div style="font-size: 12px; font-weight: 600;">${r.label}</div>
                    <div style="font-size: 11px; opacity: 0.7;">${r.detail}</div>
                    ${r.fix ? `<div style="font-size: 10px; color: ${colors[r.status]}; margin-top: 2px;"><i class="fa-solid fa-wrench" style="font-size: 9px;"></i> ${r.fix}</div>` : ''}
                </div>
            </div>
        `).join('');

        const passCount = results.filter(r => r.status === 'pass').length;
        const warnCount = results.filter(r => r.status === 'warn').length;
        const failCount = results.filter(r => r.status === 'fail').length;

        const summary = `<div style="display: flex; gap: 12px; padding: 8px 0; margin-bottom: 4px; font-size: 11px; opacity: 0.8;">
            <span style="color: #10b981;"><i class="fa-solid fa-circle-check"></i> ${passCount} pass</span>
            ${warnCount > 0 ? `<span style="color: #f59e0b;"><i class="fa-solid fa-triangle-exclamation"></i> ${warnCount} warn</span>` : ''}
            ${failCount > 0 ? `<span style="color: #ef4444;"><i class="fa-solid fa-circle-xmark"></i> ${failCount} fail</span>` : ''}
        </div>`;

        $output.html(summary + html);
    });
}

// ─── UI Visibility Helpers ──────────────────────────────────────

function updateExpressionSectionsVisibility() {
    const settings = getSettings();
    const exprEnabled = settings.expressionToolEnabled;
    // Show/hide expression-specific sections
    $('#bm_label_sprites_card').toggle(exprEnabled);
    $('#bm_conditional_sprites_card').toggle(exprEnabled);
}

// ─── Init ────────────────────────────────────────────────────────

function loadSettingsUI() {
    const settings = getSettings();
    $('#bm_global_enabled').prop('checked', settings.enabled);
    $('#bm_main_controls').toggle(settings.enabled);
    $('#bm_bg_enabled').prop('checked', settings.bgToolEnabled || false);
    $('#bm_expression_enabled').prop('checked', settings.expressionToolEnabled !== false);
    $('#bm_show_current_state').prop('checked', settings.showCurrentState !== false);
    $('#bm_context_messages').val(settings.contextMessages || 10);
    $('#bm_eval_timing').val(settings.evalTiming || 'before');
    renderConnectionProfiles();
    updateExpressionSectionsVisibility();
}

jQuery(async () => {
    const settingsHtml = await $.get('/scripts/extensions/third-party/BunMoji/settings.html');
    $('#extensions_settings2').append(settingsHtml);

    ensureSettings();
    bindUIEvents();
    loadSettingsUI();

    const settings = getSettings();
    if (settings.enabled) {
        initActivityFeed();
        suppressClassifier();
        registerSlashCommands();
        if (isGroupChat()) {
            await warmGroupSpriteCache();
        } else {
            await warmSpriteCache();
        }
        await syncCustomExpressions();
        await renderExpressionGrid();
        await renderConditionalSprites();
        if (settings.bgToolEnabled) {
            await renderBgGallery();
            renderConditionalBackgrounds();
        }
    }

    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionReady);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        // Don't clear in groups — let the per-user-message tracking handle it
        if (!isGroupChat()) {
            _sidecarRanForChars.clear();
        }
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        invalidateCache();
        invalidateBgCache();
        _sidecarRanForChars.clear();
        _lastUserMessageId = -1;

        const chatSettings = getSettings();
        if (chatSettings.enabled) {
            if (isGroupChat()) {
                await warmGroupSpriteCache();
            } else {
                await warmSpriteCache();
            }
            await syncCustomExpressions();
            await renderExpressionGrid();
            await renderConditionalSprites();
            if (chatSettings.bgToolEnabled) {
                await renderBgGallery();
                renderConditionalBackgrounds();
            }
            setTimeout(() => restoreFromMetadata(), 2500);
        }
    });

    eventSource.on(event_types.MESSAGE_SWIPED, restoreFromMetadata);

    console.log(`[${MODULE_NAME}] Extension loaded (group chat + bg-only mode support).`);
});
