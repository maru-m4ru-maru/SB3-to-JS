'use strict';
/**
 * js2sb3: compile a Scratch-flavoured subset of JavaScript into a Scratch 3 project (.sb3).
 *
 *   const { compileJs } = require('sb3-to-js/js2sb3');
 *   const { sb3, json, warnings } = compileJs(source, { filename: 'game.js', readFile: (p) => fs.readFileSync(p) });
 */
const { parse } = require('./parser');
const { translate } = require('./translate');
const { writeZip } = require('./zipwriter');
const { CompileError, formatError } = require('./errors');
const { validateProject } = require('./validate');

/**
 * @param {string} source JavaScript source text
 * @param {{filename?:string, readFile?:(path:string)=>Buffer}} [opts]
 * @returns {{ sb3: Buffer, json: object, assets: Map<string,Buffer>, warnings: string[], options: object }}
 */
function compileJs(source, opts) {
  opts = opts || {};
  const text = String(source).replace(/^\ufeff/, '');
  let ast;
  try {
    ast = parse(text, opts.filename);
  } catch (e) {
    if (e instanceof CompileError) e.source = text;
    throw e;
  }
  let res;
  try {
    res = translate(ast, opts);
  } catch (e) {
    if (e instanceof CompileError) e.source = text;
    throw e;
  }
  const problems = validateProject(res.json);
  if (problems.length) {
    // this would be a bug in js2sb3, not in the user's program
    throw new Error(`js2sb3 produced an invalid project:\n  ${problems.slice(0, 10).join('\n  ')}`);
  }
  const entries = [{ name: 'project.json', data: Buffer.from(JSON.stringify(res.json), 'utf8') }];
  for (const [name, data] of res.assets) entries.push({ name, data });
  return { sb3: writeZip(entries), json: res.json, assets: res.assets, warnings: res.warnings, options: res.projectOptions };
}

module.exports = { compileJs, CompileError, formatError, validateProject };
