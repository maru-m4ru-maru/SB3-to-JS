'use strict';
/** Canvas 2D renderer (browser only). Nothing here runs unless a CanvasRenderer is constructed. */
const C = require('./cast');
const { STAGE_W, STAGE_H } = require('./target');

class CanvasRenderer {
  constructor(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.scale = opts.scale || 1;
    canvas.width = STAGE_W * this.scale;
    canvas.height = STAGE_H * this.scale;
    this.ctx = canvas.getContext('2d');
    this.penCanvas = document.createElement('canvas');
    this.penCanvas.width = canvas.width;
    this.penCanvas.height = canvas.height;
    this.pen = this.penCanvas.getContext('2d');
  }

  /** Decode every costume image once; resolves when all are ready (failures are tolerated). */
  load(project) {
    const jobs = [];
    for (const t of project.targets) {
      for (const c of t.costumes) {
        jobs.push(new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            if (c.format !== 'svg' || !c.width) { c.width = img.naturalWidth || c.width; c.height = img.naturalHeight || c.height; }
            c._img = img;
            resolve();
          };
          img.onerror = () => resolve();
          img.src = c.src;
        }));
      }
    }
    return Promise.all(jobs);
  }

  px(x, y) { return [(x + STAGE_W / 2) * this.scale, (STAGE_H / 2 - y) * this.scale]; }

  draw(rt) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawTarget(ctx, rt.stage);
    ctx.drawImage(this.penCanvas, 0, 0);
    for (const t of rt.layers) if (t.visible) this.drawTarget(ctx, t);
    for (const t of rt.layers) if (t.visible && t.bubble) this.drawBubble(ctx, t);
    this.drawMonitors(ctx, rt);
  }

  drawTarget(ctx, t) {
    const c = t.costume;
    if (!c || !c._img) return;
    const k = this.scale;
    const res = c.bitmapResolution || 1;
    const s = t.isStage ? 1 : t.size / 100;
    const [px, py] = this.px(t.x, t.y);
    ctx.save();
    ctx.globalAlpha = 1 - C.clamp(t.effects.ghost, 0, 100) / 100;
    const filters = [];
    if (t.effects.brightness) filters.push(`brightness(${100 + t.effects.brightness}%)`);
    if (t.effects.color) filters.push(`hue-rotate(${t.effects.color * 1.8}deg)`);
    if (filters.length) ctx.filter = filters.join(' ');
    ctx.translate(px, py);
    if (!t.isStage) {
      if (t.rotationStyle === 'all around') ctx.rotate(C.degToRad(t.direction - 90));
      else if (t.rotationStyle === 'left-right' && t.direction < 0) ctx.scale(-1, 1);
    }
    ctx.scale((s * k) / res, (s * k) / res);
    ctx.drawImage(c._img, -c.rotationCenterX, -c.rotationCenterY);
    ctx.restore();
  }

  drawBubble(ctx, t) {
    const k = this.scale;
    const b = t.bounds();
    const [ax, ay] = this.px(b.right, b.top);
    const fs = 14 * k;
    ctx.save();
    ctx.font = `${fs}px sans-serif`;
    const maxW = 170 * k;
    const lines = [];
    let line = '';
    for (const word of t.bubble.text.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxW) { lines.push(line); line = word; } else line = test;
    }
    lines.push(line);
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16 * k;
    const h = lines.length * fs * 1.2 + 12 * k;
    const x = Math.min(Math.max(ax, 0), this.canvas.width - w);
    const y = Math.min(Math.max(ay - h - 8 * k, 0), this.canvas.height - h);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,.25)';
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 12 * k); else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#575e75';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, x + 8 * k, y + 6 * k + i * fs * 1.2));
    ctx.restore();
  }

  drawMonitors(ctx, rt) {
    const k = this.scale;
    for (const m of rt.monitors) {
      if (!m.visible || (m.opcode !== 'data_variable' && m.opcode !== 'data_listcontents')) continue;
      const label = (m.spriteName ? `${m.spriteName}: ` : '') + m.label;
      const val = rt.monitorValue(m);
      ctx.save();
      ctx.font = `bold ${11 * k}px sans-serif`;
      ctx.textBaseline = 'middle';
      if (m.opcode === 'data_listcontents') {
        const items = val.slice(0, 12);
        const w = (m.width || 100) * k;
        const h = (m.height || 120) * k;
        ctx.fillStyle = '#e6f0ff'; ctx.strokeStyle = '#c9d6ea';
        ctx.fillRect(m.x * k, m.y * k, w, h); ctx.strokeRect(m.x * k, m.y * k, w, h);
        ctx.fillStyle = '#575e75';
        ctx.fillText(label, m.x * k + 6 * k, m.y * k + 10 * k);
        items.forEach((it, i) => ctx.fillText(`${i + 1}  ${it}`, m.x * k + 6 * k, m.y * k + (28 + i * 16) * k));
      } else if (m.mode === 'large') {
        const text = String(val);
        const w = ctx.measureText(text).width + 16 * k;
        ctx.fillStyle = '#ff8c1a'; ctx.fillRect(m.x * k, m.y * k, w, 24 * k);
        ctx.fillStyle = '#fff'; ctx.fillText(text, m.x * k + 8 * k, m.y * k + 12 * k);
      } else {
        const text = String(val);
        const lw = ctx.measureText(label).width + 10 * k;
        const vw = Math.max(40 * k, ctx.measureText(text).width + 12 * k);
        ctx.fillStyle = '#e6f0ff'; ctx.fillRect(m.x * k, m.y * k, lw + vw, 22 * k);
        ctx.fillStyle = '#575e75'; ctx.fillText(label, m.x * k + 5 * k, m.y * k + 11 * k);
        ctx.fillStyle = '#ff8c1a'; ctx.fillRect(m.x * k + lw, m.y * k + 2 * k, vw - 2 * k, 18 * k);
        ctx.fillStyle = '#fff'; ctx.fillText(text, m.x * k + lw + 6 * k, m.y * k + 11 * k);
      }
      ctx.restore();
    }
  }

  penLine(x0, y0, x1, y1, style, size) {
    const p = this.pen;
    const [ax, ay] = this.px(x0, y0);
    const [bx, by] = this.px(x1, y1);
    p.strokeStyle = style;
    p.lineWidth = size * this.scale;
    p.lineCap = 'round';
    p.beginPath(); p.moveTo(ax, ay); p.lineTo(bx, by); p.stroke();
  }
  penPoint(x, y, style, size) {
    const [ax, ay] = this.px(x, y);
    this.pen.fillStyle = style;
    this.pen.beginPath(); this.pen.arc(ax, ay, (size * this.scale) / 2, 0, Math.PI * 2); this.pen.fill();
  }
  penClear() { this.pen.clearRect(0, 0, this.penCanvas.width, this.penCanvas.height); }
  stamp(t) { this.drawTarget(this.pen, t); }
}

module.exports = { CanvasRenderer };
