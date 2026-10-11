'use strict';
/** Shared constants / tiny helpers (kept separate to avoid a require cycle between translate.js and stdlib.js). */

// primitive types of the shadow blocks that sit in block inputs (see scratch-vm's sb3.js)
const NUM = 4; // math_number
const POS = 5; // math_positive_number
const WHOLE = 6; // math_whole_number
const INT = 7; // math_integer
const ANGLE = 8; // math_angle
const COLOR = 9; // colour_picker
const TEXT = 10; // text

/** A literal value descriptor. */
const lit = (v, ty) => ({ k: 'lit', v, ty: ty || (typeof v === 'number' ? 'num' : typeof v === 'boolean' ? 'bool' : 'str') });
const isNumLit = (v) => v.k === 'lit' && typeof v.v === 'number';

module.exports = { NUM, POS, WHOLE, INT, ANGLE, COLOR, TEXT, lit, isNumLit };
