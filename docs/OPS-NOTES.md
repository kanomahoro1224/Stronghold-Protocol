# 双服运维须知与踩坑记录（0.2.1 合并线）

> 面向：接手这个 fork 生产环境的人 / AI。内容全部来自 2026-10-07 ~ 10-08 的实操（同步上游 v0.2.1、并入上游 PR #321 / #323、发维护 tips、挂 12:00 定时部署）。
> 主仓库 `sganggs/Stronghold-Protocol`，本 fork `kanomahoro1224/Stronghold-Protocol`；本线分支 `feat/merge-v0.2.0-resume`，部署提交 **`c631cdbd0b35891172cb104626fdde208eb1f0e7`**。

---

## 0. 双服拓扑（"双服"指哪两台）

> **双服 = `.214`（主站 game.xiaolubao.com）+ t44（分线 game.kafuno.cn）**。`45.207.220.22` 是**第三台**（同名 vhost、0.1.3），不在"双服"里，见表格最后一行。

| | **.214（主站）** | **t44（分线）** | .22（第三台，备用/非双服） |
|---|---|---|---|
| 访问 | `45.207.220.214`（直连 22） | `t44.sjcmc.cn:34005`（SSH）、`:34046`（HTTP/HTTPS），**NAT 机** | `45.207.220.22` |
| hostname | `MNY910268931402` | `ECS8709` | `MNY815122892528` |
| 域名 | `game.xiaolubao.com` | `game.kafuno.cn`、`t44.sjcmc.cn`、`_` | `game.xiaolubao.com` |
| 版本（部署前） | 0.1.3 | **0.1.4** | 0.1.3 |
| 应用端口 | `127.0.0.1:3000` | `127.0.0.1:3000`（nginx 只监听 127.0.0.1:8080/8443，外面套 nginx stream `$ssl_preread_protocol` 分流：非 TLS→8080、TLS→8443；CF Flexible 回源明文、Full 回源 TLS） | `127.0.0.1:3000` |
| 部署脚本 | `deploy-214.sh` | `deploy-t44.sh` + `README-t44.txt` | `deploy_code.sh` |
| **客户端代码从哪出** | `sp-code-version.conf` 的 `default ""` → **本机 node 出码** | **没有** `sp-code-version.conf` → 本机出码 | `default "https://local.xiaolubao.com/Stronghold-Protocol/rel/0.1.3-e19d2e8b11"` → **302 到 R2** |
| systemd 服务 | `stronghold.service`（`serve-tuned.mjs` 包装，钉 maxRooms / soloReconnectWindowMs） | 同左 | 同左 |
| 系统时区 | **UTC** | **UTC** | **UTC** |
| 是否 git 仓库 | 否（解包部署） | 否 | 否 |

- `/assets/**`、`/media/**`、`/fonts/**` 在 `.214` 由 nginx **302 到 R2** `https://local.xiaolubao.com/Stronghold-Protocol`（conf 52/58/67 行，带 `?r2v=2`）→ **图音不在机器上，在 R2**，改素材要动 R2 而不是机器。
- SSH：`F:\WeChat\.tools\sshx.py`（密码在 `F:\WeChat\.env` 的 `pw`），用法 `run root <本地脚本>` / `exec root "<一行命令>"` / `put root <本地> <远端>`；t44 需要 `SSH_PORT=34005`。**`.22` 从 2026-10-08 02:41 UTC 起 SSH 失联**（见 §6）。

---

## 1. 维护 tips ≠ 公告（最容易搞错的一处）

| | 维护 tips（本次要发的） | 公告 |
|---|---|---|
| 文件 | **`public/runtime/status.json`** | `data/notice.json` |
| 线上 URL | `/runtime/status.json` | `/data/notice.json` |
| schema | `{id, tone, text, detail?, link?{label,href}, minOnline?}` | `{title, sections:[{label, lines:[…]}], updatedAt}` |
| 谁读 | `public/js/ui/statusBanner.js`（`STATUS_SOURCE`） | `public/js/ui/notice.js` |
| 缓存 | `Cache-Control: no-cache` + ETag，客户端 `cache:'no-store'`，**每次加载读一次** | 同 |

- `tone` 三值：`emergency` / `maintenance` / `info`（未知按 info）。`text` 必填，空则不显示。**没有时间字段**——时间就是写进 `text` 的纯文本（`12:00 更新 0.2.1，对局可能中断，请做好规划`）。
- **没有管理接口**：直接往服务器写这个文件即可，**不用重启、不用重新部署**（`docs/DEPLOY.md:321`）。撤回 = 删掉该文件。
- 该文件 **未被 git 跟踪** ⇒ 任何打包/更新包都不会碰它，**部署不会冲掉 tips**（`public/runtime/status.json` 在 MANIFEST/removed 之外）。
- 发的时候注意：`tone: "maintenance"` 在客户端显示「维护」徽标（i18n msgid）。

---

## 2. 部署：两种既有做法 + 本次的定时脚本

### 2.1 既有做法
- **`.22`**：`/opt/stronghold-deploy/deploy_code.sh` → 备份 → 解包 `/tmp/sp-code.tar.gz` → `chown` → **生产依赖齐全检查**（缺一个就 exit 3）→ `node --check` 入口 → 重启 → **紧接着 `python3 r2_code_mirror.py --publish`**（注释里写明顺序不能反：以前把 presence 冒烟放前面，`set -e` 一挂就导致 nginx 还停在旧代码前缀 = 玩家拿到旧客户端）→ 最后冒烟（非致命）。
- **`.214`**：`deploy-214.sh` 同构，但**不需要 R2 代码发布**（本地出码）。
- 官方定时方式（`docs/DEPLOY.md:326-333`）：**一次性** `systemd-run --on-calendar='…' --unit=sp-deploy-1159 /opt/stronghold-deploy/deploy-214.sh`。
  ⚠️ `systemd-run` 出来的是**瞬时单元**（活在 `/run`），**机器一重启就没了**；机器时区是 **UTC**，所以"北京 12:00"要写成 `04:00:00`。要保险就再补一条 **cron 兜底**——本次两台都加了
  `15 4 8 10 * /bin/bash /opt/stronghold-deploy/deploy-v021.sh >> …/logs/cron-v021.log 2>&1`（= 北京 12:15）。脚本带幂等标记（同一 sha 已部署过即退出），成功跑完还会自摘这条 cron，所以**重复触发无害**。

### 2.2 本次用的：`/opt/stronghold-deploy/deploy-v021.sh`
钉死 `SHA=c631cdb…`，流程：预检（下载 codeload tar.gz → 解包 → `node --check` → 断言 `APP_VERSION=0.2.1` → 依赖检查）→ 备份（排除 node_modules/assets/fonts/vendor/media/.cache/state，另存 `data/config.json`、`data/notice.json`）→ 解包 → 还原被保留文件 → `npm i --omit=dev` → 依赖复检 → 重启 → 健康检查（`/healthz`、vhost `/`、`/js/main.js`）→（仅走 R2 出码的机器）R2 发布；**任何一步失败自动回滚**并重启回旧代码。带幂等标记 `/opt/stronghold-deploy/.deployed-<sha>`。

```bash
bash /opt/stronghold-deploy/deploy-v021.sh --preflight      # 只验不碰线上
bash /opt/stronghold-deploy/deploy-v021.sh                  # 正式（幂等）
bash /opt/stronghold-deploy/deploy-v021.sh --rollback-last  # 回滚到最近一次备份
tail -f /opt/stronghold-deploy/logs/deploy-v021-*.log       # 日志
```

---

## 3. 本次踩到的坑（按"再踩一次会出事"排序）

1. **`npm ci` 会先删 node_modules**。若 12:00 网络抖动失败，回滚后是「旧代码 + 半个依赖树」→ 起不来。**改成就地 `npm i --omit=dev`**（失败也保留原依赖）。这是我自己脚本里的隐患，部署前改掉了。
2. **上游 v0.2.1 多了一个生产依赖 `@zip.js/zip.js`（`^2.23.0`）**，`package.json` 还写了 `engines: node>=22`（两机是 v22.23.3 ✓）。**先补依赖再重启**，否则 `node --check` 看不出来、一启动就炸。用**新** `package.json` 装，别用线上的旧 `package.json`（我第一版就错在这：`npm i` 说 "up to date" 但依赖还是缺）。已提前 `npm i --no-save @zip.js/zip.js@2.23.0` 装好。
3. **`data/config.json` 不是密钥，是游戏平衡配置**（season/modes/economy/timers/broadcasts/trophies…），R2 上公开 200 **属设计如此**（客户端要读）。**但 `data/config.json`、`data/notice.json` 都被 git 跟踪** ⇒ 解包会覆盖 → 脚本里必须备份+还原。**绝不要把它的内容贴进聊天**（线上那份是运营手改的）。
4. **`r2_code_mirror.py` 里 R2 的 AK/SK 是明文**（root-only 文件）。读它的时候别 `head` 全量（我就把密钥打进了会话）→ 建议轮换一次。
5. **代码镜像会把 `ROOT/data/**` 整个传到公开 R2**（`rel/<ver>/data/…` 实测 `config.json`/`notice.json`/`assets.json`/`chess.json` 都 200）。
6. **`.22` 部署必须连客户端代码一起发**：它只改服务端、不 `--publish` → 新服务端 + 旧客户端（且上游已去掉 `presence` 帧）→ 会不一致。脚本里按 `default ""` 判断是否需要发布。
7. **本机在代理后面**：`game.kafuno.cn` 解析成 `198.18.0.188`（fake-ip），换公共 DNS 也一样 → 域名解析/连通性必须在**机器上**验证。
8. **PS 5.1 的语法地雷**：不支持 `??`；`node -e "…"` 带引号必炸 → **一律写成脚本文件**再执行。中文输出在控制台是 GBK 乱码，但命令本身是好的。
9. **`sshx.py` 的坑**：`exec` 里 `pushd` / `$(...)` / `tr` 容易炸 → **传 `.sh` 再 `run`**；大文件 SFTP 会中途断（16.9 MB 的 tar 断过）→ 别传大文件，让机器自己 `curl`；断线后可能被 fail2ban 拦 ~3 分钟，表现为 `SSHException: Error reading SSH protocol banner` → **等一会儿重试**，不要连着重试（本次 `.22` 就断了一次，重传即可）。
10. **`.22` 的 `/assets/**` 出自 R2，所以"机器上有文件"不等于"客户端拿得到"**。查素材覆盖必须走**真实域名**（`curl --resolve game.xiaolubao.com:443:127.0.0.1`）或直接问 R2，不要用 `public/assets` 里有没有来判断。

---

## 4. 合并上游 / 并入 PR 的坑

1. **DESIGN.md 的 §编号是全局唯一的，且永不复用**。上游把 §26 给了「0.2.1 历史」⇒ 本 fork 原来的 §26 同盟匹配 / §27 在线人数要**顺延为 §27 / §28**，并有 **46 处引用散在 24 个文件**（`server/lobby.js`、`public/js/store.js`、各 test 等）。`docs/history/**` 里指 0.2.1 的 §26 是上游的，**不能动**。改完跑 `node --test test/docs-paths.test.js test/docs-consistency.test.js`（改 `docs/design/matchmaking.md` 时还得加标题块，否则 `designText()` 报 "§26 appears twice"）。
2. **`data/assets.json` 是单行紧凑大 JSON**，且 `stats`/`hash` 与正文**有断言绑定**：`stats.voiceAltChars[lang]` 必须等于 `Object.keys(audio.voiceAlt[lang])` 的长度（`test/docs-consistency.test.js:945-956`），`hash` 是正文的 `contentHash`。改完必须重算，否则测试挂。
3. **上游的 manifest 是超集，但素材不在**：本 fork 的 `public/assets` 是**部分下载**、R2 也只是那批 ⇒ 上游 manifest 引用的 **~399 个音效**（如 `a_bat_*`、`b_char_*`）在本 fork 的素材库里**根本不存在**（`/assets/...` 与 `/media/...` 都 404）。客户端对音频 404 是容忍的（静音），所以不致命；要补得从**上游 GitHub Release 的完整包**取素材再传 R2。
4. **JP 语音在 R2 上是好的**：manifest 路径 `/assets/audio/voice/jp/<char>/cn_019.mp3` 实测 **200**（走 prefixed 形态）；别用 `/media/` 去试（那只对 BGM 有意义，会 404 误导你）。
5. **i18n 是"四包 complete"制**：`public/i18n/{en,ja,ko,zh-TW}.json` 都声明 `"complete": true`，源码里 `t('中文')` 的中文就是 msgid（**没有 zh-CN.json**）。上游 PR 只改 `en.json` ⇒ 它用到的 msgid 在 ja/ko/zh-TW 缺失，而 **`node --test` 抓不到**（`test/i18n.test.js` 用临时 root）⇒ 必须手跑
   `node tools/i18n.mjs check --all --strict`（四包各 1234/1234、0 缺失才算过）。本次给 #323 补了 41 条 × 3 包（未使用的 22 条不补，只会在 `--stale` 里出现）。
6. **`en.json` 冲突的正确解法是"严格并集"**：两边都在文件尾追加（锚点同一行「开发版 · 不稳定…」）⇒ 那一行只留一份并补逗号，然后 fork 块 + PR 块都保留（本次 1044+166+63=1273 键，逐键核对）。
7. **冲突基本都是"双方各自新增"**，解法是并存（`main.js` 两个宿主、`title/lobby/room` 的 import 与按钮、`PLAYING.md` 两段），**不要**为了"看起来干净"删掉某一侧。

---

## 5. 当前状态 / 待办（截至 2026-10-08 02:40 UTC）

- 合并线三次合并已提交并**推到 fork**：`9037cbc`（上游 v0.2.1，36 提交）→ `42c4da6`（PR #321 诊断信息）→ `c631cdb`（PR #323 本机统计页）。落后上游 0 / 领先 77。
- 全量测试基线：**`npm test` 5595 项 / 5572 过 / 9 失败 / 14 跳过**。9 个失败：3 个缺本机素材、2 个满负载抖动（单独跑过）、2 个合并前就存在（`/healthz` 的 `loopStats`、`matchQueueMax` 没进 `LOBBY_OPTION_KEYS`）、1 个默认 glob 跑到手工性能探针、1 个 zip UTF-8 名（本机无 Info-ZIP `zip`，bsdtar 用 GBK 写名 → 环境触发）。
- **双服已发维护 tips**：`{"id":"2026-10-08-1200-v021-update","tone":"maintenance","text":"12:00 更新 0.2.1，对局可能中断，请做好规划"}`（两台各留了 `.bak`；`.214` 原来的那条是「0.2.0 更新延后」）。
- **双服已挂一次性定时部署**：`sp-deploy-v021.timer` → **2026-10-08 04:00:00 UTC = 北京时间 12:00**，跑 `/opt/stronghold-deploy/deploy-v021.sh`（两机 `--preflight` 均通过）。
- 线上仍是 **0.1.3**；部署后 **JP 配音才会真正出声**（0.1.3 客户端不认 `voiceAlt`，也没有「配音语言」开关）。
- 待办：`fork/master` 仍在 v0.2.0（未快进）；上游 release 素材里的 ~399 个音效可择机补进 R2；线上那条 tips 部署成功后可换成「已更新完毕」或删除（`rm public/runtime/status.json`）。

---

## 6. 开放中的问题（2026-10-08 03:00 UTC 记录）

1. **双服定时器状态（已核）**：`.214` 与 t44 都挂了 `sp-deploy-v021.timer` → **2026-10-08 04:00:00 UTC（北京 12:00）**（`systemctl list-timers` 显示 `Thu 2026-10-08 04:00:00 UTC`，两机都做了"再等 30 分钟"的当场复核），并各加了一道 **cron 兜底 04:15 UTC（北京 12:15）**；两机脚本都是最新版 **8933 B / md5 `1368b954b46e3ba5799dcb79655b3c5b`**（会自动探测应用端口、主站与分线 vhost 都试、没有 `sp-code-version.conf` 时自动跳过 R2 发布），两机 `--preflight` 均通过；双服 tips 也都已发布并验证。
2. **`.22` 已关机，不在双服内**（用户 2026-10-08 确认）：它的 SSH 从 02:41 UTC 起失联就是因为**关机**（Paramiko `Error reading SSH protocol banner` / `No existing session`；从 `.214` 侧看是 `No route to host`），所以那台机器上误挂的 `sp-deploy-v021.timer` **不会触发**，暂时不用管。它上面还留着较早那版脚本（**8133 B**，`install_deps` 先 `npm ci`），**下次开机登录后**先换成新版：
   ```bash
   md5sum /opt/stronghold-deploy/deploy-v021.sh    # 期望 1368b954b46e3ba5799dcb79655b3c5b
   # 从本 fork 的 .tools/deploy-v021.sh 重新传一次；不想让它自动部署就 systemctl stop sp-deploy-v021.timer
   ```
3. **若 `.22` 12:00 部署失败且服务起不来**（`npm ci` 半途失败会留下被清空的 `node_modules`）：
   ```bash
   cd /opt/Stronghold-Protocol && npm i --omit=dev --no-audit --no-fund   # 就地补依赖
   systemctl restart stronghold && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/healthz
   # 仍不行就用备份回滚：
   bash /opt/stronghold-deploy/deploy-v021.sh --rollback-last
   ```
   两台的备份都在 `/opt/stronghold-deploy/backups/code-<ts>.tar.gz`，被保留的运营文件在 `backups/keep-<ts>/`。
4. 部署后 3 分钟内的自查（两台各跑一遍）：
   ```bash
   grep -m1 APP_VERSION /opt/Stronghold-Protocol/shared/constants.js        # 期望 0.2.1
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/healthz   # 200
   curl -sk -o /dev/null -w '%{http_code}\n' --resolve game.xiaolubao.com:443:127.0.0.1 https://game.xiaolubao.com/
   # .22 额外看客户端代码前缀是否换新：
   grep -E '^\s*default' /etc/nginx/conf.d/sp-code-version.conf
   ```

---

## 7. 对局与状态持久化（部署会不会丢对局）

**机制**：`server/state/*` 把每个进行中的对局持久化到 **`<repo>/state/matches/match:XXXX.json`**（`SP_STATE_DIR` 可改；默认就在 checkout 里，且 **`state/` 是 gitignored**）。落盘时机：每轮 `round_start` / `settle` + 数秒一次的心跳（`server/match/match/state.js`）。重启后由 `server/http/state.js` 在 `listen` **之后**惰性扫盘（`/healthz.state.scan` 给出 listed / loaded / refused / reasons），**玩家拿着重连 token 回来时**（`server/state/resume.js` 的一次性 claim）才真正重建那一局。重连窗口：普通 10 分钟，单人局按 `SP_SOLO_RECONNECT_MS`（默认 24 h）；记录 TTL 默认 20 分钟起（`recordTtlMs`）。

**部署不会碰它**：官方 `deploy-214.sh` / `deploy-t44.sh` 的备份都带 `--exclude=./state`，部署包里也没有 `state/` ⇒ 记录文件**原地不动**（2026-10-08 实测：`.214` 966 个 / 18 MB，t44 44 个 / 652 KB，且当时都在持续写）。`data/` 里也**没有**运行时文件（只有静态内容 + 运营手改的 `notice.json`）⇒ 不存在"部署覆盖玩家数据"。

**闸门到底比什么**（看 `server/state/resume.js` `checkRecord` + `server/http/state.js` `runBootScan`）：只有 **`rulesHash`** 是真闸门；**`build` 那半可以被 `SP_STATE_IGNORE_BUILD` 跳过**（两台都开着 ⇒ 部署改了 build tag 也不会中断对局）；**`engineHash` 是"只展示、不做闸门"的**（源码注释写明：拿它拒记录会让"每次代码部署都中断对局"，与这个功能的初衷相反，所以只在 `/healthz.state.scan.gate.engine` 里给运维看）。`rulesHash` = `data/*.json`（去掉美术/文案清单）+ `shared/constants.js` 的内容哈希。

**2026-10-08 实测（0.1.3 / 0.1.4 → 0.2.1 合并线）**：两边记录的 `rulesHash` 与部署后的新值**不同** ⇒ 不干预的话，旧对局在升级后一律 `refused(reason=rules)`，玩家重连后回大厅/开新局 —— 这就是维护 tips 里「对局可能中断，请做好规划」的由来。（记录 `version` 两边都是 2，与部署后一致；记录文件被拒后**不会被删**，`purgeRefused` 只清"永久不可恢复"的那类。）

| | `.214`（0.1.3） | t44（0.1.4） | 部署后（0.2.1） |
|---|---|---|---|
| `rulesHash`（记录里盖的章 / 新值） | `24b212ce2034cd8f…` | `07dba3abeed60d1e…` | `cdde5166f0a2d545…` |
| `engineHash` 前 12 位（仅展示） | `4a6cd96d9372` | `252f321d617b` | `510e8c15ca99` |

**强制恢复（当运维坚持"升级也要接回旧对局"时）**：`/opt/stronghold-deploy/force-resume.sh`（`.tools/force-resume.sh`，两台已部署）——
1. 等 0.2.1 真正落地（`APP_VERSION` + 部署标记 + `/healthz`，最多 15 分钟；部署失败/回滚就什么都不做，退出码 0）；
2. **先把整个 `state/` 备份**到 `backups/state-<TS>.tar.gz`（可回滚）；
3. 把每个记录的 `rulesHash` 改写成新值（`build` 顺手对齐；`inMatch === false` 的房间记录不动，与 `checkRecord` 的判据一致）；
4. 若真有改写就 `systemctl restart stronghold` **一次**（约 5 秒；必须在玩家的 10 分钟重连窗口内完成），然后复查 `/healthz.state.scan`（`loaded` / `resumedCount` / `reasons`）与日志里的 `[lobby] … failed to resume`；
5. 没有任何记录需要改写时**不重启**（规则没变的情况下等于空跑）。
⚠️ 代价：这是**把旧局面重放进新引擎**——上游用 `rulesHash` 挡住它正是因为"引擎状态会被拿来对着它没见过的输入重建"，恢复回来的局**可能状态错乱或报错**（第 4 步的日志会显示）。本次由用户明确要求才这么做。

### 拒绝理由全表（`server/state/resume.js` `checkRecord`）

| reason | 判定 | 能恢复吗 |
|---|---|---|
| `rules` / `build` | `record.rulesHash !== hash`（build 那半需未设 `SP_STATE_IGNORE_BUILD`） | **能** ✓ 打补丁或改写记录即可 |
| `phase` | `resumePlan()` 认为该阶段**不可重入**（只有轮次开始 / 开放备战 / 结算可重入） | ✗ 但**文件保留** |
| `final` | `record.round >= finalRound` | ✗ 文件保留 |
| `expired` | **`now - record.updatedAt > ttlMs`**；TTL = `max(20 分钟, SP_SOLO_RECONNECT_MS)` | ✗ **终态，启动即删** |
| `ended` / `no-human` / `version` / `shape` / `key-mismatch` / `missing` | 已结束 / 无真人 / 记录格式版本不符 / 结构坏 / 键不匹配 | ✗ 终态，启动即删 |

- **活着的对局永远不会 `expired`** ✓：轮次开始、结算、以及每几秒的心跳都会重写记录（源码注释：*a live match refreshes its record every few seconds, so its TTL never runs out*）⇒ `expired` = "**20 分钟没人动过的僵尸记录**" ✓，启动扫描顺手删掉 ✓。
- 删除集合 `PURGEABLE_REFUSALS = {version, shape, ended, no-human, key-mismatch, expired}`；**`phase` / `build` / `rules` 会被保留在磁盘上** ✓ —— 所以才存在"事后改写记录 + 重启"这条强制恢复路径 ✓。

### 2026-10-08 12:00 实况（0.1.3 / 0.1.4 → 0.2.1）
- 部署：`.214` 04:00:05→04:00:16 ✓（vhost 200 ✓）；t44 首跑因 **vhost 误判 → 自动回滚** ✗（见下方坑），04:02:50 修好后重部署 ✓。
- 对局：`.214` **417 局可恢复**（拒绝 68 = `phase×62, final×6`，**`rules` 为 0** ✓），玩家已接回 381+ 局；t44 **28 局可恢复**（拒绝 6 = `phase×6`），已接回 25 局。
  `.214` 首扫（04:00:25）是 `350 可恢复 / 513 拒绝`，拒绝里 `expired×486` 正是僵尸记录被清（`state` 文件数 966 → 555）✓，**不是部署弄丢的局** ✓。
- 保留验证：维护 tips（`public/runtime/status.json`）、`data/config.json`、`data/notice.json` 全部原样 ✓（mtime 仍是升级前 ✓）；两台 `sp-` 定时器与 crontab 兜底行都已自清 ✓；依赖 `7 缺=无` ✓。

**新坑（务必记住）**：`vhost_check` 用 `curl -sk --resolve <域名>:443:127.0.0.1 https://<域名>/` 做"重启后验证"——**t44 上必然返回 000** ✗（它的 nginx 只监听 `127.0.0.1:8080/8443`，443 由上层 stream 层 `$ssl_preread_protocol` 转发），于是把**已经升级成功**的 t44 判成失败并**自动回滚** ✗（把已升级的机器退回旧版，玩家多被踢一次 ✗）。修法：**先探测本机实际监听的 https 端口（443 / 8443）再 `--resolve` 到该端口**，并且该检查**只告警、绝不据此回滚** ✓（回滚的唯一依据应是本机 `/healthz` ✓）。

**另一处观察**：`download()` 的"优先使用本机预打补丁的包"分支**没生效** ✗（两台 12:00 日志都是「⚠ 包内没有规则章补丁 → 解包后由 `patch_state_gate` 补上」），兜底的"解包后补丁"那层按预期接管 ✓。**教训：任何"预先准备好"的优化都必须配一层"事后校验/兜底"** ✓，判定条件本身也还要再查。

## 8. 预载"卡住"（2026-10-08 修）

**症状**：设置里资源预载停在 `必需 5616/7190 · 全部 9040/11221 · 433 MiB / 433 MiB`，进度条满格但数目永远到不了头，看着像卡死 ✓。

**根因**：服务端清单（`/data/resource-manifest.json`）里的条目**只有能 stat 到本地文件的才有 `size`** ✓；`.214` 实测 `count=11221, tier1=7190, sized=9042`，即 **2179 个条目没有 size**（`assets/audio` 1179、`spine` 428、`char` 284、`skill` 205、`module` 37、`token` 35、`prof` 10、`ui` 1 —— 上游 `data/assets.json` 引用、本机没抓的文件 ✓）。客户端对没有 size 的条目判 `eligible=false` → **跳过、永不下载** ✓，可面板的**分母**用的是 `total`/`tier1Total`（含这 2179 个 ✗）→ 于是"该下的 9042 个全下完了 ✓ 字节 433/433 ✓，数字却说还差 2181" ✗ = 看起来卡住 ✓。

**修法**（`public/js/ui/resourcePanel.js` `detailText` + `public/js/resources/store.js`）：
1. 分母改为 `wanted`/`tier1Wanted`（**只有源站真有的条目才算目标** ✓）；`wanted === 0`（本机一个都量不到大小，例如 t44）就**不显示数目行** ✓，不撒谎 ✓。
2. `#adopt`（从旧缓存迁移那步，原本**没有**超时 ✗）加 `#withTimeout` 护栏 ✓：任何一步卡住都不再能把一条下载道钉死 ✓（否则整轮永不结束 ✓、面板永远停在「正在后台预载…」+ 最后一次推送的计数 ✓）。
3. 测试同步更新 ✓（`test/resources/panel.test.js` ✓ 51 项资源测试全绿 ✓）；`docs/ASSETS.md` 的 failure-states 段已写明语义 ✓。

**上线方式**：纯客户端文件（`public/js/**` + `public/i18n/*.json`）✓ → 直接替换 `/opt/Stronghold-Protocol/` 下对应文件即可 ✓（**不用重启** ✓），静态头是 `Cache-Control: no-cache` ✓ 玩家**刷新即生效** ✓，原文件留 `.orig-<TS>` ✓。部署脚本的 `SHA` 已从 `c631cdbd…` 升到含这些修复的合并线提交 ✓（见 `/opt/stronghold-deploy/deploy-v021.sh` 顶部的 `SP_SHA` 默认值 ✓，可用 `SP_SHA=<sha>` 覆盖 ✓）—— 不升的话下次部署会把热替换的修复冲掉 ✗。

**同批：预载的"需要 HTTPS"提示与措辞（2026-10-08 晚）**
- `unsupportedReason()` 去掉了自己设的 `isSecureContext` 门槛 ✓（「需要 HTTPS（或 localhost）才能预载资源」这句已删 ✓），改成只问浏览器能力：`!caches` 才是硬停 ✓，提示为「预载需要缓存存储：HTTP 页面不提供，改用 HTTPS 打开即可。」✓。**原因**：Cache Storage 是 secure-context API ✓（MDN 明文 "available only in secure contexts" ✓，非安全来源直接 `SecurityError` ✓），HTTP 页面上浏览器**根本没有** `caches` ✓ —— 所以光删提示并不会让预载在 HTTP 上跑起来 ✓，只是不再把锅扣在"我们的门槛"上 ✓。
- 管理器里「{skipped} 个文件超过单文件缓存上限」这句**是错的** ✗：线上那 2179 个是**清单没给大小**（= 源站没有 ✓），不是超过 24 MiB ✓ → 改成「{skipped} 个文件源站没有提供（清单里没有它们的大小），已跳过，使用时按需加载。」✓。三处 msgid（这句 + 上面那句 + 设置页提示里多余的「需要 HTTPS。」✓）在 en/ja/ko/zh-TW 四个语言包同步替换 ✓，`node tools/i18n.mjs check --all --strict` 四包 **1233 msgids 全译、0 缺失 0 错误** ✓。
- **t44 的域名与证书现状**（决定了玩家看到哪句话 ✓）：vhost `server_name game.kafuno.cn t44.sjcmc.cn _;` ✓，本机证书 SAN **只有 `game.kafuno.cn`** ✓ → `https://game.kafuno.cn`（DNS 在 **Cloudflare** 后面 ✓）证书有效 ✓ = secure context ✓ = **预载可用** ✓；而 `t44.sjcmc.cn` 上 HTTPS **证书不匹配** ✗（`ssl_verify_result=20` ✓），HTTP 又是非安全来源 ✗ → 用 `http://t44.sjcmc.cn:34046` 的玩家必然看到那句提示 ✓。**要给玩家就用 `https://game.kafuno.cn`** ✓（另一条路是把 `t44.sjcmc.cn` 加进证书 ✓ 或给 HTTP 口做 301 跳转 ✓）。
- **同批发现的另一件事：t44 的清单 `sized=0`** ✗ —— 它的 `public/` 里没有 `assets/` 目录 ✓，`/assets/...` 由 app 回 **302 跳转**（138 B ✓，资源在 R2 镜像 ✓）→ 服务端清单只能 stat 本地文件 ✓ 于是一个 size 都量不到 ✓ ⇒ **t44 上预载缓存不了任何东西**（全部条目被判 skipped ✓）。要真正修好得让清单能拿到大小（把 assets 落到本机 ✓ 或按 R2 元数据出 size ✓），属于资源托管方式的问题 ✓ 待定。

**怎么查**：`curl -s 127.0.0.1:3000/healthz` 的 `state` 段（`scan.reasons`、`resumedCount`、`persist.written/errors` / `lastError`），日志 `journalctl -u stronghold | grep '\[state\]'`。

## 9. t44 的"HTTP 也能预载"为什么无解，以及唯一可行路径（2026-10-08 议定）

**硬约束**（实测，不是推测 ✓）：
- **Cache Storage 是 secure-context API** ✓ → HTTP 页面上 `caches` 根本不存在 ✓ ⇒ **改代码无解** ✗，这不是我们的门槛 ✓。
- t44 的对外约束：**没有 80/443** ✗、**没有 `sjcmc.cn` 的 DNS 权限** ✗（`t44.sjcmc.cn` 只能 HTTP ✗）、**对外端口随机不可控** ✗、**出口 IP 不唯一**（同一时刻 `ipinfo`/`ifconfig.me` → `183.247.170.218` ✓，`myip.ipip.net` → `120.199.9.150`（浙江电信）✓，而 `t44.sjcmc.cn` 解析在 `120.199.9.131` ✓）⇒ **不要自己写 DDNS 脚本** ✗，改用 **CNAME** 继承现有 DDNS ✓。
- 因此 **`https://t44.sjcmc.cn:34046` 永远拿不到有效证书** ✗（HTTP-01 要 80 ✗ / TLS-ALPN 要 443 ✗ / DNS-01 要 TXT 权限 ✗）。

**Cloudflare 这条路已否决** ✗（延迟实测，2026-10-08 04:50 UTC）：

| 观察点 | 直连 t44 | 经 CF（`game.kafuno.cn`） | 到 CF anycast（1.1.1.1） |
|---|---|---|---|
| t44 本机（国内 ✓） | 0.01 s | **ping 182 ms** ✗ / TLS 0.37~0.61 s ✗ | 36 ms |
| `.214`（CF 边上 ✗） | ping 39.6 ms | ping 3.2 ms | 2.8 ms |

⇒ 免费版把国内流量解析到远处 PoP ✓，t44 流量要多绕 **≈146 ms 单程** ✗ —— 对锁步 RTS 报废 ✓。**CF Tunnel / CF 代理不得承载对局流量** ✗（`.214` 的体感**不能**代表 t44 ✗：两台的"CF 友好度"完全相反 ✓）。

**议定路径**（直连 + 自有域名 + 免费证书 ✓，延迟与现在一致 ✓）：
1. CF DNS 加 **`t44.kafuno.cn` CNAME → `t44.sjcmc.cn`** ✓，**代理状态必须 DNS only（灰云 ✗ 不能橙云 ✗** —— CF 不代理 34046 这种端口 ✓，橙云会把游戏打挂 ✓）。CNAME 直接继承 `sjcmc.cn` 那边现有 DDNS ✓，零维护 ✓。
2. 证书：把现有 lineage 扩一个 SAN ✓ —— `certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cf.ini --cert-name game.kafuno.cn -d game.kafuno.cn -d t44.kafuno.cn --expand` ✓（脚本 `/opt/stronghold-deploy/t44-add-kafuno-san.sh` ✓，先 `--dry-run` ✓）。本机 `certbot` **已装** ✓ 且 **cloudflare 插件在位** ✓（`certbot plugins` 命中 4 处 ✓、`python3-cloudflare` ✓），只差一个 **CF API Token（Zone:DNS:Edit for `kafuno.cn`）** 放在 `/etc/letsencrypt/cf.ini`（600 ✓）。
   ⚠️ 顺带修一个隐患 ✓：现有 renewal 是 **`authenticator = webroot`（HTTP-01，要 80 口）** ✗ —— 这台没有 80 ✓，**下次续期会失败** ✗（当前证书 2027-01-05 到期 ✓，还有 89 天 ✓）。换成 DNS-01 后不再依赖任何端口 ✓✓。
   nginx **一行都不用改** ✓：vhost 是 `server_name game.kafuno.cn t44.sjcmc.cn _;` ✓，`_` 已经兜住任意 Host ✓；证书路径固定 `/etc/ssl/t44/` ✓，由 deploy hook `renewal-hooks/deploy/t44-copy-cert.sh` 拷贝 ✓。
3. CF Redirect Rule：`https://game.kafuno.cn/*` → **`https://t44.kafuno.cn:34046/$1`**（302 ✓），并去掉原来那条 https→http 的规则 ✓（它正是玩家掉回 HTTP 的原因 ✓）。跳转是客户端行为 ✓ ⇒ 对局流量**直连** ✓，只有首跳经过 CF ✓，延迟不受影响 ✓✓。
4. 老入口 `http://t44.sjcmc.cn:34046` 保持不动 ✓（老书签不废 ✓，只是没有预载 ✓）。

**仍待解决（否则 HTTPS 修好预载也空转 ✗）**：t44 清单 `sized=0` ✓（见 §8 末 ✓）—— 得让清单能拿到大小 ✓：把 `.214` 的 `public/assets` 落到 t44 ✓（磁盘 29 G 空闲 ✓，`public/assets` 目前不存在 ✓），或让清单按 R2 元数据出 `size` ✓。

**验证口径**（做完后按这个查 ✓）：`curl -s --resolve t44.kafuno.cn:8443:127.0.0.1 https://t44.kafuno.cn:8443/` 期望 `200 tls=0` ✓（现在是 `tls=1` ✗）；`openssl x509 -noout -ext subjectAltName` 应含两个名字 ✓；`https://game.kafuno.cn/` 应 302 到 `https://t44.kafuno.cn:34046/` ✓；最后在浏览器里看 secure context（预载不再报需要 HTTPS ✓）。

### 9.1 执行记录（2026-10-08 05:20 UTC 起）

- ✅ **DNS**：CF 加 `t44.kafuno.cn` **CNAME → `t44.sjcmc.cn`**（灰云 ✓）——直接继承 `sjcmc.cn` 那边的 DDNS ✓（这台出口 IP 不唯一：`.218`/`.150`/`.131` 都出现过 ✗，自己写 DDNS 必错 ✗）。
- ✅ **令牌**：账户级令牌（`cfat_` 前缀 ✓）。**判据不是 `/user/tokens/verify`** ✗——账户级令牌打 `/user/*` 必然 401 `Invalid API Token` ✓（`/user` 还会 403 `Valid user-level authentication not found` ✓），**`GET /zones?name=kafuno.cn` 返回 200 才算可用** ✓。凭据写 `/etc/letsencrypt/cf.ini`（`dns_cloudflare_api_token = …` ✓ 600 ✓）。
- ✅ **证书**：`--dry-run` 演练通过 ✓ → 正式扩 SAN ✓ → `DNS:game.kafuno.cn, DNS:t44.kafuno.cn` ✓，到期 **2027-01-06** ✓。`renewalparams.authenticator` 已从 `webroot` 变 **`dns-cloudflare`** ✓ + `dns_cloudflare_credentials` ✓ ⇒ **顺带消除了"没有 80 口 → 续期必失败"的隐患** ✓✓。nginx **一行未改** ✓（`server_name … _;` 兜底任意 Host ✓；证书路径仍 `/etc/ssl/t44/` ✓，由 `renewal-hooks/deploy/t44-copy-cert.sh` 拷 ✓）。
- ✅ **公网验证**：`https://t44.kafuno.cn:34046/` → **`200 tls=0`** ✓✓（直连 `183.247.170.218` ✓ 有效证书 ✓）；`/healthz` → app 0.2.1 ✓；老 `http://t44.sjcmc.cn:34046/` 仍 **200** ✓（书签不废 ✓）；`stronghold` 全程 **未重启** ✓。⏭ 只剩 CF 那条 302 的目标要改成 `https://t44.kafuno.cn:34046/$1` ✓（改前它仍把玩家送回 http ✗）。
- ✅ **资源落盘（第二层）**：t44 从 R2 镜像按清单拉到 `public/…`（约 476 MB ✓，24~32 并发 ✓，已存在跳过、可断点续跑 ✓），并把 `.214` 的 `data/local-assets.json`（150 KB ✓）就位（清单 `count` 9756 → 11221 ✓）。结束后 `touch data/assets.json` 即重建 ✓：**清单缓存的失效键只认 `data/{assets,local-assets,asset-hashes}.json` 的 `mtime:size`** ✓（`server/resources.js:293` ✓）⇒ **不用重启应用** ✓（进程内 cache ✓）。
  ⚠️ **踩过的坑：不要按"本机清单的全部 URL"去拉** ✗ —— 11221 条里有 **2179 条来自 `local-assets.json`（`source: local-client`）的素材在 R2 上根本不存在** ✗（实测 242× 404 + 45× 超时 ✓），而 60/180 秒超时会把并发 worker 全钉死 ✗ → 进度从 1 MB/s 掉到 ~18 KB/s ✗。**正确做法：以 `.214` 清单里 `size` 存在的 9042 条为准** ✓（那正是 `.214` 磁盘上真有的集合 ✓ = `.214` 的 nginx 302 给玩家的集合 ✓），404 归零 ✓✓。诊断口径：`awk '{print $1}' /tmp/t44-fetch-fail.txt | sort | uniq -c` ✓ + 单文件实测 `curl -w '%{speed_download}'`（R2 单文件 1.19 MB/s ✓、CF 裸吞吐 2 MB/s ✓ ⇒ 慢就不是链路问题 ✓）。
- ⚠️ **落盘不会改变玩家侧的交付路径** ✓：t44 的 nginx（`/etc/nginx/snippets/t44-locations.conf` ✓）把 `/assets/**`、`/media/**`、`/fonts/**` 一律 **302 到 R2** ✓（实测 ✓，`?r2v=2` ✓）⇒ 本地文件**只用来让清单量到 `size`** ✓，家里那条上行不会被玩家拖 ✓✓。`.214` 同理：nginx 302 到 R2 ✓，只有直连 app `:3000` 才会拿本地文件 ✓（所以 `.214` 磁盘上的 476 MB 与玩家下载量无关 ✓）。
- 📌 排查技巧：`pkill -f <脚本名>` 会**连自己这条 SSH 命令一起杀掉** ✗（命令行里含同样的字符串 ✓）→ 用 `pkill -f '名字[-]分段'` ✓，且把重启逻辑放进**独立脚本**执行 ✓。

