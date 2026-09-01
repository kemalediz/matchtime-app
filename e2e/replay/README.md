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
```

Everything the sweep writes lands under `.e2e/replay/` (gitignored).

---

## Validate the harness before you trust it

**Run the self-replay first.** With no `MT_REPLAY_CANDIDATE` the sweep
runs the current analyzer against *itself*, so every disagreement it
finds is model non-determinism or a bug in this harness — never a
pipeline difference. A 3% disagreement rate between two pipelines means
nothing if the same pipeline disagrees with itself 3% of the time.

The report prints that number first and labels it. Read it before
anything else.

---

## Four rules

**1. A world that cannot be PROVEN is excluded, never guessed.** A
verdict is meaningless without the squad state, the match, the capacity
and the sender's role at that moment, and a fabricated world produces a
fabricated diff — which is worse than no diff at all, because it reads
exactly like a real one. Every field of a replayed world sits in one of
two buckets:

- **Proven at the instant**, from row timestamps: which `Attendance`
  rows existed and what status they held, which `Match` was next and its
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

- **`attendance-state-unknown`** is the big one, and it is not fixable
  with more cleverness. There is no attendance audit log. A row that
  existed before a batch and was touched after it has an unknowable
  status *at* that instant — including when the batch itself was what
  touched it. Sutton's per-player payment metadata (live since
  2026-06-09) bumps `updatedAt` on confirmed rows for days after a
  match, which widens this further.
- **`batch-boundary-ambiguous`** — `AnalyzedMessage` has no batch id, so
  batches are recovered from write timing. Gaps under `BATCH_JOIN_MS`
  (2 s) are one flush; over `BATCH_AMBIGUOUS_MS` (10 s) are certainly
  two. In between, "one slow flush" and "two quick ones" are
  indistinguishable, so **both** neighbouring batches go.
- **`no-upcoming-match`** — a deleted `Match` row leaves no trace, so
  "there was no match" cannot be told from "the row was removed later".

**447 is a floor, not a disappointment.** It is 2.5x what the fortnight
in the plan would produce, it exists today, and it is biased towards
*honest* cases rather than convenient ones.

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
