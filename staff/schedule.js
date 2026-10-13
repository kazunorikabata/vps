// 事務所内ページ：スケジュール（Google カレンダーと両方向。つながる前は事務所の側だけで暗号化して保存）
// ・Google カレンダー：件名・日時・場所・参加者は、所長の Google カレンダーを正とする（どのカレンダーを出すか・
//   どれに書くかは設定で選ぶ）。Google 側で直したものもすぐ出る。暗号化されないので、鍵を開かなくても見られる。
// ・事務所の側（/store/* の schedule。1件ずつ暗号化）：Google の予定に結び付けた顧問先・メモ・参加する職員
//   { gcalId, calendarId, client, memo, members }。Google とつながる前に作った予定は、ここに全部入っている
//   { title, date, allDay, start, end, place, client, memo, members }（「まだ Google にない予定を送る」で移せる）。
// 月・週のカレンダー（幅の狭い画面では一覧）に、期限と TODO の期日も重ねて出す（鍵を開いたとき）。
// todo.js の todos・members・me・memberName・todayIso・addDays・loadMembers・loadTodos、
// deadline.js の deadlines・loadDeadlines、forms.js の registeredKey・loadedKey、common.js の共通の部品を使う
const scheduleForm = document.getElementById('schedule-form');
const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];
let events = null;          // 事務所の側の予定（復号したもの）[{ id, saved, staff, value }]（鍵を開くまで null）
let scheduleCursor = null;  // 表示している月の1日、または週の月曜日（YYYY-MM-DD）
let editingEvent = null;    // { gcal, extra, local }（直している予定）
const gcal = { connected: null, events: [], range: '', settings: { show: [], write: '' }, calendars: [] };

document.getElementById('schedule-prev').addEventListener('click', () => moveSchedule(-1));
document.getElementById('schedule-next').addEventListener('click', () => moveSchedule(1));
document.getElementById('schedule-today').addEventListener('click', () => {
  scheduleCursor = null;
  run(refreshSchedule);
});
for (const id of ['schedule-mode', 'schedule-mine', 'schedule-others']) {
  document.getElementById(id).addEventListener('change', () => {
    if (id === 'schedule-mode') scheduleCursor = null;
    run(refreshSchedule);
  });
}
window.addEventListener('resize', () => renderSchedule());
document.getElementById('schedule-add').addEventListener('click', () => openEventForm({}, todayIso()));
document.getElementById('schedule-form-cancel').addEventListener('click', () => { scheduleForm.hidden = true; });
document.getElementById('schedule-form-allday').addEventListener('change', syncAllDay);
scheduleForm.addEventListener('submit', (event) => {
  event.preventDefault();
  run(saveEventForm);
});
document.getElementById('schedule-form-delete').addEventListener('click', () => run(deleteEvent));
document.getElementById('gcal-save').addEventListener('click', () => run(saveCalendarSettings));
document.getElementById('gcal-push').addEventListener('click', () => run(pushLocalEvents));

// スケジュールの画面を開いたとき（app.js）
async function startSchedule() {
  await loadMembers();
  const { clients } = await api('clients/list');
  document.getElementById('schedule-form-client').replaceChildren(
    new Option('なし', ''), ...clients.map((c) => new Option(c.code, c.code)));
  await loadCalendars();
  await loadEvents();
}

// 鍵が開いたとき（app.js）と、画面を開いたとき
async function loadEvents() {
  if (loadedKey) {
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
  } else {
    events = null;
  }
  gcal.range = '';   // Google の予定も読み込み直す
  await refreshSchedule();
}

// --- Google カレンダーとのつながり ---

async function loadCalendars() {
  const status = document.getElementById('gcal-status');
  try {
    const data = await api('calendar/calendars');
    gcal.connected = true;
    gcal.calendars = data.calendars;
    gcal.settings = data.settings;
  } catch (err) {
    gcal.connected = false;
    status.textContent = `${err.message} つながる前は、予定は事務所の側だけに暗号化して保存します。`;
    document.getElementById('gcal-settings').hidden = true;
    return;
  }
  status.textContent = 'Google カレンダーとつながっています。';
  document.getElementById('gcal-calendars').replaceChildren(...gcal.calendars.map((c) => {
    const li = document.createElement('li');
    const line = checkLine(`${c.summary}${c.primary ? '（メイン）' : ''}`, gcal.settings.show.includes(c.id), () => {});
    line.querySelector('input').value = c.id;
    li.append(line);
    return li;
  }));
  const writable = gcal.calendars.filter((c) => ['owner', 'writer'].includes(c.accessRole));
  const write = document.getElementById('gcal-write');
  write.replaceChildren(new Option('選んでください', ''), ...writable.map((c) => new Option(c.summary, c.id)));
  write.value = writable.some((c) => c.id === gcal.settings.write) ? gcal.settings.write : '';
  document.getElementById('gcal-settings').hidden = false;
}

async function saveCalendarSettings() {
  const value = {
    show: [...document.querySelectorAll('#gcal-calendars input:checked')].map((x) => x.value),
    write: document.getElementById('gcal-write').value,
  };
  const { settings } = await api('settings/save', { key: 'calendar', value });
  gcal.settings = settings.calendar;
  gcal.range = '';
  await refreshSchedule();
  showMessage('Google カレンダーの設定を保存しました', 'ok');
}

function localEvents() {
  return (events || []).filter((e) => !e.value.gcalId);
}

function extraFor(eventId) {
  return (events || []).find((e) => e.value.gcalId === eventId) || null;
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
  run(refreshSchedule);
}

// 表示する日（週ならその7日、月なら月曜日から始まる週で月を含む日）
function visibleDays() {
  const today = todayIso();
  if (document.getElementById('schedule-mode').value === 'week') {
    const start = scheduleCursor || weekStart(today);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }
  const first = scheduleCursor || monthStart(today);
  const last = addDays(addMonths(first, 1), -1);
  const days = [];
  for (let d = weekStart(first); d <= last || (days.length % 7) !== 0; d = addDays(d, 1)) days.push(d);
  return days;
}

// 表示する範囲の Google の予定を読み込んでから表示する
async function refreshSchedule() {
  const days = visibleDays();
  const range = `${days[0]}|${days[days.length - 1]}`;
  if (gcal.connected && gcal.range !== range) {
    const { events: list } = await api('calendar/events', { from: days[0], to: days[days.length - 1] });
    gcal.events = list;
    gcal.range = range;
  }
  renderSchedule();
}

// --- 1日分の表示 ---

function timeText(v) {
  return v.allDay ? '' : `${v.start || ''}${v.end ? `〜${v.end}` : ''}`;
}

// その日に出すもの（予定・期限・TODO）。時刻のある予定を先に、時刻の順に
function entriesOn(date) {
  const mine = document.getElementById('schedule-mine').checked;
  const others = document.getElementById('schedule-others').checked;
  const myName = memberName(me);
  const list = [];
  for (const g of gcal.connected ? gcal.events : []) {
    if (date < g.date || date > g.endDate) continue;
    const extra = extraFor(g.eventId);
    const people = extra ? extra.value.members || [] : [];
    if (mine && !people.includes(me) && !(g.participants || '').includes(myName)) continue;
    const client = extra && extra.value.client;
    const time = date === g.date ? timeText(g) : '';
    list.push({ type: 'event', sort: g.allDay || date !== g.date ? '' : g.start, item: { gcal: g, extra },
      label: `${time ? `${time} ` : ''}${g.title}${client ? `（${client}）` : ''}`,
      title: [g.title, timeText(g), g.place, client, g.participants].filter(Boolean).join(' / ') });
  }
  for (const e of localEvents()) {
    const v = e.value;
    if (v.date !== date || (mine && !(v.members || []).includes(me))) continue;
    list.push({ type: 'event', sort: v.allDay ? '' : (v.start || '99'), item: { local: e },
      label: `${timeText(v) ? `${timeText(v)} ` : ''}${v.title}`,
      title: [v.title, timeText(v), v.place, v.client, (v.members || []).map(memberName).join('・')].filter(Boolean).join(' / ') });
  }
  if (others && loadedKey) {
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
  b.addEventListener('click', () => openEventForm({}, date));
  return b;
}

// --- カレンダー ---

function renderSchedule() {
  // 見られるもの：Google の予定（つながっていれば鍵がなくても）か、鍵を開いたときの事務所の側の予定
  const visible = gcal.connected || Boolean(loadedKey);
  document.getElementById('schedule-locked').hidden = visible;
  document.getElementById('schedule-keynote').hidden = !(gcal.connected && !loadedKey);
  document.getElementById('schedule-body').hidden = !visible;
  document.getElementById('gcal-push').hidden = !(gcal.connected && loadedKey && localEvents().length);
  if (!visible) return;
  const mode = document.getElementById('schedule-mode').value;
  const today = todayIso();
  const box = document.getElementById('schedule-calendar');
  const days = visibleDays();
  if (mode === 'week') {
    const [start, end] = [days[0], days[6]];
    document.getElementById('schedule-title').textContent =
      `${start.slice(0, 4)}年${Number(start.slice(5, 7))}月${Number(start.slice(8))}日〜${Number(end.slice(5, 7))}月${Number(end.slice(8))}日`;
    box.replaceChildren(narrowScreen() ? scheduleList(days) : scheduleGrid([days], null, today, 'schedule-week'));
    return;
  }
  const first = scheduleCursor || monthStart(today);
  document.getElementById('schedule-title').textContent = `${first.slice(0, 4)}年${Number(first.slice(5, 7))}月`;
  if (narrowScreen()) {
    box.replaceChildren(scheduleList(days.filter((d) => d.slice(0, 7) === first.slice(0, 7)), true));
    return;
  }
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
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
  const locked = document.getElementById('schedule-form-date').disabled;
  for (const id of ['schedule-form-start', 'schedule-form-end']) document.getElementById(id).disabled = allDay || locked;
}

// item は { gcal, extra }（Google の予定）、{ local }（事務所の側だけの予定）、{}（新しく作る）
function openEventForm(item, date) {
  editingEvent = item;
  const g = item.gcal;
  const extra = item.extra ? item.extra.value : {};
  const local = item.local ? item.local.value : null;
  const v = g ? { ...g, ...extra } : local || { date, allDay: false, members: me ? [me] : [] };
  const isNew = !g && !local;
  document.getElementById('schedule-form-title').textContent = isNew ? '予定を追加' : '予定を直す';
  document.getElementById('schedule-form-name').value = v.title || '';
  document.getElementById('schedule-form-date').value = v.date || '';
  document.getElementById('schedule-form-allday').checked = Boolean(v.allDay);
  document.getElementById('schedule-form-start').value = v.start || '';
  document.getElementById('schedule-form-end').value = v.end || '';
  document.getElementById('schedule-form-place').value = v.place || '';
  document.getElementById('schedule-form-client').value = v.client || '';
  document.getElementById('schedule-form-memo').value = v.memo || '';
  // 複数日にまたがる Google の予定は、日付と時刻を Google カレンダーで直す
  const multiDay = Boolean(g && g.endDate !== g.date);
  for (const id of ['schedule-form-date', 'schedule-form-allday']) document.getElementById(id).disabled = multiDay;
  // 顧問先・メモ・参加する職員は暗号化して残すので、鍵がないと直せない
  for (const id of ['schedule-form-client', 'schedule-form-memo']) document.getElementById(id).disabled = !loadedKey;
  const ids = members.map((m) => m.id);
  if (me && !ids.includes(me)) ids.unshift(me);
  for (const id of v.members || []) if (!ids.includes(id)) ids.push(id);
  // Google の予定で、参加者が職員の名前として書かれていれば、その職員にチェックを入れる
  const chosen = new Set(v.members && v.members.length ? v.members
    : ids.filter((id) => g && (g.participants || '').split('・').includes(memberName(id))));
  document.getElementById('schedule-form-members').replaceChildren(...ids.map((id) => {
    const label = checkLine(id === me ? `${memberName(id)}（自分）` : memberName(id), chosen.has(id), () => {});
    label.querySelector('input').value = id;
    return label;
  }));
  const where = [];
  if (g) where.push(`Google カレンダー「${(gcal.calendars.find((c) => c.id === g.calendarId) || {}).summary || g.calendarId}」の予定です。`);
  else if (local && gcal.connected) where.push('まだ Google カレンダーにない予定です。保存すると Google カレンダーにも入ります。');
  else if (isNew && gcal.connected) where.push('保存すると、Google カレンダーにも入ります。');
  if (multiDay) where.push('複数日にまたがる予定の日付・時刻は、Google カレンダーで直してください。');
  if (!loadedKey) where.push('顧問先とメモを入れるには、上の欄で鍵を開いてください。');
  document.getElementById('schedule-form-where').textContent = where.join('');
  const saved = item.extra || item.local;
  document.getElementById('schedule-form-meta').textContent = saved ? `最終更新 ${formatDate(saved.saved)}・${memberName(saved.staff)}` : '';
  document.getElementById('schedule-form-delete').hidden = isNew;
  syncAllDay();
  scheduleForm.hidden = false;
  scheduleForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('schedule-form-name').focus();
}

function checkKey() {
  if (!registeredKey || !registeredKey.spki) throw new Error('暗号化の鍵が登録されていません');
  if (!loadedKey || loadedKey.fingerprint !== registeredKey.fingerprint) {
    throw new Error('開いている鍵が登録済みの鍵と違うため、保存できません');
  }
}

async function saveStoreItem(id, value) {
  checkKey();
  const encrypted = await FormCrypto.encrypt(registeredKey.spki, registeredKey.fingerprint, value);
  await api('store/save', { store: 'schedule', ...(id ? { id } : {}), encrypted });
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
  const { gcal: g, extra, local } = editingEvent;
  if (gcal.connected) {
    await saveToGoogle(value, g, extra, local);
  } else {
    // Google とつながる前は、事務所の側だけに全部入れる
    await saveStoreItem(local && local.id, value);
  }
  scheduleForm.hidden = true;
  // 保存した予定の月（週）を出す
  const mode = document.getElementById('schedule-mode').value;
  scheduleCursor = mode === 'week' ? weekStart(value.date) : monthStart(value.date);
  await loadEvents();
  showMessage(`「${value.title}」を保存しました`, 'ok');
}

// 件名・日時・場所・参加者は Google カレンダーに。顧問先・メモ・参加する職員は事務所の側に（鍵があるとき）
async function saveToGoogle(value, g, extra, local) {
  const participants = value.members.map(memberName).join('・');
  const { event } = await api('calendar/save', {
    ...(g ? { calendarId: g.calendarId, eventId: g.eventId } : {}),
    title: value.title, date: value.date, allDay: value.allDay, start: value.start, end: value.end,
    place: value.place, participants,
  });
  if (!loadedKey) return;
  const keep = { gcalId: event.eventId, calendarId: event.calendarId, client: value.client, memo: value.memo, members: value.members };
  const id = (extra && extra.id) || (local && local.id);   // 事務所の側だけの予定は、同じ番号のまま Google の予定に結び付ける
  if (id || keep.client || keep.memo || keep.members.length) await saveStoreItem(id, keep);
}

async function deleteEvent() {
  const { gcal: g, extra, local } = editingEvent;
  if (g) await api('calendar/remove', { calendarId: g.calendarId, eventId: g.eventId });
  const item = extra || local;
  if (item) await api('store/remove', { store: 'schedule', id: item.id });
  scheduleForm.hidden = true;
  await loadEvents();
  showMessage('予定を削除しました', 'ok');
}

// Google とつながる前に作った予定を、Google カレンダーに送る（顧問先・メモは事務所の側に残す）
async function pushLocalEvents() {
  const list = localEvents();
  let done = 0;
  for (const e of list) {
    await saveToGoogle(e.value, null, null, e);
    done += 1;
    showMessage(`Google カレンダーに送っています（${done}/${list.length}）…`, 'ok');
  }
  await loadEvents();
  showMessage(`${done}件の予定を Google カレンダーに送りました`, 'ok');
}

// 顧問先の画面（register.js）に、その顧問先のこれからの予定を並べる
async function clientEvents(code) {
  if (!events) {
    await loadMembers();
    if (gcal.connected === null) await loadCalendars().catch(() => {});
    await loadEvents();
  }
  const today = todayIso();
  const result = localEvents().filter((e) => e.value.client === code && e.value.date >= today)
    .map((e) => ({ value: e.value }));
  const linked = (events || []).filter((e) => e.value.gcalId && e.value.client === code);
  if (gcal.connected && linked.length) {
    const { events: list } = await api('calendar/events', { from: today, to: addDays(today, 365) });
    for (const g of list) {
      if (linked.some((e) => e.value.gcalId === g.eventId)) result.push({ value: { ...g } });
    }
  }
  return result.sort((a, b) => `${a.value.date}${a.value.start || ''}`.localeCompare(`${b.value.date}${b.value.start || ''}`));
}
