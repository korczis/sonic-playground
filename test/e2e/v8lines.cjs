// V8 coverage to lines, shared by the browser smoke test (page.coverage) and scripts/coverage.mjs
// (NODE_V8_COVERAGE). Both hand over V8's ScriptCoverage: functions, each with ranges whose first
// is the whole function and the rest its blocks, nested ranges after the ranges that hold them.
// Painting the ranges in that order leaves every character with the count of the innermost range
// around it, which is what "executed" means for that character.
'use strict';

/**
 * Per character: -1 outside every range, 0 never executed, 1 executed.
 * @param {string} source
 * @param {{ranges: {startOffset: number, endOffset: number, count: number}[]}[]} functions
 * @returns {Int8Array}
 */
function paint(source, functions) {
  const state = new Int8Array(source.length).fill(-1);
  for (const fn of functions) {
    for (const r of fn.ranges) {
      const end = Math.min(r.endOffset, source.length);
      state.fill(r.count > 0 ? 1 : 0, Math.max(0, r.startOffset), end);
    }
  }
  return state;
}

/** Two paintings of the same source merged: executed anywhere is executed. */
function merge(into, from) {
  for (let i = 0; i < into.length && i < from.length; i++) if (from[i] > into[i]) into[i] = from[i];
  return into;
}

// A line with nothing to execute: blank, a comment, or only punctuation.
const INERT = /^\s*(?:$|\/\/|\/\*|\*|[{}()[\];,]+\s*$)/;

/**
 * The lines (1-based) a painting says ran and the lines it says never ran.
 * @param {string} source @param {Int8Array} state
 * @returns {{covered: number[], uncovered: number[]}}
 */
function lines(source, state) {
  const covered = [];
  const uncovered = [];
  let at = 0;
  source.split('\n').forEach((text, i) => {
    if (!INERT.test(text)) {
      let seen = false;
      let ran = false;
      for (let k = 0; k < text.length; k++) {
        if (/\s/.test(text[k])) continue;
        const s = state[at + k];
        if (s === -1) continue;
        seen = true;
        if (s === 1) { ran = true; break; }
      }
      if (ran) covered.push(i + 1);
      else if (seen) uncovered.push(i + 1);
    }
    at += text.length + 1;
  });
  return { covered, uncovered };
}

module.exports = { paint, merge, lines };
