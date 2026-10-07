// 入力ページの暗号化（顧問先の画面）と復号（事務所内ページ）
// 入力内容は AES-GCM（256ビット）で暗号化し、その鍵を事務所の公開鍵（RSA-OAEP 4096ビット・SHA-256）で包む。
// 包んだ鍵を開ける秘密鍵は、パスワードで暗号化したファイルとして職員が持つ（サーバーには置かない）
const FormCrypto = (() => {
  const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' };
  const PBKDF2_ITERATIONS = 600000;
  const subtle = window.crypto && window.crypto.subtle;

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function fromB64(s) {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  }

  function random(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  function supported() {
    return Boolean(subtle);
  }

  // 公開鍵の指紋（サーバーの記録と同じ、SPKI の SHA-256）
  async function fingerprint(spkiB64) {
    const hash = await subtle.digest('SHA-256', fromB64(spkiB64));
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // 画面に出す短い形（先頭16文字を4文字ずつ）
  function shortFingerprint(fp) {
    return (fp || '').slice(0, 16).match(/.{1,4}/g)?.join(' ') || '';
  }

  async function encrypt(spkiB64, keyId, value) {
    const publicKey = await subtle.importKey('spki', fromB64(spkiB64), RSA, false, ['wrapKey']);
    const aesKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = random(12);
    const data = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey,
      new TextEncoder().encode(JSON.stringify(value)));
    const key = await subtle.wrapKey('raw', aesKey, publicKey, RSA);
    return { keyId, key: toB64(key), iv: toB64(iv), data: toB64(data) };
  }

  async function decrypt(privateKey, encrypted) {
    const aesKey = await subtle.unwrapKey('raw', fromB64(encrypted.key), privateKey, RSA,
      { name: 'AES-GCM' }, false, ['decrypt']);
    const data = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(encrypted.iv) }, aesKey, fromB64(encrypted.data));
    return JSON.parse(new TextDecoder().decode(data));
  }

  async function passphraseKey(passphrase, salt, usages) {
    const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, usages);
  }

  // 新しい鍵を作り、秘密鍵はパスワードで暗号化したファイルの中身として返す
  async function createKey(passphrase) {
    const pair = await subtle.generateKey(
      { ...RSA, modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['wrapKey', 'unwrapKey']);
    const spki = toB64(await subtle.exportKey('spki', pair.publicKey));
    const fp = await fingerprint(spki);
    const salt = random(16);
    const iv = random(12);
    const lockKey = await passphraseKey(passphrase, salt, ['wrapKey']);
    const wrapped = await subtle.wrapKey('pkcs8', pair.privateKey, lockKey, { name: 'AES-GCM', iv });
    const file = {
      type: 'kabaoffice-private-key',
      version: 1,
      created: new Date().toISOString(),
      fingerprint: fp,
      publicKey: spki,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toB64(salt) },
      iv: toB64(iv),
      privateKey: toB64(wrapped),
    };
    return { spki, fingerprint: fp, file };
  }

  // 鍵ファイルとパスワードから秘密鍵を取り出す（取り出した鍵はこのページの中だけで使い、書き出せない）
  async function openKey(file, passphrase) {
    if (!file || file.type !== 'kabaoffice-private-key' || file.version !== 1) {
      throw new Error('鍵のファイルではありません');
    }
    const lockKey = await passphraseKey(passphrase, fromB64(file.kdf.salt), ['unwrapKey']);
    try {
      const privateKey = await subtle.unwrapKey('pkcs8', fromB64(file.privateKey), lockKey,
        { name: 'AES-GCM', iv: fromB64(file.iv) }, RSA, false, ['unwrapKey']);
      return { privateKey, fingerprint: file.fingerprint };
    } catch {
      throw new Error('パスワードが違います');
    }
  }

  return { supported, fingerprint, shortFingerprint, encrypt, decrypt, createKey, openKey };
})();
