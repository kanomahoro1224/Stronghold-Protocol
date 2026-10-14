#!/usr/bin/env bash
# 在目标机安装词库服务（供 server/nameModeration.js 的 lexicon 模式调用）。
#
#   bash install-lexicon.sh [--dir /opt/sensitive-lexicon]
#
# 做四件事：按钉住的提交拉词表 → 装 lexicon_server.py 与 systemd 单元 → 启动 → 自检。
# 词表数据来自上游 konsheng/Sensitive-lexicon，服务实现是本目录的零依赖 Python 文件
# （原因见 README.md）。可重复执行；已在跑的服务会在重装后重启。
set -euo pipefail

PIN=b05a333e0747d39c86bc2375a8af7b5b24c4fa08
DIR=/opt/sensitive-lexicon
UNIT=/etc/systemd/system/sensitive-lexicon.service
SRC=$(cd "$(dirname "$0")" && pwd)

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR=$2; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null || { echo "缺少 python3" >&2; exit 1; }

if [ ! -d "$DIR/.git" ]; then
  echo "== 克隆词表仓库到 $DIR"
  git clone -q https://github.com/konsheng/Sensitive-lexicon.git "$DIR"
fi
git -C "$DIR" fetch -q origin || true
git -C "$DIR" checkout -q "$PIN"
echo "== 词表提交 $(git -C "$DIR" rev-parse --short HEAD)"

install -m 0644 "$SRC/lexicon_server.py" "$DIR/lexicon_server.py"
install -m 0644 "$SRC/sensitive-lexicon.service" "$UNIT"
systemctl daemon-reload
systemctl enable -q --now sensitive-lexicon.service
systemctl restart sensitive-lexicon.service

echo "== 等待 /health"
for _ in $(seq 1 20); do
  if curl -fsS --max-time 3 http://127.0.0.1:8080/health >/tmp/lexicon-health.json 2>/dev/null; then break; fi
  sleep 0.5
done
cat /tmp/lexicon-health.json; echo

echo "== 自检：普通昵称应放行"
curl -fsS --max-time 5 -X POST http://127.0.0.1:8080/contains \
  -H 'Content-Type: application/json' --data-binary '{"text":"夜莺"}' ; echo

echo "== 自检：从词表里取一条真实词条，应当命中（不打印该词条）"
WORD=$(grep -rhm1 -v '^#' "$DIR/Vocabulary"/*.txt | tr -d '\r' | head -1)
if [ -n "${WORD:-}" ]; then
  RESULT=$(python3 - "$WORD" <<'PY'
import json, sys, urllib.request
body = json.dumps({"text": sys.argv[1]}).encode()
req = urllib.request.Request("http://127.0.0.1:8080/contains", data=body,
                             headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=5) as resp:
    data = json.load(resp)
print("contains=%s" % data.get("contains"))
PY
)
  echo "  $RESULT"
else
  echo "  词表为空，跳过" >&2
fi

echo "== 完成：systemctl status sensitive-lexicon"
