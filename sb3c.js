#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { compile, version } = require('../src/index');

const HELP = `sb3c ${version} - compile a Scratch 3 project (.sb3) to standalone JavaScript

usage: sb3c <input.sb3> [options]

  -o, --out <file>        output .js file            (default: <input>.js)
      --html              also write <out>.html that mounts the project
      --assets <mode>     inline (default): embed costumes/sounds as data: URIs
                          external: write them to <out>_assets/ and reference by URL
      --title <text>      title used for the HTML page
      --check             compile only, print warnings, write nothing
  -q, --quiet             do not print the summary
  -v, --version
  -h, --help
`;

function fail(msg) { console.error(`sb3c: ${msg}`); process.exit(1); }

function parse(argv) {
  const o = { assets: 'inline', html: false, check: false, quiet: false, input: null, out: null, title: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '-v' || a === '--version') { console.log(version); process.exit(0); }
    else if (a === '-o' || a === '--out') o.out = val();
    else if (a === '--html') o.html = true;
    else if (a === '--assets') { o.assets = val(); if (!['inline', 'external'].includes(o.assets)) fail('--assets must be inline or external'); }
    else if (a === '--title') o.title = val();
    else if (a === '--check') o.check = true;
    else if (a === '-q' || a === '--quiet') o.quiet = true;
    else if (a.startsWith('-')) fail(`unknown option ${a}\n\n${HELP}`);
    else if (!o.input) o.input = a;
    else fail('only one input file is supported');
  }
  if (!o.input) { console.error(HELP); process.exit(1); }
  return o;
}

function main() {
  const o = parse(process.argv.slice(2));
  let bytes;
  try { bytes = fs.readFileSync(o.input); } catch (e) { fail(`cannot read ${o.input}: ${e.message}`); }

  const base = path.basename(o.input).replace(/\.(sb3|json)$/i, '');
  const out = o.out || path.join(path.dirname(o.input), `${base}.js`);
  const outBase = out.replace(/\.js$/i, '');
  const assetsDir = `${path.basename(outBase)}_assets`;

  let result;
  try {
    result = compile(bytes, { title: o.title || base, source: path.basename(o.input), assets: o.assets, assetsDir });
  } catch (e) { fail(e.message); }

  for (const w of result.warnings) console.error(`warning: ${w}`);
  if (o.check) { if (!o.quiet) console.error(`ok: ${result.stats.scripts} scripts, ${result.stats.blocks} blocks`); return; }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, result.code);
  const written = [out];
  if (result.files.length) {
    const dir = path.join(path.dirname(out), assetsDir);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of result.files) fs.writeFileSync(path.join(dir, f.path), f.data);
    written.push(`${dir}/ (${result.files.length} assets)`);
  }
  if (o.html) {
    const htmlPath = `${outBase}.html`;
    fs.writeFileSync(htmlPath, result.html(path.basename(out)));
    written.push(htmlPath);
  }
  if (!o.quiet) {
    const s = result.stats;
    console.error(`compiled ${s.targets} targets, ${s.scripts} scripts, ${s.blocks} blocks -> ${written.join(', ')}`);
  }
}

main();
