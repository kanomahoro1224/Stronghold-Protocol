#!/usr/bin/env bash
# 卫戍协议：盟约 · 本分支的生产机更新脚本（在目标机上运行）
#
#   bash deploy-remote.sh <payload.tar.gz>                 # 预演：只列变更，不写任何文件
#   bash deploy-remote.sh <payload.tar.gz> --apply         # 备份 → 同步 → 重启 → 健康门（失败自动回滚）
#   bash deploy-remote.sh <payload.tar.gz> --apply --no-restart
#                                                          # 备份 → 同步 → 校验（不重启）；见下方「不重启模式」
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
# 「不重启模式」（--apply --no-restart，2026-10-15 加）：只适用于**纯前端**载荷（server/ 无改动）。
#   Node 静态服务按请求读盘（server/http/static.js：JS/CSS 用 size+mtime 做 ETag，i18n 语言 JSON
#   从不缓存），构建分包又都是新哈希 URL，所以同步完不必重启，下一次页面请求就是新代码。
#   代价与前提：
#     * 进程内的 build 标识（computeBuildTag() 在启动时算）不会变，buildGuard 不触发自动刷新，
#       在线玩家要手动刷新一次；发布顺序仍是「先同步新分包、再切 index.html」，旧分包永不删。
#     * 本模式仍备份、仍做分包完整性校验与页面/分包/语言包 HTTP 校验；失败不自动回滚
#       （进程没重启，回滚文件即可：tar xzf <备份>/code-before.tar.gz -C /opt/stronghold）。
#     * 载荷里有 server/ 改动时不要用本模式：新代码不会生效，要等下次重启。
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

PAYLOAD="${1:?usage: deploy-remote.sh <payload.tar.gz> [--apply] [--prewarm] [--no-restart]}"
shift
APPLY=""; PREWARM=""; NORESTART=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --prewarm) PREWARM=1 ;;
    --no-restart) NORESTART=1 ;;
    *) die "未知参数：$arg" ;;
  esac
done
[ -z "$NORESTART" ] || [ -n "$APPLY" ] || die "--no-restart 只与 --apply 一起用（预演本来就不写盘、不重启）"

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
# --checksum：内容相同就不动目标文件，于是 mtime 保持原样。computeBuildTag() 用 size+mtime 计算
# 浏览器运行时的构建标识，普通 rsync 会把 mtime 更新成开发机的值，导致客户端代码其实没变、
# 却让所有在线页面判定为过期并刷新（2026-10-14 实测：只改了 server/index.js，build 标识照样变了）。
sync_tree() {
  rsync -a --checksum "$STAGE/server/" "$APP/server/"
  rsync -a --checksum "$STAGE/shared/" "$APP/shared/"
  rsync -a --checksum --exclude '/assets/' "$STAGE/public/" "$APP/public/"
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
  python3 - "$PAYLOAD_VERSION" "$before_build" "${NORESTART:-0}" <<'PY'
import json, sys
want, before, norestart = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
d = json.load(open('/tmp/sp-h.json'))
print('   app=%s build=%s uptime=%ss sockets=%s rooms=%s matches=%s humans=%s'
      % (d.get('app'), d.get('build'), d.get('uptimeSec'), d.get('sockets'), d.get('rooms'), d.get('matches'), d.get('humans')))
if not d.get('ok'):
    sys.exit('healthz.ok 不是 true')
if want and str(d.get('app')) != want:
    sys.exit('版本不符：期望 %s，实际 %s' % (want, d.get('app')))
if before and d.get('build') == before:
    if norestart:
        print('   不重启模式：build 标识与同步前相同（%s）属预期；新前端以分包与语言包的 HTTP 实测为准' % before)
    else:
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

# 语言包验收：源站必须已经是载荷里的那份（i18n JSON 从不缓存，按请求读盘）。
# 配了素材 CDN 时线上客户端读的是 CDN 的 /i18n/，CDN 是否已更新只警告、不致命
# （CDN 可能回源+缓存，也可能要单独上传，见 AGENTS.md「运行时 CDN 配置」）。
# 比的是键数量而不是字节：服务端可能对出站 JSON 做路径改写，键数不受影响。
keys_of() { python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))))' "$1" 2>/dev/null || echo 0; }

verify_i18n() {
  local base="http://127.0.0.1:$PORT" cdn lang want got tmp bad=0
  for lang in en ja ko zh-TW; do
    [ -f "$STAGE/public/i18n/$lang.json" ] || continue
    want=$(keys_of "$STAGE/public/i18n/$lang.json")
    tmp="/tmp/sp-i18n-$lang.json"
    curl -s --max-time 20 "$base/i18n/$lang.json" -o "$tmp" || true
    got=$(keys_of "$tmp")
    if [ "$want" = "$got" ]; then echo "   源站 /i18n/$lang.json = 载荷（$want 条）"
    else echo "   !! 源站 /i18n/$lang.json 是 $got 条、载荷 $want 条（同步或缓存问题，玩家会拿到旧文案）"; bad=1; fi
  done
  cdn=$(curl -s --max-time 10 "$base/js/asset-cdn.js" | sed -n 's/.*ASSETS_CDN *= *"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$cdn" ]; then
    echo "   未配置素材 CDN，语言包只走源站"
  else
    for lang in en ja ko zh-TW; do
      [ -f "$STAGE/public/i18n/$lang.json" ] || continue
      want=$(keys_of "$STAGE/public/i18n/$lang.json")
      tmp="/tmp/sp-cdn-$lang.json"
      curl -s --max-time 20 "$cdn/i18n/$lang.json" -o "$tmp" || true
      got=$(keys_of "$tmp")
      if [ "$want" = "$got" ]; then echo "   CDN /i18n/$lang.json = 载荷（$want 条）"
      else echo "   警告：CDN /i18n/$lang.json 是 $got 条、载荷 $want 条；客户端读的是 CDN，需要清缓存或单独上传"; fi
    done
  fi
  [ "$bad" -eq 0 ] || return 1
  return 0
}

# ------------------------------------------------------------------- 预演
if [ -z "$APPLY" ]; then
  say "预演（不写任何文件）"
  for d in server shared; do
    n=$(rsync -ain --checksum "$STAGE/$d/" "$APP/$d/" | grep -c '^[<>ch]' || true)
    echo "   $d: $n 项将变化"
    rsync -ain --checksum "$STAGE/$d/" "$APP/$d/" | grep '^[<>ch]' | head -6 | sed 's/^/     /' || true
  done
  n=$(rsync -ain --checksum --exclude '/assets/' "$STAGE/public/" "$APP/public/" | grep -c '^[<>ch]' || true)
  echo "   public（排除 public/assets）: $n 项将变化"
  rsync -ain --checksum --exclude '/assets/' "$STAGE/public/" "$APP/public/" | grep '^[<>ch]' | head -10 | sed 's/^/     /' || true
  echo "   public/build/assets 将新增/更新 $(rsync -ain --checksum "$STAGE/public/build/assets/" "$APP/public/build/assets/" | grep -c '^[<>ch]' || true) 个文件"

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

if [ -n "$PREWARM" ] && [ -z "$NORESTART" ]; then
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

if [ -n "$NORESTART" ]; then
  say "不重启模式：跳过 systemctl restart（静态文件按请求读盘，新分包是新哈希 URL）"
  say "校验（不重启）"
  if health_gate "$BEFORE_BUILD" && verify_i18n; then
    echo "== 完成（未重启）：$APP 已同步 $PAYLOAD_VERSION（备份 $BACKUP）"
    echo "   提示：进程内 build 标识未变，在线页面不会自动刷新，需手动刷新一次。"
  else
    echo "!! 校验未通过；进程未重启、仍在跑旧代码。"
    echo "   回滚文件：tar xzf $BACKUP/code-before.tar.gz -C $APP"
    exit 3
  fi
else
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
fi

# 只留最近几次备份
ls -1d /opt/.deploy-backup-* 2>/dev/null | sort | head -n "-$KEEP_BACKUPS" | xargs -r rm -rf
rm -rf "$STAGE"
