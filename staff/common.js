// 事務所内ページの共通の部品（ボタン・確認・日付の表示・処理中の表示・メッセージ・サーバーとのやり取り）
// 事務所内ページは1つのページ（staff/index.html）で、ほかのプログラムはこれを使う
const staff = document.querySelector('.staff');
const message = document.getElementById('message');

function cell(content) {
  const td = document.createElement('td');
  td.append(content);
  return td;
}

function input(value, placeholder, maxLength) {
  const el = document.createElement('input');
  el.value = value;
  el.placeholder = placeholder;
  el.maxLength = maxLength;
  el.setAttribute('aria-label', placeholder);
  return el;
}

function select(options, value, label) {
  const el = document.createElement('select');
  for (const [v, text] of Object.entries(options)) el.append(new Option(text, v));
  el.value = value;
  el.setAttribute('aria-label', label);
  return el;
}

function checkLine(text, checked, onChange) {
  const label = document.createElement('label');
  label.className = 'check-line';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  label.append(box, text);
  return label;
}

function button(label, onClick, extraClass = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `button button-small ${extraClass}`.trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// 確認のダイアログは使えないので、操作欄の中で確認する
function askConfirm(td, text, label, action, cancel) {
  const note = document.createElement('p');
  note.className = 'confirm-text';
  note.textContent = text;
  td.replaceChildren(note, button(label, () => run(action), 'button-danger'), button('やめる', cancel, 'button-outline'));
}

// パソコンの時刻の設定によらず、日本時間で表示する
function formatDate(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso || '';
  const d = new Date(t + 9 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function today() {
  return formatDate(new Date().toISOString()).slice(0, 10).replace(/-/g, '');
}

// 処理の間はボタンを押せなくする。処理の中から別の処理を始めても、全部終わったところで元に戻す
let busyDepth = 0;

async function run(task) {
  if (busyDepth++ === 0) setBusy(true);
  try {
    await task();
  } catch (err) {
    showMessage(err.message, 'error');
  } finally {
    if (--busyDepth === 0) setBusy(false);
  }
}

function setBusy(busy) {
  staff.classList.toggle('is-busy', busy);
  // 終わったら元の状態に戻す（処理中に作られたボタンはそのまま）
  for (const b of staff.querySelectorAll('button')) {
    if (busy) {
      b.dataset.wasDisabled = b.disabled ? '1' : '';
      b.disabled = true;
    } else if (b.dataset.wasDisabled !== undefined) {
      b.disabled = b.dataset.wasDisabled === '1';
      delete b.dataset.wasDisabled;
    }
  }
}

function showMessage(text, kind) {
  message.textContent = text;
  message.className = `staff-message is-${kind}`;
  message.hidden = false;
  // ページの下の方で操作したときも、エラーに気づけるようにする
  if (kind === 'error') message.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function api(path, body = {}) {
  return fetchJson(`/api/staff/${path}`, body);
}

async function fetchJson(url, body = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('通信できませんでした。時間をおいて再度お試しください');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラーが起きました（${res.status}）`);
  return data;
}
