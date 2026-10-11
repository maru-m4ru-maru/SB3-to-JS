'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Blocks, target, project, run, val, list } = require('./helpers');

/** one-sprite project; `build(B)` returns the ids of the green-flag script body */
function single(build, opts) {
  opts = opts || {};
  const B = new Blocks();
  const body = build(B);
  if (body) B.flag(body);
  return project({}, [target('Sprite1', B, opts)]);
}
const frames = (rt) => rt.frame;

test('arithmetic, strings and comparisons follow Scratch semantics', () => {
  const rt = run(single((B) => [
    B.set('sum', B.op('operator_add', 1, B.op('operator_multiply', 2, 3))),
    B.set('mod', B.op('operator_mod', -1, 3)),
    B.set('join', B.r('operator_join', { STRING1: 'ab', STRING2: 12 })),
    B.set('letter', B.r('operator_letter_of', { LETTER: 2, STRING: 'hello' })),
    B.set('len', B.r('operator_length', { STRING: 'hello' })),
    B.set('eq', B.r('operator_equals', { OPERAND1: 'ABC', OPERAND2: 'abc' })),
    B.set('gt', B.r('operator_gt', { OPERAND1: 10, OPERAND2: 9 })),
    B.set('gtStr', B.r('operator_gt', { OPERAND1: '10', OPERAND2: 'abc' })),
    B.set('contains', B.r('operator_contains', { STRING1: 'Apple', STRING2: 'PL' })),
    B.set('sqrt', B.r('operator_mathop', { NUM: 16 }, { OPERATOR: ['sqrt', null] })),
    B.set('round', B.r('operator_round', { NUM: 2.5 })),
    B.set('tan90', B.r('operator_mathop', { NUM: 90 }, { OPERATOR: ['tan', null] })),
  ], { vars: { sum: 0, mod: 0, join: 0, letter: 0, len: 0, eq: 0, gt: 0, gtStr: 0, contains: 0, sqrt: 0, round: 0, tan90: 0 } }));
  const v = (n) => val(rt, n, 'Sprite1');
  assert.equal(v('sum'), 7);
  assert.equal(v('mod'), 2);
  assert.equal(v('join'), 'ab12');
  assert.equal(v('letter'), 'e');
  assert.equal(v('len'), 5);
  assert.equal(v('eq'), true);
  assert.equal(v('gt'), true);
  assert.equal(v('gtStr'), false); // "10" vs "abc" compares as text
  assert.equal(v('contains'), true);
  assert.equal(v('sqrt'), 4);
  assert.equal(v('round'), 3);
  assert.equal(v('tan90'), Infinity);
});

test('loops: repeat, repeat until, for each, if/else', () => {
  const rt = run(single((B) => [
    B.s('control_repeat', { TIMES: 5, SUBSTACK: B.sub([B.change('n', 2)]) }),
    B.s('control_repeat_until', {
      CONDITION: B.r('operator_gt', { OPERAND1: B.v('i'), OPERAND2: 3 }),
      SUBSTACK: B.sub([B.change('i', 1)]),
    }),
    B.s('control_for_each', { VALUE: 4, SUBSTACK: B.sub([B.change('fe', B.v('k'))]) }, { VARIABLE: ['k', 'v_k'] }),
    B.s('control_if_else', {
      CONDITION: B.r('operator_lt', { OPERAND1: B.v('n'), OPERAND2: 5 }),
      SUBSTACK: B.sub([B.set('branch', 'then')]),
      SUBSTACK2: B.sub([B.set('branch', 'else')]),
    }),
  ], { vars: { n: 0, i: 0, k: 0, fe: 0, branch: '' } }));
  assert.equal(val(rt, 'n', 'Sprite1'), 10);
  assert.equal(val(rt, 'i', 'Sprite1'), 4);
  assert.equal(val(rt, 'fe', 'Sprite1'), 10); // 1+2+3+4
  assert.equal(val(rt, 'branch', 'Sprite1'), 'else');
});

test('wait advances virtual time frame by frame', () => {
  const rt = run(single((B) => [B.s('control_wait', { DURATION: 1 }), B.set('done', 1)], { vars: { done: 0 } }));
  assert.equal(val(rt, 'done', 'Sprite1'), 1);
  assert.ok(frames(rt) >= 30 && frames(rt) <= 32, `frame=${frames(rt)}`);
});

test('visual loops take one frame per iteration, silent loops finish within a frame', () => {
  const moving = run(single((B) => [B.s('control_repeat', { TIMES: 10, SUBSTACK: B.sub([B.s('motion_movesteps', { STEPS: 10 })]) })]));
  assert.ok(frames(moving) >= 10, `moving frames=${frames(moving)}`);
  const silent = run(single((B) => [B.s('control_repeat', { TIMES: 1000, SUBSTACK: B.sub([B.change('n', 1)]) })], { vars: { n: 0 } }));
  assert.equal(val(silent, 'n', 'Sprite1'), 1000);
  assert.ok(frames(silent) <= 2, `silent frames=${frames(silent)}`);
});

test('motion: move, turn, goto, glide', () => {
  const rt = run(single((B) => [
    B.s('motion_gotoxy', { X: 10, Y: 20 }),
    B.s('motion_movesteps', { STEPS: 10 }),
    B.s('motion_turnleft', { DEGREES: 90 }),
    B.s('motion_movesteps', { STEPS: 5 }),
    B.set('x', B.r('motion_xposition')),
    B.set('y', B.r('motion_yposition')),
    B.set('dir', B.r('motion_direction')),
    B.s('motion_glidesecstoxy', { SECS: 1, X: 100, Y: 0 }),
  ], { vars: { x: 0, y: 0, dir: 0 } }));
  assert.equal(val(rt, 'x', 'Sprite1'), 20);
  assert.equal(val(rt, 'y', 'Sprite1'), 25);
  assert.equal(val(rt, 'dir', 'Sprite1'), 0);
  const s = rt.targets[0];
  assert.equal(s.x, 100);
  assert.equal(s.y, 0);
});

test('custom blocks: arguments, recursion, warp', () => {
  const B = new Blocks();
  B.proc('fact %s', ['n'], false, [
    B.s('control_if_else', {
      CONDITION: B.r('operator_lt', { OPERAND1: B.arg('n'), OPERAND2: 2 }),
      SUBSTACK: B.sub([B.set('acc', 1)]),
      SUBSTACK2: B.sub([
        B.call('fact %s', [B.op('operator_subtract', B.arg('n'), 1)]),
        B.set('acc', B.op('operator_multiply', B.v('acc'), B.arg('n'))),
      ]),
    }),
  ]);
  B.proc('count %s', ['times'], true, [
    B.s('control_repeat', { TIMES: B.arg('times'), SUBSTACK: B.sub([B.change('c', 1)]) }),
  ]);
  B.flag([B.call('fact %s', [5]), B.call('count %s', [250], true)]);
  const rt = run(project({}, [target('Sprite1', B, { vars: { acc: 0, c: 0 } })]));
  assert.equal(val(rt, 'acc', 'Sprite1'), 120);
  assert.equal(val(rt, 'c', 'Sprite1'), 250);
  // recursion yields once per level, the warp block does not
  assert.ok(frames(rt) >= 5 && frames(rt) < 20, `frames=${frames(rt)}`);
});

test('boolean custom-block arguments are cast to booleans', () => {
  const B = new Blocks();
  const flag = B.add('argument_reporter_boolean', {}, { VALUE: ['flag', null] });
  B.proc('flip %b', ['flag'], false, [B.set('out', B.r('operator_not', { OPERAND: { block: flag } }))]);
  B.flag([B.call('flip %b', [B.r('operator_gt', { OPERAND1: 3, OPERAND2: 1 })])]);
  const rt = run(project({}, [target('Sprite1', B, { vars: { out: 'x' } })]));
  assert.equal(val(rt, 'out', 'Sprite1'), false);
});

test('"stop this script" inside a custom block returns to the caller (scratch-vm stopThisScript)', () => {
  const B = new Blocks();
  B.proc('bail', [], false, [B.set('a', 'in'), B.s('control_stop', {}, { STOP_OPTION: ['this script', null] }), B.set('a', 'unreachable')]);
  B.flag([B.set('a', 1), B.call('bail', []), B.change('b', 1)]);
  const rt = run(project({}, [target('Sprite1', B, { vars: { a: 0, b: 0 } })]));
  assert.equal(val(rt, 'a', 'Sprite1'), 'in');
  assert.equal(val(rt, 'b', 'Sprite1'), 1); // the script went on after the custom block
});

test('"stop all" and "delete this clone" inside a custom block end the whole script', () => {
  const B = new Blocks();
  B.proc('halt', [], false, [B.s('control_stop', {}, { STOP_OPTION: ['all', null] })]);
  B.flag([B.set('a', 1), B.call('halt', []), B.set('a', 2)]);
  const rt = run(project({}, [target('Sprite1', B, { vars: { a: 0 } })]));
  assert.equal(val(rt, 'a', 'Sprite1'), 1);

  const C = new Blocks();
  C.proc('die', [], false, [C.s('control_delete_this_clone')]);
  C.flag([C.s('control_create_clone_of', { CLONE_OPTION: { raw: [1, C.add('control_create_clone_of_menu', {}, { CLONE_OPTION: ['_myself_', null] }, { shadow: true })] } })]);
  C.script('control_start_as_clone', [C.call('die', []), C.change('after', 1)]);
  const rt2 = run(project({ vars: { after: 0 } }, [target('Sprite1', C)]));
  assert.equal(val(rt2, 'after'), 0);
  assert.equal(rt2.targets.length, 1);
});

test('broadcast and wait resumes after receivers finish', () => {
  const A = new Blocks();
  A.flag([
    A.s('event_broadcastandwait', { BROADCAST_INPUT: { raw: [1, [11, 'go', 'm1']] } }),
    A.set('order', A.r('operator_join', { STRING1: A.v('order'), STRING2: 'A' })),
  ]);
  const Bb = new Blocks();
  Bb.script('event_whenbroadcastreceived', [
    Bb.s('control_wait', { DURATION: 0.5 }),
    Bb.s('data_setvariableto', { VALUE: 'B' }, { VARIABLE: ['order', 'v_order'] }),
  ], { BROADCAST_OPTION: ['GO', 'm1'] });
  const stage = new Blocks();
  const proj = project({ B: stage, vars: { order: '' } }, [target('A', A), target('B', Bb)]);
  const rt = run(proj);
  assert.equal(val(rt, 'order'), 'BA');
});

test('clones: start as clone hats, local variable copy, delete', () => {
  const B = new Blocks();
  B.flag([
    B.s('control_repeat', { TIMES: 3, SUBSTACK: B.sub([
      B.change('id', 1),
      B.s('control_create_clone_of', { CLONE_OPTION: { raw: [1, B.add('control_create_clone_of_menu', {}, { CLONE_OPTION: ['_myself_', null] }, { shadow: true })] } }),
    ]) }),
  ]);
  B.script('control_start_as_clone', [
    B.change('total', B.v('id')),
    B.s('control_wait', { DURATION: 0.2 }),
    B.s('control_delete_this_clone'),
  ]);
  const rt = run(project({ vars: { total: 0 } }, [target('Sprite1', B, { vars: { id: 0 } })]));
  assert.equal(val(rt, 'total'), 1 + 2 + 3);
  assert.equal(rt.targets.length, 1); // all clones deleted
});

test('lists', () => {
  const lf = (B, n) => B.listF(n);
  const rt = run(single((B) => [
    B.s('data_addtolist', { ITEM: 'a' }, lf(B, 'L')),
    B.s('data_addtolist', { ITEM: 'c' }, lf(B, 'L')),
    B.s('data_insertatlist', { INDEX: 2, ITEM: 'b' }, lf(B, 'L')),
    B.s('data_replaceitemoflist', { INDEX: 'last', ITEM: 'z' }, lf(B, 'L')),
    B.set('len', B.r('data_lengthoflist', {}, lf(B, 'L'))),
    B.set('last', B.r('data_itemoflist', { INDEX: 'last' }, lf(B, 'L'))),
    B.set('idx', B.r('data_itemnumoflist', { ITEM: 'B' }, lf(B, 'L'))),
    B.set('has', B.r('data_listcontainsitem', { ITEM: 'q' }, lf(B, 'L'))),
    B.set('text', B.r('data_listcontents', {}, lf(B, 'L'))),
    B.s('data_deleteoflist', { INDEX: 1 }, lf(B, 'L')),
  ], { vars: { len: 0, last: 0, idx: 0, has: 0, text: 0 }, lists: { L: [] } }));
  assert.deepEqual(list(rt, 'L', 'Sprite1'), ['b', 'z']);
  assert.equal(val(rt, 'len', 'Sprite1'), 3);
  assert.equal(val(rt, 'last', 'Sprite1'), 'z');
  assert.equal(val(rt, 'idx', 'Sprite1'), 2);
  assert.equal(val(rt, 'has', 'Sprite1'), false);
  assert.equal(val(rt, 'text', 'Sprite1'), 'abz');
});

test('say, ask/answer, timer, keys', () => {
  const B = new Blocks();
  B.flag([
    B.s('sensing_askandwait', { QUESTION: 'name?' }),
    B.s('looks_say', { MESSAGE: B.r('operator_join', { STRING1: 'hi ', STRING2: B.r('sensing_answer') }) }),
  ]);
  B.script('event_whenkeypressed', [B.change('presses', 1)], { KEY_OPTION: ['space', null] });
  const rt = run(project({}, [target('Sprite1', B, { vars: { presses: 0 } })]), {
    answers: ['Scratch'],
    setup: (r) => { r.on('frame', (f) => { if (f === 1) r.pressKey('space'); if (f === 2) r.releaseKey('space'); if (f === 3) r.pressKey('space'); }); },
    frames: 5,
    untilIdle: false,
  });
  assert.deepEqual(rt.said, ['Sprite1:hi Scratch']);
  assert.equal(val(rt, 'presses', 'Sprite1'), 2);
});

test('touching uses costume geometry', () => {
  const { fakePng } = require('./helpers');
  const costume = { name: 'c', assetId: 'x', md5ext: 'x.png', dataFormat: 'png', rotationCenterX: 20, rotationCenterY: 20, bitmapResolution: 1 };
  const mk = (name, x, opts) => {
    const B = new Blocks();
    if (name === 'A') {
      B.flag([B.set('hit', B.r('sensing_touchingobject', { TOUCHINGOBJECTMENU: { raw: [1, B.add('sensing_touchingobjectmenu', {}, { TOUCHINGOBJECTMENU: ['B', null] }, { shadow: true })] } }))]);
    }
    return target(name, B, Object.assign({ costumes: [costume], extra: { x, y: 0 } }, opts));
  };
  const png = fakePng(40, 40);
  const near = run(project({ vars: { hit: 'unset' } }, [mk('A', 0), mk('B', 30)]), { compile: { readAsset: () => png } });
  assert.equal(val(near, 'hit'), true);
  const far = run(project({ vars: { hit: 'unset' } }, [mk('A', 0), mk('B', 80)]), { compile: { readAsset: () => png } });
  assert.equal(val(far, 'hit'), false);
});

test('unsupported blocks produce warnings, not crashes', () => {
  const { compile } = require('../src');
  const r = compile(single((B) => [B.s('music_playNote', {}), B.set('ok', 1)], { vars: { ok: 0 } }));
  assert.ok(r.warnings.some((w) => w.includes('music_playNote')));
});
