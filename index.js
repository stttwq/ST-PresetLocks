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
const VERSION = '1.6.0'; // 与 manifest.json 同步（测试会校）
const CARD_KEY = 'presetLocks';
const WORLD_KEY = 'world'; // 酒馆原生字段 data.extensions.world（第一本）
const WORLDS_KEY = 'worldBooks'; // 本扩展：多本世界书列表
const AUTO = { NEVER: 'never', ASK: 'ask', ALWAYS: 'always' };

const DEFAULTS = {
    autoApply: AUTO.ALWAYS,
    notify: true,
    deleteWorldWithCard: true,
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
    const extra = (Array.isArray(list) ? list : []).slice(1);

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
    await pm.selectPreset(found);
    return true;
}

async function onContextChanged() {
    // 打开卡/聊天时先把卡内绑定的多本世界书同步成酒馆的「角色世界书」，让它自动生效
    const activeKey = cardKey();
    if (activeKey) await syncCharLore(activeKey, getWorlds(activeKey));

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
            <span class="opacity50p font70p" style="margin-left:6px">v${VERSION}</span>
            <span id="preset_locks_hint" class="opacity50p font70p"></span>
        </div>
        <select id="preset_locks_select" class="text_pole wide100p"></select>`;
    anchor.parentElement.insertBefore(row, anchor);

    const worldRow = document.createElement('div');
    worldRow.id = 'preset_locks_world_row';
    worldRow.className = 'flex-container flexFlowColumn';
    worldRow.innerHTML = `
        <div class="title_restorable">
            <span>🌍 世界书锁定（可多选）</span>
            <span class="opacity50p font70p" style="margin-left:6px">v${VERSION}</span>
            <span id="world_lock_hint" class="opacity50p font70p"></span>
        </div>
        <div id="world_lock_list" class="flex gap1 flexFlowColumn wide100p" style="max-height:200px;overflow:auto;"></div>`;
    anchor.parentElement.insertBefore(worldRow, anchor);

    const wlist = worldRow.querySelector('#world_lock_list');
    wlist.addEventListener('change', (event) => onWorldToggle(event));

    const sel = row.querySelector('#preset_locks_select');
    sel.addEventListener('pointerdown', () => refreshEditorRow());
    sel.addEventListener('focus', () => refreshEditorRow());
    sel.addEventListener('change', () => onEditorChange());
    refreshEditorRow(true);
    refreshWorldRow(true);
    startEditorWatch();
    return true;
}

async function refreshWorldRow(force = false) {
    const list = document.getElementById('world_lock_list');
    if (!list) return;

    const card = panelCard();
    const key = card?.avatar || '';
    const bound = getWorlds(key);
    let worlds = await fetchWorldList(force);
    let ids = worlds.map((w) => w.file_id);

    // 绑定的名字不在列表里：可能是缓存过期（刚新建/刚导入），强刷一次再下结论
    if (bound.some((w) => !ids.includes(w)) && Date.now() - lastForceAt > 5000) {
        lastForceAt = Date.now();
        worlds = await fetchWorldList(true);
        ids = worlds.map((w) => w.file_id);
    }

    const rows = worlds.map((w) => ({ id: w.file_id, label: w.name }));
    for (const w of bound) {
        if (!rows.some((r) => r.id === w)) rows.push({ id: w, label: `${w}（服务器上找不到此文件）`, missing: true });
    }

    const signature = `${key}|${bound.join(',')}|${rows.map((r) => r.id).join(',')}`;
    if (force || list.dataset.sig !== signature) {
        list.dataset.sig = signature;
        list.dataset.avatar = key;
        list.replaceChildren();
        if (!key) {
            const empty = document.createElement('div');
            empty.className = 'opacity50p font70p';
            empty.textContent = '先在左侧选中一张角色卡';
            list.append(empty);
        } else if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'opacity50p font70p';
            empty.textContent = '服务器上还没有世界书';
            list.append(empty);
        } else {
            for (const r of rows) {
                const order = bound.indexOf(r.id);
                const label = document.createElement('label');
                label.className = 'flex gap1 alignitemscenter';
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.dataset.world = r.id;
                box.checked = order >= 0;
                const text = document.createElement('span');
                text.className = r.missing ? 'flex1 opacity50p' : 'flex1';
                text.textContent = order >= 0 ? `${order + 1}. ${r.label}` : r.label;
                label.append(box, text);
                list.append(label);
            }
        }
    }

    const hint = document.getElementById('world_lock_hint');
    if (hint) {
        const missing = bound.filter((w) => !ids.includes(w));
        const shared = bound.filter((w) => worldRefs(w, key).length);
        hint.textContent = !key
            ? '先在左侧选中一张角色卡'
            : !bound.length
                ? '勾选一本或多本世界书，随卡自动生效'
                : missing.length
                    ? `有 ${missing.length} 本在服务器上找不到：取消勾选可清除`
                    : `${bound.length} 本生效中（序号即加载顺序）${shared.length ? ` · ${shared.length} 本被其他卡共用，删卡时保留` : ''}`;
    }
}

async function onWorldToggle(event) {
    const box = event.target;
    if (!box || box.type !== 'checkbox' || !box.dataset.world) return;

    const list = document.getElementById('world_lock_list');
    const avatar = list?.dataset.avatar;
    if (!avatar) {
        box.checked = !box.checked;
        toast('先在左侧选中一张角色卡', 'info');
        return;
    }

    const bound = getWorlds(avatar);
    const next = box.checked ? [...bound.filter((w) => w !== box.dataset.world), box.dataset.world] : bound.filter((w) => w !== box.dataset.world);

    const ok = await writeCardWorlds(avatar, next);
    if (!ok) {
        box.checked = !box.checked;
        toastr.error('写不进角色卡，世界书绑定失败', '预设锁定');
        return;
    }
    await syncCharLore(avatar, next);
    toast(next.length ? `已绑定 ${next.length} 本世界书` : '已解除世界书绑定');
    refreshWorldRow(true);
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
            const target = event.target instanceof Element ? event.target.closest('.character_select') : null;
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
    console.log(`${LOG} v${VERSION} 已加载`);
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
