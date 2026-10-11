'use strict';
/** Glue for the two hosts: a browser page with a <canvas>, and plain Node (headless). */
const { CanvasRenderer } = require('./renderer');
const { WebAudio } = require('./audio');

function keyName(e) {
  const k = e && e.key;
  if (typeof k !== 'string' || k === '') return ''; // e.g. autofill dispatches key events without a key
  if (k === ' ') return 'space';
  if (k.indexOf('Arrow') === 0) return `${k.slice(5).toLowerCase()} arrow`;
  return k.toLowerCase();
}

/** Create a runtime bound to a canvas, wire up input, load assets and (optionally) start it. */
function mount(createRuntime, project, canvas, opts) {
  opts = opts || {};
  const renderer = new CanvasRenderer(canvas, { scale: opts.scale || 1 });
  const rt = createRuntime({
    renderer,
    audio: new WebAudio(),
    host: { ask: (q) => Promise.resolve(window.prompt(q) || '') },
  });
  const toStage = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 480 - 240, 180 - ((e.clientY - r.top) / r.height) * 360];
  };
  canvas.tabIndex = 0;
  canvas.addEventListener('mousemove', (e) => { const p = toStage(e); rt.mouseMove(p[0], p[1]); });
  canvas.addEventListener('mousedown', (e) => { const p = toStage(e); rt.mouseMove(p[0], p[1]); rt.mouseDown(); canvas.focus(); });
  window.addEventListener('mouseup', () => rt.mouseUp());
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  window.addEventListener('keydown', (e) => {
    if (typing(e)) return;
    const n = keyName(e);
    if (!n) return;
    if (document.activeElement === canvas && (n === 'space' || n.indexOf('arrow') > 0)) e.preventDefault();
    rt.pressKey(n);
  });
  window.addEventListener('keyup', (e) => { const n = keyName(e); if (n && !typing(e)) rt.releaseKey(n); });
  rt.ready = renderer.load(project).then(() => {
    renderer.draw(rt);
    if (opts.autoplay !== false) { rt.startLoop(); rt.greenFlag(); }
    return rt;
  });
  return rt;
}

/** `node project.js [--frames N] [--realtime] [--answers a,b] [--dump]` */
function runInNode(api, argv) {
  const o = { frames: 1800, realtime: false, answers: [], dump: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--frames') o.frames = parseInt(argv[++i], 10) || o.frames;
    else if (a === '--realtime') o.realtime = true;
    else if (a === '--dump') o.dump = true;
    else if (a === '--answers') o.answers = String(argv[++i] || '').split(',');
    else if (a === '-h' || a === '--help') {
      console.log('usage: node <project.js> [--frames N] [--realtime] [--answers a,b,c] [--dump]');
      return;
    }
  }
  const rt = api.createRuntime({
    clock: o.realtime ? 'real' : 'virtual',
    host: { ask: (q) => { const a = o.answers.length ? o.answers.shift() : ''; console.log(`? ${q} -> ${a}`); return a; } },
  });
  rt.on('bubble', (t, type, text) => { if (text !== '') console.log(`[${t.name}] ${type === 'think' ? '(think) ' : ''}${text}`); });
  const finish = () => {
    if (!o.dump) return;
    const out = {};
    for (const t of [rt.stage].concat(rt.targets.filter((x) => !x.isClone))) {
      const v = {};
      for (const id of Object.keys(t.vars)) v[t.sprite.variables[id][0]] = t.vars[id];
      for (const id of Object.keys(t.lists)) v[t.sprite.lists[id][0]] = t.lists[id];
      out[t.name] = v;
    }
    console.log(JSON.stringify(out, null, 2));
  };
  rt.greenFlag();
  if (!o.realtime) { rt.run({ maxFrames: o.frames }); finish(); return; }
  rt.startLoop();
  const iv = setInterval(() => {
    if (rt.threads.length === 0 || rt.frame >= o.frames) { clearInterval(iv); rt.stopLoop(); finish(); }
  }, 50);
}

module.exports = { mount, runInNode, keyName };
