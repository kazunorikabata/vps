# CLAUDE.md

## 作業ルール
- 修正は最小限・ピンポイントで行い、大規模な書き換えはしない
- ファイルを修正したときは、変更箇所だけでなくファイル全体を提示する
- 作業は新しいブランチで行い、main に直接コミットしない（今回の初回コミットのみ例外）
- .env や認証情報のファイルは読まない・作らない
- 顧客の実データは扱わず、テストにはダミーデータを使う
- 公開は ./deploy.sh で行う。実行前に必ず確認を取る

## プロジェクト概要
蒲田和紀税理士事務所のサイト（kabaoffice.com）と、顧問先からの資料アップロードの仕組み。VPS 上の nginx で配信し、前段に Cloudflare がある。

- 公開サイト：`index.html`・`css/`・`js/` の1ページ構成。ビルドなしの静的ファイル
- 資料アップロード：
  - `upload/`：顧問先用の送信画面。URL の `#` 以降が顧問先ごとの鍵
  - `app/server.py`：Google ドライブの再開可能アップロードの受付口を発行し、送信後に先頭バイトで中身を確認する。ファイル本体は VPS を通らない
  - ドライブへは事務所アカウントの OAuth（スコープは `drive.file`）で接続する。権限を広げないこと
  - VPS 上の配置：プログラムは `/opt/kabaoffice-upload/`、ログイン情報は `/etc/kabaoffice-upload/`（読まない）、顧問先の対応表は `/var/lib/kabaoffice-upload/`。nginx の `/api/upload/` から `127.0.0.1:8081` に転送する
- 事務所内ページ：`staff/`（顧問先の追加・削除・URL再発行・QRコード）。nginx のベーシック認証（`/etc/nginx/kabaoffice-staff.htpasswd`、職員が自分で登録する）をかけ、`/api/staff/` から別ポート `127.0.0.1:8082` に転送する。顧問先用の入口から管理の機能に届かないよう、ポートを分けている

## コマンド
- テスト：`cd app && /opt/kabaoffice-upload/venv/bin/python -B -m unittest test_server`（Google への接続はダミーに置き換え済み）
- 受付サーバーの設置・更新：`sudo bash app/deploy/setup.sh`。sudo にパスワードが要るため、ユーザーに実行してもらう
- 顧問先の登録・削除：`sudo /opt/kabaoffice-upload/venv/bin/python /opt/kabaoffice-upload/clients_admin.py add|remove|reissue|list`
- `deploy.sh` は `app/` を公開フォルダに送らない。公開ファイル以外を追加したら除外の設定を確認する
