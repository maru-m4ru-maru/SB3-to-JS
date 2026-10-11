'use strict';
/**
 * The built-in functions of the source language and the blocks they become.
 *
 * Every handler gets the translator `T`, the call node `e`, its argument nodes and the scope. Statement handlers return a
 * fragment ({first,last,cap}); reporter handlers return a value descriptor. See the README for the user-facing list.
 */
const { NUM, POS, WHOLE, INT, ANGLE, COLOR, TEXT, lit, isNumLit } = require('./common');

const constants = {
  MOUSE: '_mouse_', RANDOM: '_random_', EDGE: '_edge_', MYSELF: '_myself_', STAGE: '_stage_', Infinity,
};

/* ----------------------------------------------------------------------------------- argument helpers */
const menu = (menuOpcode, field, def) => ({ menu: menuOpcode, field, def });
const MENU = {
  goto: menu('motion_goto_menu', 'TO', '_random_'),
  glideto: menu('motion_glideto_menu', 'TO', '_random_'),
  towards: menu('motion_pointtowards_menu', 'TOWARDS', '_mouse_'),
  costume: menu('looks_costume', 'COSTUME', 'costume1'),
  backdrop: menu('looks_backdrops', 'BACKDROP', 'backdrop1'),
  sound: menu('sound_sounds_menu', 'SOUND_MENU', ''),
  clone: menu('control_create_clone_of_menu', 'CLONE_OPTION', '_myself_'),
  touching: menu('sensing_touchingobjectmenu', 'TOUCHINGOBJECTMENU', '_mouse_'),
  distance: menu('sensing_distancetomenu', 'DISTANCETOMENU', '_mouse_'),
  key: menu('sensing_keyoptions', 'KEY_OPTION', 'space'),
  of: menu('sensing_of_object_menu', 'OBJECT', '_stage_'),
  penParam: menu('pen_menu_colorParam', 'colorParam', 'color'),
};

const KEY_NAMES = { up: 'up arrow', down: 'down arrow', left: 'left arrow', right: 'right arrow', arrowup: 'up arrow', arrowdown: 'down arrow', arrowleft: 'left arrow', arrowright: 'right arrow', ' ': 'space', enter: 'enter' };
function scratchKey(T, node, what) {
  const raw = T.literalString(node, what || 'the key');
  const k = raw.toLowerCase();
  const name = KEY_NAMES[k] || k;
  if (/^[a-z0-9]$/.test(name) || ['space', 'up arrow', 'down arrow', 'left arrow', 'right arrow', 'any', 'enter'].includes(name)) return name;
  throw T.fail(node, `"${raw}" is not a key Scratch knows (use a letter, a digit, "space", "up arrow", "down arrow", "left arrow", "right arrow" or "any")`);
}

/** A string argument that must be one of `allowed` (case-insensitive); returns the canonical spelling. */
function oneOf(T, node, what, allowed) {
  const s = T.literalString(node, what);
  const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
  if (hit === undefined) throw T.fail(node, `${what} must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')} (got ${JSON.stringify(s)})`);
  return hit;
}

const argv = (T, args, scope) => args.map((a) => T.expr(a, scope));

/** statement with plain inputs: simple('motion_movesteps', [['STEPS', NUM]], 'steps') */
function simple(opcode, specs, sig, o) {
  return (T, e, args, scope) => {
    T.arity(e, args, specs.length, specs.length, sig);
    const ins = specs.map(([name, slot], i) => [name, T.expr(args[i], scope), slot]);
    return T.st(scope, opcode, ins, o && o.fields, o);
  };
}

/** reporter with plain inputs */
function reporter(opcode, specs, sig, ty, fields) {
  return (T, e, args, scope) => {
    T.arity(e, args, specs.length, specs.length, sig);
    const ins = specs.map(([name, slot], i) => [name, T.expr(args[i], scope), slot]);
    return T.rep(scope, opcode, ins, fields, ty);
  };
}

const noArgs = (opcode, o) => (T, e, args, scope) => {
  T.arity(e, args, 0, 0, '');
  return T.st(scope, opcode, [], o && o.fields, o);
};
const noArgRep = (opcode, ty, fields) => (T, e, args, scope) => {
  T.arity(e, args, 0, 0, '');
  return T.rep(scope, opcode, [], fields, ty);
};

const pen = (fn) => (T, e, args, scope) => { T.extensions.add('pen'); return fn(T, e, args, scope); };

/* ----------------------------------------------------------------------------------- statements */
const statements = {
  /* motion */
  move: simple('motion_movesteps', [['STEPS', NUM]], 'steps'),
  turnRight: simple('motion_turnright', [['DEGREES', NUM]], 'degrees'),
  turnLeft: simple('motion_turnleft', [['DEGREES', NUM]], 'degrees'),
  goTo(T, e, args, scope) {
    T.arity(e, args, 1, 2, 'x, y  |  target');
    if (args.length === 2) return T.st(scope, 'motion_gotoxy', [['X', T.expr(args[0], scope), NUM], ['Y', T.expr(args[1], scope), NUM]]);
    return T.st(scope, 'motion_goto', [['TO', T.expr(args[0], scope), MENU.goto]]);
  },
  glide(T, e, args, scope) {
    T.arity(e, args, 2, 3, 'secs, x, y  |  secs, target');
    const secs = ['SECS', T.expr(args[0], scope), NUM];
    if (args.length === 3) return T.st(scope, 'motion_glidesecstoxy', [secs, ['X', T.expr(args[1], scope), NUM], ['Y', T.expr(args[2], scope), NUM]]);
    return T.st(scope, 'motion_glideto', [secs, ['TO', T.expr(args[1], scope), MENU.glideto]]);
  },
  pointInDirection: simple('motion_pointindirection', [['DIRECTION', ANGLE]], 'degrees'),
  pointTowards(T, e, args, scope) {
    T.arity(e, args, 1, 1, 'target');
    return T.st(scope, 'motion_pointtowards', [['TOWARDS', T.expr(args[0], scope), MENU.towards]]);
  },
  changeX: simple('motion_changexby', [['DX', NUM]], 'dx'),
  setX: simple('motion_setx', [['X', NUM]], 'x'),
  changeY: simple('motion_changeyby', [['DY', NUM]], 'dy'),
  setY: simple('motion_sety', [['Y', NUM]], 'y'),
  bounceOnEdge: noArgs('motion_ifonedgebounce'),
  setRotationStyle(T, e, args, scope) {
    T.arity(e, args, 1, 1, "'left-right' | \"don't rotate\" | 'all around'");
    const s = oneOf(T, args[0], 'the rotation style', ['left-right', "don't rotate", 'all around']);
    return T.st(scope, 'motion_setrotationstyle', [], { STYLE: [s, null] });
  },

  /* looks */
  say(T, e, args, scope) {
    T.arity(e, args, 1, 2, 'message[, secs]');
    const msg = ['MESSAGE', T.expr(args[0], scope), TEXT];
    if (args.length === 1) return T.st(scope, 'looks_say', [msg]);
    return T.st(scope, 'looks_sayforsecs', [msg, ['SECS', T.expr(args[1], scope), NUM]]);
  },
  think(T, e, args, scope) {
    T.arity(e, args, 1, 2, 'message[, secs]');
    const msg = ['MESSAGE', T.expr(args[0], scope), TEXT];
    if (args.length === 1) return T.st(scope, 'looks_think', [msg]);
    return T.st(scope, 'looks_thinkforsecs', [msg, ['SECS', T.expr(args[1], scope), NUM]]);
  },
  switchCostume(T, e, args, scope) {
    T.arity(e, args, 1, 1, 'name | number');
    return T.st(scope, 'looks_switchcostumeto', [['COSTUME', T.expr(args[0], scope), MENU.costume]]);
  },
  nextCostume: noArgs('looks_nextcostume'),
  switchBackdrop(T, e, args, scope) {
    T.arity(e, args, 1, 1, 'name | number');
    return T.st(scope, 'looks_switchbackdropto', [['BACKDROP', T.expr(args[0], scope), MENU.backdrop]]);
  },
  switchBackdropAndWait(T, e, args, scope) {
    T.arity(e, args, 1, 1, 'name | number');
    return T.st(scope, 'looks_switchbackdroptoandwait', [['BACKDROP', T.expr(args[0], scope), MENU.backdrop]]);
  },
  nextBackdrop: noArgs('looks_nextbackdrop'),
  changeSize: simple('looks_changesizeby', [['CHANGE', NUM]], 'amount'),
  setSize: simple('looks_setsizeto', [['SIZE', NUM]], 'percent'),
  changeEffect(T, e, args, scope) {
    T.arity(e, args, 2, 2, 'effect, amount');
    const eff = oneOf(T, args[0], 'the effect', ['color', 'fisheye', 'whirl', 'pixelate', 'mosaic', 'brightness', 'ghost']).toUpperCase();
    return T.st(scope, 'looks_changeeffectby', [['CHANGE', T.expr(args[1], scope), NUM]], { EFFECT: [eff, null] });
  },
  setEffect(T, e, args, scope) {
    T.arity(e, args, 2, 2, 'effect, value');
    const eff = oneOf(T, args[0], 'the effect', ['color', 'fisheye', 'whirl', 'pixelate', 'mosaic', 'brightness', 'ghost']).toUpperCase();
    return T.st(scope, 'looks_seteffectto', [['VALUE', T.expr(args[1], scope), NUM]], { EFFECT: [eff, null] });
  },
  clearEffects: noArgs('looks_cleargraphiceffects'),
  show: noArgs('looks_show'),
  hide: noArgs('looks_hide'),
  goToFront: noArgs('looks_gotofrontback', { fields: { FRONT_BACK: ['front', null] } }),
  goToBack: noArgs('looks_gotofrontback', { fields: { FRONT_BACK: ['back', null] } }),
  goForward: simple('looks_goforwardbackwardlayers', [['NUM', INT]], 'layers', { fields: { FORWARD_BACKWARD: ['forward', null] } }),
  goBackward: simple('looks_goforwardbackwardlayers', [['NUM', INT]], 'layers', { fields: { FORWARD_BACKWARD: ['backward', null] } }),

  /* sound */
  playSound(T, e, args, scope) {
    T.arity(e, args, 1, 1, 'name');
    return T.st(scope, 'sound_play', [['SOUND_MENU', T.expr(args[0], scope), MENU.sound]]);
  },
  playSoundUntilDone(T, e, args, scope) {
    T.arity(e, args, 1, 1, 'name');
    return T.st(scope, 'sound_playuntildone', [['SOUND_MENU', T.expr(args[0], scope), MENU.sound]]);
  },
  stopAllSounds: noArgs('sound_stopallsounds'),
  changeVolume: simple('sound_changevolumeby', [['VOLUME', NUM]], 'amount'),
  setVolume: simple('sound_setvolumeto', [['VOLUME', NUM]], 'percent'),

  /* events */
  broadcast: (T, e, args, scope) => broadcastBlock(T, e, args, scope, 'event_broadcast'),
  broadcastAndWait: (T, e, args, scope) => broadcastBlock(T, e, args, scope, 'event_broadcastandwait'),

  /* control */
  wait: simple('control_wait', [['DURATION', POS]], 'secs'),
  waitUntil: simple('control_wait_until', [['CONDITION', 'bool']], 'condition'),
  repeat(T, e, args, scope) {
    T.arity(e, args, 2, 2, 'times, () => { ... }');
    const body = callback(T, args[1], scope, 'repeat');
    const f = T.st(scope, 'control_repeat', [['TIMES', T.expr(args[0], scope), WHOLE]]);
    T.substack(scope, f.first, 'SUBSTACK', body);
    return f;
  },
  forever(T, e, args, scope) {
    T.arity(e, args, 1, 1, '() => { ... }');
    const body = callback(T, args[0], scope, 'forever');
    const f = T.st(scope, 'control_forever', [], {}, { cap: true });
    f.capName = 'an endless loop';
    T.substack(scope, f.first, 'SUBSTACK', body);
    return f;
  },
  repeatUntil(T, e, args, scope) {
    T.arity(e, args, 2, 2, 'condition, () => { ... }');
    const body = callback(T, args[1], scope, 'repeatUntil');
    const f = T.st(scope, 'control_repeat_until', [['CONDITION', T.expr(args[0], scope), 'bool']]);
    T.substack(scope, f.first, 'SUBSTACK', body);
    return f;
  },
  stopAll(T, e, args, scope) {
    T.arity(e, args, 0, 0, '');
    const f = T.st(scope, 'control_stop', [], { STOP_OPTION: ['all', null] }, { cap: true, mutation: { tagName: 'mutation', children: [], hasnext: 'false' } });
    f.capName = 'stopAll()';
    return f;
  },
  stopThisScript(T, e, args, scope) {
    T.arity(e, args, 0, 0, '');
    const f = T.stopThisScript(scope);
    f.capName = 'stopThisScript()';
    return f;
  },
  stopOtherScripts(T, e, args, scope) {
    T.arity(e, args, 0, 0, '');
    const opt = scope.t.isStage ? 'other scripts in stage' : 'other scripts in sprite';
    return T.st(scope, 'control_stop', [], { STOP_OPTION: [opt, null] }, { mutation: { tagName: 'mutation', children: [], hasnext: 'true' } });
  },
  createClone(T, e, args, scope) {
    T.arity(e, args, 0, 1, '[target]');
    const v = args.length ? T.expr(args[0], scope) : lit('_myself_');
    return T.st(scope, 'control_create_clone_of', [['CLONE_OPTION', v, MENU.clone]]);
  },
  deleteClone(T, e, args, scope) {
    T.arity(e, args, 0, 0, '');
    const f = T.st(scope, 'control_delete_this_clone', [], {}, { cap: true });
    f.capName = 'deleteClone()';
    return f;
  },

  /* sensing */
  ask: simple('sensing_askandwait', [['QUESTION', TEXT]], 'question'),
  resetTimer: noArgs('sensing_resettimer'),
  setDragMode(T, e, args, scope) {
    T.arity(e, args, 1, 1, "'draggable' | 'not draggable'");
    const m = oneOf(T, args[0], 'the drag mode', ['draggable', 'not draggable']);
    return T.st(scope, 'sensing_setdragmode', [], { DRAG_MODE: [m, null] });
  },

  /* pen */
  clearPen: pen(noArgs('pen_clear')),
  penDown: pen(noArgs('pen_penDown')),
  penUp: pen(noArgs('pen_penUp')),
  stamp: pen(noArgs('pen_stamp')),
  setPenColor: pen(simple('pen_setPenColorToColor', [['COLOR', COLOR]], '"#rrggbb"')),
  setPenSize: pen(simple('pen_setPenSizeTo', [['SIZE', NUM]], 'size')),
  changePenSize: pen(simple('pen_changePenSizeBy', [['SIZE', NUM]], 'amount')),
  setPenParam: pen((T, e, args, scope) => {
    T.arity(e, args, 2, 2, "param, value   (param: 'color' | 'saturation' | 'brightness' | 'transparency')");
    return T.st(scope, 'pen_setPenColorParamTo', [['COLOR_PARAM', penParam(T, args[0], scope), MENU.penParam], ['VALUE', T.expr(args[1], scope), NUM]]);
  }),
  changePenParam: pen((T, e, args, scope) => {
    T.arity(e, args, 2, 2, "param, amount   (param: 'color' | 'saturation' | 'brightness' | 'transparency')");
    return T.st(scope, 'pen_changePenColorParamBy', [['COLOR_PARAM', penParam(T, args[0], scope), MENU.penParam], ['VALUE', T.expr(args[1], scope), NUM]]);
  }),

  /* data */
  showVariable: (T, e, args, scope) => monitorBlock(T, e, args, scope, true),
  hideVariable: (T, e, args, scope) => monitorBlock(T, e, args, scope, false),
};

function penParam(T, node, scope) {
  if (node.type === 'Literal' || node.type === 'TemplateLiteral') return lit(oneOf(T, node, 'the pen parameter', ['color', 'saturation', 'brightness', 'transparency']));
  return T.expr(node, scope);
}

function callback(T, node, scope, name) {
  if (!T.isCallback(node)) throw T.fail(node, `${name}() needs a function as its last argument, e.g. ${name}(() => { ... })`);
  return T.callbackBody(node, scope);
}

function broadcastBlock(T, e, args, scope, opcode) {
  T.arity(e, args, 1, 1, 'message');
  const store = scope.t.store;
  const id = store.create(opcode);
  const v = T.expr(args[0], scope);
  if (v.k === 'lit') {
    const b = T.broadcastRef(String(v.v));
    store.blocks[id].inputs.BROADCAST_INPUT = [1, [11, b.name, b.id]];
  } else {
    const d = T.broadcastRef('message1');
    if (v.k === 'blk') { store.blocks[v.id].parent = id; store.blocks[id].inputs.BROADCAST_INPUT = [3, v.id, [11, d.name, d.id]]; } else store.blocks[id].inputs.BROADCAST_INPUT = [3, v.k === 'var' ? [12, v.name, v.id] : [13, v.name, v.id], [11, d.name, d.id]];
  }
  return { first: id, last: id, cap: false };
}

function monitorBlock(T, e, args, scope, show) {
  T.arity(e, args, 1, 1, 'variable');
  const a = args[0];
  const b = a.type === 'Identifier' ? scope.lookup(a.name) : null;
  if (!b || (b.kind !== 'var' && b.kind !== 'list')) throw T.fail(a, `${show ? 'showVariable' : 'hideVariable'}() needs the name of a variable or list (not a value)`);
  T.monitorFor(scope.t, b);
  if (b.kind === 'list') return T.st(scope, show ? 'data_showlist' : 'data_hidelist', [], { LIST: [b.name, b.id] });
  return T.st(scope, show ? 'data_showvariable' : 'data_hidevariable', [], { VARIABLE: [b.name, b.id] });
}

/* ----------------------------------------------------------------------------------- reporters */
const mathop = (T, scope, op, v) => T.rep(scope, 'operator_mathop', [['NUM', v, NUM]], { OPERATOR: [op, null] }, 'num');
const DEG_PER_RAD = 57.29577951308232;
const RAD_PER_DEG = 0.017453292519943295;
const times = (T, scope, a, n) => T.rep(scope, 'operator_multiply', [['NUM1', a, NUM], ['NUM2', lit(n), NUM]], {}, 'num');

/** Scratch's own trig functions work in degrees. */
const degTrig = (op) => (T, e, args, scope) => {
  T.arity(e, args, 1, 1, 'degrees');
  return mathop(T, scope, op, T.expr(args[0], scope));
};

const reporters = {
  xPosition: noArgRep('motion_xposition', 'num'),
  yPosition: noArgRep('motion_yposition', 'num'),
  direction: noArgRep('motion_direction', 'num'),
  costumeNumber: noArgRep('looks_costumenumbername', 'num', { NUMBER_NAME: ['number', null] }),
  costumeName: noArgRep('looks_costumenumbername', 'str', { NUMBER_NAME: ['name', null] }),
  backdropNumber: noArgRep('looks_backdropnumbername', 'num', { NUMBER_NAME: ['number', null] }),
  backdropName: noArgRep('looks_backdropnumbername', 'str', { NUMBER_NAME: ['name', null] }),
  size: noArgRep('looks_size', 'num'),
  volume: noArgRep('sound_volume', 'num'),
  answer: noArgRep('sensing_answer', 'str'),
  timer: noArgRep('sensing_timer', 'num'),
  mouseX: noArgRep('sensing_mousex', 'num'),
  mouseY: noArgRep('sensing_mousey', 'num'),
  mouseDown: noArgRep('sensing_mousedown', 'bool'),
  daysSince2000: noArgRep('sensing_dayssince2000', 'num'),
  loudness: noArgRep('sensing_loudness', 'num'),
  username: noArgRep('sensing_username', 'str'),
  touching(T, e, args, scope) {
    T.arity(e, args, 1, 1, 'target');
    return T.rep(scope, 'sensing_touchingobject', [['TOUCHINGOBJECTMENU', T.expr(args[0], scope), MENU.touching]], {}, 'bool');
  },
  distanceTo(T, e, args, scope) {
    T.arity(e, args, 1, 1, 'target');
    return T.rep(scope, 'sensing_distanceto', [['DISTANCETOMENU', T.expr(args[0], scope), MENU.distance]], {}, 'num');
  },
  keyPressed(T, e, args, scope) {
    T.arity(e, args, 1, 1, 'key');
    const a = args[0];
    const v = a.type === 'Literal' || a.type === 'TemplateLiteral' ? lit(scratchKey(T, a)) : T.expr(a, scope);
    return T.rep(scope, 'sensing_keypressed', [['KEY_OPTION', v, MENU.key]], {}, 'bool');
  },
  attributeOf(T, e, args, scope) {
    T.arity(e, args, 2, 2, "property, object   (e.g. attributeOf('x position', 'Cat'))");
    const prop = T.literalString(args[0], 'the property');
    return T.rep(scope, 'sensing_of', [['OBJECT', T.expr(args[1], scope), MENU.of]], { PROPERTY: [prop, null] }, 'any');
  },
  current(T, e, args, scope) {
    T.arity(e, args, 1, 1, "'year' | 'month' | 'date' | 'dayofweek' | 'hour' | 'minute' | 'second'");
    const u = oneOf(T, args[0], 'the unit', ['year', 'month', 'date', 'dayofweek', 'hour', 'minute', 'second']).toUpperCase();
    return T.rep(scope, 'sensing_current', [], { CURRENTMENU: [u, null] }, 'num');
  },
  random: reporter('operator_random', [['FROM', NUM], ['TO', NUM]], 'from, to', 'num'),
  join: reporter('operator_join', [['STRING1', TEXT], ['STRING2', TEXT]], 'a, b', 'str'),
  mod: reporter('operator_mod', [['NUM1', NUM], ['NUM2', NUM]], 'a, b', 'num'),
  round: reporter('operator_round', [['NUM', NUM]], 'x', 'num'),
  contains: reporter('operator_contains', [['STRING1', TEXT], ['STRING2', TEXT]], 'text, part', 'bool'),
  letterOf: reporter('operator_letter_of', [['LETTER', WHOLE], ['STRING', TEXT]], 'n, text   (n starts at 1)', 'str'),
  sin: degTrig('sin'),
  cos: degTrig('cos'),
  tan: degTrig('tan'),
  asin: degTrig('asin'),
  acos: degTrig('acos'),
  atan: degTrig('atan'),
};

/* ----------------------------------------------------------------------------------- Math.* */
const math = {
  floor: (T, e, a, s) => { T.arity(e, a, 1, 1, 'x'); return mathop(T, s, 'floor', T.expr(a[0], s)); },
  ceil: (T, e, a, s) => { T.arity(e, a, 1, 1, 'x'); return mathop(T, s, 'ceiling', T.expr(a[0], s)); },
  abs: (T, e, a, s) => { T.arity(e, a, 1, 1, 'x'); return mathop(T, s, 'abs', T.expr(a[0], s)); },
  sqrt: (T, e, a, s) => { T.arity(e, a, 1, 1, 'x'); return mathop(T, s, 'sqrt', T.expr(a[0], s)); },
  log: (T, e, a, s) => { T.arity(e, a, 1, 1, 'x'); return mathop(T, s, 'ln', T.expr(a[0], s)); },
  log10: (T, e, a, s) => { T.arity(e, a, 1, 1, 'x'); return mathop(T, s, 'log', T.expr(a[0], s)); },
  exp: (T, e, a, s) => { T.arity(e, a, 1, 1, 'x'); return mathop(T, s, 'e ^', T.expr(a[0], s)); },
  round: (T, e, a, s) => { T.arity(e, a, 1, 1, 'x'); return T.rep(s, 'operator_round', [['NUM', T.expr(a[0], s), NUM]], {}, 'num'); },
  // JavaScript's trig functions use radians, Scratch's blocks use degrees: convert on the way in / out
  sin: (T, e, a, s) => { T.arity(e, a, 1, 1, 'radians'); return mathop(T, s, 'sin', times(T, s, T.expr(a[0], s), DEG_PER_RAD)); },
  cos: (T, e, a, s) => { T.arity(e, a, 1, 1, 'radians'); return mathop(T, s, 'cos', times(T, s, T.expr(a[0], s), DEG_PER_RAD)); },
  tan: (T, e, a, s) => { T.arity(e, a, 1, 1, 'radians'); return mathop(T, s, 'tan', times(T, s, T.expr(a[0], s), DEG_PER_RAD)); },
  asin: (T, e, a, s) => { T.arity(e, a, 1, 1, 'x'); return times(T, s, mathop(T, s, 'asin', T.expr(a[0], s)), RAD_PER_DEG); },
  acos: (T, e, a, s) => { T.arity(e, a, 1, 1, 'x'); return times(T, s, mathop(T, s, 'acos', T.expr(a[0], s)), RAD_PER_DEG); },
  atan: (T, e, a, s) => { T.arity(e, a, 1, 1, 'x'); return times(T, s, mathop(T, s, 'atan', T.expr(a[0], s)), RAD_PER_DEG); },
  random(T, e, a, s) {
    T.arity(e, a, 0, 0, '');
    // "1.0" is not an integer for Scratch, so the result is a fraction in [0, 1] instead of 0 or 1
    return T.rep(s, 'operator_random', [['FROM', lit(0), NUM], ['TO', lit('1.0'), NUM]], {}, 'num');
  },
  pow(T, e, a, s) {
    T.arity(e, a, 2, 2, 'base, exponent');
    const b = a[0];
    if (b.type === 'Literal' && b.kind === 'num' && b.value === 10) return mathop(T, s, '10 ^', T.expr(a[1], s));
    if (b.type === 'MemberExpression' && b.object.type === 'Identifier' && b.object.name === 'Math' && !b.computed && b.property.name === 'E') return mathop(T, s, 'e ^', T.expr(a[1], s));
    if (a[1].type === 'Literal' && a[1].kind === 'num' && a[1].value === 2) return T.rep(s, 'operator_multiply', [['NUM1', T.expr(b, s), NUM], ['NUM2', T.expr(b, s), NUM]], {}, 'num');
    throw T.fail(e, 'Math.pow() is only supported for base 10, base Math.E or exponent 2 (Scratch has no general power block)');
  },
};

/* ----------------------------------------------------------------------------------- list methods */
const methodStatements = {
  push(T, e, list, args, scope) {
    T.arity(e, args, 1, 99, 'item');
    return T.link(scope, args.map((a) => T.st(scope, 'data_addtolist', [['ITEM', T.expr(a, scope), TEXT]], { LIST: [list.name, list.id] })));
  },
  pop(T, e, list, args, scope) {
    T.arity(e, args, 0, 0, '');
    const last = T.rep(scope, 'data_lengthoflist', [], { LIST: [list.name, list.id] }, 'num');
    return T.st(scope, 'data_deleteoflist', [['INDEX', last, INT]], { LIST: [list.name, list.id] });
  },
  shift(T, e, list, args, scope) {
    T.arity(e, args, 0, 0, '');
    return T.st(scope, 'data_deleteoflist', [['INDEX', lit(1), INT]], { LIST: [list.name, list.id] });
  },
  unshift(T, e, list, args, scope) {
    T.arity(e, args, 1, 99, 'item');
    return T.link(scope, args.map((a, i) => T.st(scope, 'data_insertatlist', [['INDEX', lit(i + 1), INT], ['ITEM', T.expr(a, scope), TEXT]], { LIST: [list.name, list.id] })));
  },
  splice(T, e, list, args, scope) {
    T.arity(e, args, 2, 99, 'start, deleteCount, ...items');
    const dc = args[1];
    if (dc.type !== 'Literal' || dc.kind !== 'num' || dc.value < 0 || dc.value > 50 || !Number.isInteger(dc.value)) {
      throw T.fail(dc, 'splice() needs a literal delete count (0 to 50), e.g. list.splice(i, 1) or list.splice(i, 0, item)');
    }
    const frags = [];
    for (let i = 0; i < dc.value; i++) frags.push(T.st(scope, 'data_deleteoflist', [['INDEX', T.indexOf(args[0], scope), INT]], { LIST: [list.name, list.id] }));
    args.slice(2).forEach((a, i) => {
      const idx = i === 0 ? T.indexOf(args[0], scope) : T.rep(scope, 'operator_add', [['NUM1', T.indexOf(args[0], scope), NUM], ['NUM2', lit(i), NUM]], {}, 'num');
      frags.push(T.st(scope, 'data_insertatlist', [['INDEX', idx, INT], ['ITEM', T.expr(a, scope), TEXT]], { LIST: [list.name, list.id] }));
    });
    if (!frags.length) return null;
    return T.link(scope, frags);
  },
};

const methodReporters = {
  indexOf(T, e, obj, list, args, scope) {
    T.arity(e, args, 1, 1, 'item');
    if (!list) throw T.fail(e, 'indexOf() is only supported on lists (Scratch has no "position in text" block)');
    // Scratch counts from 1 and answers 0 when missing; JavaScript counts from 0 and answers -1 -> subtract one
    const pos = T.rep(scope, 'data_itemnumoflist', [['ITEM', T.expr(args[0], scope), TEXT]], { LIST: [list.name, list.id] }, 'num');
    return T.rep(scope, 'operator_subtract', [['NUM1', pos, NUM], ['NUM2', lit(1), NUM]], {}, 'num');
  },
  includes(T, e, obj, list, args, scope) {
    T.arity(e, args, 1, 1, 'item');
    if (list) return T.rep(scope, 'data_listcontainsitem', [['ITEM', T.expr(args[0], scope), TEXT]], { LIST: [list.name, list.id] }, 'bool');
    return T.rep(scope, 'operator_contains', [['STRING1', T.expr(obj, scope), TEXT], ['STRING2', T.expr(args[0], scope), TEXT]], {}, 'bool');
  },
  charAt(T, e, obj, list, args, scope) {
    T.arity(e, args, 1, 1, 'index');
    if (list) throw T.fail(e, 'charAt() is for text; use list[index] for lists');
    return T.rep(scope, 'operator_letter_of', [['LETTER', T.indexOf(args[0], scope), WHOLE], ['STRING', T.expr(obj, scope), TEXT]], {}, 'str');
  },
};

/* ----------------------------------------------------------------------------------- hats */
const hats = {
  onFlag: { args: 0, sig: '', build: (T, t) => t.store.create('event_whenflagclicked') },
  onKey: {
    args: 1, sig: "'space'",
    build: (T, t, [k]) => t.store.create('event_whenkeypressed', { fields: { KEY_OPTION: [scratchKey(T, k), null] } }),
  },
  onClick: {
    args: 0, sig: '',
    build: (T, t) => t.store.create(t.isStage ? 'event_whenstageclicked' : 'event_whenthisspriteclicked'),
  },
  onBackdrop: {
    args: 1, sig: "'backdrop name'",
    build: (T, t, [n]) => t.store.create('event_whenbackdropswitchesto', { fields: { BACKDROP: [T.literalString(n, 'the backdrop name'), null] } }),
  },
  onMessage: {
    args: 1, sig: "'message'",
    build(T, t, [m]) {
      const b = T.broadcastRef(T.literalString(m, 'the message'));
      return t.store.create('event_whenbroadcastreceived', { fields: { BROADCAST_OPTION: [b.name, b.id] } });
    },
  },
  onCloneStart: { args: 0, sig: '', spriteOnly: true, build: (T, t) => t.store.create('control_start_as_clone') },
  onTimer: {
    args: 1, sig: 'seconds',
    build(T, t, [n], scope) {
      const id = t.store.create('event_whengreaterthan', { fields: { WHENGREATERTHANMENU: ['TIMER', null] } });
      T.plug(scope, id, 'VALUE', T.expr(n, scope), NUM);
      return id;
    },
  },
  onLoudness: {
    args: 1, sig: 'level',
    build(T, t, [n], scope) {
      const id = t.store.create('event_whengreaterthan', { fields: { WHENGREATERTHANMENU: ['LOUDNESS', null] } });
      T.plug(scope, id, 'VALUE', T.expr(n, scope), NUM);
      return id;
    },
  },
};

module.exports = { constants, statements, reporters, math, methodStatements, methodReporters, hats, MENU, isNumLit, argv };
