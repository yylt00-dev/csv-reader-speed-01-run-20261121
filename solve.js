// Swift CSV — a fast drop-in replacement for csv-reader 1.0.0.
//
// Written from scratch in this session from the csv-reader 1.0.0 policy
// (RULES.txt): read the text once, left to right, and return exactly the
// answer csv-reader returns for {text, header} as {columns, rows, errors}.
//
// Speed strategy: never walk the text one character at a time. Unquoted
// fields end at the nearest of ',', LF or CR, found with String indexOf
// (C++ memchr-speed scans) instead of a per-character loop; quoted fields
// find their closing quote with one indexOf and slice whole spans at once.
// The slow character-wise work only runs on the rare broken bits (stray
// CRs, newlines inside quotes, doubled quotes). No state is kept from one
// run() call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1; // drop a leading U+FEFF

  // The record being read: the line it starts on and its index in rows (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read, and how it ended.
  let fldValue = '';
  // How many kept characters unquoted() appended (for the quote_junk test).
  let unqAdded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Sets fldValue and
  // returns COMMA, LINE_BREAK or END. The fast path takes the field to the
  // next comma or LF and only re-scans it when the slice holds a CR.
  function unquoted(value) {
    unqAdded = 0;
    let iC = text.indexOf(',', pos);
    if (iC < 0) iC = n;
    let iL = text.indexOf('\n', pos);
    if (iL < 0) iL = n;
    if (iC < iL) {
      const v = text.slice(pos, iC);
      if (v.indexOf('\r') === -1) {
        unqAdded = iC - pos;
        pos = iC + 1;
        fldValue = value + v;
        return COMMA;
      }
      return unquotedSlow(value);
    }
    if (iL < n) {
      // A CR right before the LF makes it CRLF; any other CR is stray.
      const end = text.charCodeAt(iL - 1) === 13 ? iL - 1 : iL;
      const v = text.slice(pos, end);
      if (v.indexOf('\r') === -1) {
        unqAdded = end - pos;
        pos = iL + 1;
        line += 1;
        fldValue = value + v;
        return LINE_BREAK;
      }
      return unquotedSlow(value);
    }
    const v = text.slice(pos);
    if (v.indexOf('\r') === -1) {
      unqAdded = n - pos;
      pos = n;
      fldValue = value + v;
      return END;
    }
    return unquotedSlow(value);
  }

  // The slow unquoted read, used only when the field holds a stray CR:
  // the original three-way scan, dropping each CR not followed by LF.
  function unquotedSlow(value) {
    for (;;) {
      let iC = text.indexOf(',', pos);
      if (iC < 0) iC = n;
      let iL = text.indexOf('\n', pos);
      if (iL < 0) iL = n;
      let iR = text.indexOf('\r', pos);
      if (iR < 0) iR = n;
      if (iC <= iL && iC <= iR) {
        if (iC === n) {
          value += text.slice(pos);
          unqAdded += n - pos;
          pos = n;
          fldValue = value;
          return END;
        }
        value += text.slice(pos, iC);
        unqAdded += iC - pos;
        pos = iC + 1;
        fldValue = value;
        return COMMA;
      }
      if (iL <= iR) {
        value += text.slice(pos, iL);
        unqAdded += iL - pos;
        pos = iL + 1;
        line += 1;
        fldValue = value;
        return LINE_BREAK;
      }
      if (iR + 1 < n && text.charCodeAt(iR + 1) === 10) {
        value += text.slice(pos, iR);
        unqAdded += iR - pos;
        pos = iR + 2;
        line += 1;
        fldValue = value;
        return LINE_BREAK;
      }
      value += text.slice(pos, iR);
      unqAdded += iR - pos;
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = iR + 1;
    }
  }

  // Appends text[start..end] to value, reading each CRLF or lone CR inside
  // a quoted field as one LF (and counting it as a line). The common case
  // (no line break in the span) is a single slice.
  function appendSeg(value, start, end) {
    const v = text.slice(start, end);
    if (v.indexOf('\n') === -1 && v.indexOf('\r') === -1) return value + v;
    return appendSegSlow(value, start, end);
  }

  function appendSegSlow(value, start, end) {
    let out = value;
    let s = start;
    while (s < end) {
      let iN = text.indexOf('\n', s);
      if (iN === -1 || iN >= end) iN = end + 1;
      let iR = text.indexOf('\r', s);
      if (iR === -1 || iR >= end) iR = end + 1;
      if (iN === end + 1 && iR === end + 1) break;
      if (iN < iR) {
        out += text.slice(s, iN) + '\n';
        line += 1;
        s = iN + 1;
      } else {
        out += text.slice(s, iR) + '\n';
        line += 1;
        s = iR + 1;
        if (s < end && text.charCodeAt(s) === 10) s += 1; // CRLF is one break
      }
    }
    return out + text.slice(s, end);
  }

  // Reads a quoted field whose opening quote is at pos. Sets fldValue and
  // returns COMMA, LINE_BREAK or END.
  function quoted() {
    const open = pos;
    const openLine = line;
    pos = open + 1;
    let start = pos;
    let value = '';
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        line = openLine;
        pos = open + 1;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return unquoted('"');
      }
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote inside the field.
        value = appendSeg(value, start, q);
        value += '"';
        pos = q + 2;
        start = pos;
        continue;
      }
      value = appendSeg(value, start, q);
      pos = q + 1;
      if (pos >= n) {
        fldValue = value;
        return END;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fldValue = value;
        return COMMA;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fldValue = value;
        return LINE_BREAK;
      }
      if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fldValue = value;
        return LINE_BREAK;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const ended = unquoted(value);
      if (unqAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return ended;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    let ended;
    do {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        ended = quoted();
      } else {
        lastQuoted = false;
        // The unquoted fast path, inlined: to the next comma or LF, unless
        // the field holds a stray CR (then the slow read takes it).
        unqAdded = 0;
        let iC = text.indexOf(',', pos);
        if (iC < 0) iC = n;
        let iL = text.indexOf('\n', pos);
        if (iL < 0) iL = n;
        if (iC < iL) {
          const v = text.slice(pos, iC);
          if (v.indexOf('\r') === -1) {
            unqAdded = iC - pos;
            pos = iC + 1;
            fldValue = v;
            ended = COMMA;
          } else {
            ended = unquotedSlow('');
          }
        } else if (iL < n) {
          const end = text.charCodeAt(iL - 1) === 13 ? iL - 1 : iL;
          const v = text.slice(pos, end);
          if (v.indexOf('\r') === -1) {
            unqAdded = end - pos;
            pos = iL + 1;
            line += 1;
            fldValue = v;
            ended = LINE_BREAK;
          } else {
            ended = unquotedSlow('');
          }
        } else {
          const v = text.slice(pos);
          if (v.indexOf('\r') === -1) {
            unqAdded = n - pos;
            pos = n;
            fldValue = v;
            ended = END;
          } else {
            ended = unquotedSlow('');
          }
        }
      }
      fields.push(fldValue);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
