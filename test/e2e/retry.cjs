// Which failed visit of the sitemap sweep is loaded once more, and after how long (milliseconds);
// null means the failure stands. Two causes are the host's or a third party's, not the site's:
//   - a stalled page (its deadline passed with no error; a YouTube still on a CI runner,
//     2026-11-12): retried at once;
//   - a live host's transient answer (429, 502, 503, 504) and nothing else: GitHub Pages answered
//     503 for 3 of 2006 production pages on 2026-11-14 (run 43545986644) and turned main red.
//     Retried after a pause, and only against a live host: the artefact is served from disk,
//     where a 5xx is the test's own defect. One retry after 3 s was not enough: the run of
//     3f90951 (43610981553) got 503 twice for one page that answered 200 a minute later, so the
//     host gets three retries with growing pauses (HOST_PAUSES_MS).
// A stalled page is retried once, a host's answer at most HOST_PAUSES_MS.length times; a page that
// still fails fails, and a console message or a 404 is never retried.
'use strict';

const HOST_TRANSIENT = /^HTTP (429|502|503|504): /;
const HOST_PAUSES_MS = [3000, 10000, 30000];
const HOST_PAUSE_MS = HOST_PAUSES_MS[0];

// The pause before retry number `attempt` (1 for the first retry), or null: the failure stands.
function retryAfter({ stalled, errors }, live, attempt = 1) {
  if (stalled) return attempt === 1 ? 0 : null;
  if (live && errors.length > 0 && errors.every((e) => HOST_TRANSIENT.test(e))) {
    return attempt <= HOST_PAUSES_MS.length ? HOST_PAUSES_MS[attempt - 1] : null;
  }
  return null;
}

module.exports = { retryAfter, HOST_TRANSIENT, HOST_PAUSE_MS, HOST_PAUSES_MS };
