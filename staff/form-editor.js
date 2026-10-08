// 事務所内ページ：入力ページの作成画面（マス目に部品を並べる）
// 左のマス目は顧問先の画面と同じ見た目（render.js）。部品を押して選ぶと右側で設定を変えられる。
// ドラッグで並べ替え・枠への出し入れ、右端のつまみで幅（横12マスのうち何マス使うか）を変える。
// forms.js の共通の関数（button・select・input・checkLine・run・api・showMessage・loadForms）を使う
const TYPES = {
  text: '1行の文字',
  textarea: '複数行の文字',
  number: '数字・金額',
  date: '日付',
  select: '選択肢',
  checkbox: 'チェック',
  checkboxes: '複数チェック',
  file: 'ファイル',
  tel: '電話番号',
  email: 'メールアドレス',
  zip: '郵便番号',
  mynumber: 'マイナンバー',
  table: '表',
  heading: '見出し',
  divider: '区切り線',
  note: '説明文',
  spacer: '空白',
  group: '枠',
  page: 'ページ区切り',
};
const LAYOUT_PALETTE = ['heading', 'divider', 'note', 'spacer', 'group', 'page'];
// 枠の中に置けない部品（いちばん外の並びにだけ置ける）
const TOP_ONLY = ['group', 'page'];
const COLUMN_TYPES = { text: '文字', number: '数字・金額', date: '日付', select: '選択肢', checkbox: 'チェック', mynumber: 'マイナンバー' };
const NOTE_STYLES = { normal: '普通', bold: '太字', warning: '注意（赤）' };
const WIDTHS = {
  12: '全幅（12マス）', 9: '4分の3（9マス）', 8: '3分の2（8マス）', 6: '半分（6マス）',
  4: '3分の1（4マス）', 3: '4分の1（3マス）', 2: '2マス', 1: '1マス',
  5: '5マス', 7: '7マス', 10: '10マス', 11: '11マス',
};
// 追加したときの幅
const DEFAULT_WIDTH = { text: 6, email: 6, number: 4, date: 4, select: 4, checkbox: 4, tel: 4, mynumber: 4, zip: 3, spacer: 3 };
const DIRECTIONS = { vertical: '縦に並べる', horizontal: '横に並べる' };

const editor = document.getElementById('editor');
const canvas = document.getElementById('ed-canvas');
const props = document.getElementById('ed-props');
const edEncrypt = document.getElementById('ed-encrypt');

let editing = null;      // 編集中の入力ページ { id, form }
let selectedId = null;   // 選んでいる部品
let draggingId = null;   // ドラッグ中の部品

// --- 部品の追加ボタン ---

const palette = document.getElementById('ed-palette');
for (const [title, types] of [['入力欄', Object.keys(TYPES).filter((t) => !LAYOUT_PALETTE.includes(t))], ['レイアウト', LAYOUT_PALETTE]]) {
  const row = document.createElement('div');
  row.className = 'ed-palette-row';
  const name = document.createElement('span');
  name.className = 'ed-palette-title';
  name.textContent = title;
  row.append(name, ...types.map((type) => button(`＋${TYPES[type]}`, () => addField(type), 'button-outline')));
  palette.append(row);
}

document.getElementById('new-form').addEventListener('click', () => openEditor(null));
document.getElementById('ed-cancel').addEventListener('click', () => { editor.hidden = true; });
document.getElementById('ed-title').addEventListener('input', (e) => { editing.form.title = e.target.value; });
document.getElementById('ed-description').addEventListener('input', (e) => { editing.form.description = e.target.value; });
document.getElementById('ed-pdf-border').addEventListener('change', (e) => { editing.form.pdfBorder = e.target.checked; });
// 項目名・説明の位置（入力ページ全体。項目ごとの設定があればそちらが優先）
for (const key of ['labelPosition', 'helpPosition']) {
  const id = key === 'labelPosition' ? 'ed-label-position' : 'ed-help-position';
  document.getElementById(id).addEventListener('change', (e) => {
    editing.form[key] = e.target.value;
    renderAll();
  });
}
edEncrypt.addEventListener('change', () => {
  editing.form.encrypt = edEncrypt.checked;
  showEncryptNote();
});

document.getElementById('ed-save').addEventListener('click', () => run(async () => {
  const body = { form: editing.form };
  if (editing.id) body.id = editing.id;
  const { form } = await api('forms/save', body);
  editing.id = form.id;
  document.getElementById('editor-title').textContent = `「${form.title}」を編集`;
  showMessage(`「${form.title}」を保存しました`, 'ok');
  await loadForms();
}));

// プレビュー：顧問先の入力画面を別のタブで開き、そこから formPreview() で編集中の内容を受け取ってもらう
// （同じサイトの画面からしか呼べない）。毎回 URL を変えて、開いているタブも読み込み直させる
window.formPreview = () => editing && structuredClone(editing.form);
document.getElementById('ed-preview').addEventListener('click', () => {
  const tab = window.open(`/form/index.html?preview=${Date.now()}#preview`, 'kabaoffice-form-preview');
  if (!tab) showMessage('プレビューを開けませんでした。ブラウザでポップアップを許可してください', 'error');
});

// 何もないところを押したら、選ぶのをやめる
canvas.addEventListener('click', (event) => {
  if (event.target === canvas) selectField(null);
});
dropTarget(canvas, () => editing.form.fields, () => editing.form.fields.length, false);

function openEditor(form) {
  editing = form
    ? { id: form.id, form: structuredClone({ title: form.title, description: form.description, encrypt: form.encrypt,
      pdfBorder: form.pdfBorder !== false, labelPosition: form.labelPosition || 'top', helpPosition: form.helpPosition || 'above',
      fields: form.fields }) }
    : { id: null, form: { title: '', description: '', encrypt: true, pdfBorder: true, labelPosition: 'top', helpPosition: 'above', fields: [] } };
  for (const field of FormRender.iterFields(editing.form.fields)) prepareField(field);
  selectedId = null;
  document.getElementById('editor-title').textContent = form ? `「${form.title}」を編集` : '新しい入力ページ';
  document.getElementById('ed-title').value = editing.form.title;
  document.getElementById('ed-description').value = editing.form.description;
  document.getElementById('ed-pdf-border').checked = editing.form.pdfBorder;
  document.getElementById('ed-label-position').value = editing.form.labelPosition;
  document.getElementById('ed-help-position').value = editing.form.helpPosition;
  renderAll();
  editor.hidden = false;
  editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 種類に必要な設定をそろえる（以前に作った入力ページには幅などがない）
function prepareField(field) {
  if (!field.width) field.width = 12;
  if (field.label == null) field.label = '';
  if ((field.type === 'select' || field.type === 'checkboxes') && !field.options) field.options = [];
  if (field.type === 'checkboxes' && !field.direction) field.direction = 'vertical';
  if (field.type === 'file' && !field.maxFiles) field.maxFiles = 1;
  if (field.type === 'note' && !field.style) field.style = 'normal';
  if (field.type === 'group' && !field.children) field.children = [];
  if (field.type === 'page') { field.width = 12; field.newRow = true; }
  if (field.type === 'table') {
    if (!field.columns) field.columns = [{ id: 'c1', type: 'text', label: '', width: 1 }];
    if (!field.maxRows) field.maxRows = 10;
    for (const col of field.columns) if (!col.width) col.width = 1;
  }
}

function allIds() {
  return new Set([...FormRender.iterFields(editing.form.fields)].map((f) => f.id));
}

function newId(prefix, used) {
  let n = used.size + 1;
  while (used.has(`${prefix}${n}`)) n++;
  used.add(`${prefix}${n}`);
  return `${prefix}${n}`;
}

// 部品の場所（どの並びの何番目か。枠の中なら parent が枠）
function locate(id, list = editing.form.fields, parent = null) {
  for (const [index, field] of list.entries()) {
    if (field.id === id) return { list, index, field, parent };
    if (field.children) {
      const found = locate(id, field.children, field);
      if (found) return found;
    }
  }
  return null;
}

function hasMyNumber() {
  return [...FormRender.iterFields(editing.form.fields)].some((f) => f.type === 'mynumber'
    || (f.type === 'table' && f.columns.some((c) => c.type === 'mynumber')));
}

// マイナンバーの項目があるときは、暗号化を外せない
// マイナンバーやファイルの項目があるときは、暗号化を外せない（ファイルも暗号化して送るため）
function showEncryptNote() {
  const hasFile = [...FormRender.iterFields(editing.form.fields)].some((f) => f.type === 'file');
  const forced = hasMyNumber() || hasFile;
  if (forced) editing.form.encrypt = true;
  edEncrypt.checked = editing.form.encrypt;
  edEncrypt.disabled = forced;
  const note = document.getElementById('ed-encrypt-note');
  if (forced) note.textContent = `${hasMyNumber() ? 'マイナンバー' : 'ファイル'}の項目があるため、暗号化は外せません。`;
  else if (editing.form.encrypt) note.textContent = '入力内容は事務所の鍵でしか開けません。サーバーやドライブから漏れても読まれません。';
  else note.textContent = '暗号化しない場合、入力内容はドライブにそのまま保存されます。個人情報を含む入力ページでは暗号化してください。';
}

// --- 追加・移動・複製・削除 ---

// 選んでいる部品のうしろに追加する（枠を選んでいれば枠の中の最後、何も選んでいなければいちばん最後）
function addField(type) {
  const field = { id: newId('q', allIds()), type, label: '', help: '', required: false, width: DEFAULT_WIDTH[type] || 12 };
  prepareField(field);
  const at = selectedId && locate(selectedId);
  if (at && at.field.type === 'group' && !TOP_ONLY.includes(type)) at.field.children.push(field);
  else if (at && !(at.parent && TOP_ONLY.includes(type))) at.list.splice(at.index + 1, 0, field);
  else editing.form.fields.push(field);
  selectField(field.id);
  const first = props.querySelector('input:not([type=checkbox]), textarea');
  if (first) first.focus();
}

function moveField(id, list, index) {
  const from = locate(id);
  if (!from) return;
  from.list.splice(from.index, 1);
  // 同じ並びの中で後ろへ動かすときは、抜いた分だけ位置がずれる
  if (from.list === list && from.index < index) index--;
  list.splice(index, 0, from.field);
  renderAll();
}

function step(id, delta) {
  const at = locate(id);
  const to = at.index + delta;
  if (to < 0 || to >= at.list.length) return;
  at.list.splice(at.index, 1);
  at.list.splice(to, 0, at.field);
  renderAll();
}

function duplicate(id) {
  const at = locate(id);
  const used = allIds();
  const copy = structuredClone(at.field);
  for (const f of FormRender.iterFields([copy])) f.id = newId('q', used);
  at.list.splice(at.index + 1, 0, copy);
  selectField(copy.id);
}

function removeField(id) {
  const at = locate(id);
  at.list.splice(at.index, 1);
  selectedId = null;
  renderAll();
}

function selectField(id) {
  selectedId = id;
  renderAll();
}

// --- 表示 ---

function renderAll() {
  renderCanvas();
  renderProps();
  showEncryptNote();
}

function renderCanvas() {
  canvas.replaceChildren();
  FormRender.buildForm(canvas, editing.form.fields, { preview: true, decorate, layout: editing.form });
  document.getElementById('ed-canvas-empty').hidden = editing.form.fields.length > 0;
  // 空の枠にも落とせるようにする
  for (const grid of canvas.querySelectorAll('.f-group > .fgrid')) {
    const group = locate(grid.parentElement.dataset.id).field;
    dropTarget(grid, () => group.children, () => group.children.length, true);
  }
}

// 部品ごとに、選ぶ・ドラッグ・幅を変えるつまみを付ける
function decorate(e, field, list, index) {
  e.classList.add('ed-item');
  if (field.id === selectedId) e.classList.add('is-selected');
  e.tabIndex = 0;
  e.draggable = true;
  e.setAttribute('aria-label', `${TYPES[field.type]}：${field.label || '名前なし'}（${field.width}マス）`);

  const badge = document.createElement('span');
  badge.className = 'ed-badge';
  badge.textContent = field.type === 'page' ? TYPES.page : `${TYPES[field.type]}・${field.width}${field.newRow ? '・行の頭' : ''}`;
  e.prepend(badge);

  e.addEventListener('click', (event) => {
    event.stopPropagation();
    if (selectedId !== field.id) selectField(field.id);
  });
  e.addEventListener('keydown', (event) => {
    if (event.target === e && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      selectField(field.id);
    }
  });

  e.addEventListener('dragstart', (event) => {
    event.stopPropagation();
    draggingId = field.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', field.id);
    requestAnimationFrame(() => e.classList.add('is-dragging'));
  });
  e.addEventListener('dragend', () => {
    draggingId = null;
    e.classList.remove('is-dragging');
    clearDropMarks();
  });
  // 左半分に落とせば前、右半分なら後ろに入れる
  e.addEventListener('dragover', (event) => {
    if (!canDrop(list)) return;
    if (draggingId === field.id) return;
    event.preventDefault();
    event.stopPropagation();
    clearDropMarks();
    e.classList.add(isAfter(e, event) ? 'drop-after' : 'drop-before');
  });
  e.addEventListener('dragleave', () => e.classList.remove('drop-before', 'drop-after'));
  e.addEventListener('drop', (event) => {
    if (!canDrop(list) || draggingId === field.id) return;
    event.preventDefault();
    event.stopPropagation();
    const id = draggingId;
    moveField(id, list, list.indexOf(field) + (isAfter(e, event) ? 1 : 0));
  });

  // 右端のつまみで幅を変える（マス目に合わせる）。ページ区切りはいつも全幅
  if (field.type === 'page') return;
  const handle = document.createElement('span');
  handle.className = 'ed-resize';
  handle.title = '左右に動かして幅を変える';
  handle.addEventListener('pointerdown', (event) => startResize(event, e, field));
  handle.addEventListener('click', (event) => event.stopPropagation());
  e.append(handle);
}

function isAfter(e, event) {
  const rect = e.getBoundingClientRect();
  return event.clientX > rect.left + rect.width / 2;
}

// 枠とページ区切りは枠の中には入れられない。枠の中身ごと、自分の中にも入れられない
function canDrop(list) {
  if (!draggingId) return false;
  const dragged = locate(draggingId);
  if (!dragged) return false;
  if (TOP_ONLY.includes(dragged.field.type) && list !== editing.form.fields) return false;
  return true;
}

function dropTarget(grid, getList, getIndex, isGroup) {
  grid.addEventListener('dragover', (event) => {
    if (event.target !== grid || !canDrop(getList())) return;
    event.preventDefault();
    clearDropMarks();
    grid.classList.add('drop-inside');
  });
  grid.addEventListener('dragleave', (event) => {
    if (event.target === grid) grid.classList.remove('drop-inside');
  });
  grid.addEventListener('drop', (event) => {
    if (event.target !== grid || !canDrop(getList())) return;
    event.preventDefault();
    if (isGroup) event.stopPropagation();
    moveField(draggingId, getList(), getIndex());
  });
}

function clearDropMarks() {
  for (const e of canvas.querySelectorAll('.drop-before, .drop-after, .drop-inside')) {
    e.classList.remove('drop-before', 'drop-after', 'drop-inside');
  }
  canvas.classList.remove('drop-inside');
}

function startResize(event, e, field) {
  event.preventDefault();
  event.stopPropagation();
  const grid = e.parentElement;
  const style = getComputedStyle(grid);
  const gap = parseFloat(style.columnGap) || 0;
  const colStep = (grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + gap) / 12;
  const left = e.getBoundingClientRect().left;
  const handle = event.target;
  handle.setPointerCapture(event.pointerId);
  // つまみを動かしている間は、部品ごとドラッグして動かさない
  e.draggable = false;
  const move = (ev) => {
    const width = Math.max(1, Math.min(12, Math.round((ev.clientX - left + gap) / colStep)));
    if (width === field.width) return;
    field.width = width;
    e.style.setProperty('--w', width);
    e.querySelector('.ed-badge').textContent = `${TYPES[field.type]}・${width}${field.newRow ? '・行の頭' : ''}`;
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    selectedId = field.id;
    renderAll();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}

// --- 選んだ部品の設定 ---

function renderProps() {
  const at = selectedId && locate(selectedId);
  if (!at) {
    props.replaceChildren(propsHint());
    return;
  }
  const { field } = at;
  const items = [];
  const title = document.createElement('h3');
  title.textContent = `${TYPES[field.type]}の設定`;
  items.push(title);

  // 種類（枠の中では枠・ページ区切りにできない。中身のある枠は種類を変えられない）
  const types = { ...TYPES };
  if (at.parent) for (const t of TOP_ONLY) delete types[t];
  const type = select(types, field.type, '種類');
  type.disabled = field.type === 'group' && field.children.length > 0;
  type.addEventListener('change', () => changeType(field, type.value));
  items.push(propRow('種類', type));

  if (field.type === 'note') {
    const text = textArea(field.label, 4, '表示する文章', 2000);
    text.addEventListener('input', () => { field.label = text.value; renderCanvas(); });
    items.push(propRow('文章', text));
    const style = select(NOTE_STYLES, field.style, '文字の強さ');
    style.addEventListener('change', () => { field.style = style.value; renderCanvas(); });
    items.push(propRow('文字の強さ', style));
  } else if (field.type !== 'spacer') {
    const names = { heading: '見出しの文字', divider: '線の中の文字（任意）', group: '枠の名前（任意）', page: '次のページの見出し（任意）' };
    const label = input(field.label, names[field.type] || '項目名（例：氏名）', 200);
    label.addEventListener('input', () => { field.label = label.value; renderCanvas(); });
    items.push(propRow(names[field.type] || '項目名', label));
  }
  if (!['divider', 'spacer', 'note', 'page'].includes(field.type)) {
    const help = input(field.help || '', '説明（任意）：入力のしかたなど', 500);
    help.addEventListener('input', () => { field.help = help.value; renderCanvas(); });
    items.push(propRow('説明', help));
  }
  if (FormRender.isInput(field)) items.push(...positionEditor(field));

  // 並べ方（ページ区切りはいつも全幅）
  if (field.type === 'page') {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = '顧問先の画面では、ここで「次へ」のボタンになります。PDFもここで改ページします。';
    items.push(note);
  } else {
    const widths = Object.fromEntries(Object.entries(WIDTHS).sort((a, b) => b[0] - a[0]));
    const width = select(widths, String(field.width), '幅');
    width.addEventListener('change', () => { field.width = Number(width.value); renderCanvas(); });
    items.push(propRow('幅', width));
    items.push(checkLine('行の頭から置く（前の部品の右に並べない）', field.newRow, (checked) => {
      field.newRow = checked;
      renderCanvas();
    }));
  }

  if (FormRender.isInput(field)) {
    items.push(checkLine('必須にする', field.required, (checked) => { field.required = checked; renderCanvas(); }));
    items.push(checkLine('項目名を表示しない（CSVの列名とエラーの表示には使います）', Boolean(field.hideLabel), (checked) => {
      if (checked) field.hideLabel = true;
      else delete field.hideLabel;
      renderAll();
    }));
  }
  if (field.type === 'checkbox') {
    const text = input(field.checkText || '', '例：上記の内容に同意します（空なら「はい」）', 100);
    text.addEventListener('input', () => { field.checkText = text.value; renderCanvas(); });
    items.push(propRow('チェックの横の文言', text));
  }
  if (field.type === 'select' || field.type === 'checkboxes') items.push(propRow('選択肢（1行に1つ）', optionsEditor(field)));
  if (field.type === 'checkboxes') {
    items.push(checkLine('1つだけ選べるようにする（丸いボタンになります）', Boolean(field.single), (checked) => {
      if (checked) field.single = true;
      else delete field.single;
      renderCanvas();
    }));
    const direction = select(DIRECTIONS, field.direction, '選択肢の並べ方');
    direction.addEventListener('change', () => { field.direction = direction.value; renderCanvas(); });
    items.push(propRow('選択肢の並べ方', direction));
  }
  if (field.type === 'file') {
    const max = document.createElement('input');
    max.type = 'number';
    max.min = 1;
    max.max = 10;
    max.value = field.maxFiles;
    max.addEventListener('input', () => {
      field.maxFiles = Math.max(1, Math.min(10, Number(max.value) || 1));
      renderCanvas();
    });
    items.push(propRow('送れるファイルの数（1〜10）', max));
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'ファイルは顧問先の画面で暗号化して、その顧問先のドライブのフォルダに送ります。開くときは「届いた内容」で鍵を読み込んで取り出します。';
    items.push(note);
  }
  if (field.type === 'table') items.push(...tableEditor(field));

  const ops = document.createElement('div');
  ops.className = 'ed-props-ops';
  const prev = button('← 前へ', () => step(field.id, -1), 'button-outline');
  prev.disabled = at.index === 0;
  const next = button('後へ →', () => step(field.id, 1), 'button-outline');
  next.disabled = at.index === at.list.length - 1;
  ops.append(prev, next, button('複製', () => duplicate(field.id), 'button-outline'),
    button('削除', () => removeField(field.id), 'button-danger'));
  if (field.type === 'group' && field.children.length) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = '枠を削除すると、中の部品も削除されます。';
    items.push(note);
  }
  items.push(ops);
  props.replaceChildren(...items);
}

function propsHint() {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = '左の部品を押すと、ここで設定を変えられます。上のボタンで部品を追加します（選んでいる部品のうしろ、枠を選んでいれば枠の中に入ります）。';
  return p;
}

function propRow(labelText, control) {
  const row = document.createElement('label');
  row.className = 'ed-prop';
  const span = document.createElement('span');
  span.textContent = labelText;
  row.append(span, control);
  return row;
}

function textArea(value, rows, label, maxLength) {
  const area = document.createElement('textarea');
  area.rows = rows;
  area.value = value;
  area.maxLength = maxLength;
  area.setAttribute('aria-label', label);
  return area;
}

function changeType(field, type) {
  field.type = type;
  if (type !== 'select' && type !== 'checkboxes') delete field.options;
  if (type !== 'checkboxes') { delete field.direction; delete field.single; }
  if (type !== 'file') delete field.maxFiles;
  if (type !== 'table') { delete field.columns; delete field.maxRows; delete field.rowLabels; }
  if (type !== 'note') delete field.style;
  if (type !== 'checkbox') delete field.checkText;
  if (!FormRender.isInput(field)) delete field.hideLabel;
  if (type !== 'group') delete field.children;
  if (!FormRender.isInput(field)) field.required = false;
  if (!FormRender.isInput(field) || type === 'table') delete field.labelPosition;
  if (!FormRender.canHelpInside(type)) delete field.helpPosition;
  prepareField(field);
  renderAll();
}

// 項目名・説明の位置（空＝入力ページの設定どおり）。表の項目名はいつも上、説明を中に出せない種類もある
const LABEL_POSITIONS = { top: '上', side: '横' };
const HELP_POSITIONS = { above: '入力欄の上', inside: '入力欄の中' };

function positionEditor(field) {
  const items = [];
  const choice = (key, names, label) => {
    const control = select({ '': `入力ページの設定どおり（${names[editing.form[key]]}）`, ...names }, field[key] || '', label);
    control.addEventListener('change', () => {
      if (control.value) field[key] = control.value;
      else delete field[key];
      renderCanvas();
    });
    items.push(propRow(label, control));
  };
  if (field.type !== 'table' && !field.hideLabel) choice('labelPosition', LABEL_POSITIONS, '項目名の位置');
  if (FormRender.canHelpInside(field.type)) choice('helpPosition', HELP_POSITIONS, '説明の位置');
  return items;
}

function optionsEditor(field) {
  const area = textArea(field.options.join('\n'), 4, '選択肢', 5000);
  area.placeholder = '例：\n甲欄\n乙欄';
  area.addEventListener('input', () => {
    field.options = area.value.split('\n').map((s) => s.trim()).filter(Boolean);
    renderCanvas();
  });
  return area;
}

function tableEditor(field) {
  const items = [];
  const fixed = Array.isArray(field.rowLabels);
  const mode = select({ add: '行を追加できる（扶養家族など）', fixed: '行が決まっている（1月〜12月など）' },
    fixed ? 'fixed' : 'add', '表の形式');
  mode.addEventListener('change', () => {
    if (mode.value === 'fixed') field.rowLabels = Array.from({ length: Math.min(field.maxRows, 12) }, (_, i) => `${i + 1}`);
    else { delete field.rowLabels; delete field.rowLabelWidth; }
    renderAll();
  });
  items.push(propRow('表の形式', mode));

  if (fixed) {
    const labels = textArea(field.rowLabels.join('\n'), 6, '行の名前', 5000);
    labels.placeholder = '例：\n1月\n2月\n3月';
    labels.addEventListener('input', () => {
      field.rowLabels = labels.value.split('\n').map((s) => s.trim()).filter(Boolean);
      field.maxRows = Math.max(1, field.rowLabels.length);
      renderCanvas();
    });
    items.push(propRow('行の名前（1行に1つ・50行まで）', labels));
    // 行の名前の列の幅（空なら表の15%。数字を選ぶと、下の列の幅と同じ比で決まる）
    const widths = { '': '自動（表の15%）', ...Object.fromEntries(Array.from({ length: 10 }, (_, n) => [n + 1, `幅${n + 1}`])) };
    const labelWidth = select(widths, String(field.rowLabelWidth || ''), '行の名前の列の幅');
    labelWidth.addEventListener('change', () => {
      if (labelWidth.value) field.rowLabelWidth = Number(labelWidth.value);
      else delete field.rowLabelWidth;
      renderCanvas();
    });
    items.push(propRow('行の名前の列の幅（列の幅と同じ比）', labelWidth));
  } else {
    const max = document.createElement('input');
    max.type = 'number';
    max.min = 1;
    max.max = 50;
    max.value = field.maxRows;
    max.addEventListener('input', () => { field.maxRows = Number(max.value); });
    items.push(propRow('最大の行数', max));
  }

  const box = document.createElement('div');
  box.className = 'ed-columns';
  const head = document.createElement('p');
  head.className = 'ed-small';
  head.textContent = '列（名前・種類・幅の比・合計）';
  box.append(head);
  field.columns.forEach((col, i) => {
    const row = document.createElement('div');
    row.className = 'ed-column';
    const name = input(col.label, '列名（例：続柄）', 100);
    name.addEventListener('input', () => { col.label = name.value; renderCanvas(); });
    const type = select(COLUMN_TYPES, col.type, '列の種類');
    type.addEventListener('change', () => {
      col.type = type.value;
      if (col.type !== 'number') col.sum = false;
      if (col.type === 'select') col.options = col.options || [];
      else delete col.options;
      renderAll();
    });
    const width = select(Object.fromEntries(Array.from({ length: 10 }, (_, n) => [n + 1, `幅${n + 1}`])), String(col.width), '列の幅');
    width.addEventListener('change', () => { col.width = Number(width.value); renderCanvas(); });
    const sum = checkLine('合計', Boolean(col.sum), (checked) => { col.sum = checked; renderCanvas(); });
    sum.querySelector('input').disabled = col.type !== 'number';
    sum.title = '数字・金額の列だけ、表の下に合計を出せます';
    const remove = button('×', () => { field.columns.splice(i, 1); renderAll(); }, 'button-outline');
    remove.setAttribute('aria-label', '列を削除');
    remove.disabled = field.columns.length === 1;
    // 列の順番を入れ替える（↑で左へ、↓で右へ）
    const moveColumn = (to) => {
      field.columns.splice(to, 0, field.columns.splice(i, 1)[0]);
      renderAll();
    };
    const up = button('↑', () => moveColumn(i - 1), 'button-outline');
    up.setAttribute('aria-label', '列を前（左）へ');
    up.disabled = i === 0;
    const down = button('↓', () => moveColumn(i + 1), 'button-outline');
    down.setAttribute('aria-label', '列を後ろ（右）へ');
    down.disabled = i === field.columns.length - 1;
    const ops = document.createElement('div');
    ops.className = 'ed-column-ops';
    ops.append(up, down, remove);
    row.append(name, type, width, sum, ops);
    // 選択肢の列は、選択肢を1行に1つ書く
    if (col.type === 'select') {
      const options = textArea((col.options || []).join('\n'), 3, `${col.label || '列'}の選択肢`, 5000);
      options.placeholder = '選択肢（1行に1つ）\n例：\n配偶者\n子';
      options.className = 'ed-column-options';
      options.addEventListener('input', () => {
        col.options = options.value.split('\n').map((s) => s.trim()).filter(Boolean);
        renderCanvas();
      });
      row.append(options);
    }
    box.append(row);
  });
  const add = button('列を追加', () => {
    const used = new Set(field.columns.map((c) => c.id));
    field.columns.push({ id: newId('c', used), type: 'text', label: '', width: 1 });
    renderAll();
  }, 'button-outline');
  add.disabled = field.columns.length >= 20;
  box.append(add);
  items.push(box);
  return items;
}
