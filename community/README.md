# 卫戍协议 · 社区站点（community）

《卫戍协议》的**社区聚合站**：公开服务器列表、区域筛选、下载栏目（暂隐藏）、后台管理控制台。
独立于游戏本体运行，通过探测各游戏节点的 `/healthz` 接口获取实时状态。

> 视觉与游戏前端 **1:1 对齐**：直接沿用 `public/css/theme.css` 的设计令牌（暗色薄荷绿、括号角、扫描线纹理），
> 字体族、动效曲线、圆角/层级规范全部一致。

---

## 快速开始

```bash
cd community
npm start           # 默认 http://localhost:3100
# 或指定端口 / 管理员初始密码
PORT=3200 SP_COMMUNITY_ADMIN_PASSWORD=你的密码 npm start
```

首次启动会写入示例服务器数据，并创建初始管理员 `admin`：

- 未设置 `SP_COMMUNITY_ADMIN_PASSWORD` 时，会生成随机密码并**在控制台打印一次**（请立即登录后台修改）。
- 已设置时使用该密码。

> **当前部署的管理员**：登录名 `admin@luke.qaq`。密码未写入任何文件，如需重置请用
> `node tools/set-admin.mjs <登录名> <新密码>`（会一并清掉该账号的既有会话）。

访问：

| 地址 | 说明 |
| --- | --- |
| `/` | 前台 · 服务器列表（游客可浏览全部公开内容） |
| `/admin` | 后台 · 管理员登录 / 服务器管理控制台 |
| `/admin/accounts` | 后台 · 账号管理（仅管理员） |
| `/healthz` | 本站自身状态（服务器数 / 账号数 / 运行时长） |

---

## 需求对照

| 需求 | 实现 |
| --- | --- |
| 顶部 Tab：服务器 / 下载 / 关于 | `.nav .tabs`；**下载栏目按需求暂时隐藏**（`server-list.js` 的 `TABS.hidden`） |
| 服务器列表实时拉取 `/healthz` | `server/probe.js` 并发探测 + 10s 缓存（`ttl`）；8s 超时、传输失败重试一次、**仅探测**放宽 TLS 校验（各节点证书常年与主机名不匹配），前端每 15s 刷新 |
| 延迟判断（本机 vs 服务端） | `public/js/latency.js`：本机 ping 失败**先看服务端结果**（`statusFor()`），服务端不可达但本机连通则显示「本机可达」，两边都没数据才判离线 —— 详见仓库 `docs/OPS-NOTES.md` §15 |
| 服务器「实际探测地址」 | 后台编辑服务器可选填：公开地址给玩家（进入按钮 + 浏览器测速），服务端 `/healthz` 探测走探测地址，留空＝用公开地址。老库自动迁移加列，该字段只对管理员返回 |
| **完整展示原始 JSON** | 每张卡片可展开 `HEALTHZ · 原始数据（全量）`，逐字段语法高亮渲染 |
| 后台可新增服务器（名称/地址/区域） | 控制台「添加服务器」，地址自动规范化，重复校验 |
| 区域＝全球地理大区 | `db.js` 的 `REGIONS`：亚洲/欧洲/北美/南美/大洋洲/非洲 |
| 关闭自助注册，账号仅管理员创建 | 无注册接口；账号管理页「新建账号」是唯一入口 |
| 账号系统（登录态） | scrypt 密码哈希 + HttpOnly 会话 Cookie（存 token 的 SHA-256） |
| 后台管理控制台 | 服务器 CRUD / 账号 CRUD / 密码重置 / 停用启用 |
| 技术栈 Node.js + SQLite | `node:sqlite`（Node ≥ 22.5 内置，无需原生依赖） |

---

## 目录结构

```
community/
├─ server/
│  ├─ index.js    进程入口：HTTP 服务、静态文件、SPA 回退、启动横幅
│  ├─ db.js       SQLite 表结构、密码哈希（scrypt）、区域定义、行→API 映射
│  ├─ auth.js     会话签发/校验、登录、管理员守卫、密码策略
│  ├─ probe.js    游戏节点 /healthz 探测（缓存、超时、响应体上限）
│  ├─ api.js      /api/* JSON 接口 + 参数校验 + 权限控制
│  ├─ http.js     安全响应头、JSON/Cookie 工具、静态文件服务
│  └─ seed.js     首次启动的示例数据与初始管理员
├─ public/
│  ├─ index.html  SPA 外壳（普通脚本兜底 + module，见下）
│  ├─ css/theme.css   设计令牌（移植自游戏前端）
│  ├─ css/app.css     布局与组件
│  └─ js/
│     ├─ boot-guard.js 普通脚本兜底：模块图整体失败时在页面上给出可读提示（不许再出现深色空页）
│     ├─ main.js       路由（/、/admin、/admin/accounts）
│     ├─ api.js        接口客户端（ApiError）
│     ├─ ui.js         图标、弹窗、Toast、JSON 高亮、品牌标
│     └─ views/        server-list / admin-login / admin-shell / admin-servers / admin-accounts
├─ tools/shoot.mjs  开发期截图校验（需本机 Chrome，仅本地使用）
└─ data/            SQLite 数据库（运行时生成，已 gitignore）
```

---

## 为什么是独立服务？

游戏本体（`server/`）是一个**仅允许 GET/HEAD 的静态 + WebSocket 服务**，请求监听器是单一的
`createRequestHandler`，架构在 `docs/DESIGN.md` 中有严格约定。社区站需要 POST/PUT/DELETE、
SQLite 持久化与管理后台，因此作为**独立进程**运行在另一个端口，仅把游戏节点当作数据源（读取其 `/healthz`），
不改动游戏代码。

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3100` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `SP_COMMUNITY_ADMIN_PASSWORD` | 随机 | 首次启动创建 `admin` 时使用的密码 |
| `SP_COMMUNITY_DB` | `data/community.db` | SQLite 文件路径 |
| `SP_COMMUNITY_PROBE_TTL_MS` | `10000` | `/healthz` 探测缓存时长 |
| `SP_COMMUNITY_PROBE_TIMEOUT_MS` | `4000` | 单次探测超时 |
| `SP_COMMUNITY_SESSION_TTL_MS` | `604800000` | 会话有效期（7 天） |
| `SP_COMMUNITY_INSECURE_COOKIE` | — | 设为 `1` 时强制允许非 Secure Cookie（本地 HTTP 调试） |

---

## 安全说明

- 密码使用 **scrypt** 加盐哈希；会话只存 token 的 SHA-256，Cookie 为 `HttpOnly` + `SameSite=Lax`。
- 完整 CSP（`script-src 'self'`，无 `unsafe-inline`）。
- 所有管理接口经 `requireAdmin` 守卫；系统保证**至少保留一个启用中的管理员**，且不能停用/删除自己。
- 静态文件服务拒绝路径穿越；非 GET/HEAD 的静态请求返回 405。
- **探测节点的 TLS 校验被显式放宽**（社区节点常见自签证书 / 走隧道），仅作用于 `probe.js` 的出站探测。

> ⚠️ **模块名一律写真实路径**（`/vendor/preact.module.js` 等），**不要**再用 import map —— 它需要
> Safari/iOS **16.4+**，旧 iPhone 上会被静默忽略，裸模块名解析失败 ⇒ 整个 `main.js` 不执行 ⇒ 只剩一片
> 深色空页（2026-10 真实事故）。同理 `vendor/hooks.module.js` 内部那行 `from"preact"` 已改成
> `from"./preact.module.js"`，**升级这个 vendor 文件后要重新改**。
> `tools/check-module-specifiers.mjs`（纯 Node）与 `tools/verify-no-importmap.mjs`（浏览器，含「模块挂掉必须
> 有可读提示」一幕）守住这条规则。
>
> 备注：`server/http.js` 的 CSP 里还留着一个历史 SHA-256 哈希，它已不对应任何脚本（内联脚本全部移除），
> 留着无害；删掉它需要重启服务，故等到下次重启顺手清理。
