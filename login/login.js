// 事務所内ページのログイン（職員ごとの YubiKey。WebAuthn）
// ・ログイン：キーに触れて PIN を入れる。サーバーが確かめて、ログイン中の印（クッキー）を渡す
// ・#register=… のとき：管理者が出した登録用の URL。自分の YubiKey を登録する（登録するとそのままログイン）
// Safari はキーの操作を「ボタンを押した直後」にしか許さないので、確認用の値はページを開いたときに受け取っておく
const NETWORK_ERROR = '通信できませんでした。時間をおいて再度お試しください';
const registerToken = (location.hash.match(/^#register=([A-Za-z0-9_-]+)$/) || [])[1] || '';
let prepared = null;   // { challengeId, options, at }（サーバーから受け取った確認用の値）

start();

async function start() {
  if (!window.PublicKeyCredential) {
    showMessage('このブラウザでは使えません。Chrome・Edge・Safari の新しいものでお試しください', 'error');
    return;
  }
  if (registerToken) {
    document.getElementById('login-title').textContent = 'YubiKey の登録';
    try {
      prepared = await prepare('register/options', { token: registerToken });
    } catch (err) {
      showMessage(err.message, 'error');
      return;
    }
    document.getElementById('register-who').textContent =
      `${prepared.name || prepared.account}（ID：${prepared.account}）のキーを登録します。`;
    document.getElementById('register-box').hidden = false;
    return;
  }
  document.getElementById('login-box').hidden = false;
  prepare('login/options', {}).then((p) => { prepared = p; }).catch((err) => showMessage(err.message, 'error'));
}

async function prepare(path, body) {
  return { ...(await api(path, body)), at: Date.now() };
}

// 確認用の値は5分で使えなくなるので、古ければ受け取り直して、もう一度押してもらう
function freshEnough() {
  if (prepared && Date.now() - prepared.at < 4 * 60 * 1000) return true;
  const path = registerToken ? 'register/options' : 'login/options';
  prepare(path, registerToken ? { token: registerToken } : {}).then((p) => {
    prepared = p;
    showMessage('準備ができました。もう一度ボタンを押してください', 'ok');
  }).catch((err) => showMessage(err.message, 'error'));
  return false;
}

document.getElementById('login-button').addEventListener('click', async (event) => {
  if (!freshEnough()) return;
  const button = event.currentTarget;
  const { challengeId, options } = prepared;
  prepared = null;
  button.disabled = true;
  try {
    const credential = await keyCall(() => navigator.credentials.get({ publicKey: requestOptions(options) }));
    await api('login/verify', { challengeId, credential: credentialJson(credential) });
    showMessage('ログインしました', 'ok');
    location.href = nextPage();
  } catch (err) {
    showMessage(err.message, 'error');
    prepared = await prepare('login/options', {}).catch(() => null);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('register-button').addEventListener('click', async (event) => {
  if (!freshEnough()) return;
  const button = event.currentTarget;
  const { challengeId, options } = prepared;
  prepared = null;
  button.disabled = true;
  try {
    const credential = await keyCall(() => navigator.credentials.create({ publicKey: creationOptions(options) }));
    await api('register/verify', {
      token: registerToken, challengeId, credential: credentialJson(credential),
      label: document.getElementById('register-label').value.trim(),
    });
    history.replaceState(null, '', '/login/');   // 登録用の URL は使い終わったので、画面から消す
    document.getElementById('register-box').hidden = true;
    document.getElementById('done-text').textContent = 'YubiKey を登録しました。これからは、このキーでログインできます。';
    document.getElementById('done-box').hidden = false;
    showMessage('登録しました', 'ok');
  } catch (err) {
    showMessage(err.message, 'error');
    prepared = await prepare('register/options', { token: registerToken }).catch(() => null);
  } finally {
    button.disabled = false;
  }
});

// ログインのあとに開くページ（事務所内ページの中だけ）
function nextPage() {
  const next = new URLSearchParams(location.search).get('next') || '';
  return /^\/staff\/[^\s]*$/.test(next) && !next.startsWith('//') ? next : '/staff/';
}

async function keyCall(call) {
  try {
    return await call();
  } catch (err) {
    if (err && err.name === 'NotAllowedError') throw new Error('キーの操作が取り消されたか、時間切れになりました。もう一度お試しください');
    if (err && err.name === 'InvalidStateError') throw new Error('このキーはすでに登録されています');
    throw new Error('キーを使えませんでした。もう一度お試しください');
  }
}

// --- サーバーとのやり取りの形（base64url の文字 ⇔ バイト列） ---

function fromB64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function toB64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function creationOptions(o) {
  return {
    ...o,
    challenge: fromB64url(o.challenge),
    user: { ...o.user, id: fromB64url(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: fromB64url(c.id) })),
  };
}

function requestOptions(o) {
  return {
    ...o,
    challenge: fromB64url(o.challenge),
    allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: fromB64url(c.id) })),
  };
}

function credentialJson(c) {
  const r = c.response;
  const response = { clientDataJSON: toB64url(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = toB64url(r.attestationObject);
    if (r.getTransports) response.transports = r.getTransports();
  } else {
    response.authenticatorData = toB64url(r.authenticatorData);
    response.signature = toB64url(r.signature);
    if (r.userHandle) response.userHandle = toB64url(r.userHandle);
  }
  return { id: c.id, rawId: toB64url(c.rawId), type: c.type, response, clientExtensionResults: {},
    authenticatorAttachment: c.authenticatorAttachment || undefined };
}

function showMessage(text, kind) {
  const message = document.getElementById('login-message');
  message.textContent = text;
  message.className = `login-message is-${kind}`;
  message.hidden = false;
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(`/api/auth/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(NETWORK_ERROR);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラーが起きました（${res.status}）`);
  return data;
}
