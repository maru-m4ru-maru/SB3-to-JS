'use strict';

/** A problem in the user's JavaScript source, with a position (1-based line / column). */
class CompileError extends Error {
  constructor(message, loc, filename) {
    super(message);
    this.name = 'CompileError';
    this.line = loc && loc.line ? loc.line : 0;
    this.column = loc && loc.col ? loc.col : 0;
    this.filename = filename || '';
  }
}

/** `file:line:col: message` followed by the offending source line and a caret. */
function formatError(err, source) {
  if (!(err instanceof CompileError) || !err.line) return err.message;
  const where = `${err.filename || '<input>'}:${err.line}:${err.column}`;
  const text = String(source || '').split(/\r\n|\r|\n/)[err.line - 1];
  let out = `${where}: ${err.message}`;
  if (text !== undefined) {
    const expanded = text.replace(/\t/g, ' ');
    out += `\n  ${err.line} | ${expanded}\n  ${' '.repeat(String(err.line).length)} | ${' '.repeat(Math.max(0, err.column - 1))}^`;
  }
  return out;
}

module.exports = { CompileError, formatError };
