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
```

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
| GET | `/api/config` | 公开：`{ accounts, mail, dev, turnstileSiteKey }` |
| POST | `/api/auth/code` | `{ email, turnstileToken }` → 发验证码（60s/5 次每小时限流）；dev 未配邮件时含 `devCode` |
| POST | `/api/auth/verify` | `{ email, code }` → 200 + `Set-Cookie: sp_sid=...`（30 天）；错误码 `CODE_WRONG/CODE_EXPIRED/CODE_USED/CODE_LOCKED` |
| POST | `/api/auth/logout` | 删除会话，清 cookie |
| GET | `/api/auth/me` | 当前账号或 401 |
| GET/PUT | `/api/cloud` | 云存档（loadouts / settings / stats）；PUT 支持部分字段 |
| POST | `/api/link` | `{ playerId, playerToken }`：校验 WS 会话的重连令牌后把该 playerId 绑到当前账号 |
| GET | `/api/history?limit=&before=` | 战绩（含 `demoId`） |
| GET | `/api/cloud/demos` | 云端 Demo 列表（最多 10 条元数据） |
| POST | `/api/cloud/demos` | 上传一局本机 Demo（≤3 MB），服务端裁到最新 10 局 |
| GET | `/api/cloud/demos/:id` | 下载一局云端 Demo（本人） |
| GET | `/api/demo/:id` | Demo 文档（seed / players / events）；仅该局参与者账号可看 |

无数据库时除 `/api/config` 外全部 503 `ACCOUNTS_OFF`。

## Demo（本机录制 / 本机播放）

Demo **不存服务器**（用户 2026-11-15 决定：播放不能在服务端重跑，性能会爆炸）。全部在玩家浏览器完成：

- `public/js/demoRecorder.js`：对局中记录自己的每个 `g.*` 操作（`net.send` 包装）与收到的 `m.public` 棋盘帧，局末写入 IndexedDB（每局 400 帧 / 20000 动作）；登录后在后台再上传一份到云端。
- `public/js/demoStore.js`：IndexedDB `sp-demos` 库，按 `id` 存 `{ startedAt, mode, difficulty, players, events, snapshots }`；**本机不限局数**（用户 2026-11-15）。
- `public/js/ui/cloud.js`：历史面板列出本机 Demo（播放 / 删除）与云端 Demo（最新 10 局，下载到本机后播放），播放器按动作时间轴推进并用最近的棋盘帧还原局面（回合、阶段、每人 LP / 商店等级 / 场上数 / 状态）。播放纯客户端渲染，不请求服务器运算。

云同步范围：**战绩**（`match_records`）+ **最新 10 局 Demo**（`account_demos`）。`server/accounts/recorder.js` 默认不启用，只有 `SP_ACCOUNTS_SERVER_DEMO=1` 时才额外录服务端 Demo（排查用，不是播放路径）。

## 测试

```sh
DATABASE_URL=postgresql://stronghold:stronghold@127.0.0.1:55432/stronghold \
  node --test test/accounts.test.js
```

不设 `DATABASE_URL` / `SP_TEST_DATABASE_URL` 时整个文件跳过，保证无数据库的机器上全量测试照常通过。

## 已知边界

- Demo 本机不限局数，播放为客户端按录制帧还原（不做服务端重跑）。云端只备份最新 10 局，换设备可下载后播放；更早的 Demo 仅存在于原设备。
- 邮箱验证码限流在进程内存，多实例部署需换成共享存储。
- `player_links` 是一次绑定；同一浏览器换玩家（新 playerId）需重新 `/api/link`。
