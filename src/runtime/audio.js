'use strict';
/** Minimal HTMLAudioElement based sound player (browser only). */
class WebAudio {
  constructor() { this.playing = new Set(); }

  play(sound, volume) {
    const el = new Audio(sound.src);
    el.volume = Math.min(1, Math.max(0, volume));
    const h = { done: false, el, isDone() { return this.done; } };
    const finish = () => { h.done = true; this.playing.delete(h); };
    el.addEventListener('ended', finish);
    el.addEventListener('error', finish);
    this.playing.add(h);
    const p = el.play();
    if (p && p.catch) p.catch(finish);
    return h;
  }

  stopAll() {
    for (const h of this.playing) { h.el.pause(); h.done = true; }
    this.playing.clear();
  }
}

module.exports = { WebAudio };
