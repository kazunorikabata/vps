// 事務所内ページ：顧問先の一覧（追加・削除・URLの再発行・QRコード・台帳へ）
// common.js の共通の部品（run・api・button・askConfirm・showMessage）を使う。一覧の読み込み（loadClients）は app.js が呼ぶ
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
    const { client } = await api('clients/add', { code });
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

async function loadClients() {
  const { clients } = await api('clients/list');
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
    button('台帳・応対履歴', () => { location.hash = `#register/${encodeURIComponent(client.code)}`; }, 'button-outline'),
    button('再発行', () => askConfirm(td,
      `${client.code} のURLを新しくしますか？ 今のURLとQRコードは使えなくなります。`, '再発行する', async () => {
        const { client: renewed } = await api('clients/reissue', { code: client.code });
        showMessage(`${client.code} のURLを再発行しました。新しいURLを顧問先にお知らせください`, 'ok');
        await loadClients();
        await showDetail(renewed, `${client.code} の新しいアップロード用URL`);
      }, () => showOps(td, client))),
    button('削除', () => askConfirm(td,
      `${client.code} を削除しますか？ URLは使えなくなります（ドライブのフォルダと資料は残ります）。`, '削除する', async () => {
        await api('clients/remove', { code: client.code });
        showMessage(`${client.code} を削除しました`, 'ok');
        if (detailTitle.textContent.startsWith(`${client.code} `)) detail.hidden = true;
        await loadClients();
      }, () => showOps(td, client)), 'button-danger'),
  );
}

async function showDetail(client, title) {
  detailTitle.textContent = title;
  detailUrl.value = client.uploadUrl;
  const { dataUrl } = await api('clients/qr', { code: client.code });
  detailQr.src = dataUrl;
  detailQrSave.href = dataUrl;
  detailQrSave.download = `${client.code}_QRコード.png`;
  detail.hidden = false;
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
