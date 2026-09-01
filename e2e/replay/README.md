# The history replay harness

Step 3 of `MDs/analyzer-redesign-2026-08-31.md` §10 — *"Run two weeks;
read the diff. Criteria fixed in advance: zero cases where the new
pipeline would write and the old correctly did not; ≤2% where it would
miss a write the old one correctly made. Do not proceed on vibes."*

**We do not have to wait two weeks.** `AnalyzedMessage` holds **1,723
real production messages with bodies, back to 2026-04-20** — 4.5 months
of the same traffic a fortnight would sample. Production averages 12.9
analyzed messages a day, so the fortnight the plan asks for would yield
about 180. This harness replays that history through **any two
pipelines** and diffs them.

```
npm run replay:extract        # READ-ONLY against production, once
npm run test:replay           # free, stubbed: do the reconstructed worlds BUILD?
MT_REPLAY_LIMIT=80 npm run test:replay:live      # self-replay noise floor
MT_REPLAY_CANDIDATE=<module> npm run test:replay:live   # the real comparison

npm run replay:router-recall                     # §10 step 5: router recall, floor OFF
MT_RECALL_FLOOR=1 npm run replay:router-recall   # …and with the floor ON
```

Everything the sweep writes lands under `.e2e/replay/` (gitignored).

---

## The sweep must actually be live, and now says so

The noise floor is load-bearing: every candidate pipeline is judged
relative to it. A sweep run without a usable `ANTHROPIC_API_KEY` produces
the most flattering floor there is — two all-silent pipelines agree with
each other perfectly, 0% disagreement, green tick — and until
`fix/live-sweep-must-be-live` nothing noticed. It is the same defect the
corpus sweep had, where a keyless `npm run test:corpus:live` scored 8/47
in four seconds and passed.

`e2e/helpers/live-llm.ts` now refuses the run before it starts (missing,
blank or rejected key; a "live" run still wired to the stub seam; a
"stubbed" run carrying a real key), meters every model call so the
orchestrator can state what was really spent, and this spec reads
`AnalyzedMessage.reasoning` back at the end and fails if the messages
never reached the model. `result.json` carries that `reach` block.
**Quote the `LIVE confirmed` line alongside any floor you report**, the
same way you quote the ports.

---

## Validate the harness before you trust it

**Run the self-replay first.** With no `MT_REPLAY_CANDIDATE` the sweep
runs the current analyzer against *itself*, so every disagreement it
finds is model non-determinism or a bug in this harness — never a
pipeline difference. A 3% disagreement rate between two pipelines means
nothing if the same pipeline disagrees with itself 3% of the time.

The report prints that number first and labels it. Read it before
anything else.

### The floor is reported per class, because the classes mean different things

- **`speech_only`** is chattiness: one run posts the roster, the other
  stays silent on the identical world. Annoying, not dangerous.
- **`divergent_write`** is a player being in or out of a squad depending
  on luck. The same pipeline, the same message, the same world, two
  different attendance outcomes.

Every rate carries a **Wilson 95% interval**, because a rare event over
a few dozen replays is not a point estimate: 0 of 80 does not mean 0%,
it means "somewhere under about 4.5%".

### The criteria are RELATIVE to the floor

§10 step 3's *"≤2% where it would miss a write the old one correctly
made"* is meaningless as an **absolute** if the incumbent cannot
reproduce its own writes. A candidate scoring 1% against a 2% incumbent
floor is **better**, not a regression.

So the report:

- states whether the ≤2% bar **can discriminate at all** — it can only
  do so if the incumbent's own write-level interval sits entirely below
  it;
- compares a candidate to the stored floor (`MT_REPLAY_FLOOR=<an earlier
  result.json>`) and answers *better · indistinguishable · worse*;
- says how many replays a ±1pp interval would need, and what that costs,
  instead of shrugging at a number it cannot support.

### Where the write-level noise sits

Counting it is not enough. The report clusters write-level disagreements
by production's own intent label and reports the **concentration**: if
most of them land on one intent, that is a **named defect worth its own
PR**, not background non-determinism. Spread out, it reads as the model
being the model.

---

## Four rules

**1. A world that cannot be PROVEN is excluded, never guessed.** A
verdict is meaningless without the squad state, the match, the capacity
and the sender's role at that moment, and a fabricated world produces a
fabricated diff — which is worse than no diff at all, because it reads
exactly like a real one. Every field of a replayed world sits in one of
two buckets:

- **Recorded at the instant**, from the append-only `AttendanceEvent`
  log (2026-09-01 onwards): the exact status and position of every squad
  place, folded forward to the batch instant. Not inferred — recorded.
- **Proven at the instant**, from row timestamps, where the log does not
  reach: which `Attendance` rows existed and what status they held
  (only when a row was already settled), which `Match` was next and its
  kickoff / capacity / deadline, who was a member
  (`Membership.createdAt` / `leftAt`), who sent each message and whether
  WhatsApp gave a phone, the bodies, the batch, the chat history.
- **Assumed stable**, because no audit trail exists: org feature flags,
  membership roles (`Membership` has no `updatedAt`), display names,
  activity kickoff time and deadline hours. If one of those changed
  during the window, affected replays are wrong in a way this harness
  cannot detect. Said out loud rather than hidden.

Anything else is an `Exclusion` with a reason, and the reasons are
counted in the report.

**2. The old pipeline is NOT ground truth.** §10 step 3's wording is
"would write and the old **correctly** did not". The word doing the work
is *correctly*, and no machine supplies it. So the harness separates:

- the **class** — structural, computed: who wrote what;
- the **verdict** — an `Adjudication`, written by a human: who was right.

Until a disagreement is adjudicated it counts towards nothing, and
`passesStep3` renders **UNDECIDED**. A sweep nobody has read can never
come out as a pass. On 2026-08-30 the incumbent told a real customer
group three named players would be benched when nobody would be; it is
the thing under test, not the answer key.

**3. Diff on decisions and writes, not wording.** `registerAttendance`,
`registerFor`, whether a reply was sent at all. Reply text is compared
only as the properties the incident corpus already uses — does it name
one of this world's players, does it claim a move the database did not
make, does it leak a phone number — using the corpus's own matchers,
not a second regex.

**4. The unit of replay is the analyze BATCH.** The Pi buffers messages
and flushes a *window*; the route reasons over all of it at once.
Replaying one message at a time would compare a world production never
analysed.

---

## Files

| file | what it is |
| --- | --- |
| `types.ts` | the data shapes: raw rows in, `ReplayCase` out |
| `reconstruct.ts` | **the rules.** Rows → cases, or an exclusion with a reason. Pure |
| `diff.ts` | write sets, speech properties, classes, and §10 step 3's criteria. Pure |
| `sample.ts` | explicit, stratified, seeded sampling. Pure |
| `ledger.ts` | append-only resume ledger |
| `sweep.ts` | the driver: two pipelines, one batch at a time |
| `report.ts` | the human report and the triage cards. Pure |
| `extract.ts` | READ-ONLY production extract (the only thing that touches prod) |
| `meter.ts` | metering proxy — measured cost, without editing the analyze route |
| `../sim/history-replay.spec.ts` | free, stubbed: the worlds build |
| `../sim/history-replay-live.spec.ts` | the paid sweep |

There is **no second pipeline abstraction**. Both sides implement
`CorpusPipeline` (`e2e/corpus/pipeline.ts`, PR #32), so the incident
corpus and the history replay judge the same objects.

---

## What actually replays, and why the rest does not

Measured against production on 2026-09-01 (2026-04-20 → 2026-09-01):

```
447 of 1,723 messages replayable (25.9%), in 241 of 962 analyze batches
  strict 167 batches · wide 74

excluded:
  attendance-state-unknown   638 batches / 1,149 messages
  batch-boundary-ambiguous    62 batches /   104 messages
  no-body                     16 batches /    16 messages
  sender-unknown               3 batches /     5 messages
  no-upcoming-match            2 batches /     2 messages
```

- **`attendance-state-unknown`** is the big one. There was no attendance
  audit log, so a row that existed before a batch and was touched after
  it has an unknowable status *at* that instant — including when the
  batch itself was what touched it. Sutton's per-player payment metadata
  (live since 2026-06-09) bumps `updatedAt` on confirmed rows for days
  after a match, which widens this further.
- **`batch-boundary-ambiguous`** — `AnalyzedMessage` had no batch id, so
  batches are recovered from write timing. Gaps under `BATCH_JOIN_MS`
  (2 s) are one flush; over `BATCH_AMBIGUOUS_MS` (10 s) are certainly
  two. In between, "one slow flush" and "two quick ones" are
  indistinguishable, so **both** neighbouring batches go.

### Both were recording gaps, and both are now closed — forwards only

Shipped 2026-09-01:

- **`AttendanceEvent`**, an append-only log of every squad-place
  transition (who, which match, from what status to what, when, why, and
  what caused it), written *inside the same transaction* as the change
  and refused any UPDATE or DELETE by a database trigger. `reconstruct.ts`
  now folds it in preference to row timestamps (`logCoverage` +
  `squadStateAt`), so a batch is replayable whenever the log covers its
  match.
- **`AnalyzedMessage.batchId`**, stamped per analyze request. Where it is
  set, the batch is read rather than inferred and nothing is ambiguous.

**Neither recovers a single one of the 1,723 messages already on disk,
and the headline number does not move because of them.** The log cannot
reach backwards; a squad state nobody wrote down is gone. What changes is
tomorrow: every batch analysed after the migration is applied is
reconstructable, and the 104 lost to batch ambiguity become zero.

The report says this out loud every run, under **`recording, not
inference`**, with two counters — how many replayable batches had their
squad *proven* from the log, and how many were read from a recorded
`batchId`. Both read `0 of N` on the 2026-09-01 extract, and the report
states in words that this is expected rather than leaving a reader to
assume the fix underperformed. `ReplayMeta.squadSource` carries the same
fact per case, so log-proven and timestamp-inferred worlds can never be
silently mixed inside one number.

A match is only covered when **every** one of its attendance rows was
created at or after the log's first event. A half-recorded history would
fold into a squad with players missing — a fabricated world, which is
the one thing this harness exists not to produce.
- **`no-upcoming-match`** — a deleted `Match` row leaves no trace, so
  "there was no match" cannot be told from "the row was removed later".

**447 is a floor, not a disappointment.** It is roughly **ten times the
46-case incident corpus** and about **2.5x what the fortnight in the plan
would produce**, it exists today, and it is biased towards *honest* cases
rather than convenient ones.

### 74% unusable is itself a finding: what is fixable, what is gone

`EXCLUSION_TRACTABILITY` in `reconstruct.ts` classifies every reason, and
the report totals them:

| reason | tractability | what would fix it |
| --- | --- | --- |
| `attendance-state-unknown` | structurally lost **backwards**, fixable **forwards** | an append-only `AttendanceEvent` log (`matchId, userId, from, to, at, cause`). It would make every future batch replayable and give the admin UI a history it has never had. It cannot recover April→September. |
| `batch-boundary-ambiguous` | **fixable** | one nullable `batchId` column on `AnalyzedMessage`, stamped by the analyze route. Removes the class entirely for future traffic. |
| `no-body` | structurally lost | media and stickers have no text |
| `no-upcoming-match` | structurally lost | a deleted `Match` leaves no trace; soft-delete would fix it forwards |
| `sender-unknown` | structurally lost | the pushname was never persisted |
| `no-roster` | structurally lost | no membership row predates the batch |

**Both fixes are small and both are worth doing before step 6 leans on
this harness**, because step 6 is the one that can put a player at a
pitch with no slot. Neither helps the history already on disk.

### What this harness is NOT

It is **not the two-week live parallel run §10 step 3 asks for**, and it
cannot replace one:

- it replays a *reconstructed* world, not the live one, and only the 26%
  of it that can be proven;
- it cannot see anything the recorded state never captured — reactions
  the Pi swallowed, DMs outside the analyze path, or a decision that
  turned on the real calendar date;
- it is biased towards batches that changed nothing, because a batch that
  wrote is more likely to have left an unknowable pre-state;
- it says nothing about production *latency under load*, retries, or the
  `after()` shadow path.

What it does give, today, is ten times the corpus in real traffic with a
measured noise floor. Treat it as the evidence that makes a shorter live
parallel run safe to start — not as the run itself.

### The clock is relative, and that is a choice

A replay runs *now*, so a world is rebuilt with the same **distance** to
kickoff the message really had, not the same calendar date. Everything
that gates a decision — deadline passed or not, how close the chase is,
whether bench offers are live — is a function of that distance.

The cost: the replayed kickoff lands on an arbitrary weekday and time
(one observed run produced "Tue 15 Sept 03:02"). Copy that names the day
is not faithful, and a prompt reasoning about "Tuesday" may behave
differently than it did. Both pipelines see the same synthetic clock so
the diff still holds — but a disagreement that turns on the day of the
week does not, and should be adjudicated `both_right`.

### Tiers

- **strict** — every element of the world was proven. Headline criteria
  are computed on these.
- **wide** — the same, but the world is knowingly *thinner*: the
  previous completed match was left out because its state at that
  instant is unrecoverable (score and payment metadata land after the
  whistle). Both pipelines see the identical thinner world, so the diff
  still holds; what weakens is the claim that this is exactly what
  production saw. Every triage card prints the caveat.

### The intent mix falls out as a measured fact

`noise` is **69.3%** of all analyzed traffic — the redesign's core
economic claim (§8.3: *"44x cheaper on the case that happens most"*),
measured rather than asserted.

---

## Router recall (§10 step 5) — a different question, same extract

The sweep above compares two **pipelines** over the 447 batches whose
world can be proven. Step 5's question needs neither a world nor a
second pipeline: *given a message, would the router have thrown it
away?* So `router-recall-live.ts` routes **all 1,695 messages that have
a body** — every one, not the replayable quarter — through the real
router, in the batches the extract recovered, and reports two numbers.

- **The saving.** Benign messages (production called them `noise`,
  `unclear`, or `non-c.us author`) routed `none`. Boring and expected;
  it is 69.3% of traffic.
- **The danger.** **Non-benign** messages routed `none`. Each one is a
  message the gate would delete before the analyzer ever saw it. The
  report lists **every instance**, sorted worst-first by what it would
  cost:

  | severity | intents | what a `none` route costs |
  | --- | --- | --- |
  | `squad_place` | `in` `out` `conditional_in` `conditional_out` `replacement_request` `team_swap` `bring_guests_vague` | a player's slot. The one that matters. |
  | `action` | `generate_teams_request` `score` `reminder_request` `recruit_*` `show_teams_request` `stats_*` | the bot fails to do something it was asked to do |
  | `speech` | `question` `rating_progress` | the bot stays quiet where it would have answered |
  | `benign` | `noise` `unclear` `non-c.us author` | nothing — this is the saving |

  An intent the table does not list is treated as `action`, never as
  benign: a label added next year must not silently stop being counted.

**Production's `intent` is the incumbent's opinion, not truth** — the
same rule as rule 2 above. The report says *disagreement*, never
*wrong*, and asks for a human verdict on each one.

**Only the `none`/not-`none` boundary matters here**, which is why the
report never grades the route itself. The gate discards the route and
keeps only the membership decision, so the router being unstable
*between* `self_att` and `other_att` (observed: "can anyone replace me
tonight?" split 4/1 over five runs) changes nothing at all about what
the analyzer receives.

### It proves it was live, for a reason specific to this harness

`routeBatch` catches a failed call and routes the whole batch `unsure`
(§11.4 — fail open). That is the right production behaviour and a trap
for a measurement: a keyless run produces **zero `none` routes**, and
therefore a flawless **0% miss rate**, in about a minute. It is the
same shape as the keyless `test:corpus:live` that scored 8/47 and
passed.

So the script refuses without a key; probes the **exact router model**
(`claude-haiku-4-5`) rather than `PROBE_MODEL`, because a key with
Sonnet access but no Haiku access sails through the latter and then
falls back on every batch; fails on zero billed calls; fails when more
than 5% of routes came from the fallback; and prints a `LIVE confirmed`
line to be quoted alongside the number.

`MT_RECALL_LIMIT=N` caps a run for a smoke test and stamps
`PARTIAL RUN` on the report so it can never be quoted as the full sweep.

## Classification

Structural, computed per replayed batch:

| class | meaning | §10 step 3 |
| --- | --- | --- |
| `spurious_write` | NEW wrote where OLD did not | target **zero** |
| `missed_write` | OLD wrote where NEW did not | target **≤2%** |
| `divergent_write` | both wrote, differently | — |
| `speech_only` | identical writes, different speech | — |
| `error` | a replay threw; not a measurement of anything | kept out of every denominator |

Human, in `.e2e/replay/adjudications.jsonl` (one JSON object per line):

```jsonc
{"key":"g-abc:2026-05-12T18:30:00.000Z","verdict":"old_right","note":"he really was in"}
```

`old_right` · `new_right` (the brief's "new pipeline better") ·
`both_wrong` · `both_right`. A `missed_write` adjudicated `new_right`
does **not** count against the candidate: the incumbent was the one that
was wrong.

`npm run test:replay:live` writes `triage.md` with one card per
disagreement — the messages, the squad state, hours to kickoff, the
caveats, what each side wrote and said — and a line to paste back.

---

## Cost and latency

`meter.ts` is an HTTP proxy in front of `api.anthropic.com`. Set
`MT_REPLAY_METER_PORT` and the server under test is pointed at it via
`ANTHROPIC_BASE_URL`; every call is forwarded verbatim and its `usage`
block banked, giving exact input / output / cache-read / cache-write
tokens priced with §8's table. Nothing under `src/` is touched.

**In a self-replay the per-pipeline split is a prompt-cache artefact**:
the first side pays the cache write, the second reads it back at 0.1x.
Only the sum means anything, and the report says so.

---

## Resumability and sampling

The sweep appends one line per completed unit (case × pipeline × repeat)
to `.e2e/replay/<runId>.jsonl`, and a restart replays only what is
missing. `runId` is derived from the sweep's **shape** — pipelines,
repeats, mode, the exact set of case keys — so a resume can only ever
join a run that is genuinely the same one. Errored units are not
retained, so a transient timeout is retried on resume.

`MT_REPLAY_LIMIT` caps a run. The cap is **stratified by production's
own intent label** so it cannot fill itself with the 69% that is noise,
and the report leads with a `PARTIAL RUN` banner naming the cap, the
seed, the strategy and the per-stratum counts. A partial run can never
read as a complete one.

---

## Privacy

Real club members' names and messages. The extract stays out of git the
way the corpus's bulk output does — `.e2e/` is gitignored — and nothing
routable leaves the database:

- `authorPhone` → the boolean `authorHadPhone`; `User.phoneNumber` →
  `hasPhone`;
- the group JID → a one-way hash (`groupRefOf`);
- **`waMessageId` → a one-way hash.** WhatsApp message ids embed both a
  phone number and the group JID
  (`false_447…-160…@g.us_ACD6…`), which is exactly the kind of thing
  that walks out of a file nobody looked at twice;
- a pushname that *is* a phone number → a stable pseudonym;
- message bodies → `redact()`, which strips JIDs and phone numbers.

The stubbed spec asserts all of this on the real extract, so a
regression fails a free test rather than a paid one.

---

## Running the suite alongside other checkouts

`e2e/helpers/env.ts` hard-codes ports 3105 / 54311 and
`playwright.config.ts` sets `reuseExistingServer: true`, so two
checkouts running the suite share a database and a dev server: one
`resetDb()` truncates the other's world mid-sweep. Check
`lsof -ti :3105` first, or edit the ports locally before a long run.
