// 事務所内ページ：顧客台帳（顧問先ごとに1件。開いて直し、保存するたびにスプレッドシートに行を足す）
// 中身は暗号化したまま届くので、このページで開いた鍵で復号してから、一覧・検索・表示をする（サーバーは中身を読めない）。
// 保存するときは、事務所の公開鍵でこのページの中で暗号化してから送る。
// forms.js の共通の関数（run・api・fetchJson・showMessage・button・cell・formatDate）と forms・registeredKey・loadedKey、
// /form/render.js（表示）・values.js（値の読み取りと確認）・crypto.js（暗号化）を使う
const registerCard = document.getElementById('register');
const registerSearch = document.getElementById('register-search');
let ledger = null;        // 開いている台帳 { form, records: [{ id, code, submitted, staff, versions, answers, error }] }
let ledgerCode = null;    // 開いている顧問先
let ledgerControls = [];

document.getElementById('register-close').addEventListener('click', () => {
  registerCard.hidden = true;
  ledger = null;
});
document.getElementById('register-edit-close').addEventListener('click', closeLedgerEdit);
registerSearch.addEventListener('input', renderLedger);
document.getElementById('register-new').addEventListener('click', () => {
  const code = document.getElementById('register-new-code').value;
  if (!code) return showMessage('台帳がまだない顧問先はありません', 'error');
  run(() => openLedgerEdit(code));
});
document.getElementById('register-save').addEventListener('click', () => run(saveLedger));

// 「顧問先の登録・URL」の「台帳」から来たとき（?kind=register&code=…）。台帳が1つならそのまま開く
function startRegister() {
  const code = new URLSearchParams(location.search).get('code');
  if (!code) return;
  if (forms.length === 1) run(() => openRegister(forms[0]));
  else if (forms.length > 1) showMessage(`${code} の台帳を開くには、どの台帳かを選んで「台帳を開く」を押してください`, 'ok');
  else showMessage('まだ台帳がありません。「新しい台帳を作る」で、台帳の項目を作ってください', 'ok');
}

async function openRegister(form) {
  ledger = { form, records: [] };
  document.getElementById('register-title').textContent = `「${form.title}」`;
  registerSearch.value = '';
  closeLedgerEdit();
  registerCard.hidden = false;
  await loadLedger();
  registerCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function registerKeyChanged() {
  if (ledger && !registerCard.hidden) run(loadLedger);
}

async function loadLedger() {
  const locked = !loadedKey;
  document.getElementById('register-locked').hidden = !locked;
  document.getElementById('register-body').hidden = locked;
  if (locked) return;
  const data = await api('register/records', { formId: ledger.form.id });
  const records = [];
  for (const r of data.records) {
    let answers = null;
    let error = '';
    if (r.encrypted.keyId !== loadedKey.fingerprint) {
      error = '別の鍵で暗号化されています';
    } else {
      try {
        answers = await FormCrypto.decrypt(loadedKey.privateKey, r.encrypted);
      } catch {
        error = '復号できません';
      }
    }
    records.push({ ...r, answers, error });
  }
  ledger.records = records;
  // 台帳がまだない顧問先を「作る」の選択肢にする
  const { clients } = await fetchJson('/api/staff/clients/list');
  const have = new Set(records.map((r) => r.code));
  document.getElementById('register-new-code').replaceChildren(
    ...clients.filter((c) => !have.has(c.code)).map((c) => new Option(c.code, c.code)));
  renderLedger();
  const code = new URLSearchParams(location.search).get('code');
  if (code && !ledger.openedFromUrl) {
    ledger.openedFromUrl = true;
    await openLedgerEdit(code);
  }
}

function listedFields() {
  return [...FormRender.iterFields(ledger.form.fields)].filter((f) => f.listed && FormRender.isInput(f));
}

function renderLedger() {
  if (!ledger) return;
  const fields = listedFields();
  const head = document.getElementById('register-head');
  head.replaceChildren(...['番号', ...fields.map((f) => f.label), '最終更新', '操作'].map((t) => {
    const th = document.createElement('th');
    th.textContent = t;
    return th;
  }));
  const query = registerSearch.value.trim().toLowerCase();
  const rows = ledger.records.filter((r) => {
    if (!query) return true;
    const text = [r.code, ...fields.map((f) => FormRender.displayValue(f, r.answers ? r.answers[f.id] : ''))].join(' ');
    return text.toLowerCase().includes(query);
  });
  document.getElementById('register-list').replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr');
    const values = fields.map((f) => cell(r.error || FormRender.displayValue(f, r.answers[f.id]) || '—'));
    const ops = document.createElement('td');
    ops.className = 'ops';
    ops.append(button('開く', () => run(() => openLedgerEdit(r.code))));
    tr.append(cell(r.code), ...values, cell(`${formatDate(r.submitted)}（${r.staff || '-'}）`), ops);
    return tr;
  }));
  document.getElementById('register-empty').hidden = ledger.records.length > 0;
}

// --- 1社分を開いて直す ---

async function openLedgerEdit(code) {
  ledgerCode = code;
  const rec = ledger.records.find((r) => r.code === code);
  if (rec && rec.error) throw new Error(`${code} の台帳を開けません（${rec.error}）`);
  document.getElementById('register-edit-title').textContent = rec
    ? `${code} の台帳（最終更新 ${formatDate(rec.submitted)}・${rec.staff || '-'}、保存${rec.versions}回）`
    : `${code} の台帳（新しく作る）`;
  // いまの台帳の項目で表示し、保存してある値を戻す（項目を直したあとも、同じ番号の項目は引き継ぐ）
  const box = document.getElementById('register-fields');
  box.replaceChildren();
  ledgerControls = FormRender.buildForm(box, ledger.form.fields, { layout: ledger.form });
  if (rec) for (const c of ledgerControls) FormValues.fill(c, rec.answers[c.field.id]);
  document.getElementById('register-version').hidden = true;
  document.getElementById('register-edit').hidden = false;
  // 対応の記録が読み込めなくても、台帳そのものは開けるようにする
  await loadLedgerActivities().catch(() => {
    const empty = document.getElementById('register-activities-empty');
    empty.textContent = '対応の記録を読み込めませんでした。';
    empty.hidden = false;
  });
  await loadLedgerHistory();
  document.getElementById('register-edit').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeLedgerEdit() {
  ledgerCode = null;
  ledgerControls = [];
  document.getElementById('register-edit').hidden = true;
  document.getElementById('register-fields').replaceChildren();
  document.getElementById('register-version').replaceChildren();
}

async function saveLedger() {
  const answers = {};
  let first = null;
  for (const c of ledgerControls) {
    const value = FormValues.read(c);
    const msg = FormValues.check(c.field, value);
    c.error.textContent = msg;
    c.error.hidden = !msg;
    c.box.classList.toggle('has-error', Boolean(msg));
    if (msg && !first) first = c;
    answers[c.field.id] = value;
  }
  if (first) {
    first.box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    throw new Error('入力内容を確認してください');
  }
  if (!registeredKey || !registeredKey.spki) throw new Error('暗号化の鍵が登録されていません');
  if (!loadedKey || loadedKey.fingerprint !== registeredKey.fingerprint) {
    throw new Error('開いている鍵が登録済みの鍵と違うため、保存できません');
  }
  const encrypted = await FormCrypto.encrypt(registeredKey.spki, registeredKey.fingerprint, answers);
  await api('register/save', { formId: ledger.form.id, code: ledgerCode, encrypted });
  const code = ledgerCode;
  await loadLedger();
  await openLedgerEdit(code);
  showMessage(`${code} の台帳を保存しました`, 'ok');
}

// --- 対応の記録（顧問先を選ぶ事務所用の入力ページに送られたもの） ---

async function loadLedgerActivities() {
  const code = ledgerCode;
  const { activities, forms: targets } = await api('register/activities', { code });
  document.getElementById('register-activity-new').replaceChildren(...targets.map((f) =>
    button(`＋${f.title}を入力する`, () => { location.href = `/staff/entry.html?code=${encodeURIComponent(code)}#${f.id}`; }, 'button-outline')));
  document.getElementById('register-activities').replaceChildren(...activities.map((a) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `${formatDate(a.submitted)}　${a.formTitle}　${a.staff || '-'}`;
    li.append(span, button('表示', () => run(() => showActivity(a)), 'button-outline'));
    return li;
  }));
  const empty = document.getElementById('register-activities-empty');
  empty.textContent = 'まだ記録がありません。';
  empty.hidden = activities.length > 0;
}

async function showActivity(a) {
  const { record } = await api('submissions/get', { formId: a.formId, id: a.id });
  let answers = record.answers;
  if (record.encrypted) {
    if (record.encrypted.keyId !== loadedKey.fingerprint) throw new Error('別の鍵で暗号化されています');
    answers = await FormCrypto.decrypt(loadedKey.privateKey, record.encrypted);
  }
  showInPanel(`${formatDate(a.submitted)}　${a.formTitle}（${a.staff || '-'}）`, record.fields, answers, {});
}

function showInPanel(heading, fields, answers, layout) {
  const view = document.getElementById('register-version');
  const title = document.createElement('h3');
  title.textContent = heading;
  const grid = document.createElement('div');
  FormRender.buildView(grid, fields, answers, layout);
  const close = button('閉じる', () => { view.hidden = true; view.replaceChildren(); }, 'button-outline');
  close.style.marginTop = '12px';
  view.replaceChildren(title, grid, close);
  view.hidden = false;
  view.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- 履歴（保存した版） ---

async function loadLedgerHistory() {
  const list = document.getElementById('register-history');
  const rec = ledger.records.find((r) => r.code === ledgerCode);
  if (!rec) {
    list.replaceChildren();
    return;
  }
  const { history } = await api('register/history', { formId: ledger.form.id, code: ledgerCode });
  list.replaceChildren(...history.map((h, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `${formatDate(h.submitted)}　${h.staff || '-'}${i === 0 ? '（今の内容）' : ''}`;
    li.append(span, button('表示', () => run(() => showLedgerVersion(h)), 'button-outline'));
    return li;
  }));
}

async function showLedgerVersion(h) {
  const { record } = await api('submissions/get', { formId: ledger.form.id, id: h.id });
  if (record.encrypted.keyId !== loadedKey.fingerprint) throw new Error('別の鍵で暗号化されています');
  const answers = await FormCrypto.decrypt(loadedKey.privateKey, record.encrypted);
  showInPanel(`${formatDate(h.submitted)}　${h.staff || '-'} が保存した内容`, record.fields, answers, ledger.form);
}
