import { state, extension_settings } from './stubs.mjs';
import * as pl from './pl.mjs';

const results = [];
const ok = (name, pass, extra = '') => results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);

// 角色卡：两张卡，avatar 是键
state.ctx.characters = [
    { name: '爱丽丝', avatar: 'alice.png' },
    { name: '鲍勃', avatar: 'bob.png' },
];
const use = (i, chatId = 'c1') => Object.assign(state.ctx, { characterId: i, chatId, groupId: null });

// 1. 角色卡级记录：同一张卡的两个不同聊天文件共用一个预设
use(0, 'chat-a');
pl.setLock(pl.cardKey(), 'B');
ok('存记录键为 avatar', Object.keys(pl.settings().characterLocks)[0] === 'alice.png', Object.keys(pl.settings().characterLocks).join(','));

use(0, 'chat-b'); // 换成同一张卡的另一个聊天
state.selected = 'A';
await pl.onContextChanged();
ok('同一张卡换到另一个聊天 → 自动切到 B', state.selected === 'B', `selected=${state.selected}`);

// 2. 已经是目标预设时不重复切换
state.selectedCalls.length = 0;
state.selected = 'B';
await pl.onContextChanged();
ok('已正确时不再切换', state.selectedCalls.length === 0, `calls=${state.selectedCalls.length}`);

// 3. 切到另一张未记录的卡 → 不动
state.selected = 'C';
state.selectedCalls.length = 0;
use(1, 'chat-x');
await pl.onContextChanged();
ok('未记录的卡不动预设', state.selectedCalls.length === 0 && state.selected === 'C');

// 4. 切回记录卡 → 切回 B
use(0, 'chat-a');
await pl.onContextChanged();
ok('切回记录卡 → 切回 B', state.selected === 'B', `selected=${state.selected}`);

// 5. 群聊不参与
state.ctx.groupId = 'g1';
state.ctx.characterId = 0;
state.selected = 'C';
state.selectedCalls.length = 0;
await pl.onContextChanged();
ok('群聊不动预设', state.selectedCalls.length === 0 && state.selected === 'C');
state.ctx.groupId = null;

// 6. 记录的预设被删 → 不切、保持原样
state.presets = ['A', 'C']; // B 被删
pl.setLock('bob.png', 'B');
use(1, 'chat-y');
state.selected = 'A';
await pl.onContextChanged();
ok('预设不存在时保持原样', state.selected === 'A', `selected=${state.selected}`);
state.presets = ['A', 'B', 'C'];

// 7. 模式 never → 不自动切
use(0, 'chat-a');
pl.settings().module.autoApply = 'never';
state.selected = 'C';
state.selectedCalls.length = 0;
await pl.onContextChanged();
ok('never 模式不自动切', state.selectedCalls.length === 0 && state.selected === 'C');
pl.settings().module.autoApply = 'always';

// 8. 角色改名后记录仍然生效（键是 avatar）
delete extension_settings.__cache;
state.ctx.characters[0].name = '爱丽丝-改名版';
use(0, 'chat-a');
state.selected = 'A';
await pl.onContextChanged();
ok('改角色名后记录仍生效', state.selected === 'B', `selected=${state.selected}`);

// 9. 旧版按名字存的记录迁移到 avatar
extension_settings.PresetLocks.characterLocks = { 鲍勃: { preset: 'C', at: 1 }, 'ghost.png': { preset: 'A', at: 1 } };
const moved = pl.migrateByName();
ok('旧版名字记录迁移为 avatar 键', moved === 1 && extension_settings.PresetLocks.characterLocks['bob.png']?.preset === 'C' && !('鲍勃' in extension_settings.PresetLocks.characterLocks), `moved=${moved}`);

console.log(results.join('\n'));
console.log(results.some((r) => r.startsWith('FAIL')) ? '\n有失败项' : '\n全部通过');
