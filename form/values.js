// 入力欄の値の読み取り・確認・書き戻し（顧問先の入力画面・事務所用の入力画面・顧客台帳の編集で共通）
// 全角の数字や記号は半角にそろえ、前後の空白を取ってから確かめる。controls は render.js の buildForm が返すもの
const FormValues = (() => {
  function inputValue(c) {
    if (c.field.type === 'checkbox') return c.input.checkbox.checked;
    if (c.field.type === 'checkboxes') return c.input.checks.filter((x) => x.checked).map((x) => x.value);
    if (c.field.type === 'file') return Array.from(c.input.files);
    const value = normalize(c.field.type, c.input.value);
    if (c.input.tagName !== 'SELECT') c.input.value = value;
    return value;
  }

  function tableValue(c) {
    for (const input of c.body.querySelectorAll('[data-col]')) {
      const col = c.field.columns.find((x) => x.id === input.dataset.col);
      if (col.type !== 'checkbox') input.value = normalize(col.type, input.value);
    }
    return FormRender.tableRows(c);
  }

  // 全角の数字や記号を半角にし、前後の空白を取る
  function normalize(type, value) {
    let v = value.trim();
    if (['number', 'tel', 'zip', 'mynumber'].includes(type)) {
      v = v.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
        .replace(/[－ー―‐]/g, '-').replace(/[，]/g, ',').replace(/[．]/g, '.');
    }
    if (type === 'mynumber') v = v.replace(/[\s-]/g, '');
    return v;
  }

  function check(field, value) {
    if (field.type === 'table') {
      if (field.required && value.length === 0) return '1行以上入力してください';
      for (const [i, row] of value.entries()) {
        for (const col of field.columns) {
          const message = checkValue(col.type, row[col.id]);
          const rowName = field.rowLabels ? field.rowLabels[i] : `${i + 1}行目`;
          if (message) return `${rowName}の「${col.label}」：${message}`;
        }
      }
      return '';
    }
    if (field.type === 'checkboxes') return field.required && !value.length ? `${field.single ? '1つ' : '1つ以上'}選んでください` : '';
    if (field.type === 'file') return checkFiles(field, value);
    if (field.required && (value === '' || value === false)) {
      return field.type === 'checkbox' ? '確認のうえ、チェックを入れてください' : '入力してください';
    }
    return field.type === 'checkbox' ? '' : checkValue(field.type, value);
  }

  const FILE_EXTS = ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'xlsx', 'xls', 'docx', 'doc', 'csv'];
  const MAX_FILE_SIZE = 50 * 1024 * 1024;

  function checkFiles(field, files) {
    if (field.required && !files.length) return 'ファイルを選んでください';
    if (files.length > field.maxFiles) return `ファイルは${field.maxFiles}個まで選べます`;
    for (const file of files) {
      const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
      if (!FILE_EXTS.includes(ext)) return `「${file.name}」は送れない種類のファイルです`;
      if (file.size === 0) return `「${file.name}」は空のファイルです`;
      if (file.size > MAX_FILE_SIZE) return `「${file.name}」は50MBを超えています`;
    }
    return '';
  }

  function checkValue(type, value) {
    if (!value) return '';
    if (type === 'mynumber' && !isMyNumber(value)) return 'マイナンバー（12桁）が正しくありません';
    if (type === 'number' && !/^-?[\d,]+(\.\d+)?$/.test(value)) return '数字で入力してください';
    if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'メールアドレスが正しくありません';
    if (type === 'zip' && !/^\d{3}-?\d{4}$/.test(value)) return '郵便番号（7桁）が正しくありません';
    if (type === 'tel' && !/^[\d+()-]{10,15}$/.test(value)) return '電話番号が正しくありません';
    return '';
  }

  // マイナンバーの検査用数字（12桁目）を確かめる
  function isMyNumber(value) {
    if (!/^\d{12}$/.test(value)) return false;
    let sum = 0;
    for (let n = 1; n <= 11; n++) {
      const p = Number(value[11 - n]);
      const q = n <= 6 ? n + 1 : n - 5;
      sum += p * q;
    }
    const rest = sum % 11;
    return Number(value[11]) === (rest <= 1 ? 0 : 11 - rest);
  }

  // 入力欄に値を戻す（途中保存や、顧客台帳を開いたとき）。skipMyNumber ならマイナンバーは戻さない
  function fill(c, value, { skipMyNumber = false } = {}) {
    if (value == null || c.field.type === 'file' || (skipMyNumber && c.field.type === 'mynumber')) return;
    if (c.field.type === 'checkbox') {
      c.input.checkbox.checked = value === true;
    } else if (c.field.type === 'checkboxes') {
      if (Array.isArray(value)) for (const x of c.input.checks) x.checked = value.includes(x.value);
    } else if (c.field.type === 'table') {
      if (!Array.isArray(value)) return;
      if (!c.fixed) {
        while (c.body.rows.length < Math.min(value.length, c.field.maxRows)) c.add.click();
      }
      [...c.body.rows].forEach((tr, i) => {
        for (const input of tr.querySelectorAll('[data-col]')) {
          const col = c.field.columns.find((x) => x.id === input.dataset.col);
          if (!(skipMyNumber && col.type === 'mynumber')) FormRender.setCellValue(input, (value[i] || {})[col.id] || '');
        }
      });
      if (c.updateSum) c.updateSum(FormRender.tableRows(c, true));
    } else {
      c.input.value = String(value);
    }
  }

  // 入力欄の今の値（表は行の一覧）
  function read(c) {
    return c.field.type === 'table' ? tableValue(c) : inputValue(c);
  }

  return { read, check, fill, isMyNumber };
})();
