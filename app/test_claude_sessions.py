"""claude_sessions.py のテスト（ダミーの会話記録を使う）

実行: cd app && python3 -m unittest test_claude_sessions
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest import mock

import claude_sessions as cs


def record(text, minute, **extra):
    return {"type": "user", "timestamp": f"2026-10-07T06:{minute:02d}:00.000Z",
            "message": {"content": text}, **extra}


class TitleTest(unittest.TestCase):
    def test_titles(self):
        self.assertEqual(cs.make_title("トップの電話番号を変えて"), "トップの電話番号を変えて")
        self.assertEqual(cs.make_title("<command-message>init</command-message>\n<command-name>/init</command-name>"), "/init")
        self.assertEqual(cs.make_title('<pasted_content id="1">\n本文です\n</pasted_content>'), "本文です")
        self.assertEqual(cs.make_title([{"type": "text", "text": "画像の説明"}]), "画像の説明")
        self.assertEqual(cs.make_title("あ" * 50), "あ" * cs.TITLE_LENGTH + "…")
        self.assertEqual(cs.make_title(None), "")


class CollectTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        p = mock.patch.object(cs, "PROJECT_DIR", self.dir.name)
        p.start()
        self.addCleanup(p.stop)

    def write(self, name, records, age_minutes):
        path = os.path.join(self.dir.name, name + ".jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        t = (datetime.now() - timedelta(minutes=age_minutes)).timestamp()
        os.utime(path, (t, t))

    def collect(self, running):
        with mock.patch.object(cs, "running_sessions", return_value=running):
            return cs.collect()["sessions"]

    def test_running_ended_and_terminal(self):
        self.write("remote1", [
            {"type": "user", "isMeta": True, "timestamp": "2026-10-07T06:40:00.000Z", "message": {"content": "meta"}},
            record("リンクを作って", 41, entrypoint="sdk-cli"),
            record("", 42, toolUseResult={}),
        ], age_minutes=30)
        self.write("old", [record("昔の依頼", 1, entrypoint="sdk-cli")], age_minutes=600)
        self.write("term", [record("ターミナルの依頼", 2, entrypoint="cli")], age_minutes=1)
        start = datetime.fromisoformat("2026-10-07T15:38:00+09:00")
        sessions = self.collect([("cse_abc", start)])

        self.assertEqual([s["id"] for s in sessions], ["remote1", "term", "old"])
        self.assertEqual(sessions[0]["status"], "running")
        self.assertEqual(sessions[0]["url"], "https://claude.ai/code/cse_abc")
        self.assertEqual(sessions[0]["title"], "リンクを作って")
        self.assertEqual(sessions[1]["status"], "terminal")
        self.assertEqual(sessions[2]["status"], "ended")
        self.assertEqual(sessions[2]["url"], "")

    def test_running_without_request_yet(self):
        self.write("old", [record("昔の依頼", 1, entrypoint="sdk-cli")], age_minutes=600)
        start = datetime.fromisoformat("2026-10-07T16:30:00+09:00")
        sessions = self.collect([("cse_new", start)])
        self.assertEqual(sessions[0], {
            "id": "", "title": "", "started": "2026-10-07T16:30+09:00", "lastActive": "2026-10-07T16:30+09:00",
            "status": "running", "url": "https://claude.ai/code/cse_new",
        })
        self.assertEqual(sessions[1]["status"], "ended")

    def test_main_writes_readable_file(self):
        out = os.path.join(self.dir.name, "out.json")
        with mock.patch.object(cs, "running_sessions", return_value=[]):
            cs.main(out)
        self.assertEqual(os.stat(out).st_mode & 0o777, 0o644)
        with open(out, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["sessions"], [])


if __name__ == "__main__":
    unittest.main()
