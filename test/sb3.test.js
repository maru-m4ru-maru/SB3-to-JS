'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ZipReader } = require('../src/zip');
const { compile } = require('../src');
const { Blocks, target, project, makeZip, fakePng } = require('./helpers');

function sampleSb3(deflate) {
  const B = new Blocks();
  B.flag([
    B.s('looks_say', { MESSAGE: 'hello from sb3' }),
    B.s('control_repeat', { TIMES: 4, SUBSTACK: B.sub([B.change('n', 5)]) }),
  ]);
  const costume = { name: 'c1', assetId: 'abc', md5ext: 'abc.png', dataFormat: 'png', rotationCenterX: 24, rotationCenterY: 16, bitmapResolution: 2 };
  const json = project({ vars: { n: 0 } }, [target('Cat', B, { costumes: [costume] })]);
  json.targets[0].variables = { v_n: ['n', 0] };
  return makeZip({ 'project.json': Buffer.from(JSON.stringify(json)), 'abc.png': fakePng(48, 32) }, deflate);
}

test('zip reader handles stored and deflated entries', () => {
  for (const deflate of [false, true]) {
    const z = new ZipReader(makeZip({ 'a.txt': Buffer.from('hello'), 'dir/b.bin': Buffer.alloc(1000, 7) }, deflate));
    assert.deepEqual(z.names().sort(), ['a.txt', 'dir/b.bin']);
    assert.equal(z.read('a.txt').toString(), 'hello');
    assert.equal(z.read('dir/b.bin').length, 1000);
    assert.equal(z.read('nope'), null);
  }
});

test('compile() accepts .sb3 bytes, embeds assets and records image sizes', () => {
  for (const deflate of [false, true]) {
    const r = compile(sampleSb3(deflate));
    const m = { exports: {} };
    new Function('module', r.code)(m);
    const c = m.exports.project.targets[1].costumes[0];
    assert.equal(c.width, 48);
    assert.equal(c.height, 32);
    assert.equal(c.bitmapResolution, 2);
    assert.match(c.src, /^data:image\/png;base64,/);
    assert.deepEqual(r.warnings, []);
  }
});

test('external asset mode returns files and relative URLs', () => {
  const r = compile(sampleSb3(true), { assets: 'external', assetsDir: 'game_assets' });
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].path, 'abc.png');
  assert.match(r.code, /game_assets\/abc\.png/);
});

test('rejects non Scratch-3 input with a clear error', () => {
  assert.throws(() => compile(Buffer.from('not a project')), /neither an \.sb3/);
  assert.throws(() => compile({ targets: [], meta: { semver: '2.0.0' } }), /Unsupported project version/);
});

test('CLI compiles a file and the output runs standalone in Node', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb3c-'));
  const input = path.join(dir, 'game.sb3');
  fs.writeFileSync(input, sampleSb3(true));
  const cli = path.join(__dirname, '..', 'bin', 'sb3c.js');
  execFileSync('node', [cli, input, '--html', '-q']);
  assert.ok(fs.existsSync(path.join(dir, 'game.js')));
  assert.match(fs.readFileSync(path.join(dir, 'game.html'), 'utf8'), /<script src="game\.js">/);
  const out = execFileSync('node', [path.join(dir, 'game.js'), '--dump']).toString();
  assert.match(out, /\[Cat\] hello from sb3/);
  assert.equal(JSON.parse(out.slice(out.indexOf('{\n'))).Stage.n, 20);
});
