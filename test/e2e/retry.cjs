// Which failed visit of the sitemap sweep is loaded once more, and after how long (milliseconds);
// null means the failure stands. Two causes are the host's or a third party's, not the site's:
//   - a stalled page (its deadline passed with no error; a YouTube still on a CI runner,
//     2026-11-12): retried at once;
//   - a live host's transient answer (429, 502, 503, 504) and nothing else: GitHub Pages answered
//     503 for 3 of 2006 production pages on 2026-11-14 (run 43545986644) and turned main red.
//     Retried after a pause, and only against a live host: the artefact is served from disk,
//     where a 5xx is the test's own defect.
// A page that fails the same way twice fails; a console message or a 404 is never retried.
'use strict';

const HOST_TRANSIENT = /^HTTP (429|502|503|504): /;
const HOST_PAUSE_MS = 3000;

function retryAfter({ stalled, errors }, live) {
  if (stalled) return 0;
  if (live && errors.length > 0 && errors.every((e) => HOST_TRANSIENT.test(e))) return HOST_PAUSE_MS;
  return null;
}

module.exports = { retryAfter, HOST_TRANSIENT, HOST_PAUSE_MS };
