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


class ClientsAdminTest(unittest.TestCase):
    def setUp(self):
        import clients_admin
        self.admin = clients_admin
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        for name, path in (("CLIENTS_FILE", "clients.json"), ("ROOT_FILE", "root-folder.json")):
            p = mock.patch.object(clients_admin, name, os.path.join(self.dir.name, path))
            p.start()
            self.addCleanup(p.stop)
        self.create_folder = mock.Mock(side_effect=["rootFolder", "folderC001", "folderC002"])
        p = mock.patch.object(server, "create_folder", self.create_folder)
        p.start()
        self.addCleanup(p.stop)

    def run_admin(self, *args):
        with mock.patch("sys.stdout"):
            self.admin.main(list(args))

    def test_add_creates_root_once(self):
        self.run_admin("add", "C001")
        self.run_admin("add", "C002")
        self.assertEqual(self.create_folder.call_args_list, [
            mock.call("顧問先資料"),
            mock.call("C001", "rootFolder"),
            mock.call("C002", "rootFolder"),
        ])
        clients = self.admin.load(self.admin.CLIENTS_FILE)
        self.assertEqual(sorted(c["folder_id"] for c in clients.values()), ["folderC001", "folderC002"])
        for token in clients:
            self.assertRegex(token, server.TOKEN_RE)
        self.assertEqual(os.stat(self.admin.CLIENTS_FILE).st_mode & 0o777, 0o640)

    def test_duplicate_and_remove(self):
        self.run_admin("add", "C001")
        with self.assertRaises(SystemExit):
            self.run_admin("add", "C001")
        self.run_admin("remove", "C001")
        self.assertEqual(self.admin.load(self.admin.CLIENTS_FILE), {})
        with self.assertRaises(SystemExit):
            self.run_admin("remove", "C001")


if __name__ == "__main__":
    unittest.main()
