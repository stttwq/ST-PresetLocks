/**
 * 预设锁定（ST-PresetLocks）
 * 按角色卡记住预设：同一张卡的所有聊天共用一个预设，切换角色时自动换回。
 *
 * 基于 Character Locks v4.0.0 (aikohanasaki, AGPL-3.0) 重做的中文精简版，
 * 只保留「按角色卡锁定预设」这一个功能。
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup } from '../../../popup.js';
import { getPresetManager } from '../../../preset-manager.js';

const MODULE = 'PresetLocks';
const LOG = '[预设锁定]';
const AUTO = { NEVER: 'never', ASK: 'ask', ALWAYS: 'always' };

const DEFAULTS = {
    autoApply: AUTO.ALWAYS,
    notify: true,
};

let popupInstance = null;
let applying = false;

// ===== 设置读写 =====

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

/** 记录以角色卡的 avatar（文件名）为键，改角色名不会丢记录。 */
function getLock(key) {
    return key ? settings().characterLocks[key] || null : null;
}

function setLock(key, preset) {
    if (!key) return;
    settings().characterLocks[key] = { preset, at: Date.now() };
    saveSettings();
}

function clearLock(key) {
    if (!key) return;
    delete settings().characterLocks[key];
    saveSettings();
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

// ===== 当前上下文 =====

/** 返回当前角色卡的稳定标识；群聊或没选角色时返回 null。 */
function cardKey() {
    const ctx = getContext();
    if (!ctx || ctx.groupId) return null;
    const id = ctx.characterId;
    if (typeof id !== 'number' || id < 0) return null;
    const ch = ctx.characters?.[id];
    return ch?.avatar || null;
}

function cardName() {
    const ctx = getContext();
    if (!ctx || ctx.groupId) return null;
    const id = ctx.characterId;
    if (typeof id !== 'number' || id < 0) return null;
    return ctx.characters?.[id]?.name || null;
}

function currentPresetName() {
    const pm = getPresetManager();
    return pm ? pm.getSelectedPresetName() || '' : '';
}

// ===== 应用预设 =====

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
    return lock
        ? `<code>${lock.preset}</code> <span class="opacity50p font70p">${fmtTime(lock.at)}</span>`
        : '<span class="opacity50p">未记录</span>';
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
            记录的是<b>当前正在生效的预设</b>：先在酒馆的预设下拉里选好，再点「存为角色卡」。
            记录按角色卡文件绑定，同一张卡的所有聊天共用一条记录，改角色名不影响。
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
    const cur = currentPresetName();

    const refresh = () => {
        if (!popupOpen()) return;
        const el = popupInstance.dlg.querySelector('#pl-lock');
        if (el) el.innerHTML = lockText(getLock(key));
        const c = popupInstance.dlg.querySelector('#pl-current');
        if (c) c.textContent = currentPresetName() || '（读不到）';
    };

    const buttons = [
        button('✔ 存为角色卡', () => {
            if (!key) { toast('群聊或未选中角色时无法记录', 'info'); return; }
            if (!cur) { toast('读不到当前预设，未保存', 'warning'); return; }
            setLock(key, cur);
            toast(`已记录：角色卡「${name}」→ ${cur}`);
            refresh();
        }),
        button('✖ 清除记录', () => {
            if (!key) { toast('群聊或未选中角色时没有记录', 'info'); return; }
            clearLock(key);
            toast('已清除这张卡的记录');
            refresh();
        }),
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

    // 酒馆的菜单是懒渲染的，注入失败时重试几次
    let tries = 0;
    const timer = setInterval(() => {
        if (injectMenuItem() || ++tries > 20) clearInterval(timer);
    }, 500);

    eventSource.on(event_types.CHAT_CHANGED, () => onContextChanged());
    if (event_types.CHAT_LOADED) eventSource.on(event_types.CHAT_LOADED, () => onContextChanged());

    // 页面加载时 CHAT_CHANGED 可能早于本扩展注册，补跑一次
    onContextChanged();
}

if (event_types?.APP_READY) {
    eventSource.on(event_types.APP_READY, init);
} else {
    init();
}
