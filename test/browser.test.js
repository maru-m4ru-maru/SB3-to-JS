'use strict';
/** Smoke-test the browser-only code paths (renderer, input glue, audio) against tiny DOM mocks. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Blocks, target, project, fakePng, load } = require('./helpers');

function mockDom() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (o, k) => (k in o ? o[k] : k === 'measureText' ? (t) => ({ width: String(t).length * 7 }) : (...a) => { calls.push([k, ...a]); }),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  const makeCanvas = () => ({ width: 0, height: 0, getContext: () => ctx, addEventListener() {}, focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 360 }), dataset: {} });
  const listeners = {};
  global.window = { addEventListener: (n, f) => { listeners[n] = f; }, prompt: () => 'typed' };
  global.document = { createElement: makeCanvas, activeElement: null, readyState: 'complete', getElementById: () => null };
  global.Image = class { set src(v) { this._src = v; setTimeout(() => { this.naturalWidth = 48; this.naturalHeight = 32; this.onload(); }, 0); } };
  global.Audio = class { constructor() { this.listeners = {}; } addEventListener(n, f) { this.listeners[n] = f; } play() { setTimeout(() => this.listeners.ended && this.listeners.ended(), 0); return Promise.resolve(); } pause() {} };
  return { calls, listeners, makeCanvas, restore() { delete global.window; delete global.document; delete global.Image; delete global.Audio; } };
}

test('canvas renderer, input and monitors run without errors', async () => {
  const dom = mockDom();
  try {
    const B = new Blocks();
    B.flag([
      B.s('looks_say', { MESSAGE: 'hello world, this is a long speech bubble to wrap' }),
      B.s('pen_penDown'),
      B.s('control_repeat', { TIMES: 3, SUBSTACK: B.sub([B.s('motion_movesteps', { STEPS: 10 }), B.s('pen_stamp')]) }),
      B.s('data_showvariable', {}, { VARIABLE: ['n', 'v_n'] }),
    ]);
    B.script('event_whenthisspriteclicked', [B.change('n', 1)]);
    B.script('event_whenkeypressed', [B.change('n', 10)], { KEY_OPTION: ['right arrow', null] });
    const costume = { name: 'c', assetId: 'x', md5ext: 'x.png', dataFormat: 'png', rotationCenterX: 24, rotationCenterY: 16, bitmapResolution: 1 };
    const json = project({}, [target('S', B, { costumes: [costume], vars: { n: 0 } })]);
    json.monitors = [{ id: 'v_n', mode: 'default', opcode: 'data_variable', params: { VARIABLE: 'n' }, spriteName: 'S', x: 5, y: 5, visible: false }];
    const { api } = load(json, { readAsset: () => fakePng(48, 32) });
    const rt = api.start(dom.makeCanvas(), { scale: 1 });
    await rt.ready;
    rt.stopLoop();
    for (let i = 0; i < 6; i++) rt.step();
    rt.mouseMove(rt.targets[0].x, rt.targets[0].y); rt.mouseDown(); rt.mouseUp();
    dom.listeners.keydown({ key: 'ArrowRight', target: { tagName: 'BODY' } });
    dom.listeners.keyup({ key: 'ArrowRight', target: { tagName: 'BODY' } });
    rt.step(); rt.step();
    assert.equal(rt.targets[0].vars.v_n, 11);
    assert.ok(dom.calls.some((c) => c[0] === 'drawImage'));
    assert.ok(dom.calls.some((c) => c[0] === 'fillText'), 'bubble / monitor text was drawn');
  } finally { dom.restore(); }
});
