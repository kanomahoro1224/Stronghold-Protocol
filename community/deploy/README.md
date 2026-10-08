# community 的线上部署（45.207.220.214）

`game.xiaolubao.com` 服务本站（社区站），游戏本体搬到 `hk.xiaolubao.com`。下面四个文件就是线上的那一份，改完照抄即可。

| 文件 | 线上位置 |
| --- | --- |
| `nginx-game.conf` | `/etc/nginx/conf.d/game.xiaolubao.com.conf`（社区反代 + `resource-sw.js` 注销桩） |
| `nginx-hk.conf` | `/etc/nginx/conf.d/hk.xiaolubao.com.conf`（游戏原样搬家，含 R2 302 与 `/ws`） |
| `stronghold-community.service` | `/etc/systemd/system/stronghold-community.service` |
| `deploy.sh` | 在目标机上一次性执行：读 `/tmp/community-app.tgz`（应用）与 `/tmp/community.db`（库） |

三个 `map`（WebSocket upgrade、R2 分隔符、Origin 变体）只在 `nginx-hk.conf` 里定义**一次** —— nginx 不允许重名 map，别在另一份里重复。

## 三条硬规矩

1. **库只在不存在时放置**。`deploy.sh` 绝不覆盖已存在的 `data/community.db`；要换库请自己先停服、换文件、再起。
2. **迁开发机的库之前先合并 WAL**：`node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('<path>/community.db');d.exec('PRAGMA wal_checkpoint(TRUNCATE)')"`
   —— 否则 WAL 里未落盘的写入会静默丢掉。
3. **验收用 `--resolve`，不要用 `-H 'Host: …'`**：SNI 会是 `127.0.0.1`、HTTP/2 的 `:authority` 也不跟随 `-H Host`，会验成默认 server。

证书是 `*.xiaolubao.com` 通配（`/etc/nginx/ssl/xiaolubao/`），两个域名共用，本机没有 certbot 也不需要。
