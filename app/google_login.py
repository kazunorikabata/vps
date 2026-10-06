#!/usr/bin/env python3
"""事務所の Google アカウントでログインし、ログイン情報を保存する（最初に1回だけ実行）

使い方: sudo /opt/kabaoffice-upload/venv/bin/python google_login.py

ブラウザで許可したあとの「接続できません」の画面のURLを貼り付けると、
/etc/kabaoffice-upload/oauth-token.json に保存する。
"""
import base64
import getpass
import grp
import hashlib
import json
import os
import secrets
import sys
from urllib.parse import parse_qs, urlencode, urlparse

import requests

from server import SCOPES, TOKEN_FILE

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REDIRECT_URI = "http://localhost:8765/"
SERVICE_GROUP = "kabaupload"


def main():
    client_id = input("クライアントID: ").strip()
    client_secret = getpass.getpass("クライアントシークレット（入力しても表示されません）: ").strip()

    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    url = AUTH_URL + "?" + urlencode({
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    print("\n1. 次のURLをパソコンのブラウザで開いてください。\n")
    print(url)
    print("\n2. 事務所の Google アカウントでログインし、「許可」を押してください。")
    print("3. 「接続できません」と表示されたら、そのページのアドレス欄のURLをすべてコピーして、下に貼り付けてください。\n")
    redirected = input("アドレス欄のURL: ").strip()

    query = parse_qs(urlparse(redirected).query)
    if "error" in query:
        sys.exit(f"ログインできませんでした（{query['error'][0]}）")
    if query.get("state", [""])[0] != state or "code" not in query:
        sys.exit("貼り付けたURLが正しくありません。最初からやり直してください")

    r = requests.post(TOKEN_URL, data={
        "code": query["code"][0],
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
        "code_verifier": verifier,
    }, timeout=15)
    try:
        data = r.json()
    except ValueError:
        data = {}
    if not r.ok or "refresh_token" not in data:
        sys.exit(f"ログイン情報を取得できませんでした（{data.get('error_description') or data.get('error') or r.status_code}）")
    if SCOPES[0] not in data.get("scope", "").split():
        sys.exit("ドライブへのアクセスが許可されていません。許可の画面でチェックを入れて、やり直してください")

    save({
        "type": "authorized_user",
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": data["refresh_token"],
    })
    print(f"\n保存しました: {TOKEN_FILE}")


def save(token):
    # 受付サーバー（kabaupload）だけが読めるようにする
    tmp = TOKEN_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(token, f)
    try:
        os.chown(tmp, 0, grp.getgrnam(SERVICE_GROUP).gr_gid)
        os.chmod(tmp, 0o640)
    except KeyError:
        print(f"注意: グループ {SERVICE_GROUP} がないため、root だけが読める状態で保存します")
    os.replace(tmp, TOKEN_FILE)


if __name__ == "__main__":
    main()
