// 事務所内ページ：入力ページの作成・顧問先へのURLの発行・届いた入力内容の確認と書き出し
// 暗号化した入力内容は、このページに読み込んだ秘密鍵で、このブラウザの中だけで復号する
const TYPES = {
  heading: '見出し',
  text: '1行の文字',
  textarea: '複数行の文字',
  number: '数字・金額',
  date: '日付',
  select: '選択肢',
  checkbox: 'チェック（はい）',
  tel: '電話番号',
  email: 'メールアドレス',
  zip: '郵便番号',
  mynumber: 'マイナンバー',
  table: '表（扶養家族など複数行）',
};
const COLUMN_TYPES = { text: '文字', number: '数字・金額', date: '日付', mynumber: 'マイナンバー' };

const staff = document.querySelector('.staff');
const message = document.getElementById('message');

let forms = [];
let registeredKey = null;   // サーバーに登録されている公開鍵 { fingerprint, set }
let loadedKey = null;       // このページに読み込んだ秘密鍵 { privateKey, fingerprint }
let pendingKey = null;      // 作ったばかりで、まだ登録していない鍵
let editing = null;         // 編集中の入力ページ { id, form }
let current = null;         // 依頼URL・入力内容を表示している入力ページ
let submissions = [];

run(loadForms);

// --- 暗号化の鍵 ---

const keyOpen = document.getElementById('key-open');
const keyCreate = document.getElementById('key-create');
const keySave = document.getElementById('key-save');

document.getElementById('key-open-show').addEventListener('click', () => {
  keyOpen.hidden = !keyOpen.hidden;
  keyCreate.hidden = true;
});

document.getElementById('key-create-show').addEventListener('click', () => {
  keyCreate.hidden = !keyCreate.hidden;
  keyOpen.hidden = true;
});

keyOpen.addEventListener('submit', (event) => {
  event.preventDefault();
  const file = document.getElementById('key-open-file').files[0];
  const pass = document.getElementById('key-open-pass');
  run(async () => {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new Error('鍵のファイルではありません');
    }
    loadedKey = await FormCrypto.openKey(data, pass.value);
    pass.value = '';
    keyOpen.reset();
    keyOpen.hidden = true;
    showKey();
    showMessage('鍵を読み込みました', 'ok');
  });
});

keyCreate.addEventListener('submit', (event) => {
  event.preventDefault();
  const pass = document.getElementById('key-create-pass');
  const pass2 = document.getElementById('key-create-pass2');
  if (pass.value.length < 12) return showMessage('パスワードは12文字以上にしてください', 'error');
  if (pass.value !== pass2.value) return showMessage('確認用のパスワードが一致しません', 'error');
  run(async () => {
    showMessage('鍵を作っています（数秒かかります）…', 'ok');
    const created = await FormCrypto.createKey(pass.value);
    // 登録したあとすぐに使えるよう、書き出せない形で開き直しておく
    pendingKey = { ...created, opened: await FormCrypto.openKey(created.file, pass.value) };
    keyCreate.reset();
    keyCreate.hidden = true;
    const blob = new Blob([JSON.stringify(created.file, null, 2)], { type: 'application/json' });
    const link = document.getElementById('key-save-link');
    if (link.href.startsWith('blob:')) URL.revokeObjectURL(link.href);
    link.href = URL.createObjectURL(blob);
    link.download = `kabaoffice-秘密鍵-${today()}.json`;
    document.getElementById('key-save-done').checked = false;
    document.getElementById('key-register').disabled = true;
    keySave.hidden = false;
    showMessage('鍵のファイルを保存してから、登録してください', 'ok');
  });
});

document.getElementById('key-save-done').addEventListener('change', (event) => {
  document.getElementById('key-register').disabled = !event.target.checked;
});

document.getElementById('key-register').addEventListener('click', () => run(async () => {
  const { key } = await api('key/set', { spki: pendingKey.spki, replace: Boolean(registeredKey) });
  registeredKey = key;
  loadedKey = pendingKey.opened;
  pendingKey = null;
  const link = document.getElementById('key-save-link');
  URL.revokeObjectURL(link.href);
  link.removeAttribute('href');
  keySave.hidden = true;
  showKey();
  showMessage('鍵を登録しました。これから届く入力内容は、この鍵で暗号化されます', 'ok');
}));

function showKey() {
  const status = document.getElementById('key-status');
  status.textContent = registeredKey
    ? `登録済みの鍵：${FormCrypto.shortFingerprint(registeredKey.fingerprint)}（${registeredKey.set}）`
    : 'まだ鍵が登録されていません。暗号化する入力ページを使うには、最初に鍵を作ってください。';
  document.getElementById('key-create-show').textContent = registeredKey ? '鍵を作り直す' : '鍵を作る';
  document.getElementById('key-create-show').classList.toggle('button-danger', Boolean(registeredKey));
  document.getElementById('key-replace-warning').hidden = !registeredKey;
  const loaded = document.getElementById('key-loaded');
  if (!loadedKey) {
    loaded.textContent = 'このページには鍵が読み込まれていません（暗号化した入力内容を開くときに必要です）';
    loaded.className = 'key-loaded';
  } else if (registeredKey && loadedKey.fingerprint !== registeredKey.fingerprint) {
    // 登録されている鍵が、事務所の鍵と違う＝誰かに差し替えられたおそれがある
    loaded.textContent = `読み込んだ鍵（${FormCrypto.shortFingerprint(loadedKey.fingerprint)}）は、登録済みの鍵と違います。古い鍵でなければ、すぐに代表に知らせてください。`;
    loaded.className = 'key-loaded is-error';
  } else {
    loaded.textContent = `鍵を読み込みました（${FormCrypto.shortFingerprint(loadedKey.fingerprint)}）`;
    loaded.className = 'key-loaded is-ok';
  }
}

// --- 入力ページの一覧 ---

async function loadForms() {
  const data = await api('forms/list');
  forms = data.forms;
  registeredKey = data.key;
  showKey();
  const tbody = document.getElementById('forms');
  tbody.replaceChildren(...forms.map(formRow));
  document.getElementById('forms-empty').hidden = forms.length > 0;
}

function formRow(form) {
  const tr = document.createElement('tr');
  const enc = document.createElement('span');
  enc.className = `tag ${form.encrypt ? 'is-on' : 'is-off'}`;
  enc.textContent = form.encrypt ? 'あり' : 'なし';
  const ops = document.createElement('td');
  ops.className = 'ops';
  tr.append(cell(form.title), cell(enc), cell(String(form.fields.filter((f) => f.type !== 'heading').length)),
    cell(String(form.requests)), cell(form.updated), ops);
  showFormOps(ops, form);
  return tr;
}

function showFormOps(td, form) {
  td.replaceChildren(
    button('依頼URL', () => run(() => openRequests(form))),
    button('届いた内容', () => run(() => openSubmissions(form))),
    button('編集', () => openEditor(form)),
    button('削除', () => askConfirm(td,
      `「${form.title}」を削除しますか？ 発行したURLは使えなくなります（届いた入力内容はドライブに残ります）。`,
      '削除する', async () => {
        await api('forms/remove', { id: form.id });
        showMessage(`「${form.title}」を削除しました`, 'ok');
        for (const id of ['editor', 'requests', 'submissions']) document.getElementById(id).hidden = true;
        await loadForms();
      }, () => showFormOps(td, form)), 'button-danger'),
  );
}

// --- 入力ページの編集 ---

const editor = document.getElementById('editor');
const edFields = document.getElementById('ed-fields');
const edEncrypt = document.getElementById('ed-encrypt');
const addType = document.getElementById('ed-add-type');
for (const [value, label] of Object.entries(TYPES)) addType.append(new Option(label, value));
addType.value = 'text';

document.getElementById('new-form').addEventListener('click', () => openEditor(null));
document.getElementById('ed-cancel').addEventListener('click', () => { editor.hidden = true; });
document.getElementById('ed-title').addEventListener('input', (e) => { editing.form.title = e.target.value; });
document.getElementById('ed-description').addEventListener('input', (e) => { editing.form.description = e.target.value; });
edEncrypt.addEventListener('change', () => {
  editing.form.encrypt = edEncrypt.checked;
  showEncryptNote();
});

document.getElementById('ed-add').addEventListener('click', () => {
  const field = { id: newId(editing.form.fields, 'q'), type: addType.value, label: '', help: '', required: false };
  prepareField(field);
  editing.form.fields.push(field);
  renderFields();
  edFields.lastElementChild.querySelector('input').focus();
});

document.getElementById('ed-save').addEventListener('click', () => run(async () => {
  const body = { form: editing.form };
  if (editing.id) body.id = editing.id;
  const { form } = await api('forms/save', body);
  editing = { id: form.id, form: structuredClone(form) };
  document.getElementById('editor-title').textContent = `「${form.title}」を編集`;
  showMessage(`「${form.title}」を保存しました`, 'ok');
  await loadForms();
}));

function openEditor(form) {
  editing = form
    ? { id: form.id, form: structuredClone({ title: form.title, description: form.description, encrypt: form.encrypt, fields: form.fields }) }
    : { id: null, form: { title: '', description: '', encrypt: true, fields: [] } };
  for (const field of editing.form.fields) prepareField(field);
  document.getElementById('editor-title').textContent = form ? `「${form.title}」を編集` : '新しい入力ページ';
  document.getElementById('ed-title').value = editing.form.title;
  document.getElementById('ed-description').value = editing.form.description;
  renderFields();
  editor.hidden = false;
  editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 種類に必要な設定（選択肢・表の列）をそろえる
function prepareField(field) {
  if (field.type === 'select' && !field.options) field.options = [];
  if (field.type === 'table') {
    if (!field.columns) field.columns = [{ id: 'c1', type: 'text', label: '' }];
    if (!field.maxRows) field.maxRows = 10;
  }
}

function newId(items, prefix) {
  let n = items.length + 1;
  while (items.some((item) => item.id === `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

function hasMyNumber() {
  return editing.form.fields.some((f) => f.type === 'mynumber'
    || (f.type === 'table' && f.columns.some((c) => c.type === 'mynumber')));
}

// マイナンバーの項目があるときは、暗号化を外せない
function showEncryptNote() {
  const forced = hasMyNumber();
  if (forced) editing.form.encrypt = true;
  edEncrypt.checked = editing.form.encrypt;
  edEncrypt.disabled = forced;
  const note = document.getElementById('ed-encrypt-note');
  if (forced) note.textContent = 'マイナンバーの項目があるため、暗号化は外せません。';
  else if (editing.form.encrypt) note.textContent = '入力内容は事務所の鍵でしか開けません。サーバーやドライブから漏れても読まれません。';
  else note.textContent = '暗号化しない場合、入力内容はドライブにそのまま保存されます。個人情報を含む入力ページでは暗号化してください。';
}

function renderFields() {
  const fields = editing.form.fields;
  edFields.replaceChildren(...fields.map((field, i) => fieldEditor(field, i, fields)));
  showEncryptNote();
}

function fieldEditor(field, i, fields) {
  const li = document.createElement('li');
  li.className = `ed-field${field.type === 'heading' ? ' is-heading' : ''}`;

  const type = select(TYPES, field.type, '項目の種類');
  type.addEventListener('change', () => {
    field.type = type.value;
    if (field.type !== 'select') delete field.options;
    if (field.type !== 'table') { delete field.columns; delete field.maxRows; }
    prepareField(field);
    renderFields();
  });
  const label = input(field.label, field.type === 'heading' ? '見出しの文字' : '項目名（例：氏名）', 200);
  label.addEventListener('input', () => { field.label = label.value; });
  const top = document.createElement('div');
  top.className = 'ed-field-top';
  top.append(type, label);

  const help = input(field.help || '', '説明（任意）：入力のしかたなど', 500);
  help.addEventListener('input', () => { field.help = help.value; });
  help.style.marginTop = '8px';

  const sub = document.createElement('div');
  sub.className = 'ed-field-sub';
  if (field.type !== 'heading') {
    sub.append(checkLine('必須', field.required, (checked) => { field.required = checked; }));
  }
  const ops = document.createElement('div');
  ops.className = 'ed-field-ops';
  ops.append(
    button('↑', () => move(fields, i, -1), 'button-outline'),
    button('↓', () => move(fields, i, 1), 'button-outline'),
    button('削除', () => { fields.splice(i, 1); renderFields(); }, 'button-danger'),
  );
  ops.children[0].disabled = i === 0;
  ops.children[1].disabled = i === fields.length - 1;
  ops.children[0].setAttribute('aria-label', '上へ');
  ops.children[1].setAttribute('aria-label', '下へ');
  sub.append(ops);

  li.append(top, help);
  if (field.type === 'select') li.append(optionsEditor(field));
  if (field.type === 'table') li.append(columnsEditor(field));
  li.append(sub);
  return li;
}

function optionsEditor(field) {
  const area = document.createElement('textarea');
  area.rows = 3;
  area.placeholder = '選択肢を1行に1つずつ入力（例：甲欄、乙欄）';
  area.setAttribute('aria-label', '選択肢');
  area.value = field.options.join('\n');
  area.addEventListener('input', () => {
    field.options = area.value.split('\n').map((s) => s.trim()).filter(Boolean);
  });
  return area;
}

function columnsEditor(field) {
  const box = document.createElement('div');
  box.className = 'ed-columns';
  const title = document.createElement('p');
  title.className = 'ed-small';
  title.style.margin = '0 0 6px';
  title.textContent = '表の列';
  box.append(title);
  field.columns.forEach((col, i) => {
    const row = document.createElement('div');
    row.className = 'ed-column';
    const name = input(col.label, '列名（例：続柄）', 100);
    name.addEventListener('input', () => { col.label = name.value; });
    const type = select(COLUMN_TYPES, col.type, '列の種類');
    type.addEventListener('change', () => {
      col.type = type.value;
      showEncryptNote();
    });
    const remove = button('×', () => {
      field.columns.splice(i, 1);
      renderFields();
    }, 'button-outline');
    remove.setAttribute('aria-label', '列を削除');
    remove.disabled = field.columns.length === 1;
    row.append(name, type, remove);
    box.append(row);
  });
  const rows = document.createElement('label');
  rows.className = 'ed-rows ed-small';
  const max = document.createElement('input');
  max.type = 'number';
  max.min = 1;
  max.max = 50;
  max.value = field.maxRows;
  max.addEventListener('input', () => { field.maxRows = Number(max.value); });
  rows.append('最大の行数', max);
  const add = button('列を追加', () => {
    field.columns.push({ id: newId(field.columns, 'c'), type: 'text', label: '' });
    renderFields();
  }, 'button-outline');
  add.disabled = field.columns.length >= 20;
  const footer = document.createElement('div');
  footer.className = 'ed-field-sub';
  footer.append(add, rows);
  box.append(footer);
  return box;
}

function move(fields, i, step) {
  const [field] = fields.splice(i, 1);
  fields.splice(i + step, 0, field);
  renderFields();
}

// --- 顧問先への依頼URL ---

const requestsCard = document.getElementById('requests');
const requestDetail = document.getElementById('request-detail');

document.getElementById('requests-close').addEventListener('click', () => { requestsCard.hidden = true; });

document.getElementById('request-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = document.getElementById('request-code').value;
  run(async () => {
    const { request } = await api('requests/add', { formId: current.id, code });
    await loadRequests();
    await loadForms();
    await showRequest(request);
  });
});

document.getElementById('request-copy').addEventListener('click', async () => {
  const url = document.getElementById('request-url');
  try {
    await navigator.clipboard.writeText(url.value);
    showMessage('URLをコピーしました', 'ok');
  } catch {
    url.select();
    showMessage('コピーできませんでした。URLを選択したので、手動でコピーしてください', 'error');
  }
});

async function openRequests(form) {
  current = form;
  document.getElementById('requests-title').textContent = `「${form.title}」の依頼URL`;
  const res = await fetchJson('/api/staff/clients/list');
  const codes = document.getElementById('request-code');
  codes.replaceChildren(...res.clients.map((c) => new Option(c.code, c.code)));
  requestDetail.hidden = true;
  await loadRequests();
  requestsCard.hidden = false;
  requestsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadRequests() {
  const { requests } = await api('requests/list', { formId: current.id });
  document.getElementById('request-list').replaceChildren(...requests.map((req) => {
    const tr = document.createElement('tr');
    const ops = document.createElement('td');
    ops.className = 'ops';
    const show = () => ops.replaceChildren(
      button('URL・QR', () => run(() => showRequest(req))),
      button('取り消し', () => askConfirm(ops, `${req.code} のURLを取り消しますか？ 今のURLとQRコードは使えなくなります。`,
        '取り消す', async () => {
          await api('requests/remove', { token: req.token });
          requestDetail.hidden = true;
          showMessage(`${req.code} のURLを取り消しました`, 'ok');
          await loadRequests();
          await loadForms();
        }, show), 'button-danger'),
    );
    show();
    tr.append(cell(req.code), cell(req.created), ops);
    return tr;
  }));
  document.getElementById('requests-empty').hidden = requests.length > 0;
}

async function showRequest(req) {
  document.getElementById('request-detail-title').textContent = `${req.code} に送るURL`;
  document.getElementById('request-url').value = req.url;
  const { dataUrl } = await api('requests/qr', { token: req.token });
  document.getElementById('request-qr').src = dataUrl;
  const save = document.getElementById('request-qr-save');
  save.href = dataUrl;
  save.download = `${req.code}_${current.title}_QRコード.png`;
  requestDetail.hidden = false;
}

// --- 届いた入力内容 ---

const subCard = document.getElementById('submissions');
const subView = document.getElementById('sub-view');

document.getElementById('sub-close').addEventListener('click', () => {
  subCard.hidden = true;
  subView.replaceChildren();
});
document.getElementById('sub-latest').addEventListener('change', renderSubmissions);
document.getElementById('sub-csv').addEventListener('click', () => run(exportCsv));

async function openSubmissions(form) {
  current = form;
  document.getElementById('submissions-title').textContent = `「${form.title}」に届いた内容`;
  subView.hidden = true;
  subView.replaceChildren();
  submissions = (await api('submissions/list', { formId: form.id })).submissions;
  renderSubmissions();
  subCard.hidden = false;
  subCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function visibleSubmissions() {
  if (!document.getElementById('sub-latest').checked) return submissions;
  // 新しい順に並んでいるので、顧問先ごとに最初の1件を残す
  const seen = new Set();
  return submissions.filter((s) => !seen.has(s.code) && seen.add(s.code));
}

function renderSubmissions() {
  const list = visibleSubmissions();
  document.getElementById('sub-list').replaceChildren(...list.map((sub) => {
    const tr = document.createElement('tr');
    const ops = document.createElement('td');
    ops.className = 'ops';
    const show = () => ops.replaceChildren(
      button('表示', () => run(() => showSubmission(sub))),
      button('削除', () => askConfirm(ops, `${sub.code}（${formatDate(sub.submitted)}）の入力内容を削除しますか？ ドライブのゴミ箱に移り、30日後に完全に削除されます。`,
        '削除する', async () => {
          await api('submissions/remove', { id: sub.id });
          submissions = submissions.filter((s) => s !== sub);
          subView.hidden = true;
          subView.replaceChildren();
          renderSubmissions();
          showMessage('入力内容を削除しました', 'ok');
        }, show), 'button-danger'),
    );
    show();
    tr.append(cell(sub.code), cell(formatDate(sub.submitted)), ops);
    return tr;
  }));
  document.getElementById('sub-empty').hidden = list.length > 0;
}

// 入力内容のファイルを読み込み、暗号化されていれば復号する
async function openRecord(id) {
  const { record } = await api('submissions/get', { id });
  if (!record.encrypted) return { record, answers: record.answers || {} };
  if (!loadedKey) throw new Error('暗号化されています。先に「暗号化の鍵」で鍵を読み込んでください');
  if (record.encrypted.keyId !== loadedKey.fingerprint) {
    throw new Error(`読み込んだ鍵とは別の鍵（${FormCrypto.shortFingerprint(record.encrypted.keyId)}）で暗号化されています。その鍵を読み込んでください`);
  }
  try {
    return { record, answers: await FormCrypto.decrypt(loadedKey.privateKey, record.encrypted) };
  } catch {
    throw new Error('復号できませんでした。ファイルが壊れているおそれがあります');
  }
}

async function showSubmission(sub) {
  const { record, answers } = await openRecord(sub.id);
  const h = document.createElement('h3');
  h.textContent = `${record.code}　${formatDate(record.submitted)}`;
  const table = document.createElement('table');
  for (const field of record.fields) {
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
    tr.append(th);
    const td = tr.insertCell();
    const value = answers[field.id];
    if (field.type === 'table') td.append(answerTable(field, value || []));
    else td.textContent = displayValue(field, value) || '—';
  }
  const close = button('閉じる', () => { subView.hidden = true; subView.replaceChildren(); }, 'button-outline');
  close.style.marginTop = '12px';
  subView.replaceChildren(h, table, close);
  subView.hidden = false;
  subView.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function answerTable(field, rows) {
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

function displayValue(field, value) {
  if (field.type === 'checkbox') return value ? 'はい' : '';
  return value == null ? '' : String(value);
}

// 加工しやすいように、1件を1行にして書き出す（表の項目は「扶養家族1_氏名」のように列を分ける）
async function exportCsv() {
  const list = visibleSubmissions();
  if (!list.length) throw new Error('書き出す入力内容がありません');
  const records = [];
  for (const [i, sub] of list.entries()) {
    showMessage(`読み込んでいます（${i + 1}/${list.length}）…`, 'ok');
    records.push(await openRecord(sub.id));
  }
  const fields = current.fields.filter((f) => f.type !== 'heading');
  const rowCounts = {};
  for (const field of fields.filter((f) => f.type === 'table')) {
    rowCounts[field.id] = Math.max(1, ...records.map((r) => (r.answers[field.id] || []).length));
  }
  const header = ['顧問先', '送信日時'];
  for (const field of fields) {
    if (field.type !== 'table') header.push(field.label);
    else for (let n = 1; n <= rowCounts[field.id]; n++) {
      for (const col of field.columns) header.push(`${field.label}${n}_${col.label}`);
    }
  }
  const lines = [header];
  for (const { record, answers } of records) {
    const line = [record.code, formatDate(record.submitted)];
    for (const field of fields) {
      if (field.type !== 'table') line.push(displayValue(field, answers[field.id]));
      else for (let n = 0; n < rowCounts[field.id]; n++) {
        const row = (answers[field.id] || [])[n] || {};
        for (const col of field.columns) line.push(row[col.id] || '');
      }
    }
    lines.push(line);
  }
  const csv = '﻿' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${current.title}_${today()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showMessage(`${records.length}件をCSVに書き出しました`, 'ok');
}

// Excel で開いたときに数式として動かないよう、記号で始まる値の先頭に ' を付ける
function csvCell(value) {
  let v = String(value);
  if (/^[=+@\t\r]/.test(v) || (/^-/.test(v) && !/^-[\d,.]+$/.test(v))) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

// --- 共通 ---

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

async function run(task) {
  setBusy(true);
  try {
    await task();
  } catch (err) {
    showMessage(err.message, 'error');
  } finally {
    setBusy(false);
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
