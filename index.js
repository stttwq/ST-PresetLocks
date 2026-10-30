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
const VERSION = '2.0.5'; // 与 manifest.json 同步（测试会校）
const CARD_KEY = 'presetLocks';
const WORLD_KEY = 'world'; // 酒馆原生字段 data.extensions.world（第一本）
const WORLDS_KEY = 'worldBooks'; // 本扩展：多本世界书列表
const AUTO = { NEVER: 'never', ASK: 'ask', ALWAYS: 'always' };

const DEFAULTS = {
    autoApply: AUTO.ALWAYS,
    notify: true,
    deleteWorldWithCard: true,
    // 实测：进入卡时切换与首屏渲染谁先谁后不稳定，不重绘会时不时看到旧渲染，
    // 所以默认开启（只在目标预设带显示型正则且聊天非空时才多一次重载）。
    rerenderOnSwitch: true,
};

let popupInstance = null;
let applying = false;
let suppressRegexNotice = false;
let rerendering = false;

/**
 * 酒馆的正则扩展在预设应用时会弹「重新加载聊天以使正则生效」。
 * 我们切预设时刚刚进过聊天，这条提示只会干扰人（且正则本身已生效），所以在自动切换期间滤掉它。
 * 手动切预设不受影响。
 */
function installToastFilter() {
    if (typeof toastr === 'undefined' || window.__plToastWrapped) return;
    window.__plToastWrapped = true;
    for (const level of ['info', 'success', 'warning', 'error']) {
        const original = toastr[level].bind(toastr);
        toastr[level] = function (msg, title, ...rest) {
            const text = `${title || ''} ${msg || ''}`;
            if (suppressRegexNotice && /正则|regex/i.test(text)) return undefined;
            return original(msg, title, ...rest);
        };
    }
}

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
    if (!avatar) {
        // 面板还没填好时（刚打开列表/刚切角色），退回当前加载的那张卡
        const c = currentChar();
        return c ? { avatar: c.avatar, name: c.name } : null;
    }
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

async function setLock(key, patch) {
    if (!key) return { ok: false, where: '本机', reason: '没有角色卡' };
    // 先落本机，写卡失败也不会丢；合并基准取「卡内优先」的现有记录
    const prev = { ...(getLock(key) || {}) };
    delete prev.from;
    const merged = { ...prev, ...patch, at: Date.now() };
    if (!merged.preset) return { ok: true, where: '清空' };
    settings().characterLocks[key] = merged;
    saveSettings();
    return await writeLockToCard(key, merged);
}

async function writeLockToCard(key, value) {
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

// ===== 世界书绑定（酒馆原生字段 data.extensions.world） =====

let worldListCache = null;
let worldListAt = 0;
let lastForceAt = 0;

/** /api/worldinfo/list 的 file_id 才是酒馆内部用的名字（data.extensions.world 存的就是它）。 */
async function fetchWorldList(force = false) {
    const now = Date.now();
    if (!force && worldListCache && now - worldListAt < 60000) return worldListCache;
    try {
        const res = await fetch('/api/worldinfo/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: '{}',
        });
        if (!res.ok) return worldListCache || [];
        const list = await res.json();
        worldListCache = (Array.isArray(list) ? list : []).map((x) => ({
            file_id: x.file_id || x.name,
            name: x.name || x.file_id,
        }));
        worldListAt = now;
        return worldListCache;
    } catch (error) {
        console.warn(`${LOG} 取世界书列表失败:`, error);
        return worldListCache || [];
    }
}

function getWorlds(avatar) {
    const ext = findChar(avatar)?.data?.extensions;
    if (!ext || typeof ext !== 'object') return [];
    if (Array.isArray(ext[WORLDS_KEY])) {
        const list = ext[WORLDS_KEY].filter((w) => typeof w === 'string' && w);
        if (list.length) return list;
    }
    // 兼容旧版的单本绑定
    return typeof ext[WORLD_KEY] === 'string' && ext[WORLD_KEY] ? [ext[WORLD_KEY]] : [];
}

/** 多本绑定写进卡内：worldBooks 存完整列表，world 存第一本（酒馆原生字段，保证没本扩展也能生效）。 */
async function writeCardWorlds(avatar, list) {
    const clean = (Array.isArray(list) ? list : []).filter((w) => typeof w === 'string' && w);
    const res = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            avatar,
            data: { extensions: { [WORLDS_KEY]: clean.length ? clean : null, [WORLD_KEY]: clean[0] || null } },
        }),
    });
    if (!res.ok) return false;
    const ch = findChar(avatar);
    if (ch) {
        if (!ch.data || typeof ch.data !== 'object') ch.data = {};
        if (!ch.data.extensions || typeof ch.data.extensions !== 'object') ch.data.extensions = {};
        ch.data.extensions[WORLDS_KEY] = clean.length ? clean : null;
        ch.data.extensions[WORLD_KEY] = clean[0] || null;
    }
    return true;
}

let wiModulePromise = null;

/** 动态 import 只做一次：每轮扫描都重新 import 会白跑一趟模块解析。 */
async function getWorldInfoModule() {
    if (!wiModulePromise) {
        wiModulePromise = import('../../../world-info.js').catch((error) => {
            console.warn(`${LOG} 加载 world-info 模块失败:`, error);
            wiModulePromise = null;
            return null;
        });
    }
    return wiModulePromise;
}

/** 在某个 store 上登记录角色的额外世界书，返回是否真改动了。 */
function upsertCharLore(store, base, extra) {
    if (!store || typeof store !== 'object') return false;
    if (!Array.isArray(store.charLore)) store.charLore = [];
    const arr = store.charLore;
    const idx = arr.findIndex((e) => e && e.name === base);
    const before = idx === -1 ? [] : arr[idx].extraBooks || [];
    if (JSON.stringify(before) === JSON.stringify(extra)) return false;

    if (!extra.length) {
        if (idx !== -1) arr.splice(idx, 1);
    } else if (idx === -1) {
        arr.push({ name: base, extraBooks: [...extra] });
    } else {
        arr[idx] = { ...arr[idx], extraBooks: [...extra] };
    }
    return true;
}

/**
 * 让酒馆真的把这些世界书当成「角色世界书」加载。
 * 第一本靠 data.extensions.world 原生生效，其余的靠 world_info.charLore。
 *
 * 关键：酒馆模块内的 world_info 和 extension_settings.world_info 不是同一个对象。
 * 只写后者不生效（扫描时看不到），只写前者不落盘（刷新就没了），所以两边都要写。
 */
async function syncCharLore(avatar, list) {
    const base = avatar ? avatar.replace(/\.[^/.]+$/, '') : '';
    if (!base) return false;
    const clean = (Array.isArray(list) ? list : []).filter((w) => typeof w === 'string' && w);
    // 酒馆组装提示词时会把 charLore 里的额外书再倒一次，所以这里先倒存，才能让注入顺序 = 界面序号（2、3、4…）
    const extra = clean.slice(1).reverse();

    // 第一本靠 data.extensions.world 生效；如果是手写/旧数据只有 worldBooks，顺手补上（仅内存，不多发请求）
    const ch = findChar(avatar);
    if (ch) {
        if (!ch.data || typeof ch.data !== 'object') ch.data = {};
        if (!ch.data.extensions || typeof ch.data.extensions !== 'object') ch.data.extensions = {};
        const want = clean[0] || null;
        if ((ch.data.extensions[WORLD_KEY] || null) !== want) ch.data.extensions[WORLD_KEY] = want;
    }

    let changed = false;
    try {
        const wi = await getWorldInfoModule();
        if (wi && upsertCharLore(wi.world_info, base, extra)) changed = true;
    } catch (error) {
        console.warn(`${LOG} 写酒馆内存里的角色世界书失败:`, error);
    }
    if (!extension_settings.world_info) extension_settings.world_info = {};
    if (upsertCharLore(extension_settings.world_info, base, extra)) changed = true;
    if (changed) saveSettingsDebounced();
    return changed;
}

/** 还有哪些卡（含其他世界书槽位）在指向同一个世界书，排除指定那张卡。 */
function worldRefs(worldName, excludeAvatar) {
    if (!worldName) return [];
    const chars = getContext()?.characters || [];
    return chars.filter((c) => c && c.avatar !== excludeAvatar && getWorlds(c.avatar).includes(worldName));
}

async function deleteWorld(worldName) {
    const res = await fetch('/api/worldinfo/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: worldName }),
    });
    return res.ok;
}

/**
 * 删掉文件后必须让酒馆刷新世界书列表。
 * 不然 world_names 里还留着名字，面板上会出现一个点了没反应、删也删不掉的幽灵条目。
 */
async function refreshStWorldList() {
    worldListCache = null;
    try {
        const wi = await getWorldInfoModule();
        if (typeof wi?.updateWorldInfoList === 'function') await wi.updateWorldInfoList();
    } catch (error) {
        console.warn(`${LOG} 刷新酒馆世界书列表失败:`, error);
    }
}

/** 删卡前先问：这张卡绑定的多本世界书要不要一并删。此时卡还在，弹窗不会被酒馆重渲染冲掉。 */
async function decideWorldDelete(avatar) {
    if (!settings().module.deleteWorldWithCard) return [];

    const ch = findChar(avatar);
    const bound = getWorlds(avatar);
    if (!ch || !bound.length) return [];

    if (!worldListCache || bound.some((w) => !worldListCache.some((x) => x.file_id === w))) {
        await fetchWorldList(true);
    }

    const deletable = [];
    const shared = [];
    const missing = [];
    for (const w of bound) {
        if (worldRefs(w, avatar).length) shared.push(w);
        else if (!worldListCache?.some((x) => x.file_id === w)) missing.push(w);
        else deletable.push(w);
    }

    if (shared.length) toast(`世界书 ${shared.map((w) => `「${w}」`).join('、')} 还被其他卡使用，已保留`, 'info');
    if (!deletable.length) return [];

    const listHtml = deletable.map((w, i) => `<div>${i + 1}. <b>${w}</b></div>`).join('');
    const ok = await callGenericPopup(
        `<div class="flex gap1 flexFlowColumn">
            <div>角色卡「${ch.name || avatar}」绑定了 ${bound.length} 本世界书，删除卡后这几本可以一并删掉：</div>
            ${listHtml}
            <div class="opacity50p font70p">选「一并删除」会从服务器移除这些文件，不可撤销。${shared.length ? `另有 ${shared.length} 本被其他卡共用/早已不在，不会动。` : ''}</div>
         </div>`,
        POPUP_TYPE.CONFIRM,
        '顺便删除世界书？',
        { okButton: '一并删除', cancelButton: '只删角色卡' },
    );
    return ok === POPUP_RESULT.AFFIRMATIVE ? deletable : [];
}

/** 待删除的世界书，key 是角色卡 avatar；删卡动作完成后再执行。 */
const pendingWorldDelete = new Map();

/** 拦在酒馆发删卡请求之前：先问，再放行。 */
function installDeleteHook() {
    if (window.__presetLocksFetchWrapped) return;
    window.__presetLocksFetchWrapped = true;

    const original = window.fetch;
    window.fetch = async function (input, init) {
        try {
            const url = typeof input === 'string' ? input : input?.url || '';
            const method = (init?.method || 'GET').toUpperCase();
            if (method === 'POST' && url.includes('/api/characters/delete') && typeof init?.body === 'string') {
                const avatar = JSON.parse(init.body || '{}')?.avatar_url;
                if (avatar) {
                    const worlds = await decideWorldDelete(avatar);
                    if (worlds.length) pendingWorldDelete.set(avatar, worlds);
                }
            }
        } catch (error) {
            console.error(`${LOG} 删卡前检查世界书失败:`, error);
        }
        return original.call(this, input, init);
    };
}

/** 酒馆删卡成功后发 CHARACTER_DELETED，这里把之前确认过的世界书删掉。 */
async function onCharacterDeleted(payload) {
    const character = payload?.character;
    const avatar = character?.avatar;
    const worlds = avatar ? pendingWorldDelete.get(avatar) : null;
    if (!avatar || !worlds || !worlds.length) return;
    pendingWorldDelete.delete(avatar);

    const done = [];
    const failed = [];
    for (const w of worlds) {
        if (await deleteWorld(w)) done.push(w);
        else failed.push(w);
    }
    worldListCache = null;
    if (done.length) {
        await refreshStWorldList();
        toast(`已删除世界书 ${done.map((w) => `「${w}」`).join('、')}`);
    }
    if (failed.length) toastr.error(`删除世界书 ${failed.map((w) => `「${w}」`).join('、')} 失败`, '预设锁定');
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
    suppressRegexNotice = true;
    try {
        await pm.selectPreset(found);
        await settlePreset(name);
    } finally {
        suppressRegexNotice = false;
    }
    await rerenderIfNeeded(name);
    return true;
}

/** 这个预设是不是带能看到效果的显示型正则（markdownOnly）。 */
function presetHasDisplayRegex(oai, name) {
    try {
        const names = oai?.openai_setting_names;
        const presets = oai?.openai_settings;
        if (!names || !presets || !name) return false;
        const idx = typeof names === 'object' && !Array.isArray(names) ? names[name] : -1;
        const def = idx === undefined || idx === null || idx < 0 ? null : presets[idx];
        const scripts = def?.extensions?.regex_scripts;
        if (!Array.isArray(scripts)) return false;
        return scripts.some((s) => s && s.disabled !== true && s.markdownOnly === true);
    } catch {
        return false;
    }
}

/**
 * 已经渲染在屏幕上的旧消息不会因为换预设而重新走一遍显示型正则，
 * 它们是在加载时渲染的。酒馆的做法是弹「重载聊天」提示让人点。
 * 我们刚切入聊天，内存状与文件一致，所以直接重绘一次更省事。
 */
async function rerenderIfNeeded(presetName) {
    if (!settings().module.rerenderOnSwitch) return false;
    if (rerendering) return false;
    const oai = await getOpenAiModule();
    if (!oai || !presetHasDisplayRegex(oai, presetName)) return false;
    const ctx = getContext();
    if (!Array.isArray(ctx?.chat) || ctx.chat.length === 0) return false;

    rerendering = true;
    try {
        const main = await import('../../../../script.js');
        if (typeof main.reloadCurrentChat === 'function') await main.reloadCurrentChat();
        return true;
    } catch (error) {
        console.warn(`${LOG} 重绘旧消息失败:`, error);
        return false;
    } finally {
        setTimeout(() => {
            rerendering = false;
        }, 2000);
    }
}

// ===== 切换后的收尾（目标是：不需要刷新页面） =====

let openAiModulePromise = null;

/** openai.js 只动态 import 一次。取不到（旧版/异常）就返回 null，不影响主流程。 */
async function getOpenAiModule() {
    if (!openAiModulePromise) {
        openAiModulePromise = import('../../../openai.js').catch(() => null);
    }
    return openAiModulePromise;
}

/**
 * 把酒馆「以后才会做」的那几步当场做完：
 * 1. 等它自己的预设应用 Promise 结束（官方信号，/preset 后面接 /api 也靠它）
 * 2. 提示词管理器强制重建一次（它平时只是 debounce 重渲染，跨预设时可能来不及）
 * 3. 逐项核对活状态与预设定义，不一样就把 change 再打一次让它自己重算
 */
async function settlePreset(name) {
    const oai = await getOpenAiModule();
    if (!oai) return [];

    try {
        if (typeof oai.getPresetApplicationPromise === 'function') {
            await oai.getPresetApplicationPromise();
        }
    } catch (error) {
        console.warn(`${LOG} 等待预设应用结束失败:`, error);
    }

    try {
        const pmgr = oai.promptManager;
        if (pmgr && typeof pmgr.sanitizeServiceSettings === 'function') {
            pmgr.sanitizeServiceSettings();
            if (typeof pmgr.render === 'function') pmgr.render(false);
        }
    } catch (error) {
        console.warn(`${LOG} 提示词管理器重建失败:`, error);
    }

    syncSPresetUI(oai, name);

    let mismatch = verifyPreset(name, oai);
    if (!mismatch.length) return mismatch;

    // 还有残渣：再触发一次 change 让酒馆自己重新套一遍（比我们逐项写回安全）
    console.warn(`${LOG} 切到「${name}」后仍有 ${mismatch.length} 项不一致，重放一次 change:`, mismatch.slice(0, 8));
    try {
        const el = presetSelectEl();
        if (el) {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (typeof oai.getPresetApplicationPromise === 'function') await oai.getPresetApplicationPromise();
        }
    } catch (error) {
        console.warn(`${LOG} 重放 change 失败:`, error);
    }
    mismatch = verifyPreset(name, oai);
    if (mismatch.length) {
        console.warn(`${LOG} 仍有 ${mismatch.length} 项与预设定义不同（多为插件动态内容，可忽略）:`, mismatch.slice(0, 8));
    }
    return mismatch;
}

/** 这个预设是不是带 SPreset 数据（靠 extensions.SPreset 判定）。 */
function presetHasSPreset(oai, name) {
    try {
        const names = oai?.openai_setting_names;
        const presets = oai?.openai_settings;
        if (!names || !presets || !name) return null;
        const idx = typeof names === 'object' && !Array.isArray(names) ? names[name] : -1;
        const def = idx === undefined || idx === null || idx < 0 ? null : presets[idx];
        if (!def) return null;
        return !!(def.extensions && def.extensions.SPreset);
    } catch {
        return null;
    }
}

/**
 * SPreset 是预设自带的插件，它会往页面里插按钮/菜单项，但从不拆除。
 * 切到不带 SPreset 的预设时把它隐起来（不删除，切回去还能自动恢复）。
 */
function syncSPresetUI(oai, name) {
    const has = presetHasSPreset(oai, name);
    if (has === null) return null;
    let touched = 0;
    for (const sel of ['.spreset-button-container', '#spreset_upload_log']) {
        document.querySelectorAll(sel).forEach((el) => {
            if (!el || !el.style) return;
            el.style.display = has ? '' : 'none';
            touched++;
        });
    }
    return { has, touched };
}

/** 拿活的设置和预设定义逐项比，返回不一致的字段名。 */
function verifyPreset(name, oai) {
    try {
        const names = oai.openai_setting_names;
        const presets = oai.openai_settings;
        const presetName = name || currentPresetName();
        if (!names || !presets || !presetName) return [];

        const idx = typeof names === 'object' && !Array.isArray(names) ? names[presetName] : Array.isArray(names) ? names.indexOf(presetName) : -1;
        const def = idx === undefined || idx === null || idx < 0 ? null : presets[idx];
        if (!def) return [];

        const live = typeof oai.getChatCompletionPreset === 'function' ? oai.getChatCompletionPreset() : null;
        if (!live) return [];

        // prompts / prompt_order / extensions 是插件动态区，不参与判定
        const skip = new Set(['name', 'prompts', 'prompt_order', 'extensions', 'reverse_proxy', 'proxy_password', 'proxy_preset']);
        const bad = [];
        for (const k of Object.keys(def)) {
            if (skip.has(k)) continue;
            if (JSON.stringify(def[k]) === JSON.stringify(live[k])) continue;
            bad.push(k);
        }
        return bad;
    } catch (error) {
        console.warn(`${LOG} 校验预设一致性失败:`, error);
        return [];
    }
}

// ===== 提示词启用状态与顺序的快照 =====

/** 拿当前活状态的 prompt_order 快照（深拷贝，直接存卡里）。 */
function capturePromptOrder(oai) {
    try {
        const live = typeof oai.getChatCompletionPreset === 'function' ? oai.getChatCompletionPreset() : null;
        const po = live && Array.isArray(live.prompt_order) ? live.prompt_order : null;
        if (!po || !po.length) return null;
        return JSON.parse(JSON.stringify(po));
    } catch (error) {
        console.warn(`${LOG} 读取提示词顺序失败:`, error);
        return null;
    }
}

/** 快照里的摘要：[总条数, 已启用数]。prompt_order 可能有多个块，要全加。 */
function promptOrderSummary(snapshot) {
    const blocks = Array.isArray(snapshot) ? snapshot : [];
    let total = 0;
    let on = 0;
    for (const b of blocks) {
        const order = b && Array.isArray(b.order) ? b.order : [];
        total += order.length;
        on += order.filter((e) => e && e.enabled).length;
    }
    return [total, on];
}

/** 把快照写回活状态。返回是否真的变了。 */
async function applyPromptOrder(oai, snapshot) {
    try {
        if (!Array.isArray(snapshot) || !snapshot.length) return false;
        const live = oai.getChatCompletionPreset();
        if (JSON.stringify(live.prompt_order) === JSON.stringify(snapshot)) return false;

        oai.oai_settings.prompt_order = JSON.parse(JSON.stringify(snapshot));
        const pmgr = oai.promptManager;
        if (pmgr && typeof pmgr.render === 'function') pmgr.render(false);
        saveSettingsDebounced();
        return true;
    } catch (error) {
        console.warn(`${LOG} 写回提示词顺序失败:`, error);
        return false;
    }
}

/** 按锁定的项目切换：主预设 → 提示词快照。返回是否真的变了。 */
async function applyLock(lock) {
    if (!lock) return false;
    let changed = false;

    if (lock.preset) changed = (await applyPreset(lock.preset)) || changed;

    if (lock.enable?.prompts && lock.prompts) {
        const oai = await getOpenAiModule();
        if (oai) changed = (await applyPromptOrder(oai, lock.prompts)) || changed;
    }
    return changed;
}

/** 锁定是否已经全部生效（主预设 + 提示词快照）。 */
async function lockSatisfied(lock) {
    if (!lock) return true;
    if (lock.preset && lock.preset !== currentPresetName()) return false;
    if (lock.enable?.prompts && lock.prompts) {
        const oai = await getOpenAiModule();
        if (oai) {
            try {
                const live = oai.getChatCompletionPreset();
                if (JSON.stringify(live.prompt_order) !== JSON.stringify(lock.prompts)) return false;
            } catch {
                /* 读不到就不当 blocker */
            }
        }
    }
    return true;
}

// 多个事件（CHAT_CHANGED / CHAT_LOADED）会几乎同时触发，必须串行，否则两道都看到旧状态、重复切一次
let contextChain = Promise.resolve();

function onContextChanged() {
    contextChain = contextChain.then(runContextChanged, runContextChanged);
    return contextChain;
}

async function runContextChanged() {
    if (rerendering) return; // 自己触发的重绘不再跑一轮
    // 打开卡/聊天时同步世界书（只有勾了「世界书」才动）
    const activeKey = cardKey();
    const activeLock = activeKey ? getLock(activeKey) : null;
    if (activeKey && activeLock?.enable?.worlds) await syncCharLore(activeKey, getWorlds(activeKey));

    if (applying || popupOpen()) return;

    const key = cardKey();
    if (!key) return;

    const lock = getLock(key);
    if (!lock || !lock.preset) return;
    if (await lockSatisfied(lock)) return;

    const mode = settings().module.autoApply;
    if (mode === AUTO.NEVER) return;

    const name = cardName() || key;
    const from = currentPresetName() || '（无）';

    if (mode === AUTO.ALWAYS) {
        applying = true;
        try {
            if (await applyLock(lock)) toast(`角色卡「${name}」→ 预设「${lock.preset}」`);
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
        if (result === POPUP_RESULT.AFFIRMATIVE) await applyLock(lock);
    } finally {
        applying = false;
    }
}

function popupOpen() {
    return !!(popupInstance && popupInstance.dlg && popupInstance.dlg.hasAttribute('open'));
}

// ===== 角色卡管理界面里的预设下拉 =====

/** 酒馆的 presetManager.select 在不同版本里是选择器字符串 / 原生 select / jQuery 对象，三种都兼容。 */
function presetSelectEl(apiId = '') {
    const pm = getPresetManager(apiId);
    const s = pm?.select;
    if (!s) return null;
    if (typeof s === 'string') return document.querySelector(s);
    if (s.options) return s;
    if (s[0] && s[0].options) return s[0];
    return null;
}

/** 直接读酒馆自己的预设下拉，拿到的就是当前 API 可用的预设名，不猜接口形状。 */
function presetNames(apiId = '') {
    const el = presetSelectEl(apiId);
    if (!el || !el.options) return [];
    return Array.from(el.options)
        .map((o) => o.text.trim())
        .filter(Boolean);
}

const PANEL_CSS = `
#preset_locks_row { gap: 2px; }
#preset_locks_row .pl-head { display: flex; align-items: center; gap: 6px; }
#preset_locks_row .pl-title { font-weight: 600; }
#preset_locks_row .pl-ver { opacity: .45; font-size: .72em; }
#preset_locks_row .pl-hint { opacity: .55; font-size: .76em; }
#preset_locks_row .pl-toggle { margin-left: auto; cursor: pointer; opacity: .65; padding: 0 4px; flex: none; }
#preset_locks_row .pl-toggle:hover { opacity: 1; }
#preset_locks_row .pl-sum { font-size: .82em; opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#preset_locks_row .pl-body { display: flex; flex-direction: column; gap: 4px; }
#preset_locks_row .pl-line { display: flex; align-items: center; gap: 6px; font-size: .88em; min-width: 0; }
#preset_locks_row .pl-line > * { min-width: 0; }
#preset_locks_row .pl-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#preset_locks_row .pl-stat { flex: none; font-size: .8em; opacity: .55; white-space: nowrap; }
#preset_locks_row .pl-mini { flex: none; width: 17px; height: 17px; line-height: 17px; text-align: center; border-radius: 4px; background: rgba(0,0,0,.22); cursor: pointer; font-size: .76em; user-select: none; margin-left: 2px; }
#preset_locks_row .pl-mini:hover { background: rgba(255,255,255,.18); }
#preset_locks_row .pl-ghost { flex: none; padding: 1px 8px; border-radius: 4px; background: rgba(0,0,0,.22); cursor: pointer; font-size: .8em; white-space: nowrap; }
#preset_locks_row .pl-ghost:hover { background: rgba(255,255,255,.18); }
#preset_locks_row .pl-list { max-height: 78px; overflow: auto; display: flex; flex-direction: column; gap: 1px; padding-right: 2px; }
#preset_locks_row .pl-results { max-height: 72px; overflow: auto; display: flex; flex-direction: column; gap: 1px; padding-right: 2px; }
#preset_locks_row .pl-add { cursor: pointer; padding: 1px 6px; border-radius: 4px; background: rgba(0,0,0,.22); font-size: .82em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#preset_locks_row .pl-add:hover { background: rgba(255,255,255,.18); }
#preset_locks_row .pl-empty { opacity: .45; font-size: .8em; }
`;

function injectEditorRow() {
    if (document.getElementById('preset_locks_row')) return true;
    const anchor = document.getElementById('spoiler_free_desc') || document.getElementById('descriptionWrapper');
    if (!anchor || !anchor.parentElement) return false;

    if (!document.getElementById('preset_locks_css')) {
        const style = document.createElement('style');
        style.id = 'preset_locks_css';
        style.textContent = PANEL_CSS;
        document.head.append(style);
    }

    const row = document.createElement('div');
    row.id = 'preset_locks_row';
    row.className = 'flex-container flexFlowColumn';
    row.innerHTML = `
        <div class="pl-head">
            <span class="pl-title">🔒 锁定</span>
            <span class="pl-ver">v${VERSION}</span>
            <span class="pl-hint" id="preset_locks_hint"></span>
            <span class="pl-toggle" id="preset_locks_toggle" title="展开/收起">▾</span>
        </div>
        <div class="pl-sum" id="preset_locks_summary"></div>
        <div class="pl-body" id="preset_locks_body" style="display:none">
            <select id="preset_locks_select" class="text_pole" title="主预设"></select>

            <div class="pl-line">
                <label class="pl-line" style="flex:1 1 auto" title="把当前预设的提示词启用/关闭与顺序一起记到这张卡">
                    <input type="checkbox" id="pl_enable_prompts">
                    <span class="pl-name">提示词开关与顺序</span>
                    <span class="pl-stat" id="pl_prompts_info"></span>
                </label>
                <span class="pl-ghost" id="pl_prompts_capture" style="display:none" title="把当前提示词开关/顺序重新存进这张卡">更新快照</span>
            </div>
            <div class="pl-line">
                <label class="pl-line" style="flex:1 1 auto" title="这张卡要带哪些世界书">
                    <input type="checkbox" id="pl_enable_worlds">
                    <span class="pl-name">世界书</span>
                    <span class="pl-stat" id="world_lock_hint"></span>
                </label>
            </div>

            <div id="pl_worlds_box" style="display:none;flex-direction:column;gap:3px">
                <div class="pl-list" id="world_lock_list"></div>
                <input id="world_lock_search" class="text_pole" placeholder="搜索世界书以添加…">
                <div class="pl-results" id="world_lock_results"></div>
            </div>

            <div class="pl-line">
                <label class="pl-line" style="flex:1 1 auto" title="切入卡后，若新预设带显示型正则，自动重绘旧消息（重读聊天文件，不丢消息）">
                    <input type="checkbox" id="pl_rerender">
                    <span class="pl-name">切换后重绘旧消息</span>
                </label>
            </div>
        </div>`;
    anchor.parentElement.insertBefore(row, anchor);

    row.querySelector('#preset_locks_toggle').addEventListener('click', () => setBodyOpen(!bodyOpen()));
    const sel = row.querySelector('#preset_locks_select');
    sel.addEventListener('pointerdown', () => refreshEditorRow());
    sel.addEventListener('focus', () => refreshEditorRow());
    sel.addEventListener('change', () => onEditorChange());

    row.querySelector('#pl_enable_prompts').addEventListener('change', (e) => onEnableChange('prompts', e.target.checked));
    row.querySelector('#pl_enable_worlds').addEventListener('change', (e) => onEnableChange('worlds', e.target.checked));
    row.querySelector('#pl_prompts_capture').addEventListener('click', () => onCapturePrompts());
    row.querySelector('#pl_rerender').addEventListener('change', (e) => {
        settings().module.rerenderOnSwitch = e.target.checked;
        saveSettings();
    });
    row.querySelector('#world_lock_search').addEventListener('input', () => refreshWorldResults());
    row.querySelector('#world_lock_list').addEventListener('click', (e) => onWorldAction(e));
    row.querySelector('#world_lock_results').addEventListener('click', (e) => onWorldAdd(e));

    refreshEditorRow(true);
    refreshWorldRow(true);
    startEditorWatch();
    return true;
}

function bodyOpen() {
    const body = document.getElementById('preset_locks_body');
    return !!(body && body.style.display !== 'none');
}

function setBodyOpen(open) {
    const body = document.getElementById('preset_locks_body');
    if (!body) return;
    body.style.display = open ? 'flex' : 'none';
    const toggle = document.getElementById('preset_locks_toggle');
    if (toggle) toggle.textContent = open ? '▴' : '▾';
    if (open) {
        refreshEditorRow(true);
        refreshWorldRow(true);
    }
}

const statsCache = new Map();

/** 一本书的条目统计：[常驻数, 关键词数]。用酒馆自己的缓存读，不额外请求。 */
async function worldStats(name) {
    if (statsCache.has(name)) return statsCache.get(name);
    let stats = null;
    try {
        const wi = await getWorldInfoModule();
        const data = wi && typeof wi.loadWorldInfo === 'function' ? await wi.loadWorldInfo(name) : null;
        const entries = data && data.entries ? Object.values(data.entries) : null;
        if (entries) {
            stats = {
                constant: entries.filter((e) => e && e.constant).length,
                keyword: entries.filter((e) => e && !e.constant).length,
            };
        }
    } catch {
        stats = null;
    }
    statsCache.set(name, stats);
    return stats;
}

function worldStatText(stats) {
    if (!stats) return '';
    return `${stats.constant}/${stats.keyword}`;
}

function worldStatTitle(stats) {
    if (!stats) return '';
    return `常驻 ${stats.constant} / 关键词 ${stats.keyword}`;
}

/** 已绑定的世界书：序号 + 上移下移 + 移除 + 条目统计。 */
async function refreshWorldRow(force = false) {
    const list = document.getElementById('world_lock_list');
    const results = document.getElementById('world_lock_results');
    if (!list || !results) return;

    const card = panelCard();
    const key = card?.avatar || '';
    const bound = getWorlds(key);
    let all = await fetchWorldList(force);
    let ids = all.map((w) => w.file_id);

    // 绑定的名字不在列表里：可能是缓存过期，强刷一次再下结论
    if (bound.some((w) => !ids.includes(w)) && Date.now() - lastForceAt > 5000) {
        lastForceAt = Date.now();
        all = await fetchWorldList(true);
        ids = all.map((w) => w.file_id);
    }

    const sig = `${key}|${bound.join(',')}|${ids.join(',')}`;
    if (force || list.dataset.sig !== sig) {
        list.dataset.sig = sig;
        list.dataset.avatar = key;
        list.replaceChildren();

        if (!key) {
            const tip = document.createElement('div');
            tip.className = 'pl-empty';
            tip.textContent = '先在左侧选中一张角色卡';
            list.append(tip);
        } else if (!bound.length) {
            const tip = document.createElement('div');
            tip.className = 'pl-empty';
            tip.textContent = '还没绑定世界书';
            list.append(tip);
        } else {
            for (let i = 0; i < bound.length; i++) {
                const name = bound[i];
                const missing = !ids.includes(name);
                const stats = missing ? null : await worldStats(name);

                const line = document.createElement('div');
                line.className = 'pl-line';

                const idx = document.createElement('span');
                idx.className = 'pl-stat';
                idx.textContent = `${i + 1}.`;

                const label = document.createElement('span');
                label.className = missing ? 'pl-name' : 'pl-name';
                if (missing) label.style.opacity = '.5';
                label.textContent = missing ? `${name}（找不到）` : name;
                label.title = missing ? `${name}（服务器上找不到这个文件）` : `${name}${stats ? ' · ' + worldStatTitle(stats) : ''}`;

                const stat = document.createElement('span');
                stat.className = 'pl-stat';
                stat.textContent = worldStatText(stats);
                stat.title = worldStatTitle(stats);

                const mkBtn = (text, act, title) => {
                    const b = document.createElement('span');
                    b.className = 'pl-mini';
                    b.dataset.act = act;
                    b.dataset.world = name;
                    b.title = title;
                    b.textContent = text;
                    return b;
                };

                line.append(idx, label, stat, mkBtn('↑', 'up', '上移'), mkBtn('↓', 'down', '下移'), mkBtn('×', 'remove', '移除'));
                list.append(line);
            }
        }
        refreshWorldResults();
    }

    const hint = document.getElementById('world_lock_hint');
    if (hint) {
        const missing = bound.filter((w) => !ids.includes(w));
        hint.textContent = !key ? '' : !bound.length ? '未绑定' : missing.length ? `${bound.length} 本 · ${missing.length} 本缺失` : `${bound.length} 本`;
    }
}

/** 搜索结果：未绑定的书，点一下就加。 */
function refreshWorldResults() {
    const box = document.getElementById('world_lock_results');
    const input = document.getElementById('world_lock_search');
    if (!box || !input) return;

    const card = panelCard();
    const key = card?.avatar || '';
    const bound = getWorlds(key);
    const q = String(input.value || '').trim().toLowerCase();
    const pool = (worldListCache || []).filter((w) => !bound.includes(w.file_id));
    const hits = q ? pool.filter((w) => w.name.toLowerCase().includes(q)).slice(0, 20) : [];

    box.replaceChildren();
    box.style.display = q ? 'flex' : 'none'; // 不输入就不占位置
    if (!key || !q) return;
    if (!hits.length) {
        const tip = document.createElement('div');
        tip.className = 'pl-empty';
        tip.textContent = '没有匹配的世界书';
        box.append(tip);
        return;
    }
    for (const w of hits) {
        const add = document.createElement('div');
        add.className = 'pl-add';
        add.dataset.act = 'add';
        add.dataset.world = w.file_id;
        add.textContent = `+ ${w.name}`;
        add.title = w.name;
        box.append(add);
    }
}

/** 从事件里找带 data-act 的元素（兼容没有 Element 构造器的环境）。 */
function closestAct(target, act) {
    if (!target || typeof target.closest !== 'function') return null;
    const el = target.closest('[data-act]');
    if (!el) return null;
    if (act && el.dataset?.act !== act) return null;
    return el;
}

/** 上移 / 下移 / 移除。 */
async function onWorldAction(event) {
    const el = closestAct(event.target);
    if (!el) return;
    const list = document.getElementById('world_lock_list');
    const avatar = list?.dataset.avatar;
    if (!avatar) return;

    const name = el.dataset.world;
    const bound = [...getWorlds(avatar)];
    const i = bound.indexOf(name);
    if (i < 0) return;

    if (el.dataset.act === 'remove') bound.splice(i, 1);
    else if (el.dataset.act === 'up' && i > 0) [bound[i - 1], bound[i]] = [bound[i], bound[i - 1]];
    else if (el.dataset.act === 'down' && i < bound.length - 1) [bound[i + 1], bound[i]] = [bound[i], bound[i + 1]];
    else return;

    await commitWorlds(avatar, bound);
}

/** 搜索框里点一下添加。 */
async function onWorldAdd(event) {
    const el = closestAct(event.target, 'add');
    if (!el) return;
    const card = panelCard();
    const avatar = card?.avatar || '';
    if (!avatar) return;

    const next = [...getWorlds(avatar), el.dataset.world];
    const input = document.getElementById('world_lock_search');
    if (input) input.value = '';
    await commitWorlds(avatar, next);
}

async function commitWorlds(avatar, list) {
    const ok = await writeCardWorlds(avatar, list);
    if (!ok) {
        toastr.error('写不进角色卡，世界书绑定失败', '预设锁定');
        return;
    }
    await syncCharLore(avatar, list);
    toast(list.length ? `世界书 ${list.length} 本` : '已解除世界书绑定');
    refreshWorldRow(true);
    refreshEditorRow(true);
}

let editorTimer = null;
/** 角色面板是否真的开着。只看 DOM 存在不够，面板关着时行也还在。 */
function panelOpen() {
    const panel = document.getElementById('right-nav-panel');
    if (panel) return panel.classList.contains('openDrawer');
    const row = document.getElementById('preset_locks_row');
    return !!(row && row.offsetParent);
}

let panelObserver = null;
let lastPanelOpen = null;

/**
 * 性能：不在面板关着时空转。面板一开就刷一次并开巡检；面板一关就彻底停掉定时器。
 * 用 MutationObserver 盯面板的 class，不靠轮询。
 */
function startEditorWatch() {
    const panel = document.getElementById('right-nav-panel');
    if (!panel) return false;
    if (panelObserver) return true;

    panel.addEventListener(
        'click',
        (event) => {
            const target = event.target && typeof event.target.closest === 'function' ? event.target.closest('.character_select') : null;
            if (!target) return;
            setTimeout(refreshEditorRow, 300);
            setTimeout(refreshWorldRow, 500);
        },
        true,
    );

    lastPanelOpen = panel.classList.contains('openDrawer');
    panelObserver = new MutationObserver(() => {
        const open = panel.classList.contains('openDrawer');
        if (open === lastPanelOpen) return;
        lastPanelOpen = open;
        if (open) {
            refreshEditorRow(true);
            refreshWorldRow(true);
            startTicker();
        } else {
            stopTicker();
        }
    });
    panelObserver.observe(panel, { attributes: true, attributeFilter: ['class'] });

    if (lastPanelOpen) startTicker();
    return true;
}

/** 只在面板开着的时候跑：2 秒一次，内容没变不碰 DOM，不拉请求。 */
function startTicker() {
    if (editorTimer) return;
    editorTimer = setInterval(() => {
        if (document.hidden) return; // 后台标签页不干活
        if (!panelOpen()) {
            stopTicker();
            return;
        }
        refreshEditorRow();
        refreshWorldRow();
    }, 2000);
}

function stopTicker() {
    if (!editorTimer) return;
    clearInterval(editorTimer);
    editorTimer = null;
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

    // 勾选态
    const cbPrompts = document.getElementById('pl_enable_prompts');
    const cbWorlds = document.getElementById('pl_enable_worlds');
    const promptsOn = !!lock?.enable?.prompts;
    const worldsOn = !!lock?.enable?.worlds;
    if (cbPrompts) cbPrompts.checked = promptsOn;
    if (cbWorlds) cbWorlds.checked = worldsOn;

    const promptsInfo = document.getElementById('pl_prompts_info');
    if (promptsInfo) {
        const snap = lock?.prompts;
        const [total, on] = promptOrderSummary(snap);
        promptsInfo.textContent = snap ? `${on}/${total}` : '';
    }
    const promptsActions = document.getElementById('pl_prompts_capture');
    if (promptsActions) promptsActions.style.display = key && lock && promptsOn ? '' : 'none';

    const worldsBox = document.getElementById('pl_worlds_box');
    if (worldsBox) worldsBox.style.display = key && lock && worldsOn ? '' : 'none';

    const rerender = document.getElementById('pl_rerender');
    if (rerender) rerender.checked = !!settings().module.rerenderOnSwitch;

    // 摘要行（收起时也能看出这张卡锁了什么）
    const summary = document.getElementById('preset_locks_summary');
    if (summary) {
        if (!key) summary.textContent = '';
        else if (!lock) summary.textContent = '未绑定：展开后选主预设与要锁定的项目';
        else {
            const parts = [`预设「${lock.preset}」`];
            if (lock.enable?.prompts && lock.prompts) {
                const [total, on] = promptOrderSummary(lock.prompts);
                parts.push(`词 ${on}/${total}`);
            }
            if (lock.enable?.worlds) {
                const n = getWorlds(key).length;
                parts.push(`书 ${n} 本`);
            }
            summary.textContent = parts.join(' · ');
        }
    }

    const hint = document.getElementById('preset_locks_hint');
    if (hint) hint.textContent = !key ? '先在左侧选中一张角色卡' : lock ? `${lock.from}` : '';

    // 未绑定时自动展开，省得用户找
    if (key && !lock && !bodyOpen()) setBodyOpen(true);
}

/** 勾/取消某个锁定项。 */
async function onEnableChange(field, checked) {
    const sel = document.getElementById('preset_locks_select');
    const avatar = sel?.dataset.avatar || '';
    if (!avatar) {
        toast('先在左侧选中一张角色卡', 'info');
        refreshEditorRow(true);
        return;
    }
    const lock = getLock(avatar);
    if (!lock || !lock.preset) {
        toast('先选一个主预设', 'info');
        refreshEditorRow(true);
        return;
    }

    const enable = { ...(lock.enable || {}), [field]: checked };
    const patch = { enable };

    if (field === 'prompts' && checked && !lock.prompts) {
        const oai = await getOpenAiModule();
        const snap = oai ? capturePromptOrder(oai) : null;
        if (!snap) {
            toast('读不到当前提示词顺序', 'warning');
            refreshEditorRow(true);
            return;
        }
        patch.prompts = snap;
    }

    const r = await setLock(avatar, patch);
    if (!r.ok) toast(`写不进角色卡，已存到本机兜底：${r.reason}`, 'warning');
    refreshEditorRow(true);
    refreshWorldRow(true);

    if (field === 'worlds') {
        await syncCharLore(avatar, checked ? getWorlds(avatar) : []);
    }
    toast(checked ? '已加入锁定' : '已取消该项锁定');
}

/** 用当前活状态重新拍一张提示词顺序快照。 */
async function onCapturePrompts() {
    const sel = document.getElementById('preset_locks_select');
    const avatar = sel?.dataset.avatar || '';
    if (!avatar) return;
    const lock = getLock(avatar);
    if (!lock || !lock.preset) return;

    const oai = await getOpenAiModule();
    const snap = oai ? capturePromptOrder(oai) : null;
    if (!snap) {
        toast('读不到当前提示词顺序', 'warning');
        return;
    }
    const r = await setLock(avatar, { prompts: snap, enable: { ...(lock.enable || {}), prompts: true } });
    if (!r.ok) toast(`写不进角色卡，已存到本机兜底：${r.reason}`, 'warning');
    else toast('提示词快照已更新');
    refreshEditorRow(true);
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

    const r = await setLock(avatar, { preset });
    const shownName = findChar(avatar)?.name || panelCard()?.name || avatar;
    if (r.ok) toast(`角色卡「${shownName}」已绑定预设「${preset}」`);
    else toast(`写不进角色卡，已存到本机兜底：${r.reason}`, 'warning');
    refreshEditorRow(true);

    applying = true;
    try {
        await applyLock(getLock(avatar) || { preset });
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
        <label><input type="checkbox" id="pl-delete-world" ${s.deleteWorldWithCard ? 'checked' : ''}> 删角色卡时，一并删除它绑定的世界书</label>

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

    const delWorld = dlg.querySelector('#pl-delete-world');
    if (delWorld) delWorld.addEventListener('change', () => { s.deleteWorldWithCard = delWorld.checked; saveSettings(); });

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
            if (await applyLock(lock)) {
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
    console.log(`${LOG} v${VERSION} 已加载`);
    installToastFilter();
    settings();
    migrateByName();
    injectMenuItem();
    injectEditorRow();
    startEditorWatch();

    // 酒馆的菜单是懒渲染的，注入失败时重试几次（同时等角色面板出现）
    let tries = 0;
    const timer = setInterval(() => {
        const menuOk = injectMenuItem();
        const rowOk = injectEditorRow();
        const watchOk = startEditorWatch();
        if ((menuOk && rowOk && watchOk) || ++tries > 40) clearInterval(timer);
    }, 500);

    eventSource.on(event_types.CHAT_CHANGED, () => { refreshEditorRow(); refreshWorldRow(); onContextChanged(); });
    if (event_types.CHAT_LOADED) eventSource.on(event_types.CHAT_LOADED, () => onContextChanged());
    if (event_types.CHARACTER_DELETED) eventSource.on(event_types.CHARACTER_DELETED, onCharacterDeleted);
    if (event_types.WORLDINFO_UPDATED) {
        eventSource.on(event_types.WORLDINFO_UPDATED, () => { worldListCache = null; refreshWorldRow(true); });
    }
    installDeleteHook();

    // 页面加载时 CHAT_CHANGED 可能早于本扩展注册，补跑一次
    onContextChanged();
}

if (event_types?.APP_READY) {
    eventSource.on(event_types.APP_READY, init);
} else {
    init();
}
