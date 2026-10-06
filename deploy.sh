#!/usr/bin/env bash
# リポジトリの公開用ファイルを /var/www/kabaoffice/ に反映する
# 使い方: ./deploy.sh      （本番反映）
#         ./deploy.sh -n   （ドライラン：反映内容の確認のみ）
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/"
DEST="/var/www/kabaoffice/"

rsync -av "$@" \
  --exclude '.git/' \
  --exclude '.gitignore' \
  --exclude '.claude/' \
  --exclude '.env*' \
  --exclude 'CLAUDE.md' \
  --exclude 'README.md' \
  --exclude 'deploy.sh' \
  "$SRC" "$DEST"
