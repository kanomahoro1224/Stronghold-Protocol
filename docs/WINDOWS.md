# Windows 开箱即用方案（启动器 · 便携包 · 省流量模式）

本文是 Windows 玩家的「零安装」指南，也说明了**连接服务器**与**本机当服务器**两种玩法的差别。
相关代码：`scripts/make-windows-bundle.mjs`（打包）、`scripts/launcher.mjs`（开始界面）、
`scripts/launch.mjs`（起服务器 + 开浏览器）、`server/index.js`（`SP_PUSH_ONLY` 与 `/api/client-config`）、
`server/net.js`（安全上下文准入）、`public/js/screens/title.js`（网页开始界面的服务器选择与 http 拦截）。

## 1. 两条路，先选一条

| 玩法 | 谁在跑服务器 | 素材从哪来 | 适合 |
|---|---|---|---|
| **本机当服务器** | 这台 Windows 电脑（便携包自带 Node） | 本机 | 自己玩、或局域网里和同宿舍/同办公室的朋友玩 |
| **连接服务器** | 别人的服务器（例如 `game.example.com`） | **仍是本机**（界面与素材在本地硬盘） | 想连别人的服务器，又不想再下载几十 MB 素材 |

两种玩法都**只有游戏数据过网络**；连服务器时上行≈0 还要看对方是否开了省流量模式。

### 连接服务器到底连了什么？

选 [2] 之后浏览器打开的是**本机的页面**：

```
http://127.0.0.1:3000/?server=game.example.com
└──── 本机页面服务（只监听 127.0.0.1，局域网看不到）      └── 游戏数据发到这里
```

* 界面、脚本、全部素材（`public/assets`）从**本地硬盘**读 → 不消耗网络流量，也不用等下载；
* WebSocket（对局数据、房间、聊天）连到 `?server=` 指定的服务器（域名默认 `wss://`，本机地址用 `ws://`）；
* 所以浏览器地址栏是 `127.0.0.1` 是**正常的**——它只是页面来源，不是对局所在；
* 游戏里「复制链接」给的是**游戏服务器**的地址（`https://game.example.com/?room=密钥`），不会把你的 `127.0.0.1` 发给朋友；
* 不想启本机页面服务、直接用浏览器打开对方网页：`连接服务器.bat --no-page`（此时素材从对方服务器下载）。

开始界面（启动器菜单）长这样：

```
────────────────────────────────────────────────────────────────
  卫戍协议：盟约 · Stronghold Protocol  启动器
  端口 3000 · 局域网共享 开 · 省流量模式 关

   [1] 本机当服务器  在这台电脑开服，浏览器自动打开，可把局域网地址发给朋友
   [2] 连接服务器    页面与素材走本机，只有对局数据连别人的服务器（最省带宽）
   [3] 设置          端口 / 省流量模式 / 局域网共享
   [4] 查看状态
   [0] 退出
────────────────────────────────────────────────────────────────
```

## 2. 零安装便携包

在仓库里（任意平台，只要有 Node 22+ 和能上网下载 Node 的机器）执行：

```bash
node scripts/make-windows-bundle.mjs --zip        # 产物默认在 <仓库上一级>/Stronghold-Protocol-Windows(.zip)
node scripts/make-windows-bundle.mjs --out D:\Game --zip --force
node scripts/make-windows-bundle.mjs --no-node    # 目标机器已装 Node 22+ 时不必带便携 Node
node scripts/make-windows-bundle.mjs --keep-webfonts   # 保留 index.html 里的 Google Fonts 外链
```

产物内容：

```
node\node.exe            官方 Windows x64 便携版 Node（从 nodejs.org 下载并核对 sha256，只取 node.exe）
app\                     游戏本体：代码 + node_modules + public（全部素材）+ data，完全离线
app\scripts\launcher.mjs 开始界面
启动游戏.bat             双击开始（菜单）
本机当服务器.bat         等于菜单 [1]
连接服务器.bat           等于菜单 [2]
README-开箱即用.md       给玩家看的说明
```

把整个文件夹（或 zip）拷到目标电脑 —— **什么都不用安装**，双击 `启动游戏.bat` 即可。
卸载＝删除文件夹（不写注册表、不放系统目录）。素材约 330 MB 是硬成本，包因此比较大（`--zip` 后约 300 MB 上下）。

打包默认**去掉** `index.html` 里指向 `fonts.googleapis.com` 的外链：包内自带 `public/fonts`（Bender / Novecento Wide），
而这条外链在国内通常不可达，留着只是白等几个请求。中文/正文字体退回系统黑体（与没有代理时的效果一致）。
需要时可以 `--keep-webfonts` 保留。

`--zip` 用内置的 zip 写入器（`scripts/zipdir.mjs`）而不是系统 `tar` / `Compress-Archive`：
后两者在中文 Windows 上会按 GBK 写文件名且不置 UTF-8 标志位，别人下载后用 GitHub 预览、macOS 或 7-Zip 打开
会看到「启动游戏.bat」变成乱码。内置写入器一律 UTF-8 + bit 11，各平台解压都正常。

## 3. 启动器命令行（可跳过菜单）

```bash
node scripts/launcher.mjs                              # 菜单（开始界面）
node scripts/launcher.mjs --mode local                 # 本机当服务器
node scripts/launcher.mjs --mode local --port 3001 --no-open
node scripts/launcher.mjs --mode connect --server game.example.com
node scripts/launcher.mjs --mode connect --server game.example.com --no-page   # 直接开对方网页
node scripts/launcher.mjs --mode status                # 本机 + 上次连接的服务器状态
node scripts/launcher.mjs --mode settings              # 端口 / 省流量模式 / 局域网共享
```

设置保存在 `app\scripts\launcher.config.json`（端口、`pushOnly`、是否局域网共享、上次连接的地址；不进版本库）。
在源码目录里直接跑也一样：`node scripts/launcher.mjs`（此时用系统安装的 Node）。
底层是 `scripts/launch.mjs --game-server <host> [--push-only]`：页面仍由本机发，客户端连到 `<host>`。

## 4. 连接服务器：地址与拦截规则

* 输入 `game.example.com`、`https://game.example.com`、`192.168.1.23:3000` 都可以；
  **域名默认按 https 连**，`localhost` / `127.0.0.1` / 内网地址用 http。
* 启动器会先读这台服务器的 `/api/client-config`：
  * 对方**开了省流量模式**（`SP_PUSH_ONLY=1`）而地址又不是 https / 本机 → 启动器直接拒绝，并提示改用 https 或让管理员关掉该功能；
  * 对方是普通模式而 http 可用 → 会提醒「未加密连接」但仍然放行。
* 在**浏览器里**还有一道同样的拦：页面读到 `pushOnly` 且到这台服务器的连接不是 https/本机时，标题界面弹黄条警告并禁用
  「开始」按钮（见下文第 5 节）。本机页面连远端时，页面自己问的是**远端**的 `/api/client-config`
  （该接口允许跨域读取，见 `server/index.js` 的 `CORS_ANY`）。

## 5. 省流量模式（`SP_PUSH_ONLY`）

**它是什么。** 服务器模拟每一个战场并把快照（`b.snap`）推给客户端，客户端只发送操作意图，
不再上传战斗过程（`b.progress` / `b.result`）。省的是**玩家侧的上行**，也省客户端 CPU；
代价是**服务器的 CPU 与下行带宽**（小型主机建议先空载试一局）。服务器端开启：

```bash
SP_PUSH_ONLY=1 npm start          # Windows 便携包：启动器 [3] 里切换；或 set SP_PUSH_ONLY=1
```

`m.public.pushOnly` / `m.public.combatMode = 'server'` 会告诉网页当前是哪种模式（标题界面显示「省流量模式」徽标）。

**为什么必须 https（或本机）。** 该模式把下行流量集中到服务器上，因此**只对安全上下文开放**：

* `https://…`（反向代理要带 `X-Forwarded-Proto: https`）→ 允许；
* `http://127.0.0.1:3000`、`http://localhost:3000` → 允许（浏览器把这两个地址视为安全上下文）；
* `http://192.168.1.23:3000`、`http://game.example.com` → **拒绝**：网页弹警告、禁止开始，服务器同时以
  `403` 拒绝 WebSocket 升级，就算绕过网页也会在 `hello` 收到 `INSECURE` 错误并被断开（close 4003）。

**什么时候别开。** 打算给局域网朋友玩、又没有 https 时请关掉它（启动器 [3]），否则他们只会看到警告页。
一个人在本机玩时开着也完全没问题。

## 6. 局域网联机（本机当服务器）

1. 菜单选 [1]，等控制台出现「发给朋友」的地址（形如 `http://192.168.1.23:3000`）。
2. Windows 防火墙弹窗勾选**允许专用网络**；漏点了就运行 `node tools/doctor.mjs`（或看
   [docs/DEPLOY.md](DEPLOY.md) 的防火墙小节）排查，也可以重跑安装脚本里的防火墙规则。
3. 建房后把 4 位「同盟密钥」或「复制链接」（`…/?room=密钥`）发给朋友；同一 Wi-Fi 直接可用。

清单里只会出现**真正能连的地址**：虚拟机 / WSL / Docker 网卡会被标成「虚拟网卡」，代理软件（Clash、Mihomo）
的 TUN 地址（198.18.x.x，RFC 2544 基准测试段）也不会作为「公网 IP」列出来；Tailscale / ZeroTier / Radmin VPN
之类的点对点地址会标成 VPN（只有装了同一 VPN 的人能用）。

## 7. 常见问题

| 症状 | 处理 |
|---|---|
| 双击 `.bat` 一闪而过 | 在里面手动运行 `node app\scripts\launcher.mjs`，或在命令行里跑 `启动游戏.bat` 看报错（`.bat` 会在非 0 退出时暂停） |
| 提示找不到 node | 便携包应含 `node\node.exe`；没有就用 `--no-node` 的包，并自行安装 Node 22/24 LTS |
| 端口被占用 | 启动器 [3] 换端口，或关掉占用 3000 的程序（`node tools/doctor.mjs` 会指出是谁） |
| 浏览器没自动打开 | 手动访问 `http://127.0.0.1:<端口>`；`--no-open` / `SP_NO_BROWSER=1` 会禁用自动打开；想指定浏览器就设 `SP_BROWSER`（如 `SP_BROWSER="C:\Program Files\Mozilla Firefox\firefox.exe"`） |
| 打开时弹出 Edge「现有实例正在以提升的权限运行」 | 启动器把地址交给 shell（`explorer.exe <url>`）转发给**默认浏览器**，不会再把浏览器拉成提权；但如果你之前已经用管理员身份开过 Edge，它自己还会拦一次 —— 在任务管理器里彻底结束 `msedge` 再打开，或答「是」让它以普通权限重启即可 |
| 连接服务器时地址栏是 `127.0.0.1` | 正常：本机只发页面与素材，对局数据发到 `?server=` 那台服务器 |
| 朋友连不上 | 防火墙专用网络未放行、或不在同一网段；用 `node tools/doctor.mjs` 诊断 |
| 局域网 http 打不开游戏（弹警告） | 服务器开了省流量模式 —— 启动器 [3] 关掉，或让每个人用 https 访问 |
| 进游戏时弹出「下载文件信息」 | 那是 IDM / 迅雷这类下载管理器在嗅探音频地址，不是游戏在下载：游戏只用 `fetch` + Web Audio 播放，音频走的是无扩展名的 `/media/…` 路由（源码 `server/index.js` 的 `serveMedia`、前端 `public/js/media.js`）。仍被拦住就在下载器里加例外（如 `http://127.0.0.1:3000/*`）或玩游戏时退出它 |
| 首次进游戏很慢 | 每位玩家要下载几十 MB 素材，之后走浏览器缓存；选 [2] 连接服务器时素材从**本机**读，不存在这个问题 |

## 8. 安全与体积说明

* 便携包里的 `node.exe` 来自 nodejs.org 官方发行版（下载时校验 `SHASUMS256.txt` 的 sha256），未做任何修改。
* 启动器与游戏都不写注册表、不装服务；`启动游戏.bat` 内容只有三行（切到 UTF-8 代码页 → 找 `node\node.exe` → 跑 `app\scripts\launcher.mjs`）。
* 想做成随开机启动的 Windows 服务，用仓库自带的 `scripts/install-service-windows.ps1`（面向整合包/源码部署，见 [DEPLOY.md](DEPLOY.md)）。
