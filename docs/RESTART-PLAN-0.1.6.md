# 重启计划 0.1.6 — 提交清单与低峰重启清单

状态：**全部改动仅在本地工作区 ✓ 线上未部署 ✓ Node 未重启 ✓**
线上当前：代码版本前缀 `rel/0.1.5-assets-r2` ✓ / `NRestarts=0` ✓ / 站点 200 ✓
回退目标：代码前缀 `rel/0.1.4-473d5b0` ✓

---

## 一、提交清单（`feat/matchmaking-online-presence`）

> ⚠️ **成对提交**：`server/match/simPool.js` + `server/match/simHost.js` + `test/match/simPool.test.js` 三者的哈希已互相核对 ✓ 必须**同一提交** ✓ 否则池行为不一致 ✓。
> ⚠️ **不要提交** `.p2tmp/`（本地探针/截图/临时包 ✓）；建议加进 `.gitignore` ✓。

| # | 文件 | 内容 | 验证 |
|---|---|---|---|
| 1 | `public/js/assetOrigin.js`（新）+ `public/js/data.js` + `public/js/assets.js` + `public/js/battle/runner.js` + `public/js/render/fx.js` | ① `/assets/**` 直连对象存储 ✓；#8 数据/模拟基址**版本化** ✓ 去掉强制回源 ✓（动态 `import()` **保持字面量** ✓ 由发布器改写 ✓） | `node --test test/asset-origin.test.js test/asset-sibling-base.test.js test/data.test.js test/client-static.test.js` = 276 pass / 0 fail ✓ |
| 2 | `server/match/simPool.js` + `simHost.js` + `test/match/simPool.test.js`（均新） | ② worker 池 ✓ 默认 `SP_SIM_WORKERS=0` = 今日行为 ✓ 回退开关 ✓ 结果逐位一致（同种子 digest ✓） | `test/match/simPool.test.js test/match/simServe.test.js test/match/connection.test.js` = 30/30 ✓ |
| 3 | `server/match/Match.js`（池接线 + **虚拟调度器 gate 修复** ✓） | `if (f.cc && !this.sched.virtual && …)` ✓ 否则虚拟时间对局永不结算 ✗ | **开关 ON** 下 `test/match/clientCombat-review.test.js` = 19/19 ✓ |
| 4 | `server/match/Match.js` + `fields.js` + `server/lobby.js` + `server/index.js` | 三个修复：暂停真停 ✓ / `specBounds` memo（**线上 no-op** ✓ 如实标注 ✓）/ `/healthz` 加 `serverFields`+`mem` ✓ | 新增 `pause-headless-slice` ✓ `spec-bounds-cache` ✓ `healthz-load` ✓ + 既有 206 项 = 0 失败 ✓ |
| 5 | `README.md` + `docs/HANDOFF-0.1.5.md` | 环境变量与部署/回退说明 ✓ | 文档一致性套件 ✓ |

---

## 一之补：后续两项（同样未部署 ✓ 进同一个重启包 ✓）

- **内容键控缓存** ✓（`server/match/fields.js`）：WeakMap 挂在**共享冻结数据记录**上 ✓，数据源键用 `gd.raw` ✓（**不能**用 GameData 实例 ✗ 否则跨场复用塌掉 ✓ 第一版实测 73.7% ✓）。冷启动命中 **83.8%** ✓ 同进程后续 **100%** ✓；单场校验计算中位 **1335.6 → 118.2 µs** ✓（**~10×** ✓；一场 45 战场的校验 59–66 ms → **5–8 ms** ✓）。
  ⚠️ 单场 E2E **无差异** ✗（在本机 ±30–40% 噪声内 ✓ 因为校验只占一场 ~1% ✓）⇒ **预期收益在回合末几百场同时校验的 p99 上** ✓（推理 ✓ 非实测 ✓）⇒ 重启后**用 `loop.p99` 验证** ✓。
- **进度 ticker 暂停护栏** ✓（`server/match/Match.js`）：`this.paused` 时 tick 直接返回 ✓ 冻结时 arm 改为停靠 ✓ `_unfreeze` 只续一次 ✓（对应 157 个暂停对局每秒一次无效唤醒 ✓）。
- 两者都有「对原版代码会失败」的**测试牙** ✓：新增 `test/match/layer-memo-equivalence.test.js` ✓ `test/match/pause-progress-ticker.test.js` ✓（探针 `layer-memo-probe` 默认跳过 ✓ 不拖慢测试树 ✓）。

## 一之补三：**第 7 项待部署** ✓ —— 释放已完成战场的战场图（收益最大 ✓）

- 改动 ✓（`server/match/Match.js`）：`complete()` 调新的 `_releaseFieldBattle(f, run)` ✓（:2407）→ `f.battleErrors = run.battle.errors; f.battle = null` ✓（:2447）；`_collectSimErrors` 先读 `f.battleErrors` ✓（:2016）；`_ccField` 增 `battleErrors: null` 槽 ✓（:2150）✓。**release 时序 / timeline / endGt 未动** ✓；cc 战场里 `f.battle` 的唯一读者就是 `_collectSimErrors` ✓（其余读 result/timeline/endGt ✓ 已逐一核对 ✓）。worker 池路径本来就已置 null ✓。
- 实测 ✓（边际斜率法 ✓）：2h+2b **R1 −51.2%** ✓ **R7 −65.9%** ✓ **R13 −62.2%** ✓；0h+4b R7 **−70.7%** ✓；**无机器人战场的档 ±0.8%** ✓ =噪声底 ⇒ 收益**恰好等于被释放的图** ✓。
- 每个完成的服务端战场省 **99 KB(R1) / 377 KB(R7) / 402 KB(R13)** ✓ ⇒ 按 471 个机器人座位 = **47 / 174 / 185 MB** ✓（峰值 584 MB 的 **8–32%** ✓）。
- 测试牙 ✓：`test/match/field-battle-release.test.js`（3 项 ✓。含「释放版 vs 保留版逐场 deep-equal」✓）对改前版本**全部失败** ✓。
- ⚠️ **尚未上线** ✗：15:11 的重启上的是改动**之前**的 `Match.js` ✓（`E26F7608…` ✓）⇒ **下次重启随包带上** ✓。
- 一并记录 ✓（都**已回退/未实施** ✓ 且都低于 5% 门槛 ✓）：Lever 2 共享 GameData memo（仅 8.5–14.5 MB ✓ 1.5–2.5% ✓，`fields.js` 已确认与改前逐字节相同 ✓）；Lever 3 裁剪视图 JSON（上限 ~14.5 MB ✓ 2.5% ✓ 而代价是 `m.public` 流量 **×6.7** ✗）。

## 一之补二：**已经生效**的线上护栏（已核实 ✓ 不需重启 ✓）

- **`MemoryMax=943718400`（900 MiB）** ✓ —— 注意：drop-in **必须带 `[Service]` 段头** ✗ 否则 systemd **静默忽略** ✗（我第一次就踩了 ✓ 已隔离 ✓）；生效证据 = `systemctl show` **与** cgroup `memory.max` **双读 943718400** ✓。
- **2 GB swap** ✓（`/swapfile` ✓ 权限 600 ✓ 写入 `fstab` ✓ 持久化 ✓）+ `vm.swappiness=10` ✓（`/etc/sysctl.d/99-swappiness.conf` ✓）。
- 依据 ✓：主机**物理内存仅 1967 MB** ✗（OOM 时 `used 1443 MB` ✓）⇒ **OOM 是主机级** ✗ 不是 cgroup（`MemorySwapMax=infinity` ✓ / `memory.swap.max=max` ✓）。
- 未解释 ✓：原 1.2 GB 值的**来源文件没找到** ✗（drop-in 目录只有 `10-sim-tuning.conf` ✓ 且它不含 `MemoryMax` ✓）—— 但 `99-` 覆盖已生效且双读一致 ✓ 可复核 ✓。

## 二、待重启清单（**只在低峰做** ✓ 实测 1799 人在线时不可动 ✗）

**包里装**：第 1 项以外全部服务端改动 ✓（4 + 3 + 2 ✓）+ 可选环境变量 `SP_SIM_WORKERS=1` ✓。

**顺序** ✓
1. 提交 ✓（按上表成对 ✓）
2. `node --check` 四个服务端文件 ✓ + 跑第 3、4 项的目标套件 ✓ 全绿才继续 ✓
3. 记录基线 ✓：`/healthz` ✓（`loop.p50/p99` ✓ `fields` ✓ `humans` ✓ `bots` ✓ `mem` ✗ 新字段重启后才有 ✓）
4. `systemctl restart stronghold.service` ✓（**一次** ✓ 会中断进行中对局 ✓ 所以必须低峰 ✓）
5. **重启后立刻核对** ✓
   - `/healthz` 出现 **`serverFields`** + **`mem:{rss,heap}`** ✓（payload 仍 < 2000 字节 ✓）
   - **关键判据** ✓：`serverFields` 是否**随 `bots` 数量**一起走 ✓ ⇒ 证实「机器人战场 = 60–80% 一个核」✓✓（此前 `fields:1` 是盲区 ✗）
   - `loop.p50/p99` ✓ 与基线对比 ✓；站点 200 ✓；`NRestarts=1` ✓；开一局机器人对局做冒烟 ✓
6. 观察一段时间 ✓ → 再决定 **#1（机器人战场降量 ✓ 策略决策 ✓）**

**回退** ✓：`SP_SIM_WORKERS=0` ✓（池关闭 ✓ 无需回滚代码 ✓）；服务端 `git revert` + 重启 ✓；客户端只改 `sp-code-version.conf` 的 `default` 前缀 ✓ + `nginx -s reload` ✓（**不重启 Node** ✓ 秒级 ✓）

---

## 三、两条硬纪律（本轮踩过 ✗）

1. **传输必须哈希闸门** ✓：`sshx.py put` 对较大文件**会丢最后 1 字节** ✗（70,353 → 70,352 ✓ 实测 ✓），曾导致 tar 部分解包弄坏服务器上的 `fx.js` ✗（已修复 ✓ sha 精确匹配 ✓）⇒ 所有远端脚本一律「**哈希匹配才解包/才发布**」✓。
2. **不用内联引号的 `exec`** ✗（PowerShell 转义会炸 ✗）⇒ 一律写 `.sh` 用 `sshx.py run` ✓。
