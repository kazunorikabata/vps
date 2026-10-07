// 入力ページの部品の表示（顧問先の入力画面・PDF・事務所内ページの作成画面と確認画面で共通）
// 横12マスのマス目に、部品ごとの幅（width）で並べる。newRow の部品は行の頭から置く。
// スマホなど幅の狭い画面では、すべて縦1列になる（layout.css）
const FormRender = (() => {
  const LAYOUT_TYPES = new Set(['heading', 'divider', 'note', 'spacer', 'group']);
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
    // 枠（グループ）：中にもマス目を作る
    const box = el('fieldset', 'f-group');
    if (field.label) box.append(el('legend', '', field.label));
    if (field.help) box.append(el('p', 'f-help', field.help));
    const grid = el('div', 'fgrid');
    box.append(grid);
    buildChildren(grid, field.children || []);
    return box;
  }

  function fieldBox(field) {
    const box = el('div', 'f-field');
    const label = el(field.type === 'table' ? 'p' : 'label', 'f-label', field.label);
    if (field.type !== 'table' && field.type !== 'checkbox') label.htmlFor = `field-${field.id}`;
    if (field.required) label.append(' ', el('span', 'required-mark', '必須'));
    box.append(label);
    if (field.help) box.append(el('p', 'f-help', field.help));
    return box;
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
  function buildForm(container, fields, { preview = false, decorate } = {}) {
    const controls = [];
    const build = (grid, list) => {
      list.forEach((field, index) => {
        let e;
        if (isInput(field)) {
          const control = inputItem(field, preview);
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

  function inputItem(field, preview) {
    const box = fieldBox(field);
    const error = el('p', 'f-error');
    error.hidden = true;
    let control;
    if (field.type === 'table') {
      control = tableInput(field, box, preview);
    } else {
      const input = createInput(field);
      if (preview) (input.checkbox || input).disabled = true;
      box.append(input);
      control = { field, input };
    }
    box.append(error);
    return { ...control, box, error };
  }

  function createInput(field) {
    const id = `field-${field.id}`;
    if (field.type === 'checkbox') {
      const wrap = el('label', 'f-check');
      const input = el('input');
      input.type = 'checkbox';
      input.id = id;
      wrap.append(input, ' はい');
      wrap.checkbox = input;
      return wrap;
    }
    let input;
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
      const input = el('input');
      Object.assign(input, INPUTS[col.type] || INPUTS.text);
      input.className = 'f-input';
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

  // 表の入力内容。行数が決まった表は、行の名前とずれないように空の行も残す（すべて空なら []）
  function tableRows(control, keepEmpty = control.fixed) {
    const rows = [];
    let any = false;
    for (const tr of control.body.rows) {
      const row = {};
      let filled = false;
      for (const input of tr.querySelectorAll('input[data-col]')) {
        row[input.dataset.col] = input.value;
        if (input.value) filled = true;
      }
      if (filled) any = true;
      if (filled || keepEmpty) rows.push(row);
    }
    return any ? rows : [];
  }

  // --- 読むだけの表示（PDF と、事務所内ページで届いた内容を見るとき） ---

  function buildView(container, fields, answers) {
    const build = (grid, list) => {
      for (const field of list) {
        let e;
        if (!isInput(field)) {
          e = layoutItem(field, build);
        } else {
          e = el('div', 'f-field is-view');
          e.append(el('p', 'f-label', field.label));
          const value = answers[field.id];
          if (field.type === 'table') e.append(viewTable(field, value || []));
          else e.append(el('p', 'f-value', displayValue(field, value) || '—'));
        }
        grid.append(place(e, field));
      }
    };
    container.classList.add('fgrid');
    build(container, fields);
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

  function displayValue(field, value) {
    if (field.type === 'checkbox') return value ? 'はい' : '';
    return value == null ? '' : String(value);
  }

  return { isInput, iterFields, buildForm, buildView, tableRows, sums, parseNumber, formatNumber, displayValue };
})();
