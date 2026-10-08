"""server.py のテスト（Google ドライブには接続せず、ダミーに置き換える）

実行: cd app && python -m unittest test_server
"""
import base64
import email
import hashlib
import http.client
import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest import mock

_config_dir = tempfile.TemporaryDirectory()
os.environ["UPLOAD_CONFIG_DIR"] = _config_dir.name
os.environ["UPLOAD_DATA_DIR"] = _config_dir.name

import server  # noqa: E402

TOKEN = "dummyTokenAbcdefghijklmnopqrstuvwxyz0123456"
FOLDER = "dummyFolderId0123456789"
ORIGIN = server.ALLOWED_ORIGIN


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(server.CLIENTS_FILE, "w", encoding="utf-8") as f:
            json.dump({TOKEN: {"code": "C001", "folder_id": FOLDER}}, f)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        server._hits.clear()
        patches = {
            "create_upload_session": mock.Mock(return_value="https://upload.example/session"),
            "get_file": mock.Mock(return_value={"id": "file123456", "name": "20261006-120000_a.pdf",
                                                "size": "1000", "parents": [FOLDER]}),
            "read_head": mock.Mock(return_value=b"%PDF-1.7\n"),
            "trash_file": mock.Mock(),
        }
        for name, m in patches.items():
            p = mock.patch.object(server, name, m)
            p.start()
            self.addCleanup(p.stop)
        self.drive = patches

    def post(self, path, body, origin=ORIGIN):
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1])
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        conn.request("POST", path, json.dumps(body), headers)
        res = conn.getresponse()
        data = json.loads(res.read())
        conn.close()
        return res.status, data

    def session(self, **kw):
        return self.post("/session", {"token": TOKEN, "name": "領収書.pdf", "size": 1000, **kw})

    # --- /session ---

    def test_session_ok(self):
        status, data = self.session()
        self.assertEqual(status, 200)
        self.assertEqual(data, {"uploadUrl": "https://upload.example/session", "mimeType": "application/pdf"})
        folder, name, mime, size = self.drive["create_upload_session"].call_args.args
        self.assertEqual((folder, mime, size), (FOLDER, "application/pdf", 1000))
        self.assertRegex(name, r"^\d{8}-\d{6}_領収書\.pdf$")

    def test_wrong_origin(self):
        status, _ = self.post("/session", {"token": TOKEN, "name": "a.pdf", "size": 1}, origin="https://evil.example")
        self.assertEqual(status, 403)
        status, _ = self.post("/session", {"token": TOKEN, "name": "a.pdf", "size": 1}, origin=None)
        self.assertEqual(status, 403)

    def test_unknown_token(self):
        status, _ = self.session(token="x" * 43)
        self.assertEqual(status, 403)
        status, _ = self.session(token="../../etc")
        self.assertEqual(status, 403)

    def test_bad_extension(self):
        for name in ("a.exe", "a.pdf.exe", "noext", ".pdf"):
            status, _ = self.session(name=name)
            self.assertEqual(status, 400, name)
        self.drive["create_upload_session"].assert_not_called()

    def test_size_limits(self):
        self.assertEqual(self.session(size=0)[0], 400)
        self.assertEqual(self.session(size=server.MAX_SIZE + 1)[0], 400)
        self.assertEqual(self.session(size="1000")[0], 400)
        self.assertEqual(self.session(size=True)[0], 400)
        self.assertEqual(self.session(size=server.MAX_SIZE)[0], 200)

    def test_path_in_name_is_removed(self):
        self.session(name="../../C:\\秘密\\明細.PDF")
        name = self.drive["create_upload_session"].call_args.args[1]
        self.assertRegex(name, r"^\d{8}-\d{6}_明細\.pdf$")

    def test_rate_limit(self):
        with mock.patch.object(server, "RATE_LIMIT", 3):
            codes = [self.session()[0] for _ in range(4)]
        self.assertEqual(codes, [200, 200, 200, 429])

    def test_unknown_path_and_bad_body(self):
        self.assertEqual(self.post("/other", {})[0], 404)
        self.assertEqual(self.post("/session", [])[0], 400)

    def test_google_error_is_hidden(self):
        self.drive["create_upload_session"].side_effect = RuntimeError("secret detail")
        with self.assertLogs("upload", "ERROR"):
            status, data = self.session()
        self.assertEqual(status, 500)
        self.assertNotIn("secret", data["error"])

    # --- /complete ---

    def complete(self, file_id="file123456"):
        return self.post("/complete", {"token": TOKEN, "fileId": file_id})

    def test_complete_ok(self):
        self.assertEqual(self.complete(), (200, {"ok": True}))
        self.drive["trash_file"].assert_not_called()

    def test_complete_other_folder(self):
        self.drive["get_file"].return_value["parents"] = ["otherFolder"]
        self.assertEqual(self.complete()[0], 404)
        self.drive["trash_file"].assert_not_called()

    def test_complete_missing_file(self):
        self.drive["get_file"].return_value = None
        self.assertEqual(self.complete()[0], 404)

    def test_complete_bad_content_is_trashed(self):
        self.drive["read_head"].return_value = b"MZ\x90\x00"
        self.assertEqual(self.complete()[0], 400)
        self.drive["trash_file"].assert_called_once_with("file123456")

    def test_complete_too_large_is_trashed(self):
        self.drive["get_file"].return_value["size"] = str(server.MAX_SIZE + 1)
        self.assertEqual(self.complete()[0], 400)
        self.drive["trash_file"].assert_called_once()

    def test_complete_bad_file_id(self):
        self.assertEqual(self.complete("../x")[0], 400)


class LooksLikeTest(unittest.TestCase):
    def test_signatures(self):
        ok = {
            ".pdf": b"%PDF-1.4",
            ".jpg": b"\xff\xd8\xff\xe0",
            ".png": b"\x89PNG\r\n\x1a\n",
            ".heic": b"\x00\x00\x00\x18ftypheic",
            ".xlsx": b"PK\x03\x04",
            ".doc": b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",
            ".csv": "日付,金額\n".encode(),
        }
        for ext, head in ok.items():
            self.assertTrue(server.looks_like(ext, head), ext)
        self.assertFalse(server.looks_like(".pdf", b"PK\x03\x04"))
        self.assertFalse(server.looks_like(".csv", b"a\x00b"))
        self.assertFalse(server.looks_like(".exe", b"MZ"))


class StaffTest(unittest.TestCase):
    """顧問先の対応表と、事務所内ページ用の API"""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        for name, path in (("CLIENTS_FILE", "clients.json"), ("ROOT_FILE", "root-folder.json")):
            p = mock.patch.object(server, name, os.path.join(self.dir.name, path))
            p.start()
            self.addCleanup(p.stop)
        self.create_folder = mock.Mock(side_effect=["rootFolder", "folderC001", "folderC002"])
        p = mock.patch.object(server, "create_folder", self.create_folder)
        p.start()
        self.addCleanup(p.stop)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.StaffHandler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def post(self, path, body, origin=ORIGIN):
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1])
        headers = {"Content-Type": "application/json", "X-Staff-User": "staff1"}
        if origin:
            headers["Origin"] = origin
        conn.request("POST", path, json.dumps(body), headers)
        res = conn.getresponse()
        data = json.loads(res.read())
        conn.close()
        return res.status, data

    def clients(self):
        return server.load_json(server.CLIENTS_FILE)

    def test_add_creates_root_once(self):
        with self.assertLogs("upload", "INFO"):
            self.assertEqual(self.post("/clients/add", {"code": "C001"})[0], 200)
            self.assertEqual(self.post("/clients/add", {"code": "C002"})[0], 200)
        self.assertEqual(self.create_folder.call_args_list, [
            mock.call("顧問先資料"),
            mock.call("C001", "rootFolder"),
            mock.call("C002", "rootFolder"),
        ])
        clients = self.clients()
        self.assertEqual(sorted(c["folder_id"] for c in clients.values()), ["folderC001", "folderC002"])
        for token, c in clients.items():
            self.assertRegex(token, server.TOKEN_RE)
            self.assertRegex(c["created"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertEqual(os.stat(server.CLIENTS_FILE).st_mode & 0o777, 0o600)

    def test_add_response_and_list(self):
        status, data = self.post("/clients/add", {"code": "C001"})
        token = next(iter(self.clients()))
        self.assertEqual(data["client"]["uploadUrl"], server.UPLOAD_BASE_URL + token)
        self.assertEqual(data["client"]["folderUrl"], "https://drive.google.com/drive/folders/folderC001")
        status, data = self.post("/clients/list", {})
        self.assertEqual([c["code"] for c in data["clients"]], ["C001"])

    def test_add_duplicate_and_bad_code(self):
        self.post("/clients/add", {"code": "C001"})
        self.assertEqual(self.post("/clients/add", {"code": "C001"})[0], 409)
        for code in ("", "C 001", "顧問先", "../x", "x" * 21, 1):
            self.assertEqual(self.post("/clients/add", {"code": code})[0], 400, code)

    def test_remove(self):
        self.post("/clients/add", {"code": "C001"})
        self.assertEqual(self.post("/clients/remove", {"code": "C001"}), (200, {"ok": True}))
        self.assertEqual(self.clients(), {})
        self.assertEqual(self.post("/clients/remove", {"code": "C001"})[0], 404)

    def test_reissue_keeps_folder(self):
        self.post("/clients/add", {"code": "C001"})
        old_token, old = next(iter(self.clients().items()))
        status, data = self.post("/clients/reissue", {"code": "C001"})
        self.assertEqual(status, 200)
        (new_token, new), = self.clients().items()
        self.assertNotEqual(new_token, old_token)
        self.assertEqual(new, old)
        self.assertEqual(data["client"]["uploadUrl"], server.UPLOAD_BASE_URL + new_token)
        with self.assertRaises(server.UploadError):
            server.find_client(old_token)

    def test_qr(self):
        self.post("/clients/add", {"code": "C001"})
        status, data = self.post("/clients/qr", {"code": "C001"})
        self.assertEqual(status, 200)
        self.assertTrue(data["dataUrl"].startswith("data:image/png;base64,"))
        self.assertEqual(self.post("/clients/qr", {"code": "C999"})[0], 404)

    def test_wrong_origin(self):
        self.assertEqual(self.post("/clients/add", {"code": "C001"}, origin="https://evil.example")[0], 403)
        self.create_folder.assert_not_called()

    def test_upload_routes_not_on_staff_port_and_vice_versa(self):
        self.assertEqual(self.post("/session", {})[0], 404)
        self.assertNotIn("/clients/add", server.Handler.routes)

    def test_cli(self):
        import clients_admin
        with mock.patch("sys.stdout"):
            clients_admin.main(["add", "C001"])
            clients_admin.main(["reissue", "C001"])
            clients_admin.main(["list"])
            with self.assertRaises(SystemExit):
                clients_admin.main(["add", "C001"])
            clients_admin.main(["remove", "C001"])
        self.assertEqual(self.clients(), {})


class DriveRequestTest(unittest.TestCase):
    """ドライブへの送信内容（通信はダミー）"""

    def setUp(self):
        p = mock.patch.object(server, "auth_headers", return_value={"Authorization": "Bearer dummy"})
        p.start()
        self.addCleanup(p.stop)

    def test_create_json_file(self):
        res = mock.Mock(**{"json.return_value": {"id": "new123"}})
        with mock.patch.object(server.requests, "post", return_value=res) as post:
            self.assertEqual(server.create_json_file("folder1", "a.json", {"x": "値"}, {"kabaForm": "f1"}), "new123")
        kw = post.call_args.kwargs
        self.assertEqual(kw["params"]["uploadType"], "multipart")
        msg = email.message_from_bytes(
            f"Content-Type: {kw['headers']['Content-Type']}\r\n\r\n".encode() + kw["data"])
        meta, content = [json.loads(part.get_payload(decode=True)) for part in msg.get_payload()]
        self.assertEqual(meta, {"name": "a.json", "parents": ["folder1"], "mimeType": "application/json",
                                "appProperties": {"kabaForm": "f1"}})
        self.assertEqual(content, {"x": "値"})

    def test_list_form_files_pages(self):
        pages = [{"files": [{"id": "a"}], "nextPageToken": "next"}, {"files": [{"id": "b"}]}]
        res = [mock.Mock(**{"json.return_value": p}) for p in pages]
        with mock.patch.object(server.requests, "get", side_effect=res) as get:
            self.assertEqual([f["id"] for f in server.list_form_files("f000000000000")], ["a", "b"])
        first, second = [c.kwargs["params"] for c in get.call_args_list]
        self.assertIn("value='f000000000000'", first["q"])
        self.assertIn("trashed = false", first["q"])
        self.assertNotIn("pageToken", first)
        self.assertEqual(second["pageToken"], "next")


class FormTest(unittest.TestCase):
    """入力ページ（事務所内ページでの作成・URLの発行と、顧問先からの送信）"""

    SPKI = base64.b64encode(bytes(range(256)) * 2).decode()

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        for name in ("CLIENTS_FILE", "FORMS_FILE", "REQUESTS_FILE", "KEY_FILE"):
            p = mock.patch.object(server, name, os.path.join(self.dir.name, name.lower()))
            p.start()
            self.addCleanup(p.stop)
        with open(server.CLIENTS_FILE, "w", encoding="utf-8") as f:
            json.dump({TOKEN: {"code": "C001", "folder_id": FOLDER}}, f)
        server._hits.clear()
        self.drive = {
            "create_json_file": mock.Mock(return_value="newFile0123"),
            "list_form_files": mock.Mock(return_value=[]),
            "download_json": mock.Mock(return_value={"version": 1}),
            "get_file": mock.Mock(return_value={"id": "file123456", "size": "100",
                                                "appProperties": {"kabaForm": "f000000000000"}}),
            "trash_file": mock.Mock(),
            "create_upload_session": mock.Mock(return_value="https://upload.example/session"),
            "read_head": mock.Mock(return_value=server.FILE_MAGIC),
            "list_by_property": mock.Mock(return_value=[]),
        }
        for name, m in self.drive.items():
            p = mock.patch.object(server, name, m)
            p.start()
            self.addCleanup(p.stop)
        self.ports = {}
        for kind, handler in (("public", server.Handler), ("staff", server.StaffHandler)):
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            self.addCleanup(httpd.server_close)
            self.addCleanup(httpd.shutdown)
            self.ports[kind] = httpd.server_address[1]

    def post(self, path, body, kind="public"):
        conn = http.client.HTTPConnection("127.0.0.1", self.ports[kind])
        conn.request("POST", path, json.dumps(body), {"Content-Type": "application/json", "Origin": ORIGIN})
        res = conn.getresponse()
        data = json.loads(res.read())
        conn.close()
        return res.status, data

    def staff(self, path, body):
        with self.assertNoLogs("upload", "ERROR"):
            return self.post(path, body, "staff")

    def form(self, **kw):
        return {
            "title": "年末調整の確認",
            "description": "ダミーの説明",
            "fields": [
                {"id": "h1", "type": "heading", "label": "ご本人"},
                {"id": "name", "type": "text", "label": "氏名", "required": True},
                {"id": "agree", "type": "checkbox", "label": "確認しました"},
                {"id": "kind", "type": "select", "label": "区分", "options": ["甲", "乙"]},
                {"id": "family", "type": "table", "label": "扶養家族", "maxRows": 2, "columns": [
                    {"id": "name", "type": "text", "label": "氏名"},
                    {"id": "birth", "type": "date", "label": "生年月日"},
                ]},
            ],
            **kw,
        }

    def make_request(self, **kw):
        status, data = self.staff("/forms/save", {"form": self.form(**kw)})
        self.assertEqual(status, 200, data)
        form_id = data["form"]["id"]
        status, data = self.staff("/requests/add", {"formId": form_id, "code": "C001"})
        self.assertEqual(status, 200, data)
        return form_id, data["request"]["token"]

    def set_key(self):
        self.assertEqual(self.staff("/key/set", {"spki": self.SPKI})[0], 200)

    def encrypted(self, key_id=None):
        return {"keyId": key_id or server.public_key()["fingerprint"], "key": "QUJD", "iv": "QUJD", "data": "QUJD" * 2000}

    # --- 事務所内ページ ---

    def test_save_and_list(self):
        status, data = self.staff("/forms/save", {"form": self.form()})
        self.assertEqual(status, 200)
        form = data["form"]
        self.assertRegex(form["id"], server.FORM_ID_RE)
        self.assertTrue(form["encrypt"])   # 指定がなければ暗号化あり
        self.assertFalse(form["fields"][0]["required"])
        status, data = self.staff("/forms/save", {"id": form["id"], "form": self.form(title="変更後", encrypt=False)})
        self.assertEqual(status, 200)
        status, data = self.staff("/forms/list", {})
        self.assertEqual([(f["title"], f["encrypt"]) for f in data["forms"]], [("変更後", False)])
        self.assertIsNone(data["key"])

    def test_mynumber_requires_encryption(self):
        form = self.form(encrypt=False)
        form["fields"][4]["columns"].append({"id": "no", "type": "mynumber", "label": "マイナンバー"})
        self.assertEqual(self.staff("/forms/save", {"form": form})[0], 400)
        form["encrypt"] = True
        self.assertEqual(self.staff("/forms/save", {"form": form})[0], 200)

    def test_bad_forms(self):
        bad = [
            self.form(title=""),
            self.form(fields=[]),
            self.form(fields=[{"id": "h", "type": "heading", "label": "見出しだけ"}]),
            self.form(fields=[{"id": "a", "type": "script", "label": "x"}]),
            self.form(fields=[{"id": "a", "type": "text", "label": "x"}, {"id": "a", "type": "text", "label": "y"}]),
            self.form(fields=[{"id": "A-1", "type": "text", "label": "x"}]),
            self.form(fields=[{"id": "a", "type": "select", "label": "x", "options": []}]),
            self.form(fields=[{"id": "a", "type": "table", "label": "x", "maxRows": 0,
                               "columns": [{"id": "c", "type": "text", "label": "c"}]}]),
            self.form(fields=[{"id": "a", "type": "table", "label": "x", "maxRows": 3,
                               "columns": [{"id": "c", "type": "select", "label": "c"}]}]),
        ]
        for form in bad:
            self.assertEqual(self.staff("/forms/save", {"form": form})[0], 400, form["fields"])
        self.assertEqual(self.staff("/forms/save", {"id": "f123456789abc", "form": self.form()})[0], 404)

    def layout_form(self, **kw):
        return self.form(fields=[
            {"id": "g1", "type": "group", "label": "ご本人", "children": [
                {"id": "name", "type": "text", "label": "氏名", "width": 6},
                {"id": "kana", "type": "text", "label": "フリガナ", "width": 6},
                {"id": "no", "type": "mynumber", "label": "マイナンバー", "width": 4, "newRow": True},
            ]},
            {"id": "d1", "type": "divider"},
            {"id": "n1", "type": "note", "label": "注意書き", "style": "warning"},
            {"id": "s1", "type": "spacer", "width": 3},
            {"id": "monthly", "type": "table", "label": "月別", "rowLabels": ["1月", "2月"], "columns": [
                {"id": "amount", "type": "number", "label": "金額", "width": 3, "sum": True},
                {"id": "memo", "type": "text", "label": "メモ", "sum": True},
            ]},
        ], **kw)

    def test_layout_save(self):
        status, data = self.staff("/forms/save", {"form": self.layout_form(encrypt=False)})
        self.assertEqual(status, 400)   # 枠の中のマイナンバーも暗号化が必要
        status, data = self.staff("/forms/save", {"form": self.layout_form()})
        self.assertEqual(status, 200, data)
        group, divider, note, spacer, table = data["form"]["fields"]
        self.assertEqual([(c["width"], c["newRow"]) for c in group["children"]], [(6, False), (6, False), (4, True)])
        self.assertEqual((divider["label"], divider["width"]), ("", 12))
        self.assertEqual(note["style"], "warning")
        self.assertEqual(spacer["width"], 3)
        self.assertEqual(table["maxRows"], 2)
        self.assertEqual([(c["width"], c["sum"]) for c in table["columns"]], [(3, True), (1, False)])

    def test_layout_rejects(self):
        nested = self.layout_form()
        nested["fields"][0]["children"].append({"id": "g2", "type": "group", "children": []})
        bad = [
            nested,
            self.form(fields=[{"id": "a", "type": "text", "label": "x", "width": 13}]),
            self.form(fields=[{"id": "a", "type": "text", "label": "x", "width": 0}]),
            self.form(fields=[{"id": "a", "type": "note", "label": ""}, {"id": "b", "type": "text", "label": "x"}]),
            self.form(fields=[{"id": "d", "type": "divider"}, {"id": "g", "type": "group", "children": []}]),
            self.form(fields=[{"id": "a", "type": "table", "label": "x", "rowLabels": ["1月", ""],
                               "columns": [{"id": "c", "type": "text", "label": "c"}]}]),
            self.form(fields=[{"id": "a", "type": "table", "label": "x", "maxRows": 3,
                               "columns": [{"id": "c", "type": "text", "label": "c", "width": 11}]}]),
        ]
        # 同じ番号は枠の内外で重ねられない
        dup = self.layout_form()
        dup["fields"][0]["children"][0]["id"] = "monthly"
        bad.append(dup)
        for form in bad:
            self.assertEqual(self.staff("/forms/save", {"form": form})[0], 400, form["fields"])

    def test_pages_and_pdf_border(self):
        fields = self.form()["fields"]
        fields.insert(2, {"id": "p1", "type": "page", "label": "2ページ目", "width": 4})
        status, data = self.staff("/forms/save", {"form": self.form(fields=fields, encrypt=False)})
        self.assertEqual(status, 200, data)
        page = data["form"]["fields"][2]
        self.assertEqual((page["label"], page["width"], page["newRow"]), ("2ページ目", 12, True))
        self.assertTrue(data["form"]["pdfBorder"])   # 指定がなければ枠あり
        status, data = self.staff("/forms/save", {"id": data["form"]["id"],
                                                  "form": self.form(fields=fields, encrypt=False, pdfBorder=False)})
        self.assertFalse(data["form"]["pdfBorder"])
        status, data = self.staff("/requests/add", {"formId": data["form"]["id"], "code": "C001"})
        status, data = self.post("/form/get", {"token": data["request"]["token"]})
        self.assertEqual(status, 200)
        self.assertFalse(data["pdfBorder"])
        # ページ区切りは入力欄ではない。枠の中には置けない
        self.assertEqual(self.staff("/forms/save", {"form": self.form(fields=[{"id": "p", "type": "page"}])})[0], 400)
        nested = self.layout_form()
        nested["fields"][0]["children"].append({"id": "p2", "type": "page"})
        self.assertEqual(self.staff("/forms/save", {"form": nested})[0], 400)

    def test_label_and_help_position(self):
        fields = self.form()["fields"]
        fields[1].update(labelPosition="top", helpPosition="inside")      # 氏名（文字）
        fields[2].update(labelPosition="side", helpPosition="inside")     # チェック：説明は中に出せない
        fields[4].update(labelPosition="side", helpPosition="above")      # 表：項目名はいつも上
        fields[0].update(labelPosition="side")                             # 見出し
        fields[3].update(labelPosition="left", helpPosition="below")      # ありえない値は使わない
        form = self.form(fields=fields, encrypt=False, labelPosition="side", helpPosition="inside")
        status, data = self.staff("/forms/save", {"form": form})
        self.assertEqual(status, 200, data)
        saved = data["form"]
        self.assertEqual((saved["labelPosition"], saved["helpPosition"]), ("side", "inside"))
        got = [(f.get("labelPosition"), f.get("helpPosition")) for f in saved["fields"]]
        self.assertEqual(got, [(None, None), ("top", "inside"), ("side", None), (None, None), (None, None)])
        status, data = self.staff("/forms/save", {"form": self.form(labelPosition="x", helpPosition=1)})
        self.assertEqual((data["form"]["labelPosition"], data["form"]["helpPosition"]), ("top", "above"))
        status, data = self.staff("/requests/add", {"formId": saved["id"], "code": "C001"})
        status, data = self.post("/form/get", {"token": data["request"]["token"]})
        self.assertEqual((data["labelPosition"], data["helpPosition"]), ("side", "inside"))

    def test_check_text(self):
        fields = self.form()["fields"]
        fields[2]["checkText"] = "  上記の内容に同意します "
        status, data = self.staff("/forms/save", {"form": self.form(fields=fields)})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["form"]["fields"][2]["checkText"], "上記の内容に同意します")
        self.assertNotIn("checkText", data["form"]["fields"][1])   # チェック以外には付けない
        fields[2]["checkText"] = "あ" * 101
        self.assertEqual(self.staff("/forms/save", {"form": self.form(fields=fields)})[0], 400)

    def test_hide_label(self):
        fields = self.form()["fields"]
        fields[0]["hideLabel"] = True    # 見出しには付けない
        fields[1]["hideLabel"] = True
        fields[3]["hideLabel"] = "yes"
        status, data = self.staff("/forms/save", {"form": self.form(fields=fields)})
        self.assertEqual(status, 200, data)
        self.assertEqual([f.get("hideLabel") for f in data["form"]["fields"]], [None, True, None, None, None])
        fields[1]["label"] = ""          # 表示しなくても項目名は必要
        self.assertEqual(self.staff("/forms/save", {"form": self.form(fields=fields)})[0], 400)

    def test_table_checkbox_column(self):
        fields = self.form()["fields"]
        fields[4]["columns"].append({"id": "live", "type": "checkbox", "label": "同居", "sum": True})
        form_id, token = self.make_request(encrypt=False, fields=fields)
        status, data = self.staff("/forms/list", {})
        col = data["forms"][0]["fields"][4]["columns"][2]
        self.assertEqual((col["type"], col["sum"]), ("checkbox", False))   # 合計は数字の列だけ
        answers = {"name": "ダミー", "family": [{"name": "ダミー花子", "birth": "", "live": "はい"}, {"live": ""}]}
        self.assertEqual(self.post("/form/submit", {"token": token, "answers": answers})[0], 200)

    def test_checkboxes(self):
        fields = self.form()["fields"]
        fields.append({"id": "deduct", "type": "checkboxes", "label": "控除", "options": ["医療費", "寄附金"],
                       "direction": "horizontal"})
        _, token = self.make_request(encrypt=False, fields=fields)
        status, data = self.staff("/forms/list", {})
        self.assertEqual(data["forms"][0]["fields"][5]["direction"], "horizontal")
        ok = {"name": "ダミー", "deduct": ["医療費", "寄附金"]}
        self.assertEqual(self.post("/form/submit", {"token": token, "answers": ok})[0], 200)
        for bad in ({"deduct": ["その他"]}, {"deduct": "医療費"}):
            self.assertEqual(self.post("/form/submit", {"token": token, "answers": bad})[0], 400, bad)
        # 1つだけ選べる設定では、2つ以上は受け付けない
        fields[5]["single"] = True
        _, token = self.make_request(encrypt=False, fields=fields)
        self.assertEqual(self.post("/form/submit", {"token": token, "answers": {"deduct": ["医療費"]}})[0], 200)
        self.assertEqual(self.post("/form/submit", {"token": token, "answers": ok})[0], 400)
        no_options = self.form(fields=[{"id": "c", "type": "checkboxes", "label": "x", "options": []}])
        self.assertEqual(self.staff("/forms/save", {"form": no_options})[0], 400)

    def file_form(self):
        fields = self.form()["fields"]
        fields.append({"id": "docs", "type": "file", "label": "書類", "maxFiles": 3})
        return fields

    def test_file_field_requires_encryption(self):
        self.assertEqual(self.staff("/forms/save", {"form": self.form(fields=self.file_form(), encrypt=False)})[0], 400)
        status, data = self.staff("/forms/save", {"form": self.form(fields=self.file_form())})
        self.assertEqual(data["form"]["fields"][5]["maxFiles"], 3)
        too_many = self.file_form()
        too_many[5]["maxFiles"] = 11
        self.assertEqual(self.staff("/forms/save", {"form": self.form(fields=too_many)})[0], 400)

    def test_file_upload(self):
        form_id, token = self.make_request(fields=self.file_form())
        batch = "b" * 20
        good = {"token": token, "fieldId": "docs", "size": 1000, "batch": batch}
        status, data = self.post("/form/file-session", good)
        self.assertEqual((status, data["uploadUrl"]), (200, "https://upload.example/session"))
        folder, name, mime, size, props = self.drive["create_upload_session"].call_args.args
        self.assertEqual((folder, mime, size), (FOLDER, "application/octet-stream", 1000))
        self.assertRegex(name, r"^\d{8}-\d{6}_年末調整の確認_添付_[0-9a-f]{6}\.enc$")
        self.assertEqual(props, {"kabaFileOf": form_id, "kabaCode": "C001", "kabaBatch": batch})
        for bad in ({"fieldId": "name"}, {"size": 0}, {"size": server.MAX_ENCRYPTED_SIZE + 1}, {"batch": "../x"}):
            self.assertEqual(self.post("/form/file-session", {**good, **bad})[0], 400, bad)
        self.assertEqual(self.post("/form/file-session", {**good, "token": "x" * 24})[0], 403)

        uploaded = {"id": "file123456", "size": "1000", "parents": [FOLDER], "appProperties": {"kabaFileOf": form_id}}
        self.drive["get_file"].return_value = uploaded
        self.assertEqual(self.post("/form/file-complete", {"token": token, "fileId": "file123456"}), (200, {"ok": True}))
        # 別のフォルダ・別の入力ページのファイルは扱わない
        for other in ({"parents": ["otherFolder1"]}, {"appProperties": {"kabaFileOf": "f999999999999"}}):
            self.drive["get_file"].return_value = {**uploaded, **other}
            self.assertEqual(self.post("/form/file-complete", {"token": token, "fileId": "file123456"})[0], 404)
        self.drive["trash_file"].assert_not_called()
        # 暗号化していないファイルはゴミ箱へ
        self.drive["get_file"].return_value = uploaded
        self.drive["read_head"].return_value = b"%PDF-1.7"
        self.assertEqual(self.post("/form/file-complete", {"token": token, "fileId": "file123456"})[0], 400)
        self.drive["trash_file"].assert_called_once_with("file123456")

    def test_submit_with_batch_and_remove_files(self):
        form_id, token = self.make_request(fields=self.file_form())
        self.set_key()
        batch = "b" * 20
        body = {"token": token, "encrypted": self.encrypted(), "batch": batch}
        self.assertEqual(self.post("/form/submit", body)[0], 200)
        props = self.drive["create_json_file"].call_args.args[3]
        self.assertEqual(props["kabaBatch"], batch)
        self.assertEqual(self.post("/form/submit", {**body, "batch": "x"})[0], 400)
        # 入力内容を削除すると、一緒に送られたファイルも消す（入力内容のファイル自体は消さない）
        self.drive["get_file"].return_value = {"id": "file123456", "size": "100",
                                               "appProperties": {"kabaForm": form_id, "kabaBatch": batch}}
        self.drive["list_by_property"].return_value = [
            {"id": "attached01", "appProperties": {"kabaFileOf": form_id, "kabaBatch": batch}},
            {"id": "notattach1", "appProperties": {"kabaBatch": batch}},
        ]
        self.assertEqual(self.staff("/submissions/remove", {"id": "file123456"})[0], 200)
        self.drive["list_by_property"].assert_called_once_with("kabaBatch", batch)
        self.assertEqual([c.args[0] for c in self.drive["trash_file"].call_args_list], ["file123456", "attached01"])

    def test_staff_file_download(self):
        response = mock.MagicMock()
        response.headers = {"Content-Length": "12"}
        response.iter_content.return_value = [server.FILE_MAGIC, b"data"]
        response.__enter__.return_value = response
        with mock.patch.object(server, "open_download", return_value=response):
            self.drive["get_file"].return_value = {"id": "file123456", "size": "12", "appProperties": {"kabaFileOf": "f000000000000"}}
            conn = http.client.HTTPConnection("127.0.0.1", self.ports["staff"])
            conn.request("POST", "/submissions/file", json.dumps({"id": "file123456"}),
                         {"Content-Type": "application/json", "Origin": ORIGIN})
            res = conn.getresponse()
            self.assertEqual((res.status, res.read()), (200, server.FILE_MAGIC + b"data"))
            conn.close()
            # 入力ページの添付ファイル以外（アップロードされた資料など）は返さない
            self.drive["get_file"].return_value = {"id": "file123456", "size": "12", "appProperties": {"kabaForm": "f000000000000"}}
            self.assertEqual(self.staff("/submissions/file", {"id": "file123456"})[0], 404)
            # 顧問先用の入口からは使えない
            self.assertEqual(self.post("/submissions/file", {"id": "file123456"})[0], 404)

    def test_table_select_column(self):
        fields = self.form()["fields"]
        fields[4]["columns"].append({"id": "rel", "type": "select", "label": "続柄", "options": ["配偶者", " 子 "]})
        _, token = self.make_request(encrypt=False, fields=fields)
        status, data = self.staff("/forms/list", {})
        self.assertEqual(data["forms"][0]["fields"][4]["columns"][2]["options"], ["配偶者", "子"])
        for rel, status in (("子", 200), ("", 200), ("父", 400)):
            answers = {"name": "ダミー", "family": [{"name": "ダミー花子", "rel": rel}]}
            self.assertEqual(self.post("/form/submit", {"token": token, "answers": answers})[0], status, rel)
        fields[4]["columns"][2]["options"] = []
        self.assertEqual(self.staff("/forms/save", {"form": self.form(fields=fields)})[0], 400)

    def test_layout_answers(self):
        form = self.layout_form()
        form["fields"][0]["children"].pop()   # マイナンバーを外して暗号化なしで試す
        _, token = self.make_request(encrypt=False, fields=form["fields"])
        answers = {"name": "ダミー", "monthly": [{"amount": "100", "memo": ""}, {"amount": "", "memo": ""}]}
        self.assertEqual(self.post("/form/submit", {"token": token, "answers": answers})[0], 200)
        for bad in ({"g1": "x"}, {"n1": "x"}, {"monthly": [{}, {}, {}]}):
            self.assertEqual(self.post("/form/submit", {"token": token, "answers": bad})[0], 400, bad)

    def test_key_set(self):
        status, data = self.staff("/key/set", {"spki": self.SPKI})
        self.assertEqual(status, 200)
        self.assertEqual(data["key"]["fingerprint"], hashlib.sha256(base64.b64decode(self.SPKI)).hexdigest())
        self.assertEqual(self.staff("/key/set", {"spki": self.SPKI})[0], 409)
        self.assertEqual(self.staff("/key/set", {"spki": self.SPKI, "replace": True})[0], 200)
        self.assertEqual(self.staff("/key/set", {"spki": "QUJD", "replace": True})[0], 400)
        self.assertEqual(self.staff("/key/set", {"spki": "not base64!", "replace": True})[0], 400)

    def test_requests(self):
        form_id, token = self.make_request()
        self.assertRegex(token, server.TOKEN_RE)
        # 同じ顧問先には同じURLを返す
        self.assertEqual(self.staff("/requests/add", {"formId": form_id, "code": "C001"})[1]["request"]["token"], token)
        self.assertEqual(self.staff("/requests/add", {"formId": form_id, "code": "C999"})[0], 404)
        status, data = self.staff("/requests/list", {"formId": form_id})
        self.assertEqual(data["requests"][0]["url"], server.FORM_BASE_URL + token)
        status, data = self.staff("/requests/qr", {"token": token})
        self.assertTrue(data["dataUrl"].startswith("data:image/png;base64,"))
        self.assertEqual(self.staff("/requests/remove", {"token": token}), (200, {"ok": True}))
        self.assertEqual(self.post("/form/get", {"token": token})[0], 403)

    def test_remove_form_removes_requests(self):
        form_id, token = self.make_request(encrypt=False)
        self.assertEqual(self.staff("/forms/remove", {"id": form_id})[0], 200)
        self.assertEqual(server.load_json(server.REQUESTS_FILE), {})
        self.assertEqual(self.post("/form/get", {"token": token})[0], 403)

    def test_submissions(self):
        self.drive["list_form_files"].return_value = [
            {"id": "file123456", "createdTime": "2026-10-07T01:00:00Z", "appProperties": {"kabaCode": "C001"}}]
        status, data = self.staff("/submissions/list", {"formId": "f000000000000"})
        self.assertEqual(data["submissions"], [{"id": "file123456", "code": "C001", "submitted": "2026-10-07T01:00:00Z"}])
        self.assertEqual(self.staff("/submissions/get", {"id": "file123456"}), (200, {"record": {"version": 1}}))
        self.assertEqual(self.staff("/submissions/remove", {"id": "file123456"})[0], 200)
        self.drive["trash_file"].assert_called_once_with("file123456")
        # 入力ページ以外のファイル（アップロードされた資料など）は扱わない
        self.drive["get_file"].return_value = {"id": "file123456", "size": "100"}
        self.assertEqual(self.staff("/submissions/get", {"id": "file123456"})[0], 404)
        self.assertEqual(self.staff("/submissions/remove", {"id": "file123456"})[0], 404)
        self.assertEqual(self.staff("/submissions/get", {"id": "../x"})[0], 400)

    # --- 顧問先の入力ページ ---

    def test_get_encrypted_form(self):
        form_id, token = self.make_request()
        self.assertEqual(self.post("/form/get", {"token": token})[0], 503)   # 鍵の登録前
        self.set_key()
        status, data = self.post("/form/get", {"token": token})
        self.assertEqual(status, 200)
        self.assertEqual(data["publicKey"], self.SPKI)
        self.assertEqual(data["title"], "年末調整の確認")
        self.assertNotIn("code", data)

    def test_submit_encrypted(self):
        form_id, token = self.make_request()
        self.set_key()
        status, data = self.post("/form/submit", {"token": token, "encrypted": self.encrypted()})
        self.assertEqual(status, 200, data)
        folder, name, record, props = self.drive["create_json_file"].call_args.args
        self.assertEqual(folder, FOLDER)
        self.assertRegex(name, r"^\d{8}-\d{6}_年末調整の確認\.json$")
        self.assertEqual(props, {"kabaForm": form_id, "kabaCode": "C001"})
        self.assertEqual(record["encrypted"]["data"], "QUJD" * 2000)
        self.assertNotIn("answers", record)
        self.assertEqual(len(record["fields"]), 5)

    def test_submit_encrypted_rejects(self):
        _, token = self.make_request()
        self.set_key()
        self.assertEqual(self.post("/form/submit", {"token": token, "encrypted": self.encrypted("0" * 64)})[0], 409)
        bad = self.encrypted()
        bad["iv"] = "<script>"
        self.assertEqual(self.post("/form/submit", {"token": token, "encrypted": bad})[0], 400)
        # 暗号化する入力ページに、暗号化していない内容は送れない
        self.assertEqual(self.post("/form/submit", {"token": token, "answers": {"name": "ダミー"}})[0], 400)
        self.drive["create_json_file"].assert_not_called()

    def test_submit_plain(self):
        _, token = self.make_request(encrypt=False)
        answers = {"name": "ダミー太郎", "agree": True, "kind": "甲", "family": [{"name": "ダミー花子", "birth": "2000-01-01"}]}
        self.assertEqual(self.post("/form/get", {"token": token})[0], 200)   # 鍵がなくても開ける
        self.assertEqual(self.post("/form/submit", {"token": token, "answers": answers})[0], 200)
        record = self.drive["create_json_file"].call_args.args[2]
        self.assertEqual(record["answers"], answers)
        self.assertNotIn("encrypted", record)

    def test_submit_plain_rejects(self):
        _, token = self.make_request(encrypt=False)
        bad = [
            {"other": "x"},
            {"h1": "x"},
            {"agree": "はい"},
            {"name": "x" * 5001},
            {"family": [{"name": "a"}, {"name": "b"}, {"name": "c"}]},
            {"family": [{"other": "a"}]},
            ["x"],
        ]
        for answers in bad:
            self.assertEqual(self.post("/form/submit", {"token": token, "answers": answers})[0], 400, answers)
        self.drive["create_json_file"].assert_not_called()

    def test_submit_after_client_removed(self):
        _, token = self.make_request(encrypt=False)
        with open(server.CLIENTS_FILE, "w", encoding="utf-8") as f:
            json.dump({}, f)
        self.assertEqual(self.post("/form/submit", {"token": token, "answers": {}})[0], 403)

    def test_submit_rate_limit(self):
        _, token = self.make_request(encrypt=False)
        with mock.patch.object(server, "RATE_LIMIT", 2):
            codes = [self.post("/form/submit", {"token": token, "answers": {}})[0] for _ in range(3)]
        self.assertEqual(codes, [200, 200, 429])

    def test_staff_routes_not_on_public_port(self):
        for path in ("/forms/list", "/key/set", "/requests/add", "/submissions/get"):
            self.assertEqual(self.post(path, {})[0], 404, path)
        self.assertEqual(self.post("/form/get", {}, "staff")[0], 404)


if __name__ == "__main__":
    unittest.main()
