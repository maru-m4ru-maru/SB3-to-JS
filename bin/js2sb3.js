#!/usr/bin/env node
'use strict';
/** js2sb3 CLI: JavaScript (Scratch-flavoured subset) -> .sb3 */
const fs = require('fs');
const path = require('path');
const { compileJs, formatError, CompileError } = require('../src/js2sb3');

const HELP = `js2sb3 - compile JavaScript (a Scratch-flavoured subset) into a Scratch 3 project

usage: js2sb3 <input.js> [options]

  -o, --out <file>   output file (default: <input>.sb3 next to the input)
  --json             also write the project.json next to the output (for inspection)
  --check            only check the source (no files are written)
  -q, --quiet        no progress / warning output
  -h, --help         this help
  -v, --version      print the version

Costume / sound files named in the source are looked up relative to the input file.
Exit status: 0 ok, 1 compile error in the source, 2 usage / I/O error.`;

function parseArgs(argv) {
  const o = { input: null, out: null, json: false, check: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => { if (i + 1 >= argv.length) { throw new Error(`${a} needs a value`); } return argv[++i]; };
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '-o': case '--out': o.out = need(); break;
      case '--json': o.json = true; break;
      case '--check': o.check = true; break;
      case '-q': case '--quiet': o.quiet = true; break;
      default:
        if (a.startsWith('-') && a !== '-') throw new Error(`unknown option ${a}`);
        if (o.input) throw new Error('only one input file is accepted');
        o.input = a;
    }
  }
  return o;
}

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`js2sb3: ${e.message}\n\n${HELP}\n`); return 2; }
  if (o.help) { process.stdout.write(`${HELP}\n`); return 0; }
  if (o.version) { process.stdout.write(`${require('../package.json').version}\n`); return 0; }
  if (!o.input) { process.stderr.write(`${HELP}\n`); return 2; }

  let source;
  try { source = fs.readFileSync(o.input, 'utf8'); } catch (e) { process.stderr.write(`js2sb3: cannot read ${o.input}: ${e.message}\n`); return 2; }
  const dir = path.dirname(path.resolve(o.input));
  let res;
  try {
    res = compileJs(source, { filename: o.input, readFile: (p) => fs.readFileSync(path.resolve(dir, p)) });
  } catch (e) {
    if (e instanceof CompileError) { process.stderr.write(`${formatError(e, source)}\n`); return 1; }
    process.stderr.write(`js2sb3: internal error: ${e.stack || e.message}\n`);
    return 2;
  }
  if (!o.quiet) for (const w of res.warnings) process.stderr.write(`warning: ${w}\n`);
  const blocks = res.json.targets.reduce((n, t) => n + Object.values(t.blocks).filter((b) => !Array.isArray(b) && !b.shadow).length, 0);
  const summary = `${res.json.targets.length - 1} sprite${res.json.targets.length === 2 ? '' : 's'}, ${blocks} blocks, ${res.assets.size} asset${res.assets.size === 1 ? '' : 's'}`;
  if (o.check) { if (!o.quiet) process.stderr.write(`ok: ${o.input} (${summary})\n`); return 0; }

  const out = o.out || path.join(path.dirname(o.input), `${path.basename(o.input).replace(/(\.sb3)?\.js$/i, '')}.sb3`);
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, res.sb3);
    if (o.json) fs.writeFileSync(out.replace(/\.sb3$/i, '') + '.project.json', JSON.stringify(res.json, null, 2));
  } catch (e) { process.stderr.write(`js2sb3: cannot write ${out}: ${e.message}\n`); return 2; }
  if (!o.quiet) process.stderr.write(`compiled ${o.input} -> ${out} (${summary})\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, parseArgs };
