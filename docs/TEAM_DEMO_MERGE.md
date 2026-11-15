# 联机四人 Demo 合并与视角切换（计划）

> 状态：草案，待确认后实施  
> 日期：2026-11-15  
> 关联：`docs/ACCOUNTS.md`、`public/js/demoRecorder.js`、`public/js/demoReplay.js`、`server/accounts/*`

## 1. 目标

一局 4 人联机结束后：

1. 每个玩家把自己客户端录制的 Demo 上传到云端；
2. 服务端按同一 `matchId` 把四份帧数据合并成一份共享 Demo；
3. 四个人都能在回放中切换到任意队友的战场视角；
4. 回放仍然 100% 在客户端运算，服务端只做数据拼装，不做战斗模拟、不重跑 seed。

非目标：

- 服务端重新模拟战斗；
- 把合并后的 Demo 做成公开战绩（默认只给本局参与者）；
- 改变本机 Demo 无限保存的规则；
- 让没有账号 / 没有上传成功的玩家也出现在完整合并局里。

## 2. 结论

**方案可行，但不能把四份 JSON 原样拼接。**

必须把数据拆成三类再合并：

| 数据 | 来源 | 合并规则 |
| --- | --- | --- |
| 公共时间轴 | 四人都会收到的 `m.public / m.result / m.ticker` | 按服务端时间对齐、去重，只留一份 |
| 每个战场的帧 | 该战场归属玩家自己的客户端 | 每个 `fieldId` 只信 owner 的 `m.field / b.start / b.snap / b.ev / b.end`；观战副本只作缺失兜底 |
| 私有帧 | 每个玩家自己的 `m.private` | 按 `playerId` 分开存；查看者只能拿到自己的 private |

服务端合并的 CPU 成本主要是 JSON 解析、排序、去重、压缩，**不包含战斗运算**，压力远低于服务端重跑。

## 3. 现状与缺口

已经具备：

- `demoRecorder` 录制原始 S2C `wire`、本地战斗真实帧 `b.snap / b.ev / m.field`；
- 提交 `a9660d49` 后，玩家切去查看队友时，自己的后台战斗也会持续录帧；
- 提交 `a9797916` 后，同一个 unit id 跨回合换模型会正确重建视图；
- `demoReplay` 已支持按真实快照 seek、精确暂停、时钟冻结；
- 云端每账号保留最新 10 局，单局上限 3 MB。

当前缺口：

1. Demo 文档没有 `matchId`，服务端无法把四份上传归到同一局；
2. 上传是“各存各的”，没有 parts / merge 概念；
3. 单局 3 MB 上限装不下四人合并文档；
4. `demoReplay` 把 `g.watch` 拦截成空操作，不能切 field；
5. `wire` 只包含本机收到的帧；队友战场只在玩家实际观战时才有数据；
6. 各客户端 `at = Date.now() - startedAt` 不可直接跨机器比较，需要统一时间轴。

## 4. 总体架构

```text
玩家 A/B/C/D 客户端
  └─ 结算时上传自己的 Demo part
        POST /api/team-demos/:matchId/parts
              ↓
      team_demo_parts（每 matchId + playerId 一份）
              ↓ 四份到齐 / 超时
      服务端 Merger（只合并 JSON，不模拟战斗）
              ↓
      team_demos（canonical，压缩存储）
      team_demo_links（每个参与者账号 → 同一份 canonical）
              ↓
      GET /api/team-demos/:id（按当前账号过滤 private）
              ↓
      demoReplay：公共时间轴 + 全部战场帧 + 自己的 private
```

### 4.1 Canonical 文档结构

```jsonc
{
  "version": 2,
  "kind": "team",
  "matchId": "m_...",
  "startedAt": 1794727034097,
  "endedAt": 1794727075000,
  "mode": "coop",
  "difficulty": "HARD",
  "players": [
    { "playerId": "p_a", "seat": 0, "name": "A", "isBot": false },
    { "playerId": "p_b", "seat": 1, "name": "B", "isBot": false }
  ],
  "public": [
    { "at": 1200, "serverAt": 1794727035297, "t": "m.public", "m": { "...": "..." } }
  ],
  "fields": {
    "n:p_a": {
      "owner": "p_a",
      "kind": "normal",
      "fieldMeta": { "fieldId": "n:p_a", "rect": {}, "stageId": "..." },
      "frames": [
        { "at": 24000, "serverAt": 1794727058097, "t": "b.snap", "m": { "...": "..." } }
      ]
    }
  },
  "privates": {
    "p_a": [ { "at": 1200, "serverAt": 1794727035297, "m": { "t": "m.private", "...": "..." } } ]
  },
  "marks": [],
  "rounds": [],
  "result": {},
  "partial": false,
  "availableFields": ["n:p_a", "n:p_b", "n:p_c", "n:p_d"]
}
```

`frames` 里的 `at` 是 canonical 对局时间（从 `startedAt` 起算），`serverAt` 是用于跨客户端排序的绝对毫秒。两者都保留，回放优先用 `at`，合并/诊断用 `serverAt`。

## 5. 对局标识（matchId）

### 5.1 服务端

`server/match/host/entry.js` 创建 Match 时已经有 `matchId`，把它传入 Match 实例，例如 `opts.matchId`。

`publicView()` 增加：

```js
matchId: this.matchId || null,
```

只加一个字符串字段，旧客户端会忽略，不改变现有协议语义。

### 5.2 客户端

`demoRecorder.begin(frame)` 从首条 `m.public` 读取：

```js
matchId: msg.matchId || null,
playerId: store.get().me?.playerId || null,
```

`DemoDoc` 增加 `matchId / playerId / isTeam`。

没有 `matchId` 的旧 Demo 永不上传合并，继续走现有单机路径。

### 5.3 服务端校验

上传 part 时：

- 必须登录；
- `body.playerId` 必须属于当前账号：查 `player_links`；
- `(matchId, playerId)` 唯一；
- 至少 2 个非 bot 玩家才创建 team demo；
- 第一个 part 记录该局的 participants 集合，后续 part 的 participants 必须一致；
- 不信任客户端单方面声明“这局有谁”，后续可加服务端签发的 match upload token。

## 6. 上传与归组

### 6.1 新接口

保留现有 `POST /api/cloud/demos` 给单机/非合并局。

新增：

```http
POST /api/team-demos/:matchId/parts
Content-Type: application/json
Content-Encoding: gzip
Body: { matchId, playerId, doc }
```

限制：

- gzip 后 ≤ 12 MB；
- 未压缩 JSON ≤ 24 MB；
- `doc.wire` 只接受 `version >= 2` 的 recorder 文档；
- 同一 `(matchId, playerId)` 可重传覆盖，幂等；
- 上传成功返回 `{ ok:true, partId, waitingFor }`。

查询：

```http
GET /api/team-demos/:matchId/status   // 已上传玩家、缺谁、合并状态
GET /api/team-demos/:id               // 按当前账号过滤后的回放文档
```

### 6.2 表结构

```sql
CREATE TABLE team_demo_parts (
  id bigserial PRIMARY KEY,
  match_id text NOT NULL,
  player_id text NOT NULL,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  doc bytea NOT NULL,              -- gzip JSON
  bytes integer NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, player_id)
);

CREATE TABLE team_demos (
  id bigserial PRIMARY KEY,
  match_id text UNIQUE NOT NULL,
  canonical bytea NOT NULL,        -- gzip canonical JSON
  bytes integer NOT NULL,
  partial boolean NOT NULL DEFAULT false,
  available_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_demo_links (
  team_demo_id bigint NOT NULL REFERENCES team_demos(id) ON DELETE CASCADE,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  player_id text NOT NULL,
  PRIMARY KEY (team_demo_id, account_id)
);
```

`team_demo_links` 让同一份 canonical 只存一次，四个账号各自引用，避免 4 倍存储。

### 6.3 合并触发

- 参与者集合里的所有人类玩家都上传 → 立即合并；
- 等待超过 5 分钟仍缺人 → 用已上传的 parts 合并 `partial: true`，`availableFields` 标出覆盖到的战场；
- 一个 part 都没有 → 不创建 team demo；
- 合并失败 → 保留 parts 24 小时，后台重试；超过 24 小时清理。

### 6.4 客户端上传策略

- 结算 `finishDemo('result')` 后立即上传；
- 失败进入本地重试队列（IndexedDB），最多 5 次，指数退避；
- 页面关闭前 `sendBeacon` 或留到下次启动重试；
- 上传成功前本机 Demo 永远保留；
- 云端列表中出现 merged 后，不再重复显示同一局的个人版。

## 7. 时间轴对齐

四台机器的 `at` 不能直接比较。对齐步骤：

1. 每个 part 找 `m.public.serverNow` 作为锚点：
   `serverAt = anchor.serverNow + (frame.at - anchor.at)`；
2. 用最近的锚点（前后各 1 秒内优先），避免长时间漂移；
3. 没有 `serverNow` 的旧帧回退到 `part.startedAt + frame.at`，并标记 `clockQuality: 'low'`；
4. 同一条公共帧出现在四个 part 时，按 `t + 内容 hash + serverAt ± 100ms` 去重；
5. 每个 `fieldId` 的帧按 `serverAt` 排序，再换算回 canonical `at`；
6. 回放的时间轴以 canonical `at` 为准。

建议后续给 `b.start / b.end` 也加 `serverNow`（`clientCombat` 已经能拿到 `sched.now()`），可以进一步提高战场边界对齐精度。

## 8. 合并算法

### Step 1：解析与规范化

- 解压四个 part；
- 校验 `doc.matchId`、`playerId`、`players`；
- 统一字段：`at` 必须是非负数，`t` 必须是已知类型；
- 丢弃非回放帧（例如无用的 debug / 大字段）。

### Step 2：公共时间轴

- 合并 `m.public / m.result / m.ticker`；
- `m.field` 属于战场元数据，不放进公共时间轴，按 field 归属合并；
- `m.public` 去重后保留最早到达的一份；
- `m.result` 以 `settled:true` 的那份为准；
- `m.ticker` 全量保留（体积小，影响观感）。

### Step 3：战场归属

对每个 part：

- 从 `m.field` / `b.start` 的 `players` 或 `members` 找 `fieldId`；
- 如果 `part.playerId` 在该 field 的 players 中，则该 field 的 owner part = 这个 part；
- 否则该 part 对这个 field 的帧只是“观战副本”。

合并时：

- owner part 存在 → 只使用 owner 的 `m.field / b.start / b.snap / b.ev / b.end`；
- owner part 缺失 → 使用其他 part 里该 field 的观战副本，并标记该 field `degraded: true`；
- `m.field` 取 owner 最早一份，后续单位变化通过 `b.ev spawn` 补；
- `b.snap` 按 10 Hz 保留，不额外升频；
- `b.ev` 保留全部 `keepsState`（spawn / deploy / die / status / skill / leak 等），攻击动画事件按去重保留，超体积时优先丢攻击动画，不丢状态。

### Step 4：私有帧

- 只保留 `part.playerId` 自己的 `m.private`；
- 别的玩家 private 不进入 canonical 的 `privates[viewer]`；
- 服务端生成返回文档时，只附当前账号对应 `playerId` 的 private。

### Step 5：索引

为每个 field 生成：

```jsonc
{
  "snapTimes": [0, 100, 200, ...],
  "stateEvents": [ { "at": ..., "m": ... } ],
  "battleWindows": [ { "startAt": ..., "endAt": ... } ]
}
```

索引可以随 canonical 一起存，也可以由客户端首次加载时构建；建议服务端合并时构建，回放 seek 直接二分查找。

### Step 6：压缩与体积控制

- canonical 用 gzip（或 zstd，如果 Node 依赖允许）；
- 目标：gzip 后 ≤ 8 MB；
- 超出时按优先级降采样：
  1. 攻击动画 `b.ev` 降到 2 Hz 或只保留关键技能；
  2. `b.snap` 从 10 Hz 降到 5 Hz；
  3. 只保留每回合最近 1 张快照；
  4. 仍超出 → 只合并公共时间轴 + 每个玩家最近战场，标记 `partial`。
- 状态事件（spawn / die / status / leak）绝不降采样，否则会少单位或模型错。

## 9. 回放与视角切换

### 9.1 数据加载

`canReplayVisual(doc)` 增加：

```js
doc?.kind === 'team' && doc?.fields && doc?.public
```

`startDemoReplay` 分支：

- team 文档：公共帧 + `fields` + 当前查看者的 `private`；
- 单人文档：走现有 `wire` 路径，不回归。

### 9.2 视角列表

合成 DEMO room 的 `seats` 来自 `players`；HUD 的队友切换按钮读取：

```js
availableFields = Object.entries(doc.fields).map(([fieldId, f]) => ({
  fieldId, owner: f.owner, name: playerName(f.owner), available: true
}))
```

### 9.3 切换实现

在 `demoReplay` 的 `net.request` 拦截里处理 `g.watch`：

```js
if (type === 'g.watch') {
  const fieldId = fields?.fieldId;
  switchReplayField(session, fieldId);
  return Promise.resolve({ ok: true, replay: true });
}
```

`switchReplayField(s, fieldId)`：

1. 保持当前回放游标和暂停状态不变；
2. `battleRunner.clear()`；
3. 从 `field.frames` 取目标时刻之前最近一条 `m.field` 并 dispatch；
4. 重放该 field 到目标时刻为止的 `keepsState` 事件；
5. dispatch 目标时刻最近一张 `b.snap`；
6. 更新 `store.match.field` / `watch` 状态与 HUD；
7. 如果该 field 在目标时刻没有帧 → 按钮置灰或提示“该时刻没有录制到这个视角”，不切。

### 9.4 Seek

`seek` 已有 `latestSnap` / `stateEvents` 的按 field 重建逻辑，team 文档改为：

- 每个 field 独立收集；
- 最终只 dispatch 当前选中 field 的 `m.field + state + snap`；
- 其他 field 的帧保留在索引里，切换时按需重建；
- 暂停时切换视角仍然保持暂停，时钟 hold 不重置。

### 9.5 播放

正常播放时：

- 公共帧始终 dispatch；
- 当前选中 field 的帧按时间 dispatch；
- 切换视角时只重建目标 field，不影响公共时间轴；
- `b.start` 不重跑模拟，继续走 snapshot 模式。

## 10. 隐私与权限

- `team_demos` 的 canonical 只通过服务端过滤接口下发；
- 返回给账号 A 的文档：
  - `public`
  - `fields` 全部
  - `privates` 只含 A 的 playerId
  - 不含 B/C/D 的 `m.private`
- `team_demo_links` 只允许四个参与者账号读取；
- 观战者 / 非参与者默认不可见；
- 上传时必须校验 `player_links`，防止账号冒领别人的 playerId；
- part 原始文档 24 小时后删除，canonical 保留（受每账号 10 局限制）。

## 11. 存储与保留

| 项 | 规则 |
| --- | --- |
| 本机 Demo | 不限局数，保持现状 |
| 单机云端 Demo | 每账号最新 10 局，保持现状 |
| 合并 Demo | 每账号最新 10 局；同一 matchId 只算 1 局 |
| canonical | 一份，四个账号 link 引用 |
| parts | 合并后保留 24h 供重试/排查，之后删除 |
| 大小 | gzip 目标 ≤ 8 MB；超过则降采样 |
| 替换 | merged 生成后，四个账号的云端列表用 merged 替换该局个人版；本机个人版不动 |

## 12. 失败与降级

| 情况 | 行为 |
| --- | --- |
| 只有 1 人上传 | 不生成 team demo；个人版仍可看 |
| 2–3 人上传，超时 5 分钟 | 生成 `partial:true`，只提供已上传战场；UI 标注“部分视角” |
| 某 part 超 12 MB | 返回 `TOO_LARGE`，客户端降采样后重传；失败则 partial |
| 某 part 损坏 | 隔离该 part，用其余 part 合并 |
| 合并失败 | 保留 parts，后台重试 3 次；仍失败则保留个人版 |
| 客户端未登录 | 只落本机，不参与合并 |
| 旧版 Demo 无 matchId | 不参与合并，继续单机回放 |
| 切到无数据 field | 提示，不切换，不阻塞回放 |

## 13. 实施阶段

### Phase 0：对局标识（0.5–1 天）

- Match 实例带 `matchId`；
- `m.public.matchId`；
- recorder 文档记录 `matchId / playerId`；
- 单测：同一局四人文档 matchId 一致；旧文档不影响。

### Phase 1：上传与合并服务（2–3 天）

- `team_demo_parts / team_demos / team_demo_links` 建表；
- gzip 上传接口、状态接口、过滤下载接口；
- Merger：公共帧去重、field 归属、private 隔离、canonical 压缩；
- 幂等重传、超时 partial；
- 单测：2/3/4 份合并、缺 owner、时钟偏差、重复帧、体积。

### Phase 2：合并回放数据路径（1–2 天）

- `demoReplay` 识别 team 文档；
- 播放公共时间轴 + 当前 field；
- seek 按 field 重建；
- 不改变现有单人回放行为；
- 浏览器 e2e：合并文档能打开、能暂停、能 seek。

### Phase 3：视角切换（2–3 天）

- `g.watch` 在 DEMO 房间路由到 `switchReplayField`；
- HUD 显示四个玩家，可点击切换；
- 切到无帧时刻置灰/提示；
- 暂停中切换保持暂停；
- e2e：回合 2 / 1:12 切四个视角，单位坐标与各自快照一致；切回不丢时间轴。

### Phase 4：体积、隐私、稳定性（1–2 天）

- 降采样策略与压缩阈值；
- 过滤接口不泄露他人 private；
- 上传重试队列；
- partial / 失败降级；
- 安全测试：冒领 playerId、非参与者读取、超大文档。

### Phase 5：四人真实浏览器验收（1 天）

- 4 个 Chromium 客户端真实联机一局；
- 四人都上传后生成 merged；
- 每人云端看到同一局；
- 任意切换四个视角；
- 暂停、seek、回合边界、模型身份全部校验；
- 回归单人 Demo 805 测试 + typecheck。

## 14. 测试计划

### 合并单测

- 4 份同一 matchId → 1 份 canonical，4 个 links；
- 2 份缺失 → partial，availableFields 正确；
- 客户端时钟相差 ±2 秒 → serverAt 对齐后顺序正确；
- 公共帧重复 4 份 → 去重后 1 份；
- 同一 unit id 跨回合换模型 → 只保留 owner 帧，回放模型正确；
- private 隔离：A 的文档不含 B 的 m.private；
- 体积：4×8 MB 输入 → gzip + 降采样后 ≤ 8 MB；
- 旧文档没有 matchId → 不进入 team merge。

### 浏览器 e2e

- 4 人真局，回合 2 暂停在 `1:12`；
- 依次切 A/B/C/D；
- 每个视角的 `views` 坐标与对应 `b.snap` 一致；
- `defId / spine` 与各自 spawn 元数据一致；
- 暂停后切换，时间文字、右上角时钟、帧数都不变；
- 回到 A 视角，游标不跳；
- 非参与者账号 GET 返回 403/404。

### 回归

- `test/client-static.test.js + test/ui/demo-recorder.test.js` 805/805；
- `npm run typecheck`；
- 单人 Demo 录制 / seek / 暂停不回归；
- 云端单人版上传不被 team 接口影响。

## 15. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 四人上传不全 | 没有完整合并局 | partial + 超时；提示缺谁 |
| 文档体积过大 | 上传失败 / 浏览器卡顿 | gzip + 降采样 + 分字段存储 |
| 时钟偏差 | 切视角位置偏移 | serverNow 锚点；后续 b.start 带 serverNow |
| private 泄露 | 严重隐私问题 | 服务端过滤，绝不返回他人 private |
| 服务端存储增长 | 成本 | 一份 canonical + links；parts 24h 清理 |
| matchId 被伪造 | 数据污染 | player_links 校验 + 后续签名 token |
| 回放切视角复杂 | 暂停/seek 回归 | 复用现有 field 索引与 seek 逻辑，先做单 field 重建测试 |
| 旧 Demo 不兼容 | 用户困惑 | 旧文档继续单人路径，明确提示不支持合并 |

## 16. 待确认决策

1. 合并局是否替换该局的个人云端版，还是两者都保留？
2. 非参与者 / 观战者是否允许看合并 Demo？（默认否）
3. 上传鉴权 MVP 用 `player_links` 够不够，还是首版就加 match upload token？
4. canonical 存 PostgreSQL `bytea` 还是对象存储？按当前部署规模，首版 `bytea` 可接受。
5. 合并文档上限定 8 MB 还是 12 MB？
6. 缺人时等 5 分钟还是 2 分钟？
7. 视角切换是否允许“跳到他当前没有帧的空档”，还是只在有帧的时间点可切？

## 17. 验收标准

- 4 个已登录玩家完成一局，结算后 30 秒内四人云端出现同一份合并 Demo；
- 任意回合、任意已录制时间点，可切换到四个玩家视角；
- 每个视角的单位位置、血量、模型与对应录制快照一致；
- 暂停时切换视角，时间轴、倒计时、战斗帧全部冻结；
- 返回自己视角后进度不跳；
- 他人 `m.private` 不出现在响应中；
- 缺一人上传时能在超时后生成 partial，并明确标注；
- 单人 Demo 805 测试与 typecheck 不回归。

## 18. 里程碑建议

| 里程碑 | 内容 | 可验收结果 |
| --- | --- | --- |
| M1 | matchId + parts 上传 + 合并服务 | 四人上传后能生成 canonical，四人可下载 |
| M2 | 合并文档回放 | 能播放、暂停、seek，先只看自己视角 |
| M3 | 视角切换 | HUD 可切四个队友，位置/模型正确 |
| M4 | 体积与隐私加固 | gzip、partial、private 隔离、重试 |
| M5 | 四人真实浏览器验收 | 完整 e2e，可发布 |

## 19. 实施进度（2026-11-16）

### 已完成

- **Phase 0 对局标识**：`server/lobby.js` 为每局生成 `m_<room>_<matchNo>_<seed>`，经 `Match` / match host 写入 `m.public.matchId`；测试 / 旧对局不带该键，帧保持原样。
- **Demo 录制元数据**：`demoRecorder` 文档记录 `matchId / playerId / isTeam`（至少 2 名真人且服务器给了 matchId 才标记联机）。
- **服务端存储**：`team_demo_parts / team_demos / team_demo_links` 三张表（`server/accounts/db.js`），part 以 gzip JSON 存 `bytea`，canonical 一份 + 四账号 link。
- **纯合并器**：`server/accounts/teamDemos.js`：`m.public.serverNow` 锚定时间、公共帧去重、按 field owner 选帧（观战副本仅降级兜底）、private 按 playerId 隔离；不重跑战斗。
- **上传 / 状态 / 列表 / 下载 API**：`POST /api/team-demos/:matchId/parts`、`GET /api/team-demos/:matchId/status`、`GET /api/team-demos`、`GET /api/team-demos/:id`（按登录账号过滤 private）。
- **客户端**：四人局 `uploadDemo` 自动走 part 接口；云端 Demo 面板增加「联机合并 Demo」列表；`demoReplay` 能把 team canonical 转成单 field wire，并拦截 `g.watch` 在暂停/播放中切 field，保持游标和暂停状态。

### 尚未完成 / 待确认

- 真实 PostgreSQL 集成测试（上传 → 四人到齐 → canonical → 四账号下载）尚未在本机跑；纯合并器和回放转换已有单测。
- 缺人超时自动 `partial`、8 MB 体积降采样、上传失败重试队列尚未实现（当前缺人时 status 报告 waitingFor，不自动生成 partial）。
- 4 人真实 Chromium e2e、非参与者 403 验证尚未跑。
- §16 的决策目前按文档默认执行：merged 替换个人云版、非参与者不可见、`player_links` 鉴权、canonical 存 PostgreSQL、目标 8 MB、缺人等待 5 分钟；如用户选择不同，再调整。
