# 上游 dev 0.4.0 同步记录

## 基线

- 上游 `sganggs/Stronghold-Protocol` `dev`（与 `master` 同一 head）：`55f528e9fc4872388360ee85e13eca8594856204`
- 上游 `v0.4.0` tag：`b6d8b2ef46ed2da69585ea437c627c5fc2b4145e`
- 本地同步分支：`sync/upstream-dev-20261114`
- 分叉点 / 共同祖先：`f07b8965061bbc311ad7aa815879b09264a1e47d`（`v0.3.3`）
- 分叉点之后上游共 902 个文件发生变化，全部纳入 `docs/sync/dev-0.4.0-manifest.tsv` 逐文件清单。

## 逐文件处置

清单中的 902 行全部有最终状态，没有未决或空白状态：

| 状态 | 数量 | 处置 |
|---|---:|---|
| `added` | 50 | 上游新增文件，按上游内容加入 |
| `adopted` | 27 | 上游新增但本地同名缺失，采用上游 |
| `upstream` | 70 | 双方同名新增或 golden 基线，按用户确认采用上游 0.4.0 |
| `merged` | 14 | 无冲突三方合并 |
| `merged-local` | 64 | 文本冲突，保留本地功能并叠加上游非冲突内容 |
| `merged-upstream` | 17 | 文本冲突，采用上游行为（主要为服务端战斗/规则/机器人文件） |
| `merged-manual` | 2 | 逐块人工合并（`public/js/screens/game.js`、`server/lobby.js`） |
| `merged-doc-upstream` | 17 | 文档冲突，采用上游版本 |
| `no-change` | 636 | 本地已与上游一致，或按规则明确不改 |
| `restored-adapted` | 4 | 恢复上游测试后按本地行为适配 |
| `restored-upstream` | 1 | `public/sw.js` 按用户要求恢复上游 |

逐文件的 before/after 哈希、增删行和处置原因见 `docs/sync/dev-0.4.0-applied.tsv`。

## 用户确认过的冲突原则

- 文本代码冲突：保留本地功能，再叠加上游非冲突内容。
- 47 个双方同名新增：采用上游 0.4.0。
- `package-lock.json`：按同步后的 `package.json` 重新生成。
- 5 个本地删除文件：全部恢复上游原样。
- 测试依赖的 3 个服务端模块：一并恢复上游。
- 文档冲突：采用上游 0.4.0。

## 严格对齐上游（用户确认）

用户选择“严格对齐上游 0.4.0”后，以下本地偏离被逐文件切回上游，并重新生成受影响的 golden：

- `server/match/aiPlan.js`：恢复 `modeInactiveBonds` 过滤，采购评分不再忽略本局禁用盟约。
- `server/match/bondsMeta.js`：恢复 `computeBonds` 跳过本局禁用盟约，以及 `offBondCounts` 的“本局禁用”展示数据。
- `server/match/gamedata.js`：恢复上游 boss 共享血量倍率规则（`coop` × `alive / aliveFull`）。
- `data/config.json`：恢复上游 `bossHpScale` 配置（`perPlayer` / `coop:1` / `aliveScaling:false`），并恢复上游文件格式。
- `test/golden/matches.json`：按严格对齐后的上游行为重新计算，`test/golden.test.js` 9/9 通过。

## 几个关键文件

- `public/js/ui/shopBar.js`：18 处冲突，旧本地实现与上游卡面实现无法拼成可运行版本，最终采用上游完整实现。
- `public/js/screens/game.js`：7 处冲突手工合并；保留本地相机/主题逻辑，并补回上游 `turnCue` 声明与状态块，修复 `ReferenceError: turnCue is not defined` 导致的页面启动失败。
- `server/match/player/items.js`：保留本地 `_tryFuse` / `_fuseOnce`；上游删除了方法却保留调用，直接采用会让装备融合在运行时抛错。
- `server/match/player/round.js`：清除手工合并残留的重复 `SWITCH_EFFECTS` / `regulationBench` 与孤立 `return bench`。
- `public/js/ui/bondStrip.js`：采用上游 `bondEffectRecord` 映射，修复零层盟约弹窗显示错误。
- `public/js/media.js`：恢复上游哈希素材路径的 `/media/~hash/...` 别名支持，使恢复后的素材导入测试通过。
- `public/js/ui/effectsList.js`：补齐上游新增的 `commandDisplayText` / `bondEffectRecord` / `formatBondEffect` 导入，并按上游只在当前指挥行挂载指挥控件，修复界面 `commandDisplayText is not defined`。
- `docs/history/0.3.4.md`：上游已把开发期章节正式改名为 `docs/history/0.4.0.md`；删除旧本地文件，避免设计文档中 `§37` 重复。

## 有意保留的本地差异

`git diff HEAD FETCH_HEAD` 还列出约 400 个本地与上游不同、但上游自 v0.3.3 以来并未改动的文件。这些不是本次上游同步文件，未做覆盖；本地功能（CSP/静态服务、Demo、账号、素材缓存等）继续保留。因此不能把“本地与上游不同”简单理解为同步漏项。

`public/sw.js` 与 4 个 asset 测试的恢复与本地 `AGENTS.md` 的排除规则相反；这是用户本次明确覆盖规则后的有意选择。

## 验证

- `npm run typecheck`：通过
- 变更 JS 的 `node --check`：通过
- `test/bands/regulation-commands.test.js`：29/29
- `test/content/feedback1d-solvent.test.js`：15/15
- `test/docs-consistency.test.js` + `test/ui/asset-import.test.js` + 上述两项：92/92
- `test/ui/demo-recorder.test.js` / `test/ui/deploy-replay.test.js` / `test/bands/regulation-replay.test.js`：19/19
- `test/golden.test.js`：9/9 通过；严格对齐上游服务端行为后重新生成 `test/golden/matches.json`。
- `test/match/*.test.js`：严格对齐后复跑结果见最终提交说明。
- 界面 `commandDisplayText is not defined`：修复后 `test/ui/command-spectate.test.js` 与 `test/ui/spectate-effects.test.js` 共 7/7 通过。

## 状态

- 已提交 `b7a5cdec` 并推送；界面修复另提交 `0dbccf2a` 并推送。
- 严格对齐上游的代码、配置、测试和 golden 变更为新的本地提交，推送后以远端 HEAD 为准。
- `config/announcements.json` 保持受保护内容不变（sha256 前缀 `eb9a1dfd382a1c96f05e`）。
