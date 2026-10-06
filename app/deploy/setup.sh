#!/usr/bin/env bash
# 資料アップロードの受付サーバーを VPS に設置・更新する（何度実行してもよい）
# 使い方: sudo bash app/deploy/setup.sh
set -euo pipefail

APP_DIR=/opt/kabaoffice-upload
CONFIG_DIR=/etc/kabaoffice-upload
DATA_DIR=/var/lib/kabaoffice-upload
SERVICE_USER=kabaupload
NGINX_SITE="$(readlink -f /etc/nginx/sites-enabled/kabaoffice)"
NGINX_SNIPPET=/etc/nginx/snippets/kabaoffice-upload.conf
NGINX_BACKUP=/root/kabaoffice.nginx.bak
SNIPPET_BACKUP=/root/kabaoffice-upload.conf.bak
STAFF_HTPASSWD=/etc/nginx/kabaoffice-staff.htpasswd
SRC="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "sudo を付けて実行してください"
  exit 1
fi

echo "== 1. 必要な部品を入れる（Python の仮想環境、パスワード登録用の htpasswd）"
apt-get install -y python3-venv apache2-utils

# 事務所内ページのパスワードは、職員がご自身で登録する（このスクリプトでは作らない）
if [ ! -s "$STAFF_HTPASSWD" ]; then
  echo
  echo "事務所内ページのIDとパスワードがまだ登録されていません。"
  echo "最初の職員を次のコマンドで登録してから、もう一度このスクリプトを実行してください。"
  echo "  sudo htpasswd -c $STAFF_HTPASSWD 職員のID"
  exit 1
fi

echo "== 2. 専用ユーザー（ログインできないユーザー）を作る"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"

echo "== 3. プログラムと部品を $APP_DIR に置く"
install -d -m 755 "$APP_DIR"
install -m 644 "$SRC/server.py" "$SRC/clients_admin.py" "$SRC/google_login.py" "$SRC/requirements.txt" "$APP_DIR/"
[ -x "$APP_DIR/venv/bin/python" ] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

echo "== 4. 設定フォルダ $CONFIG_DIR（ログイン情報。root と $SERVICE_USER だけが読める）"
install -d -m 750 -o root -g "$SERVICE_USER" "$CONFIG_DIR"

echo "== 5. 顧問先の対応表を $DATA_DIR に置く（受付サーバーが書き換えられる場所）"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
for f in clients.json root-folder.json; do
  # 以前の置き場所（$CONFIG_DIR）にあれば移す
  if [ -e "$CONFIG_DIR/$f" ] && [ ! -e "$DATA_DIR/$f" ]; then
    mv "$CONFIG_DIR/$f" "$DATA_DIR/$f"
    echo "   $f を $DATA_DIR に移しました"
  fi
  if [ -e "$DATA_DIR/$f" ]; then
    chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR/$f"
    chmod 600 "$DATA_DIR/$f"
  fi
done

echo "== 6. 常駐の設定（systemd）"
install -m 644 "$SRC/deploy/kabaoffice-upload.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable kabaoffice-upload
systemctl restart kabaoffice-upload

echo "== 7. nginx に /api/upload/・/staff/・/api/staff/ の設定を入れる"
chown root:www-data "$STAFF_HTPASSWD"
chmod 640 "$STAFF_HTPASSWD"
[ -e "$NGINX_SNIPPET" ] && cp "$NGINX_SNIPPET" "$SNIPPET_BACKUP"
install -m 644 "$SRC/deploy/nginx-upload.conf" "$NGINX_SNIPPET"
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
  [ -e "$SNIPPET_BACKUP" ] && cp "$SNIPPET_BACKUP" "$NGINX_SNIPPET"
  echo "nginx の設定に誤りがあったため、元に戻しました"
  exit 1
fi
systemctl reload nginx

echo
echo "完了しました。状態: $(systemctl is-active kabaoffice-upload)"
