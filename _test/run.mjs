import { readFileSync } from 'node:fs';
import { state, extension_settings, dom, makeElem, extraState, eventSource, event_types } from './stubs.mjs';
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

// ===== 5. 删卡只删「属于这张卡」的世界书 =====
// 夹具：把一本书命名成卡的名字，另一本卡绑着但同名无关
state.ctx.characters[0].name = '爱丽丝';
state.worlds = ['爱丽丝', 'W2', 'W3', 'alice'];
await pl.writeCardWorlds('alice.png', ['爱丽丝', 'W2']);
await pl.writeCardWorlds('bob.png', ['W2']);
state.popupAnswers = [1];
state.popupCalls.length = 0;
let toDelete = await pl.decideWorldDelete('alice.png');
ok('只列出与卡同名的那本', JSON.stringify(toDelete) === '["爱丽丝"]', JSON.stringify(toDelete));
ok('同名的卡专属书不被共用影响', !toDelete.includes('W2'));

pl.pendingWorldDelete.set('alice.png', toDelete);
await pl.onCharacterDeleted({ character: alice() });
ok('删卡后真的删掉文件', !state.worlds.includes('爱丽丝') && state.worlds.includes('W2'), state.worlds.join(','));

// 同名书被别的卡占着 → 保留
state.worlds = ['爱丽丝', 'W3'];
await pl.writeCardWorlds('alice.png', ['爱丽丝']);
await pl.writeCardWorlds('bob.png', ['爱丽丝']);
state.popupCalls.length = 0;
toDelete = await pl.decideWorldDelete('alice.png');
ok('同名书被其他卡共用时不列', toDelete.length === 0 && state.popupCalls.length === 0);
await pl.writeCardWorlds('bob.png', []);

// 卡自带 character_book → 书也算自己的
state.worlds = ['卡内书名', 'W3'];
alice().data.character_book = { name: '卡内书名', entries: [] };
await pl.writeCardWorlds('alice.png', ['卡内书名']);
state.popupAnswers = [1];
toDelete = await pl.decideWorldDelete('alice.png');
ok('character_book 的书也算专属', JSON.stringify(toDelete) === '["卡内书名"]', JSON.stringify(toDelete));
delete alice().data.character_book;

// 绑定但既不同名也不是自带 → 不问
state.worlds = ['W3'];
await pl.writeCardWorlds('alice.png', ['W3']);
state.popupCalls.length = 0;
toDelete = await pl.decideWorldDelete('alice.png');
ok('绑定但无关的书不问也不删', toDelete.length === 0 && state.popupCalls.length === 0);

// 用户选「只删角色卡」
state.worlds = ['爱丽丝'];
await pl.writeCardWorlds('alice.png', ['爱丽丝']);
state.popupAnswers = [0];
toDelete = await pl.decideWorldDelete('alice.png');
ok('选「只删角色卡」时不删书', toDelete.length === 0);

pl.settings().module.deleteWorldWithCard = false;
state.popupCalls.length = 0;
toDelete = await pl.decideWorldDelete('alice.png');
ok('关掉开关后不问', toDelete.length === 0 && state.popupCalls.length === 0);
pl.settings().module.deleteWorldWithCard = true;
await pl.writeCardWorlds('alice.png', []);

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

// ===== API 连接快照 =====
const conn = pl.captureConnection(oaiStub);
ok('拍到连接快照', !!conn && conn.chat_completion_source === 'deepseek' && conn.custom_url === 'https://example.test/v1');
ok('连接快照不含非连接字段', conn && !('temperature' in conn) && !('top_p' in conn), JSON.stringify(Object.keys(conn || {})));

// 模拟“被预设吞掉”
oaiStub.live.chat_completion_source = 'openai';
oaiStub.live.custom_url = '';
oaiStub.live.custom_model = '';
const changedKeys = pl.applyConnection(oaiStub, conn);
ok('写回连接字段', changedKeys.indexOf('chat_completion_source') >= 0 && oaiStub.live.chat_completion_source === 'deepseek' && oaiStub.live.custom_url === 'https://example.test/v1', changedKeys.join(','));
ok('一致时不再重复写', pl.applyConnection(oaiStub, conn).length === 0);
ok('温度不在保护范围', oaiStub.live.temperature === 1 && pl.applyConnection(oaiStub, { temperature: 9 }).length === 0 && oaiStub.live.temperature === 1);

// 卡上锁了连接 → 外部切预设后自动拉回
use(0, 'chat-a');
await pl.setLock('alice.png', { preset: 'B', enable: { connection: true }, connection: conn });
oaiStub.live.chat_completion_source = 'claude';
pl.installConnectionGuard();
eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER, {});
await new Promise((r) => setTimeout(r, 50));
ok('外部切预设后连接被拉回', oaiStub.live.chat_completion_source === 'deepseek', oaiStub.live.chat_completion_source);

// 没锁连接时不动
oaiStub.live.chat_completion_source = 'claude';
await pl.setLock('bob.png', { preset: 'C', enable: { connection: false } });
use(1, 'chat-x');
await pl.restoreConnectionLock();
ok('未锁连接时不干预', oaiStub.live.chat_completion_source === 'claude');
oaiStub.live.chat_completion_source = 'deepseek';

// ===== API Key 本地记录 =====
ok('secret 键名映射', pl.secretKeyName('custom') === 'api_key_custom' && pl.secretKeyName('DeepSeek') === 'api_key_deepseek');
pl.setLocalKey('alice.png', 'custom', 'sk-test-123');
ok('Key 存本机', pl.getLocalKey('alice.png')?.key === 'sk-test-123');
ok('Key 不写进角色卡', !JSON.stringify(alice().data.extensions).includes('sk-test-123'));
pl.clearLocalKey('alice.png');
ok('Key 可清除', pl.getLocalKey('alice.png') === null);
ok('无记录时 applyKeyForCard 返回 false', (await pl.applyKeyForCard('alice.png')) === false);

// 快照优先级：预设定义 > 活状态（否则永远逮到自己）
oaiStub.openai_setting_names.DEF = oaiStub.openai_settings.length;
oaiStub.openai_settings.push({ name: 'DEF', temperature: 1, prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }, { identifier: 'c', enabled: true }] }] });
const fromDef = pl.capturePromptOrder(oaiStub, 'DEF');
ok('拍快照优先取预设定义', fromDef && fromDef[0].order.length === 3, JSON.stringify(fromDef && fromDef[0].order.length));
ok('预设定义摘要可算', JSON.stringify(pl.presetPromptSummary(oaiStub, 'DEF')) === '[3,2]', JSON.stringify(pl.presetPromptSummary(oaiStub, 'DEF')));
ok('无定义时退回活状态', (pl.capturePromptOrder(oaiStub, '不存在') || []).length > 0);

// captureForCard 策略：用户改过取活状态，未改过取定义
oaiStub.openai_setting_names.PICK = oaiStub.openai_settings.length;
oaiStub.openai_settings.push({ name: 'PICK', prompt_order: [{ character_id: 100001, order: [{ identifier: 'def', enabled: true }] }] });
pl.resetLastAppliedPromptSig?.();
const pickLive = pl.captureForCard(oaiStub, 'alice.png', 'PICK');
ok('无写入记录时取活状态', pickLive[0].order[0].identifier === 'main', pickLive[0].order[0].identifier);
pl.setLastAppliedSig('alice.png', JSON.stringify(oaiStub.live.prompt_order));
const pickDef = pl.captureForCard(oaiStub, 'alice.png', 'PICK');
ok('活状态等于我们刚写入时仍取定义', pickDef[0].order[0].identifier === 'def', pickDef[0].order[0].identifier);
oaiStub.live.prompt_order[0].order[0].enabled = false;
const pickChanged = pl.captureForCard(oaiStub, 'alice.png', 'PICK');
ok('用户改过时取活状态', pickChanged[0].order[0].enabled === false, JSON.stringify(pickChanged[0].order[0]));

console.log(results.join('\n'));
const failed = results.filter((x) => x.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
