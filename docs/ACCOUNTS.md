# 账号 / 云同步 / Demo（server/accounts）

可选功能：不配置 `SP_DATABASE_URL` 时服务器行为与以前完全一致，`GET /api/config` 返回 `accounts:false`，客户端隐藏账号入口。

## 组成

| 文件 | 作用 |
| --- | --- |
| `db.js` | PostgreSQL 连接池 + 幂等建表（`accounts` / `email_codes` / `sessions` / `profiles` / `match_records` / `demos` / `player_links`）。连不上时降级为 disabled，不阻塞启动。 |
| `mail.js` | 验证码邮件。配置 `SP_SMTP_*` 时用 nodemailer 直连 SMTP；未配置时只打日志，且仅在 `SP_ACCOUNTS_DEV=1` 时把验证码回显给客户端。 |
| `turnstile.js` | Cloudflare Turnstile siteverify。未配置 secret 时使用官方 always-pass 测试密钥（site `1x00000000000000000000AA`）。 |
| `auth.js` | 6 位验证码（10 分钟、单次、5 次尝试上限、sha256(email\|code\|pepper) 存储）、内存限流（邮箱 60s 间隔 / 5 次每小时，IP 20 次每小时）、账号 upsert、30 天会话（HttpOnly `sp_sid` cookie，DB 只存 token 的 sha256）。 |
| `store.js` | 云存档（`profiles` 三列 jsonb：loadouts / settings / stats，单次 ≤256 KB）、战绩分页、Demo 文档、`player_links` 绑定 WS playerId ↔ 账号。 |
| `recorder.js` | 可选的服务端 Demo 录制（默认关闭，`SP_ACCOUNTS_SERVER_DEMO=1`）：一局内人类 `g.*` 动作 + 棋盘帧；并为已绑定账号的参与者写 `match_records`（战绩同步）。 |
| `api.js` | REST 路由（见下），POST/PUT 做同源 Origin 校验，请求体上限 64 KB。 |
| `index.js` | 工厂：读环境变量，串起 db/mail/turnstile/auth/recorder/api。 |

## 环境变量

```sh
SP_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/stronghold   # 或 DATABASE_URL
SP_SMTP_HOST=smtp.example.com
SP_SMTP_PORT=465
SP_SMTP_USER=bot@example.com
SP_SMTP_PASS=...
SP_SMTP_FROM=Stronghold <bot@example.com>
SP_TURNSTILE_SITE=0x4AAAAAAA...        # 生产 site key；缺省用测试 key
SP_TURNSTILE_SECRET=0x4AAAAAAA...      # 生产 secret；缺省用 always-pass 测试 secret
SP_ACCOUNTS_PEPPER=<随机长字符串>
SP_ACCOUNTS_DEV=1                      # 仅本地：邮件未配置时 API 回显验证码
SP_ACCOUNTS_SERVER_DEMO=1              # 可选：服务端也录 Demo（默认关，播放始终在客户端）
SP_REQUIRE_ACCOUNT=1                   # 可选：不登录/注册就不许进游戏（WS hello 校验会话 cookie）
```

这些值也可以写进仓库根目录的 `.env`（已在 `.gitignore` 里）：**进程入口**（`node server/index.js` / `npm start`）启动时由
`server/index.js` 的 `loadDotEnv()` 读它，**真实环境变量优先**（与 `node --env-file` 同义），`SP_ENV_FILE=0` 可整体关掉。
测试不走这条路（`startServer()` 自己不读 `.env`），所以本机的数据库 / 门禁开关不会影响 `npm test`。
`.env` 里放的是本机开发用的 `SP_DATABASE_URL` 与 SMTP（QQ 邮箱，端口 465 = 隐式 TLS，`SP_SMTP_PASS` 填邮箱授权码而不是登录密码）。
配好 SMTP 后 `GET /api/config` 的 `mail` 为 true，验证码是真发邮件、接口不再回显 `devCode`。

本地开发数据库（无需 root，二进制由 `embedded-postgres` 提供）：

```sh
node tools/dev-postgres.mjs            # 127.0.0.1:55432，库/用户 stronghold
# 另一个终端：
DATABASE_URL=postgresql://stronghold:stronghold@127.0.0.1:55432/stronghold \
SP_ACCOUNTS_DEV=1 npm start
```

数据目录 `.pgdata/`（gitignore 之外请勿提交）。停库：Ctrl-C 即可。

## REST

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 公开：`{ accounts, mail, dev, requireAccount, turnstileConfigured, turnstileSiteKey }` |
| POST | `/api/auth/code` | `{ email, turnstileToken, mode? }` → 发验证码（60s/5 次每小时限流）；dev 未配邮件时含 `devCode`。`mode=register` 拒绝已注册邮箱（`ACCOUNT_EXISTS`），`mode=login` 拒绝没注册的邮箱（`ACCOUNT_NOT_FOUND`） |
| POST | `/api/auth/verify` | `{ email, code, password?, name?, tag? }` → 200 + `Set-Cookie: sp_sid=...`（30 天）；错误码 `CODE_WRONG/CODE_EXPIRED/CODE_USED/CODE_LOCKED/PASSWORD_WEAK/TAG_INVALID/TAG_TAKEN` |
| POST | `/api/auth/password` | `{ email, password }` → 200 + cookie；密码错 / 无此账号一律 401 `BAD_CREDENTIALS`（10 次每小时每邮箱限流） |
| POST | `/api/auth/logout` | 删除会话，清 cookie |
| GET | `/api/auth/me` | 当前账号或 401 |
| PUT | `/api/profile` | `{ name?, tag? }` → 保存博士代号 / `#xxxx` 识别号，**只补空位**，已被占用回 409 `TAG_TAKEN` |
| GET/PUT | `/api/cloud` | 云存档（loadouts / settings / stats）；PUT 支持部分字段 |
| POST | `/api/link` | `{ playerId, playerToken }`：校验 WS 会话的重连令牌后把该 playerId 绑到当前账号 |
| GET | `/api/history?limit=&before=` | 战绩（含 `demoId`） |
| GET | `/api/cloud/demos` | 云端 Demo 列表（最多 10 条元数据） |
| POST | `/api/cloud/demos` | 上传一局本机 Demo（≤3 MB），服务端裁到最新 10 局 |
| GET | `/api/cloud/demos/:id` | 下载一局云端 Demo（本人） |
| GET | `/api/demo/:id` | Demo 文档（seed / players / events）；仅该局参与者账号可看 |

无数据库时除 `/api/config` 外全部 503 `ACCOUNTS_OFF`。账号相关接口的错误体是 `{ ok:false, status, code }`（其它接口是
`error`），客户端 `public/js/ui/cloud.js` 的 `api()` 把 `code` 归一化成 `error` 再判断。

## 密码与 `#识别号`（2026-11-15 用户要求）

- **密码**：注册时可选（≥ 6 位，`scrypt` N=16384/r=8/p=1 + 每条独立盐，存 `scrypt$N$r$p$salt$hash`）；设过就能在登录页用
  邮箱 + 密码直接进，没设的老账号仍走验证码。密码错与「账号不存在」都只回 `BAD_CREDENTIALS`，不给枚举。
  `verify` 里 `password_hash = COALESCE(accounts.password_hash, EXCLUDED.password_hash)`，登录时补设也不会覆盖已有密码。
- **识别号**：标题页博士代号右边的小输入框（`public/js/screens/title.js`，类名 `title-idtag`），4 位数字，
  `#0427` 样式，存在 `accounts.tag`，全局唯一（`accounts_tag_unique` 部分索引，`WHERE tag IS NOT NULL`）。注册 / 登录时
  一起提交，登录后 `GET /api/auth/me` 带回自动填入；已有值时输入框置灰不可改（跟着账号走）。老账号允许先空着，
  之后在标题页填一次就锁上。
- **同时也是本机账号的编号**：大厅右上角名片上的 `名字#1234`（`public/js/ui/accounts.js` 的 `sp.pref.localAccount`）
  就是同一个号——不登录时输入框先写本机账号（`setLocalAccountTag`），界面上的 `#xxxx` 立刻变；登录后云端编号同步
  写进本机账号（`applyAccount`），换设备登录会自动带回。输入框预填 4 位数字时 `maxlength` 会挡住新输入，所以
  聚焦即全选，直接打字就是覆盖（用户 2026-11-15：「输入 1224 但没变成 1224」）。
- **验证码不被浪费**：识别号在各处都是「先查占用再消费验证码」，撞号时玩家换个号用同一个验证码重提即可，不必等 60 秒。


## 登录门禁（`SP_REQUIRE_ACCOUNT=1`）

默认关闭：账号只是可选功能，不登录也能玩。打开后**不登录/注册就无法进入游戏**。

- **服务端（强制）**：`server/index.js` 在账号服务可用且开关打开时给 `Network` 装 `accountGate`；`server/net.js` 的 `gateHello` 在每次新连接的第一次 `hello` 上用**升级请求里的 HttpOnly `sp_sid` cookie**校验会话，未登录回 `LOGIN_REQUIRED`（`shared/constants.js`），客户端停在标题页。页面无法自称已登录。已经通过校验的连接保留 `conn.account`，改名 / AI 代打重放的 hello 不再查库。
- **数据库不可用时放行**：查询抛错按「账号服务降级」处理，不把整台服务器锁死（日志 `[accounts] login gate could not reach the database`）；没有数据库时 `requireAccount` 恒为 false。
- **客户端（提示）**：标题页代号输入框右侧是「登录 / 注册」（已登录显示邮箱前缀）。`GET /api/config` 的 `requireAccount` 为真时，点「开始」先弹登录框，登录成功直接进入；服务端仍会兜底拒绝没带会话的连接。入口与弹窗都在 `public/js/ui/cloud.js`，标题页只负责显示与调用。
- 行为测试：`node --test test/accounts.test.js`（无数据库分支）与 `test/net-*.test.js`；手工验证可用 `ws` 直连 `/ws` 发 `hello`，未带 cookie 应回 `LOGIN_REQUIRED`。

## Demo（本机录制 / 本机播放）

Demo **不存服务器**（用户 2026-11-15 决定：播放不能在服务端重跑，性能会爆炸）。全部在玩家浏览器完成：

- `public/js/demoRecorder.js`：对局中记录自己的每个 `g.*` 操作（`net.send` 包装）、`m.public` 棋盘帧，以及整条 S2C 消息流 `wire`（`net._emit` 包装，最多 20000 帧 / 4 MB）；局末写入 IndexedDB；登录后后台再上传一份到云端。
- **收尾规则**（用户 2026-11-15「不管是模拟中断，还是中途退出啥的，通通记录」）：`m.result` 结算 → 存；放弃模拟 / 房间散去 → 存；掉线（`net` status 变 `reconnecting` / `closed`）与页面隐藏 / `pagehide` → **先落盘再继续录**（同一 `id`，玩家回得来就用完整版覆盖，回不来也不会丢这一局）；另一标签页顶掉会话 → 存。唯一的例外是**没清完第一个回合就退出**的对局：不写 Demo（已落盘的副本会删掉），与统计的 `countsTowardStats` 同一条规则（`clearedRounds`）。
- `public/js/demoStore.js`：IndexedDB `sp-demos` 库，按 `id` 存 `{ startedAt, endedAt, end, rounds, mode, difficulty, players, events, snapshots }`；**本机不限局数**（用户 2026-11-15）。另有一份 `sp.pref.demoIndex` 摘要（id / 开始时间 / 模式 / 步数 / 结局），供统计数据页判断哪一行有 Demo，不必把整份文档读出来。
- `public/js/demoReplay.js`：游戏内可视化回放（类 CS Demo），控制条含 `时间 / 总时长`、±15 秒、上/下一回合、`回合: N`、¼×–8× 倍速；进度条上一个白点代表一个回合的开始。录制文档里的 `wire`（原始 S2C 帧 `m.*` / `b.*`，含 `b.start` 战斗 spec）按录制时间原样喂回 `net._emit`，由现有 Game 画面、战斗 runner 自行渲染；回放期间把 store 切到合成的 `DEMO` 房间，退出时还原。**播放全程在客户端，服务器不参与运算。**
- `public/js/ui/cloud.js`：历史面板列出本机 Demo（播放 / 删除）与云端 Demo（最新 10 局，下载到本机后播放），播放器按动作时间轴推进并用最近的棋盘帧还原局面（回合、阶段、每人 LP / 商店等级 / 场上数 / 状态）。播放纯客户端渲染，不请求服务器运算。
- **从战绩点开**：统计数据页「对局记录」每行有一个 `播放` 按钮（`Demo` 列）；统计记录带上录制时的 `demoId`（`ui/stats.js` 的 `buildRecord` / `buildQuitRecord` ← `demoRecorder.currentDemoId()`），老记录没有链接时按「结束时间 − 时长」与模式在目录里就近匹配（`demoIdFor`）。同一页顶栏的 `Demo 库` 直接打开上面的历史面板。

云同步范围：**战绩**（`match_records`）+ **最新 10 局 Demo**（`account_demos`）。`server/accounts/recorder.js` 默认不启用，只有 `SP_ACCOUNTS_SERVER_DEMO=1` 时才额外录服务端 Demo（排查用，不是播放路径）。

## 测试

```sh
DATABASE_URL=postgresql://stronghold:stronghold@127.0.0.1:55432/stronghold \
  node --test test/accounts.test.js
```

不设 `DATABASE_URL` / `SP_TEST_DATABASE_URL` 时整个文件跳过，保证无数据库的机器上全量测试照常通过。

## 已知边界

- Demo 本机不限局数；有 `wire` 的文档走游戏内可视化回放，旧文档退回文字时间轴。播放为客户端帧回放（不做服务端重跑、也不做客户端重模拟）。云端只备份最新 10 局，换设备可下载后播放；更早的 Demo 仅存在于原设备。
- 邮箱验证码限流在进程内存，多实例部署需换成共享存储。
- `player_links` 是一次绑定；同一浏览器换玩家（新 playerId）需重新 `/api/link`。
