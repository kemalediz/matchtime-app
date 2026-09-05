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

# settle ONE case: many runs, every reasoning kept, backstop signals per run
MT_CORPUS_FILTER=S12 MT_SIM_RUNS=100 MT_SETTLE_LABEL=after-36 \
  npm run test:corpus:settle
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

### A live sweep proves it is live, before it starts and after it finishes

A live sweep that cannot reach the model does not degrade, it **fails**.
`e2e/helpers/live-llm.ts` refuses the run before any work when the key is
missing, blank, or rejected (401/403/404/429), when a "live" run would still
see `MT_TEST_LLM_STUB_FILE`, or when a "stubbed" run carries a real key and
could quietly spend money. It spends one token proving the exact model
`analyzeBatch` uses is reachable, and says so:

```
[e2e] LLM: LIVE — probe OK. claude-sonnet-4-5-20250929 answered in 4273ms and
      billed 8 in / 1 out tokens to key ...uQAA.
[e2e] LLM: metering every model call through http://127.0.0.1:56590
...
[live] 141 of 141 analyzed messages reached the real model.
[e2e] LLM: LIVE confirmed - 141 model call(s) billed: ... $2.05 across claude-sonnet-4-5.
```

Every live run goes through the metering proxy, so "how many calls did this
actually make and what did they cost" is a fact the run states rather than a
question nobody asked; **zero calls fails the run** whatever Playwright said.
The sweep itself then reads `AnalyzedMessage.reasoning` back and fails if
messages fell through to an offline verdict. **Quote the `LIVE confirmed` line
alongside any live number, the way you quote the ports.**

What this replaced: on `034f694`, in a checkout with no `.env`,
`npm run test:corpus:live` finished in **4 seconds**, scored **8/47** and
**passed**. `buildTestEnv()` forwards `ANTHROPIC_API_KEY: ""` when the
orchestrator has no key, so all 141 "runs" fell through to
`offlineVerdict("ANTHROPIC_API_KEY not set")` and were graded as an analyzer
that stayed silent. **Any live scoreboard that does not state how many messages
reached the model is unverifiable.**

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
| `dryrun-pipeline.ts` | pipeline #2 — router → extractor → engine, deciding but never writing (§10 step 2). |
| `engine-pipeline.ts` | pipeline #3 — the shipped route with the engine WRITING (§10 step 6). |
| `answer-engine-pipeline.ts` | pipeline #4 — `question` + `balancer`, answered from the database and writing nothing (§10 step 7). |
| `runner.ts` | feeds cases to a pipeline, scores them, writes the report. |
| `baseline.stub.json` | what passes today. A record, not an endorsement. |
| `../sim/corpus.spec.ts` | stubbed runner (CI). |
| `../sim/corpus-live.spec.ts` | live runner (opt-in). |
| `../sim/corpus-answers-live.spec.ts` | live runner for pipeline #4 (opt-in). |

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

## §10 step 6 — the second live arm

Step 6 moves `self_att`, `other_att` and `offer` off the mega-prompt and
onto router → extractor → engine → `registerAttendance`. The corpus is
how that is judged, and it is judged by running the **same 47 cases
twice**, same real model, same worlds, in the same spec:

```bash
set -a; source .env; set +a
npm run test:corpus:live                      # arm A — the incumbent
MT_CORPUS_ENGINE=1 npm run test:corpus:live   # arm B — the engine, WRITING
```

Each arm writes `.e2e/corpus/report-live-<pipeline>.json`, so the two
can be diffed case by case afterwards rather than overwriting each
other. **Any case arm A passes and arm B fails is a blocker.**

`AttendanceEnginePipeline` (`engine-pipeline.ts`) is the shipped route
with the engine on. It is a third pipeline, not a variant of the second:

| | what it grades | writes? |
| --- | --- | --- |
| `current-analyzer` | the mega-prompt's decision, applied | yes |
| `pipeline-dryrun` | the engine's DECISION | **no** — proposals, projected in memory |
| `attendance-engine` | the engine's **WRITE** | yes — transactions, events, bench offers, the recruit blast |

That third row is why `PR33-recruit-ask-must-not-swallow-the-drop`
scores 0/3 under the dry run and must PASS under the engine: it expects
`DM'd N recent players`, and a dry run performs no DM blast.

### How the flag is flipped on a live run

Not by an env var, and not by the router stub file. A live sweep runs
one dev server whose environment is fixed at boot, and the stub seams
are pinned empty on live runs on purpose — a "live" sweep that could
read canned routes or canned FACTS out of a file would be grading its
own answer key. So `AttendanceEnginePipeline` sends
`x-mt-attendance-engine: 1` on every request, which
`src/lib/pipeline/gate.ts` honours **only when `MT_TEST_MODE` is exactly
`"1"`** and which can only ever choose between two shipped code paths.
It cannot inject a route, a fact, a verdict or a write. The baseline arm
sends no header at all.

`MT_TEST_EXTRACTOR_STUB_FILE` is the extractor's own stub seam, used by
`e2e/sim/attendance-engine.spec.ts` in the free suite and pinned empty
(and refused by `helpers/live-llm.ts`) on any live run.

## §10 step 7 — the answer engine (`question` + `balancer`)

```bash
set -a; source .env; set +a
npm run test:corpus:answers                      # 3 runs per case
MT_SIM_RUNS=1 npm run test:corpus:answers        # one pass, cheap
MT_CORPUS_FILTER=S19 npm run test:corpus:answers # one case, verbose
```

`AnswerEnginePipeline` (`answer-engine-pipeline.ts`) is router →
question/teams extractor → engine → composer and **nothing after it**,
because both routes are reads. `attendanceAfter` is a database read
taken after the run, so `unchanged` really is asserting that nothing
moved.

It differs from the other three in one way worth knowing before reading
its numbers: **it declares the cases it owns.** `runAnswerBatch` hands a
message back to the analyzer for a dozen documented reasons, and in
production the mega-prompt is still standing to catch it. In process
there is nothing to catch it, so a handed-back message would be scored
as silence and a carve-out working exactly as designed would be reported
as a defect. The owned set is therefore listed in the source, case by
case, with the reason each neighbouring §3.2 S16 / S19 / S24 / S32 case
is in or out. The scoreboard's own "N cases DID NOT RUN and are NOT
covered by the numbers above" banner then says so in the output.

When the analyze route learns about the per-route flags, this pipeline
should be replaced by a `CurrentAnalyzerPipeline` subclass sending
`x-mt-engine-routes`, exactly as `engine-pipeline.ts` does for step 6,
and the declared list deleted.

Two more differences:

- **Live only.** A stubbed run would need hand-written FACTS, and the
  facts are what the model produces — writing them yourself is the trap
  rule 5 above warns about. The deterministic coverage is
  `src/lib/pipeline/__tests__/answer-batch.test.ts` and
  `route-flags.test.ts`.
- **It fails if it billed nothing.** The pipeline is in-process and
  writes no `AnalyzedMessage` rows, so `liveReachFailure` has nothing to
  read. Measured spend is the direct evidence that the router and the
  extractor were really called — PR #38's rule applied to a harness its
  own mechanism does not reach.
