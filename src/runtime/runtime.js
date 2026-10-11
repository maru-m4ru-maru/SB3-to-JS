'use strict';
/**
 * Scheduler + services used by compiled scripts.
 *
 * Every compiled script is a generator. A bare `yield` is a "loop tick" (the thread stays
 * active and may run again in the same frame unless a redraw was requested), `yield 1` means
 * "waiting" (wait / glide / ask ...) and `yield 2` means "sleep until the next frame".
 */
const C = require('./cast');
const { Target, STAGE_W, STAGE_H } = require('./target');

const STOP = Symbol('sb3c.stop');
const WARP_MS = 500;
// Hats that restart an already running copy of the same script (everything else is ignored while it runs).
const RESTART_HATS = new Set(['flag', 'click', 'broadcast']);
const MAX_CLONES = 300;
// Runaway guard: at most this many thread steps per frame (e.g. a clone that clones itself from "when I start as a clone").
const MAX_STEPS_PER_FRAME = 200000;
const realNow = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();

class NullRenderer {
  draw() {} penLine() {} penPoint() {} penClear() {} stamp() {}
}

class NullAudio {
  constructor(runtime) { this.runtime = runtime; }
  play(sound) {
    const rt = this.runtime;
    const ms = sound && sound.rate && sound.sampleCount ? (1000 * sound.sampleCount) / sound.rate : 0;
    const end = rt.now() + ms;
    return { isDone: () => rt.now() >= end };
  }
  stopAll() {}
}

class Thread {
  constructor(runtime, target, hat) {
    this.runtime = runtime;
    this.target = target;
    this.hat = hat;
    this.done = false;
    this.status = 0; // 0 running, 1 waiting
    this.asleep = false;
    this.warpStart = 0;
    this.gen = hat.fn(this);
  }

  /** Called by loops inside warp-mode scripts: true when the frame budget (500 ms) is used up. */
  warpTick() {
    const t = realNow();
    if (!this.warpStart) { this.warpStart = t; return false; }
    if (t - this.warpStart > WARP_MS) { this.warpStart = 0; return true; }
    return false;
  }
}

function findByNameOrIndex(list, arg) {
  if (!list.length) return null;
  if (typeof arg !== 'number') {
    const i = list.findIndex((x) => x.name === String(arg));
    if (i >= 0) return list[i];
  }
  if (typeof arg === 'number' || !(Number.isNaN(Number(arg)) || C.isWhiteSpace(arg))) {
    return list[C.wrapClamp(Math.round(Number(arg)) - 1, 0, list.length - 1)];
  }
  return null;
}

class Runtime {
  constructor(project, opts) {
    opts = opts || {};
    this.project = project;
    this.STOP = STOP;
    this.frameRate = opts.frameRate || 30;
    this.frameMs = 1000 / this.frameRate;
    this.virtualClock = opts.clock === 'virtual';
    this.maxPasses = opts.maxPasses || 5000;
    this.maxSteps = opts.maxSteps || MAX_STEPS_PER_FRAME;
    this.renderer = opts.renderer || new NullRenderer();
    this.audio = opts.audio || new NullAudio(this);
    this.host = Object.assign({ ask: () => '' }, opts.host);
    this.frame = 0;
    this.virtualTime = 0;
    this.threads = [];
    this.targets = []; // every live non-stage target, clones included
    this.layers = []; // sprites back -> front (stage is always at the back)
    this.listeners = {};
    this.keys = new Set();
    this.mouse = { x: 0, y: 0, down: false };
    this.answerText = '';
    this.counter = 0;
    this.cloneCount = 0;
    this.redrawRequested = false;
    this.dragging = null;
    this.monitors = (project.monitors || []).map((m) => Object.assign({}, m));
    this.timerStart = this.now();

    const datas = project.targets.slice().sort((a, b) => (a.layerOrder || 0) - (b.layerOrder || 0));
    for (const d of datas) {
      const t = new Target(this, d, false);
      if (d.isStage) this.stage = t;
      else { this.targets.push(t); this.layers.push(t); }
    }
    if (!this.stage) throw new Error('Project has no stage');
  }

  /* ---------------- clock / events ---------------- */
  now() { return this.virtualClock ? this.virtualTime : realNow(); }
  timerSeconds() { return (this.now() - this.timerStart) / 1000; }
  resetTimer() { this.timerStart = this.now(); }
  requestRedraw() { this.redrawRequested = true; }

  on(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); return this; }
  emit(name, ...args) { for (const fn of this.listeners[name] || []) fn(...args); }

  /* ---------------- threads ---------------- */
  executionOrder() {
    const a = [];
    for (let i = this.layers.length - 1; i >= 0; i--) a.push(this.layers[i]);
    a.push(this.stage);
    return a;
  }

  startHats(type, pred, only) {
    const started = [];
    for (const t of only ? [only] : this.executionOrder()) {
      for (const hat of t.sprite.hats) {
        if (hat.type !== type || (pred && !pred(hat))) continue;
        const th = this.startThread(t, hat);
        if (th) started.push(th);
      }
    }
    return started;
  }

  startThread(target, hat) {
    const restart = RESTART_HATS.has(hat.type);
    const idx = this.threads.findIndex((th) => !th.done && th.target === target && th.hat === hat);
    if (idx >= 0 && !restart) return null;
    const th = new Thread(this, target, hat);
    if (idx >= 0) { this.threads[idx].done = true; this.threads[idx] = th; } else this.threads.push(th);
    return th;
  }

  stopAll() {
    for (const th of this.threads) th.done = true;
    this.threads.length = 0;
    for (const t of this.targets.slice()) if (t.isClone) this.removeTarget(t);
    this.audio.stopAll();
    for (const t of this.targets) if (t.bubble) t.say('say', '');
    // like scratch-vm's onStopAll: graphic effects do not survive "stop all" / the green flag
    this.stage.clearEffects();
    for (const t of this.targets) t.clearEffects();
    this.dragging = null;
    this.emit('stopall');
  }

  stopOthers(thread) {
    for (const th of this.threads) if (th !== thread && th.target === thread.target) th.done = true;
  }

  greenFlag() {
    this.stopAll();
    this.resetTimer();
    this.stage.edge.clear();
    for (const t of this.targets) t.edge.clear();
    this.startHats('flag');
  }

  /* ---------------- frame loop ---------------- */
  step() {
    this.frame++;
    if (this.virtualClock) this.virtualTime = (this.frame * 1000) / this.frameRate;
    this.updateEdgeHats();
    this.redrawRequested = false;
    const start = realNow();
    const budget = 0.75 * this.frameMs;
    let passes = 0;
    let active;
    let first = true;
    let steps = 0;
    let runaway = false;
    do {
      active = 0;
      passes++;
      for (let i = 0; i < this.threads.length; i++) {
        // keep the list short when threads are started and finished faster than the pass advances
        if (i >= 256 && (i & 255) === 0) i = this.compactBefore(i);
        const th = this.threads[i];
        if (th.done) continue;
        if (th.target.dead) { th.done = true; continue; }
        if (th.asleep) { if (first) th.asleep = false; else continue; }
        // New threads started during this pass are run in the same pass (as in Scratch), so a script that keeps
        // starting new ones would never let the loop end. Bound the work done in one frame.
        steps++;
        if (steps > this.maxSteps || (!this.virtualClock && (steps & 63) === 0 && realNow() - start > 4 * this.frameMs)) {
          runaway = true;
          break;
        }
        this.stepThread(th);
        if (!th.done && th.status === 0 && !th.asleep) active++;
      }
      first = false;
      if (runaway) break;
      const over = this.virtualClock ? passes >= this.maxPasses : realNow() - start >= budget;
      if (over) break;
    } while (active > 0 && !this.redrawRequested);
    if (runaway && !this.warnedRunaway) {
      this.warnedRunaway = true;
      if (typeof console !== 'undefined') console.warn('[sb3c] a frame ran too many script steps and was cut short (a script that keeps starting new scripts or clones?)');
    }
    this.threads = this.threads.filter((th) => !th.done);
    this.renderer.draw(this);
    this.emit('frame', this.frame);
  }

  /** Drop finished threads in front of index `i` (order of the others is kept); returns the new cursor. */
  compactBefore(i) {
    const ts = this.threads;
    let w = 0;
    for (let r = 0; r < i; r++) if (!ts[r].done) ts[w++] = ts[r];
    if (w === i) return i;
    ts.copyWithin(w, i);
    ts.length -= i - w;
    return w;
  }

  stepThread(th) {
    th.warpStart = 0;
    let r;
    try {
      r = th.gen.next();
    } catch (e) {
      th.done = true;
      if (e !== STOP) this.reportError(e, th);
      return;
    }
    if (r.done) { th.done = true; return; }
    th.status = r.value === 1 || r.value === 2 ? 1 : 0;
    th.asleep = r.value === 2;
  }

  reportError(e, th) {
    this.emit('error', e, th);
    if (typeof console !== 'undefined') console.error(`[sb3c] error in script of "${th.target.name}":`, e);
  }

  updateEdgeHats() {
    for (const t of this.executionOrder()) {
      for (const hat of t.sprite.hats) {
        if (hat.type !== 'greater') continue;
        const now = !!hat.test({ target: t, runtime: this });
        const was = t.edge.get(hat) || false;
        t.edge.set(hat, now);
        if (now && !was) this.startThread(t, hat);
      }
    }
  }

  /** Synchronous run, mainly for headless use / tests. */
  run(opts) {
    opts = opts || {};
    const max = opts.maxFrames || 1800;
    for (let i = 0; i < max; i++) {
      this.step();
      if (opts.untilIdle !== false && this.threads.length === 0) break;
      if (opts.until && opts.until(this)) break;
    }
    return this;
  }

  startLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(), this.frameMs);
  }
  stopLoop() { clearInterval(this.timer); this.timer = null; }

  /* ---------------- helpers called by compiled code ---------------- */
  *wait(secs) {
    const end = this.now() + Math.max(0, 1000 * secs);
    do { yield 1; } while (this.now() < end);
  }

  *bubbleFor(t, type, msg, secs) {
    t.say(type, msg);
    const id = t.bubble && t.bubble.id;
    yield* this.wait(secs);
    if (t.bubble && t.bubble.id === id) t.say(type, '');
  }

  *glide(t, secs, x, y) {
    const dur = 1000 * secs;
    if (dur <= 0) { t.setXY(x, y); return; }
    const start = this.now();
    const x0 = t.x;
    const y0 = t.y;
    yield 1;
    for (;;) {
      const el = this.now() - start;
      if (el < dur) {
        const f = el / dur;
        t.setXY(x0 + (x - x0) * f, y0 + (y - y0) * f);
        yield 1;
      } else { t.setXY(x, y); return; }
    }
  }

  *glideTo(t, secs, menu) {
    const p = this.positionOf(t, menu);
    if (p) yield* this.glide(t, secs, p[0], p[1]);
  }

  positionOf(t, menu) {
    if (menu === '_mouse_') return [this.mouse.x, this.mouse.y];
    if (menu === '_random_') return [Math.round(STAGE_W * (Math.random() - 0.5)), Math.round(STAGE_H * (Math.random() - 0.5))];
    const o = this.spriteByName(String(menu));
    return o ? [o.x, o.y] : null;
  }

  goTo(t, menu) {
    const p = this.positionOf(t, menu);
    if (p) t.setXY(p[0], p[1]);
  }

  pointTowards(t, menu) {
    let x;
    let y;
    if (menu === '_random_') { t.setDirection(Math.round(Math.random() * 360) - 180); return; }
    if (menu === '_mouse_') { x = this.mouse.x; y = this.mouse.y; } else {
      const o = this.spriteByName(String(menu));
      if (!o) return;
      x = o.x; y = o.y;
    }
    t.setDirection(90 - C.radToDeg(Math.atan2(y - t.y, x - t.x)));
  }

  broadcast(name) {
    const up = String(name).toUpperCase();
    return this.startHats('broadcast', (h) => h.name === up);
  }

  *broadcastAndWait(name) {
    const started = this.broadcast(name);
    while (started.some((th) => !th.done)) yield 1;
  }

  *switchBackdropAndWait(arg) {
    const started = this.stage.switchBackdrop(arg);
    while (started.some((th) => !th.done)) yield 1;
  }

  *ask(question) {
    this.requestRedraw();
    const r = this.host.ask(String(question));
    if (r && typeof r.then === 'function') {
      let done = false;
      r.then((a) => { this.answerText = a == null ? '' : String(a); done = true; }, () => { done = true; });
      while (!done) yield 1;
    } else this.answerText = r == null ? '' : String(r);
  }

  /* ---------------- sprites / clones / layers ---------------- */
  spriteByName(name) {
    return this.targets.find((t) => !t.isClone && t.name === name) || null;
  }

  createClone(source, menu) {
    const base = menu === '_myself_' ? source : this.spriteByName(String(menu));
    if (!base || base.isStage || this.cloneCount >= MAX_CLONES) return;
    const clone = base.makeClone();
    this.cloneCount++;
    this.targets.push(clone);
    const i = this.layers.indexOf(base);
    this.layers.splice(i < 0 ? 0 : i, 0, clone);
    this.requestRedraw();
    this.startHats('clone', null, clone);
  }

  removeTarget(t) {
    t.dead = true;
    for (const th of this.threads) if (th.target === t) th.done = true;
    let i = this.targets.indexOf(t);
    if (i >= 0) this.targets.splice(i, 1);
    i = this.layers.indexOf(t);
    if (i >= 0) this.layers.splice(i, 1);
    if (t.isClone) this.cloneCount--;
    this.requestRedraw();
  }

  deleteClone(t) { if (t.isClone && !t.dead) this.removeTarget(t); }

  goToLayer(t, where) {
    const i = this.layers.indexOf(t);
    if (i < 0) return;
    this.layers.splice(i, 1);
    if (where === 'front') this.layers.push(t); else this.layers.unshift(t);
    this.requestRedraw();
  }

  moveLayers(t, dir, n) {
    const i = this.layers.indexOf(t);
    if (i < 0) return;
    const j = C.clamp(dir === 'forward' ? i + n : i - n, 0, this.layers.length - 1);
    this.layers.splice(i, 1);
    this.layers.splice(j, 0, t);
    this.requestRedraw();
  }

  /* ---------------- sensing ---------------- */
  touching(t, what) {
    if (t.isStage || !t.visible) return false;
    if (what === '_mouse_') return t.containsPoint(this.mouse.x, this.mouse.y);
    if (what === '_edge_') {
      const b = t.bounds();
      return b.left < -STAGE_W / 2 || b.right > STAGE_W / 2 || b.top > STAGE_H / 2 || b.bottom < -STAGE_H / 2;
    }
    return this.targets.some((o) => o !== t && o.name === what && o.visible && t.touchesTarget(o));
  }

  distanceTo(t, menu) {
    const p = menu === '_mouse_' ? [this.mouse.x, this.mouse.y] : (() => {
      const o = this.spriteByName(String(menu));
      return o ? [o.x, o.y] : null;
    })();
    if (!p) return 10000;
    const dx = t.x - p[0];
    const dy = t.y - p[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  keyDown(name) { return name === 'any' ? this.keys.size > 0 : this.keys.has(name); }

  attributeOf(prop, objName) {
    const o = objName === '_stage_' ? this.stage : this.spriteByName(String(objName));
    if (!o) return 0;
    if (o.isStage) {
      if (prop === 'backdrop #' || prop === 'background #') return o.costumeNumber();
      if (prop === 'backdrop name') return o.costumeName();
      if (prop === 'volume') return o.volume;
    } else {
      switch (prop) {
        case 'x position': return C.limitPrecision(o.x);
        case 'y position': return C.limitPrecision(o.y);
        case 'direction': return o.direction;
        case 'costume #': return o.costumeNumber();
        case 'costume name': return o.costumeName();
        case 'size': return o.size;
        case 'volume': return o.volume;
        default: break;
      }
    }
    const vars = o.sprite.variables || {};
    for (const id of Object.keys(vars)) if (vars[id][0] === prop) return o.vars[id];
    return 0;
  }

  current(menu) {
    const d = new Date();
    switch (String(menu).toLowerCase()) {
      case 'year': return d.getFullYear();
      case 'month': return d.getMonth() + 1;
      case 'date': return d.getDate();
      case 'dayofweek': return d.getDay() + 1;
      case 'hour': return d.getHours();
      case 'minute': return d.getMinutes();
      case 'second': return d.getSeconds();
      default: return 0;
    }
  }

  daysSince2000() {
    const start = new Date(2000, 0, 1);
    const today = new Date();
    const dst = today.getTimezoneOffset() - start.getTimezoneOffset();
    const ms = today.valueOf() - start.valueOf() + (today.getTimezoneOffset() - dst) * 60 * 1000;
    return ms / (24 * 60 * 60 * 1000);
  }

  /* ---------------- sound ---------------- */
  playSound(t, arg) {
    const s = findByNameOrIndex(t.sounds, arg);
    return s ? this.audio.play(s, t.volume / 100, t) : null;
  }
  *playSoundUntilDone(t, arg) {
    const h = this.playSound(t, arg);
    while (h && !h.isDone()) yield 1;
  }
  stopAllSounds() { this.audio.stopAll(); }

  /* ---------------- pen ---------------- */
  penClear() { this.renderer.penClear(); this.requestRedraw(); }
  stamp(t) { this.renderer.stamp(t); this.requestRedraw(); }

  /* ---------------- monitors ---------------- */
  setMonitorVisible(id, visible) {
    let m = this.monitors.find((x) => x.id === id);
    if (!m) {
      for (const t of [this.stage].concat(this.targets)) {
        const v = t.sprite.variables && t.sprite.variables[id];
        const l = t.sprite.lists && t.sprite.lists[id];
        if (v || l) {
          m = { id, mode: 'default', opcode: v ? 'data_variable' : 'data_listcontents', label: (v || l)[0], spriteName: t.isStage ? null : t.name, x: 5, y: 5, visible: false };
          this.monitors.push(m);
          break;
        }
      }
    }
    if (m) { m.visible = visible; this.requestRedraw(); }
  }

  monitorValue(m) {
    const t = m.spriteName ? this.spriteByName(m.spriteName) : this.stage;
    if (!t) return '';
    return m.opcode === 'data_listcontents' ? t.lists[m.id] || [] : t.vars[m.id];
  }

  /* ---------------- input (called by the browser adapter or by tests) ---------------- */
  pressKey(name) {
    if (!name) return;
    this.keys.add(name);
    // Always trigger the hats, even if the key is already down (OS key repeat), like scratch-vm.
    // A script that is still running from the previous press is not restarted (see RESTART_HATS).
    this.startHats('key', (h) => h.key === name || h.key === 'any');
  }
  releaseKey(name) { this.keys.delete(name); }

  mouseMove(x, y) {
    this.mouse.x = Math.round(C.clamp(x, -STAGE_W / 2, STAGE_W / 2));
    this.mouse.y = Math.round(C.clamp(y, -STAGE_H / 2, STAGE_H / 2));
    const d = this.dragging;
    if (d) {
      d.moved = true;
      d.target.setXY(this.mouse.x + d.dx, this.mouse.y + d.dy);
    }
  }

  pick(x, y) {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const t = this.layers[i];
      if (t.visible && t.containsPoint(x, y)) return t;
    }
    return null;
  }

  mouseDown() {
    this.mouse.down = true;
    const hit = this.pick(this.mouse.x, this.mouse.y);
    if (hit && hit.draggable) {
      this.goToLayer(hit, 'front');
      this.dragging = { target: hit, dx: hit.x - this.mouse.x, dy: hit.y - this.mouse.y, moved: false };
    } else this.startHats('click', null, hit || this.stage);
  }

  mouseUp() {
    this.mouse.down = false;
    const d = this.dragging;
    this.dragging = null;
    if (d && !d.moved) this.startHats('click', null, d.target);
  }
}

module.exports = { Runtime, Thread, NullRenderer, NullAudio, STOP };
