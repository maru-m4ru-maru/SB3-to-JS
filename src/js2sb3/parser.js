'use strict';
/**
 * Recursive-descent parser for the JavaScript subset understood by js2sb3.
 *
 * It accepts ordinary ES2015+ syntax for everything Scratch can express (declarations, functions, arrow functions,
 * if / while / for, operators, template literals, arrays, object literals ...) and produces an ESTree-like AST.
 * Syntax that cannot be turned into blocks (classes, try/catch, switch ...) is still parsed, as an
 * `UnsupportedStatement` / error node, so the translator can explain *why* it is not supported.
 */
const { tokenize } = require('./lexer');
const { CompileError } = require('./errors');

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
]);

const BINARY = {
  '??': 1, '||': 2, '&&': 3, '|': 4, '^': 5, '&': 6,
  '==': 7, '!=': 7, '===': 7, '!==': 7,
  '<': 8, '>': 8, '<=': 8, '>=': 8, instanceof: 8, in: 8,
  '<<': 9, '>>': 9, '>>>': 9,
  '+': 10, '-': 10, '*': 11, '/': 11, '%': 11, '**': 12,
};
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
const UNSUPPORTED_STATEMENTS = {
  switch: '"switch" is not supported; use if / else if (Scratch has no switch block)',
  try: 'try / catch is not supported (Scratch has no exceptions)',
  throw: '"throw" is not supported (Scratch has no exceptions)',
  class: 'classes are not supported (Scratch has no objects)',
  import: '"import" is not supported; put the whole project in one file',
  export: '"export" is not supported; put the whole project in one file',
  with: '"with" is not supported',
  debugger: '"debugger" is not supported',
};

class Parser {
  constructor(tokens, filename) {
    this.toks = tokens;
    this.i = 0;
    this.filename = filename || '';
  }

  /* ---------------- token helpers ---------------- */
  get tok() { return this.toks[this.i]; }
  peek(n) { return this.toks[Math.min(this.i + (n || 0), this.toks.length - 1)]; }
  next() { const t = this.toks[this.i]; if (this.i < this.toks.length - 1) this.i++; return t; }
  fail(msg, t) { t = t || this.tok; return new CompileError(msg, { line: t.line, col: t.col }, this.filename); }
  describe(t) { return t.type === 'eof' ? 'end of file' : t.type === 'str' ? 'string' : t.type === 'num' ? `number ${t.raw}` : `"${t.value || t.type}"`; }
  isP(v, t) { t = t || this.tok; return t.type === 'punc' && t.value === v; }
  isK(v, t) { t = t || this.tok; return t.type === 'id' && t.value === v; }
  eatP(v) { if (this.isP(v)) { this.next(); return true; } return false; }
  eatK(v) { if (this.isK(v)) { this.next(); return true; } return false; }
  expectP(v) { if (!this.isP(v)) throw this.fail(`expected "${v}" but found ${this.describe(this.tok)}`); return this.next(); }
  node(type, t, props) { return Object.assign({ type, line: t.line, col: t.col }, props); }

  identifier(what) {
    const t = this.tok;
    if (t.type !== 'id' || RESERVED.has(t.value)) throw this.fail(`expected ${what || 'an identifier'} but found ${this.describe(t)}`);
    this.next();
    return this.node('Identifier', t, { name: t.value });
  }

  /** Automatic semicolon insertion (the common cases: `;`, `}`, end of file or a line break). */
  semi() {
    if (this.eatP(';')) return;
    if (this.isP('}') || this.tok.type === 'eof' || this.tok.nl) return;
    throw this.fail(`expected ";" but found ${this.describe(this.tok)}`);
  }

  /* ---------------- program / statements ---------------- */
  parseProgram() {
    const body = [];
    while (this.tok.type !== 'eof') body.push(this.statement());
    return { type: 'Program', body, line: 1, col: 1 };
  }

  block() {
    const open = this.expectP('{');
    const body = [];
    while (!this.isP('}')) {
      if (this.tok.type === 'eof') throw this.fail('unexpected end of file, missing "}"', open);
      body.push(this.statement());
    }
    this.next();
    return this.node('BlockStatement', open, { body });
  }

  statement() {
    const t = this.tok;
    if (t.type === 'punc') {
      if (t.value === '{') return this.block();
      if (t.value === ';') { this.next(); return this.node('EmptyStatement', t, {}); }
    }
    if (t.type === 'id') {
      switch (t.value) {
        case 'var': case 'const': return this.varDecl(true);
        case 'let': {
          const n = this.peek(1);
          if (n.type === 'id' || this.isP('[', n) || this.isP('{', n)) return this.varDecl(true);
          break;
        }
        case 'function': return this.functionDecl();
        case 'async': if (this.isK('function', this.peek(1))) throw this.fail('async functions are not supported'); break;
        case 'if': return this.ifStatement();
        case 'for': return this.forStatement();
        case 'while': return this.whileStatement();
        case 'do': return this.doWhileStatement();
        case 'return': {
          this.next();
          let argument = null;
          if (!this.isP(';') && !this.isP('}') && this.tok.type !== 'eof' && !this.tok.nl) argument = this.expression();
          this.semi();
          return this.node('ReturnStatement', t, { argument });
        }
        case 'break': case 'continue': {
          this.next();
          if (this.tok.type === 'id' && !this.tok.nl && !RESERVED.has(this.tok.value)) this.next(); // label
          this.semi();
          return this.node(t.value === 'break' ? 'BreakStatement' : 'ContinueStatement', t, {});
        }
        default:
          if (Object.prototype.hasOwnProperty.call(UNSUPPORTED_STATEMENTS, t.value)) throw this.fail(UNSUPPORTED_STATEMENTS[t.value]);
      }
      if (!RESERVED.has(t.value) && this.isP(':', this.peek(1))) throw this.fail('labels are not supported');
    }
    const expr = this.expression();
    this.semi();
    const st = this.node('ExpressionStatement', t, { expression: expr });
    if (expr.type === 'Literal' && expr.kind === 'str' && !expr.parenthesized) st.directive = expr.value;
    return st;
  }

  varDecl(requireSemi, noIn) {
    const t = this.next(); // var / let / const
    const declarations = [];
    do {
      const nt = this.tok;
      if (this.isP('[') || this.isP('{')) throw this.fail('destructuring is not supported (declare one variable at a time)');
      const id = this.identifier('a variable name');
      let init = null;
      if (this.eatP('=')) init = this.assign(noIn);
      declarations.push({ id, init, line: nt.line, col: nt.col });
    } while (this.eatP(','));
    if (requireSemi) this.semi();
    return this.node('VariableDeclaration', t, { kind: t.value, declarations });
  }

  params() {
    this.expectP('(');
    const params = [];
    while (!this.isP(')')) {
      const t = this.tok;
      if (this.isP('...')) throw this.fail('rest parameters are not supported');
      if (this.isP('[') || this.isP('{')) throw this.fail('destructured parameters are not supported');
      const id = this.identifier('a parameter name');
      let def = null;
      if (this.eatP('=')) def = this.assign();
      params.push(this.node('Param', t, { name: id.name, default: def }));
      if (!this.eatP(',')) break;
    }
    this.expectP(')');
    return params;
  }

  functionDecl() {
    const t = this.next(); // function
    if (this.isP('*')) throw this.fail('generator functions are not supported');
    const id = this.identifier('a function name');
    const params = this.params();
    const body = this.block();
    return this.node('FunctionDeclaration', t, { id, params, body });
  }

  clause(what) {
    const t = this.tok;
    const st = this.statement();
    if (st.type === 'VariableDeclaration' && st.kind !== 'var') throw this.fail(`a lexical declaration cannot be the body of ${what}; wrap it in { }`, t);
    return st;
  }

  ifStatement() {
    const t = this.next();
    this.expectP('(');
    const test = this.expression();
    this.expectP(')');
    const consequent = this.clause('an if');
    let alternate = null;
    if (this.eatK('else')) alternate = this.clause('an else');
    return this.node('IfStatement', t, { test, consequent, alternate });
  }

  whileStatement() {
    const t = this.next();
    this.expectP('(');
    const test = this.expression();
    this.expectP(')');
    return this.node('WhileStatement', t, { test, body: this.clause('a while') });
  }

  doWhileStatement() {
    const t = this.next();
    const body = this.clause('a do-while');
    if (!this.eatK('while')) throw this.fail('expected "while" after the do body');
    this.expectP('(');
    const test = this.expression();
    this.expectP(')');
    this.eatP(';');
    return this.node('DoWhileStatement', t, { body, test });
  }

  forStatement() {
    const t = this.next();
    this.expectP('(');
    let init = null;
    if (this.isP(';')) { /* no init */ } else if (this.isK('var') || this.isK('let') || this.isK('const')) {
      const decl = this.varDecl(false, true);
      if (this.isK('of') || this.isK('in')) {
        throw this.fail('for...of / for...in loops are not supported; use for (let i = 0; i < n; i++) or while');
      }
      init = decl;
    } else {
      init = this.expression(true);
      if (this.isK('of') || this.isK('in')) {
        throw this.fail('for...of / for...in loops are not supported; use for (let i = 0; i < n; i++) or while');
      }
    }
    this.expectP(';');
    const test = this.isP(';') ? null : this.expression();
    this.expectP(';');
    const update = this.isP(')') ? null : this.expression();
    this.expectP(')');
    return this.node('ForStatement', t, { init, test, update, body: this.clause('a for') });
  }

  /* ---------------- expressions ---------------- */
  expression(noIn) {
    const t = this.tok;
    const first = this.assign(noIn);
    if (!this.isP(',')) return first;
    const expressions = [first];
    while (this.eatP(',')) expressions.push(this.assign(noIn));
    return this.node('SequenceExpression', t, { expressions });
  }

  /** `(a, b) =>` / `a =>` lookahead. */
  arrowAhead() {
    const t = this.tok;
    if (t.type === 'id' && !RESERVED.has(t.value) && this.isP('=>', this.peek(1)) && !this.peek(1).nl) return true;
    if (!this.isP('(')) return false;
    let depth = 0;
    for (let k = this.i; k < this.toks.length; k++) {
      const x = this.toks[k];
      if (x.type === 'punc') {
        if (x.value === '(' || x.value === '[' || x.value === '{') depth++;
        else if (x.value === ')' || x.value === ']' || x.value === '}') {
          depth--;
          if (depth === 0) return this.isP('=>', this.toks[k + 1]);
        }
      } else if (x.type === 'eof') return false;
    }
    return false;
  }

  arrow() {
    const t = this.tok;
    let params;
    if (this.isP('(')) params = this.params();
    else { const id = this.identifier(); params = [this.node('Param', t, { name: id.name, default: null })]; }
    this.expectP('=>');
    if (this.isP('{')) return this.node('ArrowFunctionExpression', t, { params, body: this.block(), expression: false });
    return this.node('ArrowFunctionExpression', t, { params, body: this.assign(), expression: true });
  }

  assign(noIn) {
    if (this.isK('async') && (this.isP('(', this.peek(1)) || (this.peek(1).type === 'id' && this.isP('=>', this.peek(2)))) && this.arrowAheadFrom(1)) {
      throw this.fail('async functions are not supported');
    }
    if (this.arrowAhead()) return this.arrow();
    const t = this.tok;
    const left = this.conditional(noIn);
    if (this.tok.type === 'punc' && ASSIGN_OPS.has(this.tok.value)) {
      const op = this.next();
      if (left.type !== 'Identifier' && left.type !== 'MemberExpression') throw this.fail('invalid assignment target', t);
      const right = this.assign(noIn);
      return this.node('AssignmentExpression', op, { operator: op.value, left, right });
    }
    return left;
  }

  arrowAheadFrom(n) { const save = this.i; this.i += n; const r = this.arrowAhead(); this.i = save; return r; }

  conditional(noIn) {
    const t = this.tok;
    const test = this.binary(0, noIn);
    if (!this.isP('?')) return test;
    this.next();
    const consequent = this.assign();
    this.expectP(':');
    const alternate = this.assign(noIn);
    return this.node('ConditionalExpression', t, { test, consequent, alternate });
  }

  binary(minPrec, noIn) {
    let left = this.unary();
    for (;;) {
      const t = this.tok;
      let op = null;
      if (t.type === 'punc') op = t.value;
      else if (t.type === 'id' && (t.value === 'instanceof' || (t.value === 'in' && !noIn))) op = t.value;
      const prec = op !== null && Object.prototype.hasOwnProperty.call(BINARY, op) ? BINARY[op] : undefined;
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.binary(op === '**' ? prec : prec + 1, noIn); // ** is right-associative
      left = this.node(op === '&&' || op === '||' || op === '??' ? 'LogicalExpression' : 'BinaryExpression', t, { operator: op, left, right });
    }
    return left;
  }

  unary() {
    const t = this.tok;
    if (t.type === 'punc' && (t.value === '!' || t.value === '-' || t.value === '+' || t.value === '~')) {
      this.next();
      return this.node('UnaryExpression', t, { operator: t.value, argument: this.unary() });
    }
    if (t.type === 'punc' && (t.value === '++' || t.value === '--')) {
      this.next();
      const argument = this.unary();
      if (argument.type !== 'Identifier' && argument.type !== 'MemberExpression') throw this.fail('invalid increment target', t);
      return this.node('UpdateExpression', t, { operator: t.value, prefix: true, argument });
    }
    if (t.type === 'id' && (t.value === 'typeof' || t.value === 'void' || t.value === 'delete')) {
      this.next();
      return this.node('UnaryExpression', t, { operator: t.value, argument: this.unary() });
    }
    if (t.type === 'id' && t.value === 'await') throw this.fail('await is not supported');
    return this.postfix();
  }

  postfix() {
    const t = this.tok;
    const e = this.callMember();
    if (this.tok.type === 'punc' && (this.tok.value === '++' || this.tok.value === '--') && !this.tok.nl) {
      if (e.type !== 'Identifier' && e.type !== 'MemberExpression') throw this.fail('invalid increment target', t);
      const op = this.next();
      return this.node('UpdateExpression', op, { operator: op.value, prefix: false, argument: e });
    }
    return e;
  }

  args() {
    this.expectP('(');
    const out = [];
    while (!this.isP(')')) {
      if (this.isP('...')) throw this.fail('spread arguments are not supported');
      out.push(this.assign());
      if (!this.eatP(',')) break;
    }
    this.expectP(')');
    return out;
  }

  callMember() {
    const start = this.tok; // calls and member accesses are positioned at the start of the whole expression
    let e = this.primary();
    for (;;) {
      const t = this.tok;
      if (this.isP('.')) {
        this.next();
        const nt = this.tok;
        if (nt.type !== 'id') throw this.fail(`expected a property name but found ${this.describe(nt)}`);
        this.next();
        e = this.node('MemberExpression', start, { object: e, property: this.node('Identifier', nt, { name: nt.value }), computed: false });
      } else if (this.isP('[')) {
        this.next();
        const property = this.expression();
        this.expectP(']');
        e = this.node('MemberExpression', start, { object: e, property, computed: true });
      } else if (this.isP('(')) {
        e = this.node('CallExpression', start, { callee: e, arguments: this.args() });
      } else if (this.isP('?.')) {
        throw this.fail('optional chaining (?.) is not supported');
      } else if (t.type === 'tpl') {
        throw this.fail('tagged templates are not supported');
      } else return e;
    }
  }

  primary() {
    const t = this.tok;
    switch (t.type) {
      case 'num': this.next(); return this.node('Literal', t, { value: t.value, raw: t.raw, kind: 'num' });
      case 'str': this.next(); return this.node('Literal', t, { value: t.value, raw: JSON.stringify(t.value), kind: 'str' });
      case 'tpl': {
        this.next();
        const expressions = t.exprs.map((toks) => {
          const sub = new Parser(toks, this.filename);
          const e = sub.expression();
          if (sub.tok.type !== 'eof') throw sub.fail(`unexpected ${sub.describe(sub.tok)} in template expression`);
          return e;
        });
        return this.node('TemplateLiteral', t, { quasis: t.quasis, expressions });
      }
      case 'id':
        switch (t.value) {
          case 'true': case 'false': this.next(); return this.node('Literal', t, { value: t.value === 'true', raw: t.value, kind: 'bool' });
          case 'null': this.next(); return this.node('Literal', t, { value: null, raw: 'null', kind: 'null' });
          case 'function': {
            this.next();
            if (this.isP('*')) throw this.fail('generator functions are not supported');
            if (this.tok.type === 'id' && !this.isP('(')) this.next(); // optional name
            const params = this.params();
            return this.node('FunctionExpression', t, { params, body: this.block() });
          }
          case 'new': throw this.fail('"new" is not supported (there are no objects or classes in Scratch)');
          case 'class': throw this.fail('classes are not supported');
          case 'this': throw this.fail('"this" is not supported');
          case 'super': throw this.fail('"super" is not supported');
          case 'async': if (this.isK('function', this.peek(1))) throw this.fail('async functions are not supported'); break;
          default: break;
        }
        return this.identifier();
      case 'punc':
        if (t.value === '(') {
          this.next();
          const e = this.expression();
          this.expectP(')');
          e.parenthesized = true;
          return e;
        }
        if (t.value === '[') return this.arrayLiteral();
        if (t.value === '{') return this.objectLiteral();
        break;
      default: break;
    }
    throw this.fail(`unexpected ${this.describe(t)}`);
  }

  arrayLiteral() {
    const t = this.next();
    const elements = [];
    while (!this.isP(']')) {
      if (this.isP(',')) throw this.fail('array holes are not supported');
      if (this.isP('...')) throw this.fail('spread elements are not supported');
      elements.push(this.assign());
      if (!this.eatP(',')) break;
    }
    this.expectP(']');
    return this.node('ArrayExpression', t, { elements });
  }

  objectLiteral() {
    const t = this.next();
    const properties = [];
    while (!this.isP('}')) {
      const kt = this.tok;
      if (this.isP('...')) throw this.fail('spread properties are not supported');
      let key;
      if (kt.type === 'id') key = kt.value;
      else if (kt.type === 'str') key = kt.value;
      else if (kt.type === 'num') key = String(kt.value);
      else if (this.isP('[')) throw this.fail('computed property names are not supported');
      else throw this.fail(`expected a property name but found ${this.describe(kt)}`);
      this.next();
      let value;
      if (this.eatP(':')) value = this.assign();
      else if (kt.type === 'id' && !RESERVED.has(kt.value)) value = this.node('Identifier', kt, { name: kt.value }); // shorthand
      else if (this.isP('(')) throw this.fail('methods in object literals are not supported');
      else throw this.fail(`expected ":" but found ${this.describe(this.tok)}`);
      properties.push({ key, value, line: kt.line, col: kt.col });
      if (!this.eatP(',')) break;
    }
    this.expectP('}');
    return this.node('ObjectExpression', t, { properties });
  }
}

/** Parse JavaScript source text into a Program node. */
function parse(source, filename) {
  const tokens = tokenize(source, filename);
  return new Parser(tokens, filename).parseProgram();
}

module.exports = { parse, Parser, RESERVED };
