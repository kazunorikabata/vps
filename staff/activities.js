// 事務所内ページ：応対履歴の一覧（全顧問先の応対を新しい順に。顧問先で絞り込む）
// 応対履歴は、事務所用で「顧問先を選ぶ」入力ページに送られたもの。暗号化したものは、上の欄で開いた鍵で復号して見る
// common.js の共通の部品と、forms.js の loadedKey を使う
const activitiesCard = document.getElementById('activities');
const activitiesCode = document.getElementById('activities-code');
activitiesCode.addEventListener('change', () => run(loadActivities));

function startActivities() {
  activitiesCard.hidden = false;
  document.getElementById('activities-view').hidden = true;
  run(async () => {
    const { clients } = await api('clients/list');
    const chosen = activitiesCode.value;
    activitiesCode.replaceChildren(new Option('すべて', ''), ...clients.map((c) => new Option(c.code, c.code)));
    activitiesCode.value = clients.some((c) => c.code === chosen) ? chosen : '';
    await loadActivities();
  });
}

async function loadActivities() {
  const code = activitiesCode.value;
  const { activities } = await api('activities/list', code ? { code } : {});
  document.getElementById('activities-list').replaceChildren(...activities.map((a) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `${formatDate(a.submitted)}　${a.code}　${a.formTitle}　${a.staff || '-'}`;
    li.append(span, button('表示', () => run(() => showActivityItem(a)), 'button-outline'),
      button('台帳', () => { location.hash = `#register/${encodeURIComponent(a.code)}`; }, 'button-outline'));
    return li;
  }));
  document.getElementById('activities-empty').hidden = activities.length > 0;
}

async function showActivityItem(a) {
  const { record } = await api('submissions/get', { formId: a.formId, id: a.id });
  let answers = record.answers;
  if (record.encrypted) {
    if (!loadedKey) throw new Error('暗号化されています。上の欄で鍵を開いてください');
    if (record.encrypted.keyId !== loadedKey.fingerprint) throw new Error('別の鍵で暗号化されています');
    answers = await FormCrypto.decrypt(loadedKey.privateKey, record.encrypted);
  }
  const view = document.getElementById('activities-view');
  const title = document.createElement('h3');
  title.textContent = `${formatDate(a.submitted)}　${a.code}　${a.formTitle}（${a.staff || '-'}）`;
  const grid = document.createElement('div');
  FormRender.buildView(grid, record.fields, answers, {});
  const close = button('閉じる', () => { view.hidden = true; view.replaceChildren(); }, 'button-outline');
  close.style.marginTop = '12px';
  view.replaceChildren(title, grid, close);
  view.hidden = false;
  view.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
