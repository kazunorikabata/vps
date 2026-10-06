#!/usr/bin/env python3
"""顧問先の対応表（URLの鍵 → ドライブのフォルダ）を管理する

使い方（google_login.py でログインしたあとに実行する）:
  sudo /opt/kabaoffice-upload/venv/bin/python clients_admin.py add C001     フォルダを作って、URLを表示する
  sudo /opt/kabaoffice-upload/venv/bin/python clients_admin.py remove C001  削除する（URLは使えなくなる。フォルダと資料は残る）
  sudo /opt/kabaoffice-upload/venv/bin/python clients_admin.py list         登録済みの番号を表示する

フォルダはドライブの「顧問先資料」の中に作る。ドライブ上で名前を変えても、そのまま届く。
"""
import json
import os
import secrets
import sys

import server

CLIENTS_FILE = server.CLIENTS_FILE
ROOT_FILE = os.path.join(server.CONFIG_DIR, "root-folder.json")
ROOT_NAME = "顧問先資料"
BASE_URL = os.environ.get("UPLOAD_BASE_URL", "https://kabaoffice.com/upload/#")


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save(path, data):
    # 書きかけのファイルをサーバーが読まないよう、別名で書いてから置き換える
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    if os.path.exists(path):
        st = os.stat(path)
        os.chown(tmp, st.st_uid, st.st_gid)
        os.chmod(tmp, st.st_mode)
    else:
        os.chmod(tmp, 0o640)
    os.replace(tmp, path)


def root_folder():
    """「顧問先資料」フォルダのIDを返す。なければ作る"""
    root = load(ROOT_FILE)
    if not root:
        root = {"folder_id": server.create_folder(ROOT_NAME)}
        save(ROOT_FILE, root)
        print(f"ドライブに「{ROOT_NAME}」フォルダを作りました")
    return root["folder_id"]


def main(args):
    clients = load(CLIENTS_FILE)
    if args[:1] == ["add"] and len(args) == 2:
        code = args[1]
        if any(c["code"] == code for c in clients.values()):
            sys.exit(f"{code} はすでに登録されています")
        folder_id = server.create_folder(code, root_folder())
        token = secrets.token_urlsafe(32)
        clients[token] = {"code": code, "folder_id": folder_id}
        save(CLIENTS_FILE, clients)
        print(BASE_URL + token)
    elif args[:1] == ["remove"] and len(args) == 2:
        tokens = [t for t, c in clients.items() if c["code"] == args[1]]
        if not tokens:
            sys.exit(f"{args[1]} は登録されていません")
        for t in tokens:
            del clients[t]
        save(CLIENTS_FILE, clients)
        print(f"{args[1]} を削除しました")
    elif args == ["list"]:
        for c in sorted(clients.values(), key=lambda c: c["code"]):
            print(c["code"], c["folder_id"])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
