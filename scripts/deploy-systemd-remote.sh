#!/usr/bin/env bash
# systemd 部署的"落地"步骤：在目标机上校验、备份、解包、自检，失败自动回滚。
#
# 由 scripts/deploy-systemd.mjs 上传后调用；也可单独手工使用（先自己把包放进 SP_DEPLOY_DIR）。
#
# 环境变量：
#   SP_DEPLOY_DIR  包所在目录，默认 /tmp/sp-deploy（内有 repo.tar、build.tar、deploy.sha256）
#   SP_REMOTE_DIR  部署根目录，默认 /opt/stronghold
#   SP_SERVICE     systemd 服务名，默认 stronghold
#   SP_RESTART     置 1 才在自检通过后重启服务（纯前端改动不必重启）
#   SP_HEALTH      健康检查地址，默认 http://127.0.0.1:3000/healthz
#   SP_PORT        本地 HTTP 自检端口，默认从 SP_HEALTH 解析，失败时用 3000
#
# 约定（与仓库一致）：
#   - 永不覆盖 config/announcements.json；
#   - 不删除 public/build 旧分包（emptyOutDir:false 的在线更新方式）；
#   - 任何一步失败都不留下半套前端：解包或自检失败即从本次备份还原 public/build。
set -uo pipefail

DEPLOY_DIR="${SP_DEPLOY_DIR:-/tmp/sp-deploy}"
REMOTE_DIR="${SP_REMOTE_DIR:-/opt/stronghold}"
SERVICE="${SP_SERVICE:-stronghold}"
RESTART="${SP_RESTART:-0}"
HEALTH="${SP_HEALTH:-http://127.0.0.1:3000/healthz}"
BASE="${HEALTH%/healthz}"

cd "$REMOTE_DIR" || { echo "  ✗ 进不去 $REMOTE_DIR"; exit 1; }
ts=$(date +%Y%m%d-%H%M%S)
backup="/root/stronghold-static-$ts.tar.gz"
fail=0

echo "[0/6] 校验上传的包（sha256 + tar 完整性）"
if ! sha256sum -c "$DEPLOY_DIR/deploy.sha256"; then
  echo "      ✗ 哈希不符：包在传输中损坏。未做任何改动，线上保持原样"; exit 1
fi
for f in "$DEPLOY_DIR/repo.tar" "$DEPLOY_DIR/build.tar"; do
  # repo.tar/build.tar 都是未压缩 tar；两种都接受，避免 -z 误判
  if ! tar -tf "$f" > /dev/null 2>&1 && ! tar -tzf "$f" > /dev/null 2>&1; then
    echo "      ✗ $f 不是完整 tar。未做任何改动，线上保持原样"; exit 1
  fi
done
echo "      ✓ 两个包完整且哈希一致"

echo "[1/6] 备份（源码 + 前端构建，排除 node_modules/public/assets/state）"
tar -czf "$backup" --exclude=./node_modules --exclude=./public/assets --exclude=./state . || exit 1
echo "      $backup  $(du -h "$backup" | cut -f1)"

echo "[2/6] 覆盖源码（排除 config/announcements.json，保留线上公告）"
tar -xf "$DEPLOY_DIR/repo.tar" --exclude='config/announcements.json' || { echo "      ✗ 源码解包失败"; exit 1; }
echo "      version: $(grep -m1 '"version"' package.json)"

echo "[3/6] 覆盖前端构建"
tar -xf "$DEPLOY_DIR/build.tar" -C public || {
  echo "      ✗ 构建解包失败 —— 回滚 public/build"; tar -xzf "$backup" ./public/build; exit 1; }

echo "[4/6] 自检：构建 HTML 的引用与入口分包必须存在且 HTTP 200"
entry=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' public/build/index.html | head -1)
refs=$(grep -oE '(src|href)="[^"]*/build/[^"]+"' public/build/index.html | sed -E 's/.*="([^"]*)"/\1/' | sort -u)
imps=$(grep -oE '\./[A-Za-z0-9_.-]+\.js' "public/build/$entry" | sed 's|^\./||' | sort -u)
for u in $refs; do [ -s "public$u" ] || { echo "      ✗ 磁盘缺文件 public$u"; fail=$((fail+1)); }; done
for f in $imps; do [ -s "public/build/assets/$f" ] || { echo "      ✗ 磁盘缺分包 assets/$f"; fail=$((fail+1)); }; done
if command -v curl > /dev/null 2>&1; then
  for u in $refs; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$BASE$u")" = 200 ] || { echo "      ✗ HTTP 非 200: $u"; fail=$((fail+1)); }
  done
  for f in $imps; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$BASE/build/assets/$f")" = 200 ] || { echo "      ✗ HTTP 非 200: /build/assets/$f"; fail=$((fail+1)); }
  done
else
  echo "      ! 目标机没有 curl，跳过 HTTP 自检（磁盘检查已通过）"
fi
if [ "$fail" != 0 ]; then
  echo "      ✗ 自检失败 $fail 项 —— 回滚 public/build"
  tar -xzf "$backup" ./public/build
  echo "      回滚后入口: $(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' public/build/index.html | head -1)"
  exit 1
fi
echo "      ✓ 入口 $entry：$(echo "$refs" | wc -l) 个引用 + $(echo "$imps" | wc -l) 个分包，磁盘与 HTTP 全部通过"

if [ "$RESTART" = 1 ]; then
  echo "[5/6] 重启 $SERVICE（会结束进行中的对局）"
  systemctl restart "$SERVICE" || { echo "      ✗ 重启失败"; exit 1; }
  ok=0
  for _ in $(seq 1 30); do
    if curl -s -m 5 "$HEALTH" | grep -q '"ok":true'; then ok=1; break; fi
    sleep 2
  done
  if [ "$ok" != 1 ]; then
    echo "      ✗ 健康检查未通过 —— 回滚源码与前端并重启"
    tar -xzf "$backup" ./public ./server ./shared ./config/announcements.json 2>/dev/null
    systemctl restart "$SERVICE"
    exit 1
  fi
  echo "      ✓ 健康检查通过"
else
  echo "[5/6] 不重启服务（纯前端改动刷新页面即可）"
fi

echo "[6/6] 完成"
echo "      systemd: $(systemctl is-active "$SERVICE")"
echo "      /healthz: $(curl -s -m 6 "$HEALTH" | head -c 110)"
echo "      入口: $entry"
echo "      备份: $backup"
