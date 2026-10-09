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
- 事務所内ページ：`staff/index.html` の1つのページで、サイドバー（URL の `#`）で画面を切り替える（`staff/app.js`）。鍵はページの中だけに置くので、切り替えても開いたまま使える。顧問先の管理（顧問先の一覧・応対履歴・顧問先用の入力ページ・顧客台帳）、事務所の管理（TODO・期限の管理・スケジュール〈準備中〉・事務所用の入力ページ）、サイトの修正、暗号化の鍵。共通の部品は `staff/common.js`。以前の `forms.html`・`site.html` は新しい画面へ移すだけ。事務所用・応対履歴の入力画面は `staff/entry.html`（別のタブで開く）。nginx のベーシック認証（`/etc/nginx/kabaoffice-staff.htpasswd`、職員が自分で登録する）をかけ、`/api/staff/` から別ポート `127.0.0.1:8082` に転送する。顧問先用の入口から管理の機能に届かないよう、ポートを分けている
- 入力ページ：`form/`（顧問先用。URL の `#` 以降が顧問先×入力ページごとの鍵）と `staff/forms.html`（作成・URL発行・確認・CSV書き出し）
  - 入力内容は入力ページごとのスプレッドシート（顧問先用はドライブの「入力内容」フォルダ、事務所用は「事務所の記録」）に1件1行で入れる。暗号化したものは暗号化したまま、長いものは「データ1〜8」に分ける。送信時の項目は「項目」のシートに版ごとに残す。Google Sheets API を使う（権限は drive.file のまま。アプリが作ったスプレッドシートだけ）。書けないときは以前の形（JSON ファイル）で残し、「スプレッドシートに移す」で取り込む
  - 顧客台帳（`kind: register`）は同じ作成画面で項目を作り、`staff/forms.html?kind=register`（`staff/register.js`）で顧問先ごとに開いて直す。保存するたびにドライブの「顧客台帳」フォルダのスプレッドシートに1行足し、顧問先ごとにいちばん新しい行が今の内容（前の行は履歴）。いつも暗号化し、事務所内ページで公開鍵を使って暗号化してから送る。ファイルの部品は使えない。一覧の列は項目の「台帳の一覧に出す」（`listed`）
  - 事務所用に「入力のときに顧問先を選ぶ」（`clientSelect`）を付けると、送った行の「顧問先」の列に番号が入り、台帳でその顧問先を開いたときに「対応の記録」として並ぶ
  - 入力欄の値の読み取り・確認・書き戻しは `form/values.js`（顧問先の入力画面・事務所用・台帳で共通）
  - 事務所用（`kind: office`）は URL を発行せず、職員が `staff/entry.html#入力ページの番号` で入力する（`form/form.js` を `data-mode="office"` で使い、`/api/staff/office/` に送る）。保存先はドライブの「事務所の記録」フォルダで、入力した職員（ベーシック認証のユーザー名）を残す
  - 入力内容は顧問先のブラウザで事務所の公開鍵により暗号化し（`form/crypto.js`。RSA-OAEP 4096 + AES-GCM）、`/api/form/` → `127.0.0.1:8081/form/` を通って顧問先のドライブのフォルダに JSON で保存する。VPS に入力内容は残さない
  - 秘密鍵は職員のブラウザで作り、パスワードで暗号化したファイルとして職員が保管する。VPS・ドライブ・リポジトリに置かない。復号は `staff/forms.html` の中だけで行う
  - ふだんは「鍵の開け方」で開く（`staff/unlock.js`）。セキュリティキー（PC の Chrome・Edge）か iPhone のパスキーから WebAuthn の PRF で取り出した秘密とパスワードで秘密鍵を閉じ、`/var/lib/kabaoffice-upload/key-unlocks.json` に預ける。キーの機器とパスワードの両方がないと開けない。鍵のファイルは予備として残す
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
