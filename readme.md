# 预设锁定 · ST-PresetLocks

按**角色卡**记住预设。同一张卡的聊天文件有多少个都用同一个预设，切到哪个角色就换回哪个预设。

绑定写在**角色卡自己身上**（`data.extensions.presetLocks`），所以卡导出、上传、换酒馆时一起走。

中文精简版，基于 [Character Locks v4.0.0](https://github.com/aikohanasaki/SillyTavern-CharacterLocks)（aikohanasaki，AGPL-3.0）重做，只保留角色卡级锁定。

## 安装

解压或复制到酒馆的第三方扩展目录：

```text
SillyTavern/public/scripts/extensions/third-party/ST-PresetLocks/
```

或者从 GitHub 安装：扩展面板 → Install extension → `https://github.com/stttwq/ST-PresetLocks`

重启酒馆，刷新页面。聊天输入框旁的**魔杖菜单**里会出现「预设锁定」。

## 怎么用

1. 在酒馆正常的预设下拉里，把某个角色切到你想给它用的预设
2. 魔杖 → 预设锁定 → 点 **✔ 存为角色卡**
3. 对每张卡重复一次
4. 之后切到这张卡（任何聊天文件），预设都会自动变成记录的那个

面板抓的是**当前正在生效的预设**，所以顺序永远是：先切预设 → 再点存。

## 自动切换的三档

| 档位 | 行为 |
| --- | --- |
| 不动预设 | 只在你点「▶ 立即应用」时换 |
| 先问我 | 切角色时弹窗确认，显示要从什么换成什么 |
| 直接换成记录的预设 | 不问，静默换（**默认**） |

## 记录存在哪

**主记录：角色卡内**，写在卡文件的 `data.extensions.presetLocks`，形如 `{ preset: "我的预设", at: 1730000000000 }`。

- 走酒馆自带的 `POST /api/characters/merge-attributes`，服务端只做深度合并这一个子键，卡的其它字段不动，写入是原子的
- 它和酒馆自己存 `fav` / `world` / `depth_prompt` 用的是同一套机制，符合角色卡 V2/V3 规范
- 面板里这条记录会标「卡内」

**兜底记录：本机**，`extension_settings.PresetLocks.characterLocks`（即 `settings.json`），按角色卡的 `avatar` 文件名索引。

- 只在卡内没有记录时生效，面板里标「本机兜底」
- 写卡失败时（无写权限、旧版酒馆没有该接口）自动落到这里，功能照旧

## 已知限制

- 云酒馆/服务器需要允许写角色卡（能编辑角色就能写）。写不进去时提示会说明，并退回本机记录
- 记录跟着**卡文件**走：删卡重导成新文件名，旧记录失效，需要重存一次
- 记录的预设若被删除或改名，切换时会提示「预设不存在」并保持原样
- 只在**切换角色 / 加载聊天**时检查一次。同一聊天内手动改预设不会被抢回，也不会被记住
- 卡内的预设名写的是你自己酒馆里的名字，把卡分享给别人时对方会看到「预设不存在」
- 与酒馆自带的 `bind_preset_to_connection`（绑定预设到连接）功能重叠。两者都写同一个预设选择框，若出现"切到错的预设"，先关掉那个

## 开发

`_test/` 里是离线逻辑测试，把 `index.js` 的 SillyTavern 导入换成桩件后直接跑真实代码：

```bash
cd _test
node build.js   # 生成 pl.mjs
node run.mjs    # 15 项断言
```

覆盖：卡内写入、卡内优先、本机兜底、写卡失败降级、明确清除不被兜底复活、群聊跳过、预设不存在、角色改名、旧版记录迁移。

## 许可

AGPL-3.0，与原版一致，`LICENSE` 已随附。原版的界面与自动切换思路来自 aikohanasaki/CharacterLocks。
