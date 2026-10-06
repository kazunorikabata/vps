#!/usr/bin/env python3
"""顧問先からの資料アップロードの受付サーバー

ファイル本体は受け取らない。Google ドライブの「再開可能アップロード」の受付口を発行し、
送信後にドライブ上のファイルを確認するだけ。nginx の /api/upload/ から転送される。
ドライブへは事務所の Google アカウントのログイン情報（google_login.py で保存）で接続し、
権限は drive.file（このプログラムが作ったフォルダとファイルだけ）に限る。
"""
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials

CONFIG_DIR = os.environ.get("UPLOAD_CONFIG_DIR", "/etc/kabaoffice-upload")
CLIENTS_FILE = os.path.join(CONFIG_DIR, "clients.json")
TOKEN_FILE = os.path.join(CONFIG_DIR, "oauth-token.json")
ALLOWED_ORIGIN = os.environ.get("UPLOAD_ALLOWED_ORIGIN", "https://kabaoffice.com")
PORT = int(os.environ.get("UPLOAD_PORT", "8081"))

MAX_SIZE = 50 * 1024 * 1024
MAX_BODY = 4096
RATE_LIMIT = 60      # 1つのURLから1時間に受け付ける件数
RATE_WINDOW = 3600

# 拡張子 → ドライブに保存する MIME タイプ
ALLOWED_TYPES = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".heic": "image/heic",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".csv": "text/csv",
}

DRIVE_API = "https://www.googleapis.com/drive/v3/files"
DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files"
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
JST = timezone(timedelta(hours=9))
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,128}$")
FILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,200}$")

log = logging.getLogger("upload")


class UploadError(Exception):
    """顧問先の画面にそのまま表示するエラー"""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# --- 顧問先・入力チェック ---

def find_client(token):
    if not isinstance(token, str) or not TOKEN_RE.match(token):
        raise UploadError(403, "このURLは無効です。事務所にお問い合わせください。")
    # 毎回読み込むので、対応表を書き換えたら再起動しなくても反映される
    with open(CLIENTS_FILE, encoding="utf-8") as f:
        client = json.load(f).get(token)
    if not client:
        raise UploadError(403, "このURLは無効です。事務所にお問い合わせください。")
    return client


def safe_name(name):
    """送信日時を付けた保存用のファイル名と、拡張子を返す"""
    name = os.path.basename(str(name).replace("\\", "/"))
    name = re.sub(r'[\x00-\x1f\x7f:*?"<>|]', "_", name).strip(" .")
    stem, ext = os.path.splitext(name)
    ext = ext.lower()
    if ext not in ALLOWED_TYPES:
        raise UploadError(400, "この種類のファイルは送信できません。")
    stem = stem[:80] or "file"
    return f"{datetime.now(JST):%Y%m%d-%H%M%S}_{stem}{ext}", ext


def looks_like(ext, head):
    """ファイルの先頭の数バイトが、拡張子どおりの形式か"""
    if ext == ".pdf":
        return head.startswith(b"%PDF")
    if ext in (".jpg", ".jpeg"):
        return head.startswith(b"\xff\xd8\xff")
    if ext == ".png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if ext == ".heic":
        return head[4:8] == b"ftyp"
    if ext in (".xlsx", ".docx"):
        return head.startswith(b"PK\x03\x04")
    if ext in (".xls", ".doc"):
        return head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
    if ext == ".csv":
        return len(head) > 0 and b"\x00" not in head
    return False


_hits = {}
_hits_lock = threading.Lock()


def check_rate(token):
    now = time.monotonic()
    with _hits_lock:
        hits = [t for t in _hits.get(token, []) if now - t < RATE_WINDOW]
        if len(hits) >= RATE_LIMIT:
            _hits[token] = hits
            raise UploadError(429, "短時間に多くのファイルが送信されました。しばらくしてからお試しください。")
        hits.append(now)
        _hits[token] = hits


# --- Google ドライブ ---

_creds = None
_creds_lock = threading.Lock()


def auth_headers():
    global _creds
    with _creds_lock:
        if _creds is None:
            _creds = Credentials.from_authorized_user_file(TOKEN_FILE, scopes=SCOPES)
        if not _creds.valid:
            _creds.refresh(GoogleAuthRequest())
        return {"Authorization": f"Bearer {_creds.token}"}


def create_folder(name, parent_id=None):
    body = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
    if parent_id:
        body["parents"] = [parent_id]
    r = requests.post(DRIVE_API, params={"fields": "id"}, headers=auth_headers(), json=body, timeout=15)
    r.raise_for_status()
    return r.json()["id"]


def create_upload_session(folder_id, name, mime, size):
    """1ファイル分の受付口（URL）を発行する。Origin を付けるとブラウザから直接送れる"""
    r = requests.post(
        DRIVE_UPLOAD_API,
        params={"uploadType": "resumable", "supportsAllDrives": "true"},
        headers={
            **auth_headers(),
            "X-Upload-Content-Type": mime,
            "X-Upload-Content-Length": str(size),
            "Origin": ALLOWED_ORIGIN,
        },
        json={"name": name, "parents": [folder_id], "mimeType": mime},
        timeout=15,
    )
    r.raise_for_status()
    return r.headers["Location"]


def get_file(file_id):
    r = requests.get(
        f"{DRIVE_API}/{file_id}",
        params={"fields": "id,name,size,parents", "supportsAllDrives": "true"},
        headers=auth_headers(),
        timeout=15,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def read_head(file_id, n=16):
    """先頭の数バイトだけを読む（ファイルは保存しない）"""
    with requests.get(
        f"{DRIVE_API}/{file_id}",
        params={"alt": "media", "supportsAllDrives": "true"},
        headers={**auth_headers(), "Range": f"bytes=0-{n - 1}"},
        stream=True,
        timeout=15,
    ) as r:
        r.raise_for_status()
        return next(r.iter_content(n), b"")[:n]


def trash_file(file_id):
    r = requests.patch(
        f"{DRIVE_API}/{file_id}",
        params={"supportsAllDrives": "true"},
        headers=auth_headers(),
        json={"trashed": True},
        timeout=15,
    )
    r.raise_for_status()


# --- API ---

def handle_session(body):
    token = body.get("token")
    client = find_client(token)
    size = body.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        raise UploadError(400, "ファイルが空です。")
    if size > MAX_SIZE:
        raise UploadError(400, "50MBを超えるファイルは送信できません。")
    name, ext = safe_name(body.get("name", ""))
    check_rate(token)
    url = create_upload_session(client["folder_id"], name, ALLOWED_TYPES[ext], size)
    # ファイル名には顧問先の情報が入りうるので、記録には残さない
    log.info("session code=%s ext=%s size=%d", client["code"], ext, size)
    return {"uploadUrl": url, "mimeType": ALLOWED_TYPES[ext]}


def handle_complete(body):
    client = find_client(body.get("token"))
    file_id = body.get("fileId")
    if not isinstance(file_id, str) or not FILE_ID_RE.match(file_id):
        raise UploadError(400, "ファイルが見つかりません。")
    f = get_file(file_id)
    if f is None or client["folder_id"] not in f.get("parents", []):
        raise UploadError(404, "ファイルが見つかりません。")
    ext = os.path.splitext(f["name"])[1].lower()
    size = int(f.get("size", 0))
    if ext not in ALLOWED_TYPES or not 0 < size <= MAX_SIZE or not looks_like(ext, read_head(file_id)):
        trash_file(file_id)
        log.warning("rejected code=%s ext=%s size=%d", client["code"], ext, size)
        raise UploadError(400, "ファイルの中身を確認できなかったため、受け付けられませんでした。")
    log.info("received code=%s ext=%s size=%d", client["code"], ext, size)
    return {"ok": True}


ROUTES = {"/session": handle_session, "/complete": handle_complete}


class Handler(BaseHTTPRequestHandler):
    server_version = "kabaoffice-upload"

    def do_POST(self):
        try:
            if self.headers.get("Origin") != ALLOWED_ORIGIN:
                raise UploadError(403, "不正なリクエストです。")
            route = ROUTES.get(self.path)
            if route is None:
                raise UploadError(404, "見つかりません。")
            self.send_json(200, route(self.read_json()))
        except UploadError as e:
            self.send_json(e.status, {"error": e.message})
        except Exception:
            log.exception("unexpected error")
            self.send_json(500, {"error": "サーバーでエラーが起きました。時間をおいて再度お試しください。"})

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = -1
        if not 0 < length <= MAX_BODY:
            raise UploadError(400, "不正なリクエストです。")
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            raise UploadError(400, "不正なリクエストです。")
        if not isinstance(body, dict):
            raise UploadError(400, "不正なリクエストです。")
        return body

    def send_json(self, status, data):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        log.info(format, *args)


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log.info("listening on 127.0.0.1:%d", PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
