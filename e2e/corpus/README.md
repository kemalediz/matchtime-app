# The incident corpus

Step 1 of `MDs/analyzer-redesign-2026-08-31.md` §10 — *"the artefact that
unblocks every later step and it does not exist."*

Every production incident the analyzer prompt was written in response to,
as one replayable case, runnable against **any** candidate pipeline. It is
the spec: steps 2–7 replace the 18,315-token mega-prompt with router →
extractors → engine → composer, and none of that can be judged safe
without a fixed set of cases with known-correct answers.

```
npm run test:corpus            # stubbed, deterministic, part of npm run test:e2e
npm run test:corpus:live       # real model, 3 runs per case (opt-in, costs money)

MT_SIM_RUNS=5 npm run test:corpus:live         # more repeats
MT_CORPUS_FILTER=S6 npm run test:corpus:live   # one case
MT_CORPUS_RECORD=1 npm run test:corpus         # re-record the stub baseline
```

Both write a machine-readable report to `.e2e/corpus/report-<mode>.json`.

## Files

| file | what it is |
| --- | --- |
| `incidents.jsonl` | **the corpus.** One case per line. |
| `grade.ts` | types, the grader, the scoreboard. Pure — no DB, no model, no Playwright. |
| `load.ts` | JSONL parser + validator. |
| `pipeline.ts` | the adapter boundary: `CorpusPipeline`. |
| `current-analyzer-pipeline.ts` | pipeline #1 — today's analyzer, via the sim harness. |
| `runner.ts` | feeds cases to a pipeline, scores them, writes the report. |
| `baseline.stub.json` | what passes today. A record, not an endorsement. |
| `../sim/corpus.spec.ts` | stubbed runner (CI). |
| `../sim/corpus-live.spec.ts` | live runner (opt-in). |

## Four rules

**1. Ground truth comes from git, never from memory.** Every case carries a
`provenance` block naming the commit or PR it was reconstructed from. Run
`git show <ref>`: the commit message and the test added at the time say what
the correct outcome was. If a rule's provenance cannot be reconstructed, set
`provenance.kind: "doc"` and say so in the note. **Never invent a case and
present it as a real incident.**

**2. Expectations are about writes and decisions, not wording.** Assert what
must happen to the database and whether MatchTime speaks at all. Where copy
IS the outcome, assert a property — `mustMention`, `mustNotMention`,
`mustNotMatch`, `claimsMatchWrites` — never a golden string. A corpus that
pins copy rots on the next tweak and then nobody trusts it. Two properties
are on by default: no raw phone number in any outbound text, and no
announcing a move the database did not make.

**3. Replay through the history-aware path.** `world` + `history` + `messages`
go through `e2e/sim/group.ts`, which forwards the "Recent chat history"
block the Pi sends on *every* production call. PR #26 found the sim was
omitting it, so every live-LLM test written before it ran against a prompt
production never uses; Amir's bug reproduced 2/5 only WITH history. If a
case's incident depended on surrounding conversation, put that conversation
in `history`.

**4. A failing case is a finding, not a bug in the corpus.** §4 documents
that the current prompt does not reliably do what it says. When a case
fails: check the expectation against the commit in its provenance block,
then record the failure in the baseline. **Never weaken an expectation to
make the suite green.**

## Case shape

```jsonc
{
  "id": "S6-najib-in-at-full-squad",
  "title": "an IN at a 14/14 squad with an empty bench must still write something",
  "sections": ["S6", "S10"],          // §3.2 ids — drives the coverage report
  "category": "D",                    // §3.1 A–E
  "provenance": { "kind": "commit", "ref": "f61a897", "date": "2026-05-08",
                  "player": "Najib Ahmadi", "note": "…what actually happened…" },
  "world":   { "maxPlayers": 14, "players": [...], "attendance": [...] },
  "history": [{ "author": "MatchTime", "body": "…the roster post…" }],
  "messages": [{ "from": "najib", "body": "In", "stub": { … } }],
  "stubKind": "historical",
  "expect": { "attendance": [{ "player": "najib", "status": "BENCH" }],
              "counts": { "confirmed": 14, "bench": 1 } }
}
```

`world` knobs: `maxPlayers`, `players`, `attendance`, `features`,
`upcomingMatchInDays` (`null` = no match), `alsoMatchInDays` (a second
match, for rollover), `completedMatch`, `teams`, `openBenchSlotByDropping`.

`messages` knobs: `from` (roster key or `{name, phone}` outsider), `body`,
`tag` (the `@Match Time` signal), `turn` (which analyze batch — turns run in
order and later turns see earlier ones as history), `stub`.

`expect` knobs: `attendance` (status or `ABSENT`), `unchanged`, `counts`,
`benchOffersOpen`, `score`, `teamsUnchanged`, `allowNewMembers`, `speaks`
(`silent` | `required` | `any`), `speaksAtMost`, `react`, `mustMention`,
`mustNotMention`, `mustMatch`, `mustNotMatch`, `claimsMatchWrites`,
`noRawPhone`.

## Stubbed vs live

`stubKind` says how to read a case's `stub` verdicts:

- **`historical`** — the verdict the model *actually emitted* during the
  incident. A stubbed run asks: **does today's server catch it?** Cases whose
  fix was prompt-only will fail here, and that is the point.
- **`corrected`** — what a correct model emits. A stubbed run asks: does the
  server execute a correct verdict correctly?
- **absent** — the case is live-only: its outcome depends on the real model
  classifying the message, so there is nothing honest to stub.

## Adding a pipeline

Implement `CorpusPipeline` (`pipeline.ts`) and hand it to `runCorpus`. The
interface deliberately contains no `AnalysisVerdict`, no intents and no
`reasoning`: a router + extractor + engine that never produces a verdict
must be able to implement it, and be judged by exactly these cases.

```ts
const sb = await runCorpus({ request, db }, new MyPipeline(), loadCorpus(), {
  mode: "live",
  runs: 5,
});
console.log(renderScoreboard(sb));
```

`sb.criteria` carries the two numbers §10 step 3 fixes in advance as the
go/no-go: `spuriousWriteRuns` (target 0 — a write the old pipeline
correctly did not make) and `missedWriteRate` (target ≤2%).
