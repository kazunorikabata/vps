"""server.py のテスト（Google ドライブには接続せず、ダミーに置き換える）

実行: cd app && python -m unittest test_server
"""
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


if __name__ == "__main__":
    unittest.main()
