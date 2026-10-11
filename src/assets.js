'use strict';
/** Asset helpers: MIME types and best-effort intrinsic image sizes (no decoding needed). */

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  webp: 'image/webp', svg: 'image/svg+xml', wav: 'audio/wav', wave: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg',
};
const mimeOf = (fmt) => MIME[String(fmt).toLowerCase()] || 'application/octet-stream';

function svgSize(buf) {
  const text = buf.toString('utf8', 0, Math.min(buf.length, 4096));
  const tag = /<svg\b[^>]*>/i.exec(text);
  if (!tag) return { width: 0, height: 0 };
  const attr = (n) => {
    const m = new RegExp(`\\s${n}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag[0]);
    return m ? m[1] : null;
  };
  const px = (v) => (v && /^[\d.]+(px)?$/.test(v.trim()) ? parseFloat(v) : 0);
  let width = px(attr('width'));
  let height = px(attr('height'));
  if (!width || !height) {
    const vb = attr('viewBox');
    if (vb) {
      const p = vb.trim().split(/[\s,]+/).map(Number);
      if (p.length === 4 && p[2] > 0 && p[3] > 0) { width = p[2]; height = p[3]; }
    }
  }
  return { width, height };
}

function imageSize(buf, format) {
  const f = String(format).toLowerCase();
  try {
    if (f === 'svg') return svgSize(buf);
    if (f === 'png' && buf.length > 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (f === 'gif' && buf.length > 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (f === 'bmp' && buf.length > 26) return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    if (f === 'jpg' || f === 'jpeg') {
      let p = 2;
      while (p + 9 < buf.length) {
        if (buf[p] !== 0xff) { p++; continue; }
        const m = buf[p + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
        }
        p += 2 + buf.readUInt16BE(p + 2);
      }
    }
  } catch (e) { /* fall through */ }
  return { width: 0, height: 0 };
}

module.exports = { mimeOf, imageSize };
