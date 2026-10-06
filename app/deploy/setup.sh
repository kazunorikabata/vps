#!/usr/bin/env bash
# 資料アップロードの受付サーバーを VPS に設置・更新する（何度実行してもよい）
# 使い方: sudo bash app/deploy/setup.sh
set -euo pipefail

APP_DIR=/opt/kabaoffice-upload
CONFIG_DIR=/etc/kabaoffice-upload
SERVICE_USER=kabaupload
NGINX_SITE="$(readlink -f /etc/nginx/sites-enabled/kabaoffice)"
NGINX_BACKUP=/root/kabaoffice.nginx.bak
SRC="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "sudo を付けて実行してください"
  exit 1
fi

echo "== 1. Python の仮想環境を作る部品を入れる"
apt-get install -y python3-venv

echo "== 2. 専用ユーザー（ログインできないユーザー）を作る"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"

echo "== 3. プログラムと部品を $APP_DIR に置く"
install -d -m 755 "$APP_DIR"
install -m 644 "$SRC/server.py" "$SRC/clients_admin.py" "$SRC/google_login.py" "$SRC/requirements.txt" "$APP_DIR/"
[ -x "$APP_DIR/venv/bin/python" ] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

echo "== 4. 設定フォルダ $CONFIG_DIR を作る（root と $SERVICE_USER だけが読める）"
install -d -m 750 -o root -g "$SERVICE_USER" "$CONFIG_DIR"
if [ ! -e "$CONFIG_DIR/clients.json" ]; then
  echo '{}' > "$CONFIG_DIR/clients.json"
  chown root:"$SERVICE_USER" "$CONFIG_DIR/clients.json"
  chmod 640 "$CONFIG_DIR/clients.json"
fi

echo "== 5. 常駐の設定（systemd）"
install -m 644 "$SRC/deploy/kabaoffice-upload.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable kabaoffice-upload
systemctl restart kabaoffice-upload

echo "== 6. nginx に /api/upload/ の転送を追加する"
install -m 644 "$SRC/deploy/nginx-upload.conf" /etc/nginx/snippets/kabaoffice-upload.conf
if ! grep -q 'snippets/kabaoffice-upload.conf' "$NGINX_SITE"; then
  cp "$NGINX_SITE" "$NGINX_BACKUP"
  sed -i '/^    index index.html;$/a\    include snippets/kabaoffice-upload.conf;' "$NGINX_SITE"
  if ! grep -q 'snippets/kabaoffice-upload.conf' "$NGINX_SITE"; then
    echo "nginx の設定に追加できませんでした（変更していません）"
    exit 1
  fi
fi
if ! nginx -t; then
  [ -e "$NGINX_BACKUP" ] && cp "$NGINX_BACKUP" "$NGINX_SITE"
  echo "nginx の設定に誤りがあったため、元に戻しました"
  exit 1
fi
systemctl reload nginx

echo
echo "完了しました。状態: $(systemctl is-active kabaoffice-upload)"
