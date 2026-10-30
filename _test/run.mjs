import { readFileSync } from 'node:fs';
import { state, extension_settings, dom, makeElem, extraState } from './stubs.mjs';
import * as oaiStub from './openai-stub.mjs';
import * as pl from './pl.mjs';

const results = [];
const ok = (name, pass, extra = '') => results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);

// ===== 夹具 =====
state.ctx.characters = [
    { name: '爱丽丝', avatar: 'alice.png', data: { extensions: {} } },
    { name: '鲍勃', avatar: 'bob.png', data: { extensions: {} } },
];
state.worlds = ['W1', 'W2', 'W3'];
const use = (i, chatId = 'c1') => Object.assign(state.ctx, { characterId: i, chatId, groupId: null });
const alice = () => state.ctx.characters[0];
const bob = () => state.ctx.characters[1];
const cardExt = (c) => c.data.extensions;

// 面板元素桩
const el = (id) => {
    if (!dom.els[id]) dom.els[id] = makeElem('div');
    return dom.els[id];
};
['preset_locks_select', 'preset_locks_summary', 'preset_locks_hint', 'preset_locks_body',
 'pl_enable_prompts', 'pl_enable_worlds', 'pl_prompts_info', 'pl_prompts_actions',
 'pl_worlds_box', 'world_lock_list', 'world_lock_results', 'world_lock_search',
 'avatar_url_pole', 'character_name_pole'].forEach(el);
dom.els['preset_locks_body'].style = {};

// ===== 1. 卡内写入 / 读取 / 优先级 / 兜底 / 清除 / 迁移 =====
use(0, 'chat-a');
let r = await pl.setLock('alice.png', { preset: 'B' });
ok('绑定写进角色卡内', r.ok && r.where === '卡内' && cardExt(alice()).presetLocks.preset === 'B', JSON.stringify(cardExt(alice()).presetLocks));
ok('请求打到 merge-attributes', state.fetchCalls.at(-1).url === '/api/characters/merge-attributes' && state.fetchCalls.at(-1).body.avatar === 'alice.png');

use(0, 'chat-b');
state.selected = 'A';
await pl.onContextChanged();
ok('同一张卡换聊天文件 → 自动切到 B', state.selected === 'B', `selected=${state.selected}`);

state.selectedCalls.length = 0;
state.selected = 'B';
await pl.onContextChanged();
ok('已正确时不再切换', state.selectedCalls.length === 0);

state.selected = 'C';
state.selectedCalls.length = 0;
use(1, 'chat-x');
await pl.onContextChanged();
ok('未记录的卡不动预设', state.selectedCalls.length === 0 && state.selected === 'C');

state.ctx.groupId = 'g1';
state.selectedCalls.length = 0;
await pl.onContextChanged();
ok('群聊不动预设', state.selectedCalls.length === 0);
state.ctx.groupId = null;

state.presets = ['A', 'C'];
await pl.setLock('bob.png', { preset: 'B' });
use(1, 'chat-y');
state.selected = 'A';
state.selectedCalls.length = 0;
await pl.onContextChanged();
ok('预设不存在时保持原样', state.selected === 'A');
state.presets = ['A', 'B', 'C'];

pl.settings().module.autoApply = 'never';
use(0, 'chat-a');
state.selected = 'C';
state.selectedCalls.length = 0;
await pl.onContextChanged();
ok('never 模式不自动切', state.selectedCalls.length === 0);
pl.settings().module.autoApply = 'always';

use(0, 'chat-a');
pl.settings().characterLocks['alice.png'] = { preset: 'C', at: 1 };
state.selected = 'A';
await pl.onContextChanged();
ok('卡内为主，压过本机记录', state.selected === 'B', `selected=${state.selected}`);

use(1, 'chat-y');
delete cardExt(bob()).presetLocks;
state.fetchOk = false;
r = await pl.setLock('bob.png', { preset: 'C' });
ok('写卡失败时落到本机兜底', !r.ok && pl.settings().characterLocks['bob.png'].preset === 'C', r.reason);
state.selected = 'A';
await pl.onContextChanged();
ok('兜底记录照样能套用', state.selected === 'C');
state.fetchOk = true;

use(1, 'chat-y');
await pl.clearLock('bob.png');
state.selected = 'A';
state.selectedCalls.length = 0;
await pl.onContextChanged();
ok('清除后不复活', state.selectedCalls.length === 0 && !('bob.png' in pl.settings().characterLocks));

state.ctx.characters[0].name = '爱丽丝-改名版';
use(0, 'chat-a');
state.selected = 'A';
await pl.onContextChanged();
ok('改角色名后记录仍生效', state.selected === 'B');

extension_settings.PresetLocks.characterLocks = { 鲍勃: { preset: 'C', at: 1 }, 'ghost.png': { preset: 'A', at: 1 } };
const moved = pl.migrateByName();
ok('旧版名字记录迁移为 avatar 键', moved === 1 && extension_settings.PresetLocks.characterLocks['bob.png']?.preset === 'C');

// ===== 2. 提示词快照 =====
const snapshot = oaiStub.captureSnapshot();
ok('能拍到 prompt_order 快照', Array.isArray(snapshot) && snapshot[0].order.length === 6, JSON.stringify(snapshot[0].order.length));

use(0, 'chat-a');
r = await pl.setLock('alice.png', { enable: { prompts: true }, prompts: snapshot });
ok('快照存进卡里', cardExt(alice()).presetLocks.enable.prompts === true && cardExt(alice()).presetLocks.prompts[0].order.length === 6);
ok('快照摘要正确', JSON.stringify(pl.promptOrderSummary([{ character_id: 100000, order: [] }, { character_id: 100001, order: snapshot[0].order }])) === '[6,5]', JSON.stringify(pl.promptOrderSummary(snapshot)));

// 现场改了启用状态 → applyLock 应写回
oaiStub.setEnabled('jailbreak', false);
const changed = await pl.applyPromptOrder(oaiStub, snapshot);
ok('快照与活状态不同时写回', changed === true && oaiStub.enabledOf('jailbreak') === true, `after=${oaiStub.enabledOf('jailbreak')}`);

const changedAgain = await pl.applyPromptOrder(oaiStub, snapshot);
ok('已经一致时不重复写', changedAgain === false);

// 同一主预设的两张卡，提示词快照可不同
const snapshot2 = oaiStub.captureSnapshot();
oaiStub.setEnabled('main', false);
const modified2 = oaiStub.captureSnapshot();
await pl.setLock('bob.png', { preset: 'B', enable: { prompts: true }, prompts: modified2 });
ok('两张卡可存不同提示词快照', JSON.stringify(cardExt(alice()).presetLocks.prompts) !== JSON.stringify(cardExt(bob()).presetLocks.prompts));

// 绑定预设时自动拍快照 + 开启提示词锁定
use(1, 'chat-new');
await pl.clearLock('bob.png');
dom.els['preset_locks_select'].dataset.avatar = 'bob.png';
dom.els['preset_locks_select'].value = 'B';
dom.els['preset_locks_select'].dataset.bound = '';
await pl.onEditorChange();
const autoLock = cardExt(bob()).presetLocks || {};
ok('绑定预设时自动拍提示词快照', !!autoLock.prompts && autoLock.enable?.prompts === true, JSON.stringify({ p: !!autoLock.prompts, e: autoLock.enable }));
ok('绑定预设时不动世界书开关', autoLock.enable?.worlds !== true);

oaiStub.restoreSnapshot(snapshot2);
ok('桩件可还原', oaiStub.enabledOf('main') === true);

// lockSatisfied 只看主预设
ok('主预设一致即视为已满足', (await pl.lockSatisfied({ preset: state.selected })) === true);
ok('提示词快照不一致时不算满足', (await pl.lockSatisfied({ preset: state.selected, enable: { prompts: true }, prompts: [{ character_id: 1, order: [{ identifier: 'x', enabled: false }] }] })) === false);

// ===== 3. 世界书：添加 / 上下移 / 移除 =====
use(0, 'chat-a');
dom.els['preset_locks_select'].dataset.avatar = 'alice.png';
await pl.writeCardWorlds('alice.png', []);
await pl.refreshWorldRow(true);
ok('未绑定时列表给提示', dom.els['world_lock_list'].children.length === 1);

const mkAct = (act, world) => {
    const e = makeElem('div');
    e.dataset = { act, world };
    e.closest = () => e;
    return e;
};

await pl.onWorldAdd({ target: mkAct('add', 'W1') });
await pl.onWorldAdd({ target: mkAct('add', 'W2') });
ok('搜索添加两本', JSON.stringify(pl.getWorlds('alice.png')) === '["W1","W2"]', JSON.stringify(pl.getWorlds('alice.png')));

await pl.onWorldAction({ target: mkAct('down', 'W1') });
ok('下移交换顺序', JSON.stringify(pl.getWorlds('alice.png')) === '["W2","W1"]', JSON.stringify(pl.getWorlds('alice.png')));

await pl.onWorldAction({ target: mkAct('up', 'W1') });
ok('上移换回来', JSON.stringify(pl.getWorlds('alice.png')) === '["W1","W2"]');

await pl.onWorldAction({ target: mkAct('remove', 'W1') });
ok('移除一本', JSON.stringify(pl.getWorlds('alice.png')) === '["W2"]');

await pl.onWorldAction({ target: mkAct('remove', 'W2') });
ok('全部移除后清空', pl.getWorlds('alice.png').length === 0);

// 顺序进 charLore 时倒存
await pl.writeCardWorlds('alice.png', ['W1', 'W2', 'W3']);
extension_settings.world_info.charLore = [];
await pl.syncCharLore('alice.png', ['W1', 'W2', 'W3']);
ok('charLore 倒序存储', JSON.stringify(extension_settings.world_info.charLore) === '[{"name":"alice","extraBooks":["W3","W2"]}]', JSON.stringify(extension_settings.world_info.charLore));

ok('只有 worldBooks 时补 world 字段', (() => { const e = cardExt(alice()).worldBooks; return cardExt(alice()).world === e[0]; })());

// 世界书统计（读不到就返回 null，不抛）
const stats = await pl.worldStats('W1');
ok('统计读不到时安全返回', stats === null || typeof stats.constant === 'number');

// ===== 4. 面板联动 =====
use(0, 'chat-a');
dom.els['avatar_url_pole'].value = 'alice.png';
pl.refreshEditorRow(true);
ok('摘要显示主预设与勾选项', String(dom.els['preset_locks_summary'].textContent).includes('预设「B」'), String(dom.els['preset_locks_summary'].textContent));

dom.els['pl_enable_worlds'].checked = true;
await pl.onEnableChange('worlds', true);
ok('勾选世界书写进 enable', cardExt(alice()).presetLocks.enable.worlds === true, JSON.stringify(cardExt(alice()).presetLocks.enable));

await pl.onEnableChange('worlds', false);
ok('取消勾选写回 false', cardExt(alice()).presetLocks.enable.worlds === false);

await pl.onEnableChange('prompts', true);
ok('勾选提示词自动拍快照', !!cardExt(alice()).presetLocks.prompts, JSON.stringify(Object.keys(cardExt(alice()).presetLocks)));

oaiStub.setEnabled('jazz', false);
await pl.onCapturePrompts();
ok('「用当前状态更新」刷新快照', cardExt(alice()).presetLocks.prompts[0].order.some((e) => e.identifier === 'jazz' && e.enabled === false));

// ===== 5. 删卡连带删世界书 =====
await pl.writeCardWorlds('alice.png', ['W1', 'W2']);
await pl.writeCardWorlds('bob.png', ['W2']);
state.popupAnswers = [1];
state.popupCalls.length = 0;
let toDelete = await pl.decideWorldDelete('alice.png');
ok('被共用的一本不列入删除', JSON.stringify(toDelete) === '["W1"]', JSON.stringify(toDelete));
pl.pendingWorldDelete.set('alice.png', toDelete);
await pl.onCharacterDeleted({ character: alice() });
ok('删卡后真的删掉文件', !state.worlds.includes('W1') && state.worlds.includes('W2'), state.worlds.join(','));
await pl.writeCardWorlds('bob.png', []);

state.popupAnswers = [0];
await pl.writeCardWorlds('alice.png', ['W3']);
toDelete = await pl.decideWorldDelete('alice.png');
ok('选「只删角色卡」时不删书', toDelete.length === 0);

pl.settings().module.deleteWorldWithCard = false;
state.popupCalls.length = 0;
toDelete = await pl.decideWorldDelete('alice.png');
ok('关掉开关后不问', toDelete.length === 0 && state.popupCalls.length === 0);
pl.settings().module.deleteWorldWithCard = true;

// ===== 6. SPreset 入口 =====
oaiStub.openai_setting_names.SP = oaiStub.openai_settings.length;
oaiStub.openai_settings.push({ name: 'SP', temperature: 1, extensions: { SPreset: { x: 1 } } });
ok('带 SPreset 的预设被识别', pl.presetHasSPreset(oaiStub, 'SP') === true);
ok('不带 SPreset 的预设被识别', pl.presetHasSPreset(oaiStub, 'P1') === false);
ok('未知预设返回 null', pl.presetHasSPreset(oaiStub, '不存在') === null);

const spBtn = makeElem('div');
const origQSA = document.querySelectorAll;
document.querySelectorAll = (sel) => (sel === '.spreset-button-container' ? [spBtn] : []);
ok('无 SPreset 时隐起按钮', pl.syncSPresetUI(oaiStub, 'P1').has === false && spBtn.style.display === 'none');
ok('切回时恢复显示', pl.syncSPresetUI(oaiStub, 'SP').has === true && spBtn.style.display === '');
document.querySelectorAll = origQSA;

// ===== 7. 版本一致 =====
const manifestVersion = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')).version;
ok('VERSION 与 manifest 一致', pl.VERSION === manifestVersion, `code=${pl.VERSION} manifest=${manifestVersion}`);

// 显示型正则判定 + 自动重绘开关
oaiStub.openai_setting_names.RX = oaiStub.openai_settings.length;
oaiStub.openai_settings.push({ name: 'RX', extensions: { regex_scripts: [{ scriptName: 'a', markdownOnly: true, disabled: false }, { scriptName: 'b', markdownOnly: false }] } });
oaiStub.openai_setting_names.NORX = oaiStub.openai_settings.length;
oaiStub.openai_settings.push({ name: 'NORX', extensions: { regex_scripts: [{ scriptName: 'c', markdownOnly: false, disabled: false }] } });
ok('识别带显示型正则的预设', pl.presetHasDisplayRegex(oaiStub, 'RX') === true);
ok('无显示型正则的预设返回 false', pl.presetHasDisplayRegex(oaiStub, 'NORX') === false);
ok('无正则扩展的预设返回 false', pl.presetHasDisplayRegex(oaiStub, 'P1') === false);

pl.settings().module.rerenderOnSwitch = false;
ok('关闭开关时不重绘', (await pl.rerenderIfNeeded('RX')) === false);
pl.settings().module.rerenderOnSwitch = true;
ok('聊天为空时不重绘', (await pl.rerenderIfNeeded('RX')) === false);

// ===== 默认值 =====
pl.settings().module.appliedDefaults = 0;
ok('默认静默（不弹提示）', pl.DEFAULTS.notify === false);
ok('默认自动切换', pl.DEFAULTS.autoApply === 'always');
ok('默认切换后重绘', pl.DEFAULTS.rerenderOnSwitch === true);
ok('默认删卡时问世界书', pl.DEFAULTS.deleteWorldWithCard === true);

pl.settings().module.notify = true;
const migrated = pl.migrateDefaults();
ok('升级时把 notify 迁移为静默', migrated === true && pl.settings().module.notify === false, JSON.stringify(pl.settings().module));
ok('迁移只跑一次', pl.migrateDefaults() === false);

console.log(results.join('\n'));
const failed = results.filter((x) => x.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
