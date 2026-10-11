'use strict';
/** Test utilities: a tiny .sb3 builder, a stored/deflate zip writer and a headless runner. */
const zlib = require('zlib');
const { compile } = require('../src');

/* ---------- zip writer ---------- */
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function makeZip(files, deflate) {
  const parts = [];
  const central = [];
  let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const nb = Buffer.from(name);
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(method, 8);
    h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26);
    parts.push(h, nb, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, nb);
    off += 30 + nb.length + body.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length / 2, 8); e.writeUInt16LE(central.length / 2, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}

/** A PNG-looking buffer whose IHDR says w x h (enough for size detection; never decoded in Node). */
function fakePng(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

/* ---------- project builder ---------- */
class Blocks {
  constructor() { this.blocks = {}; this.n = 0; }
  static inp(v) {
    if (v && v.raw) return v.raw;
    if (v && v.block) return [3, v.block, [10, '']];
    return typeof v === 'number' ? [1, [4, String(v)]] : [1, [10, String(v)]];
  }
  add(opcode, inputs, fields, extra) {
    const id = `b${++this.n}`;
    const ins = {};
    for (const k of Object.keys(inputs || {})) ins[k] = Blocks.inp(inputs[k]);
    this.blocks[id] = Object.assign({ opcode, next: null, parent: null, inputs: ins, fields: fields || {}, shadow: false, topLevel: false }, extra);
    return id;
  }
  /** reporter: returns a value usable as an input */
  r(opcode, inputs, fields) { return { block: this.add(opcode, inputs, fields) }; }
  v(name) { return { raw: [3, [12, name, `v_${name}`], [10, '']] }; }
  /** statement */
  s(opcode, inputs, fields, extra) { return this.add(opcode, inputs, fields, extra); }
  sub(ids) { this.chain(ids); return { raw: [2, ids[0]] }; }
  chain(ids) {
    ids.forEach((id, i) => {
      if (i + 1 < ids.length) { this.blocks[id].next = ids[i + 1]; this.blocks[ids[i + 1]].parent = id; }
    });
    return ids[0];
  }
  script(hatOpcode, ids, hatFields) {
    const hat = this.add(hatOpcode, {}, hatFields || {}, { topLevel: true });
    this.chain([hat, ...ids]);
    return hat;
  }
  set(name, v) { return this.s('data_setvariableto', { VALUE: v }, { VARIABLE: [name, `v_${name}`] }); }
  change(name, v) { return this.s('data_changevariableby', { VALUE: v }, { VARIABLE: [name, `v_${name}`] }); }
  flag(ids) { return this.script('event_whenflagclicked', ids); }
  op(opcode, a, b) { return this.r(opcode, { NUM1: a, NUM2: b }); }
  listF(name) { return { LIST: [name, `l_${name}`] }; }
  proc(code, argNames, warp, body) {
    const ids = argNames.map((_, i) => `arg${i}_${code.replace(/\W/g, '')}`);
    const proto = this.add('procedures_prototype', {}, {}, {
      shadow: true,
      mutation: { tagName: 'mutation', proccode: code, argumentids: JSON.stringify(ids), argumentnames: JSON.stringify(argNames), argumentdefaults: '[]', warp: String(!!warp) },
    });
    const def = this.add('procedures_definition', { custom_block: { raw: [1, proto] } }, {}, { topLevel: true });
    this.chain([def, ...body]);
    return def;
  }
  call(code, args, warp) {
    const ids = (args || []).map((_, i) => `arg${i}_${code.replace(/\W/g, '')}`);
    const inputs = {};
    ids.forEach((id, i) => { inputs[id] = args[i]; });
    return this.add('procedures_call', inputs, {}, {
      mutation: { tagName: 'mutation', proccode: code, argumentids: JSON.stringify(ids), warp: String(!!warp) },
    });
  }
  arg(name) { return this.r('argument_reporter_string_number', {}, { VALUE: [name, null] }); }
}

function target(name, B, opts) {
  opts = opts || {};
  const variables = {};
  for (const [k, v] of Object.entries(opts.vars || {})) variables[`v_${k}`] = [k, v];
  const lists = {};
  for (const [k, v] of Object.entries(opts.lists || {})) lists[`l_${k}`] = [k, v];
  return Object.assign({
    isStage: false, name, variables, lists, broadcasts: {}, blocks: B.blocks, comments: {},
    currentCostume: 0, costumes: opts.costumes || [], sounds: [], volume: 100, layerOrder: 1,
    visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around',
  }, opts.extra || {});
}

function project(stage, sprites) {
  return { targets: [Object.assign(target('Stage', stage.B || new Blocks(), stage), { isStage: true, layerOrder: 0 }), ...sprites],
    monitors: [], extensions: [], meta: { semver: '3.0.0', vm: '0.2.0', agent: 'test' } };
}

/* ---------- running ---------- */
function load(json, options) {
  const result = compile(json, options);
  const m = { exports: {} };
  new Function('module', result.code)(m);
  return { api: m.exports, result };
}

function run(json, o) {
  o = o || {};
  const { api } = load(json, o.compile);
  const said = [];
  const answers = (o.answers || []).slice();
  const rt = api.createRuntime({ clock: 'virtual', host: { ask: () => (answers.length ? answers.shift() : '') } });
  rt.on('bubble', (t, type, text) => said.push(`${t.name}:${text}`));
  if (o.setup) o.setup(rt);
  rt.greenFlag();
  rt.run({ maxFrames: o.frames || 600, untilIdle: o.untilIdle });
  rt.said = said;
  return rt;
}

function val(rt, name, targetName) {
  const t = targetName ? rt.targets.find((x) => x.name === targetName) : rt.stage;
  const id = Object.keys(t.vars).find((k) => t.sprite.variables[k][0] === name);
  return t.vars[id];
}
function list(rt, name, targetName) {
  const t = targetName ? rt.targets.find((x) => x.name === targetName) : rt.stage;
  const id = Object.keys(t.lists).find((k) => t.sprite.lists[k][0] === name);
  return t.lists[id];
}

module.exports = { Blocks, target, project, makeZip, fakePng, load, run, val, list };
