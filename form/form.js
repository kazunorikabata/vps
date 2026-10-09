// 顧問先の入力ページ
// 項目は事務所内ページで作ったものを読み込んで表示する。暗号化する入力ページでは、
// 入力内容をこの画面の中で事務所の公開鍵で暗号化してから送る（VPS には読めない形でしか届かない）
// 項目の並べ方（マス目）と部品の表示は render.js（事務所内ページと共通）
// ページ区切りがあれば、1ページずつ「次へ」で進む（次へ進むときに、そのページの入力を確かめる）
const NETWORK_ERROR = '通信できませんでした。電波の良い場所で再度お試しください';

const token = location.hash.slice(1);
// 事務所内ページの事務所用の入力ページ（staff/entry.html）。URL の # 以降は入力ページの番号で、
// 送り先は事務所内の API（職員のIDとパスワードで保護。保存先は「事務所の記録」フォルダ）
const office = document.body.dataset.mode === 'office';
const API_BASE = office ? '/api/staff/office/' : '/api/form/';
const who = office ? { formId: token } : { token };
// 事務所内ページの作成画面の「プレビュー」から開いたとき。項目は作成画面から受け取り、送信はしない
const preview = token === 'preview';
const form = document.getElementById('entry-form');
const fieldsBox = document.getElementById('fields');
const formError = document.getElementById('form-error');
const sendButton = document.getElementById('send');
const prevButton = document.getElementById('prev');
const nextButton = document.getElementById('next');

let page = null;
let controls = [];
let steps = [];      // ページごとの { title, box, controls }
let stepIndex = 0;   // 表示しているページ
let dirty = false;

start();

async function start() {
  try {
    if (preview) {
      page = previewForm();
    } else {
      if (office ? !/^f[0-9a-f]{12}$/.test(token) : !/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
        throw new Error(office ? '入力ページが見つかりません。' : 'このURLは無効です。事務所にお問い合わせください。');
      }
      page = await api('get', who);
      if (page.encrypt && !FormCrypto.supported()) {
        throw new Error('お使いのブラウザでは送信できません。最新のブラウザ（Chrome、Safari、Edge など）でお試しください。');
      }
    }
  } catch (err) {
    showInvalid(err.message);
    return;
  }
  document.getElementById('preview-note').hidden = !preview;
  document.title = `${page.title}｜蒲田和紀税理士事務所`;
  document.getElementById('title').textContent = page.title;
  document.getElementById('description').textContent = page.description;
  document.getElementById('secure-note').hidden = !page.encrypt;
  if (office && page.clientSelect) await setupClientSelect();
  steps = FormRender.splitPages(page.fields).map((p) => {
    const box = document.createElement('section');
    const grid = document.createElement('div');
    box.append(grid);
    fieldsBox.append(box);
    return { title: p.title, box, controls: FormRender.buildForm(grid, p.fields, { layout: page }) };
  });
  controls = steps.flatMap((s) => s.controls);
  if (!preview) startDraft();
  showStep(0);
  document.getElementById('loading').hidden = true;
  form.hidden = false;
}

function showStep(index) {
  stepIndex = index;
  steps.forEach((s, i) => { s.box.hidden = i !== index; });
  const last = index === steps.length - 1;
  const label = document.getElementById('page-step');
  label.textContent = `${index + 1} / ${steps.length} ページ${steps[index].title ? `　${steps[index].title}` : ''}`;
  label.hidden = steps.length === 1;
  prevButton.hidden = index === 0;
  nextButton.hidden = last;
  sendButton.hidden = !last;
  formError.hidden = true;
}

function moveStep(index) {
  showStep(index);
  window.scrollTo({ top: 0 });
}

prevButton.addEventListener('click', () => moveStep(stepIndex - 1));

// 開いた元の作成画面から、編集中の内容を受け取る（別のサイトから開かれたときは、ブラウザが読ませない）
function previewForm() {
  let form = null;
  try {
    form = JSON.parse(JSON.stringify(window.opener.formPreview()));
  } catch {
    // 作成画面から開いていない、または作成画面が閉じられた
  }
  if (!form) throw new Error('プレビューは、事務所内ページの入力ページの作成画面から開いてください。');
  if (!form.title) form.title = '（名前を入れてください）';
  return form;
}

// 事務所用で「顧問先を選ぶ」入力ページ：顧問先の一覧を選択肢にする（?code= があれば選んでおく）
async function setupClientSelect() {
  let clients = [];
  try {
    const res = await fetch('/api/staff/clients/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    clients = (await res.json()).clients || [];
  } catch {
    throw new Error(NETWORK_ERROR);
  }
  const select = document.getElementById('client-select');
  select.replaceChildren(new Option('選択してください', ''), ...clients.map((c) => new Option(c.code, c.code)));
  const code = new URLSearchParams(location.search).get('code');
  if (code && clients.some((c) => c.code === code)) select.value = code;
  document.getElementById('client-select-row').hidden = false;
}

// 選んだ顧問先（選ぶ必要がなければ ''、選んでいなければ null）
function selectedClient() {
  if (!office || !page.clientSelect) return '';
  const select = document.getElementById('client-select');
  if (select.value) return select.value;
  showFormError('顧問先を選んでください。');
  select.scrollIntoView({ behavior: 'smooth', block: 'center' });
  select.focus();
  return null;
}

function showInvalid(text) {
  document.getElementById('loading').hidden = true;
  const invalid = document.getElementById('invalid');
  invalid.textContent = text;
  invalid.hidden = false;
}

form.addEventListener('input', () => { dirty = !preview; });

// 入力の途中でページを閉じようとしたら確認する
window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formError.hidden = true;
  // 最後のページでなければ、このページを確かめて次へ（入力欄で Enter を押したときも）
  if (stepIndex < steps.length - 1) {
    if (collect(steps[stepIndex].controls)) moveStep(stepIndex + 1);
    return;
  }
  const answers = collect();
  if (!answers) return;
  const code = selectedClient();
  if (code === null) return;
  sendButton.disabled = true;
  sendButton.textContent = '送信しています…';
  try {
    // プレビューでは送信せず、そのまま送信後の画面（PDF の確認）へ進む
    let submitted = new Date().toISOString();
    if (preview) {
      for (const c of controls.filter((x) => x.field.type === 'file')) {
        answers[c.field.id] = answers[c.field.id].map((f) => ({ name: f.name, size: f.size, type: f.type }));
      }
    } else {
      const body = { ...who };
      if (code) body.code = code;
      const batch = await sendFiles(answers);
      if (batch) body.batch = batch;
      sendButton.textContent = '送信しています…';
      if (page.encrypt) body.encrypted = await FormCrypto.encrypt(page.publicKey, page.keyId, answers);
      else body.answers = answers;
      submitted = (await api('submit', body)).submitted;
    }
    dirty = false;
    if (!preview) clearDraft();
    showDone(answers, submitted);
  } catch (err) {
    showFormError(err.message);
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = '送信する';
  }
});

document.getElementById('print').addEventListener('click', () => window.print());

// --- 添付ファイル ---
// 1つずつこの画面の中で暗号化し、ドライブに直接送る（VPS は通らない）。
// answers のファイルの欄を { fileId, name, type, size, key } の一覧に置き換える（鍵は入力内容と一緒に暗号化される）。
// ファイルがあれば、入力内容と結び付ける番号（batch）を返す
async function sendFiles(answers) {
  const fileControls = controls.filter((c) => c.field.type === 'file');
  const total = fileControls.reduce((n, c) => n + answers[c.field.id].length, 0);
  if (!total) {
    for (const c of fileControls) answers[c.field.id] = [];
    return null;
  }
  if (!page.encrypt) throw new Error('この入力ページではファイルを送れません。事務所にお問い合わせください。');
  const batch = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  let done = 0;
  for (const c of fileControls) {
    const sent = [];
    for (const file of answers[c.field.id]) {
      done += 1;
      sendButton.textContent = `ファイルを送信しています（${done}/${total}）…`;
      const { blob, key } = await FormCrypto.encryptFile(file);
      const session = await api('file-session', { ...who, fieldId: c.field.id, size: blob.size, batch });
      const uploaded = await putFile(session.uploadUrl, blob);
      await api('file-complete', { ...who, fileId: uploaded.id });
      sent.push({ fileId: uploaded.id, name: file.name, type: file.type, size: file.size, key });
    }
    answers[c.field.id] = sent;
  }
  return batch;
}

function putFile(url, blob) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.addEventListener('load', () => {
      try {
        if (xhr.status !== 200 && xhr.status !== 201) throw new Error();
        resolve(JSON.parse(xhr.responseText));
      } catch {
        reject(new Error('ファイルを送信できませんでした。時間をおいて再度お試しください'));
      }
    });
    xhr.addEventListener('error', () => reject(new Error(NETWORK_ERROR)));
    xhr.send(blob);
  });
}

// --- 途中保存（この端末のブラウザに下書きを残す） ---
// 入力するたびに自動で保存し、同じURLを同じ端末で開き直すと続きから入力できる。
// サーバーには送らない。マイナンバーは保存しない。送信したら消し、30日たったものも消す
const DRAFT_PREFIX = 'kabaoffice-form-draft:';
const DRAFT_DAYS = 30;
let draftTimer = null;

function startDraft() {
  removeOldDrafts();
  const draft = readDraft();
  if (draft) fillDraft(draft.values);
  showDraftNote(draft);
  for (const type of ['input', 'change', 'click']) {
    form.addEventListener(type, () => {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(saveDraft, 500);
    });
  }
}

function readDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_PREFIX + token));
    return draft && draft.values ? draft : null;
  } catch {
    return null;
  }
}

function saveDraft() {
  const values = {};
  for (const c of controls) {
    if (c.field.type === 'mynumber' || c.field.type === 'file') continue;
    if (c.field.type === 'checkbox') {
      values[c.field.id] = c.input.checkbox.checked;
    } else if (c.field.type === 'checkboxes') {
      values[c.field.id] = c.input.checks.filter((x) => x.checked).map((x) => x.value);
    } else if (c.field.type === 'table') {
      const skip = c.field.columns.filter((col) => col.type === 'mynumber').map((col) => col.id);
      values[c.field.id] = FormRender.tableRows(c, true).map((row) => {
        for (const id of skip) delete row[id];
        return row;
      });
    } else {
      values[c.field.id] = c.input.value;
    }
  }
  try {
    localStorage.setItem(DRAFT_PREFIX + token, JSON.stringify({ saved: new Date().toISOString(), values }));
  } catch {
    // 保存できないブラウザ（プライベートブラウズなど）では、途中保存なしで使う
  }
}

// 入力ページが直されていても、残っている項目だけ戻す（マイナンバーとファイルは戻さない）
function fillDraft(values) {
  for (const c of controls) FormValues.fill(c, values[c.field.id], { skipMyNumber: true });
}

function clearDraft() {
  clearTimeout(draftTimer);
  try {
    localStorage.removeItem(DRAFT_PREFIX + token);
  } catch {
    // 何もしない
  }
}

function removeOldDrafts() {
  const limit = Date.now() - DRAFT_DAYS * 24 * 3600 * 1000;
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(DRAFT_PREFIX)) continue;
      let saved = NaN;
      try {
        saved = new Date(JSON.parse(localStorage.getItem(key)).saved).getTime();
      } catch {
        // 壊れた下書きは消す
      }
      if (!(saved > limit)) localStorage.removeItem(key);
    }
  } catch {
    // 何もしない
  }
}

function showDraftNote(draft) {
  const note = document.getElementById('draft-note');
  const text = document.getElementById('draft-text');
  const hasFile = [...FormRender.iterFields(page.fields)].some((f) => f.type === 'file');
  const mynumber = (hasMyNumber() ? 'マイナンバーは保存しません。' : '') + (hasFile ? 'ファイルは保存しません。' : '');
  if (draft) {
    const when = new Date(draft.saved).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const again = [hasMyNumber() && 'マイナンバー', hasFile && 'ファイル'].filter(Boolean).join('と');
    text.textContent = `前回（${when}）の途中まで入力した内容を戻しました。${again ? `${again}はもう一度入力してください。` : ''}`;
    note.classList.add('is-restored');
  } else {
    text.textContent = `入力内容はこの端末に自動で一時保存され、同じ端末でこのページを開き直すと続きから入力できます（送信すると消えます）。${mynumber}家族などと共用の端末では、入力をやめるときに下のボタンで消してください。`;
  }
  note.hidden = false;
}

document.getElementById('draft-clear').addEventListener('click', (event) => {
  event.stopPropagation();   // 消した直後に保存し直さない
  clearDraft();
  dirty = false;
  location.reload();
});

function hasMyNumber() {
  return [...FormRender.iterFields(page.fields)].some((f) => f.type === 'mynumber'
    || (f.columns || []).some((c) => c.type === 'mynumber'));
}

// --- 入力内容の取りまとめと確認 ---

// list：確かめる入力欄（「次へ」ではそのページの分だけ）。直すところが別のページにあれば、そのページを開く
function collect(list = controls) {
  const answers = {};
  let first = null;
  for (const c of list) {
    const value = FormValues.read(c);
    const message = FormValues.check(c.field, value);
    c.error.textContent = message;
    c.error.hidden = !message;
    c.box.classList.toggle('has-error', Boolean(message));
    if (message && !first) first = c;
    answers[c.field.id] = value;
  }
  if (first) {
    const at = steps.findIndex((s) => s.controls.includes(first));
    if (at !== stepIndex) showStep(at);
    showFormError('入力内容を確認してください。');
    first.box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return null;
  }
  return answers;
}

function showFormError(text) {
  formError.textContent = text;
  formError.hidden = false;
}

// --- 送信後：PDF 用の表示 ---

function showDone(answers, submitted) {
  buildPrintView(answers, submitted);
  form.hidden = true;
  document.getElementById('done-mynumber').hidden = !hasMyNumber();
  document.getElementById('done').hidden = false;
  window.scrollTo({ top: 0 });
}

// PDF（印刷）用：入力画面と同じ並びで、入力した内容を表示する
function buildPrintView(answers, submitted) {
  const view = document.getElementById('print-view');
  view.classList.toggle('no-border', page.pdfBorder === false);
  const h = document.createElement('h1');
  h.textContent = page.title;
  const meta = document.createElement('p');
  meta.className = 'print-meta';
  const when = new Date(submitted).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  meta.textContent = office ? `入力日時：${when}` : `送信日時：${when}　送信先：蒲田和紀税理士事務所`;
  const grid = document.createElement('div');
  FormRender.buildView(grid, page.fields, answers, page);
  view.replaceChildren(h, meta, grid);
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
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
