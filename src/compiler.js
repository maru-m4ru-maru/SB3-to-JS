'use strict';
/**
 * Scratch 3 project.json  ->  JavaScript source.
 *
 * Every script becomes a generator function. Expressions carry a static type
 * (number / string / boolean / any) so casts are only emitted where they matter.
 */
const Cast = require('./runtime/cast');
const { mimeOf, imageSize } = require('./assets');

const NUM = 'n';
const STR = 's';
const BOOL = 'b';
const ANY = 'a';
const J = JSON.stringify;
const indent = (s) => s.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');

/* ------------------------------------------------------------------ expressions */
const numSrc = (n) => (n < 0 ? `(${n})` : String(n));
const isCanonicalNumber = (t) => t !== '' && !Number.isNaN(Number(t)) && String(Number(t)) === t;

function lit(value, numeric) {
  const text = value === null || value === undefined ? '' : String(value);
  if (numeric && isCanonicalNumber(text)) return { src: numSrc(Number(text)), type: NUM, lit: Number(text) };
  return { src: J(text), type: STR, lit: text };
}
const ex = (src, type) => ({ src, type });

function castNum(e) {
  if (e.type === NUM) return e.src;
  if ('lit' in e) return numSrc(Cast.toNumber(e.lit));
  if (e.type === BOOL) return `(${e.src} ? 1 : 0)`;
  return `num(${e.src})`;
}
function castStr(e) {
  if (e.type === STR) return e.src;
  if ('lit' in e) return J(String(e.lit));
  return `str(${e.src})`;
}
function castBool(e) {
  if (e.type === BOOL) return e.src;
  if ('lit' in e) return String(Cast.toBoolean(e.lit));
  return `bool(${e.src})`;
}

const parseJson = (v, fallback) => {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
};

/* ------------------------------------------------------------------ per-script context */
class Ctx {
  constructor(tc, o) {
    this.tc = tc;
    this.warp = !!o.warp;
    this.isProc = !!o.isProc;
    this.args = o.args || new Map();
  }
  uid(p) { return `_${p}${this.tc.uid++}`; }
  /** Leave the current script only. In a custom block this returns to the caller (like scratch-vm's stopThisScript). */
  get ret() { return 'return;'; }
  /** Kill the whole thread, even from inside nested custom blocks ("stop all", "delete this clone"). */
  get kill() { return this.isProc ? 'throw rt.STOP;' : 'return;'; }
  get tick() { return this.warp ? 'if (S.warpTick()) yield;' : 'yield;'; }

  input(b, name) {
    const inp = b.inputs && b.inputs[name];
    if (!inp) return null;
    const main = inp[1] !== null && inp[1] !== undefined ? inp[1] : inp[2];
    if (main === null || main === undefined) return null;
    if (Array.isArray(main)) return this.primitive(main);
    return this.reporter(main);
  }
  num(b, n) { const e = this.input(b, n); return e ? castNum(e) : '0'; }
  str(b, n) { const e = this.input(b, n); return e ? castStr(e) : '""'; }
  bool(b, n) { const e = this.input(b, n); return e ? castBool(e) : 'false'; }
  any(b, n) { const e = this.input(b, n); return e ? e.src : '""'; }
  field(b, n) { const f = b.fields && b.fields[n]; return f ? String(f[0]) : ''; }
  ref(b, n, kind) {
    const f = (b.fields && b.fields[n]) || ['', ''];
    return this.tc.varRef(kind, f[1], f[0]);
  }
  stack(b, name) {
    const inp = b.inputs && b.inputs[name];
    return inp && typeof inp[1] === 'string' ? this.tc.compileStack(inp[1], this) : '';
  }
  block(head, code) { return `${head} {${code ? `\n${indent(code)}\n` : ''}}`; }
  loop(head, code) { return this.block(head, (code ? `${code}\n` : '') + this.tick); }

  primitive(p) {
    switch (p[0]) {
      case 4: case 5: case 6: case 7: case 8: return lit(p[1], true);
      case 12: return ex(this.tc.varRef('vars', p[2], p[1]), ANY);
      case 13: return ex(`listStr(${this.tc.varRef('lists', p[2], p[1])})`, STR);
      default: return lit(p[1], false);
    }
  }

  reporter(id) {
    const b = this.tc.blocks[id];
    if (!b || Array.isArray(b)) return lit('', false);
    const h = REPORTERS[b.opcode];
    if (h) return h(b, this);
    if (b.shadow && b.fields) {
      const k = Object.keys(b.fields)[0];
      if (k) return lit(b.fields[k][0], b.opcode.indexOf('math_') === 0);
    }
    this.tc.unsupported(b.opcode);
    return lit('', false);
  }
}

/* ------------------------------------------------------------------ reporters */
const REPORTERS = {};
const R = REPORTERS;
const arith = (op) => (b, c) => ex(`(${c.num(b, 'NUM1')} ${op} ${c.num(b, 'NUM2')})`, NUM);
R.operator_add = arith('+');
R.operator_subtract = arith('-');
R.operator_multiply = arith('*');
R.operator_divide = arith('/');
R.operator_mod = (b, c) => ex(`mod(${c.num(b, 'NUM1')}, ${c.num(b, 'NUM2')})`, NUM);
R.operator_round = (b, c) => ex(`Math.round(${c.num(b, 'NUM')})`, NUM);
R.operator_random = (b, c) => ex(`random(${c.any(b, 'FROM')}, ${c.any(b, 'TO')})`, NUM);
R.operator_length = (b, c) => ex(`${c.str(b, 'STRING')}.length`, NUM);
R.operator_join = (b, c) => ex(`(${c.str(b, 'STRING1')} + ${c.str(b, 'STRING2')})`, STR);
R.operator_letter_of = (b, c) => ex(`letterOf(${c.num(b, 'LETTER')}, ${c.str(b, 'STRING')})`, STR);
R.operator_contains = (b, c) => ex(`contains(${c.str(b, 'STRING1')}, ${c.str(b, 'STRING2')})`, BOOL);
R.operator_and = (b, c) => ex(`(${c.bool(b, 'OPERAND1')} && ${c.bool(b, 'OPERAND2')})`, BOOL);
R.operator_or = (b, c) => ex(`(${c.bool(b, 'OPERAND1')} || ${c.bool(b, 'OPERAND2')})`, BOOL);
R.operator_not = (b, c) => ex(`!${c.bool(b, 'OPERAND')}`, BOOL);

function compareOp(op, native) {
  return (b, c) => {
    const x = c.input(b, 'OPERAND1') || lit('', false);
    const y = c.input(b, 'OPERAND2') || lit('', false);
    const numLit = (e) => e.type === NUM && 'lit' in e;
    if (x.type === NUM && y.type === NUM && (numLit(x) || numLit(y))) return ex(`(${x.src} ${native} ${y.src})`, BOOL);
    return ex(`(cmp(${x.src}, ${y.src}) ${op} 0)`, BOOL);
  };
}
R.operator_gt = compareOp('>', '>');
R.operator_lt = compareOp('<', '<');
R.operator_equals = compareOp('===', '===');

const MATH = {
  abs: (n) => `Math.abs(${n})`, floor: (n) => `Math.floor(${n})`, ceiling: (n) => `Math.ceil(${n})`,
  sqrt: (n) => `Math.sqrt(${n})`, sin: (n) => `sin(${n})`, cos: (n) => `cos(${n})`, tan: (n) => `tan(${n})`,
  asin: (n) => `((Math.asin(${n}) * 180) / Math.PI)`, acos: (n) => `((Math.acos(${n}) * 180) / Math.PI)`,
  atan: (n) => `((Math.atan(${n}) * 180) / Math.PI)`, ln: (n) => `Math.log(${n})`,
  log: (n) => `(Math.log(${n}) / Math.LN10)`, 'e ^': (n) => `Math.exp(${n})`, '10 ^': (n) => `Math.pow(10, ${n})`,
};
R.operator_mathop = (b, c) => {
  const f = MATH[c.field(b, 'OPERATOR')];
  return ex(f ? f(c.num(b, 'NUM')) : '0', NUM);
};

// data
R.data_variable = (b, c) => ex(c.ref(b, 'VARIABLE', 'vars'), ANY);
R.data_listcontents = (b, c) => ex(`listStr(${c.ref(b, 'LIST', 'lists')})`, STR);
R.data_itemoflist = (b, c) => ex(`listGet(${c.ref(b, 'LIST', 'lists')}, ${c.any(b, 'INDEX')})`, ANY);
R.data_itemnumoflist = (b, c) => ex(`listIndexOf(${c.ref(b, 'LIST', 'lists')}, ${c.any(b, 'ITEM')})`, NUM);
R.data_lengthoflist = (b, c) => ex(`${c.ref(b, 'LIST', 'lists')}.length`, NUM);
R.data_listcontainsitem = (b, c) => ex(`listContains(${c.ref(b, 'LIST', 'lists')}, ${c.any(b, 'ITEM')})`, BOOL);

// procedures
R.argument_reporter_string_number = (b, c) => {
  const a = c.args.get(c.field(b, 'VALUE'));
  return a ? ex(a.js, a.bool ? BOOL : ANY) : ex('0', NUM);
};
R.argument_reporter_boolean = (b, c) => {
  const a = c.args.get(c.field(b, 'VALUE'));
  return a ? ex(a.js, BOOL) : ex('false', BOOL);
};

// motion / looks / sound
R.motion_xposition = () => ex('limitPrecision(t.x)', NUM);
R.motion_yposition = () => ex('limitPrecision(t.y)', NUM);
R.motion_direction = () => ex('t.direction', NUM);
R.looks_size = () => ex('Math.round(t.size)', NUM);
R.looks_costumenumbername = (b, c) => (c.field(b, 'NUMBER_NAME') === 'name' ? ex('t.costumeName()', STR) : ex('t.costumeNumber()', NUM));
R.looks_backdropnumbername = (b, c) => (c.field(b, 'NUMBER_NAME') === 'name' ? ex('G.costumeName()', STR) : ex('G.costumeNumber()', NUM));
R.sound_volume = () => ex('t.volume', NUM);

// sensing
R.sensing_touchingobject = (b, c) => ex(`rt.touching(t, ${c.str(b, 'TOUCHINGOBJECTMENU')})`, BOOL);
R.sensing_touchingcolor = (b, c) => { c.tc.unsupported('sensing_touchingcolor (always false)'); return ex('false', BOOL); };
R.sensing_coloristouchingcolor = (b, c) => { c.tc.unsupported('sensing_coloristouchingcolor (always false)'); return ex('false', BOOL); };
R.sensing_distanceto = (b, c) => ex(`rt.distanceTo(t, ${c.str(b, 'DISTANCETOMENU')})`, NUM);
R.sensing_answer = () => ex('rt.answerText', STR);
R.sensing_keypressed = (b, c) => ex(`rt.keyDown(${c.str(b, 'KEY_OPTION')})`, BOOL);
R.sensing_mousedown = () => ex('rt.mouse.down', BOOL);
R.sensing_mousex = () => ex('rt.mouse.x', NUM);
R.sensing_mousey = () => ex('rt.mouse.y', NUM);
R.sensing_loudness = () => ex('0', NUM);
R.sensing_timer = () => ex('rt.timerSeconds()', NUM);
R.sensing_of = (b, c) => ex(`rt.attributeOf(${J(c.field(b, 'PROPERTY'))}, ${c.str(b, 'OBJECT')})`, ANY);
R.sensing_current = (b, c) => ex(`rt.current(${J(c.field(b, 'CURRENTMENU'))})`, NUM);
R.sensing_dayssince2000 = () => ex('rt.daysSince2000()', NUM);
R.sensing_username = () => ex('""', STR);
R.control_get_counter = () => ex('rt.counter', NUM);

/* ------------------------------------------------------------------ statements */
const STATEMENTS = {};
const S = STATEMENTS;

// motion
S.motion_movesteps = (b, c) => `t.move(${c.num(b, 'STEPS')});`;
S.motion_turnright = (b, c) => `t.setDirection(t.direction + ${c.num(b, 'DEGREES')});`;
S.motion_turnleft = (b, c) => `t.setDirection(t.direction - ${c.num(b, 'DEGREES')});`;
S.motion_goto = (b, c) => `rt.goTo(t, ${c.str(b, 'TO')});`;
S.motion_gotoxy = (b, c) => `t.setXY(${c.num(b, 'X')}, ${c.num(b, 'Y')});`;
S.motion_glideto = (b, c) => `yield* rt.glideTo(t, ${c.num(b, 'SECS')}, ${c.str(b, 'TO')});`;
S.motion_glidesecstoxy = (b, c) => `yield* rt.glide(t, ${c.num(b, 'SECS')}, ${c.num(b, 'X')}, ${c.num(b, 'Y')});`;
S.motion_pointindirection = (b, c) => `t.setDirection(${c.num(b, 'DIRECTION')});`;
S.motion_pointtowards = (b, c) => `rt.pointTowards(t, ${c.str(b, 'TOWARDS')});`;
S.motion_changexby = (b, c) => `t.setXY(t.x + ${c.num(b, 'DX')}, t.y);`;
S.motion_setx = (b, c) => `t.setXY(${c.num(b, 'X')}, t.y);`;
S.motion_changeyby = (b, c) => `t.setXY(t.x, t.y + ${c.num(b, 'DY')});`;
S.motion_sety = (b, c) => `t.setXY(t.x, ${c.num(b, 'Y')});`;
S.motion_ifonedgebounce = () => 't.ifOnEdgeBounce();';
S.motion_setrotationstyle = (b, c) => `t.rotationStyle = ${J(c.field(b, 'STYLE'))};`;

// looks
S.looks_sayforsecs = (b, c) => `yield* rt.bubbleFor(t, "say", ${c.any(b, 'MESSAGE')}, ${c.num(b, 'SECS')});`;
S.looks_say = (b, c) => `t.say("say", ${c.any(b, 'MESSAGE')});`;
S.looks_thinkforsecs = (b, c) => `yield* rt.bubbleFor(t, "think", ${c.any(b, 'MESSAGE')}, ${c.num(b, 'SECS')});`;
S.looks_think = (b, c) => `t.say("think", ${c.any(b, 'MESSAGE')});`;
S.looks_switchcostumeto = (b, c) => `t.switchCostume(${c.any(b, 'COSTUME')});`;
S.looks_nextcostume = () => 't.setCostume(t.currentCostume + 1);';
S.looks_switchbackdropto = (b, c) => `G.switchBackdrop(${c.any(b, 'BACKDROP')});`;
S.looks_switchbackdroptoandwait = (b, c) => `yield* rt.switchBackdropAndWait(${c.any(b, 'BACKDROP')});`;
S.looks_nextbackdrop = () => 'G.switchBackdrop("next backdrop");';
S.looks_changesizeby = (b, c) => `t.setSize(t.size + ${c.num(b, 'CHANGE')});`;
S.looks_setsizeto = (b, c) => `t.setSize(${c.num(b, 'SIZE')});`;
S.looks_changeeffectby = (b, c) => `t.changeEffect(${J(c.field(b, 'EFFECT'))}, ${c.num(b, 'CHANGE')});`;
S.looks_seteffectto = (b, c) => `t.setEffect(${J(c.field(b, 'EFFECT'))}, ${c.num(b, 'VALUE')});`;
S.looks_cleargraphiceffects = () => 't.clearEffects();';
S.looks_show = () => 't.setVisible(true);';
S.looks_hide = () => 't.setVisible(false);';
S.looks_gotofrontback = (b, c) => `rt.goToLayer(t, ${J(c.field(b, 'FRONT_BACK'))});`;
S.looks_goforwardbackwardlayers = (b, c) => `rt.moveLayers(t, ${J(c.field(b, 'FORWARD_BACKWARD'))}, ${c.num(b, 'NUM')});`;

// sound
S.sound_play = (b, c) => `rt.playSound(t, ${c.any(b, 'SOUND_MENU')});`;
S.sound_playuntildone = (b, c) => `yield* rt.playSoundUntilDone(t, ${c.any(b, 'SOUND_MENU')});`;
S.sound_stopallsounds = () => 'rt.stopAllSounds();';
S.sound_changevolumeby = (b, c) => `t.setVolume(t.volume + ${c.num(b, 'VOLUME')});`;
S.sound_setvolumeto = (b, c) => `t.setVolume(${c.num(b, 'VOLUME')});`;
S.sound_changeeffectby = () => '/* sound effects are ignored */';
S.sound_seteffectto = () => '/* sound effects are ignored */';
S.sound_cleareffects = () => '/* sound effects are ignored */';

// events
S.event_broadcast = (b, c) => `rt.broadcast(${c.str(b, 'BROADCAST_INPUT')});`;
S.event_broadcastandwait = (b, c) => `yield* rt.broadcastAndWait(${c.str(b, 'BROADCAST_INPUT')});`;

// control
S.control_wait = (b, c) => `yield* rt.wait(${c.num(b, 'DURATION')});`;
S.control_repeat = (b, c) => {
  const i = c.uid('i');
  return c.loop(`for (let ${i} = Math.round(${c.num(b, 'TIMES')}); ${i} > 0; ${i}--)`, c.stack(b, 'SUBSTACK'));
};
S.control_forever = (b, c) => c.loop('while (true)', c.stack(b, 'SUBSTACK'));
S.control_repeat_until = (b, c) => c.loop(`while (!${c.bool(b, 'CONDITION')})`, c.stack(b, 'SUBSTACK'));
S.control_while = (b, c) => c.loop(`while (${c.bool(b, 'CONDITION')})`, c.stack(b, 'SUBSTACK'));
S.control_for_each = (b, c) => {
  const i = c.uid('i');
  const v = c.ref(b, 'VARIABLE', 'vars');
  const sub = c.stack(b, 'SUBSTACK');
  return c.loop(`for (let ${i} = 1; ${i} <= ${c.num(b, 'VALUE')}; ${i}++)`, `${v} = ${i};${sub ? `\n${sub}` : ''}`);
};
S.control_wait_until = (b, c) => `while (!${c.bool(b, 'CONDITION')}) yield 1;`;
S.control_if = (b, c) => c.block(`if (${c.bool(b, 'CONDITION')})`, c.stack(b, 'SUBSTACK'));
S.control_if_else = (b, c) => {
  const head = c.block(`if (${c.bool(b, 'CONDITION')})`, c.stack(b, 'SUBSTACK'));
  const other = c.stack(b, 'SUBSTACK2');
  return `${head} else {${other ? `\n${indent(other)}\n` : ''}}`;
};
S.control_stop = (b, c) => {
  const o = c.field(b, 'STOP_OPTION');
  if (o === 'all') return `rt.stopAll();\n${c.kill}`;
  if (o === 'this script') return c.ret;
  return 'rt.stopOthers(S);';
};
S.control_create_clone_of = (b, c) => `rt.createClone(t, ${c.str(b, 'CLONE_OPTION')});`;
S.control_delete_this_clone = (b, c) => `if (t.isClone) {\n  rt.deleteClone(t);\n  ${c.kill}\n}`;
S.control_incr_counter = () => 'rt.counter++;';
S.control_clear_counter = () => 'rt.counter = 0;';
S.control_all_at_once = (b, c) => {
  const prev = c.warp;
  c.warp = true;
  const code = c.stack(b, 'SUBSTACK');
  c.warp = prev;
  return c.block('', code);
};

// sensing
S.sensing_askandwait = (b, c) => `yield* rt.ask(${c.str(b, 'QUESTION')});`;
S.sensing_resettimer = () => 'rt.resetTimer();';
S.sensing_setdragmode = (b, c) => `t.draggable = ${c.field(b, 'DRAG_MODE') === 'draggable'};`;

// data
S.data_setvariableto = (b, c) => `${c.ref(b, 'VARIABLE', 'vars')} = ${c.any(b, 'VALUE')};`;
S.data_changevariableby = (b, c) => {
  const v = c.ref(b, 'VARIABLE', 'vars');
  return `${v} = num(${v}) + ${c.num(b, 'VALUE')};`;
};
const monitorId = (b, key) => ((b.fields && b.fields[key]) || ['', ''])[1];
S.data_showvariable = (b) => `rt.setMonitorVisible(${J(monitorId(b, 'VARIABLE'))}, true);`;
S.data_hidevariable = (b) => `rt.setMonitorVisible(${J(monitorId(b, 'VARIABLE'))}, false);`;
S.data_showlist = (b) => `rt.setMonitorVisible(${J(monitorId(b, 'LIST'))}, true);`;
S.data_hidelist = (b) => `rt.setMonitorVisible(${J(monitorId(b, 'LIST'))}, false);`;
S.data_addtolist = (b, c) => `listAdd(${c.ref(b, 'LIST', 'lists')}, ${c.any(b, 'ITEM')});`;
S.data_deleteoflist = (b, c) => `listDelete(${c.ref(b, 'LIST', 'lists')}, ${c.any(b, 'INDEX')});`;
S.data_deletealloflist = (b, c) => `${c.ref(b, 'LIST', 'lists')}.length = 0;`;
S.data_insertatlist = (b, c) => `listInsert(${c.ref(b, 'LIST', 'lists')}, ${c.any(b, 'INDEX')}, ${c.any(b, 'ITEM')});`;
S.data_replaceitemoflist = (b, c) => `listReplace(${c.ref(b, 'LIST', 'lists')}, ${c.any(b, 'INDEX')}, ${c.any(b, 'ITEM')});`;

// pen
S.pen_clear = () => 'rt.penClear();';
S.pen_stamp = () => 'rt.stamp(t);';
S.pen_penDown = () => 't.penDown();';
S.pen_penUp = () => 't.penUp();';
S.pen_setPenColorToColor = (b, c) => `t.setPenColor(${c.any(b, 'COLOR')});`;
S.pen_changePenColorParamBy = (b, c) => `t.changePenParam(${c.str(b, 'COLOR_PARAM')}, ${c.num(b, 'VALUE')});`;
S.pen_setPenColorParamTo = (b, c) => `t.setPenParam(${c.str(b, 'COLOR_PARAM')}, ${c.num(b, 'VALUE')});`;
S.pen_changePenSizeBy = (b, c) => `t.setPenSize(t.pen.size + ${c.num(b, 'SIZE')});`;
S.pen_setPenSizeTo = (b, c) => `t.setPenSize(${c.num(b, 'SIZE')});`;
R.pen_menu_colorParam = (b, c) => lit(c.field(b, 'colorParam'), false);

// custom blocks
S.procedures_call = (b, c) => {
  const m = b.mutation || {};
  const def = c.tc.procs.get(m.proccode);
  if (!def) { c.tc.unsupported(`call to undefined custom block "${m.proccode}"`); return ''; }
  const warp = c.warp || def.warp;
  const fn = c.tc.procFn(m.proccode, warp);
  const ids = parseJson(m.argumentids, []);
  const args = ids.map((id, i) => {
    const e = c.input(b, id);
    if (def.argTypes[i] === 'b') return e ? castBool(e) : 'false';
    return e ? e.src : '""';
  });
  const recursive = c.tc.compiling.has(fn) && !warp;
  return `${recursive ? 'yield 2;\n' : ''}yield* ${fn}(${['S'].concat(args).join(', ')});`;
};

/* ------------------------------------------------------------------ per target */
class TargetCompiler {
  constructor(pc, tjson) {
    this.pc = pc;
    this.t = tjson;
    this.blocks = tjson.blocks || {};
    this.uid = 0;
    this.procs = new Map();
    this.procNames = new Map();
    this.procSources = [];
    this.compiling = new Set();
    this.hats = [];
    this.scriptCount = 0;
    for (const [defId, b] of Object.entries(this.blocks)) {
      if (Array.isArray(b) || b.opcode !== 'procedures_definition') continue;
      const protoId = b.inputs && b.inputs.custom_block && b.inputs.custom_block[1];
      const proto = this.blocks[protoId];
      if (!proto || !proto.mutation) continue;
      const m = proto.mutation;
      const code = m.proccode;
      this.procs.set(code, {
        defId,
        argNames: parseJson(m.argumentnames, []),
        argTypes: (code.match(/%[sb]/g) || []).map((x) => (x === '%b' ? 'b' : 's')),
        warp: m.warp === true || m.warp === 'true',
      });
    }
  }

  unsupported(what) { this.pc.warn(`${this.t.name}: unsupported ${what}`); }

  /** JS expression for the storage cell of a variable / list (creating a local one if it is missing). */
  varRef(kind, id, name) {
    const own = (this.t[kind] = this.t[kind] || {});
    const stage = this.pc.stage[kind] || {};
    const find = (bag) => (bag[id] ? id : Object.keys(bag).find((k) => bag[k][0] === name));
    let k = find(own);
    if (k !== undefined) return `${this.t.isStage ? 'G' : 't'}.${kind}[${J(k)}]`;
    k = find(stage);
    if (k !== undefined) return `G.${kind}[${J(k)}]`;
    const nid = id || `auto:${name}`;
    own[nid] = [name, kind === 'vars' || kind === 'variables' ? 0 : []];
    return `${this.t.isStage ? 'G' : 't'}.${kind}[${J(nid)}]`;
  }

  compileStack(id, ctx) {
    const out = [];
    while (id) {
      const b = this.blocks[id];
      if (!b || Array.isArray(b)) break;
      const h = STATEMENTS[b.opcode];
      if (h) { const code = h(b, ctx); if (code) out.push(code); } else {
        this.unsupported(b.opcode);
        out.push(`/* unsupported block: ${b.opcode} */`);
      }
      id = b.next;
    }
    return out.join('\n');
  }

  procFn(code, warp) {
    const key = `${code}|${warp ? 1 : 0}`;
    if (this.procNames.has(key)) return this.procNames.get(key);
    const def = this.procs.get(code);
    const name = `p${this.procNames.size}`;
    this.procNames.set(key, name);
    this.compiling.add(name);
    const args = new Map();
    def.argNames.forEach((n, i) => { if (!args.has(n)) args.set(n, { js: `a${i}`, bool: def.argTypes[i] === 'b' }); });
    const ctx = new Ctx(this, { warp, isProc: true, args });
    const body = this.compileStack(this.blocks[def.defId].next, ctx);
    const params = ['S'].concat(def.argNames.map((_, i) => `a${i}`)).join(', ');
    this.procSources.push(`function* ${name}(${params}) {\n  const t = S.target, rt = S.runtime, G = rt.stage;\n${indent(body)}\n}`);
    this.compiling.delete(name);
    return name;
  }

  hatSpec(b) {
    const f = (n) => ((b.fields && b.fields[n]) || [''])[0];
    switch (b.opcode) {
      case 'event_whenflagclicked': return { type: 'flag' };
      case 'event_whenkeypressed': return { type: 'key', key: f('KEY_OPTION') };
      case 'event_whenthisspriteclicked':
      case 'event_whenstageclicked': return { type: 'click' };
      case 'event_whenbackdropswitchesto': return { type: 'backdrop', name: f('BACKDROP').toUpperCase() };
      case 'event_whenbroadcastreceived': return { type: 'broadcast', name: f('BROADCAST_OPTION').toUpperCase() };
      case 'control_start_as_clone': return { type: 'clone' };
      case 'event_whengreaterthan': return { type: 'greater', menu: f('WHENGREATERTHANMENU').toUpperCase() };
      default: return null;
    }
  }

  compile() {
    for (const b of Object.values(this.blocks)) {
      if (Array.isArray(b) || b.parent) continue;
      const spec = this.hatSpec(b);
      if (!spec) continue;
      this.scriptCount++;
      const ctx = new Ctx(this, {});
      const props = [`type: ${J(spec.type)}`];
      if (spec.key !== undefined) props.push(`key: ${J(spec.key)}`);
      if (spec.name !== undefined) props.push(`name: ${J(spec.name)}`);
      if (spec.type === 'greater') {
        const left = spec.menu === 'LOUDNESS' ? '0' : 'rt.timerSeconds()';
        props.push(`test: function (S) {\n  const t = S.target, rt = S.runtime, G = rt.stage;\n  return ${left} > ${ctx.num(b, 'VALUE')};\n}`);
      }
      const body = this.compileStack(b.next, ctx);
      props.push(`fn: function* (S) {\n  const t = S.target, rt = S.runtime, G = rt.stage;\n${indent(body)}\n}`);
      this.hats.push(`{ ${props.join(',\n')} }`);
    }
  }
}

/* ------------------------------------------------------------------ project */
function compileProject(json, options) {
  options = options || {};
  if (!json || !Array.isArray(json.targets)) throw new Error('Invalid project.json: "targets" is missing');
  const semver = json.meta && json.meta.semver;
  if (semver && !/^3\./.test(semver)) throw new Error(`Unsupported project version ${semver} (only Scratch 3 / .sb3 is supported)`);
  const stageJson = json.targets.find((t) => t.isStage);
  if (!stageJson) throw new Error('Invalid project.json: no stage target');

  const warnings = [];
  const seen = new Set();
  const files = [];
  const pc = {
    stage: stageJson,
    warn(m) { if (!seen.has(m)) { seen.add(m); warnings.push(m); } },
  };
  for (const ext of json.extensions || []) {
    if (ext !== 'pen') pc.warn(`extension "${ext}" is not supported; its blocks are skipped`);
  }

  // sb3 calls them "variables"; the compiler addresses storage as `vars` / `lists`
  for (const t of json.targets) {
    t.variables = t.variables || {};
    t.lists = t.lists || {};
    t.vars = t.variables;
  }
  const stats = { targets: json.targets.length, scripts: 0, blocks: 0 };
  const targets = json.targets.map((t) => {
    const tc = new TargetCompiler(pc, t);
    tc.compile();
    stats.scripts += tc.scriptCount;
    stats.blocks += Object.values(t.blocks || {}).filter((b) => !Array.isArray(b)).length;
    return { data: targetData(t, options, files, pc), procs: tc.procSources, hats: tc.hats };
  });

  const monitors = (json.monitors || []).map((m) => ({
    id: m.id, mode: m.mode, opcode: m.opcode, spriteName: m.spriteName || null,
    label: (m.params && (m.params.VARIABLE || m.params.LIST)) || m.opcode,
    x: m.x || 0, y: m.y || 0, visible: !!m.visible, width: m.width || 0, height: m.height || 0,
  }));

  return {
    meta: { title: options.title || 'Scratch project', stageWidth: 480, stageHeight: 360 },
    targets, monitors, files, warnings, stats,
  };
}

function targetData(t, options, files, pc) {
  const readAsset = options.readAsset || (() => null);
  const external = options.assets === 'external';
  const dir = options.assetsDir || 'assets';
  const resolve = (a, kind) => {
    const name = a.md5ext || `${a.assetId}.${a.dataFormat}`;
    const buf = readAsset(name);
    if (!buf) { pc.warn(`${t.name}: missing ${kind} asset ${name}`); return { src: '', buf: null }; }
    if (external) {
      if (!files.some((f) => f.path === name)) files.push({ path: name, data: buf });
      return { src: `${dir}/${name}`, buf };
    }
    return { src: `data:${mimeOf(a.dataFormat)};base64,${buf.toString('base64')}`, buf };
  };
  return {
    name: t.name, isStage: !!t.isStage,
    x: t.x === undefined ? 0 : t.x, y: t.y === undefined ? 0 : t.y,
    size: t.size === undefined ? 100 : t.size, direction: t.direction === undefined ? 90 : t.direction,
    visible: t.visible === undefined ? true : t.visible, draggable: !!t.draggable,
    rotationStyle: t.rotationStyle || 'all around', currentCostume: t.currentCostume || 0,
    volume: t.volume === undefined ? 100 : t.volume, layerOrder: t.layerOrder || 0,
    costumes: (t.costumes || []).map((c) => {
      const r = resolve(c, 'costume');
      const size = r.buf ? imageSize(r.buf, c.dataFormat) : { width: 0, height: 0 };
      return {
        name: c.name, src: r.src, format: String(c.dataFormat).toLowerCase(),
        width: size.width, height: size.height,
        rotationCenterX: c.rotationCenterX || 0, rotationCenterY: c.rotationCenterY || 0,
        bitmapResolution: c.bitmapResolution || 1,
      };
    }),
    sounds: (t.sounds || []).map((s) => ({
      name: s.name, src: resolve(s, 'sound').src, format: s.dataFormat, rate: s.rate || 0, sampleCount: s.sampleCount || 0,
    })),
    variables: t.variables, lists: t.lists,
  };
}

module.exports = { compileProject };
