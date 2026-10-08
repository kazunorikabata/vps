// 入力ページの部品の表示（顧問先の入力画面・PDF・事務所内ページの作成画面と確認画面で共通）
// 横12マスのマス目に、部品ごとの幅（width）で並べる。newRow の部品は行の頭から置く。
// スマホなど幅の狭い画面では、すべて縦1列になる（layout.css）
// ページ区切り（page）があれば、顧問先の画面は1ページずつ進み、PDF もそこで改ページする
const FormRender = (() => {
  const LAYOUT_TYPES = new Set(['heading', 'divider', 'note', 'spacer', 'group', 'page']);
  // 説明を入力欄の中（薄い文字）に出せる種類
  const PLACEHOLDER_TYPES = new Set(['text', 'textarea', 'number', 'tel', 'email', 'zip', 'mynumber']);
  // 添付ファイルで送れる種類（資料アップロードと同じ）
  const FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.xlsx,.xls,.docx,.doc,.csv';
  const INPUTS = {
    text: { type: 'text' },
    number: { type: 'text', inputMode: 'decimal' },
    date: { type: 'date' },
    tel: { type: 'tel', autocomplete: 'tel' },
    email: { type: 'email', autocomplete: 'email' },
    zip: { type: 'text', inputMode: 'numeric', placeholder: '例：273-0021', autocomplete: 'postal-code' },
    mynumber: { type: 'text', inputMode: 'numeric', maxLength: 14, placeholder: '12桁の数字', autocomplete: 'off' },
  };

  function isInput(field) {
    return !LAYOUT_TYPES.has(field.type);
  }

  // 枠の中の項目も含めて、すべての項目を順に返す
  function* iterFields(fields) {
    for (const f of fields) {
      yield f;
      if (f.children) yield* f.children;
    }
  }

  // ページ区切りで分けた [{ title, fields }]。区切りの名前は次のページの見出し。中身のないページは作らない
  function splitPages(fields) {
    const pages = [];
    let current = { title: '', fields: [] };
    for (const f of fields) {
      if (f.type !== 'page') {
        current.fields.push(f);
        continue;
      }
      if (current.fields.length) pages.push(current);
      current = { title: f.label || '', fields: [] };
    }
    if (current.fields.length || !pages.length) pages.push(current);
    return pages;
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function place(e, field) {
    e.style.setProperty('--w', field.width || 12);
    if (field.newRow) e.classList.add('is-new-row');
    e.dataset.id = field.id;
    return e;
  }

  // 「1,234」「１２３」なども数として読む。数でなければ null
  function parseNumber(value) {
    const v = String(value || '').replace(/[０-９．－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[,，\s]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
    return Number(v);
  }

  function formatNumber(n) {
    return n.toLocaleString('ja-JP', { maximumFractionDigits: 10 });
  }

  function sums(field, rows) {
    const result = {};
    for (const col of field.columns) {
      if (!col.sum) continue;
      result[col.id] = rows.reduce((total, row) => total + (parseNumber(row[col.id]) || 0), 0);
    }
    return result;
  }

  function hasSum(field) {
    return field.columns.some((c) => c.sum);
  }

  // 入力欄のない部品
  function layoutItem(field, buildChildren) {
    if (field.type === 'heading') {
      const box = el('div', 'f-heading-box');
      box.append(el('h2', 'f-heading', field.label));
      if (field.help) box.append(el('p', 'f-help', field.help));
      return box;
    }
    if (field.type === 'divider') {
      const box = el('div', 'f-divider');
      if (field.label) box.append(el('span', '', field.label));
      return box;
    }
    if (field.type === 'note') return el('p', `f-note is-${field.style || 'normal'}`, field.label);
    if (field.type === 'spacer') return el('div', 'f-spacer');
    // ページ区切り（作成画面で、どこでページが変わるかを見せる）
    if (field.type === 'page') return el('div', 'f-pagebreak', `ここから次のページ${field.label ? `：${field.label}` : ''}`);
    // 枠（グループ）：中にもマス目を作る
    const box = el('fieldset', 'f-group');
    if (field.label) box.append(el('legend', '', field.label));
    if (field.help) box.append(el('p', 'f-help', field.help));
    const grid = el('div', 'fgrid');
    box.append(grid);
    buildChildren(grid, field.children || []);
    return box;
  }

  // layout は入力ページの設定 { labelPosition: 'top'|'side', helpPosition: 'above'|'inside' }。
  // 項目に同じ名前の設定があれば、そちらを使う。表の項目名はいつも上
  function labelSide(field, layout = {}) {
    return field.type !== 'table' && !field.hideLabel && (field.labelPosition || layout.labelPosition) === 'side';
  }

  function canHelpInside(type) {
    return PLACEHOLDER_TYPES.has(type);
  }

  function helpInside(field, layout = {}) {
    return Boolean(field.help) && canHelpInside(field.type) && (field.helpPosition || layout.helpPosition) === 'inside';
  }

  // 項目名を横にするときは、入力欄・説明・エラーを右側の body にまとめる。
  // hideLabel の項目は項目名を見せない（読み上げには使う）。必須の印は残す
  function fieldBox(field, layout) {
    const box = el('div', 'f-field');
    const label = el(field.type === 'table' ? 'p' : 'label', 'f-label');
    label.append(el('span', field.hideLabel ? 'visually-hidden' : '', field.label));
    if (!['table', 'checkbox', 'checkboxes'].includes(field.type)) label.htmlFor = `field-${field.id}`;
    if (field.required) label.append(' ', el('span', 'required-mark', '必須'));
    else if (field.hideLabel) label.classList.add('visually-hidden');
    box.append(label);
    let body = box;
    if (labelSide(field, layout)) {
      box.classList.add('is-side');
      body = box.appendChild(el('div', 'f-body'));
    }
    if (field.help && !helpInside(field, layout)) body.append(el('p', 'f-help', field.help));
    return { box, body };
  }

  // withRemove：行を消す「×」の列を右端に付ける（行を追加できる表の入力画面）
  function tableHead(field, table, withRemove = false) {
    const colgroup = el('colgroup');
    // 列の幅は、ほかの列との比で割り振る（行の名前の列は 15%、「×」の列は 8%）
    const room = 100 - (field.rowLabels ? 15 : 0) - (withRemove ? 8 : 0);
    if (field.rowLabels) colgroup.appendChild(el('col')).style.width = '15%';
    const total = field.columns.reduce((t, c) => t + (c.width || 1), 0);
    for (const col of field.columns) {
      const c = el('col');
      c.style.width = `${((col.width || 1) / total) * room}%`;
      colgroup.append(c);
    }
    if (withRemove) colgroup.appendChild(el('col')).style.width = '8%';
    table.append(colgroup);
    const head = table.createTHead().insertRow();
    if (field.rowLabels) head.append(el('th', 'f-rowlabel-head'));
    for (const col of field.columns) head.append(el('th', '', col.label));
    if (withRemove) head.append(el('th'));
  }

  function sumRow(field, table, withRemove = false) {
    if (!hasSum(field)) return null;
    const tr = table.createTFoot().insertRow();
    tr.className = 'f-sum';
    if (field.rowLabels) tr.append(el('th', '', '合計'));
    const cells = {};
    field.columns.forEach((col, i) => {
      const td = tr.insertCell();
      if (col.sum) cells[col.id] = td;
      else if (i === 0 && !field.rowLabels) td.textContent = '合計';
    });
    if (withRemove) tr.insertCell();
    return (rows) => {
      const s = sums(field, rows);
      for (const [id, td] of Object.entries(cells)) td.textContent = formatNumber(s[id]);
    };
  }

  // --- 入力欄つきの表示 ---

  // controls（入力欄の一覧）を返す。preview なら入力できない見本として作る（作成画面用）。
  // decorate(e, field, list, index) は、部品ごとの要素に手を加えるためのもの（作成画面でドラッグなどを付ける）
  function buildForm(container, fields, { preview = false, decorate, layout } = {}) {
    const controls = [];
    const build = (grid, list) => {
      list.forEach((field, index) => {
        let e;
        if (isInput(field)) {
          const control = inputItem(field, preview, layout);
          controls.push(control);
          e = control.box;
        } else {
          e = layoutItem(field, build);
        }
        place(e, field);
        if (decorate) decorate(e, field, list, index);
        grid.append(e);
      });
    };
    container.classList.add('fgrid');
    build(container, fields);
    return controls;
  }

  function inputItem(field, preview, layout) {
    const { box, body } = fieldBox(field, layout);
    const error = el('p', 'f-error');
    error.hidden = true;
    let control;
    if (field.type === 'table') {
      control = tableInput(field, body, preview);
    } else {
      const input = createInput(field);
      if (helpInside(field, layout)) input.placeholder = field.help;
      if (preview) for (const e of [input, ...input.querySelectorAll('input')]) e.disabled = true;
      body.append(input);
      if (field.type === 'file') {
        body.append(el('p', 'f-help', `PDF・画像（JPG・PNG・HEIC）・Excel・Word・CSV、1つ50MBまで、${field.maxFiles}個まで選べます。`));
      }
      control = { field, input };
    }
    body.append(error);
    return { ...control, box, error };
  }

  function createInput(field) {
    const id = `field-${field.id}`;
    if (field.type === 'checkbox') {
      const wrap = el('label', 'f-check');
      const input = el('input');
      input.type = 'checkbox';
      input.id = id;
      wrap.append(input, ' ', checkText(field));
      wrap.checkbox = input;
      return wrap;
    }
    // 複数チェック：選択肢ごとにチェックを並べる（checks に一覧）。
    // single なら丸いボタン（1つだけ選べる）。選んだものをもう一度押すと外せる
    if (field.type === 'checkboxes') {
      const wrap = el('div', `f-checks${field.direction === 'horizontal' ? ' is-horizontal' : ''}`);
      wrap.id = id;
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', field.label);
      wrap.checks = field.options.map((option) => {
        const label = el('label', 'f-check');
        const input = el('input');
        input.type = field.single ? 'radio' : 'checkbox';
        input.value = option;
        if (field.single) {
          input.name = id;
          label.addEventListener('pointerdown', () => { input.wasChecked = input.checked; });
          input.addEventListener('click', () => {
            if (input.wasChecked) input.checked = false;
            input.wasChecked = false;
          });
        }
        label.append(input, ' ', option);
        wrap.append(label);
        return input;
      });
      return wrap;
    }
    let input;
    if (field.type === 'file') {
      input = el('input');
      input.type = 'file';
      input.accept = FILE_ACCEPT;
      input.multiple = field.maxFiles > 1;
      input.id = id;
      input.className = 'f-file';
      return input;
    }
    if (field.type === 'textarea') {
      input = el('textarea');
      input.rows = 4;
    } else if (field.type === 'select') {
      input = el('select');
      input.append(new Option('選択してください', ''));
      for (const option of field.options) input.append(new Option(option, option));
    } else {
      input = el('input');
      Object.assign(input, INPUTS[field.type] || INPUTS.text);
    }
    input.id = id;
    input.className = 'f-input';
    return input;
  }

  function tableInput(field, box, preview) {
    const wrap = el('div', 'table-wrap');
    const table = el('table', 'f-table');
    tableHead(field, table, !field.rowLabels);
    const body = table.createTBody();
    const updateSum = sumRow(field, table, !field.rowLabels);
    wrap.append(table);
    box.append(wrap);
    const control = { field, body, fixed: Boolean(field.rowLabels), updateSum };
    if (field.rowLabels) {
      for (const rowLabel of field.rowLabels) addRow(control, preview, rowLabel);
    } else {
      const add = el('button', 'row-button', '＋ 行を追加');
      add.type = 'button';
      add.disabled = preview;
      control.add = add;
      add.addEventListener('click', () => addRow(control, preview));
      box.append(add);
      addRow(control, preview);
    }
    if (updateSum) {
      body.addEventListener('input', () => updateSum(tableRows(control, true)));
      updateSum([]);
    }
    return control;
  }

  function addRow(control, preview, rowLabel) {
    const { field, body, add } = control;
    const tr = body.insertRow();
    if (rowLabel != null) tr.append(el('th', 'f-rowlabel', rowLabel));
    for (const col of field.columns) {
      let input;
      if (col.type === 'select') {
        // 選択肢の列：マスごとにプルダウン
        input = el('select', 'f-input');
        input.append(new Option('選択', ''));
        for (const option of col.options || []) input.append(new Option(option, option));
      } else if (col.type === 'checkbox') {
        input = el('input');
        input.type = 'checkbox';
        input.className = 'f-cell-check';
      } else {
        input = el('input');
        Object.assign(input, INPUTS[col.type] || INPUTS.text);
        input.className = 'f-input';
      }
      input.dataset.col = col.id;
      input.disabled = preview;
      input.setAttribute('aria-label', rowLabel ? `${rowLabel} ${col.label}` : col.label);
      tr.insertCell().append(input);
    }
    if (!control.fixed) {
      const remove = el('button', 'row-remove', '×');
      remove.type = 'button';
      remove.disabled = preview;
      remove.setAttribute('aria-label', 'この行を削除');
      remove.addEventListener('click', () => {
        tr.remove();
        if (body.rows.length === 0) addRow(control, preview);
        add.hidden = body.rows.length >= field.maxRows;
        if (control.updateSum) control.updateSum(tableRows(control, true));
      });
      tr.insertCell().append(remove);
      add.hidden = body.rows.length >= field.maxRows;
    }
  }

  // 表のマスの値。チェックの列は、入っていれば「はい」、なければ空（ほかの列と同じく文字で残す）
  function cellValue(input) {
    if (input.type === 'checkbox') return input.checked ? 'はい' : '';
    return input.value;
  }

  function setCellValue(input, value) {
    if (input.type === 'checkbox') input.checked = value === 'はい';
    else input.value = value;
  }

  // 表の入力内容。行数が決まった表は、行の名前とずれないように空の行も残す（すべて空なら []）
  function tableRows(control, keepEmpty = control.fixed) {
    const rows = [];
    let any = false;
    for (const tr of control.body.rows) {
      const row = {};
      let filled = false;
      for (const input of tr.querySelectorAll('[data-col]')) {
        row[input.dataset.col] = cellValue(input);
        if (row[input.dataset.col]) filled = true;
      }
      if (filled) any = true;
      if (filled || keepEmpty) rows.push(row);
    }
    return any ? rows : [];
  }

  // --- 読むだけの表示（PDF と、事務所内ページで届いた内容を見るとき） ---

  // ページ区切りがあれば、ページごとに見出しを付けて分ける（PDF ではページごとに改ページ）
  // options.fileButton(file) があれば、添付ファイルの名前の横に置く（事務所内ページで取り出すボタン）
  function buildView(container, fields, answers, layout = {}, options = {}) {
    const pages = splitPages(fields);
    if (pages.length === 1) {
      viewGrid(container, pages[0].fields, answers, layout, options);
      return;
    }
    container.replaceChildren(...pages.map((page, i) => {
      const section = el('section', 'f-page');
      section.append(el('h2', 'f-page-title', `${i + 1} / ${pages.length}${page.title ? `　${page.title}` : ''}`));
      const grid = el('div');
      viewGrid(grid, page.fields, answers, layout, options);
      section.append(grid);
      return section;
    }));
  }

  function viewGrid(container, fields, answers, layout, options = {}) {
    const build = (grid, list) => {
      for (const field of list) {
        let e;
        if (!isInput(field)) {
          e = layoutItem(field, build);
        } else {
          e = el('div', 'f-field is-view');
          if (labelSide(field, layout)) e.classList.add('is-side');
          e.append(el('p', `f-label${field.hideLabel ? ' visually-hidden' : ''}`, field.label));
          const value = answers[field.id];
          if (field.type === 'table') e.append(viewTable(field, value || []));
          else if (field.type === 'file' && options.fileButton && (value || []).length) e.append(viewFiles(value, options.fileButton));
          else e.append(el('p', 'f-value', displayValue(field, value) || '—'));
        }
        grid.append(place(e, field));
      }
    };
    container.classList.add('fgrid');
    build(container, fields);
  }

  function viewFiles(files, fileButton) {
    const list = el('ul', 'f-files');
    for (const file of files) {
      const li = el('li', '', `${file.name}（${formatSize(file.size)}）`);
      li.append(' ', fileButton(file));
      list.append(li);
    }
    return list;
  }

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  function viewTable(field, rows) {
    if (!rows.length && !field.rowLabels) return el('p', 'f-value', '—');
    const wrap = el('div', 'table-wrap');
    const table = el('table', 'f-table');
    tableHead(field, table);
    const body = table.createTBody();
    const count = field.rowLabels ? field.rowLabels.length : rows.length;
    for (let i = 0; i < count; i++) {
      const tr = body.insertRow();
      if (field.rowLabels) tr.append(el('th', 'f-rowlabel', field.rowLabels[i]));
      for (const col of field.columns) tr.insertCell().textContent = (rows[i] || {})[col.id] || '';
    }
    const updateSum = sumRow(field, table);
    if (updateSum) updateSum(rows);
    wrap.append(table);
    return wrap;
  }

  // チェックの横の文言（事務所で決める。空なら「はい」）
  function checkText(field) {
    return field.checkText || 'はい';
  }

  function displayValue(field, value) {
    if (field.type === 'checkbox') return value ? checkText(field) : '';
    if (field.type === 'checkboxes') return Array.isArray(value) ? value.join('、') : '';
    if (field.type === 'file') return Array.isArray(value) ? value.map((f) => f.name).join('、') : '';
    return value == null ? '' : String(value);
  }

  return { isInput, iterFields, splitPages, canHelpInside, buildForm, buildView, tableRows, setCellValue, formatSize, sums, parseNumber, formatNumber, displayValue };
})();
