#!/usr/bin/env python3
"""顧問先からの資料アップロードの受付サーバー

ファイル本体は受け取らない。Google ドライブの「再開可能アップロード」の受付口を発行し、
送信後にドライブ上のファイルを確認するだけ。nginx の /api/upload/ から転送される。
ドライブへは事務所の Google アカウントのログイン情報（google_login.py で保存）で接続し、
権限は drive.file（このプログラムが作ったフォルダとファイルだけ）に限る。
事務所内ページ（/staff/）用の顧問先管理は別のポート（nginx の /api/staff/、ベーシック認証付き）で受ける。

入力ページ（/form/）：事務所内ページで作った入力ページに、顧問先が入力して送る。
入力内容は顧問先のブラウザで事務所の公開鍵を使って暗号化され、ここでは中身を読めないまま
顧問先のドライブのフォルダに保存する（暗号化しない入力ページも作れるが、マイナンバーを含むものは必ず暗号化）。
復号は事務所内ページで、職員が持つ秘密鍵で行う。秘密鍵はこのサーバーにもドライブにも置かない。
"""
import base64
import hashlib
import json
import logging
import os
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests
import segno
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials

CONFIG_DIR = os.environ.get("UPLOAD_CONFIG_DIR", "/etc/kabaoffice-upload")   # 読み取り専用（ログイン情報）
DATA_DIR = os.environ.get("UPLOAD_DATA_DIR", "/var/lib/kabaoffice-upload")    # 書き込み可（顧問先の対応表）
TOKEN_FILE = os.path.join(CONFIG_DIR, "oauth-token.json")
CLIENTS_FILE = os.path.join(DATA_DIR, "clients.json")
ROOT_FILE = os.path.join(DATA_DIR, "root-folder.json")
FORMS_FILE = os.path.join(DATA_DIR, "forms.json")              # 入力ページの定義（項目の並び。入力内容は置かない）
REQUESTS_FILE = os.path.join(DATA_DIR, "form-requests.json")   # 入力ページのURLの鍵 → 顧問先と入力ページ
KEY_FILE = os.path.join(DATA_DIR, "public-key.json")           # 事務所の公開鍵（暗号化用。復号はできない）
ROOT_NAME = "顧問先資料"
ALLOWED_ORIGIN = os.environ.get("UPLOAD_ALLOWED_ORIGIN", "https://kabaoffice.com")
UPLOAD_BASE_URL = ALLOWED_ORIGIN + "/upload/#"
FORM_BASE_URL = ALLOWED_ORIGIN + "/form/#"
PORT = int(os.environ.get("UPLOAD_PORT", "8081"))
STAFF_PORT = int(os.environ.get("UPLOAD_STAFF_PORT", "8082"))

MAX_SIZE = 50 * 1024 * 1024
MAX_BODY = 4096
# 既定より大きい本文を受け付ける API（nginx の client_max_body_size もあわせる）
BODY_LIMITS = {"/form/submit": 256 * 1024, "/forms/save": 64 * 1024, "/key/set": 8192}
MAX_RECORD = 512 * 1024   # 事務所内ページで開く入力内容のファイルの大きさの上限
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
CODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,20}$")
FORM_ID_RE = re.compile(r"^f[0-9a-f]{12}$")
# 入力ページで添付するファイル。ブラウザの中で暗号化してから、ドライブに直接送る（VPS は通らない）。
# 暗号化したファイルは先頭が FILE_MAGIC。1回の送信のファイルと入力内容は、同じ batch の番号で結び付ける
FILE_MAGIC = b"KABAENC1"
MAX_ENCRYPTED_SIZE = MAX_SIZE + 64
MAX_FILES = 10
BATCH_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
FIELD_ID_RE = re.compile(r"^[a-z0-9_]{1,40}$")
B64_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")

# 入力ページの項目の種類（表の列に使えるのは COLUMN_TYPES だけ）
FIELD_TYPES = {"heading", "text", "textarea", "number", "date", "select", "checkbox", "checkboxes", "file",
               "tel", "email", "zip", "mynumber", "table", "divider", "note", "spacer", "group", "page"}
# 入力欄のない部品（見出し・区切り線・説明文・空白・枠・ページ区切り）
LAYOUT_TYPES = {"heading", "divider", "note", "spacer", "group", "page"}
NOTE_STYLES = {"normal", "bold", "warning"}
# 項目名の位置（上・横）と説明の位置（入力欄の上・中）。入力ページ全体で決め、項目ごとにも変えられる
LABEL_POSITIONS = {"top", "side"}
HELP_POSITIONS = {"above", "inside"}
# 説明を入力欄の中に出せる種類
PLACEHOLDER_TYPES = {"text", "textarea", "number", "tel", "email", "zip", "mynumber"}
MAX_FIELDS = 300
COLUMN_TYPES = {"text", "number", "date", "select", "checkbox", "mynumber"}

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
    client = load_json(CLIENTS_FILE).get(token)
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


def create_upload_session(folder_id, name, mime, size, app_properties=None):
    """1ファイル分の受付口（URL）を発行する。Origin を付けるとブラウザから直接送れる"""
    meta = {"name": name, "parents": [folder_id], "mimeType": mime}
    if app_properties:
        meta["appProperties"] = app_properties
    r = requests.post(
        DRIVE_UPLOAD_API,
        params={"uploadType": "resumable", "supportsAllDrives": "true"},
        headers={
            **auth_headers(),
            "X-Upload-Content-Type": mime,
            "X-Upload-Content-Length": str(size),
            "Origin": ALLOWED_ORIGIN,
        },
        json=meta,
        timeout=15,
    )
    r.raise_for_status()
    return r.headers["Location"]


def get_file(file_id):
    r = requests.get(
        f"{DRIVE_API}/{file_id}",
        params={"fields": "id,name,size,parents,appProperties", "supportsAllDrives": "true"},
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


def create_json_file(folder_id, name, data, app_properties):
    """小さな JSON ファイルをドライブに作る。appProperties で入力ページごとに探せるようにする"""
    boundary = secrets.token_hex(16)
    meta = {"name": name, "parents": [folder_id], "mimeType": "application/json",
            "appProperties": app_properties}
    body = (
        f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(meta, ensure_ascii=False)}\r\n"
        f"--{boundary}\r\nContent-Type: application/json\r\n\r\n"
        f"{json.dumps(data, ensure_ascii=False)}\r\n--{boundary}--"
    ).encode()
    r = requests.post(
        DRIVE_UPLOAD_API,
        params={"uploadType": "multipart", "fields": "id", "supportsAllDrives": "true"},
        headers={**auth_headers(), "Content-Type": f"multipart/related; boundary={boundary}"},
        data=body,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["id"]


def list_form_files(form_id):
    """入力ページに送られた入力内容のファイルを、新しい順に返す"""
    return list_by_property("kabaForm", form_id)


def list_by_property(key, value):
    """appProperties の key が value のファイルを、新しい順に返す（value は形を確かめた値だけ渡す）"""
    files, page = [], None
    while True:
        params = {
            "q": f"appProperties has {{ key='{key}' and value='{value}' }} and trashed = false",
            "fields": "nextPageToken, files(id, name, createdTime, appProperties)",
            "orderBy": "createdTime desc",
            "pageSize": 1000,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        if page:
            params["pageToken"] = page
        r = requests.get(DRIVE_API, params=params, headers=auth_headers(), timeout=30)
        r.raise_for_status()
        data = r.json()
        files += data.get("files", [])
        page = data.get("nextPageToken")
        if not page:
            return files


def open_download(file_id):
    """ファイルの中身を少しずつ読むための応答を返す（大きなファイル用）"""
    r = requests.get(
        f"{DRIVE_API}/{file_id}",
        params={"alt": "media", "supportsAllDrives": "true"},
        headers=auth_headers(),
        timeout=60,
        stream=True,
    )
    r.raise_for_status()
    return r


def download_json(file_id):
    r = requests.get(
        f"{DRIVE_API}/{file_id}",
        params={"alt": "media", "supportsAllDrives": "true"},
        headers=auth_headers(),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


# --- 顧問先の対応表（URLの鍵 → ドライブのフォルダ） ---

_clients_lock = threading.Lock()


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_json(path, data):
    # 書きかけのファイルを読まないよう、別名で書いてから置き換える。
    # root がコマンドで書いても、受付サーバー（DATA_DIR の持ち主）が書き続けられるようにする
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    st = os.stat(path if os.path.exists(path) else os.path.dirname(path))
    os.chown(tmp, st.st_uid, st.st_gid)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def root_folder():
    """「顧問先資料」フォルダのIDを返す。なければ作る"""
    root = load_json(ROOT_FILE)
    if not root:
        root = {"folder_id": create_folder(ROOT_NAME)}
        save_json(ROOT_FILE, root)
    return root["folder_id"]


def check_code(code):
    if not isinstance(code, str) or not CODE_RE.match(code):
        raise UploadError(400, "番号は半角英数字（20文字以内）で入力してください。")
    return code


def find_token(clients, code):
    for token, c in clients.items():
        if c["code"] == code:
            return token
    raise UploadError(404, f"{code} は登録されていません。")


def list_clients():
    """[(URLの鍵, 顧問先)] を番号順に返す"""
    return sorted(load_json(CLIENTS_FILE).items(), key=lambda item: item[1]["code"])


def add_client(code):
    """フォルダを作って登録し、URLの鍵を返す"""
    check_code(code)
    with _clients_lock:
        clients = load_json(CLIENTS_FILE)
        if any(c["code"] == code for c in clients.values()):
            raise UploadError(409, f"{code} はすでに登録されています。")
        folder_id = create_folder(code, root_folder())
        token = secrets.token_urlsafe(32)
        clients[token] = {"code": code, "folder_id": folder_id, "created": f"{datetime.now(JST):%Y-%m-%d}"}
        save_json(CLIENTS_FILE, clients)
    return token


def remove_client(code):
    """登録を削除する（URLは使えなくなる。フォルダと資料は残る）"""
    check_code(code)
    with _clients_lock:
        clients = load_json(CLIENTS_FILE)
        del clients[find_token(clients, code)]
        save_json(CLIENTS_FILE, clients)


def reissue_client(code):
    """同じフォルダのまま、新しいURLの鍵に取り替える"""
    check_code(code)
    with _clients_lock:
        clients = load_json(CLIENTS_FILE)
        client = clients.pop(find_token(clients, code))
        token = secrets.token_urlsafe(32)
        clients[token] = client
        save_json(CLIENTS_FILE, clients)
    return token


def find_folder(code):
    """顧問先の番号から、ドライブのフォルダのIDを返す"""
    for c in load_json(CLIENTS_FILE).values():
        if c["code"] == code:
            return c["folder_id"]
    return None


# --- 入力ページ ---

_forms_lock = threading.Lock()


def text(value, limit, name, required=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise UploadError(400, f"{name}を確認してください（{limit}文字以内）。")
    return value.strip()


def check_int(value, low, high, default, message):
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise UploadError(400, message)
    return value


def check_field(f, ids, in_group=False):
    if not isinstance(f, dict):
        raise UploadError(400, "項目の形式が正しくありません。")
    fid = f.get("id")
    if not isinstance(fid, str) or not FIELD_ID_RE.match(fid) or fid in ids:
        raise UploadError(400, "項目の番号が正しくありません。")
    ids.add(fid)
    if len(ids) > MAX_FIELDS:
        raise UploadError(400, f"項目は{MAX_FIELDS}個までです。")
    ftype = f.get("type")
    if ftype not in FIELD_TYPES:
        raise UploadError(400, "項目の種類が正しくありません。")
    # 区切り線・空白・枠・ページ区切りは名前がなくてもよい。説明文は本文を label に入れる
    label_required = ftype not in ("divider", "spacer", "group", "page")
    field = {
        "id": fid,
        "type": ftype,
        "label": text(f.get("label", ""), 2000 if ftype == "note" else 200,
                      "説明文" if ftype == "note" else "項目名", required=label_required),
        "help": text(f.get("help", ""), 500, "説明"),
        "required": f.get("required") is True and ftype not in LAYOUT_TYPES,
        # 横12マスのうち何マス使うか。newRow なら行の頭から置く
        "width": check_int(f.get("width"), 1, 12, 12, "項目の幅は1〜12マスで指定してください。"),
        "newRow": f.get("newRow") is True,
    }
    # 項目名を画面に出さない（CSV の列名とエラーの表示には使うので、項目名は必要）
    if ftype not in LAYOUT_TYPES and f.get("hideLabel") is True:
        field["hideLabel"] = True
    # 項目ごとの位置の設定（なければ入力ページの設定どおり）
    if ftype not in LAYOUT_TYPES and ftype != "table" and f.get("labelPosition") in LABEL_POSITIONS:
        field["labelPosition"] = f["labelPosition"]
    if ftype in PLACEHOLDER_TYPES and f.get("helpPosition") in HELP_POSITIONS:
        field["helpPosition"] = f["helpPosition"]
    if ftype == "note":
        field["style"] = f.get("style") if f.get("style") in NOTE_STYLES else "normal"
    if ftype == "page":
        # ページ区切り：ここから次のページ。label は次のページの見出し
        if in_group:
            raise UploadError(400, "枠の中にページ区切りは置けません。")
        field["width"] = 12
        field["newRow"] = True
    if ftype == "group":
        if in_group:
            raise UploadError(400, "枠の中に枠は置けません。")
        children = f.get("children", [])
        if not isinstance(children, list):
            raise UploadError(400, "枠の中の項目の形式が正しくありません。")
        field["children"] = [check_field(c, ids, in_group=True) for c in children]
    if ftype == "checkbox":
        # チェックの横の文言（空なら画面では「はい」）
        field["checkText"] = text(f.get("checkText", ""), 100, "チェックの横の文言")
    if ftype == "checkboxes":
        # 選択肢をいくつでも選べるチェック。縦に並べるか横に並べるか
        field["direction"] = "horizontal" if f.get("direction") == "horizontal" else "vertical"
        # 1つだけ選べる（丸いボタン）
        field["single"] = f.get("single") is True
    if ftype == "file":
        field["maxFiles"] = check_int(f.get("maxFiles"), 1, MAX_FILES, 1,
                                      f"「{field['label']}」のファイルの数は1〜{MAX_FILES}個で指定してください。")
    if ftype in ("select", "checkboxes"):
        options = f.get("options")
        if not isinstance(options, list) or not 1 <= len(options) <= 100:
            raise UploadError(400, f"「{field['label']}」の選択肢を1〜100個で入力してください。")
        field["options"] = [text(o, 100, "選択肢", required=True) for o in options]
    if ftype == "table":
        check_table(f, field)
    return field


def check_table(f, field):
    columns = f.get("columns")
    if not isinstance(columns, list) or not 1 <= len(columns) <= 20:
        raise UploadError(400, f"「{field['label']}」の列を1〜20個で入力してください。")
    col_ids = set()
    field["columns"] = []
    for c in columns:
        if not isinstance(c, dict) or c.get("type") not in COLUMN_TYPES:
            raise UploadError(400, "表の列の種類が正しくありません。")
        cid = c.get("id")
        if not isinstance(cid, str) or not FIELD_ID_RE.match(cid) or cid in col_ids:
            raise UploadError(400, "表の列の番号が正しくありません。")
        col_ids.add(cid)
        field["columns"].append({
            "id": cid,
            "type": c["type"],
            "label": text(c.get("label"), 100, "列名", required=True),
            # 列の幅（ほかの列との比。1〜10）
            "width": check_int(c.get("width"), 1, 10, 1, "列の幅は1〜10で指定してください。"),
            # 数字の列だけ、表の下に合計を出せる
            "sum": c.get("sum") is True and c["type"] == "number",
        })
        if c["type"] == "select":
            # 選択肢の列：マスごとにプルダウンで選ぶ
            options = c.get("options")
            if not isinstance(options, list) or not 1 <= len(options) <= 100:
                raise UploadError(400, f"「{field['label']}」の列「{field['columns'][-1]['label']}」の選択肢を1〜100個で入力してください。")
            field["columns"][-1]["options"] = [text(o, 100, "選択肢", required=True) for o in options]
    # 行の名前（例：1月〜12月）があれば、行数が決まった表にする
    row_labels = f.get("rowLabels")
    if row_labels:
        if not isinstance(row_labels, list) or len(row_labels) > 50:
            raise UploadError(400, f"「{field['label']}」の行の名前は50行までです。")
        field["rowLabels"] = [text(r, 100, "行の名前", required=True) for r in row_labels]
        field["maxRows"] = len(field["rowLabels"])
    else:
        field["maxRows"] = check_int(f.get("maxRows"), 1, 50, None, f"「{field['label']}」の行数は1〜50で入力してください。")
        if field["maxRows"] is None:
            raise UploadError(400, f"「{field['label']}」の行数は1〜50で入力してください。")


def iter_fields(fields):
    """枠の中の項目も含めて、すべての項目を順に返す"""
    for f in fields:
        yield f
        yield from f.get("children", [])


def has_mynumber(fields):
    return any(f["type"] == "mynumber" or any(c["type"] == "mynumber" for c in f.get("columns", []))
               for f in iter_fields(fields))


def has_file(fields):
    return any(f["type"] == "file" for f in iter_fields(fields))


def check_form(form):
    """事務所内ページから送られた入力ページの定義を確かめて、保存する形に整える"""
    if not isinstance(form, dict):
        raise UploadError(400, "入力ページの形式が正しくありません。")
    fields = form.get("fields")
    if not isinstance(fields, list) or not 1 <= len(fields) <= MAX_FIELDS:
        raise UploadError(400, f"項目を1〜{MAX_FIELDS}個で作ってください。")
    ids = set()
    fields = [check_field(f, ids) for f in fields]
    if all(f["type"] in LAYOUT_TYPES for f in iter_fields(fields)):
        raise UploadError(400, "入力する項目を1つ以上作ってください。")
    encrypt = form.get("encrypt") is not False
    if not encrypt and has_mynumber(fields):
        raise UploadError(400, "マイナンバーの項目がある入力ページは、暗号化を外せません。")
    if not encrypt and has_file(fields):
        raise UploadError(400, "ファイルの項目がある入力ページは、暗号化を外せません。")
    return {
        "title": text(form.get("title"), 100, "入力ページの名前", required=True),
        "description": text(form.get("description", ""), 2000, "説明"),
        "encrypt": encrypt,
        # 顧問先が保存する PDF で、項目を枠で囲むか
        "pdfBorder": form.get("pdfBorder") is not False,
        "labelPosition": form.get("labelPosition") if form.get("labelPosition") in LABEL_POSITIONS else "top",
        "helpPosition": form.get("helpPosition") if form.get("helpPosition") in HELP_POSITIONS else "above",
        "fields": fields,
    }


def check_form_id(form_id):
    if not isinstance(form_id, str) or not FORM_ID_RE.match(form_id):
        raise UploadError(400, "入力ページが見つかりません。")
    return form_id


def find_form(forms, form_id):
    form = forms.get(check_form_id(form_id))
    if not form:
        raise UploadError(404, "入力ページが見つかりません。")
    return form


def check_b64(value, limit):
    if not isinstance(value, str) or not 0 < len(value) <= limit or not B64_RE.match(value):
        raise UploadError(400, "送信内容の形式が正しくありません。")
    return value


def check_answers(form, answers):
    """暗号化しない入力ページの入力内容を確かめる（項目にない値や大きすぎる値は受け付けない）"""
    if not isinstance(answers, dict):
        raise UploadError(400, "送信内容の形式が正しくありません。")
    fields = {f["id"]: f for f in iter_fields(form["fields"]) if f["type"] not in LAYOUT_TYPES}
    for key, value in answers.items():
        f = fields.get(key)
        if f is None:
            raise UploadError(400, "送信内容の形式が正しくありません。")
        if f["type"] == "checkbox":
            ok = isinstance(value, bool)
        elif f["type"] == "checkboxes":
            ok = (isinstance(value, list) and all(isinstance(v, str) and v in f["options"] for v in value)
                  and (len(value) <= 1 or not f.get("single")))
        elif f["type"] == "table":
            cols = {c["id"]: c for c in f["columns"]}
            ok = isinstance(value, list) and len(value) <= f["maxRows"] and all(
                isinstance(row, dict) and set(row) <= set(cols)
                and all(isinstance(v, str) and len(v) <= 500 for v in row.values())
                # 選択肢の列は、選択肢のどれかか空
                and all(v in ("", *cols[k]["options"]) for k, v in row.items() if cols[k]["type"] == "select")
                for row in value)
        else:
            ok = isinstance(value, str) and len(value) <= 5000
        if not ok:
            raise UploadError(400, "送信内容の形式が正しくありません。")
    return answers


def find_request(token):
    if not isinstance(token, str) or not TOKEN_RE.match(token):
        raise UploadError(403, "このURLは無効です。事務所にお問い合わせください。")
    req = load_json(REQUESTS_FILE).get(token)
    form = load_json(FORMS_FILE).get(req["form_id"]) if req else None
    if not form:
        raise UploadError(403, "このURLは無効です。事務所にお問い合わせください。")
    return req, form


def public_key():
    key = load_json(KEY_FILE)
    return key if key.get("spki") else None


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


def handle_form_get(body):
    _, form = find_request(body.get("token"))
    data = {k: form[k] for k in ("title", "description", "encrypt", "fields")}
    # 設定を作る前の入力ページは、枠あり・項目名は上・説明は入力欄の上
    data["pdfBorder"] = form.get("pdfBorder", True)
    data["labelPosition"] = form.get("labelPosition", "top")
    data["helpPosition"] = form.get("helpPosition", "above")
    if form["encrypt"]:
        key = public_key()
        if not key:
            raise UploadError(503, "この入力ページは準備中です。事務所にお問い合わせください。")
        data["publicKey"] = key["spki"]
        data["keyId"] = key["fingerprint"]
    return data


def handle_form_submit(body):
    token = body.get("token")
    req, form = find_request(token)
    folder_id = find_folder(req["code"])
    if not folder_id:
        raise UploadError(403, "このURLは無効です。事務所にお問い合わせください。")
    if form["encrypt"]:
        enc = body.get("encrypted")
        key = public_key()
        if not isinstance(enc, dict) or not key:
            raise UploadError(400, "送信内容の形式が正しくありません。")
        if enc.get("keyId") != key["fingerprint"]:
            raise UploadError(409, "ページが古くなっています。ページを読み込み直してから、もう一度入力してください。")
        content = {"encrypted": {
            "keyId": key["fingerprint"],
            "key": check_b64(enc.get("key"), 2048),
            "iv": check_b64(enc.get("iv"), 64),
            "data": check_b64(enc.get("data"), 240 * 1024),
        }}
    else:
        content = {"answers": check_answers(form, body.get("answers"))}
    batch = body.get("batch")
    if batch is not None and (not isinstance(batch, str) or not BATCH_RE.match(batch)):
        raise UploadError(400, "送信内容の形式が正しくありません。")
    check_rate(token)
    now = datetime.now(JST)
    record = {
        "version": 1,
        "formId": req["form_id"],
        "formTitle": form["title"],
        "code": req["code"],
        "submitted": now.isoformat(timespec="seconds"),
        # あとで入力ページを直しても読めるように、送信時点の項目を残す
        "fields": form["fields"],
        **content,
    }
    title = form_title_for_name(form)
    props = {"kabaForm": req["form_id"], "kabaCode": req["code"]}
    if batch:
        props["kabaBatch"] = batch   # 一緒に送られたファイル（入力内容を削除するときに一緒に消す）
    create_json_file(folder_id, f"{now:%Y%m%d-%H%M%S}_{title}.json", record, props)
    # 入力内容は記録に残さない
    log.info("form submitted code=%s form=%s encrypted=%s", req["code"], req["form_id"], form["encrypt"])
    return {"ok": True, "submitted": record["submitted"]}


def form_title_for_name(form):
    return re.sub(r'[\x00-\x1f\x7f/\\:*?"<>|]', "_", form["title"])[:60]


def handle_form_file_session(body):
    """入力ページのファイル（ブラウザで暗号化したもの）の受付口を発行する。元のファイル名は受け取らない"""
    token = body.get("token")
    req, form = find_request(token)
    field_id = body.get("fieldId")
    if not any(f["id"] == field_id and f["type"] == "file" for f in iter_fields(form["fields"])):
        raise UploadError(400, "送信内容の形式が正しくありません。")
    size = body.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or size <= len(FILE_MAGIC):
        raise UploadError(400, "ファイルが空です。")
    if size > MAX_ENCRYPTED_SIZE:
        raise UploadError(400, "50MBを超えるファイルは送信できません。")
    batch = body.get("batch")
    if not isinstance(batch, str) or not BATCH_RE.match(batch):
        raise UploadError(400, "送信内容の形式が正しくありません。")
    folder_id = find_folder(req["code"])
    if not folder_id:
        raise UploadError(403, "このURLは無効です。事務所にお問い合わせください。")
    check_rate(token)
    name = f"{datetime.now(JST):%Y%m%d-%H%M%S}_{form_title_for_name(form)}_添付_{secrets.token_hex(3)}.enc"
    url = create_upload_session(folder_id, name, "application/octet-stream", size,
                                {"kabaFileOf": req["form_id"], "kabaCode": req["code"], "kabaBatch": batch})
    log.info("form file session code=%s form=%s size=%d", req["code"], req["form_id"], size)
    return {"uploadUrl": url}


def handle_form_file_complete(body):
    """送られたファイルが、この顧問先のフォルダにある暗号化したファイルか確かめる。違えばゴミ箱へ"""
    req, form = find_request(body.get("token"))
    file_id = body.get("fileId")
    if not isinstance(file_id, str) or not FILE_ID_RE.match(file_id):
        raise UploadError(400, "ファイルが見つかりません。")
    f = get_file(file_id)
    folder_id = find_folder(req["code"])
    if (f is None or folder_id not in f.get("parents", [])
            or f.get("appProperties", {}).get("kabaFileOf") != req["form_id"]):
        raise UploadError(404, "ファイルが見つかりません。")
    size = int(f.get("size", 0))
    if not len(FILE_MAGIC) < size <= MAX_ENCRYPTED_SIZE or read_head(file_id, len(FILE_MAGIC)) != FILE_MAGIC:
        trash_file(file_id)
        log.warning("form file rejected code=%s form=%s size=%d", req["code"], req["form_id"], size)
        raise UploadError(400, "ファイルを受け付けられませんでした。もう一度お試しください。")
    return {"ok": True}


def client_view(token, client):
    return {
        "code": client["code"],
        "created": client.get("created", ""),
        "folderUrl": f"https://drive.google.com/drive/folders/{client['folder_id']}",
        "uploadUrl": UPLOAD_BASE_URL + token,
    }


def handle_staff_list(body):
    return {"clients": [client_view(t, c) for t, c in list_clients()]}


def handle_staff_add(body):
    token = add_client(body.get("code"))
    return {"client": client_view(token, load_json(CLIENTS_FILE)[token])}


def handle_staff_remove(body):
    remove_client(body.get("code"))
    return {"ok": True}


def handle_staff_reissue(body):
    token = reissue_client(body.get("code"))
    return {"client": client_view(token, load_json(CLIENTS_FILE)[token])}


def handle_staff_qr(body):
    clients = load_json(CLIENTS_FILE)
    token = find_token(clients, check_code(body.get("code")))
    qr = segno.make(UPLOAD_BASE_URL + token, error="m")
    return {"dataUrl": qr.png_data_uri(scale=8, border=4)}


def form_view(form_id, form, requests_count):
    return {"id": form_id, **form, "requests": requests_count}


def handle_forms_list(body):
    forms = load_json(FORMS_FILE)
    counts = {}
    for req in load_json(REQUESTS_FILE).values():
        counts[req["form_id"]] = counts.get(req["form_id"], 0) + 1
    items = sorted(forms.items(), key=lambda item: item[1].get("updated", ""), reverse=True)
    key = public_key()
    return {
        "forms": [form_view(i, f, counts.get(i, 0)) for i, f in items],
        "key": {"fingerprint": key["fingerprint"], "set": key.get("set", "")} if key else None,
    }


def handle_forms_save(body):
    form = check_form(body.get("form"))
    today = f"{datetime.now(JST):%Y-%m-%d %H:%M}"
    with _forms_lock:
        forms = load_json(FORMS_FILE)
        form_id = body.get("id")
        if form_id is None:
            form_id = "f" + secrets.token_hex(6)
            form["created"] = today
        else:
            form["created"] = find_form(forms, form_id).get("created", today)
        form["updated"] = today
        forms[form_id] = form
        save_json(FORMS_FILE, forms)
    return {"form": form_view(form_id, form, 0)}


def handle_forms_remove(body):
    """入力ページと、その依頼URLを削除する（送られた入力内容はドライブに残る）"""
    with _forms_lock:
        forms = load_json(FORMS_FILE)
        find_form(forms, body.get("id"))
        del forms[body["id"]]
        save_json(FORMS_FILE, forms)
        reqs = {t: r for t, r in load_json(REQUESTS_FILE).items() if r["form_id"] != body["id"]}
        save_json(REQUESTS_FILE, reqs)
    return {"ok": True}


def handle_key_set(body):
    """事務所の公開鍵を登録する。秘密鍵は職員のブラウザで作られ、ここには来ない"""
    spki = check_b64(body.get("spki"), 2048)
    der = base64.b64decode(spki)
    if not 256 <= len(der) <= 1024:
        raise UploadError(400, "鍵の形式が正しくありません。")
    with _forms_lock:
        if public_key() and body.get("replace") is not True:
            raise UploadError(409, "鍵はすでに登録されています。")
        key = {"spki": spki, "fingerprint": hashlib.sha256(der).hexdigest(), "set": f"{datetime.now(JST):%Y-%m-%d %H:%M}"}
        save_json(KEY_FILE, key)
    return {"key": {"fingerprint": key["fingerprint"], "set": key["set"]}}


def request_view(token, req):
    return {"token": token, "code": req["code"], "created": req.get("created", ""), "url": FORM_BASE_URL + token}


def handle_requests_list(body):
    form_id = check_form_id(body.get("formId"))
    reqs = [request_view(t, r) for t, r in load_json(REQUESTS_FILE).items() if r["form_id"] == form_id]
    return {"requests": sorted(reqs, key=lambda r: r["code"])}


def handle_requests_add(body):
    """顧問先に入力ページのURLを発行する（同じ顧問先にはすでにあるURLを返す）"""
    code = check_code(body.get("code"))
    with _forms_lock:
        find_form(load_json(FORMS_FILE), body.get("formId"))
        if not find_folder(code):
            raise UploadError(404, f"{code} は登録されていません。")
        reqs = load_json(REQUESTS_FILE)
        for t, r in reqs.items():
            if r["form_id"] == body["formId"] and r["code"] == code:
                return {"request": request_view(t, r)}
        token = secrets.token_urlsafe(32)
        reqs[token] = {"form_id": body["formId"], "code": code, "created": f"{datetime.now(JST):%Y-%m-%d}"}
        save_json(REQUESTS_FILE, reqs)
    return {"request": request_view(token, reqs[token])}


def find_request_token(token):
    reqs = load_json(REQUESTS_FILE)
    if not isinstance(token, str) or token not in reqs:
        raise UploadError(404, "URLが見つかりません。")
    return reqs


def handle_requests_remove(body):
    with _forms_lock:
        reqs = find_request_token(body.get("token"))
        del reqs[body["token"]]
        save_json(REQUESTS_FILE, reqs)
    return {"ok": True}


def handle_requests_qr(body):
    find_request_token(body.get("token"))
    qr = segno.make(FORM_BASE_URL + body["token"], error="m")
    return {"dataUrl": qr.png_data_uri(scale=8, border=4)}


def handle_submissions_list(body):
    form_id = check_form_id(body.get("formId"))
    return {"submissions": [
        {"id": f["id"], "code": f.get("appProperties", {}).get("kabaCode", ""), "submitted": f.get("createdTime", "")}
        for f in list_form_files(form_id)
    ]}


def find_submission(file_id):
    """入力ページから送られたファイルだけを扱う（アップロードされた資料などは開かない）"""
    if not isinstance(file_id, str) or not FILE_ID_RE.match(file_id):
        raise UploadError(400, "ファイルが見つかりません。")
    f = get_file(file_id)
    if f is None or "kabaForm" not in f.get("appProperties", {}):
        raise UploadError(404, "ファイルが見つかりません。")
    return f


def handle_submissions_get(body):
    f = find_submission(body.get("id"))
    if int(f.get("size", 0)) > MAX_RECORD:
        raise UploadError(400, "ファイルが大きすぎます。")
    return {"record": download_json(f["id"])}


def handle_submissions_remove(body):
    """ドライブのゴミ箱に移す（ゴミ箱からは30日後に完全に削除される）。一緒に送られたファイルも移す"""
    f = find_submission(body.get("id"))
    trash_file(f["id"])
    batch = f.get("appProperties", {}).get("kabaBatch")
    if batch and BATCH_RE.match(batch):
        for attached in list_by_property("kabaBatch", batch):
            if "kabaFileOf" in attached.get("appProperties", {}):
                trash_file(attached["id"])
    return {"ok": True}


class FileResponse:
    """JSON ではなく、ファイルの中身をそのまま返す応答"""
    def __init__(self, response):
        self.response = response


def handle_submissions_file(body):
    """入力ページで添付されたファイル（暗号化したまま）を返す。事務所のブラウザで復号する"""
    file_id = body.get("id")
    if not isinstance(file_id, str) or not FILE_ID_RE.match(file_id):
        raise UploadError(400, "ファイルが見つかりません。")
    f = get_file(file_id)
    if f is None or "kabaFileOf" not in f.get("appProperties", {}):
        raise UploadError(404, "ファイルが見つかりません。")
    if int(f.get("size", 0)) > MAX_ENCRYPTED_SIZE:
        raise UploadError(400, "ファイルが大きすぎます。")
    return FileResponse(open_download(file_id))


ROUTES = {
    "/session": handle_session,
    "/complete": handle_complete,
    "/form/get": handle_form_get,
    "/form/submit": handle_form_submit,
    "/form/file-session": handle_form_file_session,
    "/form/file-complete": handle_form_file_complete,
}

# 顧問先用とは別のポートで受ける。顧問先用の入口から管理の機能に届かないようにするため
STAFF_ROUTES = {
    "/clients/list": handle_staff_list,
    "/clients/add": handle_staff_add,
    "/clients/remove": handle_staff_remove,
    "/clients/reissue": handle_staff_reissue,
    "/clients/qr": handle_staff_qr,
    "/forms/list": handle_forms_list,
    "/forms/save": handle_forms_save,
    "/forms/remove": handle_forms_remove,
    "/key/set": handle_key_set,
    "/requests/list": handle_requests_list,
    "/requests/add": handle_requests_add,
    "/requests/remove": handle_requests_remove,
    "/requests/qr": handle_requests_qr,
    "/submissions/list": handle_submissions_list,
    "/submissions/get": handle_submissions_get,
    "/submissions/remove": handle_submissions_remove,
    "/submissions/file": handle_submissions_file,
}
# 見るだけの API（変更の記録を残さない）
STAFF_READ_ONLY = {"/clients/list", "/clients/qr", "/forms/list", "/requests/list", "/requests/qr",
                   "/submissions/list"}


class Handler(BaseHTTPRequestHandler):
    server_version = "kabaoffice-upload"
    routes = ROUTES

    def do_POST(self):
        try:
            if self.headers.get("Origin") != ALLOWED_ORIGIN:
                raise UploadError(403, "不正なリクエストです。")
            route = self.routes.get(self.path)
            if route is None:
                raise UploadError(404, "見つかりません。")
            body = self.read_json()
            data = route(body)
            self.after_route(body)
            if isinstance(data, FileResponse):
                self.send_file(data.response)
            else:
                self.send_json(200, data)
        except UploadError as e:
            self.send_json(e.status, {"error": e.message})
        except Exception:
            log.exception("unexpected error")
            self.send_json(500, {"error": "サーバーでエラーが起きました。時間をおいて再度お試しください。"})

    def after_route(self, body):
        pass

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = -1
        if not 0 < length <= BODY_LIMITS.get(self.path, MAX_BODY):
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

    def send_file(self, response):
        with response:
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            if response.headers.get("Content-Length"):
                self.send_header("Content-Length", response.headers["Content-Length"])
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            for chunk in response.iter_content(1024 * 1024):
                self.wfile.write(chunk)

    def log_message(self, format, *args):
        log.info(format, *args)


class StaffHandler(Handler):
    routes = STAFF_ROUTES

    def after_route(self, body):
        # 誰が変更したか（入力内容を開いたか）を残す。ユーザー名は nginx のベーシック認証から
        if self.path not in STAFF_READ_ONLY:
            target = " ".join(f"{k}={body[k]}" for k in ("code", "id", "formId") if isinstance(body.get(k), str))
            log.info("staff=%s %s %s", self.headers.get("X-Staff-User", "-"), self.path, target)


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    staff = ThreadingHTTPServer(("127.0.0.1", STAFF_PORT), StaffHandler)
    threading.Thread(target=staff.serve_forever, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log.info("listening on 127.0.0.1:%d (staff %d)", PORT, STAFF_PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
