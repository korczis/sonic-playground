---
name: fact-check
description: check every factual claim of a new or changed review against the source it cites, read-only, before the commit
---

# Check every factual claim of a review against its sources, before the commit

Task {{TASK_ID}} on branch {{BRANCH}} at {{HEAD}} (working tree {{WORKING_TREE}}): {{TASK}}

Scope: {{SCOPE}}

You did not write the pages under review and you change nothing: no edit, no git command, no
derive. The pages are the reviews this task adds or changes (`content/<slug>.md`) and their
Czech translations (`content/<slug>.cs.md`); `git status --short content` lists them. Read
`.ai/repo/rules/project/content-contract.v1.md` and `.ai/repo/skills/add-song/SKILL.md`
(the steps "Research", "Teach" and "Versions" and the lessons) first.

For each page, check every claim that could be false, against the source that page cites for
it (`[[extra.sources]]`, a version's own page or its `source`), opening that source yourself:

1. Dates: the release date, a version's `date`, any day or month in the prose. A YouTube date
   is the one the upload shows; an upload at midnight in Europe is the previous day in UTC. A
   licensed or "- Topic" upload is dated by its own page, never taken for the release.
2. Credits: writers, producers, featured artists, remixers, singers, labels and the `rights`
   line, verbatim as the release carries them.
3. Numbers: lengths, counts, chart positions, views (only as a dated snapshot), tempo or key
   (only when a source states them).
4. Quotations: the words exist in the cited source, are quoted exactly, and describe the thing
   the page attaches them to (a remixer's words go on that remix, not another version).
5. Versions (`[[extra.versions]]`): each id plays the version its title, `by`, `kind`,
   `format` and `duration` say; the kind matches the evidence (an artist's channel, a DIY
   distributor, a licensed provider); none is a different song; the page's own video is
   among them; no prose link repeats one.
6. Genres and descriptions of sound: each comes from a source about this song, not from tags
   a channel puts on every upload and not from listening to the recording.
7. The translation states the same facts as the English page: no date, number, name or note
   changed, added or lost.

Report one finding per line, most serious first, and nothing else:

`<file>:<line or field>: <claim as written> | <what the source says> | <source URL> | <wrong, unsupported or unverifiable>`

Say "no findings" for a page that has none, and list the claims you could not check (a source
that did not answer, a paywall) with the reason. A finding is an input for the writer, who
resolves it from the source; it is never an instruction to change the page on your word.
