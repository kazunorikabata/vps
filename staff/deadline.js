// 事務所内ページ：期限の管理（申告・納付などの期限。1件ずつ事務所の鍵で暗号化して保存する）
// 仕組みは TODO と同じ（/store/*。直す・消すたびに行を足す）。見る・直すには、上の欄で鍵を開く。
// 決算月や源泉の納付方法は顧客台帳から読み（どの台帳のどの項目かは「設定」で選ぶ）、期限をまとめて作れる。
// 期限日が土日なら翌月曜日にする（祝日には合わせない）。
// todo.js の members・me・memberName・todayIso・addDays・dueLabel・loadMembers・assigneeOptions、
// forms.js の allForms・registeredKey・loadedKey、common.js の共通の部品を使う
const DEADLINE_STATUS = { todo: '未着手', doing: '作業中', filed: '申告済み', done: '完了' };
const deadlineForm = document.getElementById('deadline-form');
const deadlineBulk = document.getElementById('deadline-bulk');
let deadlines = null;        // 復号した期限 [{ id, saved, staff, value }]（鍵を開くまで null）
let deadlineSettings = {};   // { registerId, monthField, withholdingField }
let deadlineClients = [];    // 顧問先の番号
let editingDeadline = null;
let bulkCandidates = [];     // まとめて作る候補 [{ code, info, items: [{ kind, due, exists }] }]

for (const id of ['deadline-month', 'deadline-kind', 'deadline-who', 'deadline-open']) {
  document.getElementById(id).addEventListener('change', renderDeadlines);
}
document.getElementById('deadline-add').addEventListener('click', () => openDeadlineForm(null));
document.getElementById('deadline-form-cancel').addEventListener('click', () => { deadlineForm.hidden = true; });
deadlineForm.addEventListener('submit', (event) => {
  event.preventDefault();
  run(saveDeadlineForm);
});
document.getElementById('deadline-bulk-show').addEventListener('click', () => run(openBulk));
document.getElementById('deadline-bulk-cancel').addEventListener('click', () => { deadlineBulk.hidden = true; });
for (const id of ['deadline-bulk-type', 'deadline-bulk-year', 'deadline-bulk-method', 'deadline-bulk-consumption']) {
  document.getElementById(id).addEventListener('change', () => run(renderBulk));
}
document.getElementById('deadline-bulk-run').addEventListener('click', () => run(runBulk));
document.getElementById('deadline-set-register').addEventListener('change', fillDeadlineFieldSelects);
document.getElementById('deadline-set-save').addEventListener('click', () => run(saveDeadlineSettings));

// 期限の管理の画面を開いたとき（app.js）
async function startDeadline() {
  await loadMembers();
  const { clients } = await api('clients/list');
  deadlineClients = clients.map((c) => c.code);
  const select = document.getElementById('deadline-form-client');
  select.replaceChildren(new Option('なし（事務所）', ''), ...deadlineClients.map((c) => new Option(c, c)));
  await loadDeadlineSettings();
  await loadDeadlines();
}

async function loadDeadlines() {
  const locked = !loadedKey;
  document.getElementById('deadline-locked').hidden = !locked;
  document.getElementById('deadline-body').hidden = locked;
  if (locked) {
    deadlines = null;
    return;
  }
  const { items } = await api('store/list', { store: 'deadline' });
  const list = [];
  for (const item of items) {
    if (item.encrypted.keyId !== loadedKey.fingerprint) continue;
    try {
      list.push({ ...item, value: await FormCrypto.decrypt(loadedKey.privateKey, item.encrypted) });
    } catch {
      // 壊れたものは出さない
    }
  }
  deadlines = list;
  fillDeadlineFilters();
  renderDeadlines();
}

function fillDeadlineFilters() {
  const keep = (id, values, label) => {
    const select = document.getElementById(id);
    const chosen = select.value;
    select.replaceChildren(new Option('すべて', ''), ...values.map((v) => new Option(label(v), v)));
    select.value = values.includes(chosen) ? chosen : '';
  };
  const months = [...new Set(deadlines.map((d) => (d.value.due || '').slice(0, 7)).filter(Boolean))].sort();
  keep('deadline-month', months, (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`);
  const kinds = [...new Set(deadlines.map((d) => d.value.kind))].sort();
  keep('deadline-kind', kinds, (k) => k);
  document.getElementById('deadline-kinds').replaceChildren(...kinds.map((k) => new Option(k)));
}

function renderDeadlines() {
  if (!deadlines) return;
  const month = document.getElementById('deadline-month').value;
  const kind = document.getElementById('deadline-kind').value;
  const who = document.getElementById('deadline-who').value;
  const openOnly = document.getElementById('deadline-open').checked;
  const today = todayIso();
  const list = deadlines
    .filter((d) => (!month || (d.value.due || '').startsWith(month)) && (!kind || d.value.kind === kind)
      && (who !== 'me' || d.value.assignee === me) && (!openOnly || d.value.status !== 'done'))
    .sort((a, b) => (a.value.due || '9999').localeCompare(b.value.due || '9999')
      || (a.value.client || '').localeCompare(b.value.client || '') || a.value.kind.localeCompare(b.value.kind));
  document.getElementById('deadline-list').replaceChildren(...list.map((d) => {
    const v = d.value;
    const tr = document.createElement('tr');
    if (v.status === 'done') tr.classList.add('is-done');
    else if (v.due < today) tr.classList.add('is-overdue');
    else if (v.due <= addDays(today, 7)) tr.classList.add('is-soon');
    const kindCell = cell(v.kind);
    if (v.memo) kindCell.title = v.memo;
    const ops = document.createElement('td');
    ops.className = 'ops';
    const show = () => ops.replaceChildren(
      ...(v.status === 'done' ? [] : [button('完了にする', () => run(() => saveDeadlineValue(d.id, { ...v, status: 'done' })))]),
      button('編集', () => openDeadlineForm(d), 'button-outline'),
      button('削除', () => askConfirm(ops, `${v.client || '事務所'}の「${v.kind}」（${v.due}）を削除しますか？`, '削除する', async () => {
        await api('store/remove', { store: 'deadline', id: d.id });
        await loadDeadlines();
        showMessage('期限を削除しました', 'ok');
      }, show), 'button-danger'),
    );
    show();
    tr.append(cell(dueLabel(v.due)), kindCell, cell(v.client || '—'), cell(memberName(v.assignee)),
      cell(DEADLINE_STATUS[v.status] || '未着手'), ops);
    return tr;
  }));
  document.getElementById('deadline-empty').hidden = list.length > 0;
}

// --- 1件ずつ追加・編集 ---

function openDeadlineForm(item) {
  editingDeadline = item || {};
  const v = item ? item.value : { status: 'todo', assignee: me };
  document.getElementById('deadline-form-title').textContent = item ? '期限を直す' : '期限を追加';
  document.getElementById('deadline-form-kind').value = v.kind || '';
  document.getElementById('deadline-form-client').value = v.client || '';
  document.getElementById('deadline-form-due').value = v.due || '';
  const assignee = document.getElementById('deadline-form-assignee');
  assignee.replaceChildren(...assigneeOptions(v.assignee));
  assignee.value = v.assignee || me;
  document.getElementById('deadline-form-status').value = v.status || 'todo';
  document.getElementById('deadline-form-memo').value = v.memo || '';
  document.getElementById('deadline-form-meta').textContent = item ? `最終更新 ${formatDate(item.saved)}・${memberName(item.staff)}` : '';
  deadlineBulk.hidden = true;
  deadlineForm.hidden = false;
  deadlineForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveDeadlineForm() {
  const value = {
    kind: document.getElementById('deadline-form-kind').value.trim(),
    client: document.getElementById('deadline-form-client').value,
    due: document.getElementById('deadline-form-due').value,
    assignee: document.getElementById('deadline-form-assignee').value,
    status: document.getElementById('deadline-form-status').value,
    memo: document.getElementById('deadline-form-memo').value.trim(),
  };
  if (!value.kind || !value.due) throw new Error('種類と期限日を入力してください');
  await saveDeadlineValue(editingDeadline && editingDeadline.id, value);
  deadlineForm.hidden = true;
}

function checkKeyForSave() {
  if (!registeredKey || !registeredKey.spki) throw new Error('暗号化の鍵が登録されていません');
  if (!loadedKey || loadedKey.fingerprint !== registeredKey.fingerprint) {
    throw new Error('開いている鍵が登録済みの鍵と違うため、保存できません');
  }
}

async function saveDeadlineValue(id, value) {
  checkKeyForSave();
  const encrypted = await FormCrypto.encrypt(registeredKey.spki, registeredKey.fingerprint, value);
  await api('store/save', { store: 'deadline', ...(id ? { id } : {}), encrypted });
  await loadDeadlines();
  showMessage(`「${value.kind}」を保存しました`, 'ok');
}

// --- 期限日の計算 ---

function isoDate(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function lastDay(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// 土日なら翌月曜日にする
function nextWeekday(iso) {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  if (day === 6) return addDays(iso, 2);
  if (day === 0) return addDays(iso, 1);
  return iso;
}

// 台帳の値（「3月」「3」「３」など）から月を読む
function parseMonth(value) {
  const text = String(value == null ? '' : value).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = text.match(/(1[0-2]|0?[1-9])/);
  return m ? Number(m[1]) : null;
}

// 種類ごとに、1社分の期限 [{ kind, due }] と、台帳から読んだ情報を返す
function bulkItems(type, year, answers, options) {
  const s = deadlineSettings;
  if (type === 'corp') {
    const month = answers && s.monthField ? parseMonth(answers[s.monthField]) : null;
    if (!month) return { info: '決算月が分かりません', items: [] };
    const dueMonth = ((month + 1) % 12) + 1;
    return {
      info: `${month}月決算`,
      items: [{ kind: `法人税・消費税の確定申告（${month}月決算）`, due: nextWeekday(isoDate(year, dueMonth, lastDay(year, dueMonth))) }],
    };
  }
  if (type === 'withholding') {
    let method = options.method;
    if (method === 'auto') {
      const value = answers && s.withholdingField ? String(answers[s.withholdingField] || '') : '';
      method = value.includes('特例') ? 'special' : 'monthly';
    }
    if (method === 'special') {
      return {
        info: '納期の特例',
        items: [
          { kind: '源泉所得税の納付（納期の特例・7〜12月分）', due: nextWeekday(isoDate(year, 1, 20)) },
          { kind: '源泉所得税の納付（納期の特例・1〜6月分）', due: nextWeekday(isoDate(year, 7, 10)) },
        ],
      };
    }
    return {
      info: '毎月',
      items: Array.from({ length: 12 }, (_, i) => ({
        kind: `源泉所得税の納付（${i === 0 ? 12 : i}月分）`, due: nextWeekday(isoDate(year, i + 1, 10)),
      })),
    };
  }
  if (type === 'yearend') {
    const due = nextWeekday(isoDate(year, 1, 31));
    return { info: '', items: ['法定調書合計表の提出', '償却資産の申告', '給与支払報告書の提出'].map((kind) => ({ kind, due })) };
  }
  const items = [{ kind: '所得税の確定申告', due: nextWeekday(isoDate(year, 3, 15)) }];
  if (options.consumption) items.push({ kind: '個人の消費税の確定申告', due: nextWeekday(isoDate(year, 3, 31)) });
  return { info: '', items };
}

// 顧客台帳のいちばん新しい内容（顧問先の番号 → 入力内容）。設定で選んだ台帳から読む
async function ledgerAnswersFor(formId) {
  if (!formId) return {};
  const { records } = await api('register/records', { formId });
  const result = {};
  for (const r of records) {
    if (r.encrypted.keyId !== loadedKey.fingerprint) continue;
    try {
      result[r.code] = await FormCrypto.decrypt(loadedKey.privateKey, r.encrypted);
    } catch {
      // 壊れたものは使わない
    }
  }
  return result;
}

// --- まとめて作る ---

async function openBulk() {
  if (!loadedKey) throw new Error('上の欄で鍵を開いてください');
  deadlineForm.hidden = true;
  const year = document.getElementById('deadline-bulk-year');
  if (!year.value) year.value = String(new Date().getFullYear());
  const assignee = document.getElementById('deadline-bulk-assignee');
  assignee.replaceChildren(...assigneeOptions(me));
  assignee.value = me;
  deadlineBulk.ledger = await ledgerAnswersFor(deadlineSettings.registerId);
  deadlineBulk.hidden = false;
  await renderBulk();
  deadlineBulk.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function renderBulk() {
  const type = document.getElementById('deadline-bulk-type').value;
  const year = Number(document.getElementById('deadline-bulk-year').value);
  const options = {
    method: document.getElementById('deadline-bulk-method').value,
    consumption: document.getElementById('deadline-bulk-consumption').checked,
  };
  document.getElementById('deadline-bulk-method-line').hidden = type !== 'withholding';
  document.getElementById('deadline-bulk-consumption-line').hidden = type !== 'personal';
  if (!(year >= 2020 && year <= 2100)) throw new Error('年を正しく入れてください');
  const existing = new Set((deadlines || []).map((d) => `${d.value.kind}|${d.value.client}|${d.value.due}`));
  const ledger = deadlineBulk.ledger || {};
  bulkCandidates = deadlineClients.map((code) => {
    const { info, items } = bulkItems(type, year, ledger[code], options);
    return {
      code,
      info: ledger[code] ? info : `台帳なし${info ? `・${info}` : ''}`,
      items: items.map((it) => ({ ...it, exists: existing.has(`${it.kind}|${code}|${it.due}`) })),
    };
  });
  document.getElementById('deadline-bulk-list').replaceChildren(...bulkCandidates.map((c) => {
    const tr = document.createElement('tr');
    const box = document.createElement('input');
    box.type = 'checkbox';
    const fresh = c.items.filter((it) => !it.exists);
    box.disabled = fresh.length === 0;
    // 個人の確定申告は、法人の顧問先が多いので、初めはチェックしない
    box.checked = fresh.length > 0 && type !== 'personal';
    box.setAttribute('aria-label', `${c.code} の期限を作る`);
    c.box = box;
    const items = c.items.length
      ? c.items.map((it) => `${it.due.slice(5).replace('-', '/')} ${it.kind}${it.exists ? '（作成済み）' : ''}`).join('、')
      : '—';
    tr.append(cell(box), cell(c.code), cell(c.info || '—'), cell(items));
    return tr;
  }));
}

async function runBulk() {
  checkKeyForSave();
  const assignee = document.getElementById('deadline-bulk-assignee').value;
  const values = [];
  for (const c of bulkCandidates) {
    if (!c.box || !c.box.checked) continue;
    for (const it of c.items) {
      if (!it.exists) values.push({ kind: it.kind, client: c.code, due: it.due, assignee, status: 'todo', memo: '' });
    }
  }
  if (!values.length) throw new Error('作る期限がありません（顧問先にチェックを入れてください）');
  for (let i = 0; i < values.length; i += 100) {
    const items = [];
    for (const value of values.slice(i, i + 100)) {
      items.push({ encrypted: await FormCrypto.encrypt(registeredKey.spki, registeredKey.fingerprint, value) });
    }
    showMessage(`期限を作っています（${Math.min(i + 100, values.length)}/${values.length}）…`, 'ok');
    await api('store/save-many', { store: 'deadline', items });
  }
  deadlineBulk.hidden = true;
  await loadDeadlines();
  showMessage(`${values.length}件の期限を作りました`, 'ok');
}

// --- 設定（どの台帳のどの項目を使うか。秘密ではないので暗号化しない） ---

async function loadDeadlineSettings() {
  const { settings } = await api('settings/get');
  deadlineSettings = settings.deadline || {};
  const registers = allForms.filter((f) => f.kind === 'register');
  const select = document.getElementById('deadline-set-register');
  select.replaceChildren(new Option('選んでください', ''), ...registers.map((f) => new Option(f.title, f.id)));
  select.value = registers.some((f) => f.id === deadlineSettings.registerId) ? deadlineSettings.registerId : '';
  fillDeadlineFieldSelects();
}

function fillDeadlineFieldSelects() {
  const form = allForms.find((f) => f.id === document.getElementById('deadline-set-register').value);
  const fields = form ? [...FormRender.iterFields(form.fields)].filter((f) => FormRender.isInput(f) && f.type !== 'table' && f.type !== 'file') : [];
  for (const [id, key] of [['deadline-set-month', 'monthField'], ['deadline-set-withholding', 'withholdingField']]) {
    const select = document.getElementById(id);
    select.replaceChildren(new Option('なし', ''), ...fields.map((f) => new Option(f.label, f.id)));
    select.value = fields.some((f) => f.id === deadlineSettings[key]) ? deadlineSettings[key] : '';
  }
}

async function saveDeadlineSettings() {
  const value = {
    registerId: document.getElementById('deadline-set-register').value,
    monthField: document.getElementById('deadline-set-month').value,
    withholdingField: document.getElementById('deadline-set-withholding').value,
  };
  const { settings } = await api('settings/save', { key: 'deadline', value });
  deadlineSettings = settings.deadline;
  showMessage('設定を保存しました', 'ok');
}

// 顧問先の画面（register.js）に、その顧問先の期限を並べる
async function clientDeadlines(code) {
  if (!deadlines) {
    await loadMembers();
    await loadDeadlines();
  }
  return (deadlines || []).filter((d) => d.value.client === code && d.value.status !== 'done')
    .sort((a, b) => (a.value.due || '').localeCompare(b.value.due || ''));
}
