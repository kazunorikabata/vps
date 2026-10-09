// 事務所内ページ：鍵の開け方（セキュリティキー・iPhone のパスキー）
// WebAuthn の PRF で、キーの機器から秘密を取り出す（同じキーからは同じ秘密が出る。秘密そのものは機器の外に出ない）。
// その秘密とパスワードで秘密鍵を閉じてサーバーに預け、開くときは同じ手順で取り出す（閉じる・開くは crypto.js）。
// WebAuthn はログインには使わない（サーバーは署名を確かめない）。守りは「機器の秘密」と「パスワード」の両方が要ること。
// forms.js の共通の関数（run・api・showMessage・showKey・button・askConfirm・cell）と、registeredKey・loadedKey を使う
const PRF_INPUT = new TextEncoder().encode('kabaoffice-unlock-prf-v1');
const UNLOCK_KINDS = { 'security-key': 'セキュリティキー', passkey: 'iPhone（パスキー）' };
const unlockOpen = document.getElementById('unlock-open');
const unlockAdd = document.getElementById('unlock-add');
let unlocks = [];

// 一覧の読み込み（loadUnlocks）は、forms.js が入力ページの一覧のあとに呼ぶ

async function loadUnlocks() {
  unlocks = (await api('unlocks/list')).unlocks;
  document.getElementById('unlock-list').replaceChildren(...unlocks.map(unlockRow));
  document.getElementById('unlock-empty').hidden = unlocks.length > 0;
  unlockOpen.hidden = !unlocks.length || !webauthnSupported();
}

function webauthnSupported() {
  return Boolean(window.PublicKeyCredential && navigator.credentials);
}

function unlockRow(u) {
  const tr = document.createElement('tr');
  const ops = document.createElement('td');
  ops.className = 'ops';
  const show = () => ops.replaceChildren(
    button('削除', () => askConfirm(ops, `「${u.label}」を削除しますか？ このキー（iPhone）では鍵を開けなくなります。`,
      '削除する', async () => {
        await api('unlocks/remove', { id: u.id });
        showMessage(`「${u.label}」を削除しました`, 'ok');
        await loadUnlocks();
      }, show), 'button-danger'),
  );
  show();
  tr.append(cell(u.label), cell(UNLOCK_KINDS[u.kind] || u.kind), cell(u.created), ops);
  return tr;
}

// --- 開く ---

unlockOpen.addEventListener('submit', (event) => {
  event.preventDefault();
  const pass = document.getElementById('unlock-pass');
  run(async () => {
    const { id, prf } = await getPrf(unlocks.map((u) => u.id));
    const unlock = unlocks.find((u) => u.id === id);
    if (!unlock) throw new Error('登録されていないキーです');
    loadedKey = await FormCrypto.openWithUnlock(unlock, prf, pass.value);
    pass.value = '';
    showKey();
    showMessage(`「${unlock.label}」で鍵を開きました。このページを閉じるか再読み込みすると、鍵は消えます`, 'ok');
  });
});

// --- 登録する（今の鍵のファイルから秘密鍵を取り出し、キーの秘密とパスワードで閉じ直して預ける） ---

document.getElementById('unlock-add-show').addEventListener('click', () => { unlockAdd.hidden = !unlockAdd.hidden; });

unlockAdd.addEventListener('submit', (event) => {
  event.preventDefault();
  const label = document.getElementById('unlock-label').value.trim();
  const kind = document.getElementById('unlock-kind').value;
  const file = document.getElementById('unlock-file').files[0];
  const filePass = document.getElementById('unlock-file-pass');
  const pass1 = document.getElementById('unlock-pass1');
  const pass2 = document.getElementById('unlock-pass2');
  if (pass1.value.length < 12) return showMessage('パスワードは12文字以上にしてください', 'error');
  if (pass1.value !== pass2.value) return showMessage('確認用のパスワードが一致しません', 'error');
  if (!webauthnSupported()) return showMessage('このブラウザでは登録できません。PC は Chrome か Edge、iPhone は Safari を使ってください', 'error');
  run(async () => {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new Error('鍵のファイルではありません');
    }
    const { pkcs8, fingerprint } = await FormCrypto.exportFromFile(data, filePass.value);
    try {
      if (!registeredKey || fingerprint !== registeredKey.fingerprint) {
        throw new Error('登録済みの鍵とは別の鍵のファイルです。今の鍵のファイルを選んでください');
      }
      showMessage(kind === 'passkey' ? 'Face ID で確認してください' : 'セキュリティキーを差して、触れてください', 'ok');
      const id = await createCredential(kind, label);
      showMessage(kind === 'passkey' ? '確認のため、もう一度 Face ID で確認してください' : '確認のため、もう一度キーに触れてください', 'ok');
      const { prf } = await getPrf([id]);
      const sealed = await FormCrypto.sealForUnlock(pkcs8, prf, pass1.value);
      await api('unlocks/add', { id, label, kind, fingerprint, ...sealed });
    } finally {
      pkcs8.fill(0);
    }
    unlockAdd.reset();
    unlockAdd.hidden = true;
    await loadUnlocks();
    showMessage(`「${label}」を登録しました。これからは、このキー（iPhone）とパスワードで鍵を開けます`, 'ok');
  });
});

// --- WebAuthn ---

async function createCredential(kind, label) {
  const cred = await webauthn(() => navigator.credentials.create({
    publicKey: {
      rp: { name: '蒲田和紀税理士事務所 事務所内' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: kind === 'passkey' ? 'platform' : 'cross-platform',
        residentKey: kind === 'passkey' ? 'required' : 'discouraged',
        userVerification: 'required',
      },
      extensions: { prf: {} },
      timeout: 120000,
    },
  }));
  const prf = cred.getClientExtensionResults().prf;
  if (!prf || prf.enabled === false) {
    throw new Error('このキー（端末）は、鍵を開く機能に対応していません。FIDO2（hmac-secret）対応のセキュリティキーか、iOS 18 以降の iPhone を使ってください');
  }
  return toB64url(cred.rawId);
}

// キーから秘密を取り出す。ids のどれか（登録済みのキー・iPhone）で応じてもらう
async function getPrf(ids) {
  const assertion = await webauthn(() => navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: ids.map((id) => ({ type: 'public-key', id: fromB64url(id) })),
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_INPUT } } },
      timeout: 120000,
    },
  }));
  const results = assertion.getClientExtensionResults().prf?.results;
  if (!results || !results.first) {
    throw new Error('キーから鍵を開く情報を受け取れませんでした。PC は Chrome か Edge、iPhone は Safari で使ってください');
  }
  return { id: toB64url(assertion.rawId), prf: results.first };
}

async function webauthn(call) {
  try {
    return await call();
  } catch (err) {
    if (err && err.name === 'NotAllowedError') throw new Error('キーの操作が取り消されたか、時間切れになりました。登録したキー（iPhone）か確かめて、もう一度お試しください');
    if (err && err.name === 'InvalidStateError') throw new Error('このキー（iPhone）はすでに登録されています');
    throw new Error('キーを使えませんでした。PC は Chrome か Edge、iPhone は Safari で、もう一度お試しください');
  }
}

function toB64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
