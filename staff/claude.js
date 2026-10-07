// 事務所内ページ：Claude Code の会話の一覧（VPS の cron が1分ごとに claude-sessions.json を書き出す）
const sessionList = document.getElementById('claude-sessions');
const sessionEmpty = document.getElementById('claude-empty');
const sessionUpdated = document.getElementById('claude-updated');

loadSessions();
setInterval(loadSessions, 60 * 1000);

async function loadSessions() {
  let data;
  try {
    const res = await fetch('/staff/claude-sessions.json', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch {
    sessionUpdated.textContent = '会話の一覧を読み込めませんでした。';
    return;
  }
  sessionList.replaceChildren(...data.sessions.map(createSessionItem));
  sessionEmpty.hidden = data.sessions.length > 0;
  sessionUpdated.textContent = `一覧の更新：${formatTime(data.updated)}（1分ごとに更新）`;
}

function createSessionItem(session) {
  const li = document.createElement('li');
  li.className = `session is-${session.status}`;

  const info = document.createElement('div');
  info.className = 'session-info';
  const title = document.createElement('span');
  title.className = 'session-title';
  title.textContent = session.title || '（まだ依頼がありません）';
  const meta = document.createElement('span');
  meta.className = 'session-meta';
  meta.textContent = `${formatTime(session.started)} 開始・${formatTime(session.lastActive)} 最終 ／ ${statusLabel(session.status)}`;
  info.append(title, meta);
  li.append(info);

  if (session.status === 'running') {
    const open = document.createElement('a');
    open.className = 'button button-small';
    open.href = session.url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = '開く';
    li.append(open);
  } else if (session.status === 'ended' && session.id) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'button button-small button-outline';
    toggle.textContent = '再開方法';
    const help = createResumeHelp(session.id);
    toggle.addEventListener('click', () => { help.hidden = !help.hidden; });
    li.append(toggle, help);
  }
  return li;
}

function createResumeHelp(id) {
  const command = `cd /home/dev/vps && claude --resume ${id} --remote-control`;
  const help = document.createElement('div');
  help.className = 'resume-help';
  help.hidden = true;
  const note = document.createElement('p');
  note.textContent = 'VPS のターミナルで tmux の中に入り、次のコマンドを実行すると、この会話の続きを claude.ai やスマホから操作できます。';
  const code = document.createElement('input');
  code.readOnly = true;
  code.value = command;
  code.setAttribute('aria-label', '再開するコマンド');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'button button-small';
  copy.textContent = 'コピー';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(command);
      copy.textContent = 'コピーしました';
    } catch {
      code.select();
    }
  });
  help.append(note, code, copy);
  return help;
}

function statusLabel(status) {
  if (status === 'running') return '動いています';
  if (status === 'terminal') return 'ターミナルで作業中';
  return '終了しています';
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
