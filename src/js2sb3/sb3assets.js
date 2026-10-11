'use strict';
/** Costumes, backdrops and sounds for generated projects: loading, naming (<md5>.<ext>) and defaults. */
const crypto = require('crypto');
const path = require('path');
const { imageSize } = require('../assets');

function md5hex(buf) {
  try { return crypto.createHash('md5').update(buf).digest('hex'); } catch (e) {
    // md5 can be disabled in FIPS builds of Node; any stable 32-hex id works as an asset id
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
  }
}

const DEFAULT_SPRITE_SVG = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="52" height="52" viewBox="0 0 52 52"><circle cx="26" cy="26" r="23" fill="#4c97ff" stroke="#3373cc" stroke-width="3"/><path d="M26 9 L43 26 L26 43 L26 33 L10 33 L10 19 L26 19 Z" fill="#fff" stroke="#3373cc" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
const BLANK_BACKDROP_SVG = '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="480" height="360" viewBox="0 0 480 360"><rect width="480" height="360" fill="#ffffff"/></svg>';

const IMAGE_EXT = new Set(['svg', 'png', 'jpg', 'jpeg', 'gif', 'bmp']);
const SOUND_EXT = new Set(['wav', 'mp3', 'ogg']);

/** Sample rate / count from a PCM WAV header; null when the file is not a plain RIFF WAVE. */
function wavInfo(buf) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let p = 12;
    let rate = 0;
    let channels = 1;
    let bits = 16;
    while (p + 8 <= buf.length) {
      const id = buf.toString('ascii', p, p + 4);
      const size = buf.readUInt32LE(p + 4);
      if (id === 'fmt ') {
        channels = buf.readUInt16LE(p + 10);
        rate = buf.readUInt32LE(p + 12);
        bits = buf.readUInt16LE(p + 22);
      } else if (id === 'data') {
        const bytes = Math.min(size, buf.length - p - 8);
        const frame = Math.max(1, channels * (bits / 8));
        return { rate, sampleCount: Math.floor(bytes / frame) };
      }
      p += 8 + size + (size & 1);
    }
  } catch (e) { /* fall through */ }
  return null;
}

/**
 * Turn a costume / backdrop spec from the source into { record, asset }.
 * spec: "file.svg" | { name?, file? | svg?, rotationCenterX?, rotationCenterY?, bitmapResolution? }
 */
function makeCostume(spec, readFile, fail) {
  let name;
  let data;
  let ext;
  let o = {};
  if (typeof spec === 'string') o = { file: spec };
  else if (spec && typeof spec === 'object' && !Array.isArray(spec)) o = spec;
  else throw fail('a costume must be a file name or an object like { name, file }');

  if (typeof o.svg === 'string') {
    data = Buffer.from(o.svg, 'utf8');
    ext = 'svg';
    name = o.name || 'costume';
  } else if (typeof o.file === 'string') {
    if (!readFile) throw fail(`cannot read "${o.file}": no file access is available (pass a readFile option)`);
    try { data = readFile(o.file); } catch (e) { throw fail(`cannot read costume file "${o.file}": ${e.message}`); }
    if (!data) throw fail(`cannot read costume file "${o.file}"`);
    ext = path.extname(o.file).slice(1).toLowerCase();
    if (!IMAGE_EXT.has(ext)) throw fail(`unsupported costume file type ".${ext}" (use svg, png, jpg, gif or bmp)`);
    if (ext === 'jpeg') ext = 'jpg';
    name = o.name || path.basename(o.file, path.extname(o.file));
  } else throw fail('a costume needs either a "file" or an inline "svg"');

  const size = imageSize(data, ext);
  const record = {
    name,
    bitmapResolution: ext === 'svg' ? 1 : (o.bitmapResolution || 1),
    dataFormat: ext,
    assetId: md5hex(data),
    rotationCenterX: o.rotationCenterX !== undefined ? o.rotationCenterX : size.width / 2,
    rotationCenterY: o.rotationCenterY !== undefined ? o.rotationCenterY : size.height / 2,
  };
  record.md5ext = `${record.assetId}.${ext}`;
  return { record, asset: { name: record.md5ext, data } };
}

function makeSound(spec, readFile, fail) {
  const o = typeof spec === 'string' ? { file: spec } : spec;
  if (!o || typeof o !== 'object' || typeof o.file !== 'string') throw fail('a sound must be a file name or an object like { name, file }');
  if (!readFile) throw fail(`cannot read "${o.file}": no file access is available (pass a readFile option)`);
  let data;
  try { data = readFile(o.file); } catch (e) { throw fail(`cannot read sound file "${o.file}": ${e.message}`); }
  if (!data) throw fail(`cannot read sound file "${o.file}"`);
  const ext = path.extname(o.file).slice(1).toLowerCase();
  if (!SOUND_EXT.has(ext)) throw fail(`unsupported sound file type ".${ext}" (use wav, mp3 or ogg)`);
  const info = ext === 'wav' ? wavInfo(data) : null;
  const record = {
    name: o.name || path.basename(o.file, path.extname(o.file)),
    assetId: md5hex(data),
    dataFormat: ext,
    rate: o.rate || (info ? info.rate : 44100),
    sampleCount: o.sampleCount || (info ? info.sampleCount : 0),
  };
  record.md5ext = `${record.assetId}.${ext}`;
  return { record, asset: { name: record.md5ext, data } };
}

function defaultCostume(isStage) {
  const svg = isStage ? BLANK_BACKDROP_SVG : DEFAULT_SPRITE_SVG;
  const data = Buffer.from(svg, 'utf8');
  const assetId = md5hex(data);
  const size = isStage ? { width: 480, height: 360 } : { width: 52, height: 52 };
  return {
    record: {
      name: isStage ? 'backdrop1' : 'costume1',
      bitmapResolution: 1,
      dataFormat: 'svg',
      assetId,
      md5ext: `${assetId}.svg`,
      rotationCenterX: size.width / 2,
      rotationCenterY: size.height / 2,
    },
    asset: { name: `${assetId}.svg`, data },
  };
}

module.exports = { md5hex, makeCostume, makeSound, defaultCostume, wavInfo };
