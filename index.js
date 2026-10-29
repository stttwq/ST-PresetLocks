/**
 * 预设锁定（ST-PresetLocks）
 * 按角色卡记住预设：同一张卡的所有聊天共用一个预设，切换角色时自动换回。
 *
 * 绑定写在角色卡自己的 data.extensions.presetLocks 里，卡走预设走；
 * 同时在本机 settings.json 留一份兜底，写卡失败（无权限/旧版本）也能用。
 *
 * 基于 Character Locks v4.0.0 (aikohanasaki, AGPL-3.0) 重做的中文精简版。
 */

import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup } from '../../../popup.js';
import { getPresetManager } from '../../../preset-manager.js';

const MODULE = 'PresetLocks';
const LOG = '[预设锁定]';
const CARD_KEY = 'presetLocks';
const AUTO = { NEVER: 'never', ASK: 'ask', ALWAYS: 'always' };

const DEFAULTS = {
    autoApply: AUTO.ALWAYS,
    notify: true,
};

let popupInstance = null;
let applying = false;

// ===== 本机兜底记录（settings.json） =====

function settings() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = {};
    const store = extension_settings[MODULE];
    store.module = Object.assign({ ...DEFAULTS }, store.module || {});
    store.characterLocks = store.characterLocks || {};
    return store;
}

function saveSettings() {
    saveSettingsDebounced();
}

function getLocalLock(key) {
    return key ? settings().characterLocks[key] || null : null;
}

function setLocalLock(key, preset) {
    if (!key) return;
    settings().characterLocks[key] = { preset, at: Date.now() };
    saveSettings();
}

function dropLocalLock(key) {
    if (!key) return;
    delete settings().characterLocks[key];
    saveSettings();
}

// ===== 角色卡内记录（data.extensions.presetLocks） =====

function currentChar() {
    const ctx = getContext();
    if (!ctx || ctx.groupId) return null;
    // 酒馆 1.19 里 characterId 是字符串（"40"），旧版本是数字，两种都收
    const id = Number(ctx.characterId);
    if (!Number.isInteger(id) || id < 0) return null;
    return ctx.characters?.[id] || null;
}

function cardKey() {
    return currentChar()?.avatar || null;
}

function cardName() {
    return currentChar()?.name || null;
}

function findChar(avatar) {
    if (!avatar) return null;
    const chars = getContext()?.characters || [];
    return chars.find((c) => c && c.avatar === avatar) || null;
}

/**
 * 角色卡管理界面当前显示的那张卡。酒馆会把它的 avatar 写进 #avatar_url_pole，
 * 这个值不依赖 characterId / groupId，所以面板里没开聊天也能用。
 */
function panelCard() {
    const el = document.getElementById('avatar_url_pole');
    const avatar = el && el.value ? el.value.trim() : '';
    if (!avatar) return null;
    const namePole = document.getElementById('character_name_pole');
    const ch = findChar(avatar);
    const name = ch?.name || (namePole && namePole.value ? namePole.value.trim() : avatar);
    return { avatar, name };
}

/**
 * 返回 undefined = 卡里没写过；null = 卡里明确清除过；对象 = 有效记录。
 * 明确清除时必须返回 null，否则会被本机兜底记录复活。
 */
function readCardLock(avatar) {
    const ext = findChar(avatar)?.data?.extensions;
    if (!ext || typeof ext !== 'object' || !(CARD_KEY in ext)) return undefined;
    const v = ext[CARD_KEY];
    return v && typeof v === 'object' && v.preset ? v : null;
}

function writeCardLockMemory(avatar, value) {
    const ch = findChar(avatar);
    if (!ch) return;
    if (!ch.data || typeof ch.data !== 'object') ch.data = {};
    if (!ch.data.extensions || typeof ch.data.extensions !== 'object') ch.data.extensions = {};
    ch.data.extensions[CARD_KEY] = value;
}

/** 走服务端深度合并接口，只改 data.extensions.presetLocks，不动卡的其它字段。 */
async function postCardLock(avatar, value) {
    const res = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar, data: { extensions: { [CARD_KEY]: value } } }),
    });
    return res.ok;
}

/** 卡内为主：卡里写过就用卡里的，没写过才用本机兜底。 */
function getLock(key) {
    if (!key) return null;
    const fromCard = readCardLock(key);
    if (fromCard === null) return null;
    if (fromCard) return { ...fromCard, from: '卡内' };
    const local = getLocalLock(key);
    return local ? { ...local, from: '本机' } : null;
}

async function setLock(key, preset) {
    setLocalLock(key, preset); // 先落本机，写卡失败也不会丢
    const value = { preset, at: Date.now() };
    try {
        const ok = await postCardLock(key, value);
        if (ok) {
            writeCardLockMemory(key, value);
            return { ok: true, where: '卡内' };
        }
        return { ok: false, where: '本机', reason: '写卡被拒绝（HTTP 失败）' };
    } catch (error) {
        return { ok: false, where: '本机', reason: String(error?.message || error) };
    }
}

async function clearLock(key) {
    dropLocalLock(key);
    try {
        const ok = await postCardLock(key, null);
        if (ok) writeCardLockMemory(key, null);
        return ok;
    } catch {
        return false;
    }
}

/** 旧版按角色名存的记录，启动时按名字匹配到 avatar 上，避免升级后记录消失。 */
function migrateByName() {
    const store = settings();
    const chars = getContext()?.characters || [];
    let moved = 0;
    for (const [key, lock] of Object.entries(store.characterLocks)) {
        if (!lock || !lock.preset || chars.some((c) => c && c.avatar === key)) continue;
        const hit = chars.find((c) => c && c.name === key && c.avatar);
        if (hit) {
            store.characterLocks[hit.avatar] = lock;
            delete store.characterLocks[key];
            moved++;
        }
    }
    if (moved) saveSettings();
    return moved;
}

// ===== 应用预设 =====

function currentPresetName() {
    const pm = getPresetManager();
    return pm ? pm.getSelectedPresetName() || '' : '';
}

async function applyPreset(name) {
    const pm = getPresetManager();
    if (!pm) {
        console.warn(`${LOG} 取不到预设管理器，放弃切换`);
        return false;
    }
    if (!name || pm.getSelectedPresetName() === name) return false;

    const found = pm.findPreset(name);
    if (found === undefined || found === null) {
        toast(`预设「${name}」已不存在，请重新存一次`, 'warning');
        return false;
    }
    await pm.selectPreset(found);
    return true;
}

async function onContextChanged() {
    if (applying || popupOpen()) return;

    const key = cardKey();
    if (!key) return;

    const lock = getLock(key);
    if (!lock || !lock.preset) return;
    if (lock.preset === currentPresetName()) return;

    const mode = settings().module.autoApply;
    if (mode === AUTO.NEVER) return;

    const name = cardName() || key;
    const from = currentPresetName() || '（无）';

    if (mode === AUTO.ALWAYS) {
        applying = true;
        try {
            if (await applyPreset(lock.preset)) toast(`角色卡「${name}」→ 预设「${lock.preset}」`);
        } finally {
            applying = false;
        }
        return;
    }

    // ASK：弹窗期间占住 applying，避免连续切换时叠出多个弹窗。
    applying = true;
    try {
        const result = await callGenericPopup(
            `<div class="flex gap1 flexFlowColumn">
                <div>角色卡「${name}」记录的预设：</div>
                <div><b>${lock.preset}</b></div>
                <div class="opacity50p">当前使用：${from}</div>
             </div>`,
            POPUP_TYPE.CONFIRM,
            '要切换吗？',
            { okButton: '切换预设', cancelButton: '保持不动' },
        );
        if (result === POPUP_RESULT.AFFIRMATIVE) await applyPreset(lock.preset);
    } finally {
        applying = false;
    }
}

function popupOpen() {
    return !!(popupInstance && popupInstance.dlg && popupInstance.dlg.hasAttribute('open'));
}

// ===== 角色卡管理界面里的预设下拉 =====

/** 酒馆的 presetManager.select 在不同版本里是选择器字符串 / 原生 select / jQuery 对象，三种都兼容。 */
function presetSelectEl() {
    const pm = getPresetManager();
    const s = pm?.select;
    if (!s) return null;
    if (typeof s === 'string') return document.querySelector(s);
    if (s.options) return s;
    if (s[0] && s[0].options) return s[0];
    return null;
}

/** 直接读酒馆自己的预设下拉，拿到的就是当前 API 可用的预设名，不猜接口形状。 */
function presetNames() {
    const el = presetSelectEl();
    if (!el || !el.options) return [];
    return Array.from(el.options)
        .map((o) => o.text.trim())
        .filter(Boolean);
}

function injectEditorRow() {
    if (document.getElementById('preset_locks_row')) return true;
    const anchor = document.getElementById('spoiler_free_desc') || document.getElementById('descriptionWrapper');
    if (!anchor || !anchor.parentElement) return false;

    const row = document.createElement('div');
    row.id = 'preset_locks_row';
    row.className = 'flex-container flexFlowColumn';
    row.innerHTML = `
        <div class="title_restorable">
            <span>🔒 预设锁定</span>
            <span id="preset_locks_hint" class="opacity50p font70p"></span>
        </div>
        <select id="preset_locks_select" class="text_pole wide100p"></select>`;
    anchor.parentElement.insertBefore(row, anchor);

    const sel = row.querySelector('#preset_locks_select');
    sel.addEventListener('pointerdown', () => refreshEditorRow());
    sel.addEventListener('focus', () => refreshEditorRow());
    sel.addEventListener('change', () => onEditorChange());
    refreshEditorRow(true);
    startEditorWatch();
    return true;
}

let editorTimer = null;

/** 面板每打开一次就自己对齐一次，不依赖酒馆发事件，也不依赖下拉能拿到焦点。 */
function startEditorWatch() {
    if (editorTimer) return;
    editorTimer = setInterval(() => {
        const row = document.getElementById('preset_locks_row');
        if (!row || !row.offsetParent) return; // 面板没开就不干活
        refreshEditorRow();
    }, 500);
}

function refreshEditorRow(force = false) {
    const sel = document.getElementById('preset_locks_select');
    if (!sel) return;

    const card = panelCard();
    const key = card?.avatar || '';
    const lock = getLock(key);
    const bound = lock?.preset || '';
    const names = presetNames();
    if (bound && !names.includes(bound)) names.push(bound); // 预设被删/改名时也列出来，免得静默丢绑定

    const shown = Array.from(sel.options || []).map((o) => o.value);
    const needRebuild = force || sel.dataset.avatar !== key || shown.length - 1 !== names.length || !shown.includes(bound);
    if (needRebuild) {
        sel.replaceChildren(new Option('（不绑定预设）', ''));
        for (const n of names) sel.append(new Option(n, n, false, n === bound));
        sel.value = bound;
        sel.dataset.avatar = key;
        sel.dataset.bound = bound;
    }
    sel.disabled = false; // 永远可点：禁用的下拉拿不到焦点，也就会卡在旧状态上

    const hint = document.getElementById('preset_locks_hint');
    if (hint) {
        hint.textContent = !key
            ? '先在左侧选中一张角色卡'
            : lock
                ? `绑定中 · ${lock.from}`
                : '在这张卡上选一个预设，立即生效并写进卡里';
    }
}

async function onEditorChange() {
    const sel = document.getElementById('preset_locks_select');
    if (!sel) return;
    const avatar = sel.dataset.avatar;
    const preset = sel.value;
    if (!avatar) {
        sel.value = '';
        toast('先在左侧选中一张角色卡', 'info');
        return;
    }
    if (preset === sel.dataset.bound) return;

    if (!preset) {
        await clearLock(avatar);
        toast('已解除这张卡的预设绑定');
        refreshEditorRow(true);
        return;
    }

    const r = await setLock(avatar, preset);
    const shownName = findChar(avatar)?.name || panelCard()?.name || avatar;
    if (r.ok) toast(`角色卡「${shownName}」已绑定预设「${preset}」`);
    else toast(`写不进角色卡，已存到本机兜底：${r.reason}`, 'warning');
    refreshEditorRow(true);

    applying = true;
    try {
        await applyPreset(preset);
    } finally {
        applying = false;
    }
}

function toast(msg, type = 'success') {
    if (!settings().module.notify) return;
    if (typeof toastr === 'undefined') return;
    toastr[type](msg, '预设锁定');
}

// ===== 面板 =====

function fmtTime(at) {
    if (!at) return '';
    const d = new Date(at);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function lockText(lock) {
    if (!lock) return '<span class="opacity50p">未记录</span>';
    const tag = lock.from === '卡内' ? '卡内' : '本机兜底';
    return `<code>${lock.preset}</code> <span class="opacity50p font70p">${tag} · ${fmtTime(lock.at)}</span>`;
}

function panelHtml(key, name) {
    const s = settings().module;
    const lock = getLock(key);
    const cur = currentPresetName();
    const radio = (v, text) => `<label><input type="radio" name="pl-auto" value="${v}" ${s.autoApply === v ? 'checked' : ''}> ${text}</label>`;

    return `
    <div class="flex gap1 flexFlowColumn width100p">
        <div class="opacity70p">当前预设：<b id="pl-current">${cur || '（读不到）'}</b>　·　角色卡：${name ? `「${name}」` : '（未选中，或为群聊）'}</div>

        <div class="width100p flex gap1 alignitemscenter">
            <span class="flex1">这张卡记录的预设：</span>
            <span id="pl-lock">${lockText(lock)}</span>
        </div>

        <div class="flex gap1 flexFlowColumn">
            <b>切换角色时</b>
            ${radio('never', '不动预设（只能手动应用）')}
            ${radio('ask', '先问我')}
            ${radio('always', '直接换成记录的预设')}
        </div>

        <label><input type="checkbox" id="pl-notify" ${s.notify ? 'checked' : ''}> 显示提示</label>

        <div class="opacity50p font70p">
            绑定不在这里设。去<b>角色卡管理界面</b>（左上角 ☰），在标签下方新增的「🔒 预设锁定」下拉里直接选预设。
            选择会写进角色卡文件的 <code>data.extensions.presetLocks</code>，卡导出/上传到别的酒馆时一起走；
            同时在本机 <code>settings.json</code> 留一份兜底。
        </div>
    </div>
    `;
}

function bindPanel() {
    const s = settings().module;
    const dlg = popupInstance?.dlg;
    if (!dlg) return;

    const notify = dlg.querySelector('#pl-notify');
    if (notify) notify.addEventListener('change', () => { s.notify = notify.checked; saveSettings(); });

    dlg.querySelectorAll('input[name="pl-auto"]').forEach((el) => {
        el.addEventListener('change', () => {
            if (el.checked) { s.autoApply = el.value; saveSettings(); }
        });
    });
}

function button(text, action) {
    return {
        text,
        classes: ['menu_button'],
        action: async (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
                await action();
            } catch (error) {
                console.error(`${LOG} 按钮「${text}」执行失败:`, error);
                if (typeof toastr !== 'undefined') toastr.error(String(error.message || error), '预设锁定');
            }
        },
    };
}

async function showPanel() {
    if (popupOpen()) return;

    const key = cardKey();
    const name = cardName();

    const refresh = () => {
        if (!popupOpen()) return;
        const el = popupInstance.dlg.querySelector('#pl-lock');
        if (el) el.innerHTML = lockText(getLock(key));
        const c = popupInstance.dlg.querySelector('#pl-current');
        if (c) c.textContent = currentPresetName() || '（读不到）';
    };

    const buttons = [
        button('▶ 立即应用', async () => {
            const lock = getLock(key);
            if (!lock) { toast('这张卡没有记录', 'info'); return; }
            if (await applyPreset(lock.preset)) {
                toast(`已切到「${lock.preset}」`);
                refresh();
            }
        }),
    ];

    popupInstance = new Popup(`<h3>🔒 预设锁定</h3>${panelHtml(key, name)}`, POPUP_TYPE.TEXT, '', {
        customButtons: buttons,
        onOpen: () => bindPanel(),
        onClose: () => { popupInstance = null; },
    });
    await popupInstance.show();
}

// ===== 菜单项与初始化 =====

function injectMenuItem() {
    const menu = document.querySelector('#extensionsMenu');
    if (!menu) return false;
    if (menu.querySelector('#pl-menu-item')) return true;

    const item = document.createElement('div');
    item.className = 'extension_container interactable';
    item.tabIndex = 0;
    item.innerHTML = `<div id="pl-menu-item" class="list-group-item" title="按角色卡自动切换预设">
        <i class="fa-solid fa-lock"></i><span>预设锁定</span></div>`;
    item.addEventListener('click', () => showPanel());
    menu.appendChild(item);
    return true;
}

function init() {
    settings();
    migrateByName();
    injectMenuItem();
    injectEditorRow();

    // 酒馆的菜单是懒渲染的，注入失败时重试几次
    let tries = 0;
    const timer = setInterval(() => {
        const menuOk = injectMenuItem();
        const rowOk = injectEditorRow();
        if ((menuOk && rowOk) || ++tries > 20) clearInterval(timer);
    }, 500);

    eventSource.on(event_types.CHAT_CHANGED, () => { refreshEditorRow(); onContextChanged(); });
    if (event_types.CHAT_LOADED) eventSource.on(event_types.CHAT_LOADED, () => onContextChanged());

    // 页面加载时 CHAT_CHANGED 可能早于本扩展注册，补跑一次
    onContextChanged();
}

if (event_types?.APP_READY) {
    eventSource.on(event_types.APP_READY, init);
} else {
    init();
}
