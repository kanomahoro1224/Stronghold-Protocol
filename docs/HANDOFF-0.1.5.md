# 0.1.5 上线交接（本地已改完，待上线）

两件事：**① 客户端资源直连对象存储**（省掉 nginx 的 302 洪流）+ **② 无人观看的战场搬进 worker 线程**（P2）。
两者都能**独立回退**，且 ① **不需要重启**、② **需要重启**。

---

## ① 客户端 `/assets/**` 直连 R2

**做了什么**：新增 `public/js/assetOrigin.js`，在清单进入客户端的两处（`data.js` 的 `load()`、`assets.js` 的
`adopt()`/`local()`/`seedLocal()`/`localManifest`）把 `/assets/**` 字符串改写成对象存储的绝对地址。
改写在**清单层**完成，所以 `ui/assetUrls.js`、所有 `<img src>`、内联 CSS `url()`、PIXI/three 都自动生效，**零改调用点**。

**为什么安全**（每一条都有测试钉住，见 `test/asset-origin.test.js`）：
- 只改写以 `/assets/` 开头的字符串，其余（`sl.atlas` 这类裸文件名、`/media/…`、`/data/…`、已是绝对的 URL）**原样不动**。
- **`/assets/audio/**` 明确排除**：音频必须继续走游戏主机的无扩展名 `/media/…` 路径，否则 IDM/迅雷的「下载文件信息」弹窗会回来（`shared/media.js` 存在的原因）。
- 已实测 R2 自定义域带完整 CORS：`Access-Control-Allow-Origin: *`、预检 `OPTIONS` 返回 204 + `Allow-Methods: GET, HEAD`。
- **修掉一个致命点**：`assets.js` 的 `validSpine()` 原本要求 `.skel` 是根路径（`/^\/…\.skel$/`），改成绝对地址后会让**所有干员/敌人/召唤物模型解析为 null**（战场退化成静态图）。已放宽为接受绝对/协议相对/根路径三种，并加回归测试。
- 关闭开关：`globalThis.__SP_ASSET_BASE__`（字符串；空串 = 关闭），需在 `main.js` 执行前设置。默认在 `localhost/127.0.0.1/::1/file:` 下**自动关闭**，所以本地开发不受影响。

**上线**：发布代码版本（镜像 + nginx 版本前缀切换）即可，**无需重启 Node**。

```bash
# 服务器上（与上次热更新同一套流程）
python /opt/stronghold-deploy/r2_code_mirror.py --ver 0.1.5-<sha> --publish
```

**验证**：
```bash
curl -sL https://game.xiaolubao.com/js/assetOrigin.js | head -3          # 200 且是新文件
# 浏览器 DevTools → Network：/assets/** 的请求应直接指向 local.xiaolubao.com，且不再有 302
# nginx 侧：access.log 里 /assets/ 的 302 数量应大幅下降到接近 0
```

**回退**（秒级、无重启、不掉对局）：把 `/etc/nginx/conf.d/sp-code-version.conf` 的 `default` 改回旧前缀 + `nginx -s reload`。

**已知限制**：`/js`、`/css`、`/vendor`、`/sim`、`/shared`、`/data` 这一轮**不动**（只占约 2% 请求，且模块身份风险最高）；`/fonts/**` 与音频同样保留在 302 路径。

---

## ② 无人观看的战场搬进 worker（P2）

**做了什么**：新增 `server/match/simHost.js`（worker 入口，构造并推进一场 spec 驱动的 Battle）+
`server/match/simPool.js`（主线程池 + `parseSimWorkers`）；接线在 `Match._runOnServer` → 新的
`Match._runFieldInPool`，暂停/恢复接在 `_freeze`/`_unfreeze`。

**设计要点**（照着勘察结论做的）：
- 搬的是**一场 Battle**，不是 `Match`。`Match` 握着 socket 闭包、`PlayerState` 图、Maps/Sets 身份语义、boss 共享池和 RNG 流，**不能**过线程边界。
- **Boss/隐藏字段永不进 worker**（它们与主线程共享 boss pool 对象，克隆会悄悄破坏计分）；`BattleClass` 被注入时（测试的 `FakeBattle`）也一律留在主线程。
- **主线程是唯一的时钟**：worker 只在收到「授予切片」消息时才推进 ⇒ `_freeze` 只要停止授予，worker 就真的闲下来（P1b 的「冻结期间不得有 tick 落地」不变式由构造保证）。
- worker 只产出 JSON（结果/进度/时间线），**不认识任何 playerId→socket 映射**；所有帧仍走原有 `Match.sendTo`/`broadcast` → lobby → net 路径，背压与丢弃策略不变。
- 环境变量：`SP_SIM_WORKERS`（默认 `0` = 完全维持现状；`N>0` = N 个 worker，钳制到 `可用核数-1`）。
  虚拟调度器（测试/工具/平衡仿真）永远不会进 worker。

**上线**（需要重启 Node ⇒ 会中断进行中对局，建议低峰）：
```bash
# drop-in: /etc/systemd/system/stronghold.service.d/10-sim-tuning.conf 追加
Environment=SP_SIM_WORKERS=1
systemctl daemon-reload && systemctl restart stronghold.service
```

**验证**：
```bash
curl -s http://127.0.0.1:3000/healthz   # fields/fieldsIdle 与 loop p99 是主要观察项
# 本地：node --test test/match/simPool.test.js        （同 seed 的 resultDigest 必须一致）
#       node --test test/match/connection.test.js test/match/clientCombat.test.js test/match/simServe.test.js
```
线上可开 `SP_VERIFY` 抽样复核（已有的 `resultDigest` 服务端对照机制）。

**回退**：把 `SP_SIM_WORKERS` 改回 `0` + 重启（或直接删掉那一行）——行为与今天完全一致。

**已知风险与限制**（如实记录）：
- 2 vCPU 上池子最多 1–2 个 worker，否则会和主线程抢同一颗核（DESIGN §23 的评估：这项收益上限约 2×，排在①之前）。
- 每个 worker 会各自加载一次游戏数据（约 4.2 MB + 研究数据 3.9 MB）⇒ 每 worker 几十 MB。
- 无人在线也不是 100% 覆盖：机器人「预演」（`bot.js` 的 rehearsal）**不是** spec 驱动的，仍在主线程，属后续阶段。
- 对局结束/销毁时仍在跑的 worker 任务不会被主动取消（Battle 很短，结果会被丢弃）；队列是 FIFO。
- CSP：服务器目前**不发送** `Content-Security-Policy`；若将来 nginx/Cloudflare 加，必须把 R2 域加进
  `img-src`/`connect-src`/`media-src`/`font-src`，否则①会整片失败。

---

## 本地测试现状

| 套件 | 结果 |
|---|---|
| `test/asset-origin.test.js`（新增，含 spine 回归） | **16/16 通过** |
| `test/render/assets.test.js`、`test/ui/localArt.test.js`、`test/static-local-art.test.js`、`test/ui/assetUrls.test.js`、`test/media-url.test.js` | **47/47 通过** |
| `test/data.test.js`、`test/assets.test.js`、`test/media-url.test.js`、`test/ui/assetUrls.test.js` | 49 项中 **47 通过 / 0 失败**（2 跳过）；`assets.test.js` 有 1 条既有失败：本地检出缺 `public/assets/ui/emoticon|guide` 素材（该目录 git 从未跟踪，磁盘不存在），与本次改动无关 |
| `test/match/simPool-parity.test.js`（新增，P2 验收闸门） | **4/4 通过**（同 seed 的 `resultDigest` 在 worker 与主线程完全一致；pause/禁用/钳制均有断言） |
| `test/docs-consistency.test.js`、`test/match/simServe.test.js`、`test/match/connection.test.js` | **43/43 通过**（池默认关闭 ⇒ 行为与改前完全一致） |
| `test/match/clientCombat.test.js`、`test/match/runner.test.js` | **29/29 通过**（确定性闸门完好） |

上线前请再跑一遍上面三行；② 只有把 `SP_SIM_WORKERS` 设为 `1` 才会启用 worker。
