// Which failed visit of the sitemap sweep is loaded once more, and after how long (milliseconds);
// null means the failure stands. Two causes are the host's or a third party's, not the site's:
//   - a stalled page (its deadline passed with no error; a YouTube still on a CI runner,
//     2026-11-12): retried at once;
//   - a live host's transient answer (429, 502, 503, 504) and nothing else: GitHub Pages answered
//     503 for 3 of 2006 production pages on 2026-11-14 (run 43545986644) and turned main red.
//     Retried after a pause, and only against a live host: the artefact is served from disk,
//     where a 5xx is the test's own defect. The first run with one retry (6ac2bd1, 43611359794)
//     passed: two pages answered 503 once and passed on the retry. Up to three retries with
//     growing pauses (HOST_PAUSES_MS) cost at most 43 s for a page and give a slower recovery
//     the same chance; a real outage still fails.
// A stalled page is retried once, a host's answer at most HOST_PAUSES_MS.length times; a page that
// still fails fails, and a console message or a 404 without a host's answer is never retried.
'use strict';

const HOST_TRANSIENT = /^HTTP (429|502|503|504): /;
const HOST_PAUSES_MS = [3000, 10000, 30000];
const HOST_PAUSE_MS = HOST_PAUSES_MS[0];

// The pause before retry number `attempt` (1 for the first retry), or null: the failure stands.
function retryAfter({ stalled, errors }, live, attempt = 1) {
  if (stalled) return attempt === 1 ? 0 : null;
  // Any transient host answer, not only on the page itself: a 503 for js/core.js (run 43636079537)
  // brought its consequences with it (uncaught TypeError, reading 'module'), and those must not
  // stop the retry. A retry without the 503 shows whether the rest is the site's own defect.
  if (live && errors.some((e) => HOST_TRANSIENT.test(e))) {
    return attempt <= HOST_PAUSES_MS.length ? HOST_PAUSES_MS[attempt - 1] : null;
  }
  return null;
}

module.exports = { retryAfter, HOST_TRANSIENT, HOST_PAUSE_MS, HOST_PAUSES_MS };
