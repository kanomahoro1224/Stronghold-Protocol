# 名字/聊天屏蔽词后端（Sensitive-lexicon）

本目录提供 `server/nameModeration.js` 的 **lexicon** 模式所需的本地词库服务。启用后，
昵称与局内聊天正文在服务端转发前都会先过一遍词库，命中即拒绝（昵称提示“该名称不可用”，
聊天提示“该内容不可用”）。完整行为与故障边界见 `docs/NAME_MODERATION.md`。

## 为什么不用上游的 Go 服务

上游 `konsheng/Sensitive-lexicon` 在本仓库钉住的提交 `b05a333e0747d39c86bc2375a8af7b5b24c4fa08`
是一个 Go(Fiber) 服务，官方部署方式是 Docker。2026-10-14 三台生产机**都没有 docker、Go 或 pip**，
所以这里用 `lexicon_server.py`（只用 Python 标准库，无第三方依赖）实现**同一 HTTP 契约**，
词表仍使用上述提交的 `Vocabulary/`（16 个 txt、87 022 条）。

行为对齐上游 `internal/lexicon/store.go` 与 `internal/detect/service.go`：

| 项目 | 上游 Go | 本实现 |
|---|---|---|
| 词表加载 | 递归读 `*.txt`，逐行 `TrimSpace`，跳过空行与 `#` 注释 | 相同 |
| 判定 | 大小写不敏感的子串匹配（`HasAnyInText`），从输入首个字符位置往后扫描 | 相同 |
| `GET /health` | `{"status":"ok"}` | `{"status":"ok","count":N}` |
| `POST /contains` | `{"contains":bool,"word":"命中词"}`，未命中不带 `word` | 相同 |
| `POST /reload` | 重新加载词表 | 相同 |

若以后改用上游 Go 二进制或 Docker 部署，只要保持 `127.0.0.1:8080` 与上面的契约，
`SP_NAME_MODERATION_URL` 不需要改。

## 安装（在目标机上执行）

```sh
sudo bash install-lexicon.sh            # 默认装到 /opt/sensitive-lexicon
```

脚本会克隆钉住的提交、装 `sensitive-lexicon.service`（`User=nobody`、只监听 `127.0.0.1:8080`、
`ProtectSystem=strict`、`MemoryMax=256M`）、启动并自检：普通昵称放行 + 从词表取一条真实词条应当命中。

## 启用（改游戏服务环境变量并重启）

```ini
# /etc/systemd/system/stronghold.service.d/20-name-moderation.conf
[Service]
Environment=SP_NAME_MODERATION=lexicon
Environment=SP_NAME_MODERATION_URL=http://127.0.0.1:8080
```

```sh
sudo systemctl daemon-reload && sudo systemctl restart stronghold
```

只用 `lexicon` 时**不需要** `TYPESAFE_API_KEY`。想同时用 TypeSafe Jev 时把模式改成 `both`
并加上 `TYPESAFE_API_KEY`（`both` 缺少任一配置会启动失败，避免以为双重审核已生效）。

## 验证

```sh
curl -s http://127.0.0.1:8080/health
curl -s -X POST http://127.0.0.1:8080/contains -H 'Content-Type: application/json' -d '{"text":"夜莺"}'
# 游戏服务的兼容预审接口（无审核器时对任何名字都返回 allowed:true）
curl -s -X POST http://127.0.0.1:3000/api/name-moderation -H 'Content-Type: application/json' -d '{"name":"夜莺"}'
node --test test/name-moderation.test.js
```

## 回退

```sh
sudo rm /etc/systemd/system/stronghold.service.d/20-name-moderation.conf
sudo systemctl daemon-reload && sudo systemctl restart stronghold   # 回到不审核
sudo systemctl disable --now sensitive-lexicon.service              # 需要时再停词库服务
```

## 注意

- 词库接口**无鉴权**，只能监听回环或受控内网；不要把 `/reload` 暴露到公网。
- 词库是**子串匹配**的词表，游戏用词、真实人名都可能误报，需按运营规则审查词表内容
  （`Vocabulary/` 里含政治、色情、暴恐等名单，范围可能超出预期）。
- 审核服务故障、超时、限流或预算耗尽时**静默放行**（fail-open），这是为可用性做的取舍。
- 昵称与聊天正文会发送到词库服务，运营者应在隐私说明中告知玩家；服务端日志不记录昵称、
  正文、地址、令牌或命中词。
