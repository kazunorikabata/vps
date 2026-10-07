#!/usr/bin/env python3
"""Claude Code の会話の一覧を、事務所内ページ用の JSON に書き出す（dev ユーザーの cron で1分ごとに実行）

使い方: python3 claude_sessions.py /var/www/kabaoffice/staff/claude-sessions.json

- 動いている会話：claude remote-control が起動した会話。claude.ai で開くURLを付ける
- 終了した会話：日時と、最初の依頼の冒頭だけ（会話の中身は書き出さない）
"""
import glob
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT_DIR = os.path.expanduser("~/.claude/projects/" + REPO_DIR.replace("/", "-"))
SESSION_URL = "https://claude.ai/code/"
MAX_SESSIONS = 30
TITLE_LENGTH = 40
TERMINAL_ACTIVE = timedelta(minutes=10)   # この時間内に動きがあったターミナルの会話は「作業中」とする
JST = timezone(timedelta(hours=9))
CSE_RE = re.compile(r"/v1/code/sessions/(cse_[A-Za-z0-9]+)")


def running_sessions():
    """[(会話ID cse_…, 起動時刻)]。remote-control が起動した会話のプロセスから調べる"""
    with open("/proc/stat") as f:
        boot = next(int(line.split()[1]) for line in f if line.startswith("btime"))
    ticks = os.sysconf("SC_CLK_TCK")
    found = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            if os.stat(f"/proc/{pid}").st_uid != os.getuid():
                continue
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmdline = f.read().replace(b"\0", b" ").decode(errors="replace")
            match = CSE_RE.search(cmdline)
            if not match:
                continue
            with open(f"/proc/{pid}/stat") as f:
                # プロセス名に空白が入っても崩れないよう、最後の ")" より後ろを使う
                start_ticks = int(f.read().rsplit(")", 1)[1].split()[19])
        except (OSError, ValueError, IndexError):
            continue
        found.append((match.group(1), datetime.fromtimestamp(boot + start_ticks / ticks, JST)))
    return sorted(set(found), key=lambda s: s[1])


def make_title(content):
    if isinstance(content, list):
        content = next((p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"), "")
    if not isinstance(content, str):
        return ""
    command = re.search(r"<command-name>(.*?)</command-name>", content)
    if command:
        return command.group(1).strip()
    text = " ".join(re.sub(r"<[^>]+>", " ", content).split())
    return text[:TITLE_LENGTH] + ("…" if len(text) > TITLE_LENGTH else "")


def read_transcript(path):
    """記録ファイルから、最初の依頼の冒頭・始めた時刻・どこから始めたかを取り出す"""
    title, started, entrypoint = "", None, ""
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") != "user" or d.get("isMeta") or d.get("isSidechain") or "toolUseResult" in d:
                continue
            title = make_title(d.get("message", {}).get("content"))
            if not title:
                continue
            started = datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")).astimezone(JST)
            entrypoint = d.get("entrypoint", "")
            break
    if started is None:
        return None
    return {
        "id": os.path.splitext(os.path.basename(path))[0],
        "title": title,
        "started": started,
        "lastActive": datetime.fromtimestamp(os.path.getmtime(path), JST),
        "remote": entrypoint == "sdk-cli",
    }


def collect():
    paths = sorted(glob.glob(os.path.join(PROJECT_DIR, "*.jsonl")), key=os.path.getmtime, reverse=True)
    sessions = [s for s in map(read_transcript, paths[:MAX_SESSIONS]) if s]

    # 動いている会話と記録ファイルを、起動時刻の直後に始まった remote-control の記録で結びつける
    unmatched = []
    for cse, process_start in running_sessions():
        candidates = [s for s in sessions if s["remote"] and "url" not in s
                      and s["started"] >= process_start - timedelta(minutes=1)]
        if candidates:
            min(candidates, key=lambda s: s["started"])["url"] = SESSION_URL + cse
        else:
            # まだ依頼を送っていない会話
            unmatched.append({"title": "", "started": process_start, "lastActive": process_start, "url": SESSION_URL + cse})

    now = datetime.now(JST)
    result = []
    for s in unmatched + sessions:
        if "url" in s:
            status = "running"
        elif not s.get("remote", True) and now - s["lastActive"] < TERMINAL_ACTIVE:
            status = "terminal"
        else:
            status = "ended"
        result.append({
            "id": s.get("id", ""),
            "title": s["title"],
            "started": s["started"].isoformat(timespec="minutes"),
            "lastActive": s["lastActive"].isoformat(timespec="minutes"),
            "status": status,
            "url": s.get("url", ""),
        })
    running = [s for s in result if s["status"] == "running"]
    others = sorted((s for s in result if s["status"] != "running"), key=lambda s: s["lastActive"], reverse=True)
    return {"updated": now.isoformat(timespec="seconds"), "sessions": running + others}


def main(out_path):
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(collect(), f, ensure_ascii=False, indent=1)
    os.chmod(tmp, 0o644)
    os.replace(tmp, out_path)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
