#!/usr/bin/env python3
"""顧問先の登録・削除をコマンドで行う（事務所内ページ /staff/ と同じ処理）

使い方（google_login.py でログインしたあとに実行する）:
  sudo /opt/kabaoffice-upload/venv/bin/python clients_admin.py add C001      フォルダを作って、URLを表示する
  sudo /opt/kabaoffice-upload/venv/bin/python clients_admin.py remove C001   削除する（URLは使えなくなる。フォルダと資料は残る）
  sudo /opt/kabaoffice-upload/venv/bin/python clients_admin.py reissue C001  URLを新しくする（前のURLは使えなくなる）
  sudo /opt/kabaoffice-upload/venv/bin/python clients_admin.py list          登録済みの番号を表示する

フォルダはドライブの「顧問先資料」の中に作る。ドライブ上で名前を変えても、そのまま届く。
"""
import sys

import server


def main(args):
    try:
        if args[:1] == ["add"] and len(args) == 2:
            print(server.UPLOAD_BASE_URL + server.add_client(args[1]))
        elif args[:1] == ["remove"] and len(args) == 2:
            server.remove_client(args[1])
            print(f"{args[1]} を削除しました")
        elif args[:1] == ["reissue"] and len(args) == 2:
            print(server.UPLOAD_BASE_URL + server.reissue_client(args[1]))
        elif args == ["list"]:
            for _, c in server.list_clients():
                print(c["code"], c.get("created") or "-", c["folder_id"])
        else:
            sys.exit(__doc__)
    except server.UploadError as e:
        sys.exit(e.message)


if __name__ == "__main__":
    main(sys.argv[1:])
