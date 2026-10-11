'use strict';
/** Regression tests for bugs found while auditing the runtime against scratch-vm's behaviour. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Blocks, target, project, run, val, load } = require('./helpers');
const C = require('../src/runtime/cast');
const { compile } = require('../src');

function single(build, opts) {
  const B = new Blocks();
  const body = build(B);
  if (body) B.flag(body);
  return project({}, [target('S', B, opts || {})]);
}

test('the default pen colour is blue, as in Scratch 3', () => {
  const rt = run(single((B) => [B.s('pen_penDown')]));
  assert.equal(rt.targets[0].penStyle(), 'rgba(0,0,255,1)');
});

test('the green flag / stop all clears graphic effects', () => {
  const B = new Blocks();
  B.flag([B.s('looks_seteffectto', { VALUE: 100 }, { EFFECT: ['GHOST', null] }), B.s('control_wait', { DURATION: 5 })]);
  const { api } = load(project({}, [target('S', B)]));
  const rt = api.createRuntime({ clock: 'virtual' });
  rt.greenFlag();
  rt.step();
  rt.step();
  assert.equal(rt.targets[0].effects.ghost, 100);
  rt.stopAll();
  assert.equal(rt.targets[0].effects.ghost, 0);
  rt.greenFlag();
  rt.step();
  rt.greenFlag(); // restarting must not leave the previous run's effect behind
  assert.equal(rt.targets[0].effects.ghost, 0);
});

test('holding a key re-triggers "when key pressed" (key repeat), but never stacks a running script', () => {
  const B = new Blocks();
  B.script('event_whenkeypressed', [B.change('n', 1)], { KEY_OPTION: ['space', null] });
  const rt = run(project({}, [target('S', B, { vars: { n: 0 } })]), {
    frames: 6,
    untilIdle: false,
    setup: (r) => r.on('frame', (f) => { if (f === 1 || f === 3 || f === 5) r.pressKey('space'); }),
  });
  assert.equal(val(rt, 'n', 'S'), 3);

  // two presses in the same frame while the script is still running (it waits) -> only one run
  const W = new Blocks();
  W.script('event_whenkeypressed', [W.change('n', 1), W.s('control_wait', { DURATION: 1 })], { KEY_OPTION: ['a', null] });
  const rt2 = run(project({}, [target('S', W, { vars: { n: 0 } })]), {
    frames: 4,
    untilIdle: false,
    setup: (r) => r.on('frame', (f) => { if (f === 1) { r.pressKey('a'); r.pressKey('a'); } }),
  });
  assert.equal(val(rt2, 'n', 'S'), 1);
});

test('direction ignores non-finite values instead of becoming NaN', () => {
  const rt = run(single((B) => [B.s('motion_pointindirection', { DIRECTION: B.op('operator_divide', 1, 0) })]));
  assert.equal(rt.targets[0].direction, 90);
  const rt2 = run(single((B) => [B.s('motion_turnright', { DEGREES: B.op('operator_divide', 1, 0) })]));
  assert.equal(rt2.targets[0].direction, 90);
});

test('colour values: only "#..." strings are hex, other strings are decimal numbers', () => {
  assert.deepEqual(C.toRgb('#ff0000'), { r: 255, g: 0, b: 0, a: 255 });
  assert.deepEqual(C.toRgb('#f00'), { r: 255, g: 0, b: 0, a: 255 });
  assert.deepEqual(C.toRgb('16711680'), { r: 255, g: 0, b: 0, a: 255 });
  assert.deepEqual(C.toRgb(255), { r: 0, g: 0, b: 255, a: 255 });
  assert.deepEqual(C.toRgb('255'), { r: 0, g: 0, b: 255, a: 255 });
  assert.deepEqual(C.toRgb('#zzz'), { r: 0, g: 0, b: 0, a: 255 });
  assert.deepEqual(C.toRgb('hello'), { r: 0, g: 0, b: 0, a: 255 });
});

test('pen colour parameter wraps with Scratch\'s wrapClamp(0, 100)', () => {
  const rt = run(single((B) => [
    B.s('pen_setPenColorParamTo', { COLOR_PARAM: B.r('pen_menu_colorParam', {}, { colorParam: ['color', null] }), VALUE: 101 }),
  ]));
  assert.equal(rt.targets[0].pen.hue, 0);
});

test('edge-activated hats ("when timer > x") are armed again by the green flag', () => {
  const B = new Blocks();
  const hat = B.script('event_whengreaterthan', [B.change('n', 1)], { WHENGREATERTHANMENU: ['TIMER', null] });
  B.blocks[hat].inputs.VALUE = [1, [4, '-1']];
  const { api } = load(project({}, [target('S', B, { vars: { n: 0 } })]));
  const rt = api.createRuntime({ clock: 'virtual' });
  rt.greenFlag();
  rt.run({ maxFrames: 3, untilIdle: false });
  assert.equal(rt.targets[0].vars.v_n, 1);
  rt.greenFlag();
  rt.run({ maxFrames: 3, untilIdle: false });
  assert.equal(rt.targets[0].vars.v_n, 2);
});

test('"when backdrop switches to" does not restart a copy that is still running', () => {
  const B = new Blocks();
  B.script('event_whenbackdropswitchesto', [B.change('n', 1), B.s('control_wait', { DURATION: 1 })], { BACKDROP: ['b2', null] });
  const { api } = load(project({ B, vars: { n: 0 } }, [target('S', new Blocks())]));
  const rt = api.createRuntime({ clock: 'virtual' });
  // no costumes in the fixture, so call the hat starter directly the way switchBackdrop does
  rt.startHats('backdrop', (h) => h.name === 'B2');
  rt.step();
  rt.startHats('backdrop', (h) => h.name === 'B2');
  rt.step();
  assert.equal(rt.stage.vars.v_n, 1);
});

test('keyboard glue ignores events without a key and compile() accepts typed arrays / BOMs', () => {
  const { keyName } = require('../src/runtime/host');
  assert.equal(keyName({}), '');
  assert.equal(keyName({ key: ' ' }), 'space');
  assert.equal(keyName({ key: 'ArrowLeft' }), 'left arrow');
  assert.equal(keyName({ key: 'A' }), 'a');

  const json = JSON.stringify(single((B) => [B.set('a', 1)], { vars: { a: 0 } }));
  assert.ok(compile(new Uint8Array(Buffer.from(json))).code.length > 0);
  assert.ok(compile(new Uint8Array(Buffer.from(json)).buffer).code.length > 0);
  assert.ok(compile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)])).code.length > 0);
});

test('a clone that clones itself from "when I start as a clone" cannot freeze a frame forever', () => {
  const B = new Blocks();
  const myself = () => ({ raw: [1, B.add('control_create_clone_of_menu', {}, { CLONE_OPTION: ['_myself_', null] }, { shadow: true })] });
  B.flag([B.s('control_create_clone_of', { CLONE_OPTION: myself() })]);
  B.script('control_start_as_clone', [B.s('control_create_clone_of', { CLONE_OPTION: myself() }), B.s('control_delete_this_clone')]);
  const { api } = load(project({}, [target('S', B)]));
  const rt = api.createRuntime({ clock: 'virtual', maxSteps: 3000 });
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    rt.greenFlag();
    for (let i = 0; i < 3; i++) rt.step(); // would never return without the guard
  } finally { console.warn = warn; }
  assert.equal(rt.frame, 3);
  assert.equal(warned, 1, 'warns once');
  assert.ok(rt.threads.length < 50, `finished threads are dropped (${rt.threads.length})`);
});
