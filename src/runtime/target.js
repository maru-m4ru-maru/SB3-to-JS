'use strict';
/** A Scratch target (stage, sprite or clone): state + the geometry used for touching / fencing. */
const C = require('./cast');

const STAGE_W = 480;
const STAGE_H = 360;
const FENCE_WIDTH = 15;
const EFFECTS = ['color', 'fisheye', 'whirl', 'pixelate', 'mosaic', 'brightness', 'ghost'];
let bubbleSeq = 0;

function degenerate(poly) {
  return poly.every((p) => p[0] === poly[0][0] && p[1] === poly[0][1]);
}

/** Separating-axis test for two convex polygons. */
function polysOverlap(a, b) {
  if (degenerate(a) || degenerate(b)) return false;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const nx = p1[1] - p2[1];
      const ny = p2[0] - p1[0];
      if (!nx && !ny) continue;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const p of a) { const d = p[0] * nx + p[1] * ny; if (d < minA) minA = d; if (d > maxA) maxA = d; }
      for (const p of b) { const d = p[0] * nx + p[1] * ny; if (d < minB) minB = d; if (d > maxB) maxB = d; }
      if (maxA < minB || maxB < minA) return false;
    }
  }
  return true;
}

class Target {
  constructor(runtime, data, isClone) {
    this.runtime = runtime;
    this.sprite = data; // immutable compiled description (costumes, sounds, hats, ...)
    this.name = data.name;
    this.isStage = !!data.isStage;
    this.isClone = !!isClone;
    this.dead = false;
    this.costumes = data.costumes || [];
    this.sounds = data.sounds || [];
    this.x = data.x || 0;
    this.y = data.y || 0;
    this.direction = data.direction === undefined ? 90 : data.direction;
    this.size = data.size === undefined ? 100 : data.size;
    this.visible = data.visible === undefined ? true : !!data.visible;
    this.draggable = !!data.draggable;
    this.rotationStyle = data.rotationStyle || 'all around';
    this.currentCostume = data.currentCostume || 0;
    this.volume = data.volume === undefined ? 100 : data.volume;
    this.effects = {};
    EFFECTS.forEach((e) => { this.effects[e] = 0; });
    this.bubble = null;
    this.pen = { down: false, size: 1, hue: 66.66, saturation: 100, brightness: 100, transparency: 0 }; // Scratch's default pen is blue
    this.vars = {};
    this.lists = {};
    this.edge = new Map(); // edge-triggered hat state
    if (!isClone) {
      for (const id of Object.keys(data.variables || {})) this.vars[id] = data.variables[id][1];
      for (const id of Object.keys(data.lists || {})) this.lists[id] = data.lists[id][1].slice();
    }
    this.setCostume(this.currentCostume);
  }

  get costume() { return this.costumes[this.currentCostume] || null; }
  costumeNumber() { return this.currentCostume + 1; }
  costumeName() { return this.costume ? this.costume.name : ''; }
  redraw() { if (this.visible) this.runtime.requestRedraw(); }

  /* ---------------- motion ---------------- */
  move(steps) {
    const r = C.degToRad(90 - this.direction);
    this.setXY(this.x + steps * Math.cos(r), this.y + steps * Math.sin(r));
  }

  setXY(x, y) {
    if (this.isStage) return;
    const ox = this.x;
    const oy = this.y;
    const p = this.fenced(x, y);
    this.x = p[0];
    this.y = p[1];
    if (this.pen.down) this.runtime.renderer.penLine(ox, oy, this.x, this.y, this.penStyle(), this.pen.size);
    this.redraw();
    if (this.pen.down) this.runtime.requestRedraw();
  }

  setDirection(d) {
    if (this.isStage || !Number.isFinite(d)) return; // Scratch ignores NaN and +-Infinity
    this.direction = C.wrapClamp(d, -179, 180);
    this.redraw();
  }

  /** Keep at least a few pixels of the sprite on stage (same rule as Scratch). */
  fenced(x, y) {
    const b = this.bounds();
    const dx = x - this.x;
    const dy = y - this.y;
    const inset = Math.floor(Math.min(b.right - b.left, b.top - b.bottom) / 2);
    const sx = STAGE_W / 2 - Math.min(FENCE_WIDTH, inset);
    const sy = STAGE_H / 2 - Math.min(FENCE_WIDTH, inset);
    if (b.right + dx < -sx) x = Math.ceil(this.x - (sx + b.right));
    else if (b.left + dx > sx) x = Math.floor(this.x + (sx - b.left));
    if (b.top + dy < -sy) y = Math.ceil(this.y - (sy + b.top));
    else if (b.bottom + dy > sy) y = Math.floor(this.y + (sy - b.bottom));
    return [x, y];
  }

  ifOnEdgeBounce() {
    if (this.isStage) return;
    const b = this.bounds();
    const dists = [
      ['left', Math.max(0, STAGE_W / 2 + b.left)],
      ['top', Math.max(0, STAGE_H / 2 - b.top)],
      ['right', Math.max(0, STAGE_W / 2 - b.right)],
      ['bottom', Math.max(0, STAGE_H / 2 + b.bottom)],
    ];
    let edge = '';
    let min = Infinity;
    for (const [name, d] of dists) if (d < min) { min = d; edge = name; }
    if (min > 0) return;
    const r = C.degToRad(90 - this.direction);
    let dx = Math.cos(r);
    let dy = -Math.sin(r);
    if (edge === 'left') dx = Math.max(0.2, Math.abs(dx));
    else if (edge === 'top') dy = Math.max(0.2, Math.abs(dy));
    else if (edge === 'right') dx = 0 - Math.max(0.2, Math.abs(dx));
    else dy = 0 - Math.max(0.2, Math.abs(dy));
    this.setDirection(C.radToDeg(Math.atan2(dy, dx)) + 90);
    this.setXY(this.x, this.y);
  }

  /* ---------------- looks ---------------- */
  setVisible(v) { this.visible = !!v; this.runtime.requestRedraw(); }

  setSize(percent) {
    if (this.isStage) return;
    const c = this.costume;
    const w = c ? c.width / (c.bitmapResolution || 1) : 0;
    const h = c ? c.height / (c.bitmapResolution || 1) : 0;
    if (w > 0 && h > 0) {
      const min = Math.min(1, Math.max(5 / w, 5 / h));
      const max = Math.min((1.5 * STAGE_W) / w, (1.5 * STAGE_H) / h);
      this.size = C.clamp(percent / 100, min, max) * 100;
    } else {
      this.size = Math.max(0, percent);
    }
    this.redraw();
  }

  setCostume(i) {
    i = Math.round(i);
    if (!Number.isFinite(i)) i = 0;
    if (this.costumes.length) this.currentCostume = C.wrapClamp(i, 0, this.costumes.length - 1);
    this.redraw();
  }

  costumeIndexByName(name) {
    return this.costumes.findIndex((c) => c.name === name);
  }

  /** `switch costume to <arg>` — numbers are indices, strings are names, else numeric strings. */
  switchCostume(arg) {
    if (typeof arg === 'number') { this.setCostume(arg - 1); return; }
    const idx = this.costumeIndexByName(String(arg));
    if (idx !== -1) this.setCostume(idx);
    else if (arg === 'next costume') this.setCostume(this.currentCostume + 1);
    else if (arg === 'previous costume') this.setCostume(this.currentCostume - 1);
    else if (!(Number.isNaN(Number(arg)) || C.isWhiteSpace(arg))) this.setCostume(parseFloat(arg) - 1);
  }

  /** Stage only. Returns the "when backdrop switches to" threads that were started. */
  switchBackdrop(arg) {
    const n = this.costumes.length;
    if (typeof arg === 'number') this.setCostume(arg - 1);
    else {
      const idx = this.costumeIndexByName(String(arg));
      if (idx !== -1) this.setCostume(idx);
      else if (arg === 'next backdrop') this.setCostume(this.currentCostume + 1);
      else if (arg === 'previous backdrop') this.setCostume(this.currentCostume - 1);
      else if (arg === 'random backdrop') {
        if (n > 1) {
          let r = Math.floor(Math.random() * (n - 1));
          if (r >= this.currentCostume) r++;
          this.setCostume(r);
        }
      } else if (!(Number.isNaN(Number(arg)) || C.isWhiteSpace(arg))) this.setCostume(parseFloat(arg) - 1);
    }
    const name = this.costumeName().toUpperCase();
    return this.runtime.startHats('backdrop', (h) => h.name === name);
  }

  setEffect(name, value) {
    const e = String(name).toLowerCase();
    if (!(e in this.effects)) return;
    let v = C.toNumber(value);
    if (e === 'ghost') v = C.clamp(v, 0, 100);
    else if (e === 'brightness') v = C.clamp(v, -100, 100);
    this.effects[e] = v;
    this.redraw();
  }
  changeEffect(name, delta) {
    const e = String(name).toLowerCase();
    if (e in this.effects) this.setEffect(e, this.effects[e] + C.toNumber(delta));
  }
  clearEffects() { for (const e of EFFECTS) this.effects[e] = 0; this.redraw(); }

  say(type, text) {
    text = String(text);
    this.bubble = text === '' ? null : { type, text: text.slice(0, 330), id: ++bubbleSeq };
    this.runtime.emit('bubble', this, type, text);
    this.redraw();
  }

  setVolume(v) { this.volume = C.clamp(C.toNumber(v), 0, 100); }

  /* ---------------- geometry ---------------- */
  /** Corners of the costume rectangle in stage coordinates (y up). */
  corners() {
    const c = this.costume;
    if (!c || !c.width || !c.height) return [[this.x, this.y], [this.x, this.y], [this.x, this.y], [this.x, this.y]];
    const res = c.bitmapResolution || 1;
    const s = this.isStage ? 1 : this.size / 100;
    const flip = !this.isStage && this.rotationStyle === 'left-right' && this.direction < 0 ? -1 : 1;
    const rot = !this.isStage && this.rotationStyle === 'all around' ? C.degToRad(90 - this.direction) : 0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return [[0, 0], [c.width, 0], [c.width, c.height], [0, c.height]].map(([u, v]) => {
      const lx = ((u - c.rotationCenterX) / res) * s * flip;
      const ly = ((c.rotationCenterY - v) / res) * s;
      return [this.x + lx * cos - ly * sin, this.y + lx * sin + ly * cos];
    });
  }

  bounds() {
    const p = this.corners();
    const xs = p.map((q) => q[0]);
    const ys = p.map((q) => q[1]);
    return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
  }

  containsPoint(px, py) {
    const c = this.costume;
    if (!c || !c.width || !c.height) return false;
    const res = c.bitmapResolution || 1;
    const s = this.isStage ? 1 : this.size / 100;
    const flip = !this.isStage && this.rotationStyle === 'left-right' && this.direction < 0 ? -1 : 1;
    const rot = !this.isStage && this.rotationStyle === 'all around' ? C.degToRad(90 - this.direction) : 0;
    const dx = px - this.x;
    const dy = py - this.y;
    const lx = (dx * Math.cos(rot) + dy * Math.sin(rot)) / flip;
    const ly = -dx * Math.sin(rot) + dy * Math.cos(rot);
    const u = c.rotationCenterX + (lx * res) / s;
    const v = c.rotationCenterY - (ly * res) / s;
    return u >= 0 && u <= c.width && v >= 0 && v <= c.height;
  }

  touchesTarget(other) { return polysOverlap(this.corners(), other.corners()); }

  /* ---------------- pen ---------------- */
  penStyle() {
    const p = this.pen;
    const { r, g, b } = C.hsvToRgb(p.hue * 3.6, p.saturation / 100, p.brightness / 100);
    return `rgba(${r},${g},${b},${1 - p.transparency / 100})`;
  }
  penDown() {
    this.pen.down = true;
    this.runtime.renderer.penPoint(this.x, this.y, this.penStyle(), this.pen.size);
    this.runtime.requestRedraw();
  }
  penUp() { this.pen.down = false; }
  setPenColor(value) {
    const rgb = C.toRgb(value);
    const hsv = C.rgbToHsv(rgb);
    this.pen.hue = (hsv.h / 360) * 100;
    this.pen.saturation = hsv.s * 100;
    this.pen.brightness = hsv.v * 100;
    this.pen.transparency = rgb.a === 255 ? 0 : 100 * (1 - rgb.a / 255);
  }
  setPenParam(param, value) {
    const v = C.toNumber(value);
    const p = this.pen;
    switch (String(param)) {
      case 'color': p.hue = C.wrapClamp(v, 0, 100); break;
      case 'saturation': p.saturation = C.clamp(v, 0, 100); break;
      case 'brightness': p.brightness = C.clamp(v, 0, 100); break;
      case 'transparency': p.transparency = C.clamp(v, 0, 100); break;
      default: break;
    }
  }
  changePenParam(param, delta) {
    const key = { color: 'hue' }[param] || param;
    if (key in this.pen) this.setPenParam(param, this.pen[key] + C.toNumber(delta));
  }
  setPenSize(v) { this.pen.size = C.clamp(C.toNumber(v), 1, 1200); }

  /* ---------------- clones ---------------- */
  makeClone() {
    const c = new Target(this.runtime, this.sprite, true);
    c.x = this.x; c.y = this.y; c.direction = this.direction; c.size = this.size;
    c.visible = this.visible; c.draggable = this.draggable; c.rotationStyle = this.rotationStyle;
    c.currentCostume = this.currentCostume; c.volume = this.volume;
    Object.assign(c.effects, this.effects);
    c.pen = Object.assign({}, this.pen);
    for (const id of Object.keys(this.vars)) c.vars[id] = this.vars[id];
    for (const id of Object.keys(this.lists)) c.lists[id] = this.lists[id].slice();
    return c;
  }
}

module.exports = { Target, STAGE_W, STAGE_H, polysOverlap };
