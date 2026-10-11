'use strict';
/**
 * Tokenizer for the JavaScript subset understood by js2sb3.
 * Handles comments, numbers, strings, template literals (the `${}` parts are tokenized recursively) and
 * punctuators. Regular-expression literals are deliberately not supported: `/` is always an operator.
 */
const { CompileError } = require('./errors');

const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.', '@', '#',
];

const ID_START = /[\p{ID_Start}$_]/u;
const ID_PART = /[\p{ID_Continue}$\u200c\u200d]/u;

class Lexer {
  constructor(source, filename) {
    this.src = source;
    this.filename = filename || '';
    this.pos = 0;
    this.lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      const c = source.charCodeAt(i);
      if (c === 10 || (c === 13 && source.charCodeAt(i + 1) !== 10) || c === 0x2028 || c === 0x2029) this.lineStarts.push(i + 1);
    }
  }

  loc(pos) {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: pos - this.lineStarts[lo] + 1 };
  }

  error(msg, pos) { return new CompileError(msg, this.loc(pos === undefined ? this.pos : pos), this.filename); }

  /** All tokens of the file, ending with an `eof` token. */
  tokenize() {
    const out = [];
    for (;;) {
      const t = this.next();
      out.push(t);
      if (t.type === 'eof') return out;
    }
  }

  /** Skips whitespace and comments; returns true when a line break was crossed. */
  skipTrivia() {
    const s = this.src;
    let nl = false;
    for (;;) {
      const c = s[this.pos];
      if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') { nl = true; this.pos++; } else if (c === ' ' || c === '\t' || c === '\v' || c === '\f' || c === '\u00a0' || c === '\ufeff' || (c > '\u007f' && /\s/u.test(c))) this.pos++;
      else if (c === '/' && s[this.pos + 1] === '/') { while (this.pos < s.length && !/[\n\r\u2028\u2029]/.test(s[this.pos])) this.pos++; } else if (c === '/' && s[this.pos + 1] === '*') {
        const end = s.indexOf('*/', this.pos + 2);
        if (end < 0) throw this.error('unterminated comment');
        if (/[\n\r\u2028\u2029]/.test(s.slice(this.pos, end))) nl = true;
        this.pos = end + 2;
      } else if (c === '#' && s[this.pos + 1] === '!' && this.pos === 0) { while (this.pos < s.length && s[this.pos] !== '\n') this.pos++; } else return nl;
    }
  }

  next() {
    const nl = this.skipTrivia();
    const s = this.src;
    const start = this.pos;
    const { line, col } = this.loc(start);
    const tok = (type, value, extra) => Object.assign({ type, value, line, col, start, end: this.pos, nl }, extra);
    if (start >= s.length) return tok('eof', '');

    const c = s[start];
    if (ID_START.test(c) || c === '\\') {
      let p = start;
      while (p < s.length) {
        const ch = String.fromCodePoint(s.codePointAt(p));
        if (!ID_PART.test(ch)) break;
        p += ch.length;
      }
      if (p === start) throw this.error(`unexpected character ${JSON.stringify(c)}`);
      this.pos = p;
      return tok('id', s.slice(start, p));
    }
    if ((c >= '0' && c <= '9') || (c === '.' && s[start + 1] >= '0' && s[start + 1] <= '9')) return this.number(tok, start);
    if (c === '"' || c === "'") return this.string(tok, start, c);
    if (c === '`') return this.template(tok, start);
    for (const p of PUNCTUATORS) {
      if (s.startsWith(p, start)) {
        // "?." followed by a digit is a conditional followed by a number (a?.5:1)
        if (p === '?.' && s[start + 2] >= '0' && s[start + 2] <= '9') continue;
        this.pos = start + p.length;
        return tok('punc', p);
      }
    }
    throw this.error(`unexpected character ${JSON.stringify(c)}`);
  }

  number(tok, start) {
    const s = this.src;
    let p = start;
    let value;
    const rest = s.slice(start);
    let m;
    if ((m = /^0[xX][0-9a-fA-F_]+/.exec(rest))) { value = parseInt(m[0].slice(2).replace(/_/g, ''), 16); p += m[0].length; } else if ((m = /^0[bB][01_]+/.exec(rest))) { value = parseInt(m[0].slice(2).replace(/_/g, ''), 2); p += m[0].length; } else if ((m = /^0[oO][0-7_]+/.exec(rest))) { value = parseInt(m[0].slice(2).replace(/_/g, ''), 8); p += m[0].length; } else {
      m = /^(?:\d[\d_]*)?(?:\.\d[\d_]*|\.(?![\w$.]))?(?:[eE][+-]?\d[\d_]*)?/.exec(rest);
      const text = m[0];
      if (!text) throw this.error('malformed number');
      value = Number(text.replace(/_/g, ''));
      p += text.length;
    }
    if (s[p] === 'n') throw this.error('BigInt literals are not supported', p);
    if (p < s.length && ID_START.test(s[p])) throw this.error('identifier directly after a number', p);
    this.pos = p;
    return tok('num', value, { raw: s.slice(start, p) });
  }

  escape(quote) {
    const s = this.src;
    const at = this.pos; // at the backslash
    const c = s[at + 1];
    this.pos = at + 2;
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': if (!(s[this.pos] >= '0' && s[this.pos] <= '9')) return '\0'; throw this.error('octal escape sequences are not supported', at);
      case 'x': {
        const h = s.slice(this.pos, this.pos + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) throw this.error('invalid hexadecimal escape sequence', at);
        this.pos += 2;
        return String.fromCharCode(parseInt(h, 16));
      }
      case 'u': {
        if (s[this.pos] === '{') {
          const end = s.indexOf('}', this.pos);
          const h = s.slice(this.pos + 1, end);
          if (end < 0 || !/^[0-9a-fA-F]+$/.test(h) || parseInt(h, 16) > 0x10ffff) throw this.error('invalid unicode escape sequence', at);
          this.pos = end + 1;
          return String.fromCodePoint(parseInt(h, 16));
        }
        const h = s.slice(this.pos, this.pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(h)) throw this.error('invalid unicode escape sequence', at);
        this.pos += 4;
        return String.fromCharCode(parseInt(h, 16));
      }
      case '\r': if (s[this.pos] === '\n') this.pos++; return '';
      case '\n': case '\u2028': case '\u2029': return '';
      case undefined: throw this.error('unterminated string', at);
      default: return c;
    }
  }

  string(tok, start, quote) {
    const s = this.src;
    this.pos = start + 1;
    let out = '';
    for (;;) {
      const c = s[this.pos];
      if (c === undefined || c === '\n' || c === '\r') throw this.error('unterminated string literal', start);
      if (c === quote) { this.pos++; break; }
      if (c === '\\') out += this.escape(quote); else { out += c; this.pos++; }
    }
    return tok('str', out);
  }

  /** `a${b}c` -> { quasis: ['a', 'c'], exprs: [[tokens of b, eof]] } */
  template(tok, start) {
    const s = this.src;
    this.pos = start + 1;
    const quasis = [];
    const exprs = [];
    let cur = '';
    for (;;) {
      const c = s[this.pos];
      if (c === undefined) throw this.error('unterminated template literal', start);
      if (c === '`') { this.pos++; quasis.push(cur); break; }
      if (c === '\\') { cur += this.escape('`'); continue; }
      if (c === '$' && s[this.pos + 1] === '{') {
        this.pos += 2;
        quasis.push(cur);
        cur = '';
        const toks = [];
        let depth = 0;
        for (;;) {
          const t = this.next();
          if (t.type === 'eof') throw this.error('unterminated template expression', start);
          if (t.type === 'punc' && t.value === '{') depth++;
          if (t.type === 'punc' && t.value === '}') { if (depth === 0) break; depth--; }
          toks.push(t);
        }
        toks.push({ type: 'eof', value: '', line: 0, col: 0, start: this.pos, end: this.pos, nl: false });
        exprs.push(toks);
        continue;
      }
      if (c === '\r') { cur += '\n'; this.pos += s[this.pos + 1] === '\n' ? 2 : 1; continue; }
      cur += c;
      this.pos++;
    }
    return tok('tpl', '', { quasis, exprs });
  }
}

function tokenize(source, filename) { return new Lexer(source, filename).tokenize(); }

module.exports = { tokenize, Lexer, PUNCTUATORS };
