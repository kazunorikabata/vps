// 顧問先の入力ページ
// 項目は事務所内ページで作ったものを読み込んで表示する。暗号化する入力ページでは、
// 入力内容をこの画面の中で事務所の公開鍵で暗号化してから送る（VPS には読めない形でしか届かない）
// 項目の並べ方（マス目）と部品の表示は render.js（事務所内ページと共通）
// ページ区切りがあれば、1ページずつ「次へ」で進む（次へ進むときに、そのページの入力を確かめる）
const NETWORK_ERROR = '通信できませんでした。電波の良い場所で再度お試しください';

const token = location.hash.slice(1);
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
  steps = FormRender.splitPages(page.fields).map((p) => {
    const box = document.createElement('section');
    const grid = document.createElement('div');
    box.append(grid);
    fieldsBox.append(box);
    return { title: p.title, box, controls: FormRender.buildForm(grid, p.fields) };
  });
  controls = steps.flatMap((s) => s.controls);
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
  // 最後のページでなければ、このページを確かめて次へ（入力欄で Enter を押したときも）
  if (stepIndex < steps.length - 1) {
    if (collect(steps[stepIndex].controls)) moveStep(stepIndex + 1);
    return;
  }
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

// --- 入力内容の取りまとめと確認 ---

// list：確かめる入力欄（「次へ」ではそのページの分だけ）。直すところが別のページにあれば、そのページを開く
function collect(list = controls) {
  const answers = {};
  let first = null;
  for (const c of list) {
    const value = c.field.type === 'table' ? tableValue(c) : inputValue(c);
    const message = check(c.field, value);
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

function inputValue(c) {
  if (c.field.type === 'checkbox') return c.input.checkbox.checked;
  const value = normalize(c.field.type, c.input.value);
  if (c.input.tagName !== 'SELECT') c.input.value = value;
  return value;
}

function tableValue(c) {
  for (const input of c.body.querySelectorAll('input[data-col]')) {
    const col = c.field.columns.find((x) => x.id === input.dataset.col);
    input.value = normalize(col.type, input.value);
  }
  return FormRender.tableRows(c);
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
        const rowName = field.rowLabels ? field.rowLabels[i] : `${i + 1}行目`;
        if (message) return `${rowName}の「${col.label}」：${message}`;
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
  const hasMyNumber = [...FormRender.iterFields(page.fields)].some((f) => f.type === 'mynumber'
    || (f.columns || []).some((c) => c.type === 'mynumber'));
  document.getElementById('done-mynumber').hidden = !hasMyNumber;
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
  meta.textContent = `送信日時：${new Date(submitted).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}　送信先：蒲田和紀税理士事務所`;
  const grid = document.createElement('div');
  FormRender.buildView(grid, page.fields, answers);
  view.replaceChildren(h, meta, grid);
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
