# Windows 开箱即用方案（启动器 · 便携包）

本文是 Windows 玩家的「零安装」指南，也说明了**连接服务器**与**本机当服务器**两种玩法的差别。
相关代码：`scripts/make-windows-bundle.mjs`（打包）、`scripts/launcher.mjs`（开始界面）、
`scripts/open-browser.mjs`（用默认浏览器打开页面）、`scripts/launch.mjs`（起服务器）。

## 1. 两条路，先选一条

| 玩法 | 谁在跑服务器 | 素材从哪来 | 适合 |
|---|---|---|---|
| **本机当服务器** | 这台 Windows 电脑（便携包自带 Node） | 本机 | 自己玩、或局域网里和同宿舍/同办公室的朋友玩 |
| **连接服务器** | 别人的服务器（例如 `game.example.com`） | 对方（就是打开对方网页） | 想连别人的服务器，本机什么都不用装、不用开服务 |

「连接服务器」不做任何花活：**用你的默认浏览器打开对方那个网址**，和你在浏览器里直接输网址是同一件事。
本机不需要跑服务、不需要素材，关掉启动器也不影响你那边的对局。

开始界面（启动器菜单）长这样：

```
───────────────────────────────────────────────────────────────
  卫戍协议：盟约 · Stronghold Protocol  启动器
  端口 3000 · 局域网共享 开

   [1] 本机当服务器  在这台电脑开服，浏览器自动打开，可把局域网地址发给朋友
   [2] 连接服务器    用浏览器直接打开别人的服务器（页面与素材从对方下载）
   [3] 设置          端口 / 局域网共享
   [4] 查看状态
   [0] 退出
───────────────────────────────────────────────────────────────
```

## 2. 零安装便携包

在仓库里（**任意平台**，只要有 Node 22+ 且能上网下载官方 Node 归档）执行：

```bash
node scripts/make-windows-bundle.mjs --zip        # 产物默认在 <仓库上一级>/Stronghold-Protocol-Windows(.zip)
node scripts/make-windows-bundle.mjs --out D:\Game --zip --force
node scripts/make-windows-bundle.mjs --no-node    # 目标机器已装 Node 22+ 时不必带便携 Node
node scripts/make-windows-bundle.mjs --keep-webfonts   # 保留 index.html 里的 Google Fonts 外链
```

产出的始终是 **Windows** 包（内含 win-x64 的 `node.exe`），但它**可以在 macOS / Linux 上打**：
官方归档解压出来的布局固定是 `<zip 名>/node.exe`，与打包机器是什么系统无关。

产物内容：

```
node\node.exe            官方 Windows x64 便携版 Node（版本与 sha256 钉在仓库里，只取 node.exe）
node\LICENSE-node.txt    Node 自己的许可证（MIT，与 node.exe 出自同一个官方归档）
app\                     游戏本体：代码 + 生产依赖 + public（全部素材）+ data，完全离线
app\scripts\launcher.mjs 开始界面
启动游戏.bat             双击开始（菜单）
本机当服务器.bat         等于菜单 [1]
连接服务器.bat           等于菜单 [2]
README-开箱即用.md       给玩家看的说明（含非官方 / 严禁盈利声明）
LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md
```

把整个文件夹（或 zip）拷到目标电脑 —— **什么都不用安装**，双击 `启动游戏.bat` 即可。
卸载＝删除文件夹（不写注册表、不放系统目录）。素材约 330 MB 是硬成本，包因此比较大（`--zip` 后约 300 MB 上下）。

### 包里放了什么、没放什么

`app\` 的文件清单来自 **`git ls-files`**，不是手写的跳过表。因此被 `.gitignore` 挡在版本库外的本机文件
（`.env`、`.venv*`、`.claude/`、`data/local-assets.json`、`scripts/launcher.config.json` …）**天然进不了包**——
它们里面可能有密钥或本机路径，旧实现用一张窄表整树复制，漏一项就是把它打进别人下载的压缩包。

在此之上额外放入三份不进版本库、但游戏必需的资源，以及用 `npm ci --omit=dev` **重新装好的生产依赖**：

* `public/assets`、`public/fonts`、`public/vendor`（由 `tools/setup.mjs` 下载 / 生成）；
* `node_modules` 只含生产依赖 —— `puppeteer-core` 这类 devDependency 是开发测试用的，打进发行包只会白涨体积。

Node 版本与 sha256 **钉死在 `scripts/make-windows-bundle.mjs` 的 `NODE_PIN`** 里（不再用 `latest-v22.x`）：
那样今天打包和上个月打包内容不同，出了问题也无法复现。换版本要显式给 `--node-version` + `--sha256`。

打包默认**去掉** `index.html` 里指向 `fonts.googleapis.com` 的外链：包内自带 `public/fonts`（Bender / Novecento Wide），
而这条外链在国内通常不可达，留着只是白等几个请求。中文/正文字体退回系统黑体（与没有代理时的效果一致）。
需要时可以 `--keep-webfonts` 保留。

`--zip` 用内置的 zip 写入器（`scripts/zipdir.mjs`）而不是系统 `tar` / `Compress-Archive`：
后两者在中文 Windows 上会按 GBK 写文件名且不置 UTF-8 标志位，别人下载后用 GitHub 预览、macOS 或 7-Zip 打开
会看到「启动游戏.bat」变成乱码。内置写入器一律 UTF-8 + bit 11，各平台解压都正常。

### 授权（发出去之前请确认你同意）

便携包把整个游戏原样带给别人，所以包根会带上本项目的声明文件。核心两条：

* 本项目是玩家自制的**非官方同人作品**，与上海鹰角网络科技有限公司（Hypergryph）、Yostar 及其关联方
  **没有任何关系**，未获其授权或认可；
* **仅供学习交流与个人非商业使用。严禁任何形式的盈利**（售卖、付费分发、收费服务器、广告/打赏/会员等）。

完整条款见包内 [LICENSE](../LICENSE) 与 [NOTICE.md](../NOTICE.md)；内置 Node.js（MIT）与其它第三方组件的
许可见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) 与 `node\LICENSE-node.txt`。

## 3. 启动器命令行（可跳过菜单）

```bash
node scripts/launcher.mjs                              # 菜单（开始界面）
node scripts/launcher.mjs --mode local                 # 本机当服务器
node scripts/launcher.mjs --mode local --port 3001 --no-open
node scripts/launcher.mjs --mode connect --server game.example.com
node scripts/launcher.mjs --mode status                # 本机 + 上次连接的服务器状态
node scripts/launcher.mjs --mode settings              # 端口 / 局域网共享
```

设置保存在 `app\scripts\launcher.config.json`（端口、是否局域网共享、上次连接的地址；不进版本库）。
在源码目录里直接跑也一样：`node scripts/launcher.mjs`（此时用系统安装的 Node）。

## 4. 连接服务器：地址怎么写

* `game.example.com`、`https://game.example.com`、`192.168.1.23:3000` 都可以；
  **没写协议时**：本机 / 内网 / 点对点地址用 `http`，其余域名默认 `https`（内网一般没有证书）。
* 判定为「本机 / 内网 / 点对点」的网段：`localhost`、`*.local`、`127/8`、`10/8`、`172.16/12`、`192.168/16`、
  `169.254/16`、**`100.64/10`（CGNAT，Tailscale 用的就是这一段）**、`26.x`（Radmin VPN），以及不带点的单段主机名。
  后两段看着像公网 IP，其实是私有点对点网段 —— 按 https 去连只会白等一次握手。
* 启动器会先用 `/api/client-config`（老服务器退回 `/healthz`）探一下这个地址，确认真的能连上，
  再问你要不要用浏览器打开。连不上会直接告诉你，不会开个空白页。
* 显式写了 `https://` 就以 https 为准。

## 5. 局域网联机（本机当服务器）

1. 菜单选 [1]，等控制台出现「发给朋友」的地址（形如 `http://192.168.1.23:3000`）。
2. Windows 防火墙弹窗勾选**允许专用网络**；漏点了就运行 `node tools/doctor.mjs`（或看
   [docs/DEPLOY.md](DEPLOY.md) 的防火墙小节）排查，也可以重跑安装脚本里的防火墙规则。
3. 建房后把 4 位「同盟密钥」或「复制链接」（`…/?room=密钥`）发给朋友；同一 Wi-Fi 直接可用。

清单里只会出现**真正能连的地址**：虚拟机 / WSL / Docker 网卡会被标成「虚拟网卡」，代理软件（Clash、Mihomo）
的 TUN 地址（198.18.x.x，RFC 2544 基准测试段）也不会作为「公网 IP」列出来；Tailscale / ZeroTier / Radmin VPN
之类的点对点地址会标成 VPN（只有装了同一 VPN 的人能用）。

## 6. 常见问题

| 症状 | 处理 |
|---|---|
| 双击 `.bat` 一闪而过 | 在里面手动运行 `node app\scripts\launcher.mjs`，或在命令行里跑 `启动游戏.bat` 看报错（`.bat` 会在非 0 退出时暂停） |
| 提示找不到 node | 便携包应含 `node\node.exe`；没有就用 `--no-node` 的包，并自行安装 Node 22/24 LTS |
| 端口被占用 | 启动器 [3] 换端口，或关掉占用 3000 的程序（`node tools/doctor.mjs` 会指出是谁） |
| 浏览器没自动打开 | 手动访问 `http://127.0.0.1:<端口>`；`--no-open` / `SP_NO_BROWSER=1` 会禁用自动打开；想指定浏览器就设 `SP_BROWSER`（如 `SP_BROWSER="C:\Program Files\Mozilla Firefox\firefox.exe"`） |
| 打开时弹出 Edge「现有实例正在以提升的权限运行」 | 启动器把地址交给 shell（`explorer.exe <url>`）转发给**默认浏览器**，不会再把浏览器拉成提权；但如果你之前已经用管理员身份开过 Edge，它自己还会拦一次 —— 在任务管理器里彻底结束 `msedge` 再打开，或答「是」让它以普通权限重启即可 |
| 连接服务器时连不上 | 检查地址与协议（见第 4 节）；对方服务器没在跑时启动器已经会提示 |
| 朋友连不上 | 防火墙专用网络未放行、或不在同一网段；用 `node tools/doctor.mjs` 诊断 |
| 进游戏时弹出「下载文件信息」 | 那是 IDM / 迅雷这类下载管理器在嗅探音频地址，不是游戏在下载：游戏只用 `fetch` + Web Audio 播放，音频走的是无扩展名的 `/media/…` 路由（源码 `server/index.js` 的 `serveMedia`、前端 `public/js/media.js`）。仍被拦住就在下载器里加例外（如 `http://127.0.0.1:3000/*`）或玩游戏时退出它 |
| 首次进游戏很慢 | 每位玩家要下载几十 MB 素材，之后走浏览器缓存 |

## 7. 安全与体积说明

* 便携包里的 `node.exe` 来自 nodejs.org 官方发行版，**按仓库里钉死的 sha256 校验**后才复制，未做任何修改；
  同时取出同一个归档里的 `LICENSE` 作为 `node\LICENSE-node.txt` 一起发出去。
* `app\` 里只有版本库跟踪的文件 + 生产依赖 + 素材，被 `.gitignore` 排除的本机文件（`.env`、`.claude/`、
  `data/local-assets.json` 等）不会进包。
* 启动器与游戏都不写注册表、不装服务；`启动游戏.bat` 内容只有几行（切到 UTF-8 代码页 → 找 `node\node.exe` → 跑 `app\scripts\launcher.mjs`）。
* 想做成随开机启动的 Windows 服务，用仓库自带的 `scripts/install-service-windows.ps1`（面向整合包/源码部署，见 [DEPLOY.md](DEPLOY.md)）。
