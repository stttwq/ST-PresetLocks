# 预设锁定 · ST-PresetLocks

在**角色卡管理界面**里直接给这张卡绑一个预设。同一张卡的聊天文件有多少个都用这个预设，切到哪个角色就换回哪个预设。

绑定写在**角色卡自己身上**（`data.extensions.presetLocks`），所以卡导出、上传、换酒馆时一起走。

中文精简版，基于 [Character Locks v4.0.0](https://github.com/aikohanasaki/SillyTavern-CharacterLocks)（aikohanasaki，AGPL-3.0）重做，只保留角色卡级锁定。

## 安装

解压或复制到酒馆的第三方扩展目录：

```text
SillyTavern/public/scripts/extensions/third-party/ST-PresetLocks/
```

或者从 GitHub 安装：扩展面板 → Install extension → `https://github.com/stttwq/ST-PresetLocks`

重启酒馆，刷新页面。

## 兼容性

在真实运行的 **SillyTavern 1.19.0** 上验证过：卡内写入（`/api/characters/merge-attributes` 返回 200）、面板下拉、切角色自动换预设。

版本差异已适配两处：

- `ctx.characterId` 在 1.19 是字符串（`"40"`），旧版本是数字
- `presetManager.select` 是 jQuery 对象；旧版本可能是选择器字符串

## 怎么用

1. 点左上角 ☰ 打开**角色卡管理界面**
2. 在「标签」下面、「创作者的注释」上面，有一行 **🔒 预设锁定**，下拉里选一个预设
3. 选完立刻生效，并写进这张卡

下拉第一项是「（不绑定预设）」，选它就是解除绑定。

之后切到这张卡（任何聊天文件），预设都会自动变成绑定的那个。

## 自动切换的三档

档位在**魔杖菜单 → 预设锁定**里设（那一页只放开关和「立即应用」，绑定点在上面那个下拉里）。

| 档位 | 行为 |
| --- | --- |
| 不动预设 | 只在你点「▶ 立即应用」时换 |
| 先问我 | 切角色时弹窗确认，显示要从什么换成什么 |
| 直接换成绑定的预设 | 不问，静默换（**默认**） |

## 记录存在哪

**主记录：角色卡内**，写在卡文件的 `data.extensions.presetLocks`，形如 `{ preset: "我的预设", at: 1730000000000 }`。

- 走酒馆自带的 `POST /api/characters/merge-attributes`，服务端只做深度合并这一个子键，卡的其它字段不动，写入是原子的
- 它和酒馆自己存 `fav` / `world` / `depth_prompt` 用的是同一套机制，符合角色卡 V2/V3 规范

**兜底记录：本机**，`extension_settings.PresetLocks.characterLocks`（即 `settings.json`），按角色卡的 `avatar` 文件名索引。

- 只在卡内没有记录时生效
- 写入被服务端拒绝时（无写权限、旧版酒馆没有该接口）自动落到这里，功能照旧，提示会说明

## 已知限制

- 云酒馆/服务器需要允许写角色卡（能编辑角色就能写）。写不进去时提示会说明，并退回本机记录
- 下拉定位靠酒馆的 `#spoiler_free_desc` / `#descriptionWrapper`，如果版本改版导致找不到，这一行不会出现
- 记录跟着**卡文件**走：删卡重导成新文件名，旧记录失效，需要重新绑
- 绑定的预设若被删除或改名，下拉里仍会列出来（避免静默丢绑定），切换时提示「预设不存在」并保持原样
- 只在**切换角色 / 加载聊天**时检查一次。同一聊天内手动改预设不会被抢回，也不会被记住
- 卡内的预设名写的是你自己酒馆里的名字，把卡分享给别人时对方会看到「预设不存在」
- 与酒馆自带的 `bind_preset_to_connection`（绑定预设到连接）功能重叠。两者都写同一个预设选择框，若出现"切到错的预设"，先关掉那个

## 开发

`_test/` 里是离线逻辑测试，把 `index.js` 的 SillyTavern 导入换成桩件后直接跑真实代码：

```bash
cd _test
node build.js   # 生成 pl.mjs
node run.mjs    # 27 项断言
```

覆盖：卡内写入、卡内优先、本机兜底、写卡失败降级、明确清除不被兜底复活、群聊跳过、预设不存在、角色改名、旧版记录迁移、角色卡界面下拉的渲染与写入、`characterId` 字符串、三种预设下拉来源形态。

## 许可

AGPL-3.0，与原版一致，`LICENSE` 已随附。原版的界面与自动切换思路来自 aikohanasaki/CharacterLocks。
