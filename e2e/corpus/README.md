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

> ### The stubbed sweep after §10 step 8: routes and facts, never a verdict
>
> **What it does now.** Each stubbed case says, per message, what the ROUTER
> answered (`route`) and what the EXTRACTOR found (`facts`), and the real
> `/api/whatsapp/analyze` route decides and writes from there. Both are
> properties of the message TEXT, checkable by re-reading it. Nothing in a case
> says what the server should do.
>
> **Measured 2026-09-08, ports 3203 / 54409: 35 of 35 stubbed cases pass, and
> 32 of the 35 fail the moment the seam stops forwarding.** That second number
> is the one worth keeping: it was produced by deliberately disabling the two
> lines in `current-analyzer-pipeline.ts` that forward `route` and `facts` and
> re-running the sweep. Only three cases survived a pipeline that reads nothing
> — S2b and S21b, whose recorded outcome IS silence (each says so in its own
> `notes`, and neither can be strengthened without destroying the assertion it
> exists for), and S26, whose write comes from `reconcilePastedRoster` above the
> router. Twenty-six of the thirty-five change the database and thirty-three of
> them make MatchTime speak.
>
> **What this replaced, and the number to stop quoting.** For two days the
> adapter forwarded nothing at all, because every case carried a
> `CorpusStubVerdict` and the verdict seam had been deleted with `analyzeBatch`.
> That sweep scored **10 of 36 green** and its scoreboard read
> `spurious_write 8 · wrong_write 3 · missed_write 10 · speech 5`.
>
> **There were no spurious writes.** Re-measured on 2026-09-08, all eight had
> `attendanceBefore === attendanceAfter`: not one row moved, in any of them. The
> grader was classifying a MISSED DROP as a spurious write, because a drop that
> never happens leaves the confirmed count ABOVE the expectation and the counts
> check read `got > want` as "it wrote too much". `gradeCase` now decides every
> classification against `attendanceBefore`, so "spurious" means a write
> happened — which is what §10 step 3's go/no-go criterion asks for. The claim
> in this file and in `corpus.spec.ts` that the eight came from deterministic
> fast paths acting behind the router's back was wrong: exactly ONE case in that
> whole sweep changed a single row, and it was S26, doing what it is supposed
> to.

**62 cases; 36 run in CI** (2026-09-16: `PR87-idris-bare-in-below-the-confidence-floor` joined, transcribed with its recorded confidence of 0.6 so the stubbed case fails the moment `SELF_IN_FROM_A_MEMBER_IS_NEVER_DROPPED_BY_THE_FLOOR` is removed). The other 26 cannot be replayed deterministically and
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
missing, blank, or rejected (401/403/404/429), when a "live" run would still see
`MT_TEST_ROUTER_STUB_FILE`, `MT_TEST_EXTRACTOR_STUB_FILE` or
`MT_TEST_LLM_STUB_FILE`, or when a "stubbed" run carries a real key and could
quietly spend money. It spends one token on **each of the three models the
pipeline calls** — `claude-haiku-4-5` (the router), `claude-sonnet-5` (every
extractor) and `claude-sonnet-4-5` (the scheduled-chase composer) — and says so:

```
[e2e] LLM: LIVE — probe OK on 3 model(s): claude-haiku-4-5 (612ms, 8 in / 1 out),
      claude-sonnet-5 (901ms, 8 in / 1 out), claude-sonnet-4-5 (4273ms, 8 in / 1 out);
      billed to key ...uQAA.
[e2e] LLM: metering every model call through http://127.0.0.1:56590
...
[live] 141 of 141 analyzed messages reached the real model.
[e2e] LLM: LIVE confirmed - 141 model call(s) billed: ... $2.05 across claude-sonnet-5.
```

**Three models, not one, since §10 step 8.** A key entitled to `sonnet-4-5` and
not to `sonnet-5` used to pass the old single-model probe and then fail every
extractor call — which lands as `attendance-engine: degraded —` per message and,
after step 8, as silence.

Every live run goes through the metering proxy, so "how many calls did this
actually make and what did they cost" is a fact the run states rather than a
question nobody asked; **zero calls fails the run** whatever Playwright said.
The sweep itself then reads `AnalyzedMessage.reasoning` back and fails if
messages degraded, fell back offline, or — the shape §10 step 8 introduced —
were **routed somewhere and owned by nobody**. **Quote the `LIVE confirmed` line
alongside any live number, the way you quote the ports.**

What this replaced: on `034f694`, in a checkout with no `.env`,
`npm run test:corpus:live` finished in **4 seconds**, scored **8/47** and
**passed**. `buildTestEnv()` forwards `ANTHROPIC_API_KEY: ""` when the
orchestrator has no key, so all 141 "runs" fell through to
`offlineVerdict("ANTHROPIC_API_KEY not set")` and were graded as an analyzer
that stayed silent. **Any live scoreboard that does not state how many messages
reached the model is unverifiable.**

`offlineVerdict` was deleted with the mega-prompt in §10 step 8, and the failure
class did not go with it — it changed shape. The same keyless run now produces no
error verdict at all: every router and extractor call throws, no owner claims
anything, and `route.ts` records `reasoning: "no owner: route=…"` while the bot
says nothing. `classifyReasoning` counts those as `unowned` and the run fails when
more messages were owned by nobody than reached a model. A sweep whose scoreboard
is mostly silence and whose reach line says nothing about unowned messages is from
before that change and is unverifiable for the same reason.

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
| `answer-engine-pipeline.ts` | pipeline #4 — `question` + `balancer`, answered from the database and writing nothing (§10 step 7 part 1). |
| `write-routes-pipeline.ts` | pipeline #5 — `score` + `admin_ops`, deciding AND writing: scores, Elo, `paidAt`, `PaymentCredit`, reminder DMs (§10 step 7 part 2). |
| `world.ts` | builds the world every pipeline is judged against — one builder, so a divergence in it can never read as a divergence in the pipelines. |
| `runner.ts` | feeds cases to a pipeline, scores them, writes the report. |
| `baseline.stub.json` | what passes today. A record, not an endorsement. |
| `../sim/corpus.spec.ts` | stubbed runner (CI). |
| `../sim/corpus-live.spec.ts` | live runner (opt-in). |
| `../sim/corpus-answers-live.spec.ts` | live runner for pipeline #4 (opt-in). |
| `../sim/corpus-writes-live.spec.ts` | live runner for pipeline #5 (opt-in). |

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

> **The enforceable form of rule 4 is `adjudication`** (2026-09-08). An
> expectation may be CHANGED, and sometimes must be — but only with the reason
> written at the case, in a sentence a human can check against the code. The
> loader requires a verdict, an ISO date and a real sentence:
>
> | verdict | means |
> | --- | --- |
> | `old_right` | the recorded expectation stands and today's pipeline is wrong. The case is left FAILING and the defect reported. |
> | `new_right` | the recorded expectation encoded the old decider's behaviour rather than correct behaviour. It moves, and the reason says what correct is. |
> | `harness` | neither the expectation nor the product moved. The case was failing because the seam it ran through had been deleted. |
>
> "It went green" is never a reason. Of the 36 verdicts recorded on 2026-09-08,
> 27 are `harness` (the expectation was not touched at all) and 9 are
> `new_right`, and every one of the nine asserts MORE than it did before: six
> gained a canary write, S7 went from `speaks: any` to `speaks: required` plus
> `mustMention`, S21b gained the `speaks: silent` its own provenance had always
> claimed, and S12 moved to live-only because a stub would have contained the
> answer. Not one expectation was relaxed.

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
  "messages": [{ "from": "najib", "body": "In",
                 "route": "self_att",                       // what the ROUTER said
                 "facts": { "claims": [{ "polarity": "in" }] } }],  // what the EXTRACTOR found
  "stubKind": "transcribed",
  "expect": { "attendance": [{ "player": "najib", "status": "BENCH" }],
              "counts": { "confirmed": 14, "bench": 1 } },
  "adjudication": { "verdict": "harness", "date": "2026-09-08",
                    "reason": "…why this expectation says what it says…" }
}
```

`world` knobs: `maxPlayers`, `players`, `attendance`, `features`,
`upcomingMatchInDays` (`null` = no match), `alsoMatchInDays` (a second
match, for rollover), `completedMatch`, `teams`, `openBenchSlotByDropping`,
`lastBotPost` (MatchTime's own last group post, as a `BotJob` row — NOT the
same channel as `history`, and what a bare "Confirmed" resolves against).

`messages` knobs: `from` (roster key or `{name, phone}` outsider), `body`,
`tag` (the `@Match Time` signal), `turn` (which analyze batch — turns run in
order and later turns see earlier ones as history), `route`, `facts`.

`expect` knobs: `attendance` (status or `ABSENT`), `unchanged`, `counts`,
`benchOffersOpen`, `score`, `teamsUnchanged`, `allowNewMembers`, `speaks`
(`silent` | `required` | `any`), `speaksAtMost`, `react`, `mustMention`,
`mustNotMention`, `mustMatch`, `mustNotMatch`, `claimsMatchWrites`,
`noRawPhone`.

### Writing `facts`

State the fields the case is ABOUT and leave the rest out.
`current-analyzer-pipeline.ts:withFactDefaults` fills the boring ones from
`e2e/helpers/stub.ts:claim()` — the same defaults the other twenty-one ported
spec files use, so a case and a spec that write the same claim cannot drift into
describing different messages. Per claim those defaults are:

```
subject "sender" · personRef "" · personNamed false · polarity "in"
contingent false · conditionOn "none" · tense "present" · basis "decision"
reported false · confidence 0.95            … and per body: affirmation "none", sideRequests []
```

The shape belongs to whichever extractor the `route` reaches — `attendance` for
`self_att` / `other_att` / `offer` / `unsure`, and `question`, `teams`, `score`,
`admin` for the four others. Those four are small enough to state in full and
are passed through untouched. It is the model's RAW JSON, so `parseFacts` still
runs for real on it: a drifted enum still drops its claim, `"none"` still maps
to a null affirmation, and `-1` / `""` are still the schema's stand-ins for null.

## Stubbed vs live

**A stub carries a ROUTE and some FACTS. It never carries a decision.** That is
the rule the whole file turns on, and `MDs/llm-pipeline-testing-playbook.md` §2
is the argument for it: a stub that can express "and therefore do X" is stubbing
the part of the system most likely to move, and when it moved — §10 step 8
deleting `analyzeBatch` — every test coupled to it stopped testing anything.

`stubKind` has exactly one legal value, and that is the point:

- **`transcribed`** — every stubbed field is a property of the message text,
  checkable by re-reading it: who is talking, about whom, in / out / bench,
  tense, contingent, named or not. The case then asks the only question a stub
  can honestly ask: **given a correct reading of this message, does the server
  decide and write correctly?**
- **absent** — the case is live-only. **The loader then requires
  `liveOnlyReason`**, so the count of CI-covered cases can never quietly drift
  away from the count of corpus cases. The four honest reasons are: the assertion
  IS the classification; **the READING of the message was itself the incident**,
  so any stub would contain the answer (S12, Mojib's "replace me and habibi");
  the asserted text is model-authored; or a stub is structurally impossible.

The two old values are gone. `corrected` said "the verdict a correct model
emits" and `historical` said "the verdict the model actually emitted on the
day", and the second has no successor at all: there was no router and no
extractor on 2026-05-08, so writing one and calling it history is rule 1 in
reverse. The eleven `historical` cases were split by asking, per case, whether
the READING was ever in doubt — ten were transcribed and kept in CI, one (S12)
went live-only. Each says which and why in its own `adjudication` block. The
loader rejects both old spellings by name so a half-ported case cannot load.

**Do not "record" facts from a live run.** The model is non-deterministic, so one
sample pins whatever it happened to emit — and §4.1 of the redesign doc measured
the Amir case emitting the ghost `registerFor: [{name: "Amir's brother"}]` on six
of six runs. A recorded stub there would enshrine the bug as the expected input.

## Adding a case

1. **Find the commit.** Rule 1: ground truth comes from git. `git show <ref>` and
   read what the fix actually changed.
2. **Build the world it landed in** — the squad, the bench, the open offer, the
   completed match, MatchTime's own last post.
3. **Write the message, then transcribe it.** Re-read the text and write down
   only what it SAYS. If you find yourself reaching for a field that means "and
   therefore register them", stop: that field does not exist, and the engine is
   what answers it.
4. **Say what must be TRUE afterwards**, in rows and speech properties. Never a
   golden string.
5. **Make sure it can fail.** If your expectation is "nothing happened", a
   pipeline that reads nothing satisfies it. Two ways out, in order of
   preference: transcribe facts that positively DEMAND the write the case says
   must not happen (so the case fails the moment a guard stops refusing), and add
   a CANARY — an unrelated message in the same batch whose write nobody disputes.
   Six cases carry one, each labelled in its `notes`. If neither is possible, say
   so at the case, in full: S21b does, because the assertion that would make it
   fail ("no `PaymentCredit` row") is not in `CorpusObservation` at all.
6. **Run it, then run it with the seam disabled.** A case that passes both ways
   is not a case.
## Adding a pipeline

Implement `CorpusPipeline` (`pipeline.ts`) and hand it to `runCorpus`. The
interface deliberately contained no `AnalysisVerdict`, no intents and no
`reasoning` — so that a router + extractor + engine which never produces a verdict
could implement it and be judged by exactly these cases. §10 step 8 deleted
`AnalysisVerdict` outright, which is the design being right on schedule rather
than a reason to relax the rule: the boundary must still carry only rows, member
names, speech, DMs and reacts.

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
how that is judged, and it is judged by running the **same 49 cases
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

## Pipeline #5 — the two routes that WRITE (§10 step 7 part 2)

```bash
set -a; source .env; set +a
npm run test:corpus:writes                       # 3 runs per case
MT_SIM_RUNS=1 npm run test:corpus:writes         # one pass, cheap
MT_CORPUS_FILTER=S21 npm run test:corpus:writes  # one case, verbose
```

`WriteRoutesPipeline` (`write-routes-pipeline.ts`) is router →
score/admin extractor → engine → **apply** → composer, for `score` and
`admin_ops`. Unlike pipeline #4 the fifth box is real: it records
scores, moves `matchRating`, stamps `Attendance.paidAt`, creates
`PaymentCredit` rows and queues reminder `BotJob`s against the corpus
database. So `scoreAfter` and `dms` are reads, not proposals.

It declares the cases it owns for the same reason pipeline #4 does, and
for the same reason should be replaced by a `CurrentAnalyzerPipeline`
subclass sending `x-mt-engine-routes` once the analyze route knows about
the flags.

Two things specific to it:

- **The apply layers' dependencies are injected, and this file supplies
  SQL ones.** The Playwright worker never loads Prisma, so
  `score-engine.ts` and `admin-ops-engine.ts` take their writes as
  arguments — the same seam that makes them unit-testable without a
  database. That does mean these SQL implementations are a second
  implementation of what the analyze route will inject, and a divergence
  between them would not show up here. They are one statement each, with
  no branching, precisely so there is nothing to diverge on.
- **The recruit blast is measured, not graded.** The engine decides WHO
  may ask; the blast itself is deferred to the route's batch-final pass
  (2026-09-01: a blast that ran before the batch's writes told the owner
  his squad was full one line after he said Najib was out). The grader
  has no text to judge, so the spec counts recognitions explicitly and
  prints "recruit ask recognised in N/M runs" instead.
