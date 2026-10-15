#!/usr/bin/env python3
"""事務所内ページのアカウント（YubiKey でのログイン）をコマンドで扱う。最初の管理者を作るときと、
キーを全部なくして入れなくなったときに使う（ふだんは事務所内ページの「設定 → 職員のアカウント」で行う）

使い方:
  sudo /opt/kabaoffice-upload/venv/bin/python accounts_admin.py admin ID 表示名   管理者のアカウントを作り（あれば管理者にし）、
                                                                                キーを登録する URL を表示する
  sudo /opt/kabaoffice-upload/venv/bin/python accounts_admin.py issue ID          キーを登録する URL を表示する（24時間・1回だけ）
  sudo /opt/kabaoffice-upload/venv/bin/python accounts_admin.py list              アカウントと登録したキーの数を表示する

ID は、今の事務所内ページのログイン ID と同じにしておくと、切り替えの前も管理者として扱われる。
"""
import sys

import server


def main(args):
    try:
        if args[:1] == ["admin"] and len(args) == 3:
            aid = server.check_account_id(args[1])
            with server._forms_lock:
                data = server.load_accounts()
                account = data["accounts"].setdefault(aid, {"credentials": []})
                account.update({"name": args[2], "admin": True})
                server.save_json(server.ACCOUNTS_FILE, data)
            print(server.issue_registration(aid))
        elif args[:1] == ["issue"] and len(args) == 2:
            print(server.issue_registration(server.check_account_id(args[1])))
        elif args == ["list"]:
            for aid, a in server.load_accounts()["accounts"].items():
                print(aid, a.get("name", ""), "管理者" if a.get("admin") else "", f"キー{len(a.get('credentials', []))}本")
        else:
            sys.exit(__doc__)
    except server.UploadError as e:
        sys.exit(e.message)


if __name__ == "__main__":
    main(sys.argv[1:])
