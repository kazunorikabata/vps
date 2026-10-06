// 顧問先からの資料送信
// ファイル本体は Google ドライブへ直接送り、VPS には名前と大きさだけを伝える
const MAX_SIZE = 50 * 1024 * 1024;
const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'xlsx', 'xls', 'docx', 'doc', 'csv'];
const NETWORK_ERROR = '通信できませんでした。電波の良い場所で再度お試しください';

const token = location.hash.slice(1);
const form = document.getElementById('upload-form');
const input = document.getElementById('files');
const list = document.getElementById('file-list');
const sendButton = document.getElementById('send');
const done = document.getElementById('done');

let entries = [];

if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
  form.hidden = true;
  document.getElementById('invalid').hidden = false;
}

input.addEventListener('change', () => {
  entries = Array.from(input.files).map((file) => ({ file, error: checkFile(file), sent: false }));
  renderList();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  sendButton.disabled = true;
  input.disabled = true;
  let failed = 0;
  for (const entry of entries) {
    if (entry.error || entry.sent) continue;
    try {
      await sendFile(entry);
      entry.sent = true;
      setStatus(entry, '送信しました', 'ok');
    } catch (err) {
      failed++;
      entry.bar.hidden = true;
      setStatus(entry, err.message, 'error');
    }
  }
  input.disabled = false;
  if (failed === 0) {
    form.hidden = true;
    done.hidden = false;
  } else {
    // 失敗したものだけ、もう一度送れるようにする
    sendButton.disabled = false;
  }
});

document.getElementById('again').addEventListener('click', () => {
  entries = [];
  input.value = '';
  renderList();
  done.hidden = true;
  form.hidden = false;
});

function checkFile(file) {
  const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
  if (!ALLOWED_EXT.includes(ext)) return 'この種類のファイルは送信できません';
  if (file.size === 0) return 'ファイルが空です';
  if (file.size > MAX_SIZE) return '50MBを超えています';
  return '';
}

function renderList() {
  list.innerHTML = '';
  for (const entry of entries) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = entry.file.name;
    entry.status = document.createElement('span');
    entry.bar = document.createElement('progress');
    entry.bar.max = 100;
    entry.bar.value = 0;
    entry.bar.hidden = true;
    li.append(name, entry.status, entry.bar);
    list.append(li);
    setStatus(entry, entry.error || formatSize(entry.file.size), entry.error ? 'error' : '');
  }
  sendButton.disabled = !entries.some((entry) => !entry.error);
}

function setStatus(entry, text, kind = '') {
  entry.status.textContent = text;
  entry.status.className = kind ? `file-status is-${kind}` : 'file-status';
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function sendFile(entry) {
  const { file } = entry;
  setStatus(entry, '準備中…');
  const session = await api('session', { token, name: file.name, size: file.size });
  entry.bar.hidden = false;
  const uploaded = await putFile(session.uploadUrl, file, session.mimeType, (ratio) => {
    entry.bar.value = ratio * 100;
    setStatus(entry, `${Math.floor(ratio * 100)}%`);
  });
  setStatus(entry, '確認中…');
  await api('complete', { token, fileId: uploaded.id });
  entry.bar.hidden = true;
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(`/api/upload/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(NETWORK_ERROR);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '送信できませんでした');
  return data;
}

function putFile(url, file, mimeType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', mimeType);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      try {
        if (xhr.status !== 200 && xhr.status !== 201) throw new Error();
        resolve(JSON.parse(xhr.responseText));
      } catch {
        reject(new Error('送信できませんでした'));
      }
    });
    xhr.addEventListener('error', () => reject(new Error(NETWORK_ERROR)));
    xhr.send(file);
  });
}
