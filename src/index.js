'use strict';
const { ZipReader } = require('./zip');
const { compileProject } = require('./compiler');
const { emit, emitHtml, VERSION } = require('./emit');

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Read an .sb3 (zip) buffer, or a bare project.json buffer/string, into { json, readAsset }. */
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return Buffer.from(input);
}

function readSb3(input) {
  const buf = toBuffer(input);
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    const zip = new ZipReader(buf);
    const raw = zip.read('project.json');
    if (!raw) throw new Error('project.json not found in the archive (is this really an .sb3 file?)');
    return { json: JSON.parse(stripBom(raw.toString('utf8'))), readAsset: (name) => zip.read(name), zip };
  }
  try {
    return { json: JSON.parse(stripBom(buf.toString('utf8'))), readAsset: () => null, zip: null };
  } catch (e) {
    throw new Error('Input is neither an .sb3 archive nor a project.json file');
  }
}

/**
 * Compile a Scratch 3 project.
 * @param {Buffer|string|object} input  .sb3 bytes, project.json text, or a parsed project object
 * @param {object} [options]
 * @param {string} [options.title]      page / metadata title
 * @param {string} [options.source]     file name recorded in the output header
 * @param {'inline'|'external'} [options.assets='inline']  embed assets as data: URIs or emit them as files
 * @param {string} [options.assetsDir='assets']            URL prefix used in external mode
 * @param {(name:string)=>Buffer|null} [options.readAsset] asset loader when `input` is a parsed object
 * @returns {{code:string, files:{path:string,data:Buffer}[], warnings:string[], stats:object, html:(js:string)=>string}}
 */
function compile(input, options) {
  options = Object.assign({}, options);
  let json;
  if (input && typeof input === 'object' && !Buffer.isBuffer(input) && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)) json = input;
  else {
    const r = readSb3(input);
    json = r.json;
    options.readAsset = options.readAsset || r.readAsset;
  }
  const compiled = compileProject(json, options);
  return {
    code: emit(compiled, options),
    files: compiled.files,
    warnings: compiled.warnings,
    stats: compiled.stats,
    html: (jsFile) => emitHtml(options.title || 'Scratch project', jsFile),
  };
}

module.exports = {
  compile,
  readSb3,
  version: VERSION,
  /** JavaScript (Scratch-flavoured subset) -> .sb3, see src/js2sb3 */
  get compileJs() { return require('./js2sb3').compileJs; },
};
