#!/bin/sh
# Installs the relay as a systemd service on Ubuntu/Debian. Run as root next to the
# cofisher-relay binary:   sudo sh install-relay.sh [password] [port]
set -eu
PASSWORD="${1:-}"
PORT="${2:-23333}"
DIR="$(cd "$(dirname "$0")" && pwd)"

install -m 0755 "$DIR/cofisher-relay" /usr/local/bin/cofisher-relay
ARGS="--port $PORT"
[ -n "$PASSWORD" ] && ARGS="$ARGS --password $PASSWORD"
sed "s#^ExecStart=.*#ExecStart=/usr/local/bin/cofisher-relay $ARGS#" "$DIR/cofisher-relay.service" > /etc/systemd/system/cofisher-relay.service
systemctl daemon-reload
systemctl enable --now cofisher-relay
systemctl restart cofisher-relay

# Open the port in ufw if it is active (the cloud console's security group must allow it too).
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "$PORT"/tcp
fi
sleep 1
systemctl --no-pager status cofisher-relay | head -n 5
echo
echo "中转服务器已启动：端口 $PORT/TCP。记得在云服务器控制台的【安全组/防火墙】里放行 $PORT。"
echo "朋友们在 App 里填：服务器公网IP:$PORT + 同一个房间号${PASSWORD:+ + 密码}"
