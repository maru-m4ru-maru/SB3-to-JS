'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { compileJs, formatError, CompileError, validateProject } = require('../src/js2sb3');
const { parse } = require('../src/js2sb3/parser');
const { tokenize } = require('../src/js2sb3/lexer');
const { ZipReader } = require('../src/zip');
const { compile, readSb3 } = require('../src');
const { load, fakePng } = require('./helpers');

/* ------------------------------------------------------------------ helpers */
/** Compile source, load the result through sb3c's compiler + runtime and run it headlessly. */
function run(src, { frames = 60, setup, until = true } = {}) {
  const r = compileJs(src, { filename: 't.js' });
  const { api } = load(r.json);
  const rt = api.createRuntime({ clock: 'virtual' });
  if (setup) setup(rt);
  rt.greenFlag();
  rt.run({ maxFrames: frames, untilIdle: until });
  const value = (name, sprite) => {
    const t = sprite ? rt.targets.find((x) => x.name === sprite) : rt.stage;
    for (const o of [t, rt.stage]) {
      for (const [id, v] of Object.entries(o.sprite.variables)) if (v[0] === name) return o.vars[id];
      for (const [id, v] of Object.entries(o.sprite.lists || {})) if (v[0] === name) return o.lists[id].slice();
    }
    return undefined;
  };
  return { rt, value, result: r };
}

function failure(src, opts) {
  try { compileJs(src, Object.assign({ filename: 't.js' }, opts)); } catch (e) { return e; }
  return null;
}

const svg = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`;

/* ------------------------------------------------------------------ lexer / parser */
test('lexer: numbers, strings, escapes, templates and comments', () => {
  const toks = tokenize("0x1F 1_000 1.5e2 .5 'a\\n\\u0041' \"q\\x41\" `a${1 + `n${2}`}b` // c\n/* d */ x");
  const v = toks.map((t) => (t.type === 'tpl' ? 'tpl' : t.value));
  assert.deepEqual(v, [31, 1000, 150, 0.5, 'a\nA', 'qA', 'tpl', 'x', '']);
  assert.equal(toks[6].quasis.length, 2);
  assert.equal(toks[7].nl, true);
});

test('parser: operator precedence and associativity', () => {
  const show = (n) => {
    switch (n.type) {
      case 'Literal': return String(n.raw);
      case 'Identifier': return n.name;
      case 'BinaryExpression': case 'LogicalExpression': return `(${show(n.left)} ${n.operator} ${show(n.right)})`;
      case 'UnaryExpression': return `(${n.operator}${show(n.argument)})`;
      case 'ConditionalExpression': return `(${show(n.test)} ? ${show(n.consequent)} : ${show(n.alternate)})`;
      case 'AssignmentExpression': return `(${show(n.left)} ${n.operator} ${show(n.right)})`;
      case 'CallExpression': return `${show(n.callee)}(${n.arguments.map(show).join(',')})`;
      case 'MemberExpression': return n.computed ? `${show(n.object)}[${show(n.property)}]` : `${show(n.object)}.${n.property.name}`;
      default: return n.type;
    }
  };
  const cases = {
    '1 + 2 * 3': '(1 + (2 * 3))',
    '(1 + 2) * 3': '((1 + 2) * 3)',
    'a - b - c': '((a - b) - c)',
    '2 ** 3 ** 2': '(2 ** (3 ** 2))',
    'a && b || c && d': '((a && b) || (c && d))',
    '!a == b': '((!a) == b)',
    'a < b == c > d': '((a < b) == (c > d))',
    '-x * y': '((-x) * y)',
    'a ? b : c ? d : e': '(a ? b : (c ? d : e))',
    'x = y += 3': '(x = (y += 3))',
    'a.b[c](d, e).f': 'a.b[c](d,e).f',
  };
  for (const [src, want] of Object.entries(cases)) assert.equal(show(parse(`(${src});`).body[0].expression), want, src);
});

test('parser: automatic semicolon insertion, directives and arrow functions', () => {
  const prog = parse(`
let a = 1
let b = 2;
function f(x, y = false) { 'use warp'
  if (x) return
  while (y) { x-- }
}
const g = (p, q) => p + q
onFlag(() => { forever(function () { a++ }) })
`);
  assert.deepEqual(prog.body.map((n) => n.type), ['VariableDeclaration', 'VariableDeclaration', 'FunctionDeclaration', 'VariableDeclaration', 'ExpressionStatement']);
  assert.equal(prog.body[2].body.body[0].directive, 'use warp');
  assert.equal(prog.body[2].params[1].name, 'y');
  assert.equal(prog.body[3].declarations[0].init.type, 'ArrowFunctionExpression');
});

test('parser: syntax that cannot become blocks is rejected with a reason and a position', () => {
  const expectations = [
    ['class A {}', /classes are not supported/],
    ['switch (a) {}', /switch/],
    ['try { a } catch (e) {}', /try \/ catch/],
    ['for (const x of y) {}', /for\.\.\.of/],
    ['let [a] = [1];', /destructuring/],
    ['a?.b', /optional chaining/],
    ['new Foo()', /new/],
    ['foo(...args)', /spread/],
    ['x = ;', /unexpected/],
    ["let s = 'abc", /unterminated string/],
    ['a = `x${1', /unterminated/],
    ['import x from "y"', /import/],
  ];
  for (const [src, re] of expectations) {
    assert.throws(() => parse(src, 't.js'), (e) => e instanceof CompileError && re.test(e.message) && e.line === 1 && e.column >= 1, src);
  }
});

test('formatError points at the offending column', () => {
  const src = 'let a = 1;\nlet b = ;\n';
  const e = failure(src);
  const text = formatError(e, src);
  assert.match(text, /^t\.js:2:9: unexpected ";"/);
  assert.match(text, /2 \| let b = ;\n\s+\| {9}\^/);
});

/* ------------------------------------------------------------------ project structure */
test('a minimal project is valid and has a stage plus the sprites in order', () => {
  const r = compileJs("sprite('A', () => {}); sprite('B', { x: 5 }, () => {});");
  assert.deepEqual(r.json.targets.map((t) => t.name), ['Stage', 'A', 'B']);
  assert.deepEqual(r.json.targets.map((t) => t.layerOrder), [0, 1, 2]);
  assert.equal(r.json.targets[2].x, 5);
  assert.deepEqual(validateProject(r.json), []);
  // every target has a default costume so that the Scratch editor can open it
  for (const t of r.json.targets) assert.equal(t.costumes.length, 1);
  assert.equal(r.json.targets[0].costumes[0].name, 'backdrop1');
  assert.equal(r.json.targets[1].costumes[0].name, 'costume1');
});

test('output is deterministic', () => {
  const src = "let n = 0; sprite('A', () => { onFlag(() => { forever(() => { n++; move(1); }); }); });";
  assert.ok(compileJs(src).sb3.equals(compileJs(src).sb3));
});

test('input shapes follow the sb3 format (shadows, menus, booleans, broadcasts, custom blocks)', () => {
  const r = compileJs(`
let n = 0;
sprite('Cat', () => {
  function greet(who, loud = false) { 'use warp'; say('hi ' + who); }
  onFlag(() => {
    goTo(MOUSE);
    move(n);
    if (n < 3 && touching(EDGE)) { greet('you', true); }
    broadcast('go');
  });
});`);
  const cat = r.json.targets[1];
  const b = cat.blocks;
  const byOp = (op) => Object.entries(b).filter(([, x]) => x.opcode === op);
  const [, goto] = byOp('motion_goto')[0];
  assert.equal(goto.inputs.TO[0], 1);
  assert.equal(b[goto.inputs.TO[1]].opcode, 'motion_goto_menu');
  assert.deepEqual(b[goto.inputs.TO[1]].fields.TO, ['_mouse_', null]);
  assert.equal(b[goto.inputs.TO[1]].shadow, true);
  const [, move] = byOp('move' === 'x' ? '' : 'motion_movesteps')[0];
  assert.deepEqual(move.inputs.STEPS, [3, ['12', 'n', 'v1'].length ? [12, 'n', 'v1'] : null, [4, '']]); // variable over a number shadow
  const [, iff] = byOp('control_if')[0];
  assert.equal(iff.inputs.CONDITION[0], 2); // boolean slot: block only, no shadow
  assert.equal(b[iff.inputs.CONDITION[1]].opcode, 'operator_and');
  const [, bc] = byOp('event_broadcast')[0];
  assert.deepEqual(bc.inputs.BROADCAST_INPUT, [1, [11, 'go', 'm1']]);
  assert.deepEqual(r.json.targets[0].broadcasts, { m1: 'go' });
  const [, proto] = byOp('procedures_prototype')[0];
  assert.equal(proto.shadow, true);
  assert.equal(proto.mutation.proccode, 'greet %s %b');
  assert.equal(proto.mutation.warp, 'true');
  assert.deepEqual(JSON.parse(proto.mutation.argumentnames), ['who', 'loud']);
  assert.deepEqual(JSON.parse(proto.mutation.argumentdefaults), ['', 'false']);
  const [, call] = byOp('procedures_call')[0];
  assert.equal(call.mutation.warp, 'true');
  assert.equal(call.mutation.proccode, 'greet %s %b');
  assert.equal(byOp('argument_reporter_boolean')[0][1].shadow, true);
  assert.equal(byOp('procedures_definition')[0][1].topLevel, true);
});

test('pen blocks switch on the pen extension; show/hide variable creates monitors', () => {
  const r = compileJs("let score = 0; let L = []; sprite('P', () => { onFlag(() => { penDown(); showVariable(score); showVariable(L); }); });");
  assert.deepEqual(r.json.extensions, ['pen']);
  assert.deepEqual(r.json.monitors.map((m) => [m.opcode, m.visible, m.spriteName]), [['data_variable', false, null], ['data_listcontents', false, null]]);
  const none = compileJs("sprite('P', () => { onFlag(() => { move(1); }); });");
  assert.deepEqual(none.json.extensions, []);
});

test('the .sb3 is a valid zip that sb3c can read back', () => {
  const r = compileJs("let n = 0; sprite('A', () => { onFlag(() => { n = 5; }); });");
  const zip = new ZipReader(r.sb3);
  assert.ok(zip.names().includes('project.json'));
  const json = JSON.parse(zip.read('project.json').toString('utf8'));
  assert.deepEqual(json, JSON.parse(JSON.stringify(r.json)));
  for (const c of json.targets.flatMap((t) => t.costumes)) assert.ok(zip.names().includes(c.md5ext), `${c.md5ext} is in the archive`);
  assert.deepEqual(readSb3(r.sb3).json, json);
  assert.ok(compile(r.sb3).code.length > 1000); // the existing compiler accepts it as a file
});

test('costume and sound files are read relative to the source and named by md5', () => {
  const crypto = require('crypto');
  const png = fakePng(40, 20);
  const wav = Buffer.alloc(44 + 2000);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + 2000, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2000, 40);
  const files = { 'img/hero.png': png, 'pop.wav': wav };
  const r = compileJs("sprite('Hero', { costumes: ['img/hero.png', { name: 'inline', svg: '" + svg(10, 6) + "' }], sounds: ['pop.wav'] }, () => { onFlag(() => { playSound('pop'); switchCostume('inline'); }); });", {
    readFile: (p) => { if (!files[p]) throw new Error('ENOENT'); return files[p]; },
  });
  const hero = r.json.targets[1];
  const md5 = crypto.createHash('md5').update(png).digest('hex');
  assert.equal(hero.costumes[0].assetId, md5);
  assert.equal(hero.costumes[0].md5ext, `${md5}.png`);
  assert.equal(hero.costumes[0].name, 'hero');
  assert.deepEqual([hero.costumes[0].rotationCenterX, hero.costumes[0].rotationCenterY], [20, 10]); // centred
  assert.deepEqual([hero.costumes[1].rotationCenterX, hero.costumes[1].rotationCenterY], [5, 3]);
  assert.equal(hero.sounds[0].name, 'pop');
  assert.equal(hero.sounds[0].rate, 22050);
  assert.equal(hero.sounds[0].sampleCount, 1000);
  assert.ok(r.assets.has(`${md5}.png`));
  const e = failure("sprite('X', { costumes: ['missing.png'] }, () => {});", { readFile: () => { throw new Error('ENOENT: no such file'); } });
  assert.match(e.message, /cannot read costume file "missing\.png"/);
});

/* ------------------------------------------------------------------ behaviour (run through sb3c's runtime) */
test('arithmetic, text, comparison and logic', () => {
  const { value } = run(`
let a = 0, b = 0, c = '', d = '', f = 0, g = 0, h = '', i = 0, j = 0, k = '', m = 0;
stage(() => { onFlag(() => {
  a = 2 + 3 * 4;
  b = (2 + 3) * 4 - 10 / 4;
  c = 'x' + 5 + 'y';
  d = \`n=\${a + 1}!\`;
  f = 7 % 3; g = -7 % 3;
  h = 'abc'[1] + 'hello'.length;
  i = Math.floor(7.8) + Math.ceil(7.2) + Math.abs(-3) + Math.round(2.5) + Math.sqrt(16);
  j = -a;
  if (10 <= 10 && !(3 >= 4) || 1 != 1) { k = 'yes'; } else { k = 'no'; }
  m = Math.pow(10, 2) + Math.pow(a, 2) + Math.PI * 0;
}); });`);
  assert.equal(value('a'), 14);
  assert.equal(value('b'), 17.5);
  assert.equal(value('c'), 'x5y');
  assert.equal(value('d'), 'n=15!');
  assert.equal(value('f'), 1);
  assert.equal(value('g'), 2, '% is Scratch\'s floored mod');
  assert.equal(value('h'), 'b5');
  assert.equal(value('i'), 7 + 8 + 3 + 3 + 4);
  assert.equal(value('j'), -14);
  assert.equal(value('k'), 'yes');
  assert.equal(Number(value('m')), 100 + 196);
});

test('trigonometry: Math.* uses radians, the builtin sin/cos use degrees', () => {
  const { value } = run(`
let a = 0, b = 0, c = 0, d = 0;
stage(() => { onFlag(() => {
  a = Math.sin(Math.PI / 2);
  b = sin(90);
  c = Math.cos(Math.PI);
  d = Math.asin(1) * 2;
}); });`);
  assert.equal(value('a'), 1);
  assert.equal(value('b'), 1);
  assert.equal(value('c'), -1);
  assert.ok(Math.abs(value('d') - Math.PI) < 1e-9);
});

test('control flow: if / else if, while, for, repeat, repeatUntil, waitUntil, forever', () => {
  const { value } = run(`
let w = 0, f = 0, r = 0, u = 0, fe = '', n = 0, t = 0, ev = 0;
stage(() => {
  onFlag(() => {
    let i = 0;
    while (i < 5) { w += i; i++; }
    for (let j = 10; j > 7; j--) { f += j; }
    repeat(4, () => { r += 2; });
    repeatUntil(u >= 3, () => { u++; });
    if (w == 10) { fe = 'a'; } else if (w == 11) { fe = 'b'; } else { fe = 'c'; }
    n = 1;
    while (n < 100) { n *= 3; }
    waitUntil(n > 200);
    t = 1;
  });
  onFlag(() => { forever(() => { ev++; wait(0.1); }); });
});`, { frames: 12, until: false });
  assert.equal(value('w'), 10);
  assert.equal(value('f'), 27);
  assert.equal(value('r'), 8);
  assert.equal(value('u'), 3);
  assert.equal(value('fe'), 'a');
  assert.equal(value('n'), 243);
  assert.equal(Number(value('t')), 1);
  assert.ok(value('ev') >= 3);
});

test('"for" runs its update step after every iteration and evaluates the test each time', () => {
  const { value } = run(`
let log = '', limit = 3;
stage(() => { onFlag(() => {
  for (let i = 0; i < limit; i++) { log += i; if (i == 1) { limit = 5; } }
}); });`);
  assert.equal(value('log'), '01234');
});

test('functions: parameters, defaults, boolean parameters, warp, recursion, sprite-local vs shared', () => {
  const { value } = run(`
let log = '', total = 0, fact = 0, flagged = '';
function addTo(x, y = 5) { total = total + x + y; }
function check(ok = false) { if (ok) { flagged = 'T'; return; } flagged = 'F'; }
function factorial(n) { 'use warp'; if (n <= 1) { fact = 1; return; } factorial(n - 1); fact = fact * n; }
sprite('A', () => {
  function inner() { log += 'A'; }
  onFlag(() => { addTo(1, 2); addTo(10); check(true); inner(); inner(); factorial(5); });
});
sprite('B', () => {
  function inner() { log += 'B'; }
  onFlag(() => { addTo(100, 0); inner(); });
});`);
  assert.equal(Number(value('total')), 3 + 15 + 100);
  assert.equal(value('log').length, 3);
  assert.equal(value('log').split('A').length - 1, 2);
  assert.equal(value('log').split('B').length - 1, 1);
  assert.equal(value('flagged'), 'T');
  assert.equal(Number(value('fact')), 120);
});

test('"return" leaves only the custom block (Scratch\'s stop this script) and the caller carries on', () => {
  const { value } = run(`
let log = '';
function early(stop) { log += 'a'; if (stop) { return; } log += 'b'; }
stage(() => { onFlag(() => { early(true); early(false); log += 'c'; }); });`);
  assert.equal(value('log'), 'aabc');
});

test('lists: 0-based indexing, push/pop/shift/unshift/splice, indexOf, includes, length, assignment', () => {
  const { value } = run(`
let L = [10, 20, 30], idx = 0, has = '', last = 0, first = 0, n = 0;
let q = [1, 2, 3, 4, 5], r = [], s = [];
stage(() => { onFlag(() => {
  L.push(40);
  L[0] = 11;
  L[1] += 5;
  first = L[0]; last = L[L.length - 1];
  idx = L.indexOf(30);
  if (L.includes(40)) { has = 'yes'; }
  n = L.length;
  q.pop(); q.shift(); q.unshift(0, 9); q.splice(1, 1); q.splice(1, 0, 7, 8);
  r = ['a', 'b'];
  s.push(1); s.length = 0;
}); });`);
  assert.deepEqual(value('L').map(Number), [11, 25, 30, 40]);
  assert.equal(Number(value('first')), 11);
  assert.equal(Number(value('last')), 40);
  assert.equal(value('idx'), 2);
  assert.equal(value('has'), 'yes');
  assert.equal(value('n'), 4);
  assert.deepEqual(value('q').map(Number), [0, 7, 8, 2, 3, 4]);
  assert.deepEqual(value('r'), ['a', 'b']);
  assert.deepEqual(value('s'), []);
});

test('scoping: locals in different scopes are different Scratch variables; shadowing renames', () => {
  const { value, result } = run(`
let i = 100, count = 0;
sprite('A', () => {
  let count_x = 0;
  function helper() { for (let i = 0; i < 3; i++) { count_x += 1; } }
  onFlag(() => {
    for (let i = 0; i < 2; i++) { helper(); }
    count = count_x;
  });
});`);
  assert.equal(value('i'), 100, 'the global i is untouched by the loops');
  assert.equal(value('count'), 6);
  const names = Object.values(result.json.targets[1].variables).map((v) => v[0]);
  assert.equal(new Set(names).size, names.length, 'no duplicate variable names in the sprite');
  assert.ok(names.includes('i_2') && names.includes('i_3'), names.join());
});

test('events: broadcast, broadcastAndWait, key, timer, clone hats, backdrop hat', () => {
  const { value, rt } = run(`
let got = '', clones = 0, key = 0, tick = 0, bd = '';
sprite('Sender', () => {
  onFlag(() => { broadcast('hello'); broadcastAndWait('done'); got += '!'; });
});
sprite('Receiver', () => {
  onMessage('hello', () => { got += 'h'; });
  onMessage('done', () => { wait(0.1); got += 'd'; });
  onKey('space', () => { key++; });
  onTimer(0.2, () => { tick++; });
});
sprite('Spawner', { visible: false }, () => {
  onFlag(() => { createClone(); createClone(); });
  onCloneStart(() => { clones++; wait(0.2); deleteClone(); });
});
stage({ costumes: [{ name: 'b1', svg: '${svg(10, 10)}' }, { name: 'b2', svg: '${svg(20, 20)}' }] }, () => {
  onFlag(() => { switchBackdrop('b2'); });
  onBackdrop('b2', () => { bd = 'switched'; });
});`, { frames: 30, until: false, setup: (rt0) => rt0.on('frame', (f) => { if (f === 5) rt0.pressKey('space'); if (f === 6) rt0.releaseKey('space'); }) });
  assert.deepEqual([...value('got')].sort(), ['!', 'd', 'h']);
  assert.ok(value('got').indexOf('d') < value('got').indexOf('!'), 'broadcastAndWait waited for the receiver');
  assert.equal(value('clones'), 2);
  assert.equal(value('key'), 1);
  assert.equal(value('tick'), 1);
  assert.equal(value('bd'), 'switched');
  assert.equal(rt.targets.filter((t) => t.isClone).length, 0);
});

test('motion, looks, sound, pen and sensing blocks run', () => {
  const { rt, value } = run(`
let near = 0, attr = 0, rnd = 0, cname = '', onEdge = 0;
sprite('S', { x: 0, y: 0, direction: 90 }, () => {
  onFlag(() => {
    goTo(10, 20); move(5); turnRight(90); move(10); changeX(1); setY(-3); pointInDirection(0);
    setSize(50); changeSize(10); setEffect('ghost', 30); changeEffect('color', 5);
    say('hi'); setPenColor('#ff0000'); setPenSize(4); penDown(); move(10); penUp();
    setRotationStyle('left-right'); hide(); show(); goToFront();
    changePenParam('brightness', -10); setVolume(40);
    if (distanceTo('T') == 50) { near = 1; }
    attr = attributeOf('x position', 'T');
    cname = costumeName();
    rnd = random(5, 5) + Math.random() * 0;
    if (touching(EDGE)) { onEdge = 1; }
  });
});
sprite('T', { x: 16, y: 57 }, () => {});`, { frames: 10 });
  const s = rt.targets.find((t) => t.name === 'S');
  assert.deepEqual([s.x, s.y], [16, 7]);
  assert.equal(s.direction, 0);
  assert.equal(s.size, 60);
  assert.deepEqual([s.effects.ghost, s.effects.color], [30, 5]);
  assert.deepEqual([s.pen.size, s.pen.brightness], [4, 90]);
  assert.equal(s.rotationStyle, 'left-right');
  assert.equal(s.bubble.text, 'hi');
  assert.equal(s.volume, 40);
  assert.equal(Number(value('near')), 1);
  assert.equal(Number(value('attr')), 16);
  assert.equal(value('cname'), 'costume1');
  assert.equal(value('rnd'), 5);
});

test('statements after a cap block are dropped with a warning', () => {
  const r = compileJs("sprite('A', () => { onFlag(() => { forever(() => { move(1); }); move(99); }); function f() { return; move(2); } onFlag(() => { f(); stopAll(); say('x'); }); });");
  assert.equal(r.warnings.length, 3);
  assert.match(r.warnings[0], /unreachable code after an endless loop was dropped/);
  assert.match(r.warnings[1], /unreachable code after a block that ends the script|stopAll/);
  const ops = Object.values(r.json.targets[1].blocks).map((b) => b.opcode);
  assert.ok(!ops.includes('looks_say'));
});

test('a recursive function that keeps local variables warns', () => {
  const r = compileJs("let t = 0; function r(n) { let k = n; if (n > 0) { r(n - 1); } t += k; } sprite('A', () => { onFlag(() => { r(3); }); });");
  assert.ok(r.warnings.some((w) => /calls itself and uses local variables/.test(w)), r.warnings.join('|'));
});

/* ------------------------------------------------------------------ errors */
test('unsupported or wrong programs fail with a helpful message at the right place', () => {
  const cases = [
    ["sprite('A', () => { onFlag(() => { x = 1; }); });", /"x" is not declared/, 1, 36],
    ['let n = 0;\nsprite("A", () => { onFlag(() => {\n  while (true) { n++; if (n > 3) break; }\n}); });', /"break" is not supported/, 3, 34],
    ['let a = 0;\nsprite("A", () => { onFlag(() => { a = a > 1 ? 1 : 2; }); });', /\?: operator/, 2, 40],
    ['function f() { return 5; }\nsprite("A", () => {});', /cannot return values/, 1, 16],
    ['let a = 0; function f() { a = 1; }\nsprite("A", () => { onFlag(() => { a = f(); }); });', /cannot return a value/, 2, 40],
    ['function f(p) { p = 2; }\nsprite("A", () => {});', /parameter "p" cannot be assigned/, 1, 17],
    ['const k = 1;\nsprite("A", () => { onFlag(() => { k = 2; }); });', /declared with const/, 2, 36],
    ["sprite('A', () => { onFlag(() => { jump(5); }); });", /unknown function "jump"/, 1, 36],
    ["sprite('A', () => { onFlag(() => { move(); }); });", /move\(steps\) takes 1 argument but 0 were given/, 1, 36],
    ["sprite('A', () => { onFlag(() => { setEffect('sparkle', 5); }); });", /the effect must be one of/, 1, 46],
    ["sprite('A', () => { onKey('ctrl+x', () => {}); });", /is not a key Scratch knows/, 1, 27],
    ['let a = 1;\na = 2;', /only declarations and sprite\(\)/, 2, 1],
    ["sprite('A', () => { move(10); });", /may only contain declarations and event handlers/, 1, 21],
    ["sprite('A', () => {});\nsprite('A', () => {});", /defined twice/, 2, 1],
    ['let o = { a: 1 };', /objects are not supported/, 1, 9],
    ['let a = 1 + 2;', /must be a constant.*top-level variables start with a constant/, 1, 11],
    ['let a = 0;\nsprite("A", () => { onFlag(() => { a = [1, 2]; }); });', /holds a single value/, 2, 40],
    ['let a = 2;\nsprite("A", () => { onFlag(() => { a = a ** 2; }); });', /\*\* operator/, 2, 42],
    ['let a = 0;\nsprite("A", () => { onFlag(() => { do { a++; } while (a < 3); }); });', /do\.\.\.while/, 2, 36],
    ['let a = 0;\nsprite("A", () => { onFlag(() => { a = Math.max(1, 2); }); });', /Math\.max\(\) is not supported/, 2, 40],
    ["sprite('A', () => { onFlag(() => { xPosition(); }); });", /returns a value/, 1, 36],
    ['let a = 0;\nsprite("A", () => { onFlag(() => { a = move(1); }); });', /does not return a value/, 2, 40],
    ["sprite('A', () => {});\nstage(() => { onCloneStart(() => {}); });", /only available in sprites/, 2, 15],
    ['let L = [1];\nsprite("A", () => { onFlag(() => { L.sort(); }); });', /not supported as a statement/, 2, 38],
    ['let a = 0;\nsprite("A", () => { onFlag(() => { a.push(1); }); });', /not a list/, 2, 36],
  ];
  for (const [src, re, line, col] of cases) {
    const e = failure(src);
    assert.ok(e instanceof CompileError, `expected a CompileError for: ${src}`);
    assert.match(e.message, re, src);
    assert.equal(e.line, line, `line for: ${src}`);
    assert.equal(e.column, col, `column for: ${src}`);
  }
});

/* ------------------------------------------------------------------ CLI */
test('CLI: compiles a file, reports errors with exit code 1, supports --check and --json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'js2sb3-'));
  const cli = path.join(__dirname, '..', 'bin', 'js2sb3.js');
  const node = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  try {
    fs.writeFileSync(path.join(dir, 'game.js'), "let n = 0; sprite('A', () => { onFlag(() => { n = 7; say(n); }); });");
    const ok = node([path.join(dir, 'game.js'), '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /1 sprite, \d+ blocks/);
    assert.ok(fs.existsSync(path.join(dir, 'game.sb3')));
    assert.ok(fs.existsSync(path.join(dir, 'game.project.json')));
    assert.deepEqual(readSb3(fs.readFileSync(path.join(dir, 'game.sb3'))).json.targets.map((t) => t.name), ['Stage', 'A']);

    fs.writeFileSync(path.join(dir, 'bad.js'), 'let a = 1;\nlet b = ;\n');
    const bad = node([path.join(dir, 'bad.js')]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /bad\.js:2:9: unexpected ";"/);
    assert.ok(!fs.existsSync(path.join(dir, 'bad.sb3')));

    const chk = node([path.join(dir, 'game.js'), '--check', '-q']);
    assert.equal(chk.status, 0);
    assert.equal(chk.stderr, '');
    assert.equal(node(['nope.js']).status, 2);
    assert.equal(node(['--bogus']).status, 2);
    assert.equal(node(['--version']).stdout.trim(), require('../package.json').version);

    // files named in the source are found relative to it
    fs.writeFileSync(path.join(dir, 'hero.svg'), svg(30, 30));
    fs.writeFileSync(path.join(dir, 'files.js'), "sprite('Hero', { costumes: ['hero.svg'] }, () => {});");
    const f = node([path.join(dir, 'files.js'), '-o', path.join(dir, 'out', 'f.sb3')]);
    assert.equal(f.status, 0, f.stderr);
    assert.equal(readSb3(fs.readFileSync(path.join(dir, 'out', 'f.sb3'))).json.targets[1].costumes[0].name, 'hero');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the bundled example compiles, and the result runs in the sb3c runtime', () => {
  const file = path.join(__dirname, '..', 'examples', 'catcher.js');
  const r = compileJs(fs.readFileSync(file, 'utf8'), { filename: file });
  assert.deepEqual(validateProject(r.json), []);
  const { api } = load(r.json);
  const rt = api.createRuntime({ clock: 'virtual' });
  rt.greenFlag();
  rt.run({ maxFrames: 600, untilIdle: false });
  const lives = Object.entries(rt.stage.sprite.variables).find(([, v]) => v[0] === 'lives');
  assert.equal(rt.stage.vars[lives[0]], 0, 'the game ends when the lives run out');
});

test('a variable that starts out as text concatenates with + and +=', () => {
  const { value } = run(`
let log = '', num = 0, mixed = 'n=';
stage(() => { onFlag(() => {
  for (let i = 0; i < 3; i++) { log += i; num += i; }
  let local = 'x';
  local += 1;
  local = local + 2;
  mixed = mixed + num;
  log += 'z';
}); });`);
  assert.equal(value('log'), '012z');
  assert.equal(Number(value('num')), 3);
  assert.equal(value('mixed'), 'n=3');
  assert.equal(value('local'), 'x12');
});

test('functions nobody calls are still checked, and reported as unused', () => {
  const e = failure('function f() { return 5; }\nsprite("A", () => {});');
  assert.match(e.message, /cannot return values/);
  const r = compileJs("function helper() { broadcast('never'); penDown(); }\nsprite('A', () => { onFlag(() => { move(1); }); });");
  assert.ok(r.warnings.some((w) => /function helper\(\) is never called/.test(w)));
  // the throw-away compile must leave no trace in the project
  assert.deepEqual(r.json.targets[0].broadcasts, {});
  assert.deepEqual(r.json.extensions, []);
});

test('regression: += with a text-valued reporter does not leave an orphan block behind', () => {
  const { value, result } = run(`
let log = '', n = 0;
stage(() => { onFlag(() => { log += 'abc'[1]; log += letterOf(1, 'xyz'); n += 'q'.length; }); });`);
  assert.equal(value('log'), 'bx');
  assert.equal(Number(value('n')), 1);
  assert.deepEqual(validateProject(result.json), []);
});

test('scoping details: booleans are not text, stage-body variables are private to the stage body', () => {
  const { value } = run(`
let flag = true, n = 0;
stage(() => { onFlag(() => { n = flag + 1; if (flag) { n += 10; } }); });`);
  // a variable that starts as true/false is not text: + adds (Scratch reads the word "true" as 0) instead of joining
  assert.equal(Number(value('n')), 11);
  const e = failure(`
sprite('A', () => { onFlag(() => { hidden = 1; }); });
stage(() => { let hidden = 0; onFlag(() => { hidden = 2; }); });`);
  assert.match(e.message, /"hidden" is not declared/);
  assert.equal(failure("sprite('Stage', () => {});").message.includes('reserved'), true);
});
