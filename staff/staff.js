// 事務所内ページ：顧問先の追加・削除・URLの再発行・QRコード
const staff = document.querySelector('.staff');
const message = document.getElementById('message');
const addForm = document.getElementById('add-form');
const codeInput = document.getElementById('code');
const tbody = document.getElementById('clients');
const empty = document.getElementById('empty');
const detail = document.getElementById('detail');
const detailTitle = document.getElementById('detail-title');
const detailUrl = document.getElementById('detail-url');
const detailQr = document.getElementById('detail-qr');
const detailQrSave = document.getElementById('detail-qr-save');

addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();
  run(async () => {
    const { client } = await api('add', { code });
    codeInput.value = '';
    showMessage(`${code} を追加しました。ドライブに「${code}」フォルダを作りました`, 'ok');
    await loadClients();
    await showDetail(client, `${code} のアップロード用URL`);
  });
});

document.getElementById('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(detailUrl.value);
    showMessage('URLをコピーしました', 'ok');
  } catch {
    detailUrl.select();
    showMessage('コピーできませんでした。URLを選択したので、手動でコピーしてください', 'error');
  }
});

document.getElementById('detail-close').addEventListener('click', () => {
  detail.hidden = true;
});

run(loadClients);

async function loadClients() {
  const { clients } = await api('list');
  tbody.innerHTML = '';
  for (const client of clients) tbody.append(createRow(client));
  empty.hidden = clients.length > 0;
}

function createRow(client) {
  const tr = document.createElement('tr');
  const code = document.createElement('td');
  code.textContent = client.code;
  const created = document.createElement('td');
  created.textContent = client.created || '—';
  const folder = document.createElement('td');
  const link = document.createElement('a');
  link.href = client.folderUrl;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = '開く';
  folder.append(link);
  const ops = document.createElement('td');
  ops.className = 'ops';
  tr.append(code, created, folder, ops);
  showOps(ops, client);
  return tr;
}

function showOps(td, client) {
  td.replaceChildren(
    button('URL・QR', () => run(() => showDetail(client, `${client.code} のアップロード用URL`))),
    button('再発行', () => askConfirm(td, client,
      `${client.code} のURLを新しくしますか？ 今のURLとQRコードは使えなくなります。`, '再発行する', async () => {
        const { client: renewed } = await api('reissue', { code: client.code });
        showMessage(`${client.code} のURLを再発行しました。新しいURLを顧問先にお知らせください`, 'ok');
        await loadClients();
        await showDetail(renewed, `${client.code} の新しいアップロード用URL`);
      })),
    button('削除', () => askConfirm(td, client,
      `${client.code} を削除しますか？ URLは使えなくなります（ドライブのフォルダと資料は残ります）。`, '削除する', async () => {
        await api('remove', { code: client.code });
        showMessage(`${client.code} を削除しました`, 'ok');
        if (detailTitle.textContent.startsWith(`${client.code} `)) detail.hidden = true;
        await loadClients();
      }), 'button-danger'),
  );
}

// 確認のダイアログは使えないので、操作欄の中で確認する
function askConfirm(td, client, text, label, action) {
  const note = document.createElement('p');
  note.className = 'confirm-text';
  note.textContent = text;
  td.replaceChildren(
    note,
    button(label, () => run(action), 'button-danger'),
    button('やめる', () => showOps(td, client), 'button-outline'),
  );
}

async function showDetail(client, title) {
  detailTitle.textContent = title;
  detailUrl.value = client.uploadUrl;
  const { dataUrl } = await api('qr', { code: client.code });
  detailQr.src = dataUrl;
  detailQrSave.href = dataUrl;
  detailQrSave.download = `${client.code}_QRコード.png`;
  detail.hidden = false;
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function button(label, onClick, extraClass = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `button button-small ${extraClass}`.trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
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
  for (const b of staff.querySelectorAll('button')) b.disabled = busy;
}

function showMessage(text, kind) {
  message.textContent = text;
  message.className = `staff-message is-${kind}`;
  message.hidden = false;
}

async function api(path, body = {}) {
  let res;
  try {
    res = await fetch(`/api/staff/clients/${path}`, {
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
