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
- 入力ページ：`form/`（顧問先用。URL の `#` 以降が顧問先×入力ページごとの鍵）と `staff/forms.html`（作成・URL発行・確認・CSV書き出し）
  - 入力内容は顧問先のブラウザで事務所の公開鍵により暗号化し（`form/crypto.js`。RSA-OAEP 4096 + AES-GCM）、`/api/form/` → `127.0.0.1:8081/form/` を通って顧問先のドライブのフォルダに JSON で保存する。VPS に入力内容は残さない
  - 秘密鍵は職員のブラウザで作り、パスワードで暗号化したファイルとして職員が保管する。VPS・ドライブ・リポジトリに置かない。復号は `staff/forms.html` の中だけで行う
  - 入力ページごとに暗号化を外せるが、マイナンバーの項目があるものは外せない（サーバーでも確認）
  - 部品は横12マスのマス目に幅（`width`）で並べる（区切り線・説明文・空白・枠、行が決まった表・合計・列幅も）。表示は `form/render.js` と `form/layout.css` を顧問先の画面・PDF・事務所内ページで共通に使い、作成画面は `staff/form-editor.js`
  - VPS 上の配置：入力ページの定義 `forms.json`、URLの対応表 `form-requests.json`、公開鍵 `public-key.json`（いずれも `/var/lib/kabaoffice-upload/`）
- 管理ページの Claude Code 会話一覧：`staff/claude.js`。dev の crontab で `app/claude_sessions.py` を毎分実行し、`/var/www/kabaoffice/staff/claude-sessions.json` に書き出す（会話の中身は書き出さず、日時と最初の依頼の冒頭だけ）。ブラウザから VPS のプログラムを起動する機能は作らない

## コマンド
- テスト：`cd app && /opt/kabaoffice-upload/venv/bin/python -B -m unittest test_server test_claude_sessions`（Google への接続はダミーに置き換え済み）
- 受付サーバーの設置・更新：`sudo bash app/deploy/setup.sh`。sudo にパスワードが要るため、ユーザーに実行してもらう
- 顧問先の登録・削除：`sudo /opt/kabaoffice-upload/venv/bin/python /opt/kabaoffice-upload/clients_admin.py add|remove|reissue|list`
- `deploy.sh` は `app/` を公開フォルダに送らない。公開ファイル以外を追加したら除外の設定を確認する
- Cloudflare が JS・CSS を4時間ほど保存する。`form/`・`staff/` の JS・CSS を変えたら、読み込む HTML の `?v=日付` を新しくする（古いファイルと混ざって動かなくなるのを防ぐ）
