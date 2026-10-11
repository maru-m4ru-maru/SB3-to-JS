'use strict';
/**
 * Structural validator for Scratch 3 project.json files (the invariants scratch-vm / scratch-gui rely on when they load
 * a project). Used by js2sb3 as a self-check and by the tests. Returns a list of problems; an empty list means "valid".
 */

const PRIMITIVE_TYPES = new Set([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

function validateProject(json) {
  const problems = [];
  const bad = (msg) => problems.push(msg);
  if (!json || typeof json !== 'object') return ['project is not an object'];
  if (!Array.isArray(json.targets) || !json.targets.length) return ['project has no targets'];
  if (!json.meta || json.meta.semver !== '3.0.0') bad('meta.semver must be "3.0.0"');
  if (!Array.isArray(json.monitors)) bad('monitors must be an array');
  if (!Array.isArray(json.extensions)) bad('extensions must be an array');

  const stage = json.targets[0];
  if (!stage || !stage.isStage) bad('the first target must be the stage');
  if (json.targets.filter((t) => t.isStage).length !== 1) bad('there must be exactly one stage');
  const names = new Set();
  const varIds = new Map(); // id -> kind
  const stageVars = new Set();
  for (const t of json.targets) {
    for (const [id, v] of Object.entries(t.variables || {})) { if (varIds.has(id)) bad(`variable id ${id} is used twice`); varIds.set(id, 'var'); if (t.isStage) stageVars.add(id); void v; }
    for (const id of Object.keys(t.lists || {})) { if (varIds.has(id)) bad(`list id ${id} is used twice`); varIds.set(id, 'list'); if (t.isStage) stageVars.add(id); }
  }
  const broadcasts = (stage && stage.broadcasts) || {};
  let usesPen = false;

  for (const t of json.targets) {
    const where = `target "${t.name}"`;
    if (typeof t.name !== 'string' || !t.name) bad('a target has no name');
    if (names.has(t.name)) bad(`${where}: duplicate target name`);
    names.add(t.name);
    for (const k of ['variables', 'lists', 'broadcasts', 'blocks', 'comments']) if (!t[k] || typeof t[k] !== 'object' || Array.isArray(t[k])) bad(`${where}: "${k}" must be an object`);
    for (const k of ['costumes', 'sounds']) if (!Array.isArray(t[k])) bad(`${where}: "${k}" must be an array`);
    if (!Array.isArray(t.costumes) || !t.costumes.length) bad(`${where}: needs at least one costume`);
    else {
      if (!Number.isInteger(t.currentCostume) || t.currentCostume < 0 || t.currentCostume >= t.costumes.length) bad(`${where}: currentCostume out of range`);
      for (const c of t.costumes) {
        for (const k of ['assetId', 'name', 'md5ext', 'dataFormat']) if (typeof c[k] !== 'string') bad(`${where}: costume missing ${k}`);
        if (typeof c.rotationCenterX !== 'number' || typeof c.rotationCenterY !== 'number') bad(`${where}: costume "${c.name}" needs numeric rotationCenterX / rotationCenterY`);
        if (c.md5ext !== `${c.assetId}.${c.dataFormat}`) bad(`${where}: costume md5ext does not match assetId + dataFormat`);
      }
    }
    for (const s of t.sounds || []) {
      for (const k of ['assetId', 'name', 'md5ext', 'dataFormat']) if (typeof s[k] !== 'string') bad(`${where}: sound missing ${k}`);
      if (typeof s.rate !== 'number' || typeof s.sampleCount !== 'number') bad(`${where}: sound "${s.name}" needs rate and sampleCount`);
    }
    if (typeof t.volume !== 'number') bad(`${where}: volume must be a number`);
    if (typeof t.layerOrder !== 'number') bad(`${where}: layerOrder must be a number`);
    if (t.isStage) {
      if (t.name !== 'Stage') bad('the stage must be named "Stage"');
    } else {
      for (const k of ['x', 'y', 'size', 'direction']) if (typeof t[k] !== 'number') bad(`${where}: ${k} must be a number`);
      if (typeof t.visible !== 'boolean' || typeof t.draggable !== 'boolean') bad(`${where}: visible / draggable must be booleans`);
      if (!['all around', 'left-right', "don't rotate"].includes(t.rotationStyle)) bad(`${where}: bad rotationStyle`);
      if (Object.keys(t.broadcasts || {}).length) bad(`${where}: only the stage owns broadcast messages`);
    }
    for (const [id, v] of Object.entries(t.variables || {})) if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string') bad(`${where}: variable ${id} must be [name, value]`);
    for (const [id, v] of Object.entries(t.lists || {})) if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || !Array.isArray(v[1])) bad(`${where}: list ${id} must be [name, [items]]`);

    const blocks = t.blocks || {};
    const visible = (id) => (t.variables && t.variables[id]) || (t.lists && t.lists[id]) || stageVars.has(id);
    const refCount = {};
    const protoByCode = new Map();
    for (const [id, b] of Object.entries(blocks)) if (b.opcode === 'procedures_prototype' && b.mutation) protoByCode.set(b.mutation.proccode, b);

    for (const [id, b] of Object.entries(blocks)) {
      const at = `${where}, block ${id} (${b && b.opcode})`;
      if (Array.isArray(b)) continue; // a lone variable reporter on the workspace
      if (!b || typeof b.opcode !== 'string') { bad(`${at}: no opcode`); continue; }
      if (b.opcode.indexOf('pen_') === 0) usesPen = true;
      for (const k of ['next', 'parent']) if (b[k] !== null && typeof b[k] !== 'string') bad(`${at}: ${k} must be a block id or null`);
      if (!b.inputs || typeof b.inputs !== 'object') bad(`${at}: inputs missing`);
      if (!b.fields || typeof b.fields !== 'object') bad(`${at}: fields missing`);
      if (typeof b.shadow !== 'boolean' || typeof b.topLevel !== 'boolean') bad(`${at}: shadow / topLevel must be booleans`);
      if (b.topLevel) {
        if (b.parent !== null) bad(`${at}: a top-level block has a parent`);
        if (typeof b.x !== 'number' || typeof b.y !== 'number') bad(`${at}: a top-level block needs x and y`);
        if (b.shadow) bad(`${at}: a top-level block cannot be a shadow`);
      } else {
        if (b.parent === null || !blocks[b.parent]) bad(`${at}: parent "${b.parent}" does not exist`);
        if ('x' in b || 'y' in b) bad(`${at}: only top-level blocks have x / y`);
      }
      if (b.next) {
        const n = blocks[b.next];
        if (!n) bad(`${at}: next "${b.next}" does not exist`);
        else {
          if (n.parent !== id) bad(`${at}: next block ${b.next} has parent ${n.parent}`);
          if (n.shadow) bad(`${at}: next is a shadow`);
          refCount[b.next] = (refCount[b.next] || 0) + 1;
        }
      }

      const checkPrimitive = (p, where2) => {
        if (!Array.isArray(p) || !PRIMITIVE_TYPES.has(p[0])) { bad(`${at}: ${where2} is not a valid primitive`); return; }
        if (p[0] === 11) { if (typeof p[1] !== 'string' || !broadcasts[p[2]]) bad(`${at}: ${where2} references unknown broadcast ${p[2]}`); } else if (p[0] === 12 || p[0] === 13) {
          if (typeof p[1] !== 'string' || !visible(p[2])) bad(`${at}: ${where2} references unknown ${p[0] === 12 ? 'variable' : 'list'} ${p[2]}`);
          else if (varIds.get(p[2]) !== (p[0] === 12 ? 'var' : 'list')) bad(`${at}: ${where2} has the wrong kind of reference`);
        } else if (typeof p[1] !== 'string') bad(`${at}: ${where2} value must be a string`);
      };
      const checkRef = (r, role, where2) => {
        if (typeof r === 'string') {
          const c = blocks[r];
          if (!c) { bad(`${at}: ${where2} references missing block ${r}`); return; }
          if (c.parent !== id) bad(`${at}: ${where2} block ${r} has parent ${c.parent}`);
          if (role === 'shadow' && !c.shadow) bad(`${at}: ${where2} block ${r} must be a shadow`);
          if (role === 'block' && c.shadow) bad(`${at}: ${where2} block ${r} must not be a shadow`);
          refCount[r] = (refCount[r] || 0) + 1;
        } else checkPrimitive(r, where2);
      };
      for (const [name, inp] of Object.entries(b.inputs || {})) {
        if (!Array.isArray(inp) || ![1, 2, 3].includes(inp[0])) { bad(`${at}: input ${name} is malformed`); continue; }
        if (inp[0] === 1) { if (inp.length !== 2) bad(`${at}: input ${name} must have 2 elements`); checkRef(inp[1], 'shadow', `input ${name}`); } else if (inp[0] === 2) { if (inp.length !== 2) bad(`${at}: input ${name} must have 2 elements`); checkRef(inp[1], 'block', `input ${name}`); } else {
          if (inp.length !== 3) bad(`${at}: input ${name} must have 3 elements`);
          checkRef(inp[1], 'block', `input ${name}`);
          checkRef(inp[2], 'shadow', `input ${name} (shadow)`);
        }
      }
      for (const [name, f] of Object.entries(b.fields || {})) {
        if (!Array.isArray(f) || f.length !== 2 || typeof f[0] !== 'string') { bad(`${at}: field ${name} must be [value, id]`); continue; }
        if (name === 'VARIABLE' || name === 'LIST') {
          if (!visible(f[1])) bad(`${at}: field ${name} references unknown id ${f[1]}`);
          else if (varIds.get(f[1]) !== (name === 'VARIABLE' ? 'var' : 'list')) bad(`${at}: field ${name} points at the wrong kind of variable`);
        } else if (name === 'BROADCAST_OPTION') {
          if (!broadcasts[f[1]]) bad(`${at}: broadcast ${f[1]} is not declared in the stage`);
        } else if (f[1] !== null) bad(`${at}: field ${name} must have a null id`);
      }

      if (b.opcode === 'procedures_prototype' || b.opcode === 'procedures_call') {
        const m = b.mutation;
        if (!m || m.tagName !== 'mutation' || !Array.isArray(m.children) || typeof m.proccode !== 'string') bad(`${at}: bad mutation`);
        else {
          let ids = null;
          try { ids = JSON.parse(m.argumentids); } catch (e) { bad(`${at}: argumentids is not JSON`); }
          if (ids) {
            const slots = (m.proccode.match(/%[sb]/g) || []).length;
            if (ids.length !== slots) bad(`${at}: proccode has ${slots} arguments but argumentids has ${ids.length}`);
            if (b.opcode === 'procedures_prototype') {
              for (const k of ['argumentnames', 'argumentdefaults']) {
                let arr = null;
                try { arr = JSON.parse(m[k]); } catch (e) { bad(`${at}: ${k} is not JSON`); }
                if (arr && arr.length !== ids.length) bad(`${at}: ${k} has the wrong length`);
              }
              for (const aid of ids) if (!b.inputs[aid]) bad(`${at}: no argument reporter for ${aid}`);
            } else {
              for (const k of Object.keys(b.inputs)) if (!ids.includes(k)) bad(`${at}: input ${k} is not one of the arguments`);
              if (!protoByCode.has(m.proccode)) bad(`${at}: no custom block defines "${m.proccode}"`);
              else if (protoByCode.get(m.proccode).mutation.argumentids !== m.argumentids) bad(`${at}: argumentids differ from the definition`);
              if (!protoByCode.has(m.proccode) || String(protoByCode.get(m.proccode).mutation.warp) !== String(m.warp)) bad(`${at}: warp flag differs from the definition`);
            }
          }
          if (m.warp !== 'true' && m.warp !== 'false') bad(`${at}: warp must be "true" or "false"`);
        }
      }
      if (b.opcode === 'procedures_definition') {
        const inp = b.inputs.custom_block;
        if (!inp || !blocks[inp[1]] || blocks[inp[1]].opcode !== 'procedures_prototype') bad(`${at}: custom_block must point at a prototype`);
      }
      if (b.opcode === 'control_stop' && (!b.mutation || (b.mutation.hasnext !== 'true' && b.mutation.hasnext !== 'false'))) bad(`${at}: control_stop needs a hasnext mutation`);
    }

    // every non-top-level block must be referenced exactly once (and then its parent is the referrer: checked above)
    for (const [id, b] of Object.entries(blocks)) {
      if (Array.isArray(b) || !b || b.topLevel) continue;
      const n = refCount[id] || 0;
      if (n !== 1) bad(`${where}, block ${id} (${b.opcode}) is referenced ${n} times (expected 1)`);
    }
    // no cycles / every chain ends in a top-level block
    for (const [id, b] of Object.entries(blocks)) {
      if (Array.isArray(b) || !b) continue;
      let cur = b;
      let steps = 0;
      while (cur && !cur.topLevel && steps++ < 100000) cur = blocks[cur.parent];
      if (!cur || !cur.topLevel) bad(`${where}, block ${id} is not connected to a top-level block`);
    }
  }

  for (const m of json.monitors || []) if (!varIds.has(m.id)) bad(`monitor ${m.id} does not belong to a variable or list`);
  if (usesPen && !(json.extensions || []).includes('pen')) bad('pen blocks are used but the "pen" extension is not listed');
  return problems;
}

module.exports = { validateProject };
