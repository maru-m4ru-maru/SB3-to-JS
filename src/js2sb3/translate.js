'use strict';
/**
 * JavaScript AST  ->  Scratch 3 project.json.
 *
 * The source is *compiled statically*: it is never executed. Its structure is mapped onto blocks:
 *   top-level `let`            -> global (stage) variable / list
 *   sprite(...) body `let`     -> variable / list "for this sprite only"
 *   function f(a, b) { }       -> custom block (`'use warp'` = run without screen refresh)
 *   onFlag(() => { ... })      -> hat block + script
 *   if / while / for           -> control blocks, arrays -> lists, operators -> operator blocks
 */
const { CompileError } = require('./errors');
const { makeCostume, makeSound, defaultCostume } = require('./sb3assets');
const stdlib = require('./stdlib');

const { NUM, TEXT, lit, isNumLit } = require('./common');

/* ------------------------------------------------------------------------------------------ blocks */
class BlockStore {
  constructor(prefix) { this.blocks = {}; this.n = 0; this.prefix = prefix; }

  create(opcode, o) {
    o = o || {};
    const id = `${this.prefix}${(++this.n).toString(36)}`;
    const b = { opcode, next: null, parent: null, inputs: o.inputs || {}, fields: o.fields || {}, shadow: !!o.shadow, topLevel: false };
    if (o.mutation) b.mutation = o.mutation;
    this.blocks[id] = b;
    return id;
  }
}

/** Link `frags` (arrays of {first,last,cap}) into one chain. */
function chain(store, frags) {
  let out = null;
  for (const f of frags) {
    if (!f) continue;
    if (!out) { out = { first: f.first, last: f.last, cap: !!f.cap }; continue; }
    store.blocks[out.last].next = f.first;
    store.blocks[f.first].parent = out.last;
    out.last = f.last;
    out.cap = !!f.cap;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ scopes */
class Scope {
  constructor(parent, t) {
    this.parent = parent || null;
    this.t = t || (parent && parent.t) || null;
    this.fn = parent ? parent.fn : null; // the custom block being compiled (null inside a hat script)
    this.map = new Map();
  }

  lookup(name) {
    for (let s = this; s; s = s.parent) if (s.map.has(name)) return s.map.get(name);
    return null;
  }

  define(name, binding) { this.map.set(name, binding); return binding; }
  has(name) { return this.map.has(name); }
}

class TargetCtx {
  constructor(name, isStage, prefix) {
    this.name = name;
    this.isStage = isStage;
    this.store = new BlockStore(prefix);
    this.variables = {}; // id -> [name, value]
    this.lists = {}; // id -> [name, items]
    this.names = new Set(); // variable / list names already used in this target (+ all global ones)
    this.procs = new Map(); // function declaration node -> proc info
    this.procNames = new Set();
    this.queue = []; // procs whose bodies still have to be compiled
    this.nextY = 30;
    this.opts = {};
    this.costumes = [];
    this.sounds = [];
    this.scope = null;
  }
}

/* ------------------------------------------------------------------------------------------ helpers */
const litText = (v) => String(v.v);
const isTrueLiteral = (n) => (n.type === 'Literal' && n.kind === 'bool' && n.value === true);

const MATH_CONSTANTS = { PI: Math.PI, E: Math.E, LN2: Math.LN2, LN10: Math.LN10, LOG2E: Math.LOG2E, LOG10E: Math.LOG10E, SQRT2: Math.SQRT2, SQRT1_2: Math.SQRT1_2 };

class Translator {
  constructor(ast, opts) {
    this.ast = ast;
    this.opts = opts || {};
    this.filename = this.opts.filename || '';
    this.warnings = [];
    this.assets = new Map();
    this.extensions = new Set();
    this.broadcasts = new Map(); // lower-case name -> { id, name }
    this.monitors = [];
    this.varCounter = 0;
    this.projectOpts = {};
    this.stage = new TargetCtx('Stage', true, 's');
    this.sprites = [];
    this.stageDef = null;
    this.spriteDefs = [];
    this.spriteNames = new Set();
    this.usedShared = new Set();

    // scopes: builtin constants <- globals <- target <- function / block scopes
    this.rootScope = new Scope(null, null);
    for (const [k, v] of Object.entries(stdlib.constants)) this.rootScope.define(k, { kind: 'const', value: v, readonly: true });
    this.globalScope = new Scope(this.rootScope, this.stage);
  }

  fail(node, msg) { return new CompileError(msg, { line: node.line, col: node.col }, this.filename); }

  warn(node, msg) {
    const where = node && node.line ? `${this.filename || '<input>'}:${node.line}:${node.col}: ` : '';
    this.warnings.push(`${where}${msg}`);
  }

  /* ---------------------------------------------------------------- entry point */
  run() {
    this.scanTop();
    const stageDef = this.stageDef;
    this.compileTarget(this.stage, stageDef ? stageDef.body : null, stageDef ? stageDef.options : null, stageDef ? stageDef.node : null);
    this.sprites.forEach((def, i) => {
      def.t = new TargetCtx(def.name, false, `p${i + 1}_`);
      this.compileTarget(def.t, def.body, def.options, def.node);
    });
    this.checkUnusedFunctions();
    return this.buildProject();
  }

  /**
   * Top-level functions are copied into every sprite that calls them. One that nobody calls would never be compiled, so
   * its mistakes (e.g. `return 5`) would go unnoticed: compile it once into a throw-away target to report them.
   */
  checkUnusedFunctions() {
    for (const [name, b] of this.globalScope.map) {
      if (b.kind !== 'func' || this.usedShared.has(b.decl)) continue;
      const snap = { broadcasts: new Map(this.broadcasts), monitors: this.monitors.slice(), extensions: new Set(this.extensions) };
      const t = new TargetCtx('(unused)', false, 'u');
      t.scope = new Scope(this.globalScope, t);
      for (const n of this.stage.names) t.names.add(n);
      this.getProc(t, b.decl, true);
      while (t.queue.length) this.compileProc(t, t.queue.shift());
      this.broadcasts = snap.broadcasts;
      this.monitors = snap.monitors;
      this.extensions = snap.extensions;
      this.warn(b.decl.id, `function ${name}() is never called`);
    }
  }

  /* ---------------------------------------------------------------- top level */
  scanTop() {
    for (const st of this.ast.body) {
      switch (st.type) {
        case 'EmptyStatement': break;
        case 'VariableDeclaration': this.declareDeclaration(st, this.globalScope, { top: true }); break;
        case 'FunctionDeclaration':
          if (this.globalScope.has(st.id.name)) throw this.fail(st.id, `"${st.id.name}" is already declared`);
          this.globalScope.define(st.id.name, { kind: 'func', decl: st, shared: true });
          break;
        case 'ExpressionStatement': {
          const e = st.expression;
          if (st.directive !== undefined) break; // "use strict"
          if (e.type !== 'CallExpression' || e.callee.type !== 'Identifier') {
            throw this.fail(st, 'only declarations and sprite(), stage() or project() calls are allowed at the top level');
          }
          this.topCall(e);
          break;
        }
        default:
          throw this.fail(st, 'only variable / function declarations and sprite(), stage() or project() calls are allowed at the top level');
      }
    }
  }

  topCall(e) {
    const name = e.callee.name;
    const args = e.arguments;
    if (name === 'project') {
      if (args.length > 1) throw this.fail(e, 'project() takes one options object');
      this.projectOpts = args[0] ? this.staticValue(args[0]) : {};
      return;
    }
    if (name === 'sprite' || name === 'stage') {
      const fnNode = args[args.length - 1];
      if (!fnNode || (fnNode.type !== 'ArrowFunctionExpression' && fnNode.type !== 'FunctionExpression')) {
        throw this.fail(e, `${name}() needs a function as its last argument, e.g. ${name === 'sprite' ? "sprite('Cat', { x: 0 }, () => { ... })" : 'stage(() => { ... })'}`);
      }
      if (fnNode.params.length) throw this.fail(fnNode, `the function passed to ${name}() takes no parameters`);
      let nameStr = 'Stage';
      let rest = args.slice(0, -1);
      if (name === 'sprite') {
        if (!rest.length || rest[0].type !== 'Literal' || rest[0].kind !== 'str' || !rest[0].value) throw this.fail(e, 'sprite() needs a name as a string, e.g. sprite("Cat", ...)');
        nameStr = rest[0].value;
        if (nameStr === 'Stage') throw this.fail(rest[0], '"Stage" is reserved for the stage; call it with stage(...)');
        rest = rest.slice(1);
        if (this.spriteNames.has(nameStr)) throw this.fail(e, `sprite "${nameStr}" is defined twice`);
        this.spriteNames.add(nameStr);
      }
      if (rest.length > 1) throw this.fail(e, `${name}() takes ${name === 'sprite' ? 'a name, an optional options object and a function' : 'an optional options object and a function'}`);
      const options = rest[0] ? this.staticValue(rest[0]) : {};
      if (options === null || typeof options !== 'object' || Array.isArray(options)) throw this.fail(rest[0], 'the options must be an object like { x: 0, y: 0 }');
      const def = { name: nameStr, options, body: fnNode, node: e };
      if (name === 'stage') {
        if (this.stageDef) throw this.fail(e, 'stage() is defined twice');
        this.stageDef = def;
      } else this.sprites.push(def);
      return;
    }
    throw this.fail(e, `unexpected top-level call ${name}(...); only sprite(), stage() and project() are allowed here`);
  }

  /** Evaluate an object / array / literal node without running anything. */
  staticValue(n) {
    switch (n.type) {
      case 'Literal': return n.value;
      case 'TemplateLiteral':
        if (n.expressions.length) throw this.fail(n, 'this value must be a constant (no ${} here)');
        return n.quasis[0];
      case 'UnaryExpression':
        if (n.operator === '-' && n.argument.type === 'Literal' && n.argument.kind === 'num') return -n.argument.value;
        if (n.operator === '+' && n.argument.type === 'Literal' && n.argument.kind === 'num') return n.argument.value;
        break;
      case 'ArrayExpression': return n.elements.map((e) => this.staticValue(e));
      case 'ObjectExpression': {
        const o = {};
        for (const p of n.properties) o[p.key] = this.staticValue(p.value);
        return o;
      }
      case 'Identifier':
        if (n.name === 'Infinity') return Infinity;
        if (n.name === 'undefined') return null;
        break;
      default: break;
    }
    throw this.fail(n, 'this value must be a constant (a number, string, true/false, array or object literal)');
  }

  /* ---------------------------------------------------------------- variables */
  newVarId() { return `v${++this.varCounter}`; }

  /** A free Scratch variable name (unique among globals and this target's variables/lists). */
  uniqueName(t, base) {
    if (!t.names.has(base) && !this.stage.names.has(base)) return base;
    for (let i = 2; ; i++) {
      const cand = `${base}_${i}`;
      if (!t.names.has(cand) && !this.stage.names.has(cand)) return cand;
    }
  }

  /** Create the Scratch variable/list for a JS binding. */
  makeBinding(scope, nameNode, kind, initial, o) {
    const t = scope.t;
    const jsName = nameNode.name;
    if (scope.has(jsName)) throw this.fail(nameNode, `"${jsName}" is already declared in this scope`);
    const isGlobal = !!(o.top || t.isStage);
    let scratchName;
    if (o.top) {
      scratchName = jsName;
      if (this.stage.names.has(scratchName)) throw this.fail(nameNode, `a variable named "${jsName}" already exists`);
    } else scratchName = this.uniqueName(t, jsName);
    const id = this.newVarId();
    const holder = (o.top || t.isStage) ? this.stage : t;
    if (kind === 'list') holder.lists[id] = [scratchName, initial];
    else holder.variables[id] = [scratchName, initial];
    holder.names.add(scratchName);
    t.names.add(scratchName);
    if (scope.fn) scope.fn.locals++;
    // a variable that starts out as text is treated as text by + and += (like JavaScript would at that point)
    const ty = kind === 'var' && typeof initial === 'string' ? 'str' : 'any';
    return scope.define(jsName, { kind, id, name: scratchName, global: !!isGlobal, readonly: false, ty });
  }

  /** `let a = 1, b = [], c;` — at the top / sprite level the initial values must be constants. */
  declareDeclaration(st, scope, o) {
    const out = [];
    for (const d of st.declarations) {
      let init = d.init;
      const isList = init && init.type === 'ArrayExpression';
      if (o.top || o.level) {
        let value = 0;
        if (init) {
          let v;
          try { v = this.staticValue(init); } catch (e) {
            if (e instanceof CompileError) e.message += `; ${o.top ? 'top-level' : 'sprite-level'} variables start with a constant, so assign the computed value inside an event handler such as onFlag(() => { ... })`;
            throw e;
          }
          if (isList) value = v.map((x) => this.scratchConst(x, d));
          else if (v !== null && typeof v === 'object') throw this.fail(init, 'objects are not supported as values');
          else value = this.scratchConst(v, d);
        } else if (isList) value = [];
        const b = this.makeBinding(scope, d.id, isList ? 'list' : 'var', value, o);
        b.ty = !isList && init && typeof this.staticValue(init) === 'string' ? 'str' : 'any';
        if (st.kind === 'const') b.readonly = true;
        out.push({ binding: b, init: null });
      } else {
        const b = this.makeBinding(scope, d.id, isList ? 'list' : 'var', isList ? [] : 0, o);
        if (st.kind === 'const') b.readonly = true;
        out.push({ binding: b, init, decl: d });
      }
    }
    return out;
  }

  scratchConst(v, node) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return v;
    throw this.fail(node, 'only numbers, strings and booleans can be stored in variables and lists');
  }

  broadcastRef(name) {
    const key = String(name).toLowerCase();
    let b = this.broadcasts.get(key);
    if (!b) { b = { id: `m${this.broadcasts.size + 1}`, name: String(name) }; this.broadcasts.set(key, b); }
    return b;
  }

  /* ---------------------------------------------------------------- targets */
  compileTarget(t, fnNode, options, node) {
    options = options || {};
    t.opts = options;
    t.scope = new Scope(this.globalScope, t);
    for (const n of this.stage.names) t.names.add(n);
    this.loadAssets(t, options, node);
    if (!fnNode) return;

    const level = { level: true };
    const hatDefs = [];
    const body = fnNode.type === 'ArrowFunctionExpression' && fnNode.expression ? [{ type: 'ExpressionStatement', expression: fnNode.body, line: fnNode.line, col: fnNode.col }] : fnNode.body.body;
    // pass 1: declarations (hoisted so that scripts may use anything declared in the sprite)
    for (const st of body) {
      switch (st.type) {
        case 'EmptyStatement': break;
        case 'VariableDeclaration': this.declareDeclaration(st, t.scope, level); break;
        case 'FunctionDeclaration':
          if (t.scope.has(st.id.name)) throw this.fail(st.id, `"${st.id.name}" is already declared in ${t.name}`);
          t.scope.define(st.id.name, { kind: 'func', decl: st, shared: false });
          break;
        case 'ExpressionStatement':
          if (st.directive !== undefined) break;
          if (st.expression.type === 'CallExpression' && st.expression.callee.type === 'Identifier' && stdlib.hats[st.expression.callee.name]) { hatDefs.push(st.expression); break; }
          throw this.fail(st, `${t.isStage ? 'the stage' : 'a sprite'} body may only contain declarations and event handlers such as onFlag(() => { ... })`);
        default:
          throw this.fail(st, `${t.isStage ? 'the stage' : 'a sprite'} body may only contain declarations and event handlers such as onFlag(() => { ... })`);
      }
    }
    // pass 2: scripts
    for (const call of hatDefs) this.compileHat(t, call);
    // pass 3: custom blocks (declared here or shared ones that were called)
    for (const st of body) {
      if (st.type === 'FunctionDeclaration') this.getProc(t, st, false);
    }
    while (t.queue.length) this.compileProc(t, t.queue.shift());
  }

  loadAssets(t, options, node) {
    const fail = (msg) => this.fail(node || { line: 0, col: 0 }, `${t.name}: ${msg}`);
    const readFile = this.opts.readFile;
    const add = (r) => { if (!this.assets.has(r.asset.name)) this.assets.set(r.asset.name, r.asset.data); return r.record; };
    const costumes = options.costumes !== undefined ? options.costumes : [];
    if (!Array.isArray(costumes)) throw fail('"costumes" must be an array');
    t.costumes = costumes.map((c) => add(makeCostume(c, readFile, fail)));
    if (!t.costumes.length) t.costumes = [add(defaultCostume(t.isStage))];
    const sounds = options.sounds !== undefined ? options.sounds : [];
    if (!Array.isArray(sounds)) throw fail('"sounds" must be an array');
    t.sounds = sounds.map((s) => add(makeSound(s, readFile, fail)));
    const seen = new Set();
    for (const c of t.costumes) { if (seen.has(c.name)) throw fail(`two costumes are named "${c.name}"`); seen.add(c.name); }
  }

  /* ---------------------------------------------------------------- custom blocks */
  getProc(t, decl, shared) {
    if (shared && t.name !== '(unused)') this.usedShared.add(decl);
    let info = t.procs.get(decl);
    if (info) return info;
    const name = decl.id.name;
    if (t.procNames.has(name)) throw this.fail(decl.id, `a custom block named "${name}" already exists in ${t.name}`);
    t.procNames.add(name);
    const seenParam = new Set();
    const params = decl.params.map((p, i) => {
      if (seenParam.has(p.name)) throw this.fail(p, `duplicate parameter "${p.name}"`);
      seenParam.add(p.name);
      let isBool = false;
      let def = '';
      if (p.default) {
        const v = this.staticValue(p.default);
        if (typeof v === 'boolean') { isBool = true; def = String(v); } else if (v === null || typeof v === 'object') throw this.fail(p.default, 'a parameter default must be a number, string or boolean');
        else def = String(v);
      }
      return { name: p.name, isBool, def, id: `${t.store.prefix}arg${t.procs.size + 1}_${i}` };
    });
    let warp = false;
    for (const st of decl.body.body) {
      if (st.type !== 'ExpressionStatement' || st.directive === undefined) break;
      if (st.directive === 'use warp' || st.directive === 'warp') warp = true;
    }
    info = {
      decl, name, params, warp, shared: !!shared,
      proccode: [name].concat(params.map((p) => (p.isBool ? '%b' : '%s'))).join(' '),
      locals: 0, calls: new Set(),
    };
    t.procs.set(decl, info);
    t.queue.push(info);
    return info;
  }

  compileProc(t, info) {
    const store = t.store;
    // a shared (top-level) function sees only globals + its own parameters; a local one also sees the sprite's variables
    const declScope = info.shared ? new Scope(this.globalScope, t) : t.scope;
    const scope = new Scope(declScope, t);
    scope.fn = info;
    info.params.forEach((p) => scope.define(p.name, { kind: 'param', param: p, readonly: true }));

    const mutation = {
      tagName: 'mutation', children: [], proccode: info.proccode,
      argumentids: JSON.stringify(info.params.map((p) => p.id)),
      argumentnames: JSON.stringify(info.params.map((p) => p.name)),
      argumentdefaults: JSON.stringify(info.params.map((p) => p.def)),
      warp: String(info.warp),
    };
    const protoId = store.create('procedures_prototype', { shadow: true, mutation });
    for (const p of info.params) {
      const rid = store.create(p.isBool ? 'argument_reporter_boolean' : 'argument_reporter_string_number', { shadow: true, fields: { VALUE: [p.name, null] } });
      store.blocks[rid].parent = protoId;
      store.blocks[protoId].inputs[p.id] = [1, rid];
    }
    const defId = store.create('procedures_definition', { inputs: { custom_block: [1, protoId] } });
    store.blocks[protoId].parent = defId;

    const before = store.n;
    const body = this.stmts(info.decl.body.body, scope);
    if (body) { store.blocks[defId].next = body.first; store.blocks[body.first].parent = defId; }
    this.addScript(t, defId, store.n - before);
    if (info.locals && info.calls.has(info)) {
      this.warn(info.decl.id, `function ${info.name}() calls itself and uses local variables; Scratch has no stack variables, so every call shares them (parameters are safe)`);
    }
  }

  /** Position a finished top-level script in the editor. */
  addScript(t, firstId, size) {
    const b = t.store.blocks[firstId];
    b.topLevel = true;
    b.parent = null;
    b.x = 30;
    b.y = t.nextY;
    t.nextY += Math.min(Math.max(size, 1), 80) * 34 + 60;
  }

  /* ---------------------------------------------------------------- hats */
  compileHat(t, call) {
    const name = call.callee.name;
    const spec = stdlib.hats[name];
    if (spec.stageOnly && !t.isStage) throw this.fail(call, `${name}() is only available in the stage`);
    if (spec.spriteOnly && t.isStage) throw this.fail(call, `${name}() is only available in sprites`);
    const args = call.arguments;
    const fnNode = args[args.length - 1];
    const nonFn = args.slice(0, -1);
    if (!fnNode || (fnNode.type !== 'ArrowFunctionExpression' && fnNode.type !== 'FunctionExpression')) {
      throw this.fail(call, `${name}(${spec.sig}) needs a function as its last argument`);
    }
    if (nonFn.length !== spec.args) throw this.fail(call, `${name} takes ${spec.args ? `${spec.args} argument${spec.args > 1 ? 's' : ''} and ` : ''}a function: ${name}(${spec.sig})`);
    if (fnNode.params.length) throw this.fail(fnNode, `the function passed to ${name}() takes no parameters`);
    const scope = new Scope(t.scope, t);
    const store = t.store;
    const hatId = spec.build(this, t, nonFn, scope, call);
    const before = store.n;
    const body = this.callbackBody(fnNode, scope);
    if (body) { store.blocks[hatId].next = body.first; store.blocks[body.first].parent = hatId; }
    this.addScript(t, hatId, store.n - before);
  }

  /** Compile the body of an arrow / function expression used as a callback. */
  callbackBody(fnNode, scope) {
    if (fnNode.params && fnNode.params.length) throw this.fail(fnNode, 'callbacks take no parameters');
    const list = fnNode.type === 'ArrowFunctionExpression' && fnNode.expression ? [{ type: 'ExpressionStatement', expression: fnNode.body, line: fnNode.body.line, col: fnNode.body.col }] : fnNode.body.body;
    return this.stmts(list, new Scope(scope));
  }

  isCallback(n) { return n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression'); }

  /* ---------------------------------------------------------------- inputs */
  /** Put value `v` into input `name` of block `parentId`. `slot`: a primitive type, 'bool', or a menu spec. */
  plug(scope, parentId, name, v, slot) {
    const store = scope.t.store;
    const parent = store.blocks[parentId];
    const refOf = (x) => (x.k === 'var' ? [12, x.name, x.id] : [13, x.name, x.id]);
    if (slot === 'bool') {
      if (v.k === 'lit') v = this.boolLiteral(scope, v);
      if (v.k === 'blk') { store.blocks[v.id].parent = parentId; parent.inputs[name] = [2, v.id]; } else parent.inputs[name] = [2, refOf(v)];
      return;
    }
    if (slot && typeof slot === 'object') { // dropdown menu: a shadow block holds the chosen value
      const mk = (val) => {
        const m = store.create(slot.menu, { shadow: true, fields: { [slot.field]: [String(val), null] } });
        store.blocks[m].parent = parentId;
        return m;
      };
      if (v.k === 'lit') parent.inputs[name] = [1, mk(litText(v))];
      else {
        const m = mk(slot.def);
        if (v.k === 'blk') store.blocks[v.id].parent = parentId;
        parent.inputs[name] = [3, v.k === 'blk' ? v.id : refOf(v), m];
      }
      return;
    }
    if (v.k === 'lit') parent.inputs[name] = [1, [slot, litText(v)]];
    else if (v.k === 'blk') { store.blocks[v.id].parent = parentId; parent.inputs[name] = [3, v.id, [slot, '']]; } else parent.inputs[name] = [3, refOf(v), [slot, '']];
  }

  /** A literal where a condition is needed: build `1 = 1` / `1 = 0` (Scratch has no boolean literals). */
  boolLiteral(scope, v) {
    const truth = typeof v.v === 'string' ? v.v !== '' && v.v !== 'false' && v.v !== '0' ? true : v.v === 'true' : Boolean(v.v);
    return this.rep(scope, 'operator_equals', [['OPERAND1', lit(1), TEXT], ['OPERAND2', lit(truth ? 1 : 0), TEXT]], {}, 'bool');
  }

  /** New reporter block with its inputs plugged in. */
  rep(scope, opcode, ins, fields, ty) {
    const store = scope.t.store;
    const id = store.create(opcode, { fields: fields || {} });
    for (const [n, v, slot] of ins || []) this.plug(scope, id, n, v, slot);
    return { k: 'blk', id, ty: ty || 'any' };
  }

  /** New statement block -> fragment. */
  st(scope, opcode, ins, fields, o) {
    o = o || {};
    const store = scope.t.store;
    const id = store.create(opcode, { fields: fields || {}, mutation: o.mutation });
    for (const [n, v, slot] of ins || []) this.plug(scope, id, n, v, slot);
    return { first: id, last: id, cap: !!o.cap };
  }

  /** Chain statement fragments into one. */
  link(scope, frags) { return chain(scope.t.store, frags); }

  substack(scope, parentId, name, frag) {
    if (!frag) return;
    const store = scope.t.store;
    store.blocks[parentId].inputs[name] = [2, frag.first];
    store.blocks[frag.first].parent = parentId;
  }

  /* ---------------------------------------------------------------- statements */
  stmts(list, scope) {
    const store = scope.t.store;
    const frags = [];
    let capped = null;
    for (const st of list) {
      if (capped) { this.warn(st, `unreachable code after ${capped} was dropped`); break; }
      const f = this.stmt(st, scope);
      if (!f) continue;
      frags.push(f);
      if (f.cap) capped = f.capName || 'a block that ends the script';
    }
    const out = chain(store, frags);
    if (out && capped) out.capName = capped;
    return out;
  }

  blockOrStmt(n, scope) {
    if (n.type === 'BlockStatement') return this.stmts(n.body, new Scope(scope));
    return this.stmts([n], new Scope(scope));
  }

  stmt(n, scope) {
    switch (n.type) {
      case 'EmptyStatement': return null;
      case 'BlockStatement': return this.stmts(n.body, new Scope(scope));
      case 'VariableDeclaration': return this.localDeclaration(n, scope);
      case 'FunctionDeclaration': throw this.fail(n, 'function declarations are only allowed at the top level or directly inside sprite() / stage()');
      case 'ExpressionStatement': return this.exprStmt(n.expression, scope, n);
      case 'IfStatement': return this.ifStmt(n, scope);
      case 'WhileStatement': return this.whileStmt(n.test, n.body, null, scope, n);
      case 'ForStatement': return this.forStmt(n, scope);
      case 'DoWhileStatement': throw this.fail(n, 'do...while is not supported; use while (cond) { ... } (the body can be repeated before the loop if needed)');
      case 'ReturnStatement':
        if (n.argument) throw this.fail(n, 'custom blocks cannot return values in Scratch; store the result in a variable instead');
        return this.stopThisScript(scope);
      case 'BreakStatement': throw this.fail(n, '"break" is not supported (Scratch has no break); loop with while (!done) { ... } instead');
      case 'ContinueStatement': throw this.fail(n, '"continue" is not supported (Scratch has no continue); wrap the rest of the body in an if');
      default: throw this.fail(n, `${n.type} is not supported`);
    }
  }

  stopThisScript(scope) {
    return this.st(scope, 'control_stop', [], { STOP_OPTION: ['this script', null] }, { cap: true, mutation: { tagName: 'mutation', children: [], hasnext: 'false' } });
  }

  /** `let x = expr;` inside a script: a sprite variable that is (re)initialised where the declaration runs. */
  localDeclaration(n, scope) {
    const frags = [];
    for (const { binding, init, decl } of this.declareDeclaration(n, scope, {})) {
      if (binding.kind === 'list') {
        frags.push(this.replaceList(scope, binding, init, decl));
      } else if (init) {
        const v = this.expr(init, scope);
        if (v.ty === 'str') binding.ty = 'str';
        frags.push(this.setVar(scope, binding, v));
      } else frags.push(this.setVar(scope, binding, lit(0)));
    }
    return chain(scope.t.store, frags);
  }

  setVar(scope, binding, v) {
    return this.st(scope, 'data_setvariableto', [['VALUE', v, TEXT]], { VARIABLE: [binding.name, binding.id] });
  }

  listField(b) { return { LIST: [b.name, b.id] }; }

  /** `list = [a, b]` / `let list = [..]`: delete all, then add every item. */
  replaceList(scope, binding, init, node) {
    const store = scope.t.store;
    const frags = [this.st(scope, 'data_deletealloflist', [], this.listField(binding))];
    if (init) {
      if (init.type !== 'ArrayExpression') throw this.fail(init, `"${binding.name}" is a list; assign an array literal like [1, 2, 3] or use list.length = 0`);
      for (const el of init.elements) frags.push(this.st(scope, 'data_addtolist', [['ITEM', this.expr(el, scope), TEXT]], this.listField(binding)));
    }
    void node;
    return chain(store, frags);
  }

  lookupVar(scope, id) {
    const b = scope.lookup(id.name);
    if (!b) throw this.fail(id, `"${id.name}" is not declared (declare it with let)`);
    return b;
  }

  /* ---- expression statements */
  exprStmt(e, scope, stNode) {
    switch (e.type) {
      case 'AssignmentExpression': return this.assignStmt(e, scope);
      case 'UpdateExpression': return this.updateStmt(e, scope);
      case 'CallExpression': return this.callStmt(e, scope);
      case 'SequenceExpression': return chain(scope.t.store, e.expressions.map((x) => this.exprStmt(x, scope, stNode)));
      case 'Literal': case 'TemplateLiteral':
        if (stNode && stNode.directive !== undefined) return null; // a directive such as 'use warp'
        this.warn(e, 'this statement has no effect');
        return null;
      default:
        throw this.fail(e, 'this expression cannot be used as a statement (use an assignment, a call or ++ / --)');
    }
  }

  isListTarget(node, scope) {
    return node.type === 'Identifier' && (scope.lookup(node.name) || {}).kind === 'list';
  }

  assignStmt(e, scope) {
    const op = e.operator;
    const left = e.left;
    if (op === '||=' || op === '&&=' || op === '??=') throw this.fail(e, `${op} is not supported; use an if statement`);

    if (left.type === 'Identifier') {
      const b = this.lookupVar(scope, left);
      if (b.kind === 'param') throw this.fail(left, `parameter "${left.name}" cannot be assigned (Scratch custom block arguments are read-only); copy it into a variable first`);
      if (b.kind === 'func') throw this.fail(left, `"${left.name}" is a function and cannot be assigned`);
      if (b.kind === 'const') throw this.fail(left, `"${left.name}" is a constant and cannot be assigned`);
      if (b.readonly) throw this.fail(left, `"${left.name}" is declared with const and cannot be assigned`);
      if (b.kind === 'list') {
        if (op !== '=') throw this.fail(e, `"${left.name}" is a list; use push() / splice() or assign an array literal`);
        return this.replaceList(scope, b, e.right, e);
      }
      if (op === '=') {
        if (e.right.type === 'ArrayExpression') throw this.fail(e.right, `"${left.name}" holds a single value; declare it as a list with let ${left.name} = [] to store several`);
        return this.setVar(scope, b, this.expr(e.right, scope));
      }
      const bop = op.slice(0, -1);
      if (bop === '+') {
        const r = this.expr(e.right, scope); // compiled once: a value that is computed but not plugged in would be an orphan block
        if (r.ty !== 'str' && b.ty !== 'str') {
          return this.st(scope, 'data_changevariableby', [['VALUE', r, NUM]], { VARIABLE: [b.name, b.id] });
        }
        const cur = { k: 'var', name: b.name, id: b.id, ty: b.ty || 'any' };
        return this.setVar(scope, b, this.rep(scope, 'operator_join', [['STRING1', cur, TEXT], ['STRING2', r, TEXT]], {}, 'str'));
      }
      if (bop === '-') {
        const r = this.expr(e.right, scope);
        const neg = isNumLit(r) ? lit(-r.v) : this.rep(scope, 'operator_subtract', [['NUM1', lit(0), NUM], ['NUM2', r, NUM]], {}, 'num');
        return this.st(scope, 'data_changevariableby', [['VALUE', neg, NUM]], { VARIABLE: [b.name, b.id] });
      }
      return this.setVar(scope, b, this.expr({ type: 'BinaryExpression', operator: bop, left, right: e.right, line: e.line, col: e.col }, scope));
    }

    // member targets: list[i] = v, list.length = 0
    if (left.type === 'MemberExpression') {
      const obj = left.object;
      if (obj.type === 'Identifier') {
        const b = scope.lookup(obj.name);
        if (b && b.kind === 'list') {
          if (!left.computed && left.property.name === 'length') {
            if (op === '=' && e.right.type === 'Literal' && e.right.value === 0) return this.st(scope, 'data_deletealloflist', [], this.listField(b));
            throw this.fail(e, 'only list.length = 0 is supported (to clear a list)');
          }
          if (left.computed) {
            const value = op === '=' ? e.right : { type: 'BinaryExpression', operator: op.slice(0, -1), left, right: e.right, line: e.line, col: e.col };
            return this.st(scope, 'data_replaceitemoflist', [['INDEX', this.indexOf(left.property, scope), 7], ['ITEM', this.expr(value, scope), TEXT]], this.listField(b));
          }
        }
        if (b && b.kind !== 'list') throw this.fail(left, `"${obj.name}" is not a list, so its items cannot be assigned`);
      }
    }
    throw this.fail(left, 'this assignment target is not supported (use a variable or list[index])');
  }

  updateStmt(e, scope) {
    const delta = e.operator === '++' ? 1 : -1;
    const a = e.argument;
    if (a.type === 'Identifier') {
      const b = this.lookupVar(scope, a);
      if (b.kind !== 'var' || b.readonly) throw this.fail(a, `"${a.name}" cannot be incremented`);
      return this.st(scope, 'data_changevariableby', [['VALUE', lit(delta), NUM]], { VARIABLE: [b.name, b.id] });
    }
    return this.assignStmt({ type: 'AssignmentExpression', operator: delta > 0 ? '+=' : '-=', left: a, right: { type: 'Literal', kind: 'num', value: 1, raw: '1', line: e.line, col: e.col }, line: e.line, col: e.col }, scope);
  }

  /* ---- control flow */
  condition(n, scope) { return this.expr(n, scope); }

  ifStmt(n, scope) {
    const store = scope.t.store;
    const cons = this.blockOrStmt(n.consequent, scope);
    const alt = n.alternate ? this.blockOrStmt(n.alternate, scope) : null;
    if (!alt) {
      const f = this.st(scope, 'control_if', [['CONDITION', this.condition(n.test, scope), 'bool']]);
      this.substack(scope, f.first, 'SUBSTACK', cons);
      return f;
    }
    const f = this.st(scope, 'control_if_else', [['CONDITION', this.condition(n.test, scope), 'bool']]);
    this.substack(scope, f.first, 'SUBSTACK', cons);
    this.substack(scope, f.first, 'SUBSTACK2', alt);
    void store;
    return f;
  }

  /** `repeat until` needs the negated condition; `!x` is simply `x`. */
  negated(test, scope) {
    if (test.type === 'UnaryExpression' && test.operator === '!') return this.expr(test.argument, scope);
    return this.rep(scope, 'operator_not', [['OPERAND', this.expr(test, scope), 'bool']], {}, 'bool');
  }

  whileStmt(test, bodyNode, extra, scope, node) {
    const inner = new Scope(scope);
    let body = bodyNode.type === 'BlockStatement' ? this.stmts(bodyNode.body, new Scope(inner)) : this.stmts([bodyNode], new Scope(inner));
    if (extra) body = chain(scope.t.store, [body, extra(inner)]);
    if (!test || isTrueLiteral(test)) {
      const f = this.st(scope, 'control_forever', [], {}, { cap: true });
      f.capName = 'an endless loop';
      this.substack(scope, f.first, 'SUBSTACK', body);
      return f;
    }
    const f = this.st(scope, 'control_repeat_until', [['CONDITION', this.negated(test, scope), 'bool']]);
    this.substack(scope, f.first, 'SUBSTACK', body);
    void node;
    return f;
  }

  forStmt(n, scope) {
    const inner = new Scope(scope);
    const store = scope.t.store;
    const frags = [];
    if (n.init) {
      if (n.init.type === 'VariableDeclaration') frags.push(this.localDeclaration(n.init, inner));
      else frags.push(this.exprStmt(n.init, inner));
    }
    const update = n.update ? (s) => this.exprStmt(n.update, s) : null;
    frags.push(this.whileStmt(n.test, n.body, update, inner, n));
    const out = chain(store, frags);
    return out;
  }

  /* ---- calls as statements */
  callStmt(e, scope) {
    const callee = e.callee;
    if (callee.type === 'Identifier') {
      const b = scope.lookup(callee.name);
      if (b && b.kind === 'func') return this.callProc(b, e, scope);
      if (b && b.kind !== 'const') throw this.fail(callee, `"${callee.name}" is not a function`);
      const h = stdlib.statements[callee.name];
      if (h) return h(this, e, e.arguments, scope);
      if (stdlib.reporters[callee.name]) throw this.fail(e, `${callee.name}() returns a value; use it inside an expression (for example assign it to a variable)`);
      throw this.fail(callee, `unknown function "${callee.name}"`);
    }
    if (callee.type === 'MemberExpression' && !callee.computed) {
      const m = stdlib.methodStatements[callee.property.name];
      if (callee.object.type === 'Identifier') {
        const b = scope.lookup(callee.object.name);
        if (b && b.kind === 'list' && m) return m(this, e, b, e.arguments, scope);
        if (b && b.kind === 'list') throw this.fail(callee.property, `list.${callee.property.name}() is not supported as a statement (supported: push, pop, shift, unshift, splice)`);
        if (b && b.kind === 'var' && m) throw this.fail(callee, `"${callee.object.name}" is not a list (declare lists as let ${callee.object.name} = [])`);
      }
      throw this.fail(callee, 'this method call is not supported as a statement');
    }
    throw this.fail(e, 'this call is not supported');
  }

  callProc(binding, e, scope) {
    const t = scope.t;
    const info = this.getProc(t, binding.decl, binding.shared);
    if (scope.fn) scope.fn.calls.add(info);
    const args = e.arguments;
    if (args.length > info.params.length) throw this.fail(e, `${info.name}() takes ${info.params.length} argument${info.params.length === 1 ? '' : 's'} but ${args.length} were given`);
    const store = t.store;
    const mutation = { tagName: 'mutation', children: [], proccode: info.proccode, argumentids: JSON.stringify(info.params.map((p) => p.id)), warp: String(info.warp) };
    const id = store.create('procedures_call', { mutation });
    info.params.forEach((p, i) => {
      const a = args[i];
      if (a) this.plug(scope, id, p.id, this.expr(a, scope), p.isBool ? 'bool' : TEXT);
      else if (!p.isBool) store.blocks[id].inputs[p.id] = [1, [TEXT, p.def]];
    });
    return { first: id, last: id, cap: false };
  }

  /* ---------------------------------------------------------------- expressions */
  expr(n, scope) {
    switch (n.type) {
      case 'Literal':
        if (n.kind === 'null') return lit('');
        return lit(n.value, n.kind === 'bool' ? 'bool' : undefined);
      case 'TemplateLiteral': return this.template(n, scope);
      case 'Identifier': return this.identifier(n, scope);
      case 'UnaryExpression': return this.unary(n, scope);
      case 'BinaryExpression': return this.binary(n, scope);
      case 'LogicalExpression': return this.logical(n, scope);
      case 'CallExpression': return this.callExpr(n, scope);
      case 'MemberExpression': return this.member(n, scope);
      case 'ConditionalExpression': throw this.fail(n, 'the ?: operator is not supported; use if / else and assign in both branches');
      case 'AssignmentExpression': throw this.fail(n, 'an assignment cannot be used as a value; write it as its own statement');
      case 'UpdateExpression': throw this.fail(n, '++ / -- cannot be used as a value; write it as its own statement');
      case 'ArrayExpression': throw this.fail(n, 'an array can only initialise or replace a list (let items = [1, 2, 3])');
      case 'ObjectExpression': throw this.fail(n, 'objects are not supported');
      case 'ArrowFunctionExpression': case 'FunctionExpression': throw this.fail(n, 'a function can only be used as an event handler or as the body of repeat() / forever() / repeatUntil()');
      case 'SequenceExpression': throw this.fail(n, 'the comma operator is not supported');
      default: throw this.fail(n, `${n.type} is not supported`);
    }
  }

  template(n, scope) {
    const parts = [];
    n.quasis.forEach((q, i) => {
      if (q) parts.push(lit(q));
      if (n.expressions[i]) parts.push(this.expr(n.expressions[i], scope));
    });
    if (!parts.length) return lit('');
    if (parts.length === 1) { // `${x}` is text
      if (parts[0].k === 'lit') return lit(litText(parts[0]), 'str');
      return this.rep(scope, 'operator_join', [['STRING1', parts[0], TEXT], ['STRING2', lit(''), TEXT]], {}, 'str');
    }
    let acc = parts[0];
    for (let i = 1; i < parts.length; i++) acc = this.rep(scope, 'operator_join', [['STRING1', acc, TEXT], ['STRING2', parts[i], TEXT]], {}, 'str');
    return acc;
  }

  identifier(n, scope) {
    const b = scope.lookup(n.name);
    if (!b) {
      if (n.name === 'undefined') return lit('');
      if (n.name === 'NaN') throw this.fail(n, 'NaN is not supported');
      throw this.fail(n, `"${n.name}" is not declared (declare it with let)`);
    }
    switch (b.kind) {
      case 'var': return { k: 'var', name: b.name, id: b.id, ty: b.ty || 'any' };
      case 'list': return { k: 'list', name: b.name, id: b.id, ty: 'str' };
      case 'const': return lit(b.value);
      case 'func': throw this.fail(n, `"${n.name}" is a custom block; call it as ${n.name}(...) in a statement`);
      case 'param':
        return this.rep(scope, b.param.isBool ? 'argument_reporter_boolean' : 'argument_reporter_string_number', [], { VALUE: [b.param.name, null] }, b.param.isBool ? 'bool' : 'any');
      default: throw this.fail(n, `cannot use "${n.name}" here`);
    }
  }

  unary(n, scope) {
    switch (n.operator) {
      case '-': {
        if (n.argument.type === 'Literal' && n.argument.kind === 'num') return lit(-n.argument.value);
        const v = this.expr(n.argument, scope);
        if (isNumLit(v)) return lit(-v.v);
        return this.rep(scope, 'operator_subtract', [['NUM1', lit(0), NUM], ['NUM2', v, NUM]], {}, 'num');
      }
      case '+': return this.rep(scope, 'operator_add', [['NUM1', this.expr(n.argument, scope), NUM], ['NUM2', lit(0), NUM]], {}, 'num');
      case '!': return this.rep(scope, 'operator_not', [['OPERAND', this.expr(n.argument, scope), 'bool']], {}, 'bool');
      default: throw this.fail(n, `the ${n.operator} operator is not supported`);
    }
  }

  binary(n, scope) {
    const op = n.operator;
    const L = () => this.expr(n.left, scope);
    const R = () => this.expr(n.right, scope);
    const arith = (opcode, ty) => this.rep(scope, opcode, [['NUM1', L(), NUM], ['NUM2', R(), NUM]], {}, ty || 'num');
    switch (op) {
      case '+': {
        const a = L();
        const b = R();
        if (a.ty === 'str' || b.ty === 'str') return this.rep(scope, 'operator_join', [['STRING1', a, TEXT], ['STRING2', b, TEXT]], {}, 'str');
        return this.rep(scope, 'operator_add', [['NUM1', a, NUM], ['NUM2', b, NUM]], {}, 'num');
      }
      case '-': return arith('operator_subtract');
      case '*': return arith('operator_multiply');
      case '/': return arith('operator_divide');
      case '%': return arith('operator_mod');
      case '<': return this.rep(scope, 'operator_lt', [['OPERAND1', L(), TEXT], ['OPERAND2', R(), TEXT]], {}, 'bool');
      case '>': return this.rep(scope, 'operator_gt', [['OPERAND1', L(), TEXT], ['OPERAND2', R(), TEXT]], {}, 'bool');
      case '<=': { // a <= b  ==  not (a > b)
        const g = this.rep(scope, 'operator_gt', [['OPERAND1', L(), TEXT], ['OPERAND2', R(), TEXT]], {}, 'bool');
        return this.rep(scope, 'operator_not', [['OPERAND', g, 'bool']], {}, 'bool');
      }
      case '>=': {
        const g = this.rep(scope, 'operator_lt', [['OPERAND1', L(), TEXT], ['OPERAND2', R(), TEXT]], {}, 'bool');
        return this.rep(scope, 'operator_not', [['OPERAND', g, 'bool']], {}, 'bool');
      }
      case '==': case '===': return this.rep(scope, 'operator_equals', [['OPERAND1', L(), TEXT], ['OPERAND2', R(), TEXT]], {}, 'bool');
      case '!=': case '!==': {
        const eq = this.rep(scope, 'operator_equals', [['OPERAND1', L(), TEXT], ['OPERAND2', R(), TEXT]], {}, 'bool');
        return this.rep(scope, 'operator_not', [['OPERAND', eq, 'bool']], {}, 'bool');
      }
      case '**': throw this.fail(n, 'the ** operator is not supported; use Math.pow(10, x) / Math.exp(x) or multiply');
      default: throw this.fail(n, `the ${op} operator is not supported`);
    }
  }

  logical(n, scope) {
    if (n.operator === '??') throw this.fail(n, 'the ?? operator is not supported');
    const opcode = n.operator === '&&' ? 'operator_and' : 'operator_or';
    return this.rep(scope, opcode, [['OPERAND1', this.expr(n.left, scope), 'bool'], ['OPERAND2', this.expr(n.right, scope), 'bool']], {}, 'bool');
  }

  /** Scratch list index (1-based) for the JS index expression `n`. */
  indexOf(n, scope) {
    if (n.type === 'Literal' && n.kind === 'num') return lit(n.value + 1);
    if (n.type === 'BinaryExpression' && n.operator === '-' && n.right.type === 'Literal' && n.right.kind === 'num' && n.right.value === 1) return this.expr(n.left, scope);
    if (n.type === 'BinaryExpression' && n.operator === '+' && n.right.type === 'Literal' && n.right.kind === 'num') {
      return this.rep(scope, 'operator_add', [['NUM1', this.expr(n.left, scope), NUM], ['NUM2', lit(n.right.value + 1), NUM]], {}, 'num');
    }
    return this.rep(scope, 'operator_add', [['NUM1', this.expr(n, scope), NUM], ['NUM2', lit(1), NUM]], {}, 'num');
  }

  member(n, scope) {
    const obj = n.object;
    if (obj.type === 'Identifier' && obj.name === 'Math' && !n.computed && !scope.lookup('Math')) {
      if (Object.prototype.hasOwnProperty.call(MATH_CONSTANTS, n.property.name)) return lit(MATH_CONSTANTS[n.property.name]);
      throw this.fail(n, `Math.${n.property.name} is not a supported constant`);
    }
    const b = obj.type === 'Identifier' ? scope.lookup(obj.name) : null;
    const isList = b && b.kind === 'list';
    if (!n.computed) {
      if (n.property.name === 'length') {
        if (isList) return this.rep(scope, 'data_lengthoflist', [], { LIST: [b.name, b.id] }, 'num');
        return this.rep(scope, 'operator_length', [['STRING', this.expr(obj, scope), TEXT]], {}, 'num');
      }
      throw this.fail(n.property, `the property "${n.property.name}" is not supported`);
    }
    if (isList) return this.rep(scope, 'data_itemoflist', [['INDEX', this.indexOf(n.property, scope), 7]], { LIST: [b.name, b.id] }, 'any');
    // string indexing: "abc"[i]
    return this.rep(scope, 'operator_letter_of', [['LETTER', this.indexOf(n.property, scope), 6], ['STRING', this.expr(obj, scope), TEXT]], {}, 'str');
  }

  callExpr(e, scope) {
    const callee = e.callee;
    if (callee.type === 'Identifier') {
      const b = scope.lookup(callee.name);
      if (b && b.kind === 'func') throw this.fail(e, `${callee.name}() is a custom block and cannot return a value in Scratch; assign the result to a variable inside the function`);
      if (b && b.kind !== 'const') throw this.fail(callee, `"${callee.name}" is not a function`);
      const h = stdlib.reporters[callee.name];
      if (h) return h(this, e, e.arguments, scope);
      if (stdlib.statements[callee.name]) throw this.fail(e, `${callee.name}() does not return a value`);
      throw this.fail(callee, `unknown function "${callee.name}"`);
    }
    if (callee.type === 'MemberExpression' && !callee.computed) {
      const name = callee.property.name;
      if (callee.object.type === 'Identifier' && callee.object.name === 'Math' && !scope.lookup('Math')) {
        const h = stdlib.math[name];
        if (!h) throw this.fail(callee, `Math.${name}() is not supported`);
        return h(this, e, e.arguments, scope);
      }
      const h = stdlib.methodReporters[name];
      if (h) {
        const b = callee.object.type === 'Identifier' ? scope.lookup(callee.object.name) : null;
        return h(this, e, callee.object, b && b.kind === 'list' ? b : null, e.arguments, scope);
      }
      throw this.fail(callee.property, `the method .${name}() is not supported`);
    }
    throw this.fail(e, 'this call is not supported');
  }

  /* ---------------------------------------------------------------- helpers for the standard library */
  arity(e, args, min, max, sig) {
    if (args.length < min || args.length > max) {
      const want = min === max ? `${min}` : `${min} to ${max}`;
      throw this.fail(e, `${e.callee.name || e.callee.property.name}(${sig || ''}) takes ${want} argument${max === 1 ? '' : 's'} but ${args.length} were given`);
    }
  }

  /** A string that must be a literal in the source (e.g. an effect name). */
  literalString(node, what) {
    if (node.type === 'Literal' && node.kind === 'str') return node.value;
    if (node.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0];
    throw this.fail(node, `${what} must be a string literal`);
  }

  /** Register a monitor for variable / list `b` (so show/hide variable works when the project opens). */
  monitorFor(t, b) {
    if (this.monitors.some((m) => m.id === b.id)) return;
    const base = { id: b.id, mode: b.kind === 'list' ? 'list' : 'default', opcode: b.kind === 'list' ? 'data_listcontents' : 'data_variable', params: b.kind === 'list' ? { LIST: b.name } : { VARIABLE: b.name }, spriteName: b.global ? null : t.name, value: b.kind === 'list' ? [] : 0, width: 0, height: 0, x: 5, y: 5, visible: false };
    if (b.kind !== 'list') Object.assign(base, { sliderMin: 0, sliderMax: 100, isDiscrete: true });
    this.monitors.push(base);
  }

  /* ---------------------------------------------------------------- project */
  buildProject() {
    const targets = [this.stage].concat(this.sprites.map((s) => s.t));
    const json = {
      targets: targets.map((t, i) => this.targetJson(t, i)),
      monitors: this.monitors,
      extensions: [...this.extensions],
      meta: { semver: '3.0.0', vm: '0.2.0', agent: 'sb3-to-js js2sb3' },
    };
    return { json, assets: this.assets, warnings: this.warnings, projectOptions: this.projectOpts };
  }

  targetJson(t, index) {
    const o = t.opts;
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    let current = 0;
    if (o.currentCostume !== undefined) {
      if (typeof o.currentCostume === 'number') current = Math.max(0, Math.min(t.costumes.length - 1, Math.round(o.currentCostume)));
      else { const i = t.costumes.findIndex((c) => c.name === o.currentCostume); if (i < 0) throw new CompileError(`${t.name}: currentCostume "${o.currentCostume}" does not exist`, { line: 0, col: 0 }, this.filename); current = i; }
    }
    const common = {
      isStage: t.isStage, name: t.name, variables: t.variables, lists: t.lists,
      broadcasts: {}, blocks: t.store.blocks, comments: {}, currentCostume: current,
      costumes: t.costumes, sounds: t.sounds, volume: num(o.volume, 100), layerOrder: index,
    };
    if (t.isStage) {
      for (const b of this.broadcasts.values()) common.broadcasts[b.id] = b.name;
      return Object.assign(common, { tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null });
    }
    const rotation = o.rotationStyle === undefined ? 'all around' : o.rotationStyle;
    if (!['all around', 'left-right', "don't rotate"].includes(rotation)) throw new CompileError(`${t.name}: rotationStyle must be "all around", "left-right" or "don't rotate"`, { line: 0, col: 0 }, this.filename);
    return Object.assign(common, {
      visible: o.visible === undefined ? true : !!o.visible,
      x: num(o.x, 0), y: num(o.y, 0), size: num(o.size, 100), direction: num(o.direction, 90),
      draggable: !!o.draggable, rotationStyle: rotation,
    });
  }
}

function translate(ast, opts) { return new Translator(ast, opts).run(); }

module.exports = { translate, Translator, BlockStore, Scope, chain };
