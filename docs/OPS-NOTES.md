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

---

## §10 资源缺口：0.2.0 / 0.2.1 新干员素材（头像 / 立绘 / 技能图 / Spine）一个都没有

**症状**：0.2.0/0.2.1 加入的那批干员（外援），头像、立绘、技能图标、Spine **全部 404**，游戏里一片空白。

**根因**：`data/assets.json` 是**提交在仓库里的清单** ✓，并入上游后它引用的条数涨到 **9756** ✓；但 `tools/fetch-assets.mjs` 上一次真跑是 **10-07 13:17**（那次 `[plan]` 只有 7470 个文件、`stats.files=7470`）⇒ `public/assets/` 上实际只有 **7577** 条 ⇒ **缺 2179 条**，其中 **1000 条是图/骨架**：`spine/op` 428、`skill/*.png` 205、`char/avatar` 142、`char/portrait` 142、`token/avatar` 35、`prof/sub` 10；另 1179 条是音频（`audio/voice` 994 + `audio/sfx` 185）。

**为什么"清单里有"却没人发现**：`server/resources.js` 的清单**只从本机 `stat` 取 `size`** ✓（`measure()`）⇒ 本机没有的文件在清单里就是**没有 `size`** ✓，客户端预载把它算进「源站没有提供（清单里没有它们的大小），已跳过」✓（§8）⇒ 服务端看着"一切正常" ✓，玩家侧是图裂 ✗。

**交付链路决定修法**：nginx 把 `/assets/**`、`/media/**`、`/fonts/**` 一律 **302 到 `https://local.xiaolubao.com/Stronghold-Protocol<path>`** ✓ ⇒ **玩家看到的图 = R2 上的对象** ✓。所以"把文件补到机器上"只让清单量到 `size` ✓，**必须同时上传 R2** ✓。

**修法（全程在服务器上做，不重启应用）**
1. `.214`：`cd /opt/Stronghold-Protocol && node tools/fetch-assets.mjs` ✓（**不带** `--prune` / `--force` / `--allow-shrink` ✓）。实测 **50 秒** ✓，9540 → **12123 文件** ✓，476 → **643 MB** ✓，9 MB/s ✓，`miss=4` ✓。
2. 服务器直传 R2：`214-r2-push.py` ✓（纯标准库 SigV4 ✓，key = `Stronghold-Protocol/<去掉 public/ 的路径>` ✓）。实测 **12130 个对象 / 612.9 MB / 265 秒 / 2.3 MB/s / 失败 0** ✓。

**坑（按踩到的顺序）**
1. **`--dry-run` 的计划行在头部** ✓：`[plan]` 在上面 ✓，尾巴全是 `spineLocal` 的 note ✗ ⇒ 用 `head` 看，别用 `tail` 只看尾巴就下结论 ✗。
2. **`spineLocal`**：部分 `token_*` / `enemy_*` 的 Spine **官方客户端才有** ✓，上游 dump 拿不到 ✓ ⇒ 下载器只给 note 不给文件 ✓（本次 `miss=4` ✓）⇒ 要用 `tools/local-extract`（Python + Ark-Unpacker ✓）从官服文件提取到 `public/assets/local/` ✓（该目录**永不被 `--prune` 删** ✓）。
3. **R2 上有两套布局** ✓：历史上一批对象只存在于**桶根**（`/assets/...` ✓），而 nginx 302 到的是**带前缀**的 `Stronghold-Protocol/assets/...` ✓ ⇒ 排查时**两个路径都要试** ✓，别看到一个 404 就下结论 ✗。
4. **`.214` 上没有任何上传工具** ✓（`rclone`/`aws`/`s3cmd`/`mc`/`storcli` 全无 ✓，`boto3` 也没有 ✓）⇒ 只能自己签 SigV4 ✓；**path-style 必须把 bucket 名放路径第一段** ✓（否则 R2 把 `Stronghold-Protocol` 当成 bucket 名回 `InvalidBucketName` ✓）。
5. **key 里千万别混进 `public/`** ✓（本次真事故 ✓）：`os.path.relpath(full, APP)` 得到的是 **`public/assets/...`** ✓ ⇒ 直接拼前缀就传成了 `Stronghold-Protocol/**public**/assets/...` ✓ ⇒ **PUT 返回 200 但正确 key 上是 404** ✗✗ ⇒ 所以**不能只看 PUT 的 200** ✓，必须用**签名 S3 HEAD** 验真 ✓（`214-r2-s3verify.py` ✓）。
6. **Cloudflare 会对同一 IP 的高频 HEAD 限流** ✓（本次 `.214` 全部 403 ✓，连原本 200 的对象也 403 ✓）⇒ 验真走**签名 S3 直连** ✓；玩家路径从别的 IP 实测正常 ✓（说明限流只影响排查 ✗，不影响玩家 ✓）。
7. **凭据处理**：只从环境变量读 ✓（`R2_EP`/`R2_AK`/`R2_SK`/`R2_BUCKET` ✓），env 文件用 `put`（SFTP ✓）落到 `/root/.r2env` 并 `chmod 600` ✓，用完 `shred` ✓；**任何脚本都不打印** EP/AK/SK ✓。
8. **PowerShell 传远端命令**：双引号里的 `$(…)` 会被 **PowerShell 本地**求值 ✗（`||` 直接语法报错 ✗）⇒ 一律用**单引号**包远端命令 ✓，复杂逻辑写成脚本 `put` 上去再 `bash` ✓。
9. **Python 后台日志是块缓冲** ✓：`print` 重定向到文件时，`tail` 会长时间 0 字节 ✗（本次 4 分钟 ✓）⇒ 用 `python3 -u` ✓，或读 `/proc/<pid>/io` 的 `wchar` 估进度 ✓（本次 630 MB / 643 MB ✓）。
10. **`pkill -f <脚本名>` 会连自己那条 SSH 命令一起杀** ✗（命令行里含同名串 ✓）⇒ 用 `pkill -f '名字[-]分段'` ✓，重启逻辑放独立脚本 ✓。
11. **别按本机清单的"全部 URL"去 R2 抓** ✗：`local-assets.json`（`source: local-client`）里那 2179 条在 R2 上**根本不存在** ✓ ⇒ 404 + 60/180 秒超时会把并发 worker 钉死 ✓（1 MB/s → 18 KB/s ✗）；正确口径是**以 `.214` 清单里存在 `size` 的集合为准** ✓（那正是 `.214` 磁盘上真有的集合 ✓）。

**验收口径**：R2 上 `https://local.xiaolubao.com/Stronghold-Protocol/assets/char/avatar/char_003_kalts.png` = **200** ✓；`.214` 清单 `count=12115 / tier1=8084 / sized=12115 / 0 unsized / 612.9 MiB` ✓；**签名 S3 逐条核对 12115/12115 = 200**（`214-r2-verify-all.py` ✓ 86 秒 ✓，非 200 = 0 ✓）；t44 补齐后 `sized` 同步 ✓；玩家侧不再图裂 ✓。

**顺带纠正一个认知** ✓：交付给客户端的清单必须是**新**的那份 ✓ ⇒ 补全后 `.214` 的 `data/assets.json`（`stats.files` 9749 → **10643**，路径引用 **+894 条、−0 条** ✓ 纯增量 ✓）已同步回仓库并提交 ✓（`3cb18f2` ✓）—— **不做这一步，下一次部署会把新干员的素材从清单里抹掉** ✗。同时也要把这份清单推给 t44 ✓（t44 的客户端读的是**它自己**那份 ✓，不推它就不会去请求新干员的图 ✗）。

### §10.1 t44 侧补齐：不该从 R2 拉，也不该用重试参数

**为什么另一台服也要有一份文件**：清单里的 `size` **只来自本机 `statFile`** ✓（`server/resources.js` `measure()` ✓）⇒ **谁给客户端发清单，谁就必须有这些文件（或至少知道尺寸）** ✓。客户端拿 `size` 决定预载谁 ✓、算分母与百分比 ✓；没 `size` 的条目会被跳过 ✗（§8 / §10 那条提示 ✓）。字节本身仍是客户端**直接从 R2 取** ✓（nginx 302 ✓）⇒ **t44 本地那些文件根本不参与交付** ✗，它们只为"量尺寸"存在 ✓。

**两条路都试过，实测（同一晚，同一批文件）**
- **`.214` 直推 t44**（`rsync -a --size-only --chown=stronghold:stronghold -e "ssh -p 34005 -o BatchMode=yes" /opt/Stronghold-Protocol/public/<子目录>/ root@t44.sjcmc.cn:/opt/Stronghold-Protocol/public/<子目录>/` ✓）：**单条 SSH 流只有 ~70 KB/s** ✗（7 分钟 29 MB ✗）；并发到 4~8 条时开始 `Connection timed out during banner exchange` ✗（`183.247.170.218:34005` ✓，`.214` 这个源 IP 被 sshd/网络限流 ✓）⇒ **能用，但在这条跨云链路上不快也不稳**。
- **t44 从 R2 拉**（`xargs -P 24` + 60 秒超时 ✓）：**~440 KB/s** ✓（473 MB / ~18 分钟 ✓），失败率 7~8%（都是偶发 `000` ✓，多轮快扫能收干净 ✓）⇒ **本轮最快的其实是这一条**。
- ⇒ 结论 ✗：**"直推" 不是性能最优解**，"减少要传的东西"才是 —— 见下面的根治办法 ✓。

**根治办法（推荐，但属于生产配置变更，需你点头）** ✓：t44 不必存这 643 MB ✗，它只需要**一份带尺寸的清单** ✓。t44 的 nginx 加一条即可：`location = /data/resource-manifest.json { proxy_pass http://45.207.220.214/data/resource-manifest.json; }` ⇒ t44 直接用 `.214` 的清单（**尺寸天然齐全** ✓），字节照旧由客户端从 R2 取 ✓ ⇒ **以后 `.214` 换资产，t44 零同步** ✓。代价：预载面板依赖 `.214` ✗（游戏本身不依赖 ✓——它的 `/data/*.json` 是本地的 ✓）。

1. **rsync 默认比"大小 + mtime"** ✗：t44 上那些文件是 curl 下来的 ✓ 时间戳不同 ✗ ⇒ 不加 `--size-only` 会把 643 MB **全部重传** ✗（两边内容同源于 R2 ✓ 大小必等 ✓，这里用它安全 ✓）；首次同步后 `-a` 会对齐 mtime ✓，以后就干净了 ✓。
2. **免密要先铺** ✓：`.214` 生成 `id_ed25519`（`ssh-keygen -t ed25519 -N '' -C 214-to-t44` ✓），公钥进 t44 的 `/root/.ssh/authorized_keys` ✓（该机 `PermitRootLogin yes` ✓），并 `ssh-keyscan -p 34005 -H t44.sjcmc.cn > /root/.ssh/known_hosts` ✓ 才能非交互 ✓。
3. **收尾补漏别用 `-m 120 --retry 3`** ✗✗（本次真教训 ✓）：挂住的连接会把并发 worker 钉死好几分钟 ✓，8 并发 15 分钟只推进 **191** 个 ✗；补漏就该沿用抓取时那套 **60 秒超时 + 多轮快扫（12~24 并发）** ✓。
4. **`.214` 上带 `if/then/fi` 或内嵌 `python3 -c "…"` 的内联命令会被打回** ✗（`rc=2`、**无任何输出** ✗）⇒ **一律写成脚本 `put` 上去再 `bash`** ✓（本次所有失败的调用都是内联的 ✓，所有成功的都是脚本 ✓）。
5. **客户端 `gone` 表是按"清单 hash"记 404 的** ✓（`store.js #goneSet` ✓）：服务端修好后，只要该文件的 **hash 没变** ✗，客户端就**永不再试** ✓ ⇒ 面板出现「{gone} 个文件源站没有（已跳过，不影响使用）」（`resourcePanel.js:247` ✓—— 注意它和「清单里没有它们的大小」那条是**两句不同的话** ✓，别混 ✓）⇒ 修法是玩家侧**「清理缓存」** ✓（`store.clear()` 会连索引里的 `gone` 一起删 ✓），或改成"清单 `version` 变了就重试一次" ✓。
6. **清单在应用进程里是带缓存的** ✗（缓存键 = `data/{assets,local-assets,asset-hashes}.json` 的 **mtime:size** 加上 `cdnBase` ✓，见 `server/resources.js` 的 `key` ✓）⇒ 文件落地后必须 `touch data/assets.json` 才会按**新尺寸**重建 ✓；本次因为 rsync 与 curl 两路并行 ✓，第一轮 `touch` 拿到的还是旧尺寸（`totalBytes=603.6 MiB` ✗），**等两路都停了再 `touch` 一次**才收敛到 `612.8 MiB` ✓（与 `.214` 的 `612.9` 一致 ✓）。⇒ **换完文件的最后一步永远是：确认没有下载进程在跑 → `touch` → 再读 `/data/resource-manifest.json` 核对 `sized`** ✓。

**t44 最终验收** ✓：`public/assets` **12123 文件 / 643M**（与 `.214` 一致 ✓）；清单 `count=12115 / tier1=8084 / sized=12115 / 0 unsized / 612.8 MiB` ✓；`stronghold` 服务全程未重启 ✓（仍启动于 04:03:00 UTC ✓）。

## §11 客户端设置项「下载并发」（小 lanes 4→16 / 大 lanes 1→4）

**改了什么** ✓：预载并发由 **4 小 + 1 大** 提到 **16 小 + 4 大** ✓，并做成资源管理器里的设置项 **「下载并发」（4 / 8 / 12 / 16，默认 16）** ✓，持久化为 `settings.preloadLanes` ✓。
链路（缺一环就不生效 ✗）：`ui/gameLogic/settings.js`（`PRELOAD_LANES` + `DEFAULT_SETTINGS.preloadLanes` + `sanitizeSettings` 白名单 ✓）→ `main.js`（`ResourceManagerHost` 传 `lanes`/`onLanes` ✓ + `installResourcePreload` 里 `syncResources(…, s.preloadLanes)` ✓）→ `resources/index.js`（模块态 `lanes` + `applyLanes(store)` ✓，在 `resourceContext()`、`startDownload()`、`syncResources()` 三处落地 ✓）→ `resources/store.js`（`DEFAULT_SMALL_LANES = 16`、`DEFAULT_BIG_LANES = 4`、`bigLanesFor()` = 小 lanes 的 1/4，至少 1 ✓）。
**为什么不重建 store** ✓：`resourceContext()` 的 promise 是缓存的 ✓（一页只建一次 ✓，重建等于再拉一次清单 + 多一条进度线 ✗），而 `store.smallLanes/bigLanes` 是**每轮 `drain()` 现读的普通字段** ✓ ⇒ 直接赋值即可 ✓。

坑（按"再踩一次会误判"排序）：
1. **`node --test <目录>` 在 Node 24 被当成模块路径** ✗✗：报 `Cannot find module 'F:\…\test\resources'` ✓，汇总里于是出现 2 个 "fail" ✓ ⇒ 那是**假警报** ✗，不是用例失败 ✓。跑整目录请显式列文件 ✓；`node --test` 不带参数才是递归全量 ✓（仓库 **549** 个 `*.test.js` ✓，含真实对局集成测试 ✓，所以"全量几分钟"是正常的 ✓）。
2. **`tools/i18n.mjs seed` 会静默漏包** ✗：同一份种子喂 4 个包，`en`/`ko` 各加 2 条 ✓，`ja`/`zh-TW` 报 `0 added` 且**确实没写进去** ✗。改用 `template <code>` 也不行 ✗ —— 它会把另一个包里的**陈旧 msgid** 一并补成空串 ✓（本次 24 条 ✓ 全是代码已不再使用的 ✓）⇒ **正确做法**：`JSON.parse` → 追加 → `JSON.stringify(json, null, 2) + '\n'`，**照 `writeCatalog`（`tools/i18n.mjs:585`）的序列化原样写回** ✓，diff 才只有插入的那几行 ✓；落盘后 `node tools/i18n.mjs check --all` 验收 ✓（本次 4 包 **1235/1235 = 100%、0 missing、0 errors** ✓）。
3. **PowerShell 控制台看 UTF-8 中文全是乱码** ✗：`Get-Content` / `Select-String` 都不可信 ✓（`-Pattern '中文'` 直接匹配不到 ✓，害我一度以为 i18n 没写进去 ✓）⇒ 看文件内容一律用 read / grep 工具 ✓，别用 PowerShell 文本 cmdlet 下结论 ✓。
4. **PowerShell 双引号里的 `$(…)` 在本地展开** ✗：`exec root "… hostname=$(hostname) …"` 打出来的是本机名 ✓（远端其余数据是对的 ✓，极易看错 ✓）⇒ 远端命令避免 `$()` ✓，或写成脚本 `put` 上去跑 ✓（与 §10.1 第 4 条同源 ✓）。
5. **客户端静态文件改了不用重启** ✓：`Cache-Control: no-cache` + ETag ✓、入口 `src="/js/main.js"` **无版本号** ✓ ⇒ 刷新即生效 ✓。本次 12 个文件用 `putbin`（二进制安全 + sha256 校验 ✓）上传 ✓ → 远端 `sha256sum` **逐个与本地一致** ✓ → 线上字节校验 `mark=1`（`.214` 的 `:3000`、t44 的 `:8080` / `:80`、公网 `game.xiaolubao.com:443`、公网 `t44.kafuno.cn:34046` ✓），两台 `stronghold` 全程未重启 ✓（仍 04:01:02 / 04:03:00 UTC ✓）。

**验收** ✓：`test/resources`（7 文件）+ `test/ui/gameLogic` + `test/i18n` + `test/client-static` + `test/docs-consistency` + `test/docs-paths` = **386/386 通过 / 0 失败** ✓（另加本轮定向 140/140 ✓）；i18n `check --all` 4 包 100% ✓；两台机器 12 文件 sha256 一致且线上生效 ✓。

## §12 预载改直连 R2（不走 nginx 302）

**背景** ✓：客户端 `public/js/assetOrigin.js` 早就把 `/assets/**` 重写成对象存储的绝对地址 ✓（文件头注释写明原因：302 曾占那台 2vCPU 机器 **~60% 请求量 / ~30% CPU** ✓），`data.js` 与 `assets.js` 在**清单入口**统一重写 ✓ —— **只有资源预载清单这一处漏了** ✗。
后果有两层 ✓：① 预载每个文件都白吃一次 302 ✓；② 更要命 —— 预载把文件存在**站点路径**下（`https://game/assets/x.png` ✓），而游戏运行期请求的是 **CDN 绝对地址** ✓，Service Worker 的 `matchResource` 又是按**完整 URL** 查缓存 ✓ ⇒ **永远查不到** ✗ ⇒ 预载的 613 MB 对游玩**毫无作用** ✓，玩家首次用到时还得再下一次 ✗。

**改法** ✓（纯客户端 ✓ 不重启 ✓）：`resources/index.js` → `validateManifest(rewriteAssetPaths(await res.json()))` ✓ + `new ResourceStore(manifest, { cdnBase: assetBase() })` ✓；`store.js` 新增 `sourceOf()` ✓（缓存键仍是站点路径时改从存储按路径取 ✓ —— 音频就是这一类 ✓）与 `aliasOf()` + `#adopt` 内的**旧键迁移** ✓（老缓存哈希相符就搬过去 ✓ ⇒ 老玩家不重下 ✓）；哈希不符自动 `?sp=<hash>` 重取那套本来就有 ✓（`store.js:477` ✓）⇒ 边缘给陈旧字节也能自愈 ✓。

**实测证据** ✓：取清单里的真实 URL 直连对象存储 ✓ → **200** ✓ + `access-control-allow-origin: *` ✓ + `cf-cache-status: DYNAMIC` ✓（CF 根本不缓存这些对象 ✓ ⇒ 不必带 `?r2v=2` ✓）；`archive.js resourcePath()` 的注释本就是「跨 origin/CDN 前缀稳定」✓ ⇒ ZIP 导入导出不受影响 ✓。

**坑** ✓：迁移测试的前提要写对 ✓ —— 迁移发生在「**清单已是 CDN 绝对地址、缓存仍是站点路径**」时 ✓；若测试里清单还写着站点路径 ✗（生产里 `index.js` 会先重写 ✓），`keyOf` 也是站点路径 ✓、`aliasOf()` 返回 null ✓，于是它会**真的去下载** ✗（我第一版就这么写错了一次 ✓ 断言 `calls` 为空才抓到 ✓）。

## §13 合并上游预载修复（`xinhai-ai` `a94c720a`）

**结论先行** ✓：上游 `xinhai-ai/Stronghold-Protocol` 与本 fork 的预载是**两套并行实现** ✗（`git merge-base --is-ancestor` 全部返回 1 ✓，`store.js` 两边差 ±475 行 ✓）⇒ **不能 `git merge`** ✗（等于重写 ✓）。逐条对比后 ✓：上游预载史上 20 条提交里 ✓，本 fork **只有最新两条没有** ✓ —— `a94c720a fix: preload board metadata and normalize resource paths` ✓ 与 `5d8e91e7 perf: optimize ZIP resource imports with bounded read caching` ✓（后者依赖上游自研的 `zipReader.js`/`integrity.js` 栈 ✗，我们走 fflate 且本就流式 ✓ ⇒ **不移植** ✓）。

**`a94c720a` 补的两个真缺口** ✓（本地实测 ✓）：
1. **棋盘元数据从未进过预载** ✗：`resourceType()` 只认扩展名 ✓ ⇒ `.json` 一律 `null` ✓ ⇒ `public/assets/local/map/autochess/tiles.json`（8745 B ✓，`boardArt.js:45` / `board3d/load.js:115` 运行期确实 fetch ✓）等 4 个文件**永远不在清单里** ✓（`manifest: json 0` ✓）。
2. **方括号路径两套拼写、缓存永不命中** ✗：渲染器按 `encodeURI` 请求 `%5Bopt%5D…` ✓，清单/缓存键却是字面量 `[opt]` ✓ ⇒ 本地 6 个这类文件（`fx/[opt]merged_textures*.png` ×5 ✓ + `water/[ucp]TX_water_normal.png` ✓）预载等于白下 ✓。

**改法** ✓：新增 `shared/resourcePaths.js`（`isBoardResourceJson` 白名单 4 个 json ✓ + `canonicalResourceUrl` 归一 `%5B`/`%5D` ✓），服务端 `server/resources.js`（`resourceType` ✓、`collectResourceFiles` 归一+去重+`tiles.json` 同伴推导 ✓、`pathKey` ✓、`localPathFor` decode+控制字符拦截 ✓、`createResourceIndex` 由磁盘现算 `tiles.json` 指纹并让 size/mtime 参与失效 ✓）、客户端 `common.js`/`service.js`/`archive.js`（缓存键归一 ✓、旧字面量键作为**回退候选** ✓、ZIP 身份归一且**旧包仍可读** ✓）、`tools/asset-hashes.mjs`（键改归一 ✓）、`buildTag.js`（把 `shared/resourcePaths.js` 纳入 build 标识 ✓ ⇒ SW 依赖变了要刷新页面 ✓）。

**⚠️ 部署最大的坑** ✓：`data/asset-hashes.json` 被 `.gitignore` 忽略 ✓ ⇒ **机器上那份才是生效的** ✓。`.214` 那份只有 **7182/12123** 条 ✓ 且方括号是**字面量** ✓ ⇒ 若在机器上**全量重算** ✗，几千个文件的 hash 会从「合成 stamp」变成真 SHA-1 ✓ ⇒ **所有玩家重下 613 MB** ✗✗。正确做法 ✓：**只把那 6 个键重命名为 `%5B` 拼写** ✓（其余一条不动 ✓），棋盘 JSON 本来就在表里（4 条 ✓）✓、`tiles.json` 由服务端现算 ✓ ⇒ 零重下 ✓。t44 干脆**没有**这份表 ✗ ⇒ 它的清单哈希是合成值 ✓（t44 公网有自己的清单 ✓，与 `.214` 的 ZIP 互通性本就受限 ✓ —— 记录在案 ✓）。

**验收** ✓：定向 8 文件 **435/435 通过 / 0 失败** ✓（含移植的 5 条：`common` 白名单/缓存键 ✓、`manifest` 棋盘 + 方括号 + 工具链 ✓、`archive` 棋盘 JSON 往返 + 旧字面量包兼容 ✓）；`client-static` 通过 ✓ ⇒ 新 `shared/` 导入可解析 ✓（`server/http/static.js:70` 本就挂载 `/shared/` ✓）。

## §14 社区站上线 + 域名分工（`game.` = 社区 ✓ `hk.` = 游戏）

**结果** ✓：`community/` 作为**独立进程**跑在 `.214` 的 `127.0.0.1:3100` ✓，公网入口 `game.xiaolubao.com` 反代到它 ✓；游戏本体的公网名换成 `hk.xiaolubao.com` ✓（原本 `game.` 的那份 nginx 站点文件**原样搬家** ✓，R2 302 / `sp_code` 分流 / `/ws` / `/data/resource-manifest.json` 全部保留 ✓）。**证书不用动** ✓ —— `/etc/nginx/ssl/xiaolubao/{fullchain,privkey}.pem` 是 `*.xiaolubao.com` 通配 ✓（ZeroSSL ECC ✓ 到 2026-10-23 ✓），两个名字共用 ✓；机器上**没有 certbot** ✓（也不需要 ✓）。

**数据库是这次唯一不能想当然的环节** ✓✗：
- 库里有真数据 ✓（2 个节点 ✓ 其中 `HK - 分线` 已指向 `https://hk.xiaolubao.com/` ✓、管理员 `admin@luke.qaq` ✓、3 个会话 ✓），**绝不能让服务器重新 seed** ✗。
- 迁之前必须 `PRAGMA wal_checkpoint(TRUNCATE)` ✓：开发机 `community.db-wal` 有 **107 KB 未落盘** ✗，只拷 `.db` 会静默丢数据 ✓（合并后 WAL = 0 ✓ 单文件 36864 B ✓ sha256 `3761c2c3…` ✓）。
- 部署脚本**只在库不存在时放置** ✓，之后每次部署都不覆盖线上库 ✓✓。
- 两类文件永不入库 ✓：`server.log`（首启可能打印随机管理员密码 ✗）与 `.shots/token.txt`（真会话 token ✗）✓ 已进 `.gitignore` ✓。

**服务** ✓：`/opt/Stronghold-Protocol/community` ✓ + `/etc/systemd/system/stronghold-community.service` ✓（`User=stronghold` ✓ `PORT=3100` ✓ `HOST=127.0.0.1` ✓ `NODE_ENV=production` ✓ → 会话 Cookie 带 `Secure` ✓；`node:sqlite` 只需 Node ≥ 22.5 ✓ 机器是 22.23.3 ✓ 无原生依赖、无 `node_modules` ✓）。零停机 ✓：**只 `nginx -t` + `nginx -s reload`** ✓，游戏进程全程没重启 ✓（切换前后 `humans 1601→1583`、`matches 592→588`、`sockets 2028→1908` ✓ 现有 WS 不断 ✓）。回滚 ✓：`/opt/stronghold-deploy/game.xiaolubao.com.conf.bak-20261008-101225` ✓（恢复 + 删掉 `hk.xiaolubao.com.conf` + reload ✓）；`nginx -t` 失败脚本会自己回滚 ✓。

**两个坑** ✓：
1. **`resource-sw.js` 注销桩** ✓：老玩家在 `game.` 源上还注册着**游戏**的 Service Worker ✗，它会拿游戏缓存回答 `/fonts/**`、`/assets/**` ✓ ⇒ 会盖掉社区站自己的 `/fonts/fonts.css` ✗。社区的站点块里用 `location = /resource-sw.js` 直接返回一段自注销脚本 ✓（`activate` 时 `self.registration.unregister()` ✓，Cache Storage 不动 ✓）。
2. **验收别用 `-H 'Host: x' https://127.0.0.1/`** ✗：SNI 是 `127.0.0.1` ✓ 而且 HTTP/2 的 `:authority` 不跟随 `-H Host` ✓ ⇒ 拿到的是默认 server（旧 worker 还在退场时更乱 ✗）。我第一版就因此看到「同一 Host 下 `/` 是游戏页 ✗、`/healthz` 是社区 ✗」这种自相矛盾 ✓。正确姿势 ✓：`curl --resolve <name>:443:127.0.0.1 https://<name>/…` ✓。

**影响面** ✓：老玩家在 `game.` 上**已建立**的连接继续有效 ✓（reload 不断 ✓），但**刷新就会落到社区页** ✓ ⇒ 之后要走 `hk.xiaolubao.com` 或 `t44.kafuno.cn:34046` ✓；社区列表里两条节点正好就是这两个 ✓ ⇒ 落地页天然把玩家导过去 ✓。`.214` 的站点文件与单元同步留档在 `community/deploy/` ✓。

## §15 社区站延迟判断：本机 ping 失败 ≠ 节点离线

**改因** ✓：列表页原来只认浏览器实测 ✗ —— 本机测不到就写「本机延迟未知」✗，服务端探测失败就直接写「离线无响应」✗。线上实测发现**两边都会错** ✓：

- **本机侧会错** ✓：广告拦截 / 门户认证 / 混合内容拦截 / 一次丢包 ✓，从页面里看和「节点死了」完全一样 ✓（我把页面对 `/healthz` 的请求拦掉，卡上立刻变成「本机延迟未知」✗）。
- **服务端侧也会错** ✗：`.214` 上 `t44.kafuno.cn` 解析到 **183.247.170.218** ✓ 而这个 IP 从 `.214` **TCP 完全连不通** ✗（curl 30s 超时 ✓ node `UND_ERR_CONNECT_TIMEOUT` ✓ **去掉证书校验结果一样** ✓ ⇒ 是网络层不是 TLS ✓）；同一时刻 `hk.` 只要 **0.07 s** ✓，而玩家浏览器测 t44 只有 **164 ms** ✓ ⇒ 服务端写「离线无响应」就是**判断错误** ✓。

**改法**（纯客户端 ✓ 不需要重启 ✓）：

1. `measure()` 一整轮 3 次全废时**再重试一轮** ✓ —— 瞬时失败不再一次定生死 ✓。
2. 本机没数时**先问服务端** ✓：`measureLatencies()` 重拉一次 `/api/servers?probe=1` ✓（服务端探测自己有 10s 缓存去重 ✓ 不会额外压节点 ✓），并在 **5s** 后只对失败的节点补测一次 ✓（不必等下一个 30s 周期 ✓）。
3. 判断收敛进 `latency.js` 的 `statusFor()` ✓，五态分明 ✓：`pending`（还没有服务端结论 ✓ 不下判断）/ `local`（本机实测 ✓）/ `ok`（服务端可达但本机没数 ✓ → 「本机未测到 · 服务端 NN ms」✓）/ `reachable`（服务端不可达但**本机刚连通** ✓ → 「本机可达」✓ 绝不说离线 ✓）/ `off`（**两边都没数据**才允许 ✓）。「进入服务器」按钮同时改成 `服务端可达 || 本机有数` ✓。
4. 数字来源写清楚 ✓：tooltip 明确「这是服务端探测结果，不是你的本机延迟」✓。

**验收** ✓：`community/tools/check-latency-logic.mjs` **28/28** ✓（含反向用例与重试计数 ✓）；`community/tools/verify-latency-fallback.mjs` 三趟浏览器 e2e ✓（正常 ✓ / 本机 ping 被拦截 ✓ / 服务端探测被伪造为失败 ✓），**本地与公网都全部通过** ✓ —— 公网那趟直接把 t44 判成「本机可达」✓。上线是纯静态替换 ✓（sha256 一致 ✓ community/game 两个时间戳都没动 ✓）。

**已办** ✓（见 §16）：探测超时 4s→8s ✓、传输失败重试一次 ✓、以及 `probe.js` 注释一直**宣称**却没实现的「放宽 TLS 校验」✓ 都已补上 ✓；并给 t44 配上了稳定可达的探测地址 `https://t44.sjcmc.cn:34046/` ✓。

## §16 「实际探测地址」：公开地址 ≠ 服务端能探测到的地址

**背景** ✓：§15 那个 t44 误判 ✓ 的根因再确认 ✓ —— 在 `.214` 上跑 `probe.js` 完全同款的调用（Node fetch ✓ 5s 预算 ✓ 开/关证书校验各一次 ✓）：

| 候选地址 | 开证书校验（probe.js 现状 ✓） | 关证书校验 |
|---|---|---|
| `https://t44.kafuno.cn:34046/` | **240 ms · 200** ✓ ／ 紧接着再跑一次同样调用 **5s 超时** ✗ | 5s 超时 ✗ |
| `https://t44.sjcmc.cn:34046/` | **`ERR_TLS_CERT_ALTNAME_INVALID`** ✗（证书是 `*.kafuno.cn` ✓） | **207 ms · 200** ✓ |
| `120.199.9.131` / `8.129.152.245` / `39.103.26.212` 三个 IP ✗ | 全超时 ✗ | 全超时 ✗ |

⇒ 两条结论 ✓：① **「瞬时连不上」的真相是 `t44.kafuno.cn` 的 DNS 答案在变** ✓（同一个 5 秒窗口内 ✓ 一次 240 ms 通 ✓ 一次 5s 超时 ✗）；② 从 `.214` **稳定可达**的是 `t44.sjcmc.cn:34046` ✓（207 ms ✓ 每次都通 ✓），但它的证书名不匹配 ✗ ⇒ 要用它就必须补上 `probe.js` 注释里**已经宣称**、代码里却没有的放宽校验 ✗。

**本次改动**（后台可选字段 ✓）：

- `servers.probe_address` 列 ✓（`ALTER TABLE … NOT NULL DEFAULT ''` ✓，`openDatabase()` 里按 `PRAGMA table_info` 判断后补列 ✓ ⇒ 老库自动迁移 ✓，已用「无该列的旧 schema」回归 ✓）。
- 探测目标统一走 `probeTargetOf(row) = probe_address || address` ✓；玩家的「进入服务器」和浏览器测速**始终**用 `address` ✓ ⇒ 两者互不影响 ✓。
- 后台「编辑服务器」新增「实际探测地址（可选）」✓（留空＝用公开地址 ✓），表格地址下方标注「探测 → …」✓ 一眼能看出服务端在探哪个 ✓。
- 该字段**只对管理员返回** ✓（公开 API 不含 ✓）—— 它可能是直连 IP 或内网名 ✓ 不该暴露给玩家 ✓。
- 改地址时**两个目标的探测缓存都立刻失效** ✓ 不用等 10s TTL ✓；入参规则 ✓：不传＝不动 ✓ 传空串＝清空 ✓ 非法地址＝400 ✓。

**验收** ✓：`tools/check-probe-address.mjs` **24/24** ✓（旧库迁移 ✓ 入参校验 ✓ 真实 API：公开地址用 `192.0.2.1`（RFC 5737 ✓ 必然连不通 ✓）+ 探测地址指向本机服务 ⇒ 判定**可达** ✓ 证明探测确实走的是探测地址 ✓；清空后回落到公开地址并如实判不可达 ✓；游客响应里没有该字段 ✓）。`tools/verify-admin-probe-address.mjs` **9/9** ✓（真实浏览器：编辑弹窗有该字段 ✓ 回填已存值 ✓ 改完保存写进数据库 ✓ 表格刷新 ✓）。`check-latency-logic.mjs` 28/28 回归 ✓。

**部署** ✓：`systemctl restart stronghold-community` ✓（只重启社区服务 ✓ 游戏进程与 nginx 都不动 ✓）。

- `probe.js` ✓：改用 `node:http` / `node:https` 就地为**每一次探测**关掉证书校验 ✓（`fetch` 想按请求放宽必须倚赖 undici ✗ 而本项目零依赖 ✗）；超时 4s→**8s** ✓；**传输失败（超时/压根没连上）重试一次** ✓（重试预算 4s ✓ ⇒ 最坏约 12s ✓），HTTP 层结论不重试 ✓；仍最多跟随 3 次跳转 ✓ 响应体上限 64KB ✓。
- t44 的 `probe_address` 直接写库设为 `https://t44.sjcmc.cn:34046/` ✓（重启前写入 ✓ 重启后探测缓存天然是空的 ✓ 不用等 TTL ✓）。
- 证书回归 ✓：`tools/check-probe-address.mjs` 第 4 节用**提交在库里的自签证书** ✓（`tools/fixtures/` ✓，已注明仅供测试 ✓）起一个本地 https 服务 ⇒ **对照实验**：普通 `fetch` 因证书不受信失败 ✓、`probe()` 正常拿到 200 JSON ✓ ⇒ 该文件 **27/27** ✓。
- 从本机实测 ✓：`probe('https://t44.sjcmc.cn:34046/')` → **ok=true 197 ms** ✓（`app 0.2.1` ✓ 就是那台游戏节点 ✓）。

**上线结果** ✓（2026-10-08 10:42 UTC ✓）：

- 流程 ✓：解包（不含 `data/` ✓ 线上库不被覆盖 ✓）→ `node --check` ✓ → 盒子上跑 `tools/check-probe-address.mjs` **27/27** ✓ + `check-latency-logic.mjs` **28/28** ✓ → 用新 `probe.js` 直接探 ✓：`t44.sjcmc.cn` **175 ms ok** ✓、`t44.kafuno.cn` **157 ms ok** ✓ → `systemctl restart stronghold-community` ✓。
- ⚠️ **踩坑** ✗：脚本原先把「给 t44 写 `probe_address`」放在重启**之前** ✓ 结果 `Error: no such column: probe_address` ✗ —— 迁移是**服务进程启动**时由 `openDatabase()` 跑的 ✓ 重启前库里还没有这一列 ✓ ⇒ **顺序必须是「先重启（跑迁移）→ 再写库」** ✓（脚本已按此修正 ✓ 结果一致 ✓）。
- 线上复核 ✓（游客视角 ✓）：community `10:42:48 UTC` ✓ / game `04:01:02 UTC` **未动** ✓；`game.` 与 `hk.` 都 **200** ✓ `nginx -t` ok ✓；**两条节点都 `ok=true`** ✓（t44 151 ms ✓ HK 14 ms ✓）⇒ t44 不再被判离线 ✓；游客响应里 `probeAddress=undefined` ✓（不泄露运维地址 ✓）。
- 数据 ✓：`id=1` 公开 `https://t44.kafuno.cn:34046/` ✓ 探测 `http://t44.sjcmc.cn:34046/` ✓（部署脚本写的是 `https://` ✓，10:43:30 UTC 又在**后台界面**里被改成 `http://` ✓ —— 这顺带证明该字段在线上端到端可用 ✓，UI → API → 库都通 ✓；两种 scheme 都探得到 ✓ 实测 86 ms ✓，只是 http 那一段是明文（内容仅是公开的 `/healthz` ✓）✓ 想换回 https 后台改一下即可 ✓）；`id=2` 探测＝公开 ✓。

## §17 iOS 打开 `game.xiaolubao.com` 只有一片深色空页

**症状** ✓（用户实拍 ✓）：iPhone Safari 打开 `game.xiaolubao.com` ⇒ 只有深色背景 ✓ 没有任何内容 ✓；桌面与安卓正常 ✓。

**根因** ✓：`public/index.html` 用 `<script type="importmap">` 把裸模块名映射到 `/vendor/*.js` ✓，而 **import map 需要 Safari/iOS 16.4+** ✓ —— 更旧的 iOS 会**静默忽略**它 ✗ ⇒ `import { useState } from 'preact/hooks'` 这类裸名解析失败 ✗ ⇒ 整个 `main.js` 不执行 ✓ ⇒ **CSS 到了（所以是深色 ✓）而 `#app` 永远是空的** ✓，逐项对上症状 ✓。

- 全仓扫描确认 ✓：**没有任何** iOS 16.4+ 才有的 JS 语法/API ✓（`structuredClone` ✓ `toSorted` ✓ `??=` ✓ `Object.groupBy` ✓ `Promise.withResolvers` ✓ 静态块 ✓ 全都为零 ✓）⇒ 唯一的拦路虎就是 import map ✓（CSS 里可能有个别新特性 ✓ 但那只会影响外观 ✓ 不会白屏 ✓）。
- 顺带发现 ✓：游戏站 `hk.` **也有** import map ✗，但它自带 `__spBootFail` 兜底 ✓；社区站**什么兜底都没有** ✗ ⇒ 用户只能看到空页 ✓。

**修复** ✓（纯静态 ✓ **不需要重启** ✓）：

1. 6 个用到裸模块名的前端文件全部改成真实地址 ✓（`/vendor/preact.module.js` ✓ `/vendor/hooks.module.js` ✓ `/vendor/htm.module.js` ✓）。
2. ⚠️ **只删 importmap 不够** ✗ —— `vendor/hooks.module.js`（官方压缩过的 hooks 构建 ✓）内部自己写着 `from"preact"` ✓，一并改成 `from"./preact.module.js"` ✓。**以后替换这个 vendor 文件必须重新改这一处** ✓。
3. `index.html` 删掉 importmap ✓，改为先加载**普通脚本** `js/boot-guard.js` ✓ 再加载 module ✓。
4. 新增 `js/boot-guard.js` ✓：普通脚本（不依赖模块 ✓）⇒ 任何启动失败（模块 link 失败 ✓ 脚本报错 ✓ 或 8 秒还没渲染 ✓）都在页面顶部显示中文提示 + **UA** ✓ ⇒ **以后不会再出现「一片空页」** ✓；`main.js` 渲染成功后置 `document.documentElement.dataset.appReady = '1'` ✓。
   ⚠️ CSP 是 `script-src 'self'` 且没有 `unsafe-inline` ✓ ⇒ 兜底必须是**外链普通脚本** ✓，**不能**用 `onerror=` 内联处理器（会被 CSP 拦掉 ✗；游戏站那边正是内联写法 ✓ 在社区站行不通 ✓）。

**验收** ✓：`tools/check-module-specifiers.mjs` **10/10** ✓（纯 Node ✓ 全仓裸模块名归零 ✓ importmap 复活即失败 ✓ 兜底脚本必须存在且不含 import/export ✓ 且不许出现内联处理器 ✓）；`tools/verify-no-importmap.mjs` **9/9** ✓（浏览器两幕 ✓：**把 importmap 删掉再加载 = iOS 16.4 以下的处境** ✓ 页面照常渲染出卡片 ✓；**故意让 `/vendor/*` 全部加载失败** ✓ 页面出现可读提示并带 UA ✓ 不再是空页 ✓）；回归 ✓ `check-latency-logic` **28/28** ✓ `check-probe-address` **27/27** ✓。

**仍待办** ✓：游戏站 `hk.` 的 import map ✗ —— 它有兜底提示但**进不去游戏** ✗ ⇒ 旧 iOS 用户要么升级到 16.4+ ✓，要么用同样办法改客户端 ✓（那是**上游文件** ✓ 改动面大得多 ✓ 需要单独决定 ✓）。

## §18 状态判定：只要一侧连得上就是「运行正常」；超时要给三次机会

**用户口径** ✓（2026-10-08 ✓）：
1. 「服务器连不上公开地址，但是客户端连上了，就是运行正常」 ✓；
2. 「超时一般不会三次都超时，只有三次都超时才要判为不正常」 ✓。

**改了什么** ✓：

- **前台状态口径** ✓（`public/js/latency.js` 的 `statusFor()` ✓）：**服务端可达 OR 本机实测到 ⇒ 「运行正常」（绿）**；**两侧都没数据**才判「离线无响应」（红）。此前「服务端不可达 + 本机可达」会写成主行「本机可达」（琥珀）⇒ 按用户口径**不再降级**，改为主行「运行正常」✓，把小字写成 `服务端探测超时 · timeout · 本机 180 ms` ✓（琥珀色小字 ✓，问题仍可见 ✓）。卡片圆点/绿框、「在线节点」统计都按同一口径 ✓。
- **后台「实时状态」列** ✓（`public/js/views/admin-servers.js` ✓）：拆成两行 —— **服务端**（社区服务器探到的可达/不可达 + 延迟）与 **本机**（这个浏览器实测的延迟）；服务端不可达但本机连通时补一个「节点可用」✓。管理员不会再因为社区服务器出口不通而误判一个玩家能进的节点 ✓。
- **服务端探测次数** ✓（`server/probe.js` ✓）：**2 次 → 3 次** ✓。第 1 次 5s、第 2/3 次各 2.5s、总预算 10s（`SP_COMMUNITY_PROBE_*` 可调）⇒ **只有三次都超时才判不可达** ✓；HTTP 层已有明确结论（非 2xx / 非 JSON）不重试 ✓；失败结果缓存 30s（成功仍 10s）✓；同地址并发**复用同一次探测**（in-flight dedupe）✓ ⇒ 一个死节点不会让 `/api/servers` 每轮都耗满预算 ✓。
- ⚠️ 以上只有 `server/probe.js` 需要**重启服务**才生效 ✗（前台两处是静态文件 ✓ 已上线 ✓，服务端文件已先放上盘 ✓）。

**验收** ✓：`tools/check-probe-retries.mjs` **19/19** ✓（黑孔 ⇒ 恰好 3 次连接 ✓；前两次超时第三次正常 ⇒ 判可达 ✓；HTTP 500 / 非 JSON ⇒ 只探 1 次 ✓；同地址并发只发 1 次 ✓；失败缓存生效 ✓）；`tools/check-latency-logic.mjs` **35/35** ✓（含「只要一侧连得上就是运行正常」✓、「本机可达不再作为主标题」✓）；`tools/verify-admin-probe-address.mjs` **12/12** ✓（含状态列两行 ✓）；`tools/verify-latency-fallback.mjs` 公网三趟 ✓ 全绿。

**顺手抓到一个真 bug** ✓：新加的 `boot-guard`（§17）在本地跑后台页时**立刻**报出 `admin-servers.js:110 Unexpected reserved word` ✓ —— 我在 `setLatency((prev) => ({ ...prev, ...(await measureAll()) }))` 里对**非 async 的状态更新函数**用了 `await` ✗ ⇒ 后台整页白屏 ✓（正是 §17 那个兜底要防的场景 ✓ 它第一天就发挥作用了 ✓）。改成先 `await` 再把结果交给 `setState` ✓ 后恢复正常 ✓。
- 公网三趟 e2e 复跑 ✓ **全部通过** ✓：正常 `本机 159 / 62 ms` ✓；拦截本机 ping ⇒「运行正常 / 本机未测到 · 服务端 1247 / 23 ms」✓ 不说离线 ✓；伪造服务端失败 ⇒「本机可达 / 探测超时 · timeout · 本机 162 ms」且可进入 ✓。

