'use strict';
/**
 * Value semantics shared by the compiler (constant folding) and the runtime.
 * They mirror scratch-vm's Cast / MathUtil behaviour.
 */

const isWhiteSpace = (v) => v === null || (typeof v === 'string' && v.trim().length === 0);

function toNumber(v) {
  if (typeof v === 'number') return Number.isNaN(v) ? 0 : v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function toBoolean(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return !(v === '' || v === '0' || v.toLowerCase() === 'false');
  return Boolean(v);
}

const toStr = (v) => String(v);

function compare(a, b) {
  let n1 = Number(a);
  let n2 = Number(b);
  if (n1 === 0 && isWhiteSpace(a)) n1 = NaN;
  else if (n2 === 0 && isWhiteSpace(b)) n2 = NaN;
  if (Number.isNaN(n1) || Number.isNaN(n2)) {
    const s1 = String(a).toLowerCase();
    const s2 = String(b).toLowerCase();
    return s1 < s2 ? -1 : s1 > s2 ? 1 : 0;
  }
  if ((n1 === Infinity && n2 === Infinity) || (n1 === -Infinity && n2 === -Infinity)) return 0;
  return n1 - n2;
}

function isInt(v) {
  if (typeof v === 'number') return Number.isNaN(v) ? true : v === parseInt(v, 10);
  if (typeof v === 'string') return v.indexOf('.') < 0;
  return true;
}

function random(a, b) {
  const n1 = toNumber(a);
  const n2 = toNumber(b);
  if (n1 === n2) return n1;
  const lo = Math.min(n1, n2);
  const hi = Math.max(n1, n2);
  if (isInt(a) && isInt(b)) return lo + Math.floor(Math.random() * (hi + 1 - lo));
  return Math.random() * (hi - lo) + lo;
}

function mod(n, m) {
  let r = n % m;
  if (r / m < 0) r += m;
  return r;
}

function letterOf(index, s) {
  const i = index - 1;
  return i < 0 || i >= s.length ? '' : s.charAt(i);
}

const contains = (a, b) => a.toLowerCase().includes(b.toLowerCase());

function limitPrecision(n) {
  const r = Math.round(n);
  return Math.abs(n - r) < 1e-9 ? r : n;
}

const degToRad = (d) => (d * Math.PI) / 180;
const radToDeg = (r) => (r * 180) / Math.PI;
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const wrapClamp = (n, min, max) => {
  const range = max - min + 1;
  return n - Math.floor((n - min) / range) * range;
};

const round10 = (x) => Math.round(x * 1e10) / 1e10;
const sin = (n) => round10(Math.sin((Math.PI * n) / 180));
const cos = (n) => round10(Math.cos((Math.PI * n) / 180));
function tan(n) {
  const a = n % 360;
  if (a === -270 || a === 90) return Infinity;
  if (a === -90 || a === 270) return -Infinity;
  return round10(Math.tan((Math.PI * n) / 180));
}

/* ---- lists (1-based, with the "last" / "random" / "all" keywords) ---- */
const LIST_ITEM_LIMIT = 200000;

function listIndex(index, length, acceptAll) {
  if (typeof index !== 'number') {
    if (index === 'all') return acceptAll ? 'ALL' : 'INVALID';
    if (index === 'last') return length > 0 ? length : 'INVALID';
    if (index === 'random' || index === 'any') return length > 0 ? 1 + Math.floor(Math.random() * length) : 'INVALID';
  }
  const i = Math.floor(toNumber(index));
  return i < 1 || i > length ? 'INVALID' : i;
}
function listGet(list, index) {
  const i = listIndex(index, list.length, false);
  return i === 'INVALID' ? '' : list[i - 1];
}
function listAdd(list, item) {
  if (list.length < LIST_ITEM_LIMIT) list.push(item);
}
function listDelete(list, index) {
  const i = listIndex(index, list.length, true);
  if (i === 'ALL') list.length = 0;
  else if (i !== 'INVALID') list.splice(i - 1, 1);
}
function listInsert(list, index, item) {
  const i = listIndex(index, list.length + 1, false);
  if (i === 'INVALID' || list.length >= LIST_ITEM_LIMIT) return;
  list.splice(i - 1, 0, item);
}
function listReplace(list, index, item) {
  const i = listIndex(index, list.length, false);
  if (i !== 'INVALID') list[i - 1] = item;
}
function listIndexOf(list, item) {
  for (let i = 0; i < list.length; i++) if (compare(list[i], item) === 0) return i + 1;
  return 0;
}
const listContains = (list, item) => listIndexOf(list, item) > 0;
function listStr(list) {
  for (let i = 0; i < list.length; i++) {
    if (!(typeof list[i] === 'string' && list[i].length === 1)) return list.join(' ');
  }
  return list.join('');
}

/* ---- colours ---- */
/**
 * Same rule as scratch-vm's Cast.toRgbColorObject: only strings that start with "#" are hex colours;
 * anything else (including the string "16711680") is a decimal number.
 */
function toRgb(v) {
  if (typeof v === 'string' && v.charAt(0) === '#') {
    let h = v.slice(1).trim();
    if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((c) => c + c).join('');
    if (/^[0-9a-f]{6}$/i.test(h)) {
      const n = parseInt(h, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
    }
    return { r: 0, g: 0, b: 0, a: 255 }; // "#" followed by garbage -> black
  }
  const n = toNumber(v) >>> 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: n > 0xffffff ? (n >>> 24) & 255 : 255 };
}
function rgbToHsv({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

/** Short names used by generated code. */
const helpers = {
  num: toNumber, str: toStr, bool: toBoolean, cmp: compare, mod, random, letterOf, contains,
  limitPrecision, sin, cos, tan,
  listGet, listAdd, listDelete, listInsert, listReplace, listIndexOf, listContains, listStr,
};

module.exports = {
  helpers, isWhiteSpace, toNumber, toBoolean, toStr, compare, isInt, random, mod,
  limitPrecision, degToRad, radToDeg, clamp, wrapClamp, toRgb, rgbToHsv, hsvToRgb,
  listIndex, listGet, listAdd, listDelete, listInsert, listReplace, listIndexOf, listContains, listStr,
};
