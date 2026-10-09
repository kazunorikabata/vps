// 事務所内ページ：入力ページの作成・顧問先へのURLの発行・届いた入力内容の確認と書き出し
// 暗号化した入力内容は、このページに読み込んだ秘密鍵で、このブラウザの中だけで復号する
// 入力ページの作成画面は form-editor.js、部品の表示は /form/render.js（顧問先の画面と共通）
// 種類（formKind）ごとに同じ画面を使い、app.js が setKind で切り替える：
//   client（顧問先用：URL を発行して顧問先が入力）・activity（応対履歴：事務所用で顧問先を選ぶもの）・
//   office（事務所用：報告書など）・register（顧客台帳。台帳の画面は register.js）
let formKind = 'client';
let allForms = [];          // サーバーから受け取ったすべての入力ページ
let forms = [];             // 今の種類の入力ページ
let registeredKey = null;   // サーバーに登録されている公開鍵 { fingerprint, set, spki }
let loadedKey = null;       // このページに読み込んだ秘密鍵 { privateKey, fingerprint }
let pendingKey = null;      // 作ったばかりで、まだ登録していない鍵
let current = null;         // 依頼URL・入力内容を表示している入力ページ
let submissions = [];

const KIND_TITLES = { client: '顧問先用の入力ページ', activity: '応対履歴', office: '事務所用の入力ページ', register: '顧客台帳' };

// 入力ページがどの種類か（応対履歴は、事務所用で「顧問先を選ぶ」もの）
function kindOf(form) {
  const kind = form.kind || 'client';
  return kind === 'office' && form.clientSelect ? 'activity' : kind;
}

// 種類を切り替える（arg は顧客台帳で開く顧問先の番号など）
function setKind(kind, arg) {
  formKind = kind;
  for (const id of ['editor', 'requests', 'submissions', 'register', 'activities']) document.getElementById(id).hidden = true;
  showKind();
  renderForms();
  if (kind === 'register') startRegister(arg);
  if (kind === 'activity') startActivities();
}

function showKind() {
  const staffOnly = formKind === 'office' || formKind === 'activity';
  document.getElementById('page-title').textContent = KIND_TITLES[formKind];
  document.getElementById('kind-note').textContent = {
    office: '日報・報告書など、顧問先に関係しない記録を職員が入力するためのページです。「入力する」から入力します（スマホからも使えます）。入力した内容はドライブの「事務所の記録」フォルダの、入力ページごとのスプレッドシートに1件1行で保存され、入力した職員のIDも残ります。',
    activity: '電話・訪問・相談などの応対を記録する入力ページです。入力のときに顧問先を選び、顧客台帳と上の一覧に、顧問先ごとに新しい順で並びます。「入力する」から入力します（スマホからも使えます）。',
    client: '顧問先に入力してもらうページです。「依頼URL」で顧問先ごとのURLを発行します。届いた内容はドライブの「入力内容」フォルダの、入力ページごとのスプレッドシートに1件1行で保存されます（添付ファイルは顧問先のフォルダに入ります）。',
    register: '顧問先ごとの情報（台帳）です。項目は「新しい台帳を作る」・「編集」で自由に作れます。「台帳を開く」で顧問先の一覧を見て、開いて直せます。直すたびにドライブの「顧客台帳」フォルダのスプレッドシートに1行足され（暗号化したまま）、前の内容は履歴として残ります。見る・直すには、上の欄で鍵を開いてください。',
  }[formKind];
  document.getElementById('new-form').textContent = formKind === 'register' ? '新しい台帳を作る' : '新しい入力ページを作る';
  document.getElementById('forms-count-head').textContent = formKind === 'client' ? '依頼' : '';
  document.getElementById('sub-who-head').textContent = staffOnly ? '入力した職員' : '顧問先';
  // 事務所用・応対履歴は「顧問先ごとに最新の1件だけ」は使わない
  document.getElementById('sub-latest').checked = !staffOnly;
  document.getElementById('sub-latest-line').hidden = staffOnly;
}

// 届いた内容を誰が送ったか（顧問先用は顧問先の番号、事務所用は入力した職員、応対履歴は「顧問先・職員」）
function senderOf(item) {
  if (formKind === 'activity') return `${item.code}・${item.staff || '-'}`;
  if (formKind === 'office') return item.staff || '-';
  return item.code;
}

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
  // 顧客台帳を開いていれば、鍵が開いたところで中身を読み込む（register.js）
  if (loadedKey && formKind === 'register') registerKeyChanged();
}

// --- 入力ページの一覧 ---

async function loadForms() {
  const data = await api('forms/list');
  allForms = data.forms;
  registeredKey = data.key;
  showKey();
  renderForms();
}

function renderForms() {
  forms = allForms.filter((f) => kindOf(f) === formKind);
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
  tr.append(cell(form.title), cell(enc), cell(String([...FormRender.iterFields(form.fields)].filter(FormRender.isInput).length)),
    cell(formKind === 'client' ? String(form.requests) : ''), cell(form.updated), ops);
  showFormOps(ops, form);
  return tr;
}

function showFormOps(td, form) {
  const first = {
    office: () => [button('入力する', () => openEntry(form.id)), button('届いた内容', () => run(() => openSubmissions(form)))],
    activity: () => [button('入力する', () => openEntry(form.id)), button('届いた内容', () => run(() => openSubmissions(form)))],
    client: () => [button('依頼URL', () => run(() => openRequests(form))),
      button('届いた内容', () => run(() => openSubmissions(form)))],
    register: () => [button('台帳を開く', () => run(() => openRegister(form)))],
  }[formKind]();
  td.replaceChildren(
    ...first,
    button('編集', () => openEditor(form)),
    button('削除', () => askConfirm(td,
      `「${form.title}」を削除しますか？ 発行したURLは使えなくなります（届いた入力内容はドライブに残ります）。`,
      '削除する', async () => {
        await api('forms/remove', { id: form.id });
        showMessage(`「${form.title}」を削除しました`, 'ok');
        for (const id of ['editor', 'requests', 'submissions', 'register', 'activities']) document.getElementById(id).hidden = true;
        await loadForms();
      }, () => showFormOps(td, form)), 'button-danger'),
  );
}

// 事務所用・応対履歴の入力画面は別のタブで開く（このページの鍵を開いたままにしておくため）
function openEntry(formId, code) {
  const query = code ? `?code=${encodeURIComponent(code)}` : '';
  window.open(`/staff/entry.html${query}#${formId}`, '_blank', 'noopener');
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
  await loadSubmissions();
  subCard.hidden = false;
  subCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadSubmissions() {
  const data = await api('submissions/list', { formId: current.id });
  submissions = data.submissions;
  const link = document.getElementById('sub-sheet-link');
  if (data.sheetUrl) link.href = data.sheetUrl;
  document.getElementById('sub-sheet').hidden = !data.sheetUrl;
  // 以前の形（1件ずつの JSON ファイル）で届いている分は、スプレッドシートに移せる
  document.getElementById('sub-migrate-text').textContent =
    `以前の形（1件ずつの JSON ファイル）で届いている入力内容が${data.legacy}件あります。スプレッドシートに移すと、JSON ファイルはドライブのゴミ箱に移ります。暗号化したものは暗号化されたまま移します。`;
  document.getElementById('sub-migrate').hidden = !data.legacy;
  renderSubmissions();
}

document.getElementById('sub-migrate-run').addEventListener('click', () => run(async () => {
  let moved = 0;
  for (;;) {
    const result = await api('submissions/migrate', { formId: current.id });
    moved += result.moved;
    showMessage(`スプレッドシートに移しています（${moved}件）…`, 'ok');
    if (!result.remaining || !result.moved) break;
  }
  await loadSubmissions();
  showMessage(`${moved}件をスプレッドシートに移しました`, 'ok');
}));

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
      button('削除', () => askConfirm(ops, `${senderOf(sub)}（${formatDate(sub.submitted)}）の入力内容を削除しますか？ 添付ファイルもドライブのゴミ箱に移ります（30日後に完全に削除）。`,
        '削除する', async () => {
          await api('submissions/remove', { formId: current.id, id: sub.id });
          submissions = submissions.filter((s) => s !== sub);
          subView.hidden = true;
          subView.replaceChildren();
          renderSubmissions();
          showMessage('入力内容を削除しました', 'ok');
        }, show), 'button-danger'),
    );
    show();
    tr.append(cell(senderOf(sub)), cell(formatDate(sub.submitted)), ops);
    return tr;
  }));
  document.getElementById('sub-empty').hidden = list.length > 0;
}

// 入力内容のファイルを読み込み、暗号化されていれば復号する
async function openRecord(id) {
  const { record } = await api('submissions/get', { formId: current.id, id });
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
  h.textContent = `${senderOf(record)}　${formatDate(record.submitted)}`;
  // 顧問先の画面と同じ並びで表示する（送信したときの項目で。項目名の位置は今の入力ページの設定）
  const grid = document.createElement('div');
  FormRender.buildView(grid, record.fields, answers, current, {
    fileButton: (file) => button('取り出す', () => run(() => saveAttachment(file)), 'button-outline'),
  });
  const close = button('閉じる', () => { subView.hidden = true; subView.replaceChildren(); }, 'button-outline');
  close.style.marginTop = '12px';
  subView.replaceChildren(h, grid, close);
  subView.hidden = false;
  subView.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 添付ファイルを受け取り、このブラウザの中で復号して保存する（鍵は入力内容の中にある）
async function saveAttachment(file) {
  let res;
  try {
    res = await fetch('/api/staff/submissions/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: file.fileId }),
    });
  } catch {
    throw new Error('通信できませんでした。時間をおいて再度お試しください');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `ファイルを取り出せませんでした（${res.status}）`);
  }
  let plain;
  try {
    plain = await FormCrypto.decryptFile(await res.arrayBuffer(), file.key);
  } catch {
    throw new Error('ファイルを復号できませんでした。ファイルが壊れているおそれがあります');
  }
  const url = URL.createObjectURL(new Blob([plain], { type: file.type || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showMessage(`「${file.name}」を取り出しました。使い終わったら、PCに残ったファイルを削除してください`, 'ok');
}

// 加工しやすいように、1件を1行にして書き出す。表は「扶養家族1_氏名」「月別_1月_金額」のように列を分け、
// 合計を出す列は「月別_合計_金額」も付ける。枠の中の項目も並べる
async function exportCsv() {
  const list = visibleSubmissions();
  if (!list.length) throw new Error('書き出す入力内容がありません');
  const records = [];
  for (const [i, sub] of list.entries()) {
    showMessage(`読み込んでいます（${i + 1}/${list.length}）…`, 'ok');
    records.push(await openRecord(sub.id));
  }
  const fields = [...FormRender.iterFields(current.fields)].filter(FormRender.isInput);
  const rowNames = {};
  for (const field of fields.filter((f) => f.type === 'table')) {
    if (field.rowLabels) {
      rowNames[field.id] = field.rowLabels.map((r) => `_${r}_`);
    } else {
      const count = Math.max(1, ...records.map((r) => (r.answers[field.id] || []).length));
      rowNames[field.id] = Array.from({ length: count }, (_, n) => `${n + 1}_`);
    }
  }
  const header = [formKind === 'office' ? '入力した職員' : '顧問先', '送信日時'];
  for (const field of fields) {
    if (field.type !== 'table') {
      header.push(field.label);
      continue;
    }
    for (const name of rowNames[field.id]) {
      for (const col of field.columns) header.push(`${field.label}${name}${col.label}`);
    }
    for (const col of field.columns.filter((c) => c.sum)) header.push(`${field.label}_合計_${col.label}`);
  }
  const lines = [header];
  for (const { record, answers } of records) {
    const line = [senderOf(record), formatDate(record.submitted)];
    for (const field of fields) {
      if (field.type !== 'table') {
        line.push(FormRender.displayValue(field, answers[field.id]));
        continue;
      }
      const rows = answers[field.id] || [];
      rowNames[field.id].forEach((_, n) => {
        for (const col of field.columns) line.push((rows[n] || {})[col.id] || '');
      });
      const sums = FormRender.sums(field, rows);
      for (const col of field.columns.filter((c) => c.sum)) line.push(String(sums[col.id]));
    }
    lines.push(line);
  }
  const csv = '\ufeff' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
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
