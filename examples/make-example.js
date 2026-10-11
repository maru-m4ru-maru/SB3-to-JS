'use strict';
/** Builds examples/bounce.sb3 (a tiny hand-made Scratch 3 project) so the CLI has something to chew on. */
const fs = require('fs');
const path = require('path');
const { Blocks, target, project, makeZip } = require('../test/helpers');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60">
  <circle cx="30" cy="30" r="28" fill="#4c97ff" stroke="#3373cc" stroke-width="4"/>
  <circle cx="21" cy="24" r="5" fill="#fff"/><circle cx="39" cy="24" r="5" fill="#fff"/>
  <path d="M18 38 Q30 50 42 38" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
</svg>`;

const B = new Blocks();
B.flag([
  B.s('motion_gotoxy', { X: 0, Y: 0 }),
  B.set('steps', 0),
  B.s('pen_clear'),
  B.s('pen_penDown'),
  B.s('looks_sayforsecs', { MESSAGE: 'Hello, Scratch!', SECS: 2 }),
  B.s('control_forever', { SUBSTACK: B.sub([
    B.s('motion_movesteps', { STEPS: 6 }),
    B.s('motion_ifonedgebounce'),
    B.change('steps', 1),
  ]) }),
]);
B.script('event_whenkeypressed', [B.s('motion_turnright', { DEGREES: 15 })], { KEY_OPTION: ['right arrow', null] });
B.script('event_whenkeypressed', [B.s('motion_turnleft', { DEGREES: 15 })], { KEY_OPTION: ['left arrow', null] });
B.script('event_whenthisspriteclicked', [B.s('looks_say', { MESSAGE: B.r('operator_join', { STRING1: 'steps: ', STRING2: B.v('steps') }) })]);

const costume = { name: 'ball', assetId: 'ball1', md5ext: 'ball1.svg', dataFormat: 'svg', rotationCenterX: 30, rotationCenterY: 30, bitmapResolution: 1 };
const json = project({}, [target('Ball', B, { costumes: [costume], vars: { steps: 0 }, extra: { direction: 45 } })]);
json.targets[0].costumes = [Object.assign({}, costume, { name: 'backdrop1', assetId: 'bg1', md5ext: 'bg1.svg', rotationCenterX: 240, rotationCenterY: 180 })];
json.extensions = ['pen'];
json.monitors = [{ id: 'v_steps', mode: 'default', opcode: 'data_variable', params: { VARIABLE: 'steps' }, spriteName: 'Ball', x: 5, y: 5, visible: true }];

const bg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect width="480" height="360" fill="#f4f8ff"/></svg>';
const zip = makeZip({ 'project.json': Buffer.from(JSON.stringify(json)), 'ball1.svg': Buffer.from(svg), 'bg1.svg': Buffer.from(bg) }, true);
fs.writeFileSync(path.join(__dirname, 'bounce.sb3'), zip);
console.log('wrote examples/bounce.sb3');
