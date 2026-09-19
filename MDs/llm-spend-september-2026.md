# Where the $184.60 went, September 2026

Investigation, 2026-09-19. Read-only. No model pin, prompt or application
file was changed by this work.

Every number below is labelled **MEASURED** (read from the database, the
billing figures Kemal supplied, or a literal in the source) or
**ESTIMATED** (derived, with the arithmetic shown). Where a figure is
derived from someone else's earlier measurement it says so and dates it.

---

## 0. The answer in six lines

**MatchTime production, the live bot serving Sutton FC, cost about $3.50
in September. The other ~$181 was us, running live-LLM harnesses against
the production API key.**

That is **98% development, 2% production**. Three independent pieces of
arithmetic, using three different token pools and three different
database counters, all land between 0.39% and 0.46% production share of
token volume. They are set out in section 2 and they agree with each
other.

The single biggest line item is **the router, ~18,500 Haiku calls at
~3,200 uncached input tokens each, $59 of the $65 Haiku line.**
Production made **77** of those calls. The rest were corpus sweeps.

---

## 1. Every LLM call site in the codebase

MEASURED by grep over `src/`, `scripts/` and `e2e/`, 2026-09-19.

| # | Call site | Model | Trigger | Cached? | Sept calls in PROD |
|---|---|---|---|---|---|
| 1 | `pipeline/llm.ts:54` router, via `pipeline/router.ts` | `claude-haiku-4-5` | every inbound group batch | **no, cannot** (see 3) | **77** MEASURED |
| 2 | `pipeline/llm.ts:55` extractors, via `pipeline/extractors.ts` | `claude-sonnet-5` | every non-`none` route | yes, 1,773 tok | **~57** ESTIMATED |
| 3 | `message-analyzer.ts:95` chase composer | `claude-sonnet-4-5` | scheduler, 5 kinds | yes, 1h TTL, 2 markers | **<=45** MEASURED upper bound |
| 4 | `dm-qa.ts:312` scoped DM answer | `claude-sonnet-4-5` | a player DMs a question | **no marker** | ~10 ESTIMATED |
| 5 | `rating-adjuster.ts:22` | `claude-sonnet-4-5` | team generation, 1 per match | yes, 1h TTL | **2** MEASURED |
| 6 | `squad-from-list.ts:50` | `claude-sonnet-4-5` | pasted-list groups | yes, 1h TTL | **0**, dormant |
| 7 | `onboarding-analyzer.ts:28` | `claude-sonnet-4-5` | onboarding wizard | yes, 1h TTL | **0**, dormant |
| 8 | `onboarding-conversation.ts:66` | `claude-haiku-4-5` | self-onboarding bot | yes, 1h TTL | **0**, dormant |
| 9 | `dm-intent.ts:87` | `claude-haiku-4-5` | 1:1 DM classification | yes, 1h TTL | small |
| 10 | `fee-confirm.ts:365` | `claude-haiku-4-5` | payment confirmation | yes, 1h TTL | small |
| 11 | `match-availability-classifier.ts:32` | `claude-haiku-4-5` | availability boundary | yes, 1h TTL | small |
| 12 | `roster-survey-classifier.ts:17` | `claude-haiku-4-5` | roster survey replies | yes, 1h TTL | small |
| 13 | `pipeline/none-shadow.ts` re-examination | `claude-sonnet-5` | nightly cron, sample 40 | yes | **9 nights** MEASURED |
| 14 | `scripts/dryrun-dm-qa.ts:143` | `claude-sonnet-4-5` | dev harness | no marker | dev only |
| 15 | `e2e/helpers/live-llm.ts:122` `PROBE_MODEL` | `claude-sonnet-4-5` | liveness probe, ~1 token | no | dev only |

Dormancy is MEASURED: `OnboardingSession` has **0** rows created in
September and `GroupMessage` has **0**, so sites 6, 7 and 8 did not fire.

### `claude-something-7` is not a model and not a bug

It appears twice, both in `src/lib/pipeline/__tests__/cache-threshold.test.ts:67-68`.
It is a deliberately fictional id used to assert that an unmeasured model
falls back to `DEFAULT_MIN_CACHEABLE_TOKENS` (4,096, the most demanding
floor known). No production code references it. Nothing to fix.

### Production volume, MEASURED

Queried against the production Supabase instance, read-only, September
2026, all organisations:

```
AnalyzedMessage rows            114
distinct batchId                 77
organisations with any traffic    1  (Sutton Football Club)
GroupMessage rows                 0
SentNotification rows           254   (dm 141, group-message 44,
                                       outbound-text-log 35,
                                       update-reaction 32, group 1, oob 1)
RatingAdjustment rows            24   across 2 days (8 and 15 Sept)
Match rows                        5
OnboardingSession rows            0
WindowVerdict rows                9   ($0.0793 total, MEASURED costUsd)
```

Intent breakdown of those 114: `noise` 65, `in` 31, `conditional_in` 3,
`out` 3, `score` 2, `team_swap` 2, `generate_teams_request` 2,
`replacement_request` 2, and one each of `team_colour_swap`, `question`,
`stats_blast`, `recruit_recent`.

**One question. Thirty-one INs. One hundred and fourteen messages in a
month.** That is the entire production workload.

### There is no per-call cost ledger in the database

The brief suggested `WindowVerdict.costUsd` as the primary source. It is
populated (514 rows, all with a cost, $5.5775 lifetime MEASURED) but it
is **not** a general ledger. It was the shadow window-analyzer's table.
That analyzer was switched off by default on 2026-08-31 (PR #28) and
deleted on 2026-09-06 (commit `8dc64fb`); `window-analyzer.ts` is now a
payload contract with no `analyzeWindow` in it. The 9 September rows are
the nightly `none`-bucket sweep reusing the table as a heartbeat, not the
pipeline reporting its costs.

Everywhere else, `costOf()` in `pipeline/llm.ts` computes a cost per call
and it is summed in memory and printed to the console. **Nothing writes
it to the database.** Stating that plainly, because it is why the
production figures below are bottom-up estimates rather than a query.

---

## 2. Production versus development

### 2.1 The harnesses use the production key. Verified.

`e2e/run.ts:39` reads:

```
loadEnv(); // load repo-root .env so process.env.ANTHROPIC_API_KEY is set before helpers/env reads it
```

`e2e/replay/router-attendance-live.ts` calls `loadEnv()` at module scope
and then refuses to run on an empty key. `scripts/dryrun-pipeline.ts`,
`scripts/dryrun-dm-qa.ts`, `scripts/chase-at-risk-live.ts` and
`scripts/measure-claimless.ts` all read `process.env.ANTHROPIC_API_KEY`
from the same `.env`. `.env.e2e` contains a database URL and two ports
and **no Anthropic key at all**, so there is no separate dev credential
to fall back to.

MatchTime has exactly one `ANTHROPIC_API_KEY` in this checkout and every
live harness spends on it.

### 2.2 The arithmetic, three ways

**Haiku 4.5.** MEASURED (billing): 59.3M uncached input tokens.
MEASURED (source): `ROUTER_SYSTEM_PROMPT` is 11,455 characters.
MEASURED (prior `count_tokens` probe recorded in `pipeline/router.ts`,
2026-09-16): 11,233 characters is 2,962 tokens on Haiku, a ratio of 3.79
characters per token.
DERIVED: 11,455 / 3.79 = **3,021 system-prompt tokens**.
ESTIMATED per call: 3,021 system + ~120 for a batch of roughly two short
messages + ~60 schema and wrapper = **~3,200 input tokens, all of them
uncached**.

```
59,300,000 / 3,200 = 18,531 router calls   (ESTIMATED)
                                            range 17,970 at 3,300 tok
                                                  19,636 at 3,020 tok
```

Bill check: 59.3M x $1.00/MTok = **$59.30**. Kemal's Haiku line is $65.
The residual $5.70 at $5.00/MTok output is 1.14M output tokens, which
across 18,531 calls is **62 output tokens per call**. The router emits
about 140 tokens for a batch of eight and fewer for a batch of two, so 62
is exactly right. **The Haiku line is the router and essentially nothing
else, and the call count is around 18,500.**

Production made **77** of them.

```
77 / 18,531 = 0.42%
```

**Sonnet 5.** MEASURED (billing): 26.1M cache-read tokens.
MEASURED (prior live probe recorded in `pipeline/llm.ts`, 2026-09-11):
the attendance extractor prompt caches at 1,773 tokens on Sonnet 5.

```
26,100,000 / 1,773 = 14,720 cache-hitting extractor calls  (ESTIMATED)
```

ESTIMATED production extractor calls: 114 messages less 65 `noise` is 49
non-`none` routes, plus the single retry `extractForRoute` allows on the
four attendance routes, so **~57**.

```
57 / 14,720 = 0.39%
```

**Sonnet 4.5.** MEASURED (billing): 86.4M cache-read tokens, $65 total.
Cache reads bill at 0.1x input, so 86.4M x $0.30/MTok = **$25.92** of the
$65; the remaining $39.08 is uncached input, cache writes and output.

Only four Sonnet 4.5 sites attach a `cache_control` marker at all
(MEASURED by grep): the chase composer's two markers at
`message-analyzer.ts:624` and `:634`, plus `rating-adjuster.ts:163`,
`squad-from-list.ts:281` and `onboarding-analyzer.ts:144`. The last three
fired 2, 0 and 0 times in production. `dm-qa.ts` and
`scripts/dryrun-dm-qa.ts` attach **no** marker and therefore cannot
produce a cache read at all. So the 86.4M is the **chase composer**.

MEASURED: the `CHASE_SYSTEM_PROMPT` source block is 15,123 characters,
about 5,215 Sonnet tokens. ESTIMATED: the `matchContext` block it also
caches (roster, up to 20 match detail rows, four leaderboards) is 2,500
to 5,000 tokens. Cached prefix **7,700 to 10,200 tokens, midpoint 8,900**.

```
86,400,000 / 8,900 = 9,708 chase composes   (ESTIMATED)
                                             range 8,470 to 11,220
```

MEASURED upper bound on production chase composes: 44 `group-message`
plus 1 `group` `SentNotification` rows = **45**, and not all of those are
LLM-composed.

```
45 / 9,708 = 0.46%
```

### 2.3 The verdict

Three token pools, three database counters, **0.39%, 0.42%, 0.46%**.

Bottom-up production cost for September, ESTIMATED, each line shown:

| Line | Arithmetic | USD |
|---|---|---|
| Router | 77 batches x $0.00358 (the repo's own measured $0.00317 plus $0.00041 for Rule 17's Turkish block) | 0.28 |
| Extractors | 57 x ~$0.0026 (effective input ~400 tok at $2/MTok, output ~180 tok at $10/MTok) | 0.15 |
| Chase composer | 45 x ~$0.060 (8,900 tok cold write at 2x = $6/MTok, plus uncached tail and ~400 output tok at $15/MTok) | 2.70 |
| Rating adjuster | 2 x ~$0.030 | 0.06 |
| DM Q&A | ~10 x ~$0.031 (7,166 uncached tok at $3/MTok, 600 output at $15/MTok) | 0.31 |
| `none`-bucket nightly sweep | MEASURED, 9 rows | 0.08 |
| **Production total** | | **~$3.58** |

Range, flexing the chase composer between an all-cold and a half-warm
cache and the prefix between 7,700 and 10,200 tokens: **$2.20 to $4.80**.

```
$184.60 - $3.58 = $181.02 development
$181.02 / $184.60 = 98.1%
```

The token-share method (0.42% x $184.60 = $0.78) is lower than the
bottom-up method because the columns Kemal was given cover uncached Haiku
input and cache reads, and the production path's largest item is the
chase composer's cache **writes**, which appear in neither. The bottom-up
figure is the more complete one and it is the one to use.

### 2.4 The expensive days are development days

Sutton plays on Tuesdays. Commit counts are MEASURED from `git log`.

| Day | Spend | Weekday | Commits | What shipped |
|---|---|---|---|---|
| 1 Sept | $47 | Monday | **12** | The whole analyzer rebuild, steps 2 to 5. Includes `878aa79` "the incident archive becomes a replayable test suite", `9b60f93` "§10 step 3 without waiting two weeks", and `cf1c8f2` "a live sweep that cannot reach the model now fails instead of passing, and S12 settled at **100 runs a side**" |
| 11 Sept | $37 | Friday | 6 | `1fc6cfb` "measure what the router actually gets wrong, and price the fixes" plus `8bb56ef` the router prompt rewrite. `MDs/router-accuracy-2026-09-11.md` records the 373-message sweep run at least six times (3 baseline, 3 candidate) |
| 16 Sept | $27 | Tuesday | 11 | Turkish Phase 1 (`5833f35`). `router.ts` records that this PR re-ran the 373-message sweep **three times as the veto and three more on a first cut that was rejected**. Also the day of the 15-hour WhatsApp outage, when the bot was DOWN |
| 17 Sept | $44 | Thursday | 8 | i18n Phases 2 and 3, self-setup, swap fixes. Kemal's own note says this day is **shared with HomeTenant** |

16 September is the one Tuesday in the list, and it is the day production
traffic was *suppressed* by an outage. Its spend is the Turkish router
sweeps, not the match.

Cross-check: 18,500 router calls at 974 batches per full corpus sweep is
**19 full sweeps**, or at 294 batches x 3 runs per attendance veto,
**21 attendance vetoes**. Both are consistent with a month containing
four router or prompt PRs each gated on a three-run veto, plus
`dryrun-pipeline.ts` runs at `REPEAT=15`.

---

## 3. The Haiku cache floor: real, and it is a development cost, not a production one

**The finding is true.** `ROUTER_SYSTEM_PROMPT` is 3,021 tokens.
`claude-haiku-4-5`'s minimum cacheable prefix is **4,096 tokens**,
confirmed against Anthropic's published per-model table (the minimum is
not monotonic across generations: 512 on Opus 5, 1,024 on Sonnet 5 and
Sonnet 4.5, 4,096 on Haiku 4.5). The router prompt sits **1,075 tokens
below the floor and can never cache.** Every one of its 3,021 tokens is
paid at full price on every call.

**It is not a lying marker.** `shouldCachePrompt()` correctly returns
false and no `cache_control` is attached. That was the bug and it was
fixed on 11 September in `8bb56ef`; the old `MIN_CACHEABLE_CHARS = 4_000`
rule would have reported `cacheAttempted: true` and cached nothing.

**And it is worth almost nothing in production.** 77 calls x 3,021 tokens
x $1.00/MTok = **$0.23 a month**. Making it cacheable saves Kemal about
twenty pence.

**Do not pad the prompt to cross the floor.** It would help sweeps
enormously (974 back-to-back calls go from $2.94 to about $0.41) and it
would make **production worse**. The Pi buffers inbound messages for ten
minutes, so a 5-minute ephemeral entry is always expired by the next
call, and a padded 4,200-token prompt would bill 4,200 x 1.25 = 5,250
effective tokens per production call against 3,021 today. That is a
**74% increase** on the production router line to save money on a
harness. If it is done at all it has to be sweep-only, and a prompt
change is veto-gated by the corpus regardless.

---

## 4. Why Sonnet 4.5 is carrying $65

Because the pin is a fossil, and because the traffic is not production.

`claude-sonnet-4-5` was the model `analyzeBatch` called. `analyzeBatch`
and its 19,850-token `SYSTEM_PROMPT` were deleted on 6 September
(`8dc64fb`). Every surviving 4.5 pin was **inherited from it, not
chosen**. `e2e/helpers/live-llm.ts` says so in as many words: the probe
list "was a single string, `claude-sonnet-4-5`, the model `analyzeBatch`
called".

| Site | What it does | Needs Sonnet? |
|---|---|---|
| `message-analyzer.ts:95` chase composer | writes the 5 scheduled group posts | Tone only. The file's own header says "the model keeps exactly one job: tone". Sonnet-class is defensible; **4.5 is not** |
| `dm-qa.ts:312` | answers a player's DM from scoped facts, in English or Turkish | Judgement and fact-fidelity. Sonnet-class yes |
| `rating-adjuster.ts:22` | reads a week of chat, proposes clamped rating deltas | Judgement. Sonnet-class yes. Fired **twice** in September |
| `squad-from-list.ts:50` | pasted-list squad extraction | Dormant. 0 `GroupMessage` rows in September |
| `onboarding-analyzer.ts:28` | onboarding wizard, one-shot per org | Dormant. 0 `OnboardingSession` rows in September |
| `scripts/dryrun-dm-qa.ts:143` | dev harness | dev only |
| `e2e/helpers/live-llm.ts:122` | ~1-token liveness probe | dev only |

`claude-sonnet-5` is **$2.00 / $10.00 per MTok**. Sonnet 4.5 is
**$3.00 / $15.00**. Sonnet 5 is **33% cheaper on both input and output,
newer, and has a 1M context window**. The pipeline's own extractors
already run it. There is no argument for keeping 4.5 anywhere.

(Sonnet 4.5's $3/$15 is the rate in this repo's own `RATES` table in
`pipeline/llm.ts:61`. It is no longer on Anthropic's current published
model table because it is superseded, and the current Sonnet 4.x entry,
Sonnet 4.6, is $3/$15. See section 6.)

---

## 5. Per-message and per-match economics

All ESTIMATED, from MEASURED counts. Arithmetic shown.

**One inbound group message.** MEASURED: 114 messages across 77 batches,
so **1.48 messages per batch**.

```
router share     $0.00358 / 1.48          = $0.00242
extractor share  (57/114) x $0.0026       = $0.00130
                                          -----------
per inbound message                         $0.0037
```

**One match week.** MEASURED September averages: 114 messages over 4.3
weeks is 27 a week; 5 matches; 45 group posts, so 9 per match.

```
inbound processing   27 x $0.0037    = $0.10
scheduled chases      9 x $0.060     = $0.54
team gen + adjuster   1 x $0.030     = $0.03
rating DMs and Q&A    2 x $0.031     = $0.06
nightly sweep share   7 x $0.0088    = $0.06
                                     --------
per match week                         $0.79
```

**Per additional club, at Sutton's volume: about $3.50 a month.** Round
it to $4 and it is still generous. At three times Sutton's chat volume it
is under $8, because the message-driven part is only 7% of the total.

The number that matters for onboarding club two and club three:

> **LLM cost per club is roughly $4 a month and it scales with the number
> of clubs, not with how chatty they are.** Ten clubs is about $40 a
> month. This is not a cost that constrains the business.

The reason it scales per club rather than per message is that **the
scheduled chase composer is 75% of it** ($2.70 of $3.58) and it fires on
a clock, four to five times a day, whether or not anybody spoke.

---

## 6. Savings, ranked by money saved against risk taken

**1. Give the dev harnesses their own API key.** Saving: $0 directly.
Value: it is the precondition for every figure in this document being
checkable next month instead of reconstructed, and it turns "why is my
bill $184" into two dashboard lines. Today `e2e/run.ts:39` and every
`scripts/dryrun-*.ts` and `e2e/replay/*-live.ts` read the production key
out of `.env`. Risk: none. Verify: run one attendance sweep on the new
key and confirm the production key's daily total does not move.

**2. Move every `claude-sonnet-4-5` pin to `claude-sonnet-5`.**
Saving: **$21.45 a month** (0.33 x $65) at September's mixed volume, of
which about **$1.20 a month** is production and the rest is harness. Also
buys a newer model. What could break: the chase composer's tone, and the
DM Q&A's Turkish, which has a long list of regressions already caught
(`GLUED_SUFFIX`, `WRONG_DAY_TR`, `FORMAL`). **The real risk is not tone,
it is thinking.** Sonnet 5 runs adaptive thinking when `thinking` is
omitted, and `pipeline/llm.ts` documents what that does: it can spend the
whole `max_tokens` budget deliberating and return no text block at all,
probed at 1,024, 2,048 and 4,096 tokens, five runs of five. The chase
composer and `dm-qa.ts` do **not** currently send a `thinking` parameter,
so a 4.5 to 5 move must send `thinking: {type: "disabled"}` at the same
time or budget for thinking tokens. `__tests__/thinking-off.test.ts`
already documents the trap. Verify: `REPEAT=15` on `dryrun-pipeline.ts
CHASES=1` in both `LANG=en` and `LANG=tr`, and `REPEAT=15` on
`scripts/dryrun-dm-qa.ts` in both, comparing flag counts against the
current model before and after.

**3. Halve the sweep volume.** Saving: **~$25 a month**, the largest
single number here. 18,500 router calls at 3,200 uncached tokens is $59,
and the sweeps are the entire bill. The cheapest change is to stop
routing all 974 batches when the 294-batch attendance subset is the
actual veto in `router-attendance-live.ts`; that is a 70% cut per sweep.
What could break: less measurement, and measurement is the thing that
caught the "candidate prompt scored higher overall while tripling
attendance-to-`none`" failure. This is the one place where spending money
is the point, so take it as a budget decision, not a bug fix. Verify:
nothing to verify; decide how many sweeps a PR is worth.

**4. Measure, then probably remove, the chase composer's 1h cache
markers.** Saving: **~$1.20 a month at Sutton, ~$12 at ten clubs.**
MEASURED: `message-analyzer.ts:624` and `:634` attach
`cache_control: {type: "ephemeral", ttl: "1h"}` over roughly 8,900
tokens. A 1h write bills at **2x** input ($6/MTok on Sonnet 4.5) where no
marker bills at 1x ($3/MTok). The five chase kinds fire at 17:00, on
match-day morning, 3 to 4 hours before kickoff and 2 hours before, so the
gaps are hours and most calls are paying double for a cache nobody reads.
The 3-to-4-hour and 2-hour chases may genuinely land inside one hour on
match day, which is why this is a measurement first: log
`usage.cache_read_input_tokens` on that call for one week and count the
non-zero ones. If they are mostly zero, drop the markers. What could
break: nothing functional, you lose the occasional real hit.

**5. Leave the `none`-bucket nightly sweep alone.** MEASURED: 9 rows,
**$0.0793** in September, about $0.26 a year-round month. It is 0.04% of
the bill. It is also the only thing that ever re-reads a message the
router called banter, and `bot-health.ts` treats a missing row as a
degradation. **Named here so that nobody cutting costs cuts it.**

**6. There is no duplicate or shadow classification pass to remove.**
The brief asked. Checked and killed: the `WindowVerdict` shadow
window-analyzer, which `MDs/analyzer-redesign-2026-08-31.md` §8.1 once
measured at 30% of the analyzer bill, was switched off on 2026-08-31
(PR #28) and deleted on 2026-09-06 (`8dc64fb`). `window-analyzer.ts`
retains only the payload contract. The surviving `none-shadow.ts` runs
nightly, sampled at 40, behind `NONE_BUCKET_SHADOW_ENABLED`, and is item
5. **No live message is classified twice.**

**7. There is no dead weight worth cutting from the prompts.** The
router prompt is 3,021 tokens paid in full on every call, and every block
in it has a measured veto behind it: §3.1's rewrite took
attendance-to-`none` from 3.0 of 373 to 0 of 373, and Rule 17's Turkish
block costs +408 tokens and bought 30 of 30 on bare "yokum" / "yok" /
"var". At 77 production calls a month the entire production router line
is **$0.28**, so trimming it is a false economy, and any change to it is
veto-gated by the corpus. The 3,021 tokens only cost real money inside
the sweeps, which is item 3.

---

## 7. What I could NOT verify

Listed so nothing above is read as firmer than it is.

1. **The full usage breakdown per model.** Kemal supplied one token
   column per model (uncached Haiku input, Sonnet cache reads). I do not
   have uncached Sonnet input, output tokens or cache writes. The Admin
   API usage and cost report would close this. Every Sonnet dollar split
   in section 2.2 is therefore a reconstruction that reconciles to the
   totals, not a direct read.

2. **The `matchContext` block's real token size.** I measured
   `CHASE_SYSTEM_PROMPT`'s source block at 15,123 characters, but
   `matchContext` is built at runtime from the club's roster and match
   history and I estimated it at 2,500 to 5,000 tokens. Every
   chase-composer figure, including the $2.70 production line and the
   9,708 call count, inherits that uncertainty.

3. **Which harness ran on which day.** `e2e/replay/ledger.ts` records a
   MEASURED `costUsd` and a full token span per unit, which would make
   the development spend measured rather than inferred. It writes to
   `.e2e/replay/<runId>/`, which is gitignored, and **no ledger directory
   exists on this machine**. The sweeps that produced the September bill
   ran in agent worktrees that are gone. The `.e2e/replay/` directory
   holds only the corpus inputs (`source.json`, 1,776 messages,
   11 September).

4. **Whether 17 September's $44 belongs to MatchTime.** Kemal's own note
   says that day is shared with HomeTenant. MatchTime's 17 September is 8
   commits of i18n Phases 2 and 3. Nothing in this repo can apportion it,
   and if a material share is HomeTenant's then MatchTime's September
   total is **below** $184.60 and the production share is even smaller
   than 2%.

5. **`claude-sonnet-4-5`'s current list price.** It is no longer on
   Anthropic's published current-model table because it is superseded.
   This repo pins $3.00 / $15.00 in `pipeline/llm.ts:61` and that matches
   the Sonnet 4.x generation rate (Sonnet 4.6 is $3/$15 today), so I used
   it. It is the repo's number, not one I confirmed against a live price
   list, and every Sonnet 4.5 dollar figure moves with it. Haiku 4.5
   ($1/$5) and Sonnet 5 ($2/$10) **were** confirmed against the current
   table, as was Haiku 4.5's 4,096-token cache floor.

6. **Whether production uses this exact key.** I verified from source
   that the harnesses spend the key in `.env`. I did not audit the Vercel
   or Pi environment to confirm production uses the same key string
   rather than a different one. Note the direction: if production is on a
   separate key, then **all** $184.60 is development and the conclusion
   gets stronger, not weaker.

7. **The 5,700 output tokens' worth of Haiku that is not the router.**
   The bill check in 2.2 attributes all of the residual to router output.
   Sites 9 to 12 (`dm-intent`, `fee-confirm`,
   `match-availability-classifier`, `roster-survey-classifier`) are also
   Haiku and did fire, at low volume. They are inside the rounding error
   of the 62-tokens-per-call figure and I did not separate them.
