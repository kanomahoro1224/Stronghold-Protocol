#!/usr/bin/env bash
# Put the community site at game.xiaolubao.com (node:3100) and move the game's public name to hk.xiaolubao.com.
# Everything is done without restarting the game server: the game keeps serving 127.0.0.1:3000, only nginx
# server_name routing changes, and nginx is reloaded (existing sockets and WebSockets survive a reload).
set -u
TS=$(date +%Y%m%d-%H%M%S)
APP=/opt/Stronghold-Protocol/community
BK=/opt/stronghold-deploy
say() { echo "[$(date +%H:%M:%S)] $*"; }

say "1. app dir $APP"
mkdir -p "$BK" "$APP"
if [ -d "$APP/server" ]; then
  say "   existing install -> backup $BK/community-backup-$TS.tgz"
  tar -czf "$BK/community-backup-$TS.tgz" -C /opt/Stronghold-Protocol community 2>/dev/null && say "   backup ok"
fi
say "2. extract app"
tar -xzf /tmp/community-app.tgz -C "$APP" || { echo UNTAR_FAIL; exit 1; }
mkdir -p "$APP/data"

say "3. database (migrated from the dev box; NEVER overwritten once present)"
if [ -f "$APP/data/community.db" ]; then
  say "   $APP/data/community.db already exists -> left as-is"
else
  cp /tmp/community.db "$APP/data/community.db" || { echo DB_COPY_FAIL; exit 1; }
  say "   installed /tmp/community.db ($(stat -c%s "$APP/data/community.db") B)"
fi
chown -R stronghold:stronghold "$APP"
chmod 644 "$APP/data/community.db"
say "   db sha256: $(sha256sum "$APP/data/community.db" | cut -c1-16)"
say "   db counts: $(/usr/local/bin/node -e "
  const {DatabaseSync}=require('node:sqlite');
  const d=new DatabaseSync('$APP/data/community.db');
  console.log('servers='+d.prepare('SELECT COUNT(*) n FROM servers').get().n,
              'accounts='+d.prepare('SELECT COUNT(*) n FROM accounts').get().n,
              'sessions='+d.prepare('SELECT COUNT(*) n FROM sessions').get().n);
  for (const s of d.prepare('SELECT name,address FROM servers ORDER BY sort_order').all()) console.log('     - '+s.name+'  '+s.address);
" 2>/dev/null | tr '\n' ' ')"

say "4. systemd unit"
install -m 644 /tmp/stronghold-community.service /etc/systemd/system/stronghold-community.service
systemctl daemon-reload
systemctl enable stronghold-community >/dev/null 2>&1
systemctl restart stronghold-community
sleep 3
say "   is-active: $(systemctl is-active stronghold-community)"
say "   own /healthz: $(curl -s --max-time 5 http://127.0.0.1:3100/healthz)"
say "   journal (last 5):"; journalctl -u stronghold-community -n 5 --no-pager 2>/dev/null | sed 's/^/     /'

say "5. nginx configs (backup + test + reload, auto-rollback on failure)"
cp -a /etc/nginx/conf.d/game.xiaolubao.com.conf "$BK/game.xiaolubao.com.conf.bak-$TS"
say "   backup $BK/game.xiaolubao.com.conf.bak-$TS"
install -m 644 /tmp/nginx-hk.conf /etc/nginx/conf.d/hk.xiaolubao.com.conf
install -m 644 /tmp/nginx-game.conf /etc/nginx/conf.d/game.xiaolubao.com.conf
if nginx -t >/tmp/nginx-t.log 2>&1; then
  sed 's/^/     /' /tmp/nginx-t.log
  nginx -s reload && say "   reloaded (game server untouched)"
else
  say "   nginx -t FAILED -> rolling back:"
  sed 's/^/     /' /tmp/nginx-t.log
  cp -a "$BK/game.xiaolubao.com.conf.bak-$TS" /etc/nginx/conf.d/game.xiaolubao.com.conf
  rm -f /etc/nginx/conf.d/hk.xiaolubao.com.conf
  nginx -t >/tmp/nginx-t2.log 2>&1 && nginx -s reload && say "   rolled back and reloaded"
  exit 1
fi

say "6. verify (real SNI via --resolve; -H Host on 127.0.0.1 is NOT enough: HTTP/2 :authority ignores it)"
R="--resolve game.xiaolubao.com:443:127.0.0.1 --resolve hk.xiaolubao.com:443:127.0.0.1"
for h in game.xiaolubao.com hk.xiaolubao.com; do
  code=$(curl -sk $R -o /tmp/page.html -w '%{http_code}' --max-time 10 "https://$h/")
  title=$(grep -o '<title>[^<]*</title>' /tmp/page.html | head -1)
  echo "   $h  / -> $code  $title"
done
echo -n "   game /api/servers -> "; curl -sk $R --max-time 10 https://game.xiaolubao.com/api/servers | head -c 200; echo
echo -n "   game /healthz     -> "; curl -sk $R --max-time 10 https://game.xiaolubao.com/healthz; echo
echo -n "   game /resource-sw.js -> "; curl -sk $R --max-time 10 https://game.xiaolubao.com/resource-sw.js | head -c 80; echo
echo -n "   hk   /healthz     -> "; curl -sk $R --max-time 10 https://hk.xiaolubao.com/healthz | head -c 160; echo
echo -n "   hk   /assets 302  -> "; curl -sk $R -o /dev/null -w '%{http_code} %{redirect_url}\n' --max-time 10 https://hk.xiaolubao.com/assets/img/ui/logo.png
echo -n "   hk   /ws upgrade  -> "; curl -sk $R -o /dev/null -w '%{http_code}\n' --http1.1 --max-time 10 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://hk.xiaolubao.com/ws
echo "   --- public ---"
echo -n "   https://game.xiaolubao.com/ -> "; curl -s -o /tmp/p2.html -w '%{http_code}' --max-time 20 https://game.xiaolubao.com/; echo -n "  "; grep -o '<title>[^<]*</title>' /tmp/p2.html | head -1
echo -n "   https://game.xiaolubao.com/api/servers -> "; curl -s --max-time 20 https://game.xiaolubao.com/api/servers | head -c 200; echo
echo -n "   https://hk.xiaolubao.com/healthz -> "; curl -s --max-time 20 https://hk.xiaolubao.com/healthz | head -c 160; echo
echo -n "   game server sockets: "; curl -s --max-time 10 http://127.0.0.1:3000/healthz | grep -o '"sockets":[0-9]*'
echo DONE
