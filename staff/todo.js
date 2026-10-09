// 事務所内ページ：TODO（1件ずつ事務所の鍵で暗号化して保存する。見る・直すには、上の欄で鍵を開く）
// サーバーは中身を読めないので、絞り込み・並べ替えは、このページで復号してから行う。
// 直すたび・消すたびにスプレッドシートに行が足され、誰がいつ直したかが残る。
// 担当は「職員の一覧」（事務所内ページにログインするID と表示名）から選ぶ。
// common.js の共通の部品と、forms.js の registeredKey・loadedKey を使う
const TODO_PRIORITY = { high: '高', normal: '中', low: '低' };
const TODO_STATUS = { todo: '未着手', doing: '進行中', done: '完了' };
const todoForm = document.getElementById('todo-form');
let todos = null;       // 復号した TODO [{ id, saved, staff, value }]（鍵を開くまで null）
let members = [];       // 職員の一覧 [{ id, name }]
let me = '';            // 今ログインしている職員のID
let editingTodo = null; // 直している TODO（新しく作るときは {}）

for (const id of ['todo-who', 'todo-done', 'todo-client']) {
  document.getElementById(id).addEventListener('change', renderTodos);
}
document.getElementById('todo-add').addEventListener('click', () => openTodoForm(null));
document.getElementById('todo-cancel').addEventListener('click', closeTodoForm);
todoForm.addEventListener('submit', (event) => {
  event.preventDefault();
  run(saveTodo);
});

// TODO の画面を開いたとき（app.js）
async function startTodo() {
  await loadMembers();
  await fillTodoClients();
  await loadTodos();
}

async function fillTodoClients() {
  const { clients } = await api('clients/list');
  for (const id of ['todo-client', 'todo-client-select']) {
    const select = document.getElementById(id);
    const chosen = select.value;
    select.replaceChildren(new Option(id === 'todo-client' ? 'すべて' : 'なし', ''),
      ...clients.map((c) => new Option(c.code, c.code)));
    select.value = clients.some((c) => c.code === chosen) ? chosen : '';
  }
}

async function loadTodos() {
  const locked = !loadedKey;
  document.getElementById('todo-locked').hidden = !locked;
  document.getElementById('todo-body').hidden = locked;
  if (locked) {
    todos = null;
    return;
  }
  const { items } = await api('store/list', { store: 'todo' });
  const list = [];
  for (const item of items) {
    if (item.encrypted.keyId !== loadedKey.fingerprint) continue;   // 別の鍵（作り直す前の鍵）のもの
    try {
      list.push({ ...item, value: await FormCrypto.decrypt(loadedKey.privateKey, item.encrypted) });
    } catch {
      // 壊れたものは出さない
    }
  }
  todos = list;
  renderTodos();
}

function todayIso() {
  return formatDate(new Date().toISOString()).slice(0, 10);
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function memberName(id) {
  const m = members.find((x) => x.id === id);
  return m && m.name ? m.name : (id || '—');
}

// 期日の表示（今日・明日・期限切れが分かるように）
function dueLabel(due) {
  if (!due) return '—';
  const today = todayIso();
  const text = `${Number(due.slice(5, 7))}/${Number(due.slice(8, 10))}`;
  if (due === today) return `${text}（今日）`;
  if (due === addDays(today, 1)) return `${text}（明日）`;
  if (due < today) return `${text}（期限切れ）`;
  return due.slice(0, 4) === today.slice(0, 4) ? text : `${due.slice(0, 4)}/${text}`;
}

function renderTodos() {
  if (!todos) return;
  const who = document.getElementById('todo-who').value;
  const showDone = document.getElementById('todo-done').checked;
  const client = document.getElementById('todo-client').value;
  const order = { high: 0, normal: 1, low: 2 };
  const list = todos
    .filter((t) => (who !== 'me' || t.value.assignee === me) && (showDone || t.value.status !== 'done')
      && (!client || t.value.client === client))
    .sort((a, b) => (a.value.due || '9999') .localeCompare(b.value.due || '9999')
      || order[a.value.priority] - order[b.value.priority] || a.saved.localeCompare(b.saved));
  const today = todayIso();
  document.getElementById('todo-list').replaceChildren(...list.map((t) => {
    const v = t.value;
    const tr = document.createElement('tr');
    if (v.status === 'done') tr.classList.add('is-done');
    else if (v.due && v.due < today) tr.classList.add('is-overdue');
    else if (v.due && v.due <= addDays(today, 1)) tr.classList.add('is-soon');
    const title = cell(v.title);
    if (v.memo) title.title = v.memo;
    const priority = cell(TODO_PRIORITY[v.priority] || '中');
    if (v.priority === 'high') priority.className = 'todo-priority-high';
    const ops = document.createElement('td');
    ops.className = 'ops';
    const show = () => ops.replaceChildren(
      ...(v.status === 'done' ? [] : [button('完了にする', () => run(() => saveTodoValue(t.id, { ...v, status: 'done' })))]),
      button('編集', () => openTodoForm(t), 'button-outline'),
      button('削除', () => askConfirm(ops, `「${v.title}」を削除しますか？`, '削除する', async () => {
        await api('store/remove', { store: 'todo', id: t.id });
        await loadTodos();
        showMessage(`「${v.title}」を削除しました`, 'ok');
      }, show), 'button-danger'),
    );
    show();
    tr.append(cell(dueLabel(v.due)), title, cell(memberName(v.assignee)), priority,
      cell(TODO_STATUS[v.status] || '未着手'), cell(v.client || '—'), ops);
    return tr;
  }));
  document.getElementById('todo-empty').hidden = list.length > 0;
}

// --- 追加・編集 ---

function assigneeOptions(selected) {
  const ids = members.map((m) => m.id);
  if (me && !ids.includes(me)) ids.unshift(me);
  if (selected && !ids.includes(selected)) ids.push(selected);
  return ids.map((id) => new Option(id === me ? `${memberName(id)}（自分）` : memberName(id), id));
}

function openTodoForm(item, client) {
  editingTodo = item || {};
  const v = item ? item.value : { priority: 'normal', status: 'todo', assignee: me, client: client || '' };
  document.getElementById('todo-form-title').textContent = item ? 'TODO を直す' : 'TODO を追加';
  document.getElementById('todo-title').value = v.title || '';
  document.getElementById('todo-memo').value = v.memo || '';
  const assignee = document.getElementById('todo-assignee');
  assignee.replaceChildren(...assigneeOptions(v.assignee));
  assignee.value = v.assignee || me;
  document.getElementById('todo-due').value = v.due || '';
  document.getElementById('todo-priority').value = v.priority || 'normal';
  document.getElementById('todo-status').value = v.status || 'todo';
  document.getElementById('todo-client-select').value = v.client || '';
  document.getElementById('todo-meta').textContent = item ? `最終更新 ${formatDate(item.saved)}・${memberName(item.staff)}` : '';
  todoForm.hidden = false;
  todoForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('todo-title').focus();
}

function closeTodoForm() {
  editingTodo = null;
  todoForm.hidden = true;
}

async function saveTodo() {
  const value = {
    title: document.getElementById('todo-title').value.trim(),
    memo: document.getElementById('todo-memo').value.trim(),
    assignee: document.getElementById('todo-assignee').value,
    due: document.getElementById('todo-due').value,
    priority: document.getElementById('todo-priority').value,
    status: document.getElementById('todo-status').value,
    client: document.getElementById('todo-client-select').value,
  };
  if (!value.title) throw new Error('内容を入力してください');
  await saveTodoValue(editingTodo && editingTodo.id, value);
  closeTodoForm();
}

async function saveTodoValue(id, value) {
  if (!registeredKey || !registeredKey.spki) throw new Error('暗号化の鍵が登録されていません');
  if (!loadedKey || loadedKey.fingerprint !== registeredKey.fingerprint) {
    throw new Error('開いている鍵が登録済みの鍵と違うため、保存できません');
  }
  const encrypted = await FormCrypto.encrypt(registeredKey.spki, registeredKey.fingerprint, value);
  await api('store/save', { store: 'todo', ...(id ? { id } : {}), encrypted });
  await loadTodos();
  showMessage(`「${value.title}」を保存しました`, 'ok');
}

// 顧問先の画面（register.js）に、その顧問先の TODO を並べる
async function clientTodos(code) {
  if (!todos) {
    await loadMembers();
    await loadTodos();
  }
  const order = { todo: 0, doing: 0, done: 1 };
  return (todos || []).filter((t) => t.value.client === code)
    .sort((a, b) => order[a.value.status] - order[b.value.status] || (a.value.due || '9999').localeCompare(b.value.due || '9999'));
}

// --- 職員の一覧 ---

async function loadMembers() {
  const data = await api('members/list');
  members = data.members;
  me = data.me;
  renderMembers();
}

function renderMembers() {
  document.getElementById('members-list').replaceChildren(...members.map((m) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `${m.name || '（名前なし）'}　ID：${m.id}${m.id === me ? '（自分）' : ''}`;
    li.append(span, button('削除', () => run(() => saveMembers(members.filter((x) => x.id !== m.id))), 'button-outline'));
    return li;
  }));
}

async function saveMembers(list) {
  members = (await api('members/save', { members: list })).members;
  renderMembers();
  renderTodos();
}

document.getElementById('members-add').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = document.getElementById('member-id').value.trim();
  const name = document.getElementById('member-name').value.trim();
  if (members.some((m) => m.id === id)) return showMessage(`${id} はすでに登録されています`, 'error');
  run(async () => {
    await saveMembers([...members, { id, name }]);
    event.target.reset();
    showMessage(`${name || id} を追加しました`, 'ok');
  });
});
