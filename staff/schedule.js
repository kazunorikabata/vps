// 事務所内ページ：スケジュール（予定。1件ずつ事務所の鍵で暗号化して保存する）
// 仕組みは TODO・期限と同じ（/store/*。直す・消すたびに行を足す）。見る・直すには、上の欄で鍵を開く。
// 月・週のカレンダーで見る（幅の狭い画面では日付順の一覧）。期限と TODO の期日も、色を変えて並べられる。
// todo.js の todos・members・me・memberName・todayIso・addDays・loadMembers・loadTodos、
// deadline.js の deadlines・loadDeadlines、forms.js の registeredKey・loadedKey、common.js の共通の部品を使う
const scheduleForm = document.getElementById('schedule-form');
const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];
let events = null;          // 復号した予定 [{ id, saved, staff, value }]（鍵を開くまで null）
let scheduleCursor = null;  // 表示している月の1日、または週の月曜日（YYYY-MM-DD）
let editingEvent = null;

document.getElementById('schedule-prev').addEventListener('click', () => moveSchedule(-1));
document.getElementById('schedule-next').addEventListener('click', () => moveSchedule(1));
document.getElementById('schedule-today').addEventListener('click', () => {
  scheduleCursor = null;
  renderSchedule();
});
for (const id of ['schedule-mode', 'schedule-mine', 'schedule-others']) {
  document.getElementById(id).addEventListener('change', () => {
    if (id === 'schedule-mode') scheduleCursor = null;
    renderSchedule();
  });
}
window.addEventListener('resize', () => { if (events) renderSchedule(); });
document.getElementById('schedule-add').addEventListener('click', () => openEventForm(null, todayIso()));
document.getElementById('schedule-form-cancel').addEventListener('click', () => { scheduleForm.hidden = true; });
document.getElementById('schedule-form-allday').addEventListener('change', syncAllDay);
scheduleForm.addEventListener('submit', (event) => {
  event.preventDefault();
  run(saveEventForm);
});
document.getElementById('schedule-form-delete').addEventListener('click', () => run(async () => {
  await api('store/remove', { store: 'schedule', id: editingEvent.id });
  scheduleForm.hidden = true;
  await loadEvents();
  showMessage('予定を削除しました', 'ok');
}));

// スケジュールの画面を開いたとき（app.js）
async function startSchedule() {
  await loadMembers();
  const { clients } = await api('clients/list');
  document.getElementById('schedule-form-client').replaceChildren(
    new Option('なし', ''), ...clients.map((c) => new Option(c.code, c.code)));
  await loadEvents();
}

async function loadEvents() {
  const locked = !loadedKey;
  document.getElementById('schedule-locked').hidden = !locked;
  document.getElementById('schedule-body').hidden = locked;
  if (locked) {
    events = null;
    return;
  }
  const { items } = await api('store/list', { store: 'schedule' });
  const list = [];
  for (const item of items) {
    if (item.encrypted.keyId !== loadedKey.fingerprint) continue;
    try {
      list.push({ ...item, value: await FormCrypto.decrypt(loadedKey.privateKey, item.encrypted) });
    } catch {
      // 壊れたものは出さない
    }
  }
  events = list;
  // 期限と TODO も重ねて出すので、まだなら読み込む
  if (!todos) await loadTodos();
  if (!deadlines) await loadDeadlines();
  renderSchedule();
}

// --- 日付 ---

function weekStart(iso) {
  const day = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;   // 月曜日を0にする
  return addDays(iso, -day);
}

function monthStart(iso) {
  return `${iso.slice(0, 7)}-01`;
}

function addMonths(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n, 1);
  return d.toISOString().slice(0, 10);
}

function narrowScreen() {
  return window.innerWidth < 700;
}

function moveSchedule(step) {
  const mode = document.getElementById('schedule-mode').value;
  const base = scheduleCursor || (mode === 'week' ? weekStart(todayIso()) : monthStart(todayIso()));
  scheduleCursor = mode === 'week' ? addDays(base, step * 7) : addMonths(base, step);
  renderSchedule();
}

// --- 1日分の表示 ---

// その日に出すもの（予定・期限・TODO）。時刻のある予定を先に、時刻の順に
function entriesOn(date) {
  const mine = document.getElementById('schedule-mine').checked;
  const others = document.getElementById('schedule-others').checked;
  const list = [];
  for (const e of events || []) {
    const v = e.value;
    if (v.date !== date || (mine && !(v.members || []).includes(me))) continue;
    const time = v.allDay ? '' : `${v.start || ''}${v.end ? `〜${v.end}` : ''}`;
    list.push({ type: 'event', sort: v.allDay ? '' : (v.start || '99'), label: `${time ? `${time} ` : ''}${v.title}`,
      title: [v.title, time, v.place, v.client, (v.members || []).map(memberName).join('・')].filter(Boolean).join(' / '), item: e });
  }
  if (others) {
    for (const d of deadlines || []) {
      const v = d.value;
      if (v.due !== date || v.status === 'done' || (mine && v.assignee !== me)) continue;
      list.push({ type: 'deadline', sort: '98', label: `期限：${v.kind}${v.client ? `（${v.client}）` : ''}`, title: `${v.kind} ${v.client || ''}` });
    }
    for (const t of todos || []) {
      const v = t.value;
      if (v.due !== date || v.status === 'done' || (mine && v.assignee !== me)) continue;
      list.push({ type: 'todo', sort: '99', label: `TODO：${v.title}`, title: v.title });
    }
  }
  return list.sort((a, b) => a.sort.localeCompare(b.sort));
}

function entryButton(entry) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `sch-item sch-${entry.type}`;
  b.textContent = entry.label;
  b.title = entry.title;
  if (entry.type === 'event') b.addEventListener('click', () => openEventForm(entry.item));
  else b.addEventListener('click', () => { location.hash = entry.type === 'todo' ? '#todo' : '#deadline'; });
  return b;
}

function dayButton(date, text) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sch-day';
  b.textContent = text;
  b.title = 'この日の予定を追加';
  b.addEventListener('click', () => openEventForm(null, date));
  return b;
}

// --- カレンダー ---

function renderSchedule() {
  if (!events) return;
  const mode = document.getElementById('schedule-mode').value;
  const today = todayIso();
  const box = document.getElementById('schedule-calendar');
  if (mode === 'week') {
    const start = scheduleCursor || weekStart(today);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    document.getElementById('schedule-title').textContent =
      `${start.slice(0, 4)}年${Number(start.slice(5, 7))}月${Number(start.slice(8))}日〜${Number(days[6].slice(5, 7))}月${Number(days[6].slice(8))}日`;
    box.replaceChildren(narrowScreen() ? scheduleList(days) : scheduleGrid([days], null, today, 'schedule-week'));
    return;
  }
  const first = scheduleCursor || monthStart(today);
  document.getElementById('schedule-title').textContent = `${first.slice(0, 4)}年${Number(first.slice(5, 7))}月`;
  if (narrowScreen()) {
    const days = [];
    for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = addDays(d, 1)) days.push(d);
    box.replaceChildren(scheduleList(days, true));
    return;
  }
  const weeks = [];
  for (let d = weekStart(first); d <= addDays(addMonths(first, 1), -1) || weeks.length === 0; d = addDays(d, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  }
  box.replaceChildren(scheduleGrid(weeks, first.slice(0, 7), today, ''));
}

function scheduleGrid(weeks, month, today, extraClass) {
  const table = document.createElement('table');
  table.className = `schedule-grid ${extraClass}`.trim();
  const head = table.createTHead().insertRow();
  WEEKDAYS.forEach((w, i) => {
    const th = document.createElement('th');
    th.textContent = w;
    if (i === 5) th.className = 'sch-sat';
    if (i === 6) th.className = 'sch-sun';
    head.append(th);
  });
  const body = table.createTBody();
  for (const week of weeks) {
    const tr = body.insertRow();
    week.forEach((date, i) => {
      const td = tr.insertCell();
      if (month && date.slice(0, 7) !== month) td.classList.add('is-other');
      if (date === today) td.classList.add('is-today');
      const day = dayButton(date, month ? String(Number(date.slice(8))) : `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`);
      if (i === 5) day.classList.add('sch-sat');
      if (i === 6) day.classList.add('sch-sun');
      td.append(day, ...entriesOn(date).map(entryButton));
    });
  }
  return table;
}

// 幅の狭い画面：日付順の一覧（予定などがある日だけ。月の表示では今日も出す）
function scheduleList(days, onlyBusy = false) {
  const ul = document.createElement('ul');
  ul.className = 'schedule-list';
  const today = todayIso();
  for (const date of days) {
    const entries = entriesOn(date);
    if (onlyBusy && !entries.length && date !== today) continue;
    const li = document.createElement('li');
    const w = WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7];
    const day = dayButton(date, `${Number(date.slice(5, 7))}/${Number(date.slice(8))}（${w}）${date === today ? ' 今日' : ''}`);
    day.classList.add('sch-date');
    li.append(day, ...entries.map(entryButton));
    ul.append(li);
  }
  if (!ul.children.length) ul.append(Object.assign(document.createElement('li'), { textContent: '予定はありません。' }));
  return ul;
}

// --- 追加・編集 ---

function syncAllDay() {
  const allDay = document.getElementById('schedule-form-allday').checked;
  for (const id of ['schedule-form-start', 'schedule-form-end']) document.getElementById(id).disabled = allDay;
}

function openEventForm(item, date) {
  editingEvent = item || {};
  const v = item ? item.value : { date, allDay: false, members: me ? [me] : [] };
  document.getElementById('schedule-form-title').textContent = item ? '予定を直す' : '予定を追加';
  document.getElementById('schedule-form-name').value = v.title || '';
  document.getElementById('schedule-form-date').value = v.date || '';
  document.getElementById('schedule-form-allday').checked = Boolean(v.allDay);
  document.getElementById('schedule-form-start').value = v.start || '';
  document.getElementById('schedule-form-end').value = v.end || '';
  document.getElementById('schedule-form-place').value = v.place || '';
  document.getElementById('schedule-form-client').value = v.client || '';
  document.getElementById('schedule-form-memo').value = v.memo || '';
  const ids = members.map((m) => m.id);
  if (me && !ids.includes(me)) ids.unshift(me);
  for (const id of v.members || []) if (!ids.includes(id)) ids.push(id);
  document.getElementById('schedule-form-members').replaceChildren(...ids.map((id) => {
    const label = checkLine(id === me ? `${memberName(id)}（自分）` : memberName(id), (v.members || []).includes(id), () => {});
    label.querySelector('input').value = id;
    return label;
  }));
  document.getElementById('schedule-form-meta').textContent = item ? `最終更新 ${formatDate(item.saved)}・${memberName(item.staff)}` : '';
  document.getElementById('schedule-form-delete').hidden = !item;
  syncAllDay();
  scheduleForm.hidden = false;
  scheduleForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('schedule-form-name').focus();
}

async function saveEventForm() {
  const allDay = document.getElementById('schedule-form-allday').checked;
  const value = {
    title: document.getElementById('schedule-form-name').value.trim(),
    date: document.getElementById('schedule-form-date').value,
    allDay,
    start: allDay ? '' : document.getElementById('schedule-form-start').value,
    end: allDay ? '' : document.getElementById('schedule-form-end').value,
    place: document.getElementById('schedule-form-place').value.trim(),
    client: document.getElementById('schedule-form-client').value,
    members: [...document.querySelectorAll('#schedule-form-members input:checked')].map((x) => x.value),
    memo: document.getElementById('schedule-form-memo').value.trim(),
  };
  if (!value.title || !value.date) throw new Error('件名と日付を入力してください');
  if (value.start && value.end && value.end < value.start) throw new Error('終了の時刻が開始より前です');
  if (!registeredKey || !registeredKey.spki) throw new Error('暗号化の鍵が登録されていません');
  if (!loadedKey || loadedKey.fingerprint !== registeredKey.fingerprint) {
    throw new Error('開いている鍵が登録済みの鍵と違うため、保存できません');
  }
  const encrypted = await FormCrypto.encrypt(registeredKey.spki, registeredKey.fingerprint, value);
  await api('store/save', { store: 'schedule', ...(editingEvent && editingEvent.id ? { id: editingEvent.id } : {}), encrypted });
  scheduleForm.hidden = true;
  // 保存した予定の月（週）を出す
  const mode = document.getElementById('schedule-mode').value;
  scheduleCursor = mode === 'week' ? weekStart(value.date) : monthStart(value.date);
  await loadEvents();
  showMessage(`「${value.title}」を保存しました`, 'ok');
}

// 顧問先の画面（register.js）に、その顧問先のこれからの予定を並べる
async function clientEvents(code) {
  if (!events) {
    await loadMembers();
    await loadEvents();
  }
  const today = todayIso();
  return (events || []).filter((e) => e.value.client === code && e.value.date >= today)
    .sort((a, b) => `${a.value.date}${a.value.start || ''}`.localeCompare(`${b.value.date}${b.value.start || ''}`));
}
