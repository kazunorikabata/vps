// 顧問先の入力ページ
// 項目は事務所内ページで作ったものを読み込んで表示する。暗号化する入力ページでは、
// 入力内容をこの画面の中で事務所の公開鍵で暗号化してから送る（VPS には読めない形でしか届かない）
const NETWORK_ERROR = '通信できませんでした。電波の良い場所で再度お試しください';
const TYPE_INPUTS = {
  text: { type: 'text' },
  number: { type: 'text', inputMode: 'decimal' },
  date: { type: 'date' },
  tel: { type: 'tel', autocomplete: 'tel' },
  email: { type: 'email', autocomplete: 'email' },
  zip: { type: 'text', inputMode: 'numeric', placeholder: '例：273-0021', autocomplete: 'postal-code' },
  mynumber: { type: 'text', inputMode: 'numeric', maxLength: 14, placeholder: '12桁の数字', autocomplete: 'off' },
};

const token = location.hash.slice(1);
const form = document.getElementById('entry-form');
const fieldsBox = document.getElementById('fields');
const formError = document.getElementById('form-error');
const sendButton = document.getElementById('send');

let page = null;
let controls = [];
let dirty = false;

start();

async function start() {
  try {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) throw new Error('このURLは無効です。事務所にお問い合わせください。');
    page = await api('get', { token });
    if (page.encrypt && !FormCrypto.supported()) {
      throw new Error('お使いのブラウザでは送信できません。最新のブラウザ（Chrome、Safari、Edge など）でお試しください。');
    }
  } catch (err) {
    showInvalid(err.message);
    return;
  }
  document.title = `${page.title}｜蒲田和紀税理士事務所`;
  document.getElementById('title').textContent = page.title;
  document.getElementById('description').textContent = page.description;
  document.getElementById('secure-note').hidden = !page.encrypt;
  controls = page.fields.map(createField);
  document.getElementById('loading').hidden = true;
  form.hidden = false;
}

function showInvalid(text) {
  document.getElementById('loading').hidden = true;
  const invalid = document.getElementById('invalid');
  invalid.textContent = text;
  invalid.hidden = false;
}

form.addEventListener('input', () => { dirty = true; });

// 入力の途中でページを閉じようとしたら確認する
window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formError.hidden = true;
  const answers = collect();
  if (!answers) return;
  sendButton.disabled = true;
  sendButton.textContent = '送信しています…';
  try {
    const body = { token };
    if (page.encrypt) body.encrypted = await FormCrypto.encrypt(page.publicKey, page.keyId, answers);
    else body.answers = answers;
    const result = await api('submit', body);
    dirty = false;
    showDone(answers, result.submitted);
  } catch (err) {
    showFormError(err.message);
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = '送信する';
  }
});

document.getElementById('print').addEventListener('click', () => window.print());

// --- 項目の表示 ---

function createField(field) {
  if (field.type === 'heading') {
    const h = document.createElement('h2');
    h.className = 'entry-heading';
    h.textContent = field.label;
    fieldsBox.append(h);
    if (field.help) fieldsBox.append(helpText(field.help));
    return { field };
  }
  const box = document.createElement('div');
  box.className = 'entry-field';
  const id = `field-${field.id}`;
  const label = document.createElement(field.type === 'table' ? 'p' : 'label');
  label.className = 'entry-label';
  if (field.type !== 'table') label.htmlFor = id;
  label.textContent = field.label;
  if (field.required) label.append(' ', requiredMark());
  box.append(label);
  if (field.help) box.append(helpText(field.help));
  const error = document.createElement('p');
  error.className = 'entry-error';
  error.hidden = true;

  let control;
  if (field.type === 'table') {
    control = createTable(field, box);
  } else {
    const input = createInput(field, id);
    box.append(input);
    control = { field, input };
  }
  box.append(error);
  fieldsBox.append(box);
  return { ...control, box, error };
}

function createInput(field, id) {
  let input;
  if (field.type === 'textarea') {
    input = document.createElement('textarea');
    input.rows = 4;
  } else if (field.type === 'select') {
    input = document.createElement('select');
    input.append(new Option('選択してください', ''));
    for (const option of field.options) input.append(new Option(option, option));
  } else if (field.type === 'checkbox') {
    const wrap = document.createElement('label');
    wrap.className = 'entry-check';
    input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    wrap.append(input, ' はい');
    wrap.input = input;
    return wrap;
  } else {
    input = document.createElement('input');
    Object.assign(input, TYPE_INPUTS[field.type] || TYPE_INPUTS.text);
  }
  input.id = id;
  input.className = 'entry-input';
  return input;
}

function createTable(field, box) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.className = 'entry-table';
  const head = table.createTHead().insertRow();
  for (const col of field.columns) {
    const th = document.createElement('th');
    th.textContent = col.label;
    head.append(th);
  }
  head.append(document.createElement('th'));
  const body = table.createTBody();
  wrap.append(table);
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'row-button';
  add.textContent = '＋ 行を追加';
  const control = { field, body, add };
  add.addEventListener('click', () => addRow(control));
  box.append(wrap, add);
  addRow(control);
  return control;
}

function addRow(control) {
  const { field, body, add } = control;
  const tr = body.insertRow();
  for (const col of field.columns) {
    const td = tr.insertCell();
    const input = document.createElement('input');
    Object.assign(input, TYPE_INPUTS[col.type] || TYPE_INPUTS.text);
    input.className = 'entry-input';
    input.dataset.col = col.id;
    input.setAttribute('aria-label', col.label);
    td.append(input);
  }
  const td = tr.insertCell();
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'row-remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', 'この行を削除');
  remove.addEventListener('click', () => {
    tr.remove();
    if (body.rows.length === 0) addRow(control);
    add.hidden = body.rows.length >= field.maxRows;
  });
  td.append(remove);
  add.hidden = body.rows.length >= field.maxRows;
}

function helpText(text) {
  const p = document.createElement('p');
  p.className = 'entry-help';
  p.textContent = text;
  return p;
}

function requiredMark() {
  const span = document.createElement('span');
  span.className = 'required-mark';
  span.textContent = '必須';
  return span;
}

// --- 入力内容の取りまとめと確認 ---

function collect() {
  const answers = {};
  let first = null;
  for (const c of controls) {
    if (c.field.type === 'heading') continue;
    const value = c.field.type === 'table' ? tableValue(c) : inputValue(c);
    const message = check(c.field, value);
    c.error.textContent = message;
    c.error.hidden = !message;
    c.box.classList.toggle('has-error', Boolean(message));
    if (message && !first) first = c.box;
    answers[c.field.id] = value;
  }
  if (first) {
    showFormError('入力内容を確認してください。');
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return null;
  }
  return answers;
}

function inputValue(c) {
  if (c.field.type === 'checkbox') return c.input.input.checked;
  const value = normalize(c.field.type, c.input.value);
  if (c.input.tagName !== 'SELECT') c.input.value = value;
  return value;
}

function tableValue(c) {
  const rows = [];
  for (const tr of c.body.rows) {
    const row = {};
    let filled = false;
    for (const input of tr.querySelectorAll('input[data-col]')) {
      const col = c.field.columns.find((x) => x.id === input.dataset.col);
      input.value = normalize(col.type, input.value);
      row[col.id] = input.value;
      if (input.value) filled = true;
    }
    if (filled) rows.push(row);
  }
  return rows;
}

// 全角の数字や記号を半角にし、前後の空白を取る
function normalize(type, value) {
  let v = value.trim();
  if (['number', 'tel', 'zip', 'mynumber'].includes(type)) {
    v = v.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
      .replace(/[－ー―‐]/g, '-').replace(/[，]/g, ',').replace(/[．]/g, '.');
  }
  if (type === 'mynumber') v = v.replace(/[\s-]/g, '');
  return v;
}

function check(field, value) {
  if (field.type === 'table') {
    if (field.required && value.length === 0) return '1行以上入力してください';
    for (const [i, row] of value.entries()) {
      for (const col of field.columns) {
        const message = checkValue(col.type, row[col.id]);
        if (message) return `${i + 1}行目の「${col.label}」：${message}`;
      }
    }
    return '';
  }
  if (field.required && (value === '' || value === false)) {
    return field.type === 'checkbox' ? '確認のうえ、チェックを入れてください' : '入力してください';
  }
  return field.type === 'checkbox' ? '' : checkValue(field.type, value);
}

function checkValue(type, value) {
  if (!value) return '';
  if (type === 'mynumber' && !isMyNumber(value)) return 'マイナンバー（12桁）が正しくありません';
  if (type === 'number' && !/^-?[\d,]+(\.\d+)?$/.test(value)) return '数字で入力してください';
  if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'メールアドレスが正しくありません';
  if (type === 'zip' && !/^\d{3}-?\d{4}$/.test(value)) return '郵便番号（7桁）が正しくありません';
  if (type === 'tel' && !/^[\d+()-]{10,15}$/.test(value)) return '電話番号が正しくありません';
  return '';
}

// マイナンバーの検査用数字（12桁目）を確かめる
function isMyNumber(value) {
  if (!/^\d{12}$/.test(value)) return false;
  let sum = 0;
  for (let n = 1; n <= 11; n++) {
    const p = Number(value[11 - n]);
    const q = n <= 6 ? n + 1 : n - 5;
    sum += p * q;
  }
  const rest = sum % 11;
  return Number(value[11]) === (rest <= 1 ? 0 : 11 - rest);
}

function showFormError(text) {
  formError.textContent = text;
  formError.hidden = false;
}

// --- 送信後：PDF 用の表示 ---

function showDone(answers, submitted) {
  buildPrintView(answers, submitted);
  form.hidden = true;
  const hasMyNumber = page.fields.some((f) => f.type === 'mynumber'
    || (f.columns || []).some((c) => c.type === 'mynumber'));
  document.getElementById('done-mynumber').hidden = !hasMyNumber;
  document.getElementById('done').hidden = false;
  window.scrollTo({ top: 0 });
}

function buildPrintView(answers, submitted) {
  const view = document.getElementById('print-view');
  const h = document.createElement('h1');
  h.textContent = page.title;
  const meta = document.createElement('p');
  meta.className = 'print-meta';
  meta.textContent = `送信日時：${new Date(submitted).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}　送信先：蒲田和紀税理士事務所`;
  const table = document.createElement('table');
  for (const field of page.fields) {
    const tr = table.insertRow();
    if (field.type === 'heading') {
      const th = document.createElement('th');
      th.colSpan = 2;
      th.className = 'print-heading';
      th.textContent = field.label;
      tr.append(th);
      continue;
    }
    const th = document.createElement('th');
    th.textContent = field.label;
    const td = tr.insertCell();
    tr.prepend(th);
    const value = answers[field.id];
    if (field.type === 'table') td.append(printTable(field, value));
    else if (field.type === 'checkbox') td.textContent = value ? 'はい' : '—';
    else td.textContent = value || '—';
  }
  view.replaceChildren(h, meta, table);
}

function printTable(field, rows) {
  if (!rows.length) return document.createTextNode('—');
  const table = document.createElement('table');
  const head = table.insertRow();
  for (const col of field.columns) {
    const th = document.createElement('th');
    th.textContent = col.label;
    head.append(th);
  }
  for (const row of rows) {
    const tr = table.insertRow();
    for (const col of field.columns) tr.insertCell().textContent = row[col.id] || '';
  }
  return table;
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(`/api/form/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(NETWORK_ERROR);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '送信できませんでした。時間をおいて再度お試しください');
  return data;
}
