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
MT_CORPUS_FILTER=S6 npm run test:corpus        # triage one case (skips the baseline compare)
MT_CORPUS_RECORD=1 npm run test:corpus         # re-record the stub baseline
```

Both write a machine-readable report to `.e2e/corpus/report-<mode>.json`.

**46 cases; 35 run in CI.** The other 11 cannot be replayed deterministically and
each must say why (see *Stubbed vs live*). The scoreboard states all three numbers
on its first two lines — a case that never ran is never counted as a pass.

### Running a sweep while another checkout is running one

Fine, and it needs nothing from you. Each checkout gets its own port pair,
derived from its absolute path (`e2e/helpers/ports.ts`), so two worktrees get
two databases and two dev servers. Every run prints which pair it used, on its
first three lines — quote that alongside any number you report:

```
[e2e] checkout /Users/kemal/Projects/Cressoft/Sports/matchtime
[e2e] app  http://localhost:3187  (slot 82 of 200)
[e2e] db   127.0.0.1:54393  (slot 82 of 200)
```

If a run **cannot** have its own world it stops before touching anything, with
`REFUSING to run` and the reason: something else on the app port, a Postgres on
the db port whose data directory belongs to another checkout, or another run
already holding this checkout's `.e2e/run.lock`. Two checkouts hashing to the
same slot (a 1-in-200 chance) lands here; escape it for one run with
`MT_E2E_APP_PORT` / `MT_E2E_DB_PORT`.

What this replaced, because a sweep from before PR #34 may still be quoted
somewhere: ports 3105/54311 were hard-coded and `playwright.config.ts` set
`reuseExistingServer: true`, so two runs shared a database and a dev server.
One `resetDb()` truncated the other's world mid-sweep, and a live-mode server
(no `MT_TEST_LLM_STUB_FILE`) served the other's stubbed requests as noise.
Neither run errored; both reported plausible wrong numbers — the same commit
gave 26/35 and then 9/35. The signature is mass
`expected CONFIRMED, got no attendance row` with everything silent. **Any
scoreboard from before PR #34 that does not name its ports is unverifiable.**

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

**5. A failing case is not yet a production bug either.** Before reporting one,
rule out a badly-built world. Three cases in the first sweep failed because the
world did not reproduce the scenario: a completed match seeded at today 20:00,
which `endedAt <= now` rejects for most of a working day, and two payment cases
with no completed match for the credit to attach to. Read the code path the case
targets before calling it a defect, and say plainly when you have not.

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
  classifying the message, so there is nothing honest to stub. **The loader then
  requires `liveOnlyReason`**, so the count of CI-covered cases can never quietly
  drift away from the count of corpus cases. The three honest reasons are: the
  assertion IS the classification; the asserted text is model-authored, so a stub
  would contain the answer; or a stub is structurally impossible (a reminder
  verdict carries an absolute date the server clamps to `now+60d`).

**For a prompt-only fix, the live result is the authority.** A `corrected` stub is
a guess at what the model emits, and when the original fix changed only the prompt
(`c85a23c`, `a5a150a`) that guess is guessing the answer. S9 and S28 fail stubbed
and pass live 3/3 for exactly this reason: the hand-written verdict asked the apply
path for something the real model never requests. Treat a stubbed failure on a
prompt-only fix as a question about the stub, not a finding about production.

**Do not "record" stubs from a live run.** The model is non-deterministic, so one
sample pins whatever it happened to emit — and §4.1 of the redesign doc measured
the Amir case emitting the ghost `registerFor: [{name: "Amir's brother"}]` on six
of six runs. A recorded stub there would enshrine the bug as the expected input.

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

Failures are classified worst-first: `error` (the case threw — not a measurement
of anything), `spurious_write`, `wrong_write`, `missed_write`, `speech`. A case
that throws is recorded and the sweep carries on; a paid live sweep must never
hinge on one malformed fixture.
