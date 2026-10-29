import { state, extension_settings, dom, makeFakeSelect, pmStub } from './stubs.mjs';
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

// 14. 角色卡管理界面的下拉：渲染出预设列表并选中已绑定项
use(0, 'chat-a');
dom.els['avatar_url_pole'].value = 'alice.png'; // 面板显示的是爱丽丝
const sel = makeFakeSelect();
dom.els['preset_locks_select'] = sel;
pl.refreshEditorRow(true);
const labels = sel.children.map((o) => o.value);
ok('下拉渲染出「不绑定 + 全部预设」', labels[0] === '' && labels.includes('A') && labels.includes('C'), JSON.stringify(labels));
ok('下拉选中卡内绑定的 B', sel.value === 'B' && sel.dataset.bound === 'B' && sel.disabled === false, `value=${sel.value}`);

// 15. 下拉永远可点（禁用的下拉拿不到焦点，就会卡在旧状态）
state.ctx.characterId = -1;
state.ctx.groupId = 'g1';
pl.refreshEditorRow();
ok('无角色/群聊时下拉仍可点', sel.disabled === false, `disabled=${sel.disabled}`);
state.ctx.groupId = null;
use(0, 'chat-a');

// 16. 面板切到另一张卡 → 下拉跟着换卡，不串记录
state.ctx.characters[1].data.extensions.presetLocks = { preset: 'A', at: 1 };
dom.els['avatar_url_pole'].value = 'bob.png';
pl.refreshEditorRow();
ok('面板换卡后下拉跟着切到鲍勃的记录', sel.value === 'A' && sel.dataset.avatar === 'bob.png', `value=${sel.value} avatar=${sel.dataset.avatar}`);
dom.els['avatar_url_pole'].value = 'alice.png';
pl.refreshEditorRow();
ok('换回爱丽丝 → 下拉回到 B', sel.value === 'B' && sel.dataset.avatar === 'alice.png', `value=${sel.value}`);

// 17. 在下拉里换一个预设 → 立刻写卡并生效
state.selected = 'A';
sel.value = 'C';
await pl.onEditorChange();
ok('下拉选 C → 写进卡里', state.ctx.characters[0].data.extensions.presetLocks?.preset === 'C', JSON.stringify(state.ctx.characters[0].data.extensions));
ok('下拉选 C → 预设立刻切到 C', state.selected === 'C', `selected=${state.selected}`);

// 18. 选「不绑定」→ 卡内清除，不再自动切
sel.value = '';
await pl.onEditorChange();
state.selected = 'A';
state.selectedCalls.length = 0;
await pl.onContextChanged();
ok('选「不绑定」→ 卡内清空且不再自动切', state.ctx.characters[0].data.extensions.presetLocks === null && state.selected === 'A' && state.selectedCalls.length === 0);

// 19. presetManager.select 的三种形态都能拿到预设列表（酒馆 1.19 是 jQuery 对象）
for (const shape of ['jquery', 'element', 'string']) {
    pmStub.shape = shape;
    pl.refreshEditorRow(true);
    const n = sel.children.length - 1;
    ok(`预设下拉来源形态 ${shape}`, n === state.presets.length, `options=${n}`);
}
pmStub.shape = 'jquery';

// 20. 酒馆 1.19 的 characterId 是字符串，自动切换仍要生效
use(0, 'chat-a');
await pl.setLock('alice.png', 'B');
state.ctx.characterId = '0';
state.selected = 'A';
await pl.onContextChanged();
ok('characterId 为字符串时照样自动切', state.selected === 'B', `selected=${state.selected} characterId=${state.ctx.characterId}`);
use(0, 'chat-a');

// ===== 世界书绑定 =====
const wsel = makeFakeSelect();
dom.els['world_lock_select'] = wsel;
dom.els['world_lock_hint'] = { textContent: '' };

dom.els['avatar_url_pole'].value = 'alice.png';
await pl.refreshWorldRow(true);
ok('世界书下拉列出服务器上的世界书', wsel.children.map((o) => o.value).join(',') === ',W1,W2', wsel.children.map((o) => o.value).join(','));
ok('未绑定时下拉停在「不绑定」', wsel.value === '' && wsel.disabled === false);

wsel.value = 'W1';
await pl.onWorldChange();
ok('选世界书 → 写进卡内 data.extensions.world', alice().data.extensions.world === 'W1', JSON.stringify(alice().data.extensions));

await pl.refreshWorldRow(true);
ok('重新渲染后选中已绑定的 W1', wsel.value === 'W1' && wsel.dataset.bound === 'W1');

wsel.value = '';
await pl.onWorldChange();
ok('选「不绑定」→ 卡内写 null', alice().data.extensions.world === null, JSON.stringify(alice().data.extensions));

// 删卡连带删世界书（先问，再删）
await pl.writeCardWorld('alice.png', 'W1');
state.worlds = ['W1', 'W2'];
state.popupCalls.length = 0;
state.popupAnswers = [1];
let decided = await pl.decideWorldDelete('alice.png');
ok('删卡前先问一次', state.popupCalls.length === 1 && state.popupCalls[0].html.includes('W1'), `popups=${state.popupCalls.length}`);
ok('确认后返回待删的世界书', decided === 'W1', `decided=${decided}`);
pl.pendingWorldDelete.set('alice.png', decided);
await pl.onCharacterDeleted({ id: 0, character: alice() });
ok('删卡完成后真的删掉世界书文件', !state.worlds.includes('W1'), `worlds=${state.worlds.join(',')}`);
ok('删完清空待删队列', !pl.pendingWorldDelete.has('alice.png'));

// 共用同一个世界书 → 不问也不删
state.worlds = ['W1', 'W2'];
await pl.writeCardWorld('alice.png', 'W1');
await pl.writeCardWorld('bob.png', 'W1');
state.popupCalls.length = 0;
decided = await pl.decideWorldDelete('alice.png');
ok('其他卡共用的世界书不问也不删', decided === null && state.popupCalls.length === 0 && state.worlds.includes('W1'));

// 用户选「只删角色卡」→ 保留
state.worlds = ['W1', 'W2'];
await pl.writeCardWorld('bob.png', null);
await pl.writeCardWorld('alice.png', 'W2');
state.popupAnswers = [0];
decided = await pl.decideWorldDelete('alice.png');
ok('选「只删角色卡」→ 不删世界书', decided === null && state.worlds.includes('W2'), `worlds=${state.worlds.join(',')}`);

// 卡没绑世界书 → 不问
state.popupCalls.length = 0;
await pl.writeCardWorld('alice.png', null);
decided = await pl.decideWorldDelete('alice.png');
ok('没绑世界书的卡不问', decided === null && state.popupCalls.length === 0);

// 开关关闭 → 不问
await pl.writeCardWorld('alice.png', 'W2');
pl.settings().module.deleteWorldWithCard = false;
state.popupCalls.length = 0;
decided = await pl.decideWorldDelete('alice.png');
ok('关掉开关后不问也不删', decided === null && state.popupCalls.length === 0);
pl.settings().module.deleteWorldWithCard = true;

// 没有预先确认就不删（防止删卡流程意外连带删除）
state.worlds = ['W1', 'W2'];
await pl.onCharacterDeleted({ id: 0, character: { avatar: 'alice.png', name: 'alice', data: { extensions: { world: 'W2' } } } });
ok('没预先确认时删卡不动世界书', state.worlds.includes('W2'), `worlds=${state.worlds.join(',')}`);

console.log(results.join('\n'));
const failed = results.filter((x) => x.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
