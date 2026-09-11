# Router accuracy, and what is left of the regex — 2026-09-11

Kemal, 2026-09-11: *"see what can be done to increase the accuracy of the
routing, instead of using regex if possible"*.

This document is in three parts and the order is deliberate.
**Part 1 is what was measured.** Part 2 and Part 3 are proposals, and
they are kept separate from Part 1 so a number can never be quoted as if
it were a plan or the other way round.

Everything in Part 1 is a live measurement made today against the real
Sutton FC history, with the real models. Nothing in it was written to a
production table, no `BotJob` was created, and no WhatsApp message or DM
was sent. The only production access was `BEGIN TRANSACTION READ ONLY`.

Total spend on the measurements below: about **$18.90** of live API
calls, itemised in Appendix A.

---

## 0. The one-paragraph answer

The router's `none`/not-`none` decision — the only one that can lose a
player their place — is already good: **3 of 373 real attendance
messages in 143 days of history are called banter** (0.80%, stable over
three live runs). The rest of the routing is much weaker than that
number suggests: **overall owner accuracy is 83.1%**, `admin_ops` fires
on six wrong messages for every right one, and 21% of banter escapes the
`none` bucket and buys an extractor call. **The fix is the prompt, not
the model and not a second pass.** A rewritten router prompt, measured
over the whole corpus, lifts owner accuracy to **91.1%** on the same
Haiku, cuts banter escaping `none` from 21.3% to 10.5% and nearly
triples `admin_ops` precision. Put that same prompt on Claude Sonnet 5
and the attendance-to-`none` rate goes to **0 of 373, three runs out of
three** — for about **+$1.93/month** at peak traffic. Note the direction
of that result: a bigger model on the **current** prompt is *worse* at
exactly this (6.0 of 93 against Haiku's 4.4). The prompt is the
constraint; the model only pays off once the prompt is right.

Of the four surviving regexes, three have **never once fired** in
production and one fired correctly once; two should be converted, one
should be converted only alongside a new extractor fact, and **`HELP_RE`
should stay a regex** — that recommendation is argued in §2.4, not
hedged.

**Recommended order:** §3.1 (rewrite the prompt) → §3.2 (make the
`none`-bucket sweep observable — it has filed one row in five nights) →
§3.4 (move the router to Sonnet 5) → Part 2 (convert the regexes, last,
because every conversion moves work onto the two routes that are
currently least precise).

---

# PART 1 — WHAT WAS MEASURED

## 1.1 The corpus, and a correction to the records

`npm run replay:extract` was re-run today (read-only, production).

| | this extract (2026-09-11) | what `e2e/replay/README.md` and `gate.ts` say |
|---|---|---|
| `AnalyzedMessage` rows | **1,776** | 1,723 |
| …with a body | **1,748** | 1,695 |
| recovered analyze batches | **974** | 962 |
| span | 2026-04-20 → 2026-09-10 (143 days) | to 2026-09-01 |
| `noise` share | **69.1%** | 69.3% |
| replayable (full-world) | 470 (26.5%) in 256 batches | 447 (25.9%) in 241 |

Two real orgs: Sutton FC (1,557 messages) and Sutton Lads (215, churned
2026-06-18). Four rows are test-org noise.

**Volume is extremely spiky and the cost model has to use the peak, not
the mean.** Messages per month: Apr 243 · May 597 · **Jun 656** · Jul 211
· Aug 10 (summer break) · Sep 59 so far. The mean of 12.2/day understates
a match week by 3x.

## 1.2 Ground truth: there wasn't one, so one was built

`e2e/replay/router-recall.ts` grades against production's own `intent`
column, and it says so itself: *"Production's `intent` is the incumbent's
opinion, not truth."* That caveat is stronger than it reads, and it
biases the published number **in the flattering direction**:

> `SEVERITY_BY_INTENT` maps `noise` and `unclear` to `benign`, so a real
> attendance claim that the old mega-prompt mislabelled `noise` is counted
> as **the saving** when the router calls it `none`, not as a miss.

Three such messages are in the corpus by inspection: `"@Yoobie IN"`,
`"@Match Time Kieran and Rashad are IN"` and `"I can play @Kemal Ediz .
Your bot is spamming me in DM 😒"` — all labelled `noise` by production,
all plainly attendance. The reverse error is there too: `"@Match Time
swap Elvin with Abid please, then post the teams again"` is labelled
`out`, and MatchTime's *own* posts ("We're 9/14 for 7-a-side…") are in
the table labelled `question` and `in`.

**So a hand-adjudicated gold set was built.** 445 unique message bodies,
each labelled by me with the OWNER it should reach, not the route:

| label | owner | routes that satisfy it |
|---|---|---|
| `A` | attendance engine | `self_att` `other_att` `offer` `unsure` |
| `Q` | `pipeline/answer-batch.ts` | `question` |
| `B` | balancer / team-ops | `balancer` |
| `S` | score engine | `score` |
| `D` | admin-ops engine | `admin_ops` |
| `N` | nobody — skipped | `none` |

Owner, not route, because `gate.ts` throws the route away at the
boundary: `self_att` vs `other_att` changes nothing about who handles the
message. Composition: every one of the **325 unique non-benign bodies**,
plus a deterministic stride sample of **120 of the 1,199 unique benign
bodies**. Directly covers 641 of 1,748 messages; the benign sample
carries a re-weighting factor of **10.17** for traffic-level estimates.

**How trustworthy is it, honestly.** It is one reader's judgement, and
the rubric has genuinely contestable edges — "we are short 2 players for
Sunday morning at Goals Sutton" (a *different* fixture) is labelled `N`;
"I will be back Tuesday week" is labelled `A` and left to the extractor's
`availability` vs `decision` distinction. Two labels were corrected for
internal consistency (a general chase for players must reach the
attendance extractor so its `sideRequests: chase` fact is reported) —
**before** any candidate prompt was run, and the correction is recorded
in the scratch data. Where a message legitimately carries two
instructions the gold label is a set (`A|B`) and either satisfies it.
**Anything traffic-weighted below rests on the 120-body benign sample and
should be read as an estimate with a factor-of-10 lever on it; the raw
counts alongside are exact.**

## 1.3 The headline: per-owner precision and recall on real traffic

Full live sweep, `npm run replay:router-recall`, floor OFF:
**1,748 messages · 974 batches · 974 billed `claude-haiku-4-5` calls ·
$1.2488 · 1,457.7 s of model time · 0.1% fallback.**

Scored against the gold set, **traffic-weighted** (≈1,751 messages):

| owner | precision | recall | what the error means |
|---|---|---|---|
| `A` attendance | **84.7%** | **94.5%** | 5.5% of real attendance does not reach the engine |
| `Q` question | 46.0% | 75.8% | cheap: `answer-batch` refuses untagged, so most FPs cost nothing |
| `B` balancer | 39.3% | 84.4% | an unwanted team regen is visible and annoying |
| `S` score | 100% | 100% | — |
| `D` admin_ops | **14.9%** | 87.6% | **six wrong for every right one, in front of the mass-DM door** |
| `N` none | 97.4% | 78.5% | 21.5% of banter escapes and buys an extractor call |

**Overall owner accuracy: 83.1%** (est. 1,455 of 1,751).

Unweighted, on the 641 directly-labelled messages (exact counts, no
sampling lever): `A` P93.9 / R95.7 · `Q` P60.0 / R83.6 · `B` P84.4 /
R84.4 · `S` P100 / R100 · `D` P22.7 / R71.4 · `N` P94.4 / R64.2.

### The confusion pairs that actually occur, ranked

Traffic-weighted, off-diagonal only:

| rank | pair | est. messages | representative real message |
|---|---|---|---|
| 1 | **N → D** | 77 | `"£8.6 per person to Elvin"` · `"exactly that's the main aim hence please click and rate players after each game…"` |
| 2 | **N → A** | 73 | `"@Zeeshan they asked can anyone step in i said in you can check up the messages"` |
| 3 | **N → Q** | 59 | `"who wins tonight?"` · `"should we play?"` · `"Have they played with us before?"` |
| 4 | **N → B** | 41 | `"ok calling goals to switch to 5aside"` · `"@Youssef teams pls"` |
| 5 | **Q → N** | 12 | `"@Match Time , who is 🥁?"` · `"@Match Time I guess we have 13 now and need one more"` |
| 6 | **A → N** | 12 | see §1.4 — three distinct messages |
| 7 | **A → Q** | 11 | `"Hi, is there anyone who can replace me in today's match?"` |

**Every one of the top four is the same error: banter that should have
stopped at the router did not.** That is the whole of the router's
precision problem, and the `N → D` corner of it is the one with teeth —
`admin_ops` is the route that reaches `AdminFacts.action = "recruit"` and
`"stats_blast"`, the two mass-DM doors. It is currently held shut by
`RECRUIT_BLAST_REQUIRES_TAG` and `STATS_BLAST_REQUIRES_TAG` (both `true`)
and `STATS_BLAST_TAG_MUST_BE_EXPLICIT`, and the measurement above is the
argument for **never** setting any of them to `false`: the route those
constants guard is wrong 85% of the time it fires.

`A → Q` is the second-order finding and it is the 2026-09-01 incident
class wearing a different hat: *asking the group for a replacement* is
routed `question`, so the attendance extractor never runs and the
`sideRequests: "recruit" | "chase"` fact it would have reported is never
produced. `answer-batch` then refuses the message for being untagged and
nothing happens at all.

## 1.4 The question `gate.ts` calls the biggest risk in the design

> *"Missing a saving costs pennies. Missing a player's IN costs them
> their place."*

Quantified, against my labels, over 143 days:

Every batch in the corpus containing at least one gold-labelled
attendance message (294 batches, **373 attendance messages**) was routed
through the live router **three times**, in its real production batch:

| run | attendance messages routed `none` |
|---|---|
| 1 | 3 of 373 |
| 2 | 2 of 373 |
| 3 | 4 of 373 |
| **mean** | **3.0 of 373 — 0.80%**, Wilson 95% CI **[0.27%, 2.3%]** |

Traffic-weighted the point estimate is 12 of 456 (2.6%), but that figure
rests on three distinct messages and one of them carries the 10.17 benign
weight, so the weighted number is the fragile one and the raw count is
the honest one.

The messages lost, across all three runs:

```
"very good lads, same quality and friendliness as ours, come on, one player please"   3/3 runs
"So if anyone wants to play then they can take the last spot"                          3/3 runs
"Lemme know if we need more to make it 14. I can find another"                         1/3 runs
"@all we need more players old"                                                        1/3 runs
"Confirmed"                                                                            1/3 runs
```

Four of the five are **offers or chases** — the "can anyone cover / we
need one more" shape. The fifth is `"Confirmed"`, a bare affirmation,
which is precisely the class `awaiting-answer.ts` exists to rescue and
which these runs deliberately routed with `awaiting: null`.

**Not one "In", "Out", "@Adam IN", "Zeeshan OUT" or pasted roster in the
entire 143-day history was routed `none`, in any run.** That is a real
and creditable result and it is the strongest thing in this document in
the router's favour.

For comparison, the existing harness reports **17 of 517 (3.3%)** against
production's `intent`, of which it calls 5 `squad_place`. Reading those 5
by hand: 2 agree with my labels (the two chases above), and 3 I judge
correctly routed `none` — `"For Tuesday session too"` (a context-free
fragment), `"If I was in the team it won't be ruined"` (a counterfactual
the extractor's own `tense: hypothetical` exists for), and `"Shahrokh"`
(a bare name). The harness also misses one that it counts as *saving*.
**Net, by hand: 3, not 5.** The harness's number is not wrong so much as
built on a label column that is 85% right.

### The `none` bucket in live production

27 rows since the router went live on 2026-09-06 (2026-09-07 → 09-09).
I read all 27. Every one is genuine banter — Arsenal chat, a charity
bike ride, a McDonald's coffee link, `"Well done to reds, well deserved
win"`. One is a bare `"Yes"`, which is the affirmation class that
`awaiting-answer.ts` exists to catch and which was not answering an open
question.

### ⚠️ The only thing watching that bucket has filed one row, ever

`none-shadow.ts` is described in `gate.ts` as *"the ONLY remaining thing
watching for a real IN the router called banter"*. Queried read-only
today:

```
WindowVerdict rows in total:                506
…from the none-bucket shadow:                 1      (2026-09-09 02:00 UTC)
```

The cron is scheduled nightly in `vercel.json` and the flag is evidently
on, because that one row exists. But
`src/app/api/cron/none-bucket-shadow/route.ts:65` files a row only
`if (orgId && result.checked > 0)`, and `orgId` is taken from
`result.alerts[0]?.orgId` — **so a night with zero alerts writes nothing
at all.** A sweep that ran and found nothing and a cron that never fired
leave identical evidence. This is precisely the failure class
`SESSION-HANDOFF-2026-09-09.md` names ("the thing that actually matters:
nothing was watching") reappearing inside the fix for it.

Worth knowing too: the one alert it has ever raised was, by my reading, a
**false positive** — `"@Wasim could you add your friend Raihan to the
group? He is quite convenient for this group"` produced
`{polarity: "in", personRef: "Raihan", confidence: 0.5}`. That is a
request to add someone to the *WhatsApp group*, not the squad.

## 1.5 Cost and latency of the router as it stands

Measured, not estimated, from the full sweep:

| | value |
|---|---|
| model | `claude-haiku-4-5` ($1.00 / $5.00 per MTok) |
| system prompt | **661 tokens** (see the correction below) |
| per batch | **$0.001282** · **1.50 s** |
| per message | $0.000714 · 0.83 s |
| batch size, real traffic | 1.79 messages |
| attendance extractor, for comparison | **$0.00162/call · 2.03 s/call** (`claude-sonnet-5`, measured over 10 live calls) |

At the **peak month** (656 messages ≈ 366 batches): router **$0.47/month**,
plus 518 attendance-extractor calls per 1,748 messages → **$0.31/month**.
**Total LLM spend on routing + attendance extraction at peak traffic
today: about $0.78/month.**

### Measured per-batch cost of every prompt × model combination

Direct probe, one representative two-message batch, **no cache marker**,
so these are true cold costs — which is what production actually pays
(see the caching note below):

| prompt | `claude-haiku-4-5` | `claude-sonnet-5` |
|---|---|---|
| current (2,501 chars) | **$0.00107** | $0.00278 |
| candidate v2 (7,811 chars) | **$0.00244** | **$0.00651** |

These line up with the full-sweep figures for Haiku ($0.001282 and
$0.00264 over 974 real batches). They do **not** line up with the
Sonnet full sweep, and the reason is the next section.

### ⚠️ Two corrections to the code's own comments

**1. The router prompt is 661 tokens, not ~360.** `gate.ts:31` says
*"~360 tokens"*, `llm.ts:44` says *"the router emits ~140 tokens for a
batch of eight"* and *"The router prompt is ~360 tokens"*. Measured with
`messages.count_tokens` against `claude-haiku-4-5`: **661**
(2,501 characters). Nearly double. Nothing breaks because of it; it
matters because the next section's arithmetic is built on it.

**2. `MIN_CACHEABLE_CHARS = 4_000` is calibrated for Sonnet and is wrong
for the router's model by a factor of four.** `llm.ts` attaches
`cache_control` when `req.system.length >= 4000` — about 1,100 tokens.
Claude Haiku 4.5's minimum cacheable prefix is **4,096 tokens**. Probed
directly today on `claude-haiku-4-5`:

```
system 4,719 chars / 1,328 tokens + cache marker  → cache_read 0      cache_write 0
system 15,979 chars / 4,408 tokens + cache marker → cache_read 4,400  cache_write 0
```

Today this is harmless: the router prompt is 2,501 chars, under the
threshold, so no marker is attached. **It becomes a trap the moment the
prompt grows** — any router prompt between ~4,000 and ~15,500 characters
will report `cacheAttempted: true`, show up in a sweep as "caching was
asked for", and cache **nothing**. That is the exact defect §8.5 records
("several `cache_control` markers sit on prompts below the minimum
cacheable prefix and are silent no-ops"), re-armed.

**And it is not hypothetical — it bit this investigation.** The candidate
prompt in §3.1 is 7,811 characters. Probed on both models:

```
claude-sonnet-5 : 2,751 tokens → 2nd call input=10    cache_read=2,741   CACHED
claude-haiku-4-5: 2,036 tokens → 2nd call input=2,036 cache_read=0       NOT CACHED
```

The same prompt caches on Sonnet 5 and silently does not on Haiku 4.5
(note the tokenizers differ too: 2,751 vs 2,036 tokens for identical
text). That made the **nominally more expensive model measure cheaper**
in the full sweep — Sonnet $0.00179/batch against Haiku's $0.00264 —
which is an artefact, not a finding. Back-to-back sweep calls hit a warm
cache; production flushes one batch every ten minutes against a 5-minute
default TTL and will almost always be cold. **Every cost figure in Part 3
uses the uncached probe, not the sweep, for Sonnet.**

## 1.6 How much of the error is the model being random

220-message held-out set, **5 live repeats per arm**, identical batching.

| | baseline (`claude-haiku-4-5`) |
|---|---|
| single-run owner accuracy | 173, 170, 171, 170, 174 → **mean 171.6 / 220 (78.0%)** |
| messages whose **route** flipped across 5 runs | 19 / 220 (8.6%) |
| messages whose **owner** flipped across 5 runs | 12 / 220 (5.5%) |
| gold-attendance routed `none` in ≥1 run | 5 / 93 |
| gold-attendance routed `none` in **all 5** runs | **3 / 93** |

**The failures are persistent, not random.** Three of the five
attendance misses are the same three messages every single run. That is a
prompt property, and it means the levers that attack randomness cannot
fix them — which the next two measurements confirm.

### Self-consistency (a "cheap second pass") buys nothing

Majority vote over the same 5 runs:

| arm | mean single run | majority-of-5 | delta |
|---|---|---|---|
| baseline haiku | 171.6 / 220 | **172 / 220** | +0.4 |
| candidate haiku | 196.0 / 220 | **195 / 220** | **−1.0** |
| candidate sonnet-5 | 201.6 / 220 | 204 / 220 | +2.4 |

Three or five samples of the same prompt cost 3–5x and recover between
−0.5 and +1.1 percentage points. **Rejected on the measurement.** This is
the same conclusion `recruit-request.ts` reached by argument — *"another
sample at temperature 1: the same coin flip, one layer down, dressed up
as a safeguard"* — now with counts behind it.

### Batching is not hurting the router either

| arm | batches of 6 | one message per call | cost multiple |
|---|---|---|---|
| baseline | 171.6 / 220 | 171.5 / 220 | **4.1x** |
| candidate | 196.0 / 220 | 197.5 / 220 | 4.9x |

Un-batching the router costs four to five times as much and moves
accuracy by less than the run-to-run spread. **Rejected.**

## 1.7 The model is not the constraint — the prompt is

Held-out 220-message set (the half of the gold set the few-shot
examples were NOT mined from), same batching, 3–5 live repeats each.

| arm | model | owner accuracy | gold-A routed `none` | $/220 msgs | s/call |
|---|---|---|---|---|---|
| current prompt | haiku-4-5 | 78.0% | 4.4 / 93 | $0.059 | 1.9 |
| current prompt | **sonnet-5** | 83.0% | **6.0 / 93** | $0.246 | 4.9 |
| current prompt | sonnet-5, thinking off | 80.6% | **6.0 / 93** | $0.151 | 2.0 |
| + rules only | haiku-4-5 | 84.5% | 3.0 / 93 | $0.073 | 2.4 |
| + examples only | haiku-4-5 | 89.1% | 1.7 / 93 | $0.085 | 2.4 |
| **+ rules + examples** | haiku-4-5 | 89.1% | 3.0 / 93 | $0.099 | 2.2 |
| + rules + examples | sonnet-5 | **91.6%** | **0.4 / 93** | $0.178 | 4.7 |

**The single most useful line in this document:** moving the *current*
prompt from Haiku to Sonnet 5 buys 5 points of overall accuracy and makes
the one metric that matters **worse** — 6.0 of 93 attendance messages
routed `none` against Haiku's 4.4 — for 4.2x the cost and 2.6x the
latency. Sonnet is not bad at this; it follows the current prompt more
literally, and the current prompt does not say the right thing. Fixing
the prompt on Haiku beats changing the model, by 11 points, at a quarter
of the price.

(Note for anyone who does put Sonnet 5 behind the router: `ModelRequest`
only sends `thinking: {type:"disabled"}` when a caller asks, and
`router.ts` does not ask. Sonnet therefore runs adaptive thinking on
every routing call — 13,000 output tokens per 220 messages against
Haiku's 2,670 — which is where the 4.9 s/call comes from. Turning it off
halves the cost and the latency and costs 3.6 points of accuracy.)

## 1.8 The deterministic floor rescues nothing, and never has

`ROUTER_GATE_FLOOR_ENABLED` is default OFF and `gate.ts` says its true
value can only be measured with the floor out of the way. It now has
been, twice over — by the harness's own `deriveFloorEffect`, and
independently against my labels:

```
routeFloor() matches            195 of 1,748 production messages (11.2%)
…of which the router said none    0
  real rescues                    0
  benign dragged back             0
```

**Zero rescues in 143 days.** The floor fires only on messages the router
already gets right. It is also blind to shapes this club uses constantly
— probed directly:

```
"In"              → self_att        "Bench"            → (no match)
"I'm in"          → self_att        "In for bench 👍"  → (no match)
"@Adam IN"        → other_att       "Yep in"           → (no match)
"Out"             → self_att        "Zeeshan OUT"      → (no match)
                                    "+1"               → (no match, deliberately)
```

`"Bench"` is a real registration in this group and the baseline router
routed it `none` in **5 of 5** runs. The floor would not have saved it.
**Turning the floor on is not the lever, and no sign-off is needed for a
thing that changes nothing.**

## 1.9 The four surviving regexes, measured

All four run in `src/app/api/whatsapp/analyze/route.ts`. Matched against
all 1,748 bodies:

| regex | live since | pattern matches in 143 days | tagged (i.e. would actually fire) | production actions taken |
|---|---|---|---|---|
| `STATS_REQUEST` (:687) | 2026-06-01 | **0** | 0 | **0** |
| `DM_ME` (:806) | 2026-06-01 | 5 | 3 | **0** |
| `HELP_RE` (:934) | 2026-06-18 | **0** | 0 | **0** |
| `looksLikeColourSwapPhrase` (:3751) | (handler older) | 1 | 1 | 1, correct |

Cross-checked the other way: the corpus contains **15** `handledBy =
"fast-path"` rows in total, and every one of them came from
`looksLikeRecruitRequest` (deleted 2026-09-01), the stats-blast keyword
triple (deleted 2026-09-10), or `rating_progress`. **None of the four
regexes under discussion has produced a single production action in its
entire live window.**

The one colour-swap hit is `"@Match Time swap the colors and keep the
same squad"`, 2026-06-09 — the exact message whose mishandling
(`handledBy=llm`, a full regen on match night) is why the guard exists.

**The clause-peel cost of converting them is measured at zero
occurrences.** Not one of the historical hits for any of the four carries
a second instruction. There is no `"@Match Time help, and I'm out"` in
143 days; there is no `"@Match Time dm me the fixtures. Also I'm out"`.
The compound case these peels were built for, for *these four paths*, has
never happened.

## 1.10 What could not be measured, and what was assumed

- **Whether the gold labels are right.** They are one reader's, made
  against a written rubric, and the contestable ones are named in §1.2.
  A second adjudicator would move some cells. Nobody else has read them.
- **Anything outside `AnalyzedMessage`.** Reactions the Pi swallowed, DMs
  that never reach the analyze path, and messages dropped before the
  buffer are invisible here. `SESSION-HANDOFF-2026-09-09.md` records that
  `getChats`, message recovery and participant sync are all degraded, so
  the corpus is a sample of what was *received*, not of what was *sent*.
- **The candidate full-corpus sweeps are single runs.** §1.6's five
  repeats give the variance on the 220-message set (±2 messages, ~1pp);
  the 1,748-message sweeps were run once each because each costs ~$2.50
  and ~30 minutes. Treat their differences below ~1pp as noise.
- **The benign re-weighting factor of 10.17** assumes the 120-body stride
  sample is representative of the 1,199 unique benign bodies. It is a
  systematic sample over first-appearance order, not a random one.
- **Production `intent` is assumed to be a triage signal only**, which is
  what the harness itself says, and §1.2 shows why that matters more than
  the caveat implies.
- **Both orgs are pooled.** Sutton Lads (215 messages) churned on
  2026-06-18 and had `featureAttendance=false`; its traffic is in every
  number above.

---

# PART 2 — REMOVING THE REMAINING REGEX CLASSIFIERS

## 2.0 The tension, named first

`stats-blast.ts` states the price of the 2026-09-10 conversion plainly:

> *"THE CLAUSE PEEL. … 'Match Time send everyone their stats. Also I'm
> out' used to blast AND drop the sender. It cannot any more … Recorded
> as a follow-up rather than smuggled in: the fix, if it is worth one, is
> a `sideRequests` entry on the ATTENDANCE extractor."*

**Every conversion pays that, and the reason is structural.** A clause
peel needs a deterministic predicate to decide *which clause* to take
(`peelClause` runs the fast path's own whole-body test first and returns
null on a miss). Delete the predicate and there is nothing to peel with.
Meanwhile `route.ts`'s second exclusion keeps a step-7 owner from ever
seeing a residual, so an `admin_ops` or `question` route is
whole-message by construction.

**Is `sideRequests` on the attendance extractor the general answer? No —
it is the answer for exactly one shape, and it is already built.**
`SideRequest` is `"recruit" | "chase"`, both of which ride alongside an
attendance claim in the *same* message and are reported by the *same*
extractor call. That works because "I'm out, can someone replace me" is
one thought with two facts. It does not generalise to "@Match Time dm me
the fixtures. Also I'm out", because those are two thoughts needing two
different engines, and putting `dm_qa` on `AttendanceFacts` would mean
the attendance extractor deciding a DM — the model deciding an action,
which is the split this codebase exists to keep.

The honest general answer is different and it is in §3.5: **let the
router return more than one route per message id.** That is the only
mechanism that restores compound handling without a deterministic
predicate over language. It is also the largest change in this document,
and §1.9 measures the problem it solves at **zero occurrences in 143
days** for these four paths. So it is ranked last, deliberately.

## 2.1 Ranked by (risk reduced) / (effort)

| # | regex | blast radius if it misfires | effort | verdict |
|---|---|---|---|---|
| 1 | **`DM_ME`** | **one DM to the sender**, containing a scoped answer. Worst case: answers a fragment. Never mass. | **medium** — needs a new fact | **convert** |
| 2 | **`looksLikeColourSwapPhrase`** | flips both team labels on a live match sheet; visible, one message to undo | **medium** — needs a new `TeamFacts.action` | **convert** |
| 3 | **`STATS_REQUEST`** | **one DM** with a 48h magic link to the sender's own stats | **medium** — needs a new `AdminFacts.action` | convert, but it is the lowest-value of the three |
| 4 | **`HELP_RE`** | one help message in the group | trivial to convert, and the conversion **adds** risk | **keep it a regex** — §2.4 |

None of the four can DM anybody but the sender. None is the mass-DM
class that `recruit-lookback.ts` warns about. **That is the single most
important fact in Part 2, and it means none of these four is urgent.**

## 2.2 `DM_ME` — convert (highest value of the four)

**What it owns today.** `/\b(dm|pm|message)\s+me\b/i`, tag-gated, clause-
peeled. The consumed clause is passed to `answerScopedQuestion`
(`dm-qa.ts`) and the answer is queued as a DM; 📩 in the group.

**Why it is the worst of the four as a pattern.** It is the only one that
matched something it should not have. Two of its five historical matches
are `"If anyone would like to play 7 a side tomorrow in New Malden Goals,
pls message me"` and `"We are short 2 players for Sunday morning at Goals
Sutton. If anyone would like to play, pls message me."` — recruiting
posts addressed to humans. They were saved **only by the tag gate**. Any
future message of that shape that also happens to carry the word
"matchtime" would be fed to the Q&A engine as a question. That is
`stats-blast.ts`'s incident sentence exactly: a pattern matching a
fragment of a sentence aimed at people, not at the bot.

**The regex-free replacement.** `"dm me X"` is a question with a delivery
channel, so the channel becomes a fact:

```ts
// pipeline/types.ts
export interface QuestionFacts {
  kind: "question";
  topic: QuestionTopic;
  personRef: string | null;
  statedCount: number | null;
  /** The asker explicitly wants the answer PRIVATELY ("dm me the
   *  fixtures"). Absent means answer in the group, which is every
   *  question in the history bar three. */
  deliverBy: "group" | "dm";
}
```

One line in the question extractor prompt; `answer-batch.ts` reads
`deliverBy` and, when it is `"dm"`, routes the answer through the
existing `answerScopedQuestion` rather than composing a group reply.

**Do NOT merge the two answer engines.** `dm-qa.ts` has its own system
prompt and its own context builder, and its guarantee is structural:
*"we feed the model only safe, already-group-public data … Phone numbers,
emails and other private fields are never put in the context, so no
prompt-injection can extract what physically isn't there."* Answering a
DM request out of `answer-batch`'s group context would silently widen
that scope. Keep the call; change only what triggers it.

**Cost of conversion.** The clause peel is lost — `"@Match Time dm me the
fixtures. Also I'm out"` would answer privately and drop the OUT on the
floor. **Observed occurrences of that shape in 143 days: zero.** Second,
today the *consumed clause* is what gets answered; with a whole-message
route the whole body goes to `answerScopedQuestion`, which is a slightly
worse question. Mitigate by passing the extractor's `topic` +
`personRef` alongside the body.

**Risk of not converting: low but real.** Risk of converting: one extra
extractor field and a scope mistake if the DM engine is merged away.

## 2.3 `looksLikeColourSwapPhrase` — convert, and mind the gap it lands in

**What it owns.** The literal-colour half of `handleColorSwapIfApplicable`,
lifted out so the clause can be chosen without a DB read. It exists
because on 2026-06-09 `"swap the colours and keep the same teams"` ran a
full regen on match night.

**The regex-free replacement is NOT just deleting the function.** The
`teams` extractor's `action` enum is `"show" | "generate" | "rename" |
"swap"`, and none of those means *flip the two labels, keep the
line-ups*. Worse, `team-ops-engine-batch.ts:38` says
`rename`, `swap` → *"neither; both are handed back"*, with the operator
note `team action "swap" is not a read (no module owns it)`. **So if the
regex is deleted today, "@Match Time swap the colours" routes `balancer`,
extracts as `rename` or `swap`, hits an owner that claims neither, and
the group gets silence plus an operator DM.** That is a straight
regression from "works" to "nothing happens", and it is not obvious from
reading the analyze route.

The conversion is therefore three pieces, all small:

1. `TeamFacts.action` gains `"flip"` — *swap which side wears which
   colour, leaving both line-ups exactly as they are* — plus two
   examples in the teams extractor prompt.
2. `team-ops-engine-batch.ts` owns `flip` and emits the existing
   transaction from `handleColorSwapIfApplicable` (the flip itself is
   already deterministic, already tested, and does not move).
3. `looksLikeColourSwapPhrase` **and** the custom-team-label branch both
   go. Note that branch is *also* a regex classifier, built at runtime
   from the org's `teamLabels` — converting only the literal-colour half
   would leave the more dynamic one behind.

**Cost.** The peel is lost, so `"@Match Time swap the colours and I'm
out"` would flip and drop the OUT. Observed: zero. The real cost is the
new `flip` action being one more thing the model can pick wrongly — and
a wrong `flip` writes to `TeamAssignment` on a live match sheet. It is
recoverable in one message, and `generate` (which rebalances) is already
a bigger button sitting next to it.

## 2.4 `HELP_RE` — **keep it. This is the argued exception.**

Kemal's brief says *"instead of using regex **if possible**"*. Here it is
possible and it is worse. The recommendation is to leave it alone, and
the reasons are not aesthetic:

**1. It is not a classifier. It is an allowlist over the whole body.**

```js
/^\s*(?:@?\s*match\s*time|@mt|matchtime)?\s*\bhelp\b(?:\s+[\w &]+?)?\s*$/i
```

Anchored `^…$`, one optional bot token, the literal word `help`, one
optional topic token. It cannot match a fragment of a sentence, which is
the single property that caused 2026-04-21, 2026-09-01 and 2026-09-10.
`route.ts:924` already argues this and the argument survives scrutiny:
a message it matches is *structurally incapable* of carrying a second
clause, so there is no peel to lose — `peelClause` would return
`{consumed: body, residual: ""}` on every input it ever sees.

**2. Its blast radius is one group message.** No DM, no write, no state
change. `buildHelpReply` reads the org's feature flags and posts text.
A false positive is one unwanted help message; a false negative is a
user who re-types `help`.

**3. Converting it makes the failure mode worse, not better.** There is
no `help` route among the nine and no `help` action on any extractor, so
the conversion means a tenth route or a new `AdminFacts.action`. Either
adds a target for the `N → D` confusion measured at **77 messages** in
§1.3 — the single largest confusion pair in the system, and the one
pointed at `admin_ops`. Trading a regex that cannot match a sentence for
a model route that is currently wrong 85% of the time it fires is a bad
trade, and it is a bad trade in the direction of the mass-DM door.

**4. Measured usage in 143 days: zero.** Nobody has typed `help` once.
Converting a path with no users, at the cost of widening the worst
confusion pair in the system, is effort spent to make the system less
safe.

**What would change this.** If a `help` route is ever wanted for its own
sake — a real onboarding surface with real usage — build it then, and
build it as its own route rather than as an `admin_ops` action, so it
does not share a door with `stats_blast` and `recruit`.

## 2.5 `STATS_REQUEST` — convert, lowest value

**What it owns.** `/\bwrapped\b|\bmy\s+(stats|season|ratings?|
performance|form|card)\b/i`, tag-gated, clause-peeled. DMs the sender a
48h magic link to `/profile/stats`, reacts 📊. The DM is composed from
the *sender*, never from the body, so the regex's only job is deciding
*whether*, not *what*.

**It is the safest of the four by construction** (one DM, to the person
who asked, containing their own link) and it has never fired.

**The regex-free replacement, and why it is more than a prompt line.**
The admin extractor prompt already answers this case — and answers it
*"other"*:

```
"@Match Time what are my stats"   -> other, one person asking about themselves
```

So deleting the regex today means a tagged `"@Match Time my stats"`
routes `admin_ops`, extracts `other`, and produces silence plus an
operator note. The conversion needs:

1. `AdminFacts.action` gains `"stats_link_self"`, with the prompt line
   above inverted and two examples;
2. `admin-ops-engine.ts` gates it (no admin requirement — it is the
   sender's own data) and emits a `stats_link_self` write;
3. `admin-ops-engine-batch.ts` reports it and `route.ts` performs the
   existing magic-link DM.

That is the `stats_blast` shape exactly, one rung down, and it should
reuse that plumbing rather than grow its own.

**Alternative worth considering instead:** route it `question` with
`topic: "stats"` and `deliverBy: "dm"` — i.e. fold it into §2.2's field
and avoid touching `admin_ops` at all. That keeps the personal-stats path
away from the route that guards the mass-DM doors, which given §1.3's
`D` precision of 14.9% is worth something. **Recommended.**

**Cost.** Peel lost (observed occurrences: zero). One more `admin_ops` or
`question` target.

## 2.6 What Part 2 is really worth

Converting all three is **between zero and three production behaviours
changed in 143 days**. The case for doing it is not risk reduction — it
is that the four paths are the last places in the analyze route where a
pattern decides what a message *means*, and while they exist the rule
"the model extracts, code decides and acts" is a rule with exceptions.
The case against doing it urgently is §1.3: `admin_ops` precision is
14.9% and `balancer` precision is 39.3%, and **every conversion moves
work onto exactly those two routes.** Fix the router first (Part 3),
measure again, then convert. That ordering is the recommendation.

---

# PART 3 — MAKING THE ROUTING ITSELF MORE ACCURATE

Ranked by (risk reduced) / (effort). Every line is measured except where
it says otherwise.

## 3.1 ⭐ Rewrite the router prompt — measured, cheap, do this first

Two changes to `ROUTER_SYSTEM_PROMPT`, both driven by §1.3's confusion
table rather than by taste:

**(a) Four new rules**, targeting the four largest confusion pairs:

- an overriding **Rule 0**: anything that states, promises, withdraws,
  offers or asks for a place in this squad *for anybody* is an
  attendance route and can never be `none`;
- asking the group for a replacement or for more players is attendance,
  not `question`, however many question marks it has (kills `A → Q`);
- a message one member sends to another that settles nothing and asks
  the bot for nothing is `none` (kills `N → Q`) — **explicitly subject to
  Rule 0**, see the failure below;
- `admin_ops` is an instruction *addressed to the bot*; talk **about**
  the bot, about the pitch, about money between members, or about what
  the sender will do themselves is `none` (kills `N → D`).

**(b) 39 worked examples**, mined from a train half of the gold set and
held out of every evaluation set below.

### The first version of this made the one thing that matters worse

Measured on the full 1,748-message corpus, the first candidate ("both
v1") scored **92.0% owner accuracy** — and routed **9** real attendance
messages `none` against the baseline's 3:

```
"@Ehtisham Ul Haq in sha Allah I’ll play"
"Talha is coming please add him"
"@Kemal Ediz my brother can play if needed"
"Add these 2 boys pl"
"+1 (289) 888-3645  Rashad my cousin to add if poss"
…
```

The person-to-person rule was swallowing stated commitments because they
were addressed to a person. **It did not show up on the held-out 220-
message set** — those messages were in the train half — which is exactly
the trap the playbook warns about. Version 2 adds Rule 0 above it and an
explicit `11a. RULE 11 NEVER OVERRIDES RULE 0` with five of those
messages as counter-examples.

### Measured: full production corpus, 1,748 messages

One live sweep per arm for the wide metrics; **three live runs** for the
attendance-loss metric, over the 294 real batches that contain one.

| | current prompt | **candidate v2** |
|---|---|---|
| owner accuracy (traffic-weighted) | 83.1% | **91.1%** |
| **attendance messages routed `none`** | **3, 2, 4 of 373** (mean 3.0) | **3, 3, 3 of 373** (mean 3.0) |
| attendance recall | 94.5% | **96.7%** |
| banter escaping `none` | 21.3% | **10.5%** |
| `none` precision / recall | 97.4% / 78.5% | 97.3% / **89.5%** |
| `admin_ops` precision | **14.9%** | **40.4%** |
| `balancer` precision | 39.3% | **74.7%** |
| `question` precision | 46.0% | **78.2%** |
| `admin_ops` routes emitted | 61 | **25** |
| `none` share of traffic | 56.4% | 63.4% |
| router $/batch (uncached) | $0.00128 | **$0.00244** |
| router s/call | 1.50 | 1.84 |

**Parity on the dangerous metric, +8 points everywhere else.** Note the
shape of the two failure sets: the baseline's three vary run to run,
v2's three are byte-identical every run. v2's are therefore *fixable* —
they are named prompt gaps, not sampling noise:

```
"very good lads, same quality and friendliness as ours, come on, one player please"
"Oops, I messed it up, it should be Zair not Baki, sorry. Now I play for 2 people Ismail and Ozgur."
"@Kemal Ediz please switch to 7 a side and include Amir as 14th player"
```

**Cost, at the peak month (656 messages ≈ 366 batches):**

```
router      366 × $0.00244  =  $0.89/month   (was $0.47)
extractor   486 A-routes per 1,748 msgs → 182/month × $0.00162 = $0.30  (was $0.31)
                                ───────────
                       net   =  +$0.41/month
```

Latency +0.34 s per batch, against a Pi that buffers for ten minutes.

**Risks, stated.** (1) The wide metrics are **one** full-corpus sweep per
arm (the attendance-loss row is three); §1.6's repeats put the noise at
about ±1pp, so `91.1` vs `92.0` is not a real difference but `91.1` vs
`83.1` is. (2) The 39 examples are mined from
this club's traffic and will overfit it — a second org will need its own,
or the examples will need generalising. (3) The prompt is 7,811
characters, which lands inside the false-caching window in §1.5; fix
`MIN_CACHEABLE_CHARS` **or** push the prompt past ~15,500 characters
before anyone reads `cacheAttempted` as evidence of anything. (4) `score`
precision drifts from 100% to 57.9% (17 routes against 14 gold) — small,
visible, and worth one more example.

**Effort: hours. Risk reduced: the largest available. Do it first.**

## 3.2 ⭐ Make the `none`-bucket sweep prove it ran

§1.4: one filed row in five nights, because the cron only writes a
`WindowVerdict` when `result.alerts[0]` exists. **File the row
unconditionally** (the org is knowable from the rows the sweep read, not
only from an alert), and have `bot-health` — which already exists and
already emails on a *missing* heartbeat — treat a missing shadow row as a
degradation.

This is a handful of lines and it is what makes every number in §1.4
keep being true tomorrow. **Effort: minimal. Risk reduced: high** —
without it, the only thing watching the `none` bucket is unobservable,
and `gate.ts` is resting its entire containment argument on it.

## 3.3 Fix `MIN_CACHEABLE_CHARS`, per model

One constant becomes a small map keyed on model id (Haiku 4.5: 4,096
tokens; Sonnet 5: 1,024; Opus 5: 512), compared against a token estimate
rather than a character count. Prevents `cacheAttempted: true` from ever
again meaning "we asked and nothing happened". **Effort: minimal. Risk
reduced: low, but it stops a future cost claim being fiction.** Should
travel with §3.1, which is the change that walks into the window.

## 3.4 ⭐ Then move the router to Claude Sonnet 5 — measured at zero misses

**Only after §3.1, and the order is not a formality.** On the *current*
prompt, Sonnet 5 is measurably **worse** at the one thing that matters
(6.0 of 93 against Haiku's 4.4, §1.7). On the v2 prompt it is the best
arm measured, by a wide margin, on exactly that metric.

Full production corpus, 1,748 messages in their real batches:

| | v2 on `claude-haiku-4-5` | **v2 on `claude-sonnet-5`** |
|---|---|---|
| **attendance routed `none`** (3 live runs) | 3, 3, 3 of 373 | **0, 0, 0 of 373** |
| attendance recall | 96.7% | **99.8%** |
| owner accuracy (traffic-weighted) | **91.1%** | 87.6% |
| banter escaping `none` | **10.5%** | 16.9% |
| `none` precision | 97.3% | **98.5%** |
| `admin_ops` precision | 40.4% | 39.4% |
| `score` precision | 57.9% | **100%** |
| `A` precision | **86.4%** | 77.5% |
| `unsure` used | 12 of 1,748 | **67 of 1,748** |
| router $/batch (uncached) | $0.00244 | $0.00651 |
| router s/call | 1.84 | 2.13 |

**Read the accuracy column carefully before treating it as a loss.**
Sonnet scores 3.5 points lower overall, and every point of that gap is
in the *cheap* direction: it over-routes to attendance (`A` precision
77.5%) and lets more banter through the `none` gate. What that buys is
extractor calls — 534 attendance routes per 1,748 messages against
Haiku's 486, i.e. **48 extra calls at $0.00162, about 8 pence** — and
`§6.2`'s measured worst case, which is an extractor that returns no
claims and an engine that writes nothing. Its extra `balancer` and
`question` routes cost *literally nothing*: both owners filter on
`m.tagged` before they spend (`team-ops-engine-batch.ts:371`,
`answer-batch.ts:662`), so an untagged false positive never reaches a
model call at all.

Meanwhile it is **better** on `none` precision, `score` precision, and
level on `admin_ops` — the door that matters. And it is the only arm
that used the abstain route at a meaningful rate (67 of 1,748 against
12), which is the behaviour §3.6 says cannot be instructed into a
smaller model.

By `gate.ts`'s own doctrine — *"Missing a saving costs pennies. Missing a
player's IN costs them their place."* — this is the arm to ship.

**Cost, at the peak month:**

```
router      366 × $0.00651  =  $2.38/month   (today: $0.47)
extractor   200/month × $0.00162 = $0.33     (today: $0.31)
                                ───────────
            total             =  $2.71/month  (today: $0.78)   →  +$1.93/month
```

**Risks, stated.** (1) 0 of 373 is three runs on a 143-day corpus, not a
proof; the held-out 220-message set put the same arm at 0.4 of 93 (zero
in three runs of five), so the true rate is low but not certainly zero.
(2) Sonnet runs adaptive thinking on every routing call because
`router.ts` never sends `thinking`. Turning it off halves cost and
latency and **costs 3.6 points of accuracy** (measured) — leave it on.
(3) Two pinned models instead of one, and §11.3's rule is that a model id
change is cleared by the corpus.
(4) The $0.00179/batch the full sweep reported for Sonnet is a warm-cache
artefact and must not be quoted — see §1.5.

## 3.5 Let the router return more than one route per message

This is the only real answer to the clause-peel loss in Part 2, and to
the compound messages the analyze route has now dropped six times.
`RoutedMessage` becomes a list, `partition` skips a message only when
*every* route is `none`, and each owner sees the message once.

It is the largest change in this document. It is ranked here rather than
higher because **§1.9 measures its benefit for the four regexes at zero
occurrences in 143 days** — but note the shape it addresses is *not*
rare in general: `"@Match Time pls generate the teams as a 5-aside game,
now Idris, Burak, Mojib and Habib are OUT"` is one message carrying a
balancer instruction and four drops, and it is in the corpus.

**Effort: days. Risk reduced: moderate and structural.** Worth a design
of its own; not worth bundling with §3.1.

## 3.6 Things that were tested and should NOT be done

| proposal | measured result | verdict |
|---|---|---|
| cheap second pass / self-consistency vote | 3–5x cost, −1.0 to +2.4 messages of 220 | **no** |
| one router call per message (drop batching) | 4.1x cost, −0.1 messages of 220 | **no** |
| turn on `ROUTER_GATE_FLOOR_ENABLED` | 0 rescues of 195 floor matches in 143 days | **no** |
| bigger model on the current prompt | +5pp overall, **worse** on attendance-to-`none`, 4.2x cost | **no** |
| instruct the model to use `unsure` more | `unsure` is 1.9% of production routes; an explicit abstain rule moved it to 1.0% on the test set | **no — see below** |

### On abstention specifically

The brief asks about "a confidence/abstain signal so `unsure` is used
properly". Measured: the router emits `unsure` on **33 of 1,748**
production messages (1.9%). Adding a rule that says in terms *"when a
message is attendance-shaped but you cannot tell what it does, return
`unsure` rather than guessing; it is a real route with a real handler,
not a failure"* moved it to **11–12 of 1,100** on the held-out set, i.e.
down. Sonnet 5 with thinking on used it three times as often (35 of
1,100) and was the most accurate arm — so abstention correlates with
capability, not with instruction.

The deeper point: `unsure` maps to the **same extractor as `self_att`**,
so abstaining and guessing cost the same and reach the same code. There
is no decision downstream that reads `unsure` differently. Asking the
model to abstain more is asking it to relabel, not to behave differently.
**If an abstain signal is wanted it has to buy something** — the obvious
candidate being "route `unsure` and ALSO run the question extractor", at
$0.00162 a time. That is a real proposal and it is §3.5 in disguise.

## 3.7 Are nine routes the right cut, and should `none` exist?

**Nine routes is close to right, and the evidence is per-route.** `score`
is perfect (P100/R100) and trivially separable. `A`'s four routes
(`self_att`/`other_att`/`offer`/`unsure`) all reach one extractor and one
engine, so the model's instability between them — `router-recall.ts`
records `"can anyone replace me tonight?"` splitting 4/1 over five runs —
costs exactly nothing, which is a good design. The weak cut is at the
other end: **`admin_ops` (P14.9) and `balancer` (P39.3) are the two
routes the model cannot hold apart from banter**, and `admin_ops` is a
bag holding payment credit, reminders, recruit blasts and stats blasts —
four actions with wildly different blast radii behind one label. If any
re-cut is worth doing it is splitting the two mass-DM actions out of
`admin_ops` into their own route, so the tag gate and the route agree
about which door they are guarding. §3.1 gets most of that benefit for
much less work (precision 14.9% → 40.4%), so measure again after it.

**Should the `none` bucket exist given nothing re-reads it? Yes, and the
measurement makes the case.** `none` covers 56.4% of traffic today (63.4%
under §3.1), and each skipped message saves a $0.00162 / 2.03 s extractor
call. Removing the bucket entirely — routing everything to an extractor —
would cost roughly $1.30/month at peak and remove the 0.8% attendance
loss measured in §1.4. That is an affordable trade in money.

**It should still not be taken, for a reason that is not cost.** The
extractor is not a second router: it returns claims, and `engine.ts` acts
on claims. Feeding 1,100 banter messages a month to an attendance
extractor trades a *silent* 0.8% false-negative rate for a *loud* false-
positive rate on the write path, and §13's rule points the other way —
*"a missed add is recoverable in one message; a wrong registration on a
paid match is not."* The right version of the idea is narrower and is
§3.2: keep the bucket, and make the thing that re-reads it actually work.

---

## 3.8 Everything, ranked by (risk reduced) / (effort)

| # | change | measured effect | effort | cost/month at peak | do it? |
|---|---|---|---|---|---|
| 1 | **§3.1** rewrite the router prompt | owner accuracy 83.1% → **91.1%**; banter escaping `none` 21.3% → 10.5%; `admin_ops` precision 14.9% → 40.4% | hours | +$0.41 | **yes, first** |
| 2 | **§3.2** file the `none`-shadow row unconditionally + alert on absence | turns "1 row in 5 nights" into a signal; makes every §1.4 number keep being true | ~an hour | $0 | **yes** |
| 3 | **§3.4** move the router to Sonnet 5 **after** #1 | attendance routed `none` **3.0 → 0.0 of 373**, three runs of three | minutes (one constant) + a corpus run | +$1.52 on top of #1 | **yes, after #1** |
| 4 | **§3.3** make `MIN_CACHEABLE_CHARS` per-model | stops `cacheAttempted: true` meaning nothing on Haiku | minutes | $0 | yes, with #1 |
| 5 | **§2.2** convert `DM_ME` to `QuestionFacts.deliverBy` | removes the one regex that has actually matched the wrong thing | medium | ~$0 | yes, after #1 |
| 6 | **§2.3** convert the colour swap (needs `TeamFacts.action: "flip"`) | removes two regexes, one of them built at runtime from org labels | medium | ~$0 | yes, after #1 |
| 7 | **§2.5** convert `STATS_REQUEST` via `deliverBy`, not `admin_ops` | removes a regex that has never fired | medium | ~$0 | low priority |
| 8 | **§3.5** multi-route per message | the only real fix for compound messages; measured at 0 occurrences for these four paths | days | small | design it separately |
| — | **§2.4** `HELP_RE` | anchored whole-body allowlist, 0 matches in 143 days, converting it widens the worst confusion pair | — | — | **leave it** |
| — | **§3.6** second pass · un-batching · the floor · a bigger model on the current prompt | all measured, all rejected | — | — | **no** |

Running totals if 1–4 are taken: **$2.71/month at peak traffic**, against
$0.78 today, and an attendance-loss rate measured at zero across three
full-corpus runs.

---

## Appendix A — how to reproduce, and what it cost

```bash
set -a; source .env; set +a

npm run replay:extract          # read-only against production
npm run replay:router-recall    # the full live sweep: 974 calls, ~$1.25, ~55 min
```

The gold set, the candidate prompts and the scoring scripts are
throwaway artefacts under this session's scratchpad, not in the repo:

| file | what it does |
|---|---|
| `gold.json` | 445 hand-labelled bodies, keyed by body text |
| `p-both-v2.txt` | the candidate router prompt (7,811 chars) |
| `fullsweep.mts` | routes all 1,748 messages in their real batches, scores against gold |
| `attslice.mts` | routes only the 294 batches containing a gold-attendance message, N repeats — the metric that matters |
| `routereval.mts` + `run-arms.mts` | held-out 220-message set, N repeats per arm |

All of them read `.e2e/replay/source.json` and write only to the
scratchpad. None touches Prisma, none creates a `BotJob`, none sends a
message.

**Spend, itemised:**

```
full router-recall sweep (baseline, 974 calls)          $1.25
held-out arm sweeps (6 arms × 3 reps, then 3 × 5 reps)  $3.79
batch-size and thinking-off arms                        $2.18
full-corpus sweeps: v1 haiku, v2 haiku, v2 sonnet       $6.63
attendance-slice repeats (3 arms × 3 runs)              $4.97
token / cache / extractor probes                        $0.08
                                                       ──────
                                                       ~$18.90
```

If §3.1 is taken, `gold.json` and `attslice.mts` are worth promoting
into `e2e/replay/` so the next prompt change is measured the same way;
the candidate prompt itself belongs in `router.ts`.

## Appendix B — corrections to this codebase's own records

1. `gate.ts:31` / `llm.ts:44`: the router system prompt is **661
   tokens**, not ~360.
2. `llm.ts:MIN_CACHEABLE_CHARS`: 4,000 chars is a Sonnet threshold.
   Haiku 4.5 needs **4,096 tokens** (~15,500 chars). Measured both
   sides.
3. `e2e/replay/router-recall.ts:SEVERITY_BY_INTENT`: treating `noise`
   and `unclear` as benign means a real IN mislabelled by the old
   analyzer is scored as **the saving**. The published 3.3% miss rate is
   biased optimistic; by hand the count is 3 of 373, not 5 of 517.
4. `e2e/replay/README.md`: the corpus is now 1,776 / 1,748 messages in
   974 batches, not 1,723 / 1,695 in 962. `noise` is 69.1%, not 69.3%.
5. `gate.ts` calls the `none`-bucket sweep *"the ONLY remaining thing
   watching"*. It has filed **one row in five nights** and cannot file
   one on a clean night at all.
6. `team-ops-engine-batch.ts`: `rename` and `swap` are owned by nobody.
   Any plan to delete the colour-swap regex must add a `flip` action
   first or it converts a working feature into an operator note.
7. `ROUTER_GATE_FLOOR_ENABLED`: the floor's true recall contribution,
   which `gate.ts` says can only be measured with it off, is now
   measured. It is **zero rescues in 143 days**, and the floor does not
   match `"Bench"`, `"Yep in"` or `"Zeeshan OUT"`.

## Appendix C — the candidate prompt (v2) in full

This is the string measured throughout Part 3. It is 7,811 characters;
2,036 tokens on Haiku 4.5, 2,751 on Sonnet 5.

```text
You classify WhatsApp messages from a football club group. For EVERY message id you are given, return exactly one route.

0. READ THIS FIRST, AND LET NOTHING BELOW OVERRIDE IT. If a message states, promises, withdraws, offers or asks for a PLACE IN THIS SQUAD for anybody at all — the sender, a named player, an @mention, a relative, a friend, a guest, a phone number — it is an attendance route (self_att, other_att, offer or unsure) and it must NEVER be none. A message the group would read as "one more person is playing" or "one fewer person is playing" is attendance, however casually it is worded and whoever it is addressed to.

none        banter, jokes, memes, links, emoji, greetings, off-topic chat
self_att    the SENDER is joining or leaving THIS match themselves
other_att   the message adds, drops, benches, swaps or replaces SOMEONE ELSE
offer       a contingent or tentative commitment by anyone ("if you're short", "if my back holds up")
question    a question the bot could answer
balancer    asks the bot to generate, show, shuffle or rename the two teams
score       reports a final result
admin_ops   payment credit, reminder request, other bot admin instruction
unsure      attendance-shaped but you genuinely cannot tell

Rules:
1. Route on what a message DOES, not what it is about. "Great game last night" is none.
2. A completed join stated about someone else IS other_att ("Ayoub snatched that spot").
3. A relayed commitment IS other_att ("Najib said in as well").
4. Moving, benching or swapping a NAMED PLAYER is other_att, never balancer. ONE list of players, however long or numbered, is a reposted squad roster and is other_att; balancer is only about the TWO team line-ups.
4a. Asking to SEE who is playing — "who's in?", "show me the squad", "list the players", "who's playing tonight?" — is question. It asks for the ONE squad list the bot already holds. balancer is only for the TWO team line-ups (red and yellow), so "show me the teams" is balancer and "show me the squad" is not.
5. An @mention of a person with in or out is other_att.
6. A question mark does not make a message a question. If it also states that someone is joining or leaving ("can anyone replace me tonight?"), route the attendance. question is only for a message that ASKS FOR information the bot holds and states no change.
7. When in doubt between none and anything else, choose the other route.
8. ASKING is question; INSTRUCTING is admin_ops. "Amir paid for 4 players" and "remind me on Monday" tell the bot to do something and are admin_ops. "Who hasn't paid?", "has everyone paid for last week?" and "any payments outstanding?" ask for something the bot already knows and are question.
9. A question about a match that has ALREADY BEEN PLAYED is question, not none: "what was the score?", "did we win on tuesday?", "how did we get on last night?", "who's played the most this season?". Reporting a result ("we won 5-3") is still score.
10. ASKING THE GROUP FOR A PLAYER IS ATTENDANCE, NOT question. "anyone able to replace me?", "is anyone available to take my dad's place?", "we need one more player, anyone interested?", "@all we need more players", "can we have more INs please?" all ask PEOPLE to fill a gap in this squad. Route them other_att when they name or imply a specific person leaving, otherwise offer. A question mark does not make them question. question is only for information the BOT already holds.
11. A MESSAGE ONE MEMBER SENDS TO ANOTHER, WHICH STATES NO CHANGE TO THIS SQUAD AND ASKS THE BOT FOR NOTHING IT HOLDS, IS none: "are you injured?", "are you available to play @Enayem?", "@Amir you are coming, right?", "which two of you can play tomorrow?". These ASK; they settle nothing.
11a. ⚠️ RULE 11 NEVER OVERRIDES RULE 0. Being addressed to a person, or speaking on someone else's behalf, does NOT make a stated commitment banter. "@Ehtisham in sha Allah I'll play", "Talha is coming please add him", "@Kemal my brother can play if needed", "add these 2 boys pl", "Rashad my cousin to add if poss", "I can play @Kemal, your bot is spamming me" all STATE that somebody will play. Every one is attendance.
12. admin_ops IS AN INSTRUCTION ADDRESSED TO THE BOT. Talk ABOUT the bot, about settings, about the pitch, about money owed between members, or plans the sender is going to carry out themselves ("I will change it to 7aside", "please add Talha to this group", "matchtime should suggest 5aside") is none. If nobody is telling the BOT to do something now, it is not admin_ops.
13. WHEN A MESSAGE IS ATTENDANCE-SHAPED BUT YOU CANNOT TELL WHAT IT DOES, RETURN unsure RATHER THAN GUESSING BETWEEN self_att AND other_att. unsure is a real route with a real handler; it is not a failure. Never use unsure for a message that is plainly banter — that is none.

Worked examples from this group. Copy the reasoning, not the wording.

  "In"                                                        -> self_att
  "Yep in"                                                    -> self_att
  "Bench"                                                     -> self_att
  "I'm not playing"                                           -> self_att
  "I can't join due to work n dint bring kit"                 -> self_att
  "Hey gents, I am in just in case someone drops."            -> offer
  "Lemme know if we need more to make it 14. I can find another" -> offer
  "Will confirm shortly"                                      -> unsure
  "@Youssef is IN"                                            -> other_att
  "@Match Time Kojo IN, Aaron IN"                             -> other_att
  "Najib said in as well so we should be at 13 players"       -> other_att
  "Trevell got injured today so he had to drop out"           -> other_att
  "@Match Time move @Aydin from bench to squad to replace @Ehtisham" -> other_att
  "@Match Time swap David and Abid"                           -> other_att
  "Hi guys, does anyone wants to take my place for tonight?"  -> other_att
  "We need one more player guys, anyone interested?"          -> offer
  "@all we need one more player otherwise Salman will move to squad from bench" -> other_att
  "@Match Time how many players so far?"                      -> question
  "Pitch number ?"                                            -> question
  "Where is my name?"                                         -> question
  "@Match Time who has got the most MoM so far?"              -> question
  "@Match Time what is the current squad status?"             -> question
  "Teams?"                                                    -> balancer
  "@Match Time regenerate the teams once more"                -> balancer
  "@Match Time generate the teams, put me and David together" -> balancer
  "5-3 to Yellows"                                            -> score
  "10-10"                                                     -> score
  "remind me on Tuesday morning at 9am instead please"        -> admin_ops
  "@Match Time DM me the link for switching to 7aside"        -> admin_ops
  "Are you injured ?"                                         -> none
  "Are you available to play @Enayem ?"                       -> none
  "@Youssef @Ehtisham , Talha is coming, right?"              -> none
  "Oops, didn't realise @Mojib Jalali is in"                  -> none
  "I think we are still waiting for the poll result."         -> none
  "Get the rating done"                                       -> none
  "Eid Mubarak everyone"                                      -> none
  "Crazy statistics"                                          -> none
  "wait guys sorry by mistake I enabled the tracking of squad in Match Time" -> none
  "Are we adding them to the group?"                          -> none

Return JSON only: {"routes":[{"id":"<id>","route":"<route>"}]}
```
