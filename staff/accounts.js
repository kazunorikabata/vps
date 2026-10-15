// 事務所内ページ：職員のアカウント（YubiKey でのログイン）と、ログイン中の職員の表示・ログアウト
// アカウントの追加・削除・管理者の切り替え・キーの削除・登録用の URL は、管理者だけ（サーバーでも確かめる）。
// 管理者でない職員は、自分の予備のキーの登録用 URL だけ出せる。
// common.js の共通の部品を使う
let currentUser = { user: '', name: '', admin: true, loggedIn: false };   // 今の職員（/me）

// 最初に一度（app.js）：ログイン中の職員を表示し、管理者でなければ管理者向けのボタンを隠す
async function loadMe() {
  currentUser = await api('me');
  const who = document.getElementById('whoami');
  who.textContent = currentUser.name || currentUser.user;
  who.hidden = !currentUser.user;
  document.getElementById('logout').hidden = !currentUser.loggedIn;
  applyAdmin();
}

function applyAdmin() {
  for (const e of document.querySelectorAll('.admin-only')) e.hidden = !currentUser.admin;
  // 鍵の作成・開け方の登録は管理者だけ
  document.getElementById('unlock-add-show').hidden = !currentUser.admin;
  if (!currentUser.admin) {
    document.getElementById('key-create-show').hidden = true;
    document.getElementById('key-create-locked').textContent = '鍵の作成・作り直しは、管理者だけができます。';
    document.getElementById('key-create-locked').hidden = false;
  }
}

document.getElementById('logout').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } finally {
    location.href = '/login/';
  }
});

// --- アカウントの一覧 ---

async function loadAccounts() {
  const { accounts, me, admin } = await api('accounts/list');
  document.getElementById('accounts-list').replaceChildren(...accounts.map((a) => accountRow(a, me, admin)));
  document.getElementById('accounts-empty').hidden = accounts.length > 0;
  document.getElementById('accounts-add').hidden = !admin || !accounts.length;
  document.getElementById('accounts-self-key').hidden = !accounts.some((a) => a.id === me);
}

function accountRow(a, me, admin) {
  const tr = document.createElement('tr');
  const keys = document.createElement('td');
  if (!a.keys.length) keys.textContent = 'まだありません';
  for (const k of a.keys) {
    const line = document.createElement('div');
    line.className = 'account-key';
    line.textContent = `${k.label || 'YubiKey'}（${k.created}${k.lastUsed ? `・最後に使った日 ${k.lastUsed}` : ''}）`;
    if (admin) {
      line.append(' ', button('削除', () => askConfirm(keys, `${a.name || a.id} の「${k.label || 'YubiKey'}」を削除しますか？ このキーではログインできなくなります。`,
        '削除する', async () => {
          await api('accounts/key-remove', { id: a.id, keyId: k.id });
          showMessage('キーを削除しました', 'ok');
          await loadAccounts();
        }, loadAccounts), 'button-danger'));
    }
    keys.append(line);
  }
  const ops = document.createElement('td');
  ops.className = 'ops';
  const show = () => {
    ops.replaceChildren();
    if (!admin) return;
    ops.append(
      button('登録用のURL', () => run(() => showRegistrationUrl(a))),
      button(a.admin ? '管理者から外す' : '管理者にする', () => run(async () => {
        await api('accounts/save', { id: a.id, name: a.name, admin: !a.admin });
        showMessage(`${a.name || a.id} を${a.admin ? '管理者から外しました' : '管理者にしました'}`, 'ok');
        await loadAccounts();
      }), 'button-outline'),
    );
    if (a.id !== me) {
      ops.append(button('削除', () => askConfirm(ops, `${a.name || a.id} のアカウントを削除しますか？ この職員はログインできなくなります。`,
        '削除する', async () => {
          await api('accounts/remove', { id: a.id });
          showMessage(`${a.name || a.id} のアカウントを削除しました`, 'ok');
          await loadAccounts();
        }, show), 'button-danger'));
    }
  };
  show();
  tr.append(cell(a.id + (a.id === me ? '（自分）' : '')), cell(a.name || '—'), cell(a.admin ? '管理者' : ''), keys, ops);
  return tr;
}

async function showRegistrationUrl(a) {
  const { url } = await api('accounts/issue', { id: a.id });
  document.getElementById('accounts-url-title').textContent = `${a.name || a.id} の YubiKey の登録用のURL（24時間・1回だけ）`;
  document.getElementById('accounts-url-input').value = url;
  const box = document.getElementById('accounts-url');
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

document.getElementById('accounts-url-copy').addEventListener('click', async () => {
  const input = document.getElementById('accounts-url-input');
  try {
    await navigator.clipboard.writeText(input.value);
    showMessage('URLをコピーしました', 'ok');
  } catch {
    input.select();
    showMessage('コピーできませんでした。URLを選択したので、手動でコピーしてください', 'error');
  }
});

document.getElementById('accounts-add').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = document.getElementById('account-id').value.trim();
  const name = document.getElementById('account-name').value.trim();
  const admin = document.getElementById('account-admin').checked;
  run(async () => {
    const { account } = await api('accounts/save', { id, name, admin });
    event.target.reset();
    await loadAccounts();
    await showRegistrationUrl(account);
    showMessage(`${name || id} のアカウントを作りました。登録用のURLを本人に渡してください`, 'ok');
  });
});

// 自分の予備のキー：登録用のページを別のタブで開く（このページの鍵は開いたまま）
document.getElementById('accounts-self-key').addEventListener('click', () => run(async () => {
  const { url } = await api('accounts/issue', { id: currentUser.user });
  window.open(url, '_blank', 'noopener');
}));
