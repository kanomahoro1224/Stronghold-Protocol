#!/usr/bin/env bash
# 卫戍协议：盟约 · 本分支的生产机更新脚本（在目标机上运行）
#
#   bash deploy-remote.sh <payload.tar.gz>                 # 预演：只列变更，不写任何文件
#   bash deploy-remote.sh <payload.tar.gz> --apply         # 备份 → 同步 → 重启 → 健康门（失败自动回滚）
#   bash deploy-remote.sh --rollback <backup-dir>          # 手动回滚到某次备份
#
# 载荷由 scripts/deploy-push.ps1 生成，含 server/ shared/ public/（不含 public/assets）与两个 package 文件。
#
# 三条来自实际事故的硬规则（2026-10-14）：
#   1. rsync 排除模式必须以 `/` 锚定。`--exclude 'assets/'` 会匹配**任意层级**的 assets 目录，把
#      public/build/assets 一起排除，于是新 index.html 引用的分包在源站不存在、页面 JS/CSS 全 404。
#      public/assets 是 900 MB 的素材树，保留目标机现状，绝不覆盖、绝不删除。
#   2. 永远不带 --delete：旧哈希分包是**已经打开的页面**仍在请求的文件，删掉它们会让在线玩家白屏。
#   3. 忙机重启前先预热 .cache/asset-hashes.json。首次 0.2.6 启动要在 900 MB 素材上算 SHA-256，
#      160 上同时叠加 900 局恢复与 1000 人重连，两个 vCPU 被占满约 5 分钟，nginx 报 110/104。
#      预热把这段开销挪到旧进程仍在服务的时候。
#
# 不碰 config/（线上公告排期）与 data/（含 data/skins-installed.json）——载荷里本来就没有它们。
set -euo pipefail

APP="${SP_APP_DIR:-/opt/stronghold}"
SERVICE="${SP_SERVICE:-stronghold}"
PORT="${SP_PORT:-3000}"
KEEP_BACKUPS="${SP_KEEP_BACKUPS:-5}"

die() { echo "!! $*" >&2; exit 1; }
say() { echo "== $*"; }

# ---------------------------------------------------------------- 回滚模式
if [ "${1:-}" = "--rollback" ]; then
  BK="${2:?usage: deploy-remote.sh --rollback <backup-dir>}"
  TAR="$BK/code-before.tar.gz"
  [ -f "$TAR" ] || die "备份不存在：$TAR"
  say "回滚 $TAR → $APP"
  tar xzf "$TAR" -C "$APP"
  systemctl restart "$SERVICE"
  sleep 8
  curl -s --max-time 10 "http://127.0.0.1:$PORT/healthz"; echo
  echo "回滚完成：$(cat "$BK/health-before.json" 2>/dev/null | head -c 200)"
  exit 0
fi

PAYLOAD="${1:?usage: deploy-remote.sh <payload.tar.gz> [--apply] [--prewarm]}"
shift
APPLY=""; PREWARM=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --prewarm) PREWARM=1 ;;
    *) die "未知参数：$arg" ;;
  esac
done

[ -f "$PAYLOAD" ] || die "载荷不存在：$PAYLOAD"
[ -f "$APP/package.json" ] || die "$APP 不是本项目的部署目录（缺 package.json）"

TS=$(date +%Y%m%d-%H%M%S)
STAGE="/opt/.stage-$TS"
BACKUP="/opt/.deploy-backup-$TS"
say "载荷 $(du -h "$PAYLOAD" | cut -f1)  sha256=$(sha256sum "$PAYLOAD" | cut -d' ' -f1)"
mkdir -p "$STAGE"
tar xzf "$PAYLOAD" -C "$STAGE"
[ -f "$STAGE/package.json" ] || die "载荷里没有 package.json"
[ -f "$STAGE/public/build/index.html" ] || die "载荷里没有 public/build/index.html（先在本地 npm run build）"
PAYLOAD_VERSION=$(grep -m1 '"version"' "$STAGE/package.json" | sed 's/[^0-9.]//g')
echo "   载荷版本 $PAYLOAD_VERSION"

# ------------------------------------------------------- 同步哪些、怎么同步
# 排除模式一律以 / 锚定到传输根：'/assets/' 只排 public/assets，不碰 public/build/assets。
sync_tree() {
  rsync -a "$STAGE/server/" "$APP/server/"
  rsync -a "$STAGE/shared/" "$APP/shared/"
  rsync -a --exclude '/assets/' "$STAGE/public/" "$APP/public/"
  cp -p "$STAGE/package.json" "$STAGE/package-lock.json" "$APP/"
}

# 载荷里 index.html 引用的每个 /build/assets/* 都必须真的落到磁盘上。这条检查就是 2026-10-14 那次
# 事故的回归测试：当时同步漏掉整个 public/build/assets，页面 CSS/JS 全 404，站点形同宕机。
check_build_assets() {
  local html="$APP/public/build/index.html" missing=0 total=0 f
  [ -f "$html" ] || { echo "   源模式（没有 public/build/index.html），跳过"; return 0; }
  for f in $(grep -oE '/build/assets/[A-Za-z0-9._~-]+' "$html" | sed 's#/build/assets/##' | sort -u); do
    total=$((total + 1))
    if [ ! -f "$APP/public/build/assets/$f" ]; then echo "   缺失：$f"; missing=$((missing + 1)); fi
  done
  echo "   引用 $total 个分包，缺失 $missing"
  [ "$missing" -eq 0 ] || return 1
}

health_gate() {
  local before_build="${1:-}" tries=30 i body code
  for i in $(seq 1 "$tries"); do
    code=$(curl -s -o /tmp/sp-h.json -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/healthz" || true)
    [ "$code" = "200" ] && break
    sleep 2
  done
  [ "$code" = "200" ] || { echo "   /healthz 未在 $((tries * 2))s 内返回 200（最后一次 $code）"; return 1; }
  python3 - "$PAYLOAD_VERSION" "$before_build" <<'PY'
import json, sys
want, before = sys.argv[1], sys.argv[2]
d = json.load(open('/tmp/sp-h.json'))
print('   app=%s build=%s uptime=%ss sockets=%s rooms=%s matches=%s humans=%s'
      % (d.get('app'), d.get('build'), d.get('uptimeSec'), d.get('sockets'), d.get('rooms'), d.get('matches'), d.get('humans')))
if not d.get('ok'):
    sys.exit('healthz.ok 不是 true')
if want and str(d.get('app')) != want:
    sys.exit('版本不符：期望 %s，实际 %s' % (want, d.get('app')))
if before and d.get('build') == before:
    print('   注意：build 标识与重启前相同（%s）——若确实改了浏览器运行时，说明同步没生效' % before)
PY
  # 页面与它引用的分包、运行时配置
  local base="http://127.0.0.1:$PORT" f bad=0
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base/")" = "200" ] || { echo "   / 不是 200"; bad=1; }
  for f in $(grep -oE '/build/assets/[A-Za-z0-9._~-]+' "$APP/public/build/index.html" 2>/dev/null | sort -u | head -20); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base$f")" = "200" ] || { echo "   $f 不是 200"; bad=1; }
  done
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base/js/asset-cdn.js")" = "200" ] || { echo "   /js/asset-cdn.js 不是 200"; bad=1; }
  [ "$bad" -eq 0 ] || return 1
  # 配了素材 CDN 时，服务端清单不该再带内容哈希段：CDN 镜像的是 public/assets 的原始布局。
  if grep -q 'SP_ASSETS_CDN=' /proc/"$(pgrep -f 'node server/index.js' | head -1)"/environ 2>/dev/null; then
    if curl -s --max-time 20 "$base/data/local-assets.json" | grep -qE '~[0-9a-f]{16}'; then
      echo "   警告：/data/local-assets.json 仍带 ~<hash> 段；若 CDN 没有剥离该段的规则，本地素材会 404"
    fi
  fi
  return 0
}

# ------------------------------------------------------------------- 预演
if [ -z "$APPLY" ]; then
  say "预演（不写任何文件）"
  for d in server shared; do
    n=$(rsync -ain "$STAGE/$d/" "$APP/$d/" | grep -c '^[<>ch]' || true)
    echo "   $d: $n 项将变化"
    rsync -ain "$STAGE/$d/" "$APP/$d/" | grep '^[<>ch]' | head -6 | sed 's/^/     /' || true
  done
  n=$(rsync -ain --exclude '/assets/' "$STAGE/public/" "$APP/public/" | grep -c '^[<>ch]' || true)
  echo "   public（排除 public/assets）: $n 项将变化"
  rsync -ain --exclude '/assets/' "$STAGE/public/" "$APP/public/" | grep '^[<>ch]' | head -10 | sed 's/^/     /' || true
  echo "   public/build/assets 将新增/更新 $(rsync -ain "$STAGE/public/build/assets/" "$APP/public/build/assets/" | grep -c '^[<>ch]' || true) 个文件"

  # 预演阶段就核对新 index.html 的每个分包引用：目标机缺、而载荷里有 ⇒ 本次同步会补上；
  # 载荷里也缺 ⇒ 本地构建不完整，必须先重新构建。2026-10-14 的事故就发生在这一步。
  say "分包引用核对"
  payload_missing=0
  for f in $(grep -oE '/build/assets/[A-Za-z0-9._~-]+' "$STAGE/public/build/index.html" | sed 's#/build/assets/##' | sort -u); do
    if [ ! -f "$APP/public/build/assets/$f" ]; then
      if [ -f "$STAGE/public/build/assets/$f" ]; then echo "     本次同步会补上：$f"
      else echo "     载荷里也缺（本地构建不完整）：$f"; payload_missing=$((payload_missing + 1)); fi
    fi
  done
  [ "$payload_missing" -eq 0 ] || echo "     !! 载荷缺 $payload_missing 个被引用的分包，先重新 npm run build"
  echo "预演结束；加 --apply 执行"
  exit 0
fi

# ------------------------------------------------------------------- 应用
BEFORE_BUILD=$(curl -s --max-time 8 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("build",""))' 2>/dev/null || true)
echo "   重启前 build=$BEFORE_BUILD"

say "备份 → $BACKUP"
mkdir -p "$BACKUP"
curl -s --max-time 8 "http://127.0.0.1:$PORT/healthz" > "$BACKUP/health-before.json" 2>/dev/null || true
tar czf "$BACKUP/code-before.tar.gz" -C "$APP" \
  server shared public/js public/css public/i18n public/fonts public/icons public/img public/dev public/vendor \
  public/build public/index.html public/manifest.json public/resource-sw.js package.json package-lock.json
echo "   备份 $(du -h "$BACKUP/code-before.tar.gz" | cut -f1)"

if [ -n "$PREWARM" ]; then
  say "预热内容哈希缓存（用新代码算，旧进程仍在服务）"
  cat > /tmp/sp-prewarm.mjs <<EOF
import { createAssetIndex } from '$STAGE/server/http/assetIndex.js';
const idx = createAssetIndex({
  publicDir: '$APP/public',
  cacheFile: '$APP/.cache/asset-hashes.json',
  log: { info: () => {}, warn: (m) => console.error(m), debug: () => {} },
});
idx.start();
const t0 = Date.now();
while (!idx.ready) await new Promise((r) => setTimeout(r, 500));
console.log('   索引就绪 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's，files=' + idx.size);
idx.close();
EOF
  node /tmp/sp-prewarm.mjs || echo "   预热失败（不致命），重启后由服务自己算"
fi

say "同步"
sync_tree

say "完整性校验：index.html 引用的分包是否都在磁盘上"
check_build_assets || {
  echo "!! 分包缺失 —— 页面会 404。已同步的文件保持现状，未重启；修好载荷后重跑。"
  exit 2
}

say "重启 $SERVICE"
systemctl restart "$SERVICE"

say "健康门"
if health_gate "$BEFORE_BUILD"; then
  echo "== 完成：$APP 已是 $PAYLOAD_VERSION（备份 $BACKUP）"
else
  echo "!! 健康门未通过，自动回滚"
  tar xzf "$BACKUP/code-before.tar.gz" -C "$APP"
  systemctl restart "$SERVICE"
  sleep 8
  curl -s --max-time 10 "http://127.0.0.1:$PORT/healthz"; echo
  echo "!! 已回滚到重启前状态；备份保留在 $BACKUP"
  exit 3
fi

# 只留最近几次备份
ls -1d /opt/.deploy-backup-* 2>/dev/null | sort | head -n "-$KEEP_BACKUPS" | xargs -r rm -rf
rm -rf "$STAGE"
