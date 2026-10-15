# 合并上游时的仓库约定

本文件适用于整个仓库，记录本分支相对上游增加的行为及合并验证要求。合并时保留上游的功能更新，同时维护以下约定；不要用整文件覆盖的方式解决冲突。用户明确调整需求时，以用户指示为准，并同步更新本文。

## 上游合并优先级

- 本仓库是上游的服务端优化分支。后端、网络、WebSocket、房间/匹配、持久化、监控、Worker、部署、CDN 服务端和高并发优化以本仓库为准；上游删除或重写这些能力时不接受直接删除。
- 游戏逻辑以上游为准：干员、敌人、技能、特性、数值、战斗规则、模拟实现及对应客户端玩法更新应合入用户指定版本（当前为 `v0.2.4`），不因后端分支差异而回退。用户指定的上游仓库为 `https://github.com/xinhai-ai/Stronghold-Protocol`（2026-10-11 指定；其 `master` 已包含原 `sganggs/Stronghold-Protocol` 的 `v0.2.4`，因此以它为准可一次覆盖两者）。
- 本仓库特色功能必须保留并逐段适配，包括局内聊天、房间 Worker、状态增量、监控接口、持久化恢复、公告、CDN、资源预载、作战统计、自定义快捷键及其他本文件记录的分支行为。
- 共享文件按职责逐段处理：游戏规则片段以上游为准，协议/服务端/状态所有权片段以本仓库为准；禁止用整文件 `ours`/`theirs` 解决冲突。上游删除的测试、文档或工具若对应本仓库后端能力，也保留本仓库版本并补做上游玩法适配。

## 开始合并前

- 检查 `git status`、暂存区和上游差异，保留已有的本机修改。`config/announcements.json` 可能包含正在使用的公告排期，不要覆盖或顺手提交。
- 先识别上游是否修改了前端加载入口、模拟模块导入、静态服务、构建/启动脚本及监控接口；这些是本分支的主要冲突点。
- `public/build/`、`public/vendor/`、素材和依赖是生成文件，不应纳入源码提交。合并 `package.json` 的依赖后使用 npm 更新 `package-lock.json`，保留版本元数据一致。
- 本分支的相关实现起点为 `f164a5e`（Vite 打包、SW 排除构建文件、监控接口拆分）。后续合并以当前代码和测试为准。
- 获取上游引用后核对用户指定的版本标签及提交，不把标签之后的开发提交一并合入。先列出本次保留、排除和需要适配的改动；能按本文和用户指示确定的直接合并、逐段处理冲突，确实无法定夺的规则或行为先问用户。
- 排除一项上游功能时，同时核对其实现、提取/构建工具、清单、文档和测试，不能只移除入口而留下不一致的预期。共享文件中仍保留上游其他功能更新，不以整文件选 ours/theirs 代替逐段合并。
- 合并前复现可能影响验收的测试失败并记录证据。暂存时只纳入本次任务路径；同一文件含已有本地修改时按块暂存，提交后核对原有修改仍保留。

## Vite 构建与源码模式

- `public/index.html` 和 `public/js/` 保持为可直接运行的源码；不要用构建产物覆盖源码。
- `npm run build` 先运行 vendor 准备，再由 `vite.config.js` 输出到 `public/build/`。`base` 为 `/build/`，`publicDir: false`，避免将全部素材和可选字体复制进构建目录。
- `server/index.js` 在存在 `public/build/index.html` 时，用构建 HTML 响应 `/` 和 `/index.html`；没有产物时回退到源码页面。
- `npm run dev` 使用 `--source-client` 强制提供源码页面，即使已经有构建产物。生产源码更新后需要重新构建并重启服务。
- Preact/hooks/htm 应保持同一个 UI 库实例。渲染器、战斗模拟和 Three.js 保持按需加载，不能因为合并或分包配置变化进入首屏静态依赖。
- `vite.config.js` 对 HTML 有适配：移除源码 import map/modulepreload、合并页面 CSS、保留可选 `/fonts/fonts.css`，并让 Pixi/Spine prefetch 与实际注入的哈希脚本一致。上游修改 HTML 标签格式、脚本入口或字体顺序时，检查这些处理是否仍生效，尤其是样式覆盖顺序和启动失败提示。

## 浏览器模拟与动态导入

- `public/js/battle/runner.js` 的默认模拟入口使用明确的 `/sim/…` 导入，便于 Vite 解析并生成延迟加载的模拟包。自定义 `base` 的动态导入保留给工具和测试使用。
- `server/sim/content/index.js` 的技能层级和领域模块，以及 `bands.js`、`bonds.js` 的子模块，使用包含明确路径的加载回调。上游新增模块时同步维护列表及安装顺序。
- 不要恢复成单纯的 `import(path)` 或变量拼接加载列表：原生 ESM 可以运行，但 Vite 可能遗漏依赖。遗漏可能被原有异常隔离捕获而退回通用技能，因此“构建成功”不足以证明模拟完整。
- 保留模块加载失败的日志和异常隔离，不改变服务器原有规则行为。纯技能实现、常量和数据更新尽量直接合并，避免维护另一份浏览器规则。
- `vite.config.js` 将模拟依赖的 `server/data.js` 替换为浏览器数据桥接，桥接从同一份 `simdata.js` 的 `getSimData()` 读取注入数据，不能创建第二份模拟数据状态。
- 构建插件按 AST 移除 `simdata.js` 的 `if (IS_NODE)` 初始化分支，并拒绝打包 `nodeData.js`。上游改变该初始化结构时必须同步适配；不要把 Node 文件系统 API、研究数据回退或服务器数据加载打进浏览器包。
- `public/js/render/app.js` 使用 `new URL(..., import.meta.url)` 为 Pixi/Spine 生成哈希资源地址；Three.js 默认使用可解析的明确导入，自定义 URL 的加载方式保留。
- 合并后运行打包模拟与 Node 原版的结果比对；上游新增重要机制时，扩充有代表性的比对场景。现有几个固定种子不能覆盖全部玩法。

## 本分支游戏规则

- 0.2.4 共享干员/装备库存按上游规则：同盟共享干员池为单人两倍，自选库存仍为个人独立 8/5 份。拟态物质等超额授予保持有符号剩余份数，对外可用数归零；Redis 检查点和完整 Match Worker 恢复不得截掉负数，否则归还时会错误释放库存。装备库存由已恢复的手牌、临时区、装备槽实时推导，不另存一份可漂移计数。保留旧检查点兼容，跨版本进行中对局的容量变化仍需部署验证。
- 干员被动/特质赠送装备不占用、不受共享装备库存限制，包括缪尔赛思、耶拉等固定赠送、随机赠送、复制/再次触发的特质及休整期赠送。通过服务端特质上下文识别来源，不能按装备名称一概豁免，也不改变商店、机变、奖励、策略/物品效果或控制台的普通获取。装备实例的可选 `itemPoolCopies` 记录实际占用：赠送为 0，赠送与普通各一份合成进阶为 1，纯普通进阶为 2；合成、装备、回收、消耗、销毁、淘汰及 Redis/Match Worker 恢复均保持来源计数。赠送装备直接升级仍为 0；旧存档缺少来源字段按原普通/进阶 1/2 份解释，不能猜测或批量免除同名旧装备。新增行为有 `test/match/passive-item-stock.test.js` 和真实 Redis 回归。
- 模式的 `inactiveBondIds` 与开局随机盟约 ban 继续参与干员池过滤：仅当干员的所有盟约都在两者并集中时才 ban 该干员。保留 `drawDisabledBonds()`、干员池和本局禁用干员的现有行为。
- 模式名单不再禁止盟约激活或效果触发；保留下来的干员及装备赋予的盟约照常计数、激活并进入战斗输入。界面将模式名单和随机 ban 都解释为阵容不完整，不标注“该盟约不会激活”；AI 不按模式名单排除盟约，机变候选继续按实际干员池判断。
- 最终攻势及隐秘核心的 Boss 共享血量池：单人 `bloodPoint × 1`，多人 `bloodPoint × 4 × min(存活人数, 4) / 4`，存活人数取每个 Boss 回合开始时的值。模式及全局配置均启用 `aliveScaling`，保留模式优先、人数上限和未传人数按满队计算的行为；普通敌人倍率不变。
- 重新生成数据时维护 `tools/build-data.mjs` 中同样的血量配置，不恢复上游的单人 0.25／多人 1 或模式盟约激活限制。
- 联防保留本回合战场的地形、围栏、阻隔工事及平台，并继续应用每位援助者自己的设备改造效果。`escaped_single` / `escaped_multi` 用于漏怪重入批次与路线，不替换成平坦地图；仅在当前战场数据缺失时使用模板地图回退。援助者左右顺序、携带状态、联防归责与禁用战斗叠层规则不变。客户端 BattleSpec、服务器模拟和观战元数据须使用同一 stageId，保留 `test/match/feedback5-unite-map.test.js` 对 #282 的阻挡物和双方模拟回归。

## 本分支界面与素材取舍

- 界面主题（`uiTheme`，用户要求 2026-10-15「主页用上 yzrt-master 的液态玻璃」）：设置项 `uiTheme`（`UI_THEMES = ['default','glass']`，默认 `default`）由 `ui/settings.js` 的 `applyUiTheme()` 写到 `<html data-ui-theme>`，与其它设置一起持久化在 `sp.pref.settings`，刷新后保持。切换入口是大厅顶栏工具行**第三个**的图标方形按钮（顺序为 设置、玩法说明、**液态玻璃**、大厅背景、全屏、音乐、添加到桌面；用户 2026-10-15 先要求放在「添加到桌面」旁，随后改为第三个）（`ui/theme.js` 的 `UiThemeButton`，`data-testid="ui-theme"`，水滴图标 `droplet`，`title`/`aria-label` 为「液态玻璃主题」/「切换回默认主题」，`aria-pressed` 表示当前生效），不需要确认也不需要重启。皮肤只上色：`css/glass.css` 里不得出现 `display`/`position`/`padding`/`margin`/`width`/`height`/`gap`/`inset`/`font-size`，也不得定义 `--t`（`test/ui/glass-theme.test.js` 会拦），所以它能与「文字大小」任意组合。玻璃结构取自 `F:\WeChat\yzrt-master\纯CSS液态玻璃`（四层 inset 白色高光边 + 内圈模糊透镜环 + 45° 高光扫过 + `backdrop-filter`），两处刻意的偏离：**不用** `filter: contrast(3)`（它给后代建 containing block 与新 backdrop root，会同时破坏面板的 `backdrop-filter` 和顶栏内部 `position: fixed` 的设置/玩法说明/账户弹窗），高光对比度直接写进 alpha；按暗色重调（内圈改暗、高光偏薄荷）。**通透优先**：`--glass-blur` 只有 3px（原版 2px）、填充 `rgba(255,255,255,.045)`，再配 `saturate(1.35) brightness(1.06)` —— 大模糊会变成磨砂塑料，用户 2026-10-15 明确否掉过一版 12px。`--glass-*` 令牌与全部规则都挂在 `html[data-ui-theme="glass"]` 下，`glass.css` 在 `public/index.html` 里排在 `utility-mobile.css` **之后**（最后一个样式表，覆盖两者）。2026-10-15 的三次追加要求：右下角「搜寻队友」（`.hub-entry--bright`）不再是薄荷实心，改成薄荷玻璃 `rgba(78,216,175,.26)` 并把原来的深色字换成浅色（半透明底上深字会糊）；大厅里**所有**灰色小字改薄绿（用户 2026-10-15 纠正：是 hub 的全部灰字，不是某一处）：在 `html[data-ui-theme="glass"] .lobby-hub` 作用域内把灰色文字令牌整体换成 `--glass-en`：`--text-lo`（`#8a948f`，ghost 按钮标签「返回」「公告」及各类次级标签）与 `--text-dim`（`#5d6863`，更暗的小字），于是 tile / entry / 卡片 / 弹窗 / 顶栏里所有用它的小字（JOIN WITH KEY、SOLO、ALLIANCE、空位提示、tips、bgset 说明…）一次到位；正文用的 `--text-md`（`#c3cbc7`，接近白）与标题用的 `--text-hi` 保持原样，长段落不跟着变绿；写死颜色的少数位置（`.hub-plate__tag` 的 REPORT、名片上的 LOCAL 本机账号、`.hub-recruit__pulse` 脉冲点）另补规则；右上角账号胶囊本身是玻璃，但名片层 `.nc-layer`（`--nc-shade` + 名片图 + `#101514`）会把整块盖成不透明深色，玻璃主题下该层降到 `opacity: .5` 并一起 `backdrop-filter`，于是名片和玻璃同时可见。测试 `test/ui/glass-theme.test.js`（静态守卫）与 `test/ui/glass-theme.e2e.test.js`（`SP_E2E=1` + Chrome，写 `test/e2e/out/theme-*.png`）。

- 大厅背景照片上的**顶部黑色遮罩已去掉**（用户 2026-10-15「上面的黑色遮罩去了，不好看」）：删掉 `.hub-bg__vignette` 的 `linear-gradient(180deg, rgba(0,0,0,.42), transparent 16%)`（16% ≈ 165px，正是那条横贯整屏、下缘发虚的黑带），只留四周的径向暗角；`.hub-topbar` 的顶栏遮罩由 `.85` 压到 `.5`（玻璃主题下 `.3`）。两条都写在 `css/glass.css`（最后加载，同选择器自然覆盖 `lobby.css`），因此**两套主题都生效**。`.hub-bg__shade`（自定义照片的整体压暗）保留：它由「大厅背景」的 dim 滑块控制（默认 45%），是全屏均匀压暗而不是顶部那条带，玩家可自行调到 0。`test/ui/glass-theme.test.js` 与 e2e 都断言这条带子不再出现。

- 头像 P2P（用户要求 2026-10-15「头像直接跟队友打 P2P 传给队友，不用服务器传」）：本机账号的头像（`ui/accounts.js`，128×128 JPEG data URL，上限 `AVATAR_MAX = 160_000`，存在 `sp.pref.localAccount`）不再只留在本机——同房玩家之间用 **WebRTC DataChannel** 直接互传，服务器**只转发信令**（`shared/protocol.js` 的 `rtc.signal`，`server/lobby.js` 的 `rtcSignal`）：校验两端在同一房间（座位或观战席）、过 `TokenBucket(60/s, burst 120)`、`data` 上限 `RTC_LIMITS.signalLen = 16 KiB`，然后原样转发，**不落库、不解析、不存图片**（静态测试断言处理函数里没有 `JSON.parse` 与任何写注册表动作）。客户端在 `public/js/ui/peerAvatars.js`：每个队友一条 `RTCPeerConnection`（房间最多 4 席 ⇒ 满房 6 条），按 perfect negotiation 由 playerId 大的一方发 offer 并建 channel、小的一方 polite 让路；头像 JSON 按 12 KiB 分片（`avatarFrames`/`foldAvatarFrame`），超过 512 KiB 发送缓冲时等待；收到后校验成 `{ id, name, tag, avatar }` 缓存并广播给订阅者。显示侧不用改界面：`accounts.js` 的 `accountOf`/`useAccount` 在非本人时返回 P2P 收到的账号，于是房间座位（`screens/room.js` 的 `AvatarFrame`）、`AccountTag`、聊天里的 `#tag` 都自动生效；没收到（旧客户端、WebRTC 被墙、浏览器不支持）就退回原来的名片干员与首字母，**绝不改走服务器**：用户明确要求「P2P 没传成功可以用其他方式，但不能消耗服务器流量」，所以没有「服务器代传」这条退路，e2e 的第二个用例把 `RTCPeerConnection` 拿掉后，断言两边 WS 出站帧里没有任何图片字节。**没有开关**（用户 2026-10-15「设置不要新增头像 P2P，我就是想要默认 P2P」；先做过一版 `p2pAvatar` 开关，随后按要求整条删掉：`gameLogic/settings.js` 不留该字段、旧存档里若有也被忽略、设置弹窗与 i18n 键一并移除）：`main.js` 启动时 `startAccounts()` → `startPeerAvatars()`，只要浏览器有 WebRTC 就常开。ICE 默认 `stun:stun.miwifi.com:3478` + `stun:stun.l.google.com:19302`（Google 的在国内不通），可用 `globalThis.SP_ICE_SERVERS` 换成自建 STUN；**故意不用 TURN**（那会把图片重新放回服务器），对称 NAT/CGNAT 打不通时按上面的回退显示。账号弹窗里那句隐私说明已改成「…只有和你同一个房间的队友会通过浏览器直连收到你的头像…」。测试：`test/lobby-rtc-signal.test.js`（真实 WS：同房中继、跨房/自己/未知玩家被拒、信封与长度上限、限流、观战席可用）、`test/ui/peer-avatars.test.js`（分片/重组/校验 + 静态契约：出站帧只有 `rtc.signal`、头像只走 `dc.send`、设置里不存在 `p2pAvatar` 字段）、`test/ui/peer-avatars.e2e.test.js`（两个独立浏览器上下文真实同房互传，并断言 WS 出站帧里从未出现 `data:image/`；第二个用例把 `RTCPeerConnection` 拿掉，断言只退化成名片、两边 WS 出站帧里没有任何图片字节；截图 `test/e2e/out/p2p-*.png`）。

- 非战场管理界面的移动端密度规则位于倒数第二个加载的 `public/css/utility-mobile.css`，仅调整标题页、大厅/房间、资源管理、设置/快捷键、公告/关于、干员调配/持有/自选、本机历史、玩法说明、本局信息、控制台和作战统计小窗；不改战场、商店、HUD 几何、聊天尺寸或全局 `rem`。管理弹窗显式 `utility: true`，保持桌面宽度、焦点管理、标题/关闭按钮及正文滚动；移动端按安全区域和动态视口展开，控件采用不互相覆盖的实际点击区域。正文大小由 `--utility-text` 在原 `--t` 设置上加局部可读下限，`--t` 仍只由 theme.css 定义。所有移动端页面均保留全局强制横屏，包括管理弹窗、玩法说明和作战统计，不设置竖屏豁免。资源必备/可选分类在横屏保持双栏，仅窄于 560px 时堆叠；移动端作战统计固定标题/范围切换/关闭按钮，正文按排行优先整体滚动，排行不能被固定总计、图例或说明挤到零高度；角落上方不足 128px 或角落不在可见视口时，改为视口内浮动定位，监听 visualViewport 的尺寸/偏移变化。桌面保留独立排行滚动；自身数据口径、四类伤害色条和四项数值不变。验证 `test/ui/combat-metrics-layout.test.js`、`test/ui/utility-mobile.test.js`、文字大小、设备、资源、统计及 Vite 构建测试；尺寸预算静态测试不等同于浏览器/真机实测。

- 同盟模拟房间顶部的统计、设置、玩法说明在所有设备均使用图标方形按钮，不显示文字，保留 `title`、`aria-label` 和原点击动作；独立模拟的组件标签不改。移动端房间标题必须与控制区、邀请区始终同一行，工具/连接状态、邀请区以及底栏选项/状态/动作使用明确的 grid area，并统一取消顶部/底部固定高度；不能仅在 760px 以下适配而遗漏横屏手机。密钥字符格随自身字号缩放，工具按钮不依靠裁掉嵌套文字来假装图标模式。短屏同盟房间可整体滚动，保留座位区最小高度；竖屏座位使用不小于实际卡片的自动行，避免 `min-height` 卡片越过 `minmax(0, 1fr)` 行而重叠。验证 `test/ui/room-mobile.test.js` 的组件和 CSS 层叠回归及现有设备/构建测试。

- 局内“交流”弹出面板左侧提供“表情 / 历史”SVG 图标切换按钮，复用 `GIcon` 图标系统，用 `title` 和 `aria-label` 保留文字提示及无障碍名称；两种内容复用同一显示区，不再并排展示历史。每次打开默认显示六个表情，历史按钮显示条数，历史列表独立纵向滚动。文字输入固定在两种视图的下方，切换不清空草稿；保留动态视口高度和安全区域限制。

- “交流”采用小尺寸组件：桌面面板宽度最多 260px、表情格高 44px；移动端宽度最多 220px、表情格高 32px。表情区与翻页区使用正常网格布局，不用固定小高度或绝对定位叠在一起；图片限制在各格的可用区域，完整显示两行表情，翻页触控范围不能覆盖表情。历史视图使用与表情区相同高度。输入与发送控件保持单行，固定 24px border-box 高度、20px 行高及 1px 纵向内边距，避免继承的大行高撑开组件；输入区纵向内边距为 2px。更窄视口遵循安全区域限制；移动端文字输入字号为 16px，避免输入时自动放大。保留发送冷却期间的输入焦点。

- 文字聊天发送及冷却期间不禁用输入框、不丢失其焦点；点击发送保持输入焦点及移动端键盘，冷却只阻止发送，仍可继续编辑。发送成功只清除仍与本次提交相同的草稿，不能清掉等待回复期间新输入的下一条消息。若启用审核，聊天正文在服务端转发给对局前审核；不记录审核触发、通过或降级日志，仅明确拒绝时记录不含正文、昵称、令牌和地址的日志标记。

- 局内“交流”保留表情，并提供最多 20 个 Unicode 码点的单行文字聊天（中文或普通 emoji 各计一字，组合 emoji 按码点计数），客户端和服务端均校验，拒绝空白、控制字符及无效 Unicode。文字与表情共用 1 秒冷却，仅当前局玩家可发送，观战席不可发送；服务端广播可信发送者身份。头像旁显示文字气泡，“交流”内可回看当前页面接收到的本局最近 100 条文字消息（姓名、时间、正文）；不上传聊天历史、不持久化，换局或退出清空，页面刷新不恢复，滚动回看时不强制跳到底部。文字仅按纯文本渲染，不解析 HTML。启用名称审核器时，聊天审核使用同一双审核配置，任一明确拒绝会返回“该内容不可用”，服务异常按 fail-open 继续发送。每个玩家最多一个待审核消息；审批绑定原会话、连接及对局，退出、换局、重连或关闭后不转发旧消息。

- 局内“交流”的表情面板另加六套自带表情（用户要求 2026-10-11/13，素材 `D:\表情\weishu`）：鹿乃、超辉夜姬、十年星扉、十年星扉动态（唯一 `.gif`，写 `ext: 'gif'`）、星白、迷迭香，各 6 张（迷迭香 300/312，勿改尺寸），放 `public/assets/local/emoticon/<dir>/pic_*_battle.<ext>`；只进 `CUSTOM_EMOTE_THEMES`，不进 `EMOTE_THEMES` / `EMOTE_CATALOG` / `EMOTES`（`data/emotes.json` 仍须与官方表逐字一致）。`ALL_EMOTE_THEMES` 按 `EMOTE_PAGE_ORDER` 交错出 12 页（缺/重/未知即报错），`EMOTE_IDS` 是 `g.emote` 白名单；翻页显示不可点的 `1/12`，触控区仍只属 ‹ / ›。清单不手改，但这些图必须能被预载：`shared/constants.js` 的 `CUSTOM_EMOTE_ART` 列 36 个 URL，`server/resources.js` 按必备资源并入 `/data/resource-manifest.json`（含 CDN 改写），有文件给真实 size/hash，否则用 URL 派生 hash（换图失效缓存）；客户端仍按 `emoteArtPath` 取图。改套组时同步 `public/i18n/` 四个语言包（套组名 + 6 标签）与 `test/ui/emotes.test.js`、`test/resources/manifest.test.js`。

- 干员皮肤按用户要求（2026-10-11）**构建期装好、随资源预载下发**，不做 PR 原版的「游戏里点按钮按需安装」：`tools/install-skins.mjs` 把 `docs/research/08-skins.json` 的全部皮肤（273 套 / 174 干员）下载并写进 `data/assets.json`，素材传素材 CDN；`server/resources.js` 的通用遍历自动列入 `/data/resource-manifest.json`，并按用户要求归入**可选资源**（`tierForPath()` 把 `skins` 段列入可选，干员 Spine 仍在必备档；客户端 `resourceGroup()` 单列「干员皮肤」），只有勾选「同时预载」才缓存，否则按需从 CDN 取图；`ui/skinPicker.js` 只列本机清单能画出的皮肤，无安装按钮。已删除 `server/skinInstall.js`、`room.skin.install`、`skins.changed` 与 `skin.progress`；`data/skins-installed.json` 仅作构建期记录。新增皮肤按 `docs/SKINS.md`：官方 `skin_table.json` 补 `docs/research/08-skins.json` → `node tools/build-skins.mjs` → `node tools/install-skins.mjs add-char …` → `npm run assets` → 上传 CDN。**下载与上传都在部署机上做**（2026-10-11：本机到 GitHub 约 0.08 MB/s，部署机 1–3.5 MB/s），只传 `tools/`、研究表和 `data/skins.json`，不要传 `data/skins-installed.json`（否则会被当成已装而全跳过），装完用同一台机器的上传脚本推 R2；是否已在桶里以 `--dry-run` 的对象头为准，CDN 的 HEAD 会命中边缘缓存的旧 404。**上传前不要用 CDN 探测这些路径**：边缘会把 404 按 Cache Rule 长期缓存（实测 10 小时后仍是 `cf-cache-status: HIT`），桶里有文件也照样 404，只能靠 Cloudflare 清缓存恢复；线上 `/i18n/*.json` 走素材 CDN，`/data/*.json` 走数据 CDN，两者都会被影响。
- 0.1.4 合并时确立的取舍继续适用于后续合并，除非用户明确调整：排除上游快捷键实现，保留本仓库可自定义快捷键、默认按键、提示文字及浏览器持久化设置。当前默认 W 查看怪物、S 冻结、R 刷新、C 准备、X 出售、Q 撤退、G 升级、空格暂停/继续；不要恢复上游固定 R/F/D/Space 方案。
- 不合并 3D 棋盘贴图改用 WebP 的提取、加载、文档和测试改动，继续使用 PNG（0.2.6 起 `extract.py` 的 `WEBP` 保持空表，但采纳上游**玩法说明页**的 WebP 复制 `GUIDE_WEBP_*`：`--webp` 因此只重写 guide 页，`test/local-extract.test.js` 断言 `jobs.webp` 存在且不含 guide 行）。其他棋盘材质、地形提示及渲染修复可正常合并；保留 `boardArt.js` 对裁切表素材路径的 CDN 改写。
- 标题页的“关于本服务器”入口按用户要求撤掉（2026-10-10）：`screens/title.js` 的按钮与弹窗一并移除，标题页页脚仍保留一行非官方同人复刻与素材版权说明。版权与免责声明以对应上游 `NOTICE.md` 为依据，区分自编代码许可证与游戏素材/数据权利；如需恢复该入口，按移除前的实现接回联系邮箱、反馈入口、本分支仓库链接、纯公益说明，以及非官方、非商业、无担保、不索取游戏账号和权利人联系处理说明，并在上游声明变化时同步核对文案和链接。
- “关于本服务器”弹窗已随入口一并移除，其滚动与视口约定暂时没有对应界面；若恢复该弹窗，仍须保留正文可上下滚动、标题和关闭按钮可见、动态视口高度、安全区域、正文 `min-height: 0` 和触屏纵向滚动支持，避免新增文案在移动端被截断。标题页设置入口和资源预载入口均保留。
- 同盟等待室的空位不再有“添加 AI 队友”按钮（用户要求 2026-10-06，自 fork 移植提交 `f6966ee3`）：空位只显示“空位”，房间等待真人加入；服务端 `room.addBot` 保留（同盟模拟的 AI 与协议测试仍在使用；`Lobby.seatBot` 已不存在），已入座的 AI 队友仍可由房主 ✕ 移除，玩家中途退出仍由对局自身的 `left` / `autoplay` bot 接管。
- 左下角“作战统计”按钮打开可在战斗中查看的小窗，保留本地实时干员伤害/治疗统计、整局累计与当前战斗切换和伤害降序排行；只显示自己的数据，移除玩家筛选及全队统计，观战席不显示统计入口。打开时默认显示“当前战斗”，该选项排在前面；“本局累计”由用户手动点击。同一玩家的同名干员合并展示伤害、治疗、DPS/HPS 和分色横条，当前战斗及本局累计使用相同合并规则。查看队友战场时，统计仍读取自己的战斗，不随观战画面切换。物理/法术/真实/元素 HP 伤害使用分色横条；统计实际扣血与有效治疗，召唤物归入所属干员，不将元素积累、过量治疗或友方伤害计入输出。DPS/HPS 按本机已模拟的自身战斗时间计算，暂停与倍速不改变口径；补帧、后台模拟及重复观战不能漏计或重复累计。统计不上传服务器，保留移动端触控、滚动列表、安全区域及角落按钮换行后的弹窗定位。

- 匹配没有倒计时，也没有 AI 补位（用户要求 2026-10-11）：排队只把真人凑满 4 席后立即开始，未满就一直等待，等待多久都不会补 AI。`match.join` 不再接受 `fillBots`，`match.queue` 与房间 `matching` 不再带 `deadlineAt` / `fillBots`，`Lobby` 的 `matchmakingWaitMs` 选项已移除，客户端大厅与房间都不再显示“匹配剩余”。`match.queue.count` 仍只统计该玩家实际分组的真人数，不使用同模式、同难度的全部排队人数；人数广播与开局继续使用相同的 `groupMatchEntries` 分组规则（按队伍大小 FIFO、不拆分队伍、容纳不下则跳过），队首未满时继续处理后续满员分组，不阻塞整条队列；保留原始 `queuedAt` 作为排队顺序。房间 `matching` 只保留 `queueId` 与 `queuedAt`。

- 设置保留浏览器持久化的帧率上限：不限（默认）、30、60、120 FPS。仅限制画面渲染，Pixi 干员/特效与 Three.js 棋盘共享限帧，简化 DOM 战场也遵循上限；战斗模拟、计时、倍速及联网结算保持独立。旧设置或非法值回退为不限；自动画质降级阈值适配主动限帧，不能将稳定的 30 FPS 误判为性能不足。
- 单网络限流默认 1 房 1 局（用户 2026-10-13）：`maxRoomsPerAddr` / `maxMatchesPerAddr` 默认 `1`（`0` = 不限，`SP_MAX_*_PER_ADDR` 与 `startServer` 选项仍可覆盖，本地/内网直连不受限）；`room.create` / `room.start` 各记一行 `[lobby] room created ip … code …` / `match started ip … code … match #N`（不含昵称/令牌/正文）。**无房间的独立匹配也占该网络的名额**：`room.start` 按房间对局 + 独立匹配计数，`room.create` 按独立匹配计数（房间对局由 `maxRoomsPerAddr` 管），`/metrics` 的 `matches` / `worstMatches` 一并计入；共享出口（宿舍/CGNAT）须显式调大，合并时勿恢复 16/8。

- 公告在 `config/announcements.json` 中分为 `type: "scroll"`（默认，兼容旧条目）和 `type: "popup"` 两种独立类型，分别选择当前有效内容，可同时展示，等级、过期、撤回和关闭互不影响。滚动公告保留原行为；弹窗公告支持可选 `title`、HTTP(S) 详情 `url` 和 `autoPopup`（默认 false），公告按钮只打开当前有效弹窗公告。对局期间（含开局准备、观战和结果页面）不自动弹出新公告，回到大厅或非对局页面后仅展示仍有效的当前公告；延后期间不记录已查看，手动查看照常可用且计入已查看，进入对局时关闭自动打开的公告。自动弹出按浏览器记录最近 100 个已查看版本，刷新、重连和恢复旧公告不重复弹出；标题、正文、链接、自动弹出开关或有效时间变化视为新版本。保留无公告状态、过期/撤回处理，以及可滚动正文、动态视口和安全区域。弹窗正文按作者写的换行分行显示（空行丢弃，行内连续空格合并；`normalizeAnnouncementText` 保留换行），行内出现的裸 `http(s)://` 地址渲染成带下划线的链接、点击在新标签页打开，`[显示文字](https://地址)` 把任意文字变成同样的下划线链接，`**文字**` 渲染成浅绿强调色（`.notice__accent`，不跳转），三者都只认 `http(s)`、未闭合的 `**` 原样显示（`announcementLineNodes`），正文本身仍按纯文本处理、不解析 HTML（用户要求 2026-10-11；滚动公告仍是纯文本）。大厅及房间将在线人数放在原延迟右侧，共用延迟胶囊样式；原在线人数位置改为公告按钮，标题页保留入口；设置里按用户要求不再放公告按钮（2026-10-10，`ui/settings.js` 的弹窗 actions 只留玩法说明与完成）。WebSocket 保留 `announcement` 为滚动公告，新增 `popupAnnouncement`；`/api/announcement` 保持旧滚动接口和内容摘要，`/api/popup-announcement` 独立提供弹窗公告。

- 控制台获取干员包含当前玩家本局已选自选干员的普通及精锐形态，列表使用实际名称、头像并可按槽位或干员 ID 搜索；服务端通过玩家自己的数据视图授予并保留技能、模组和合并行为。未填写的自选槽位和隐藏记录不可获取；控制台授权与 5 次/回合、50 次/全场限制不变，授予不消耗共享池或个人自选库存。

## 运行时 CDN 配置

- 页面素材与数据 CDN 地址来自服务器动态生成的 `/js/asset-cdn.js`，分别导出 `ASSETS_CDN` 和 `DATA_CDN`，并非 `/healthz` 或 `/metrics`。磁盘上的 `public/js/asset-cdn.js` 是两者均为空的配置回退。任一 CDN 设置变化都必须改变运行时模块的 ETag。
- i18n 语言 JSON 使用 `ASSETS_CDN`：`public/i18n/` 对应 CDN 的 `/i18n/`，`data/i18n/` 对应 `/data/i18n/`，目录式语言包使用 `/packs/<id>/…`。动态 `/packs/index.json` 保留同源，以源站实际安装的语言包为准。未配置素材 CDN 时保留同源路径，显式外部 URL 和自定义数据加载器 `base` 不改写；游戏文本语言包不使用 `DATA_CDN`。部署时同步相应语言目录并设置 JSON 跨域响应头，不将语言 JSON 混入素材 ZIP 或 SW 的代码/数据缓存。
- Vite 必须将此模块保留为外部的同源绝对 URL。保留 `makeAbsoluteExternalsRelative: false`，避免把 `/js/asset-cdn.js` 当成文件系统路径改写。
- 同一份构建可以通过启动时的 `SP_ASSETS_CDN` 和 `SP_DATA_CDN` 使用不同 CDN。不要在构建时固化环境配置，也不要把磁盘上的空 CDN 配置直接内联。
- 页面数据加载器、浏览器模拟和独立素材加载器直接读取数据 CDN 的静态 JSON；`shared/cdn.js` 的 `dataUrl()` 保留 `/data/local-assets.json` 与 `/data/resource-manifest.json` 的同源例外。显式传入的加载器 `base` / `url` / `dataBase` 仍优先，不能被运行时 CDN 覆盖。Node 的 `/data/` 始终提供本地数据，已移除数据 CDN 的 307 跳转，不要在合并时恢复；保留素材清单 URL 改写，合并后运行 CDN 测试。
- CDN 回源可使用 Nginx 静态文件或 Node 的本地数据响应，配置 JSON 跨域响应头并保持数据版本一致；游戏源站的运行时配置、本地素材清单和动态预载清单继续由 Node 提供。
- `public/js/render/boardArt.js` 读取静态 `tiles.json` 后也要改写 `source` 中的素材路径；仅让裁切表走 CDN 不够，否则 D、common_D、BG 图片会回到源站。保留无 CDN 和已有绝对 URL 的行为，用 `test/render/boardart.test.js` 验证。

## HTTP 缓存、Service Worker 与更新检测

- 新导出的 ZIP 清单使用 `version: 2`，每份资源只计算一次 SHA-1，保存完整 40 位 `sha1`，并从同一结果取前 12 位 `hash` 匹配服务器指纹；不再导出 SHA-256。导入按版本校验：v2 校验完整 SHA-1 及其前缀，兼容旧 v1 的 SHA-1、SHA-256 双摘要校验，不因旧包缺少 SHA-256 而自动降级。写缓存时复用与实际字节及指纹绑定的本地校验结果，不能信任包内声明或普通对象来跳过校验。未验证输入仍校验，已有缓存是另一份字节，须独立计算 SHA-1 以识别损坏副本。服务器指纹协议不变。导出使用 BlobReader，避免 Uint8ArrayReader 的额外切片复制。

- 预载入口打开统一的大资源管理模态框，保留分类文件数、大小、进度、暂停/继续、清理、关闭及 ZIP 导入导出。必备资源包括地图/棋盘网格、干员/敌人图片、Spine、视觉特效、界面/图标/字体；语音、音效、背景音乐及玩法说明图片为可选资源，`preloadOptional` 浏览器持久化且默认 false。只下载必备资源时按所选范围判定完成，不因未勾选的可选资源一直显示未完成；按需加载与已缓存内容继续可用。服务器分级处理 `map/autochess` 等带斜杠的本地分组，清单版本纳入分级变化。
- ZIP 使用本功能导出的独立资源包格式，可包含部分缓存或旧版本资源。导入先检查整包路径、数量和清单，不全量预扫描本地文件头；文件头、边界及重叠检查并入每个文件的一次解压，校验 CRC、实际解压大小及内容摘要后立即写入；任一文件损坏时报错并保留已完成写入的有效文件，不再要求整包摘要全部通过才写入。已缓存及不适用的包内文件仍须校验；以当前服务器清单的真实内容指纹决定复用，过时、已移除或只有合成指纹的资源不写入，按所选范围增量补齐。不超过 256 KiB 的小文件最多 4 路并发，包内原始字节缓冲合计最多 1 MiB，更大或大小未知的资源独占单路，避免二次解压、整包暂存和响应流克隆。CDN/站点变化按资源路径和指纹复用，写入当前清单 URL；不导入代码、游戏数据或包内缓存索引。ZIP 处理与下载/清理共享 Web Lock，取消或空间不足保留已完成的有效文件。zip.js 通过 vendor 准备且按需打包，不进入首屏静态依赖；保留 24 MiB 单资源、50,000 文件和 2 GiB 包限制，以及模态框动态视口、安全区域、滚动和触屏支持。ZIP 进度使用百分比，阶段内每 0.5 秒最多更新一次；导入时同步刷新必备/可选分类列表的数量、大小和进度，并标出当前导入分类。分类计数按完成的缓存键增量维护，UI 更新时仅复制短分类列表，不再重扫整份清单，阶段切换、完成、取消和失败立即刷新，不降低资源校验频率。相关校验覆盖 `test/resources/archive.test.js` 及现有预载/构建测试。
- 并发导入可按不同于包内顺序的顺序完成；错误或取消后不开始新写入，已开始的 Cache.put 无法取消，须等待全部结束并将成功写入记入索引后再释放 Web Lock。索引写入串行化。导入成功、失败及取消均输出仅在客户端保留的分阶段耗时摘要；阶段时间是重叠操作的累计等待时间，不当作 CPU 耗时或总耗时占比。
- ZIP 文件读取默认缓存两个按 16 MiB 对齐的文件块，总上限 32 MiB，LRU 淘汰；不超过 16 MiB 的元数据及未压缩正文共用文件块，跨块读取按顺序拼接，更大读取直接读取目标范围。同块并发请求共用读任务，分块物理读取串行化。返回独立的字节数组，不让条目保留或修改缓存块；读取缓存与小文件 pipeline 的 1 MiB 原始字节预算、大文件独占缓冲分别计量。记录 fileReadCalls、fileReadBytes、fileReadMs、maxReadAheadBytes 和 readCacheLimitBytes。成功导入后自动启用预载，通过界面的设置回调持久化开关，再按原有必备/可选选择增量补齐；失败、取消不启用原本关闭的预载。导入显示单一的逐文件处理进度，不恢复全量文件头校验阶段。
- 未压缩 ZIP 条目先由 zip.js 验证本地文件头、描述符、边界及重叠，再直接读取正文并复用 vendor 的 zip.js Crc32 实现校验，不走 Blob.stream 和通用流式复制链；Deflate 条目仍走原有有界解压路径。单个条目的 CRC、实际大小及摘要均通过才允许写入；不能只验证摘要而省略 CRC。诊断中的 metadataMs、bodyReadMs、crcMs 已包含在 readMs 内，storedFiles 记录直接读取成功的资源数。CRC 模块随 ZIP 按需加载，不进入首屏依赖。
- 已启用预载的页面启动检查只获取服务器资源清单、缓存键和本地索引，不重读或哈希资源正文。缓存键和索引并行读取，同时发生的状态检查共享正在进行的扫描并返回独立快照；只合并进行中的请求，不长期缓存结果，以便后续发现浏览器清理或资源版本变化。活动检查/下载/ZIP 期间打开资源窗口不额外扫描。启动耗时日志区分 manifestMs、cacheKeysMs、indexReadMs 和总时间。
- 棋盘资源 JSON 仅放行 `/assets/local/map/fx/materials.json`、`prefab.json` 及 `/assets/local/map/autochess/materials.json`、`tiles.json`（兼容素材 CDN 前缀），作为必备地图资源参与预载、指纹和 ZIP 导入导出，不泛化放行游戏数据或语言 JSON。`tiles.json` 从已列出的 `TX_autochessi_D.png` 同目录推导，存在本地文件或服务器哈希表记录时纳入；本地裁切表内容用于生成真实指纹，其大小/mtime 参与清单失效。带方括号的资源 URL 统一 `%5B`/`%5D`，服务器清单、磁盘路径、缓存键及 ZIP 身份一致，兼容旧 ZIP 原始方括号路径和旧缓存读取。`tools/asset-hashes.mjs` 同步此 JSON 白名单和路径规则。新增 shared/resourcePaths.js 属于 SW 依赖，生产 build 标识须覆盖，部署后更新 SW。

- HTML 保持 `no-cache`；`/build/assets/` 下带内容哈希的 JS/CSS 使用 `public, max-age=31536000, immutable`。运行时配置和非指纹代码不能套用此长期缓存。
- 资源清单缓存命中仅 stat 三个源清单和已发现的棋盘裁切表，不重读 JSON 正文、CDN 改写或全资源遍历；只合并进行中的检查/重建，后续请求重新校验。源清单及裁切表出现、删除、size/mtime 变化仍失效；失败不伪装旧数据，reset 后旧任务不覆盖新缓存。保持指纹、JSON 白名单、ETag/gzip/304/GET/HEAD，验证 `test/resources/manifest.test.js`。
- 保留 gzip、ETag/304、HEAD 和原有素材 Range 行为。
- 素材预载 SW 的 scope 为 `/`，但 `/build/` 必须直接放行，不调用 `respondWith()`。即使 Cache Storage 已有旧构建文件，也不能用它响应代码请求。
- `public/js/resources/common.js` 和 `server/resources.js` 均明确排除 `/build/`。原有规则会匹配路径任意位置的 `/assets/`，用于兼容 CDN 前缀；不能因 Vite 也使用 assets 目录而再次误匹配，也不要直接改为只匹配根 `/assets/` 而破坏 CDN。
- SW 保留素材、字体和音频预载功能；`public/resource-sw.js` 及其依赖仍单独提供。修改这些依赖后，部署时须让浏览器更新 SW。
- `buildGuard.js` 启动后及每 60 秒读取 `/healthz.build`；连续两次确认版本变化，非对局时刷新，对局时提示并等待结束。保留失败/超时不刷新的行为。
- `computeBuildTag()` 区分生产构建和源码模式：生产检测构建文件及独立 SW 依赖，源码模式检测原来的源码入口。构建标识在服务器启动时计算，不应在每次健康轮询中重扫文件。
- `emptyOutDir: false` 用于保留旧哈希分包，供尚未刷新的页面继续加载。在线更新先上传新资源，再替换 HTML；不要在线删除整个构建目录。旧文件清理安排在维护停服期间。

## `/healthz` 与 `/metrics`

- 高并发延迟优化须保留：全服广播/心跳分批让出事件循环及广播 FIFO 顺序、跨房间共享本地模拟续步预算、私有状态编码复用，以及保持原有组队规则的按队伍大小 FIFO 匹配。`/metrics.websocket.diagnostics` 的事件循环、消息耗时与发送采样仅在服务端聚合，不记录地址或正文；统计为启动以来累计，发送完成不等于客户端 RTT。`/healthz` 不增加详细诊断字段。压缩开关与原有背压阈值继续保持兼容。
- 房间 Worker 化第一阶段可通过 `SP_ROOM_WORKERS` 或 `startServer({ roomWorkers })` 启用：保留同一 `/ws` 和主线程 Match，仅将每个房间/独立匹配的战斗与 bot 预演任务固定到按活跃房间数选择的独立模拟 Worker lane；`workers` 是全 lane 总线程预算，不能让每个 lane 各自复制完整默认线程数。默认 `0` 保持单一共享池，释放房间时清理 lane 归属；这不是完整 Match 跨线程迁移，仍须继续验证主线程状态生成和发送耗时。
- 完整 Match Worker 可通过 `SP_MATCH_WORKERS` 或 `startServer({ matchWorkers })` 启用：房间/公共匹配的 Match 实例、计时器、AI、状态视图和对局生命周期在 lane Worker 中运行，主线程保留 `/ws`、身份、房间目录和消息发送；Worker 通过 `captureMatch` 提供与原 Redis 文档相同的检查点，恢复等待异步 Worker 完成后再继续启动。`/metrics.workers` 保留模拟任务池，`/metrics.matchWorkers` 单独报告 Match Worker；默认 `0` 保持旧路径。启用前必须验证多房间公共匹配、观战、重连、退出、连续重启和真实 Redis。
- 完整 Match Worker 的游戏数据每 lane 首次使用只传一次，安装线程数据源后再导入游戏模块；同 lane 的 Match 共用深冻结快照，不共用玩家库存、池或 RNG，不恢复为每局复制完整数据。Worker 编码的单播/广播 JSON 由主线程发送及回放复用，未提供编码的旧路径仍可用。初始化代理元数据全量，后续只发变化字段，连接/退出、阶段及战斗序号仍同步，IPC 失败不推进元数据基线；每个对局实例基线独立。状态增量仍由主线程管理，可靠入队基线、FIFO 及确认语义不变。验证 `test/match-worker-hotpaths.test.js`、生命周期、状态增量与持久化测试；`tools/match-workerbench.mjs` 仅为 IPC 微基准，不能当作真实对局容量或主线程 CPU 实测。
- 完整 Match Worker 的有效下行消息仅传类型和编码，不重复复制完整消息对象；主线程按需为旧回调解码，状态增量仍从编码建立独立快照，不能信任回调可变对象作为基线。原始 capture 在 Match Worker 内序列化为独占字节缓冲，主线程只转交所有权，由持久化 Worker 解码并执行原 `encodeMatchCapture`；保持 Maps、波次隐藏排期、检查点代际、失败保留及旧对象路径，IPC 字节格式不写入 Redis、不作为跨版本存档。验证 `test/encoded-message.test.js`、持久化/生命周期及真实 Redis 重启测试。

- 在线人数 `presence` 每 10 秒最低优先级刷新，人数不变仍可更新；`welcome.online` 即时提供。周期任务独立延后、分批处理，只保留最新待发快照，普通广播/心跳优先；连接已有任何发送积压时跳过本轮，下一周期再更新，不排队补发。不改变游戏状态/回复的可靠 FIFO、背压或压缩参数；已进入 WS/TCP 的字节无法抢占。关停时取消周期及待发任务，保留标题页未认证连接的周期在线人数展示。验证 `test/presence.test.js`、`test/ws-latency.test.js`。

- 状态增量通过 `hello.stateDelta: 1` 协商，仅用于 `m.public` / `m.private`；旧客户端保持原全量消息。新连接、重连及 `state.resync` 发送全量，补丁按 `base` 校验独立公共/私人基线，失败不派发部分状态，重同步限流后安静重试。基线仅在可靠帧成功入队后推进，不丢弃补丁、不改变确认时机；原全量结果回放仍可用，私人状态不跨玩家共享。源码 build 标识纳入 `shared/stateDelta.js`，生产随 Vite 网络模块打包。保留 `test/state-delta.test.js`、`test/state-delta-integration.test.js`；详见 `docs/STATE_DELTA.md`。性能验收看关联状态完成解码后的 p95 和失败率，按实际四人房间发送，不将全员合成广播视为完整对局容量；状态视图仍完整生成，不能声称已实现细粒度脏标记或压缩正文复用。

- 持续监控配置位于 `deploy/monitoring/`，采用独立 JSON collector → Prometheus → Grafana，不把游戏 `/metrics` 改成文本格式或给 `/healthz` 增加诊断。保留诊断启动以来字段；新增进程CPU累计秒、独立10秒事件循环窗口及耗时累计桶/总和供近期速率/p95查询，多抓取者不重置窗口。collector只抓固定管理员目标，失败不伪装旧数据/零CPU；可选匿名WS ping探针不创建身份/对局，不当作玩家操作状态到达RUM。面板区分压缩前应用正文、全进程RSS、Worker旧样本、单核CPU百分比和本机发送完成；未采集的客户端状态延迟明确标注。Grafana默认仅绑定本机，真实targets/密码不入Git，不挂载Docker socket，不运行 `down -v`。验证 `test/monitoring-exporter.test.js` 及诊断/接口测试；文档以 `deploy/monitoring/README.md` 为准。

- `/healthz` 保留 `ok`、`version`、`app`、`uptimeSec`、`build`。
- 高频 `/healthz` 保留同步处理路径及每服务实例独立的短期统计快照、JSON 字节复用。稳定状态下最多每秒扫描一次房间/队列；房间、活跃队列对局或排队玩家数量变化时立即失效，连接数、会话数和运行时间及时更新，既有房间内部的座位/对局计数允许最多约 1 秒的快照延迟。过期使用单调时钟，不创建后台扫描定时器，失败返回 500 并重试，不返回旧快照掩盖错误。HTTP 仍为 `no-store`，GET/HEAD 内容长度、405、URL 长度限制和安全响应头保持不变；`/metrics` 的实时统计不复用或覆盖此快照。
- 以下计数也保留在 `/healthz`：`sockets`、`sessions`、`rooms`、`matches`、`roomMatches`、`standaloneMatches`、`humans`、`bots`、`spectators`、`queued`。不要因精简接口删除这些字段；沿用现有统计含义。
- `/metrics` 返回 JSON，包含健康接口的上述字段，加上详细状态：`persist`、`workers`、`memory`、`staticCache`、`usage`、`socketBuffers`、`announcements`、`websocket`、`assetsCdn`、`dataCdn`、`limits`、`tuning`。
- 详细统计只在请求 `/metrics` 时采集；不要重新放入页面每分钟轮询的 `/healthz`。保持原有字段名、结构和未启用时的 `null` 语义。
- 两个接口均支持 GET/HEAD，保持 `Cache-Control: no-store`，其他方法返回 405。`/metrics` 保持 JSON 接口；若要改为其他监控格式，需要用户明确调整需求。
- 启动脚本、Docker 健康检查、`tools/doctor.mjs` 的端口探测和页面更新检测继续使用 `/healthz`。完整监控数据的读取者及文档指向 `/metrics`；公开统计中不列出客户端地址。

## 持久化恢复

- 对局恢复采用 best effort：逐会话、逐房间、逐局隔离异常；缺失、过期或归属另一对局的真人按现有退出规则处理，保留其余玩家、有效棋子、经济、共享池及 RNG 状态，不因一个失效座位丢弃整局，不凭空创建或转移 token。
- 房间匹配须重建匹配上下文及公共/其他房间队友的绑定；这些队友不要求出现在主房间的座位表中。主房间记录缺失时可由有效检查点重建，保留有效队友各自的房间归属和重连、退出、到期处理。
- 最新退出名单及战斗序号独立于安全检查点保存，防止战斗期间退出后复活旧座位，以及连续重启复用战斗序号接收旧上报。开局立即捕获初始安全检查点并触发异步保存；显式保存等待正在进行的写入，周期保存不积压。
- 可选字段与局部损坏尽量兼容恢复；策略阶段保留已选策略，损坏的机变阶段可回退休整期，其他不可恢复阶段回退信息确认或休整期。不得重复收入、购买及已应用的效果；降级原因记录日志，健康检查点保持完整状态比对。
- 无法立即恢复的原始检查点及关联会话保留在 `recovery`，后续保存不得清掉；下次启动继续尝试。同一房间另开新局时保留被替代的原始存档但不自动覆盖新局。恢复过程中正常结束的对局为有效 token 保留结算消息。
- Redis 启动读取失败或原始 JSON 不可读时，重试读取成功前不得写入覆盖旧状态；旧 token 等待恢复，不换发新身份。Worker 初始化或单局捕获失败不得影响其他对局保存，不回退到主线程编码。配置容量降低时保留原有活跃身份，新会话仍遵守容量上限。
- 进行中的对局在没人后至少保留 30 分钟再清理（用户要求 2026-10-11，当天有人掉线重连回来房间已消失）：`Lobby.onDisconnect` 对**任何**进行中的对局把 `session.resumeWindowMs` 设为 `matchIdleGraceMs`（默认 30 分钟，同名启动选项可覆盖；单人对局仍用 `config.constants.singleReconnectTime` 的 24 小时），所以掉线超过 `net.js` 默认 10 分钟重连窗口后，`hello` 仍能找回座位与检查点；只有该窗口真正耗尽才 `onLeave` → 空房间 `disposeRoom('empty')`。房间内没有进行中对局的大厅座位仍按 `lobbyGraceMs`（60 秒）释放。`persist.js` 按会话保存的 `resumeWindowMs` 决定检查点保留窗口，因此重启后同样保留 30 分钟。回归 `test/lobby.test.js` 的 solo/co-op resume windows 组。
- 验证包含 `test/persist-queue-recovery.test.js`、现有持久化/Worker/匹配/快照测试、真实 Redis 验证、连续重启与 WebSocket 重连；Node 验证不等于实际 HTTPS 页面或 Docker 部署验证。


## 构建与发行入口

- 0.2.1 合并按用户要求排除上游新增的发行更新 ZIP、发行清单校验和启动时删除旧文件功能，相关工具、入口、文档及测试同步排除；不影响原有完整/精简打包、Windows 便携包，以及游戏内资源 ZIP 导入导出。

- 保留 `tools/setup.mjs` 在安装了 Vite 时的构建步骤及 `--check` 的只检查行为；已含构建产物的发行包不依赖 Vite 运行。
- Docker 构建阶段需要开发依赖和 `vite.config.js`，完成前端构建；运行阶段仍只含生产依赖。`.dockerignore` 排除本机生成的 `public/build`，避免带入旧产物。
- `scripts/make-windows-bundle.mjs` 在源仓库构建，再把 `public/build` 一起放进便携包；包内只安装生产依赖。构建失败不能先删除上一次的包。
- CI 保留生产构建检查。上游调整 Node/Vite 版本、vendor 库或构建工具时，核对支持的 Node 版本与锁文件，并验证发行入口。
- 更新资源、重新生成数据或合并上游导致 `data/` 变化后，提醒用户运行 `scripts/copy-data-to-nginx.sh`，同步到 Nginx 实际提供数据的主机目录。当前使用 `srv` 目录时，在仓库根目录执行 `sudo bash scripts/copy-data-to-nginx.sh ./data /opt/1panel/www/sites/wei.linxia.dev/index/srv`；该路径在容器内对应 `/www/sites/wei.linxia.dev/index/srv/`，须与 Nginx 的 `alias` 一致。脚本默认目标为 `index/data`，使用 `srv` 时必须显式传入目标，避免复制到错误目录。
- 复制脚本只同步 `data/`；图片、模型、音频等素材有更新时，还需同步到素材 CDN 的实际目录。提醒用户按缓存策略刷新 CDN 缓存，并确认 CDN 数据与游戏服务器为同一版本。

## Docker 发布与更新提醒

- 用本分支更新后的源码构建镜像并重建容器；仅 restart 旧容器或替换宿主机源码不等于升级，不用上游原始镜像替换本分支实现。Compose/1Panel 的实际服务名、镜像标签和构建上下文以部署配置为准，不假定仓库已有 Compose 文件。
- 保留原有环境变量、端口、网络、挂载和公告排期。发布前保留旧镜像及对应数据/素材清单/CDN 副本，优先在无对局时更新；未配置 Redis 时重建容器会丢失内存房间/对局，配置 Redis 时保留 URL、prefix、持久化卷并优雅停止，不运行 `down -v`。未经验证不承诺跨版本恢复进行中的对局。
- 检查 `/app/public/assets`、`/app/data`、字体及 `/app/config` 的挂载源；旧挂载会覆盖新镜像的文件，镜像升级不代表这些目录已更新。素材、游戏数据、本地清单和哈希表必须相互对应；公告优先挂载整个配置目录并保证容器内 `node` 用户可读取。
- `FETCH_ASSETS=1` 的素材下载失败可能只打印警告而继续构建，必须核对缺失报告和实际文件。公开下载不包含本地客户端提取的官方 3D 棋盘素材，继续提供已有 PNG 素材及匹配的 `local-assets.json`。宿主机镜像源环境变量不会自动传进 Docker 构建，按当前 Dockerfile 核对支持方式。
- 新增素材按实际缺失量补齐；使用 `tools/fetch-assets.mjs` 后核对清单变化，并运行 `node tools/asset-hashes.mjs` 更新哈希。素材和哈希等本机生成文件不纳入源码提交；不能为了通过测试而删掉新功能的清单项，也不能不经审查就提交工具重写的 `data/assets.json`。
- 干净构建的新 Docker 镜像不会自动带上旧镜像的哈希分包，`emptyOutDir: false` 也不能跨镜像保留文件。维护更新时让玩家结束对局后刷新；无停机部署须另行保留旧分包，先发布新资源再切换 HTML，版本检测不能替代这个发布顺序。
- 发布完成后检查容器健康和日志、`/healthz` 的目标版本及新 `build`、`/metrics` 的持久化/Worker/CDN 配置、`/js/asset-cdn.js` 的运行时地址，并提醒手动验证实际 HTTPS 页面、对局、声音、素材预载和 SW 更新。回滚时一起恢复匹配版本的镜像、数据和 CDN，不能只回退代码。
- 用户要求本机专用且不跟踪的升级文档时，使用 `.git/info/exclude` 精确排除该文件，不修改共享 `.gitignore`、不暂存或提交。后续合并不能依赖该文档或未跟踪同步脚本在其他机器必然存在；通用约定写入本文。

## 生产机更新（本分支三台）

- 三台线上机（`wei.xiaolubao.com` / `weishuxieyi.xiaolubao.com` / `weishu.xiaolubao.com`）用 `scripts/deploy-push.ps1`（开发机驱动）+ `scripts/deploy-remote.sh`（目标机执行）更新：默认预演，`-Apply` 才动手，`-Prewarm` 在重启前预热哈希缓存。目标机清单放不入库的 `.cache/deploy/targets.json`。`/opt/stronghold` 不是 git 检出，更新 = 文件同步 + `systemctl restart stronghold`；**不要手写 rsync 命令**。
- 2026-10-14 事故（160 两个 vCPU 被占满约 5 分钟，nginx 报 `upstream timed out (110)` / `Connection reset (104)`，连接从 1018 掉到 100 余，三台页面 JS/CSS 全 404）：临时脚本里的 `rsync --exclude 'assets/'` 不以 `/` 锚定，rsync 会匹配**任意层级**的 `assets` 目录，把 `public/build/assets` 一起排除，新 `index.html` 引用的分包在源站根本不存在。规则：排除模式一律锚定（`--exclude '/assets/'`），载荷只排 `public/assets`（900 MB 素材树保持目标机现状），**永远不加 `--delete`**（旧哈希分包是仍打开的页面还在请求的文件，删掉即白屏）。
- 内容哈希索引（`server/http/assetIndex.js`）首次启动要在 `public/assets` + `public/fonts` 上算 SHA-256。忙机重启前用 `-Prewarm` 先写 `.cache/asset-hashes.json`，否则这段开销会与数百局恢复、上千人重连叠加；此后重启只 stat 文件、读缓存，代价很小。
- 部署前必须跑一次预演：它逐条核对新 `index.html` 的每个 `/build/assets/*` 引用（目标机缺而载荷有 ⇒ 本次会补上；载荷也缺 ⇒ 先重新构建）。`--apply` 内部还有同样的完整性校验、`/healthz` 版本与 build 标识健康门、页面与分包 200 校验，失败自动回滚到 `/opt/.deploy-backup-<ts>`；配了素材 CDN 时另警告 `/data/local-assets.json` 是否仍带 `~<hash>` 段（CDN 镜像 `public/assets` 原始布局，服务端清单出站必须剥掉该段，见 `shared/cdn.js`）。

- 2026-10-14 握手与单核加固（三台已落地）：`/etc/sysctl.d/99-stronghold-syn.conf` 设 `net.ipv4.tcp_max_syn_backlog=8192`、`net.ipv4.tcp_synack_retries=2`；`server/index.js` 的 `listen` 显式传 backlog 4096（`SP_LISTEN_BACKLOG` 可覆盖，受 `net.core.somaxconn` 约束）。默认 `tcp_max_syn_backlog=256` 时，一次重连突发就让 SYN 队列每秒溢出数百次，普通客户端（含防火墙白名单来源）被卡成 SYN-RECV 半开连接，内核报 possible SYN flooding。160 另用 systemd drop-in `/etc/systemd/system/stronghold.service.d/10-workers.conf` 开 `SP_MATCH_WORKERS=1`，把 Match 实例、计时器、AI、状态视图与对局生命周期移入 lane Worker：实测事件循环利用率 1.000 → 0.373、`/metrics` 2316 ms → 2.9 ms、`ListenOverflows` +904/s → 0、`SyncookiesSent` +596/s → 0，Redis 检查点把 814 局全部重建进 lane。回退 = 删除该 drop-in 后 `systemctl daemon-reload && systemctl restart stronghold`。2 vCPU 上只开 1 条 lane，留一核给主线程；不要顺带在负载未验证的机器上启用 worker 配置。
- 同步必须带 `--checksum`：`computeBuildTag()` 用 size+mtime 计算浏览器运行时标识（`server/http/buildTag.js:49`），普通 `rsync -a` 会把 mtime 改成开发机的值，于是客户端文件内容没变，也会在下次重启后让全部在线页面判定过期并刷新（2026-10-14：18:05 手工补分包用了不带 `--checksum` 的 rsync，重启后标识由 `1e3193df6514` 变 `831c6583bc72`，而备份树与新树的构建输入逐字节逐 mtime 一致、用备份树算出的正是新标识）。构建标识是**每台机器各自**的（依赖 mtime），三台不一致属正常，不要当成版本差异。
- 判断"是否被攻击"先看这四组数：`/proc/net/tcp` 里 `st=03`（SYN-RECV）的**来源分布**、`TcpExt` 的 `SyncookiesSent` / `ListenOverflows`、`ss -lnt` 的 Recv-Q 与监听队列长度、nginx 访问日志的单 IP 占比与 UA。2026-10-14 的结论是**没有被攻击**：3000 端口只对白名单开放且兜底 DROP 仅命中 81 个包，80/443 请求速率平稳（1100–1400/min）、单 IP 峰值 2.3 req/s、UA 全为真浏览器、入向 2.5 Mbps / 2771 pps；半开连接全部来自白名单来源（其中一个只发 SYN、在访问日志里 0 条请求），根因是 accept 队列打满 + 主线程单核 100% + `tcp_max_syn_backlog=256`。同时确认 `/healthz` 占 160 全部请求的 53%，来自客户端 `public/js/ui/buildGuard.js:43` 每 60 秒一次的正常轮询，不是攻击。

- 名字/聊天屏蔽词（lexicon 模式）由每台本机的 `sensitive-lexicon.service` 提供，代码与说明在 `deploy/lexicon/`：上游钉住的 `konsheng/Sensitive-lexicon` `b05a333e…` 是 Go(Fiber)+Docker，而三台生产机没有 docker、Go、pip，所以用零依赖 Python 标准库实现同一 HTTP 契约（`GET /health`、`POST /contains`、`POST /reload`），行为对齐上游 `internal/lexicon/store.go`（递归读 `*.txt`、逐行 `TrimSpace`、跳过空行与 `#`、大小写不敏感子串匹配、命中返回最早词条）；词表仍用该提交的真实 `Vocabulary/`（87 022 行去重后 51 102 条）。服务只监听 `127.0.0.1:8080`，安装用 `sudo bash deploy/lexicon/install-lexicon.sh`（可重复执行）。注意 Python 文件必须按**原始字节**上传，用 PS 5.1 的 `Get-Content -Raw` 读 UTF-8 会按 GBK 解码，把中文注释变成非法字符导致服务起不来。
- 启用审核靠 `stronghold` 的 drop-in `20-name-moderation.conf`（`SP_NAME_MODERATION=lexicon` + `SP_NAME_MODERATION_URL=http://127.0.0.1:8080`），**必须重启游戏服务才生效**（`daemon-reload` 不会让运行中的进程读到新环境变量）；词库服务要先于游戏服务可用，否则审核 fail-open 放行。`TYPESAFE_API_KEY` 未配置，Jev 未启用。回退：删该 drop-in 后 `daemon-reload` 并重启，需要时再 `systemctl disable --now sensitive-lexicon`。验证：`curl -s http://127.0.0.1:8080/health`、对词库词条 `POST /contains` 应 `contains:true`，或用同一份 `nameModerationFromEnv()` 离线校验（普通昵称放行、词表词条与同词条聊天均 `NAME_REJECTED`），不必重启线上服务。

## 黄金结果与本分支规则差异

- 保留上游 `tools/golden.mjs`、`test/golden.test.js` 和完整场景集。运行 `npm run golden` 比对全部场景；不能只凭默认快速子集判断完整覆盖。
- 上游基线可能因本分支 Boss 血量、盟约策略等明确差异而失败。先检查变化场景和字段；必要时在独立临时副本中仅还原这些本分支规则，验证其余行为是否与对应上游版本一致，不在当前工作树临时覆盖规则或已有修改。
- 确认差异来源后才运行 `npm run golden:update`，审查并提交受影响基线，同时在 `test/golden/README.md` 记录规则差异和验证依据。不能通过更新全部基线掩盖未知回归，也不能为迎合上游基线恢复用户明确排除的行为。
- 0.1.4 合并参考：`9f0e80c` 合入上游 `9f93096`，当时独立副本仅还原本分支 Boss/盟约规则后全部 133 场景与上游一致；本分支基线变化为 7 个 roster、20 个 Boss/隐秘核心 fields、10 个 matches，bonds 不变。这是历史证据，后续版本须按当次场景和实现重新核实。
- 0.2.0 合并参考：标签 `1303321`；技能注册表逐文件用明确导入回调，HTTP/Match/PlayerState/渲染器/UI 拆分后本分支行为迁入相应子模块；Redis 检查点保留补位、自选编队及独立库存，旧检查点缺新增字段时用兼容默认。独立副本还原本分支 Boss/盟约策略后全部 283 场景与标签一致；本分支基线变化 7 roster、3 matches、2 standins。泡泡与“余音”互相反伤递归及“碎铳之簧”无来源反伤在本分支修正，保留回归测试。
- 0.2.4 合并参考：上游 `upstream/master` @ `1cf48618`（含 `v0.2.4` = `bc50cac0`）合入本分支 `700cfbdb`，12 个冲突文件逐段解决，共 189 个文件。局内聊天改用上游实现（左侧“表情 / 历史”切换、20 码点单行、最近 100 条历史、审核 fail-open），本分支并行的 `chats` / `ChatBubble` / `chatLogLines` / `activeChatBubbles` / `CHAT_MAX_LEN`=40 管线已删除，`test/ui/emotes.test.js` 的对应结构断言改由上游 `test/chat.test.js` 覆盖；`ui/emotes.js` 与 `teamPanel.js` 因本分支内容已被上游同一功能取代而整文件取上游，其余文件按块取上游侧。合并未删除任何文件，Boss 共享血量池（单人 `bloodPoint × 1`）、`inactiveBondIds` 盟约 ban、自定义快捷键默认值、PNG 棋盘与发行 ZIP 排除均保留。

## 合并后的验证

- 0.2.1 合并标签 `c2a2ef7`。独立副本只还原 Boss/盟约/AI 规则与两处反伤修复后完整 283 场景与标签一致；本次基线新增差异 7 roster、3 matches、1 fields，standins 保留此前 2 个差异，bonds 与 diy 不变。联防当前战场优先及缺失数据回退、援助者设备改造、Vite 明确导入、加载期 pending battle 与本机统计兼容回归均须保留。
- 0.2.4 合并验证（2026-10-11，工作树 `700cfbdb` + `upstream/master`）：依赖未变未跑 `npm ci`；`npm run build` 成功；i18n strict 0 error；三组指定测试 119/149/102 全通过；`npm run golden` 287 场景 match；全量 6491 用例 / 6459 通过 / 12 失败 / 20 跳过（素材/研究数据 7、本机 Node 环境 1、并发负载敏感 4；后两类合并前独立工作树同样复现，计时类单独运行即通过）。部署前仍须在目标机器复核素材与数据完整性。

- 0.2.5 合并验证（2026-10-13，分支 `merge/upstream-20261013`，收口 HEAD `2880c618`）：先按用户指示提交并推送本机改动（`bbb80205`），再依次合入 `upstream/master`（v0.2.4 之后 5 个提交，16 文件 / 30 冲突块，提交 `8eef2e0d`）与用户指定的第二个上游 `origin/master` = 标签 `v0.2.5`（221 文件，23 文件 / 54 冲突块，提交 `3bf38fb1`）。依赖未变，未运行 `npm ci`。`npm run build` 成功；`node tools/i18n.mjs check --all --strict` 0 error（en 1370/1370 = 100%）；`npm run golden` 287 个场景全部 match（`golden:update` 只移动 `matches.json` 20 个与 `roster.json`，`bonds` / `fields` / `standins` / `diy` 与上游基线逐字一致，差异来源见 `test/golden/README.md`）；三组指定测试分别 121、150 个用例全通过；全量 `node --test` 收口为 6876 用例、**6843 通过 / 10 失败 / 23 跳过**（HEAD `4b6df419`）。10 项失败逐项定位，均非合并回归：素材/研究数据 6 项（`test/assets.test.js` 的清单项、`test/backups.test.js` 的 DIY 池重算、`test/feedback7-voices.test.js` 缺 jp 语音、`character_table` 派生项；测试文件未被合并改动，属本机 `public/assets`、`.cache/gamedata` 不完整，部署前须复核）、本机 Node 环境 1 项（`test/assets-env-proxy.test.js`）、负载敏感 3 项（`test/match-worker-hotpaths.test.js`、`test/presence.test.js`、`test/sim/robustness.test.js`，单独跑 6/6、2/2、35/35 全通过）。发行打包按用户决定（2026-10-13）**采纳上游**：上游带来 `playerPackageJson`/`rewritePlayerDoc`/`PLAYER_MARKDOWN` 却漏调 `rewritePlayerStage()`，stage 的 `package.json` 因此原样带上 `golden`/`package`/`test`；补上调用、`RUNTIME_RESEARCH` 增补 `docs/research/08-skins.json`（`tools/fetch-assets.mjs`、`tools/assets/plan.mjs` 都读它）、`plan.mjs` 注释补 `08`、`test/package.test.js` 计数 `35→36`（其 fake checkout 与 `SHIPPED_TRACKED` 均由该常量派生，不能另开常量绕过），并修掉上游 `docs/DEPLOY.md` 坏链；`test/package.test.js` 13/13、`test/package-player.test.js` 4/4。仍**不**移植上游发行更新 ZIP（`--update`/`MANIFEST.json`/`tools/package-update.mjs`）。已按用户指示推送 **fork**：`fork/merge/upstream-20261013` = `4b6df419`（比 `origin/master` 多 129 提交）。另修掉 `test/scene-assets.test.js` 的 Windows 路径 bug（`new URL(...).pathname` → `/F:/…` ⇒ `path.resolve` 得 `F:\F:\…`；`597b0b49`）。
- 0.2.6 合并验证（2026-10-13，分支 `merge/upstream-20261013`，起点 HEAD `7fd7b61a`）：按用户决定「按 A 合并 + 保留本分支压缩参数 + 采纳 narrowDeflateOffer/traffic/brotli/哈希 URL」合入 `origin/master` = 标签 `v0.2.6`（`488db49f`；58 提交 / 94 文件 / +5882 −277，20 个冲突文件 / 43 块逐段解决，未用整文件 ours/theirs）。依赖未变，未运行 `npm ci`（`package.json` 只改版本号到 0.2.6）。`npm run build` 成功；`node tools/i18n.mjs check --all --strict` 0 error（四包各 1403/1403 = 100%；`官方伤害数字` 及其提示在 0.2.5 已存在，只并入新的「弹药数量」两条，避免重复键）；`npm run golden` 287 个场景全部 match（`test/golden/` 未被本次合并改动，上游 0.2.6 的改动在渲染与客户端层，模拟未变，无需 `golden:update`）；定向测试三批 144（构建/CDN/资源/哈希索引/流量/压缩）、156（大厅/Worker/持久化/公告/版本）、262（提取工具/打包/监控/预载/场景/伤害数字/盟约预选）在修掉下述两项后全通过；全量 `node --test` 收口 6987 用例、**6952 通过 / 12 失败 / 23 跳过**。12 项失败逐项定位，均非合并回归：素材/研究数据 6 项（同 0.2.5 基线，属本机 `public/assets`、`.cache/gamedata` 不完整，部署前须复核）、本机 Node 环境 1 项（`test/assets-env-proxy.test.js` 的 `restart decision…`，即基线那一项）、并发负载敏感 5 项（`test/workers.test.js` 2 项、`test/match-worker-hotpaths.test.js` 2 项、`test/sim/robustness.test.js` 的性能项；四文件单独跑 62/62 全通过）。
- PR #643（`feat: 集成全新UI界面`，`isomerpoi`，`b2bd17af`）合并验证（2026-10-15，分支 `merge/pr-643-ui`，起点 HEAD `00f52385`，基线为标签 `v0.2.6` = `488db49f`）：48 文件（40 js / 8 css，纯客户端改动）+9391 −528，10 个冲突文件逐段解决，未用整文件 ours/theirs。依赖未变，未运行 `npm ci`。`npm run build` 成功（`public/build/index.html` → `assets/index-C7kV3huq.js` / `assets/index-C9aBvcIO.css`）；`node tools/i18n.mjs check --all --strict` 0 error（四包各 1740/1740 = 100%）；`npm run golden` 287 个场景全部 match（模拟未变，无需 `golden:update`）；`node tools/check-imports.mjs` 通过。收尾按本分支约定修掉合并带来的五类回归：① `public/js/screens/room.js` 顶栏改为 `PingPill` + 在线人数 + 公告按钮，抽出 `RoomTools`（统计/设置/玩法说明三个图标方形按钮，保留 `title`/`aria-label`），并补回控制台启用（含 5 秒冷却确认弹窗、`utility: true`）与 AI 队友 ✕ 移除；`test/ui/room-mobile.test.js`、`topbar-layout.test.js`、`utility-mobile.test.js` 由红转绿，能力核对脚本确认 HEAD 版 `room.js` 的协议调用与导出函数 0 丢失。② `public/css/screens/lobby.css` 的 150 处写死 rem 字号接回 `--t`（含 `max(Nrem, Xpx)` 下限），`.ach__box` 的局部 `--t: 1rem` 改为 `--ach-text`。③ `public/css/screens/result.css` 的 `.settle__stage` 局部 `--t` 改为 `--settle-text`（67 处引用随之改写），`.tcard__chips:has(.tchip--like)` 改由 `settle.js` 显式加 `.has-social`（本仓库禁用 `:has()`）。④ `public/css/screens/draft.css` 的 `container-type` 与 23 处 `cqw` 按容器宽度 `min(100vw, 177.78vh)` 等价改写为 `min(1vw, 1.7778vh)`。⑤ `game.css`/`lobby.css` 的 14 处 `color-mix()` 补同属性普通值回退、`lobby.css` 的 `backdrop-filter` 补 `-webkit-` 双写。`test/ui` 全目录 842 用例全通过；`test/client-static.test.js` 431/431、`text-scale` 10/10、`vite` 6/6、`lobby` 83/83。全量 `node --test` 收口 7032 用例、**6996 通过 / 13 失败 / 23 跳过**（1182 s）；13 项逐项定位均非合并回归：素材/研究数据 6 项（`assets.test.js` 清单项、`backups.test.js` DIY 池重算、`feedback7-voices.test.js` 缺 jp 语音、`potential.test.js` 2 项、`full-potential.test.js`）、本机 Node 环境 1 项（`assets-env-proxy.test.js` 的 `restart decision…`）、并发负载敏感 6 项（`sim/perf.test.js`、`sim/robustness.test.js`、`state-delta-integration.test.js` 2 项、`workers.test.js` 2 项）——后两类单独运行 2/2、35/35、5/5、19/19、6/6、2/2 全通过，前一类所属测试文件本次未改动。
- 0.2.6 合并的服务端取舍与验证要点：`server/http/traffic.js`、`assetIndex.js`、`assetViews.js`、`shared/assetPaths.js` 与 `files.js` 的 brotli 全部采纳；`routes.js` 保留本分支 `/healthz` 快照缓存与 `/metrics` 详细统计，叠加 `?traffic=1`（仅本机/内网客户端）与 `assetHashes`，`index.js` 必须把 `network.opts.trustProxy` 传给 `createRequestHandler`（漏掉会让 `TRUST_PROXY=0` 的内网客户端判错，`test/traffic.test.js` 会失败）；`static.js` 先剥离 `~<hash>` 段再走本分支的 CDN 改写、`/js/asset-cdn.js`、预载清单与挂载表，两个被服务的清单改由 `serveBuffer` 下发（brotli/gzip；此前是裸传）；`websocket.js` 保留本分支 `WS_DEFLATE`（32 KB 窗口、双侧无上下文接管、`threshold 1024`）并**显式钉住** `serverMaxWindowBits: 15` —— 行为与此前不设该值时相同，但让 ws 的拒绝判据与 `narrowDeflateOffer` 真正生效（声明更小窗口的客户端退化为不压缩，而不是握手 400）；上游 `test/ws-compression.test.js` 按本分支 15 位窗口适配（`server_max_window_bits=15` 可接受、`=14` 属过窄），`test/ui/ammo-count.test.js` 对 `render/app.js` 的源码正则补上本分支的 `fpsLimit: 0`；`public/js/resources/service.js` 的预载缓存键增加「去哈希」候选，兼容预载清单 URL 与游戏实际请求的两种形状。
- 0.2.5 合并的取舍：`server/match/bot.js` 采纳上游 `SOFT_BAND_RESERVE = 0.25` 队友软预留，但不采纳其 `inactive(id)` 权重 0（AGENTS「AI 不按模式名单排除盟约」）；装备库存继续用本分支 `fromPool` + `itemPoolCopies` 口径（赠送占 0、赠送与普通各一份合成进阶占 1），上游新增的 `test/match/community-round30.test.js` 库存断言按本分支口径改写，不用其 `requirePool` / `isUnlimitedGiftItem`；`shared/protocol.js` 保留本分支消息表并补上游新消息 `m.layer`；`public/js/render/app.js` 同时保留上游 `officialDamageNumbers` 与本分支 `fpsLimit`，棋子签名保留 `info.skin`；`ui/gameLogic/settings.js` 的 `DEFAULT_SETTINGS` 补 `officialDamageNumbers: false`；`ui/shopBar.js` 采纳上游 `refreshBusy`（置灰 + `正在刷新…`）并保留 `shortcutLabel`；标题页 `utility=${true}` 挂到设置弹窗（上游原挂在已撤掉的「关于本服务器」弹窗）；`tools/package.mjs`、`tools/local-extract/extract.py`、`test/render/board3d-extract.test.js` 与 PNG 棋盘一致，继续排除 WebP 提取与发行更新 ZIP/清单校验。

依赖有变化时先运行 `npm ci`。在仓库根目录运行：

```sh
npm run build
node --test test/vite.test.js test/metrics.test.js test/build.test.js test/ui/buildGuard.test.js test/cdn.test.js test/resources/common.test.js test/resources/index.test.js test/resources/manifest.test.js test/resources/store.test.js
node --test test/lobby.test.js test/workers.test.js test/memory-lifecycle.test.js test/announcements.test.js test/persist.test.js test/persist-worker.test.js test/windows-bundle.test.js test/doctor.test.js test/version.test.js
npm run golden
node --test
git diff --check
```

- `test/vite.test.js` 实际构建并验证 HTTP 缓存、运行时 CDN、按需分包和模拟结果；`test/metrics.test.js` 验证接口字段及按需采集；资源测试验证 SW 放行构建文件。
- 不主动启用浏览器自动化；用户明确要求时再运行浏览器测试，并覆盖进入对局、素材预载和 SW 更新。构建/Node 测试通过不等同于浏览器实测、Docker 镜像验证或便携包验证。
- 2026-10-06 曾在修改前源码复现三个全量测试失败：`test/match/fuzz.test.js` 的两个用例生成缺少字段的 `g.console` 消息，以及 `test/ui/playtest3.test.js` 直接调用组件导致 Preact Hook 错误。这是历史记录；以后遇到失败需重新核实基线，不能永久忽略或默认归为已有问题。
- 全量测试出现额外失败时逐项检查：素材缺失先核对清单与磁盘并补齐；静态断言与合并后的 import/标签不同先核对实际功能；Windows 临时目录清理和短计时测试先独立复测并判断是否依赖平台或负载，再做有依据的修复，不直接跳过测试。
- 提交只纳入合并/修复范围，沿用仓库 Conventional Commit 与已有签名配置；报告实际验证结果及尚未验证的部分。

## 上游开发指导（合并优先级以本文前部为准）

# AGENTS.md

Entry point for AI coding assistants (Codex, Claude Code, Cursor, Copilot …) working on this repository. It only
indexes the existing documents and their hard rules; when this file and a linked document disagree, the document wins.
Human contributors: [CONTRIBUTING.md](CONTRIBUTING.md) is the same material in full.

## What this is

A non-commercial fan remake of Arknights「卫戍协议：盟约」 that runs in the browser: a Node.js server (economy, rounds,
rooms) and a deterministic battle sim shared by the server and the browser. It aims to be faithful to the official mode.

## Read first

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the code map: where things live, data flow, golden results,
   import boundaries, where common changes start.
2. [docs/DESIGN.md](docs/DESIGN.md) — the index of the rules: current rules in `docs/design/`, each release's
   revisions and their evidence in `docs/history/`.
3. The reference for the part you touch: [docs/SIM.md](docs/SIM.md) (battle engine API, hooks, test harness),
   [docs/META.md](docs/META.md) (match flow, shop, protocol), [docs/DATA.md](docs/DATA.md) (generated data),
   [docs/I18N.md](docs/I18N.md) (interface strings), `server/sim/content/kits/README.md` (operator kits).

## Hard rules

- **Official first.** Rules come from the official data tables (`.cache/gamedata/excel/` after setup) and
  [PRTS](https://prts.wiki/). A detail no source settles is implemented the simplest way and marked `[ASSUMED]` in the
  code and the PR. Deliberate deviations from the official mode are the maintainer's decision only.
- **Determinism.** `server/sim/` is plain ESM that runs in Node and in browsers: no Node APIs, no `Math.random`, no
  clocks, and no engine-approximated Math functions (use `server/sim/detmath.js`; ESLint and
  `test/sim/detmath.test.js` enforce it).
- **Golden results.** A refactor must not change `test/golden/*.json`. An intended gameplay change runs
  `npm run golden:update` in the same commit, and the commit / PR names every moved scenario and why
  ([test/golden/README.md](test/golden/README.md)).
- **Generated data.** Never hand-edit `data/*.json`: change `tools/build-data.mjs` and regenerate.
- **No game art in git.** `public/assets/` is ignored; never commit extracted or downloaded game files.
- **Interface strings** go through `t('…')`, with entries in every pack under `public/i18n/`
  (`node tools/i18n.mjs check --all --strict`).
- **Docs follow the code.** A rule change updates `docs/design/`, the current `docs/history/` file and the reference
  docs; run `node --test test/docs-consistency.test.js test/docs-paths.test.js`.
- **Commits and PRs**: one topic per PR; a one-line message of what changed (Chinese or English) with the issue number;
  no attribution trailers (`Co-Authored-By:`, `Generated with …`). The PR description states what, why, the sources,
  the `[ASSUMED]` points, the tests you ran (paste the summary lines) and the golden moves. No ads, payments or other
  monetisation — the project stays non-commercial.

## Verify

Run the tests of what you touched first, then everything before opening the PR:

```bash
node --test test/<area>/<file>.test.js      # targeted
npm run ci                                  # the CI checks locally (tools/ci.mjs): node --test, smoke, lint, imports, types
npm run golden                              # golden results
```

Browser suites are off by default and need Chrome: `SP_E2E=1` (UI), `SP_REAL_E2E=1` (real match, needs assets),
`RENDER_E2E=1`, `SIM_E2E=1` — see CONTRIBUTING.md §2. Battle tests are easiest with the helpers described in
docs/SIM.md (the test harness section) and the patterns in `test/content/op_siege.test.js`.

## 预载语音范围

- 资源管理直接选择中文、日语、两种语言或不预载语音，浏览器持久化 preloadVoiceLang，独立于播放 voiceLang 和干员个人语音覆盖；旧配置以已保存的播放语言迁移，默认中文。可选资源仍需同时预载开关。
- 按 /voice/cn/ 与 /voice/jp/ 目录识别（兼容 CDN 前缀），不能按 cn_019 等文件名判语言。保留旧未分语言语音组及不预载时的排除。切换中止旧范围、等待已开始操作，只增量下载最新选择，不删除已有缓存；完成与进度只计算所选可缓存资源。
- ZIP 内未选择但有效的资源仍须校验并保留，导出仍包含全部有效缓存；仅导入后的缺失下载按范围过滤。分类计数增量维护，不在每个进度更新重扫全清单。更新 common.js 等独立 SW 依赖后部署需更新 SW，并同步 CDN 的 UI 语言 JSON。验证 test/ui/preload-voice.test.js 和现有资源/ZIP/构建测试。
## 双用户名及聊天审核后端

- `server/nameModeration.js` 同时支持 Sensitive-lexicon 与 Jev：`SP_NAME_MODERATION=lexicon|jev|both|off`；仅设置 URL 自动选 lexicon，仅设置 TYPESAFE_API_KEY 自动选 jev。both 并行调用，任一明确 `NAME_REJECTED` 拦截；任一服务故障/超时/限流/非法响应静默放行，不缓存降级结果。both 缺配置必须启动失败，不可假装双审。
- Sensitive-lexicon 使用 dev Docker 的 POST `/contains` `{text}` 和布尔 `contains`，不使用 `/detect`；Jev 使用服务端 key 和官方 `/v1/systemone` 单个精简 Noul 违规概率，合并类别以尽可能降低输入至 100 tokens 以下；不截断正文或声明未经实测的计费 token 数。浏览器不接触 Jev key；名称审核只在服务端直连 WS hello 触发，并通过同一 WS 返回不可用。
- 保持服务端最终校验、同源 HTTP 安全、名字格式、缓存/并发/限流、断线竞态和 fail-open 约定。仅审核明确拒绝以固定日志标记记录，不包含昵称、聊天正文、地址、令牌、响应或 key；不记录审核触发、通过、格式错误、故障降级或审核开关状态日志。昵称拒绝提示“该名称不可用”，聊天拒绝提示“该内容不可用”，标题页无审核说明或服务不可用提示。词库后端只放受控 Docker 网络。文档 `docs/NAME_MODERATION.md`，回归 `test/name-moderation.test.js`、`test/chat-moderation-lifecycle.test.js`。
- 首次/恢复登录及在线改名收到明确 `NAME_REJECTED` 后都自动返回可编辑昵称标题页，清除 entered 标记并关闭旧对话框；保留原 token、房间及对局，不自动退出或重试被拒名称。在线改名被拒仍保留服务器已批准的昵称和会话，用户手动改名后可继续；`CHAT_REJECTED`、限流及普通对局错误不触发此回退。
