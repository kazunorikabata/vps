// 事務所内ページの画面の切り替え（URL の # の部分。例：#register/C001 は顧客台帳で C001 を開く）
// ページを読み込み直さずに切り替えるので、開いた鍵はこのページを閉じるか再読み込みするまで、どの画面でも使える
const ROUTES = {
  clients: { view: 'clients', title: '顧問先の一覧' },
  activity: { view: 'forms', kind: 'activity' },
  forms: { view: 'forms', kind: 'client' },
  register: { view: 'forms', kind: 'register' },
  todo: { view: 'todo', title: 'TODO' },
  deadline: { view: 'deadline', title: '期限の管理' },
  schedule: { view: 'schedule', title: 'スケジュール' },
  office: { view: 'forms', kind: 'office' },
  site: { view: 'site', title: 'サイトの修正' },
  keys: { view: 'keys', title: '暗号化の鍵' },
};

function route() {
  const [name, arg] = location.hash.slice(1).split('/');
  const key = ROUTES[name] ? name : 'clients';
  const r = ROUTES[key];
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== r.view;
  for (const a of document.querySelectorAll('.staff-sidebar a')) {
    const on = a.dataset.nav === key;
    a.classList.toggle('is-current', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${r.title || KIND_TITLES[r.kind]}｜事務所内｜蒲田和紀税理士事務所`;
  message.hidden = true;
  if (r.kind) setKind(r.kind, arg ? decodeURIComponent(arg) : undefined);
  if (key === 'todo') run(startTodo);
  if (key === 'deadline') run(startDeadline);
  window.scrollTo({ top: 0 });
}

function currentRoute() {
  const name = location.hash.slice(1).split('/')[0];
  return ROUTES[name] ? name : 'clients';
}

// 鍵が開いたとき（forms.js の showKey から）。今の画面の中身を読み込み直す
function keyOpened() {
  const name = currentRoute();
  if (name === 'register') registerKeyChanged();
  if (name === 'todo') run(loadTodos);
  if (name === 'deadline') run(loadDeadlines);
}

window.addEventListener('hashchange', route);

// 一覧などを順に読み込んでから、最初の画面を出す（同時に動かすと、ボタンの使える・使えないが乱れるため）。
// どれかが読み込めなくても、ほかは使えるようにする
document.addEventListener('DOMContentLoaded', () => run(async () => {
  for (const load of [loadClients, loadForms, loadUnlocks]) {
    try {
      await load();
    } catch (err) {
      showMessage(err.message, 'error');
    }
  }
  route();
}));
