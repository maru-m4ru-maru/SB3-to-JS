'use strict';
/** Minimal dependency-free ZIP reader (stored + deflate), enough for .sb3 files. */
const zlib = require('zlib');

class ZipReader {
  constructor(buf) {
    this.buf = buf;
    this.entries = new Map();
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip archive (end of central directory not found)');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory');
      const method = buf.readUInt16LE(p + 10);
      const csize = buf.readUInt32LE(p + 20);
      const nlen = buf.readUInt16LE(p + 28);
      const elen = buf.readUInt16LE(p + 30);
      const clen = buf.readUInt16LE(p + 32);
      const off = buf.readUInt32LE(p + 42);
      if (csize === 0xffffffff || off === 0xffffffff) throw new Error('Zip64 archives are not supported');
      const name = buf.toString('utf8', p + 46, p + 46 + nlen);
      if (!name.endsWith('/')) this.entries.set(name, { method, csize, off });
      p += 46 + nlen + elen + clen;
    }
  }

  names() { return [...this.entries.keys()]; }
  has(name) { return this.entries.has(name); }

  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    const b = this.buf;
    if (b.readUInt32LE(e.off) !== 0x04034b50) throw new Error(`Corrupt zip local header for ${name}`);
    const start = e.off + 30 + b.readUInt16LE(e.off + 26) + b.readUInt16LE(e.off + 28);
    const raw = b.subarray(start, start + e.csize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`Unsupported zip compression method ${e.method} for ${name}`);
  }
}

module.exports = { ZipReader };
