import { state, extension_settings } from './stubs.mjs';
import * as pl from './pl.mjs';

const results = [];
const ok = (name, pass, extra = '') => results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);

// 两张卡：avatar 是键，data.extensions 是卡内记录的位置
state.ctx.characters = [
    { name: '爱丽丝', avatar: 'alice.png', data: { extensions: {} } },
    { name: '鲍勃', avatar: 'bob.png', data: { extensions: {} } },
];
const use = (i, chatId = 'c1') => Object.assign(state.ctx, { characterId: i, chatId, groupId: null });
const alice = () => state.ctx.characters[0];
const bob = () => state.ctx.characters[1];

// 1. 存记录：写进角色卡内
use(0, 'chat-a');
let r = await pl.setLock(pl.cardKey(), 'B');
ok('存记录写进角色卡', r.ok && r.where === '卡内' && alice().data.extensions.presetLocks?.preset === 'B', JSON.stringify(alice().data.extensions));
ok('请求打到 merge-attributes', state.fetchCalls.at(-1).url === '/api/characters/merge-attributes' && state.fetchCalls.at(-1).body.avatar === 'alice.png');

// 2. 同一张卡换到另一个聊天文件 → 自动切到卡里记录的预设
use(0, 'chat-b');
state.selected = 'A';
await pl.onContextChanged();
ok('同一张卡换聊天 → 自动切到 B', state.selected === 'B', `selected=${state.selected}`);

// 3. 已经是目标预设时不重复切换
state.selectedCalls.length = 0;
state.selected = 'B';
await pl.onContextChanged();
ok('已正确时不再切换', state.selectedCalls.length === 0, `calls=${state.selectedCalls.length}`);

// 4. 未记录的卡不动
state.selected = 'C';
state.selectedCalls.length = 0;
use(1, 'chat-x');
await pl.onContextChanged();
ok('未记录的卡不动预设', state.selectedCalls.length === 0 && state.selected === 'C');

// 5. 切回记录卡 → 切回 B
use(0, 'chat-a');
await pl.onContextChanged();
ok('切回记录卡 → 切回 B', state.selected === 'B', `selected=${state.selected}`);

// 6. 群聊不参与
state.ctx.groupId = 'g1';
state.ctx.characterId = 0;
state.selected = 'C';
state.selectedCalls.length = 0;
await pl.onContextChanged();
ok('群聊不动预设', state.selectedCalls.length === 0 && state.selected === 'C');
state.ctx.groupId = null;

// 7. 记录的预设被删 → 不切、保持原样
state.presets = ['A', 'C']; // B 被删
await pl.setLock('bob.png', 'B');
use(1, 'chat-y');
state.selected = 'A';
state.selectedCalls.length = 0;
await pl.onContextChanged();
ok('预设不存在时保持原样', state.selected === 'A', `selected=${state.selected}`);
state.presets = ['A', 'B', 'C'];

// 8. never 模式不自动切
use(0, 'chat-a');
pl.settings().module.autoApply = 'never';
state.selected = 'C';
state.selectedCalls.length = 0;
await pl.onContextChanged();
ok('never 模式不自动切', state.selectedCalls.length === 0 && state.selected === 'C');
pl.settings().module.autoApply = 'always';

// 9. 卡内为主：卡里 B、本机 C → 用卡里的 B
use(0, 'chat-a');
pl.settings().characterLocks['alice.png'] = { preset: 'C', at: 1 };
state.selected = 'A';
await pl.onContextChanged();
ok('卡内为主，压过本机记录', state.selected === 'B', `selected=${state.selected}`);

// 10. 写卡失败 → 退回本机兜底仍可用
use(1, 'chat-y');
delete bob().data.extensions.presetLocks; // 卡里没有记录，只能靠兜底
state.fetchOk = false;
r = await pl.setLock('bob.png', 'C');
ok('写卡失败时落到本机兜底', !r.ok && r.where === '本机' && pl.settings().characterLocks['bob.png'].preset === 'C', `reason=${r.reason}`);
state.selected = 'A';
await pl.onContextChanged();
ok('兜底记录照样能套用', state.selected === 'C', `selected=${state.selected}`);
state.fetchOk = true;

// 11. 卡内明确清除后，本机记录不会把它复活
state.ctx.characters[1].data.extensions.presetLocks = { preset: 'C', at: 1 };
pl.settings().characterLocks['bob.png'] = { preset: 'C', at: 1 };
use(1, 'chat-y');
await pl.clearLock('bob.png');
state.selected = 'A';
state.selectedCalls.length = 0;
await pl.onContextChanged();
ok('清除后本机记录不复活', state.selectedCalls.length === 0 && state.selected === 'A' && !('bob.png' in pl.settings().characterLocks));

// 12. 改角色名后记录仍生效（键是 avatar）
alice();
state.ctx.characters[0].name = '爱丽丝-改名版';
use(0, 'chat-a');
state.selected = 'A';
await pl.onContextChanged();
ok('改角色名后记录仍生效', state.selected === 'B', `selected=${state.selected}`);

// 13. 旧版按名字存的记录迁移到 avatar
extension_settings.PresetLocks.characterLocks = { 鲍勃: { preset: 'C', at: 1 }, 'ghost.png': { preset: 'A', at: 1 } };
const moved = pl.migrateByName();
ok('旧版名字记录迁移为 avatar 键', moved === 1 && extension_settings.PresetLocks.characterLocks['bob.png']?.preset === 'C' && !('鲍勃' in extension_settings.PresetLocks.characterLocks), `moved=${moved}`);

console.log(results.join('\n'));
const failed = results.filter((x) => x.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
