# Redesigning the WhatsApp natural-language layer

**31 August 2026. Architecture proposal, for a funding decision.**

Every number here was measured, not estimated. Token counts come from
`POST /v1/messages/count_tokens` against the live `SYSTEM_PROMPT`. Latency, output
tokens and cache behaviour come from real API calls made with the production prompt and
a reconstructed Sutton context. Where a figure could not be measured without querying
production, it is marked as unknown rather than guessed. Citations are `file:line`
against `ba5b4ea` + working tree.

---

## 1. The decision, up front

### Diagnosis

MatchTime's analyzer asks one 18,315-token prompt to do four jobs at once: understand
English, decide what the database should say, do arithmetic, and write the group's
public message. Only the first is a language problem. The other three are deterministic,
and every incident in the last four months came from the model being asked to do one of
them.

Because the model decides, the server cannot trust its output, so the server checks it
afterwards. There are now **54 correction layers** across the analyze route and the
analyzer library. Two of them decide whether to drop a player from a paid match by
running regular expressions over the model's **English prose** —
`route.ts:1035-1047` parses `verdict.reasoning`, `route.ts:1075-1077` parses
`verdict.reply`. That is not an interface. It is a hope.

The prompt is not long because someone was verbose. It is long because it is an
**incident archive**: 26 reconstructable production incidents, 14 dated references, 5
"Kemal flagged" annotations, 27 real players' names used as worked examples, 12
`CRITICAL` banners, 470 shouted words. Each entry is individually justified.
Collectively they are a second classifier competing with the 54 in the server, and
neither can be reasoned about in isolation.

The most telling number in this document: **the prompt has grown 29 lines since
18 June.** It has essentially stopped. What grew instead is `analyze/route.ts` — now
3,297 lines — and seven new pure modules extracted from the prompt one incident at a
time. The team is already migrating decisions out of the model. This proposal is a plan
to **finish that migration deliberately instead of one incident at a time**, not a
change of direction.

The strongest evidence that it works is `src/lib/format-switch.ts`. On 30 August the
model told a real customer group that "Najib + Mojib + Mustafa go on the bench" when
nobody would be benched — it computed `8 − 5` (players per *team*) instead of `8 − 10`
(the format *total*). The fix was not another prompt rule. It was 206 lines of pure code
that compute the arithmetic and the names and hand the model a finished sentence to copy.
Its header states the principle exactly: *"the model no longer does this arithmetic and
no longer picks the names... 'LLM extracts, code decides.'"* It is unit tested and it
has not regressed.

**The recommendation is to generalise `format-switch.ts` to the whole analyzer.**

### Recommendation

Replace the single mega-call with a three-stage pipeline:

1. **Router** — `claude-haiku-4-5`, ~360-token prompt, classifies each message in a
   batch into one of nine routes. Banter exits here.
2. **Extractors** — one small specialist per route, `claude-sonnet-5` with a strict JSON
   schema, returning **facts about the text only**: who the claim is about, whether that
   person was actually *named*, polarity, whether it was contingent and on what, tense,
   whether it was reported speech. No intent. No `registerAttendance`. No reply. No
   emoji. No `reasoning` prose.
3. **Decision engine + composer** — pure TypeScript. Takes facts plus squad state,
   decides every write, and composes every outgoing message. Every number and every name
   the bot says is read from the database.

The model's job shrinks to the only thing it is uniquely good at: turning English into
structured facts. It is never again asked what should happen.

I recommend this over the alternatives in §7, including the cheaper "one call with
strict tool use" option, which fixes schema drift but leaves the decision inside the
model and therefore leaves most of the 54 seatbelts standing.

### What it costs and what it saves

| | today (measured) | proposed (measured prototype) |
|---|---|---|
| Batch of 8 banter messages | **$0.053**, 14–19 s | **~$0.0012**, ~2 s |
| Batch of 3 with 1 action | **$0.044**, 8–15 s | **~$0.005**, ~5 s |
| Per club per month (see §8.3) | **$58–207** | **$9–32** |

Roughly **6× cheaper overall, ~44× cheaper on the modal case** (a batch where nothing
happened), latency roughly halved.

Two caveats on that table, both important. First, ~30% of today's cost is **two bugs,
not architecture** — a prompt-cache buster and a shadow analyzer nobody decided about
(§8.1). Both are fixable this week for free, and doing so is step 0. Second, **cost is
not the argument.** At one club the absolute saving is lunch money. The number is here
only to remove "more calls will cost more" as an objection, and to show that the bill
stops scaling with *chat volume* and starts scaling with *things that actually
happened* — which is what makes the design survive 20 clubs instead of one.

### The single biggest risk

Router misclassification silently drops a real attendance change. A message routed
`none` never reaches an extractor and produces nothing — no write, no reply, no
reaction, no signal. Today the mega-call at least emits *something* for every message.
My own prototype misrouted a real admin command 3/3. §11.1 has the containment design;
it is the part I would build first and test hardest, and note that one mitigation I
initially assumed was available turns out not to exist (the regex fast-path was deleted
in April), so the floor has to be built.

---

## 2. One number in the brief, corrected

The brief states the `SYSTEM_PROMPT` is "1,929 lines / ~32,000 tokens". Measured:

| | value | how |
|---|---|---|
| Source lines | **407** (`message-analyzer.ts:209-615`) | `wc` |
| Characters | 66,510 | `wc` |
| **Tokens** | **18,315** | `count_tokens`, `claude-sonnet-4-5` |
| Full call, 6-message batch | **21,073** input tokens | `count_tokens` |

1,929 is `2137 − 209 + 1` — the prompt declaration to end-of-file, which is the prompt
*plus* the post-processor layer. Those are two different artefacts that grew for
different reasons, and separating them is the point of §3 and §5.

This matters beyond pedantry. The inflated figure implies the fix is "shrink the
prompt". The measured figures show the prompt is **nearly free once cached** and that
**output tokens are 50–72% of the bill** (§8.1). A redesign that shrank the prompt but
kept the model writing the replies would save almost nothing. Getting this wrong would
have optimised the wrong half.

---

## 3. Evidence: the prompt rule inventory

The primary artefact. Every section of `SYSTEM_PROMPT` categorised, with measured token
weight and, where reconstructable, the incident that caused it.

- **A** — extraction guidance the model genuinely needs
- **B** — a decision that should be deterministic code
- **C** — output formatting that should be a template
- **D** — a patch for a past model failure (scar tissue)
- **E** — dead, duplicated, or actively wrong

### 3.1 The split

| category | sections | source lines | tokens | share |
|---|---|---|---|---|
| **A** extraction the model needs | 12 | 140 | **5,411** | **29.0%** |
| **B** should be deterministic code | 16 | 119 | **6,642** | **35.6%** |
| **C** should be a template | 6 | 79 | **4,454** | **23.8%** |
| **D** scar tissue for past model failures | 5 | 49 | **2,173** | **11.6%** |
| **E** dead / duplicated / wrong | §3.4 | — | ~450 | ~2.4%, overlapping A–D |
| **Total** | 39 | 387 | 18,680 | |

*(387 of 407 lines; the rest are blank separators. The total slightly exceeds the
whole-prompt count of 18,315 because each segment boundary carries tokenizer overhead.)*

**71% of the prompt — 13,269 tokens — is not teaching the model to read English.** It is
code, templates and apology for past mistakes, written in prose and re-sent on every
call.

### 3.2 Section by section, with provenance

| id | lines | tok | cat | section | incident that caused it | where it goes |
|---|---|---|---|---|---|---|
| S0 | 209-211 | 102 | A | Preamble, JSON-only, batch framing | — | router + extractor preambles |
| S1 | 213-215 | 272 | **D** | VERDICT COVERAGE | **2026-05-25 Ibrahim + Baki**: two clear drop messages omitted from the verdicts array entirely; bot silently no-op'd both (`cd3214f`) | dies: router emits one route per id; coverage asserted in code |
| S2 | 217-231 | 628 | **B** | INTERACTION CONTRACT — tag-gating | **2026-06-18 rollover**: with this week full, casual "In"s landed on next week's empty match (`19f43e3`) | `interaction-contract.ts` — already exists, already pure |
| S3 | 232-237 | 317 | **B** | Never register hypothetical / past / third-person | same | schema `tense`, `subject`; engine vetoes |
| S4 | 239-261 | 403 | A | Output schema, 15 fields | — | per-extractor JSON schema |
| S5 | 263-270 | 470 | A | intent "in" + bench self-declaration + react rule | **2026-05-01 Aydın**: "In. For bench👍" was slotted CONFIRMED at #8 against his stated intent (`401ced4`) | extractor; react rule → C, dies |
| S6 | 272-279 | 350 | **D** | "NEVER LEAVE registerAttendance NULL (CRITICAL — Kemal flagged 2026-05-11)" + 5 excuses the model must not make | **2026-05-08 Najib**: "In" at 22:27 with squad 14/14; model emitted `intent:"in"`, `registerAttendance:null`, reasoning *"this is odd"*. **Lost his slot for a week** (`f61a897`) | dies: `intent` and `registerAttendance` merge into one `polarity` and cannot disagree |
| S7 | 281-288 | 425 | **D** | "WORDS MUST MATCH ACTION (CRITICAL — 2026-05-15)" | **2026-05-15 Erdal**: model replied *"Erdal goes on the bench"* with no `registerFor`. Group believed it; DB didn't (`bef5252`) | dies: the model no longer writes the words |
| S8 | 289-294 | 442 | **B** | ADMIN DEMOTE TO BENCH — *"the SINGLE MOST IMPORTANT case to get right"* | **2026-06-11 Salman Shelly**: demote read as the sender's own `intent:"in"`; reply announced the move, DB kept him CONFIRMED, count read "14/14 with 1 slot open" (`9afa357`) | engine: `{subject:other, polarity:bench}` + actor is admin |
| S9 | 295-305 | 986 | **B** | PROMOTE FROM BENCH / SELF-REPLACE + 6 forbidden phrasings | **2026-06-16 Aydın**: two prompt rules collided; the model hedged *"until he confirms"* after the swap was already written (`c85a23c`) | engine + `promote-authorization.ts` |
| S10 | 306-307 | 246 | **D** | Two full incident narratives as prose the model re-reads every call | Erdal 2026-05-15, Najib 2026-05-08 | dies: becomes two regression tests |
| S11 | 308-310 | 375 | **B** | CONDITIONAL DROP | **2026-06-09 Erdal**: *"If u can make happy to drop"* → dropped immediately, replacement never confirmed, squad left at 13 (`b726f63`) | schema `contingent` + engine hold |
| S12 | 311-314 | 161 | **B** | replacement_request (a) definite vs (b) tentative | — | engine, from `contingent` |
| S13 | 316-328 | 758 | **B** | BENCH SLOT CLAIM — first-come | **2026-05-19 Karahan**: sequential chain ran a 2h timer and marked him DROPPED **while he slept**, then chained on, wiping all three overnight benchers | engine reads `BenchSlotOffer` |
| S14 | 329-353 | **1,314** | **C** | BENCH CONFIRMATION FLOW, 6 forbidden phrasings, admin swap | **2026-05-18 Erdal**: bot announced *"asking Erdal in DMs"*; he got no DM and called it misinformation (`7e3284c`) | composer template |
| S15 | 354-362 | 534 | **B** | conditional_in (a) standing-offer vs (b) personal-uncertainty | **2026-05-15 Erdal**: *"consider me as the 14th whenever you have 13"* → 🤔, left unregistered (`a9e42e5`). **(a) is the rule behind incident A5** | schema `conditionOn: squad\|self`; engine decides |
| S16 | 363-374 | **2,091** | **C** | intent "question" + 6 sub-rules — **the heaviest section** | **2026-05-06 Amir** (history-vs-roster), **2026-05-11 Najib/Wasim** (claimed confirmed on a speaker's say-so), **2026-04-28** (hallucinated "(5-a-side bench if we downgrade)"), **2026-05-14** ("top 3 most consistent" returned the squad roster) | squad/bench/phone answers deterministic; one small call for free-form stats |
| S17 | 375-376 | 148 | A | intent "score" | — | extractor |
| S18 | 377-393 | 1,030 | A | generate_teams + includeNames / teamOverrides / teamNames | — | extractor |
| S19 | 394-396 | 339 | A | show_teams vs generate | **2026-06-18**: "show the teams again" re-ran the balancer and destroyed an admin's manual swap (`c408649`) | router route |
| S20 | 397-400 | 256 | A | bring_guests_vague | **2026-04-24 Amir**: "two of my guys can play" → `unclear`, no reply | schema `personNamed:false` |
| S21 | 401-411 | 459 | A | bulk_payment_credit | — | extractor |
| S22 | 412-426 | 858 | **B** | reminder_request incl. **calendar arithmetic** | — | extractor returns the phrase; `date-fns-tz` resolves it |
| S23 | 427-429 | 68 | A | noise / unclear | — | router route `none` |
| S24 | 431-438 | 265 | **B** | FACT-CHECK CLAIMS ABOUT SQUAD STATE | **2026-04-24**: someone claimed "we're 9/14" when it was 11 (`f71b6ad`) | engine compares stated number to DB |
| S25 | 440-448 | 279 | **B** | SHORT CONFIRMATION TO A BOT-LISTED PENDING SET | 2026-04-24 Amir (`7453daa`) | engine: the bot's own last post is a known object |
| S26 | 450-472 | 329 | A | REPOSTED ROSTER AS ANSWER | same | extractor |
| S27 | 474-492 | 956 | A | THIRD-PARTY REGISTRATIONS + DO/DON'T list | — | **the core extraction task** — keep, sharpen |
| S28 | 494-517 | 851 | A | 13 worked `registerFor` examples | **2026-05-05 Izzet/Elnur**: raw `@lid` wire format read as *"noise — administrative commentary"* (`a5a150a`) | keep ~5, move the rest to tests |
| S29 | 518-527 | 707 | **B** | REPLACEMENT/SWAP + BANTER guard | **2026-06-12 Zeeshan**: a wind-up ("Zeeshan is out 😂😂", mock votes) read as a real drop **while Zeeshan was in the same batch protesting** (`ed0a50b`) | engine: corroboration policy over `(actor, subject, polarity)` |
| S30 | 529-533 | 127 | **B** | CHASE behaviour | — | engine |
| S31 | 535-543 | 461 | **C** | SQUAD-STATE REPLY SHAPE | **2026-04-26 Wasim's drop**: reply reordered the roster, **omitted Zair**, claimed 12/14 when truth was 13/14 (`ef8d801`) | `composeSquadStatusPost()` — **already exists**, `message-analyzer.ts:1440-1461` |
| S32 | 545-556 | 319 | **C** | Lead variants, formatting, no-raw-phone | — | template + a lint on the outgoing string |
| S33 | 557-576 | 181 | **C** | A worked 14-row roster example | — | dies |
| S34 | 578-605 | 880 | **D** | FORMAT SWITCH — *"YOU DO NO ARITHMETIC HERE"*: 28 lines telling the model **not** to do something | **2026-08-30**: 8 confirmed → *"switch to 5-a-side (10 players) — Najib + Mojib + Mustafa go on the bench"*. Computed 8−5 not 8−10, named three real people (`aabc760`) | dies: `format-switch.ts` computes it; the model stops seeing the alternatives at all |
| S35 | 607-609 | 123 | **B** | State collapse — only an author's latest message writes | — | engine, trivially |
| S36 | 611 | 39 | **B** | De-duplicate replies within a batch | — | engine |
| S37 | 613 | 43 | **B** | Confidence floor 0.7 | — | engine |
| S38 | 615 | 88 | **C** | Reply tone | — | the one thing left for a model |

### 3.3 The prompt stopped growing. The seatbelts did not.

Measured `SYSTEM_PROMPT` template lines per commit:

| date | prompt lines | event |
|---|---|---|
| 2026-04-20 | **34** | `26cf5e4` first LLM analysis, on Haiku |
| 2026-04-21 | **122** | **nine commits in one day**; the regex fast-path is deleted and the LLM takes every message |
| 2026-04-29 | 215 | bulk payment |
| 2026-05-17 | 314 | reminders |
| 2026-06-18 | **378** | interaction contract |
| 2026-08-31 | **407** | today |

**+29 lines in ten weeks.** Meanwhile `analyze/route.ts` reached 3,297 lines, and seven
pure modules were extracted *out of* the prompt, each after an incident:

| module | created | lines | extracted because |
|---|---|---|---|
| `promote-authorization.ts` | 2026-06-15 | 86 | admin-vs-self is an authorisation decision |
| `interaction-contract.ts` | 2026-06-18 | 172 | tag-gating must be deterministic |
| `registration-match-select.ts` | 2026-06-18 | 84 | which match a write lands on |
| `format-switch.ts` | 2026-08-30 | 206 | the model did 8−5 instead of 8−10 in production |
| `out-of-band-self-attendance.ts` | 2026-08-31 | 152 | honest acks |
| `bench-offer-copy.ts` | 2026-08-31 | 171 | copy pinned to a feature flag |
| `attendance-write-outcome.ts` | 2026-08-31 | 179 | the ack must follow the write outcome |

**This proposal is not a change of direction. It is the same direction, done on purpose
and in one pass, instead of once per incident after someone is embarrassed in front of
their club.**

### 3.4 Category E — things that are simply wrong

Found while doing the inventory. Each is small; together they are the tell that nobody
can read this file any more.

1. **Lines 369 and 372 are byte-identical.** The whole "For BENCH questions" paragraph
   appears twice, ~200 tokens, on every cache write. Introduced by `cf6ed22` on
   2026-05-14 while inserting the stats rule between them. **Undetected for 3.5 months.**
2. **`bulk_payment_credit` is missing from the prompt's own output schema.** The enum at
   `:244` lists 12 intents; `AnalysisIntent` (`:61-74`) and `normaliseVerdict`
   (`:1912-1926`) accept 13. S21 spends 459 tokens teaching the model to emit an intent
   the schema three sections earlier forbids. It works only because the model ignores
   the schema line.
3. **Line 346 instructs the model to assert something false.** *"NEVER write 'in DMs'...
   that is factually FALSE (the bot does not DM bench players)"*. The bot **does** DM
   bench players — `bot-scheduler.ts:1310`, comment *"Personal DM to each bencher"*. A
   rule written in May to stop the model lying now forces it to describe the system
   inaccurately. Also cold-audit 3.1.
4. **Line 270** forbids slot-number keycap reactions "they're no longer used" — an
   instruction whose entire content is the history of a removed feature.
5. **`smart-analysis.ts:44-48`** still documents *"A regex fast-path in handlers.ts
   catches obvious IN/OUT/score messages BEFORE they queue here"*. It was **deleted on
   2026-04-21** (`handlers.ts:7-10`). The same comment's "~£2/month" estimate is off by
   1–2 orders of magnitude (§8.3).

---

## 4. Evidence: the prompt does not reliably do what it says

I ran the live `SYSTEM_PROMPT` against a reconstructed Sutton context (10/14 confirmed,
14-player 7-a-side, one viable 5-a-side alternative) and the exact production message
from incident A5.

### 4.1 The same input gives three different answers

Message: `@Kemal Ediz my brother can play if needed` (Amir, 30 Aug 23:03).

**With Amir already on the bench** (post-incident state), 4 identical calls:

| run | intent | write |
|---|---|---|
| 1, 3, 4 | `bring_guests_vague` | none; asks for the name |
| 2 | **`in`** | **`registerFor: [{name: "Amir's brother", action: "IN"}]`** |

**With Amir not yet registered** (the actual pre-incident state), 6 identical calls:

| runs | intent | write |
|---|---|---|
| **6 of 6** | `in` | **`registerFor: [{name: "Amir's brother", action: "IN"}]`** |

Six times out of six the current prompt would call
`resolveOrProvisionByName("Amir's brother")` (`route.ts:1830-1923`) and, finding no
match, **create a User whose name is the literal string "Amir's brother"** and register
them into a paid squad. Production did something different again — it benched Amir
(`AnalyzedMessage`: `intent=conditional_in action=BENCH author=Amir`). **Three distinct
wrong answers to one message**, depending on squad state and on the roll of the dice.

The prompt already has a rule for this. S27 says *"unnamed ('2 of my guys', 'another',
'someone') → DON'T"*. Adding a 28th rule saying "'my brother' is not a name either" is
exactly the reflex this design is meant to end. The problem is not the missing rule. The
problem is that *"is this string a personal name?"* is decided implicitly, inside a
model simultaneously deciding twelve other things, with **no field in the output where
the answer can be inspected**.

### 4.2 Nothing costs as much as saying nothing

Eight messages of pure banter — emoji, a YouTube link, "anyone watching the derby":

| run | latency | output tokens | actions taken |
|---|---|---|---|
| 1 | 14.0 s | 1,284 | 0 |
| 2 | 18.6 s | 1,285 | 0 |

~160 output tokens per message to conclude that a laughing emoji is a laughing emoji.
Output is billed at 5× input, so this is the most expensive thing the analyzer does and
the thing it does most often.

---

## 5. Evidence: 54 correction layers

Distinct guards applied to model output, or to a message before the model sees it:

| where | count |
|---|---|
| Pre-LLM deterministic peels (`route.ts:271-598`) | 7 |
| Analyzer-side normalisation (`message-analyzer.ts:1849-2078`) | 6 |
| Batch-level guards (`route.ts:648-754`) | 2 |
| Per-message verdict rewrites (`route.ts:769-1208`) | 11 |
| `executeVerdict` overrides (`route.ts:2065-2900`) | 16 |
| Reply post-processors (`route.ts:1222-1414`) | 6 |
| Batch-final passes (`route.ts:1472-1605`) | 3 |
| Identity-hygiene guards | 4 |
| **Total** | **54** |

Classified against the proposed design:

| class | count | meaning |
|---|---|---|
| **No longer possible** | **19** | the error class becomes unrepresentable, so the guard has nothing to guard |
| **Survives as a genuine invariant** | **22** | authorisation, tenancy, coverage, identity, value clamping — none of these are about the model |
| **Becomes a schema field** | **7** | the guard was reconstructing a fact; the extractor now states it |

The two worst are both in the first column.

**`route.ts:1012-1056` — the OUT safety net.** Decides whether to drop a player by
matching eleven regexes against `verdict.reasoning`, the model's free-text English
rationale:

```ts
const strongDrop = /\b(definite|definitely)\s+(drop|out)\b/.test(r) || …
if (strongDrop && !notDropping) { verdict = { ...verdict, registerAttendance: "OUT" }; }
```

Its history is the whole argument in miniature. `f35dfe6` (2026-05-26) added the
`strongDrop` half to fix Mojib not being dropped. Three days later `1daf7db` had to add
the `notDropping` half **because `strongDrop` wrongly dropped Kemal from his own squad**
on the message "@all we need more players pls". *The second half of this seatbelt exists
only because the first half caused an incident two days after shipping.* It exists at
all only to reconcile `intent` against `registerAttendance` when the model decides them
independently and they disagree. **Merge them into one `polarity` and there is nothing
to reconcile and no prose to parse.**

**`message-analyzer.ts:1482-1623` — `enforceCanonicalRoster`.** 140 lines of regex in
six sub-passes: overwrite the roster block, patch every `N/14`, rewrite "full squad" →
"need 2 more", rewrite "one slot open", overwrite the bench section, strip promotion
claims, cap impossible totals. Every line exists because the model authors the
user-visible squad text and gets it wrong. `composeSquadStatusPost()` — the correct
deterministic composer — **already exists forty lines above it** at
`message-analyzer.ts:1440-1461`, used only as a fallback when a batch produces two
contradictory replies. The design below makes it the only path and deletes the 140
lines.

---

## 6. The design

```
  batch of N messages
          │
          ▼
  ┌───────────────────────────────────────────────┐
  │ 0. Deterministic pre-filter (existing peels)  │  no LLM
  │    stats links, help, recruit, rating-progress │
  │  + NEW: a small regex floor for bare IN/OUT   │
  └───────────────────────────────────────────────┘
          │
          ▼
  ┌───────────────────────────────────────────────┐
  │ 1. ROUTER            claude-haiku-4-5          │  1 call / batch
  │    ~360-token prompt, 9 routes                 │  ~815 in, ~300 out
  │    banter exits here, costs nothing further    │  ~2 s
  └───────────────────────────────────────────────┘
          │ routed, non-`none` messages only
          ▼
  ┌───────────────────────────────────────────────┐
  │ 2. EXTRACTORS        claude-sonnet-5           │  ≤1 per routed
  │    strict JSON schema, FACTS ONLY              │  message, parallel
  │    ~1,200-token prompt each                    │  ~2–4 s
  └───────────────────────────────────────────────┘
          │ facts
          ▼
  ┌───────────────────────────────────────────────┐
  │ 3. DECISION ENGINE   pure TypeScript           │  0 calls, <5 ms
  │    facts + squad state → writes                │  100% unit tested
  └───────────────────────────────────────────────┘
          │ outcomes (what the DB actually did)
          ▼
  ┌───────────────────────────────────────────────┐
  │ 4. COMPOSER          templates                 │  0 calls normally
  │    every name and number read from the DB      │
  └───────────────────────────────────────────────┘
```

### 6.1 Stage 1 — the router

Nine routes. The prompt is ~360 tokens; here it is in full, because its size is the
argument:

```
none        banter, jokes, memes, links, emoji, off-topic chat
self_att    the SENDER is joining or leaving THIS match themselves
other_att   the message adds, drops, benches, swaps or replaces SOMEONE ELSE
offer       a contingent or tentative commitment by anyone
question    a question the bot could answer
team_ops    asks the bot to generate, show, shuffle or rename the two teams
score       reports a final result
admin_ops   payment credit, reminder request, other bot admin instruction
unsure      attendance-shaped but you genuinely cannot tell
```

plus five routing rules — route on what a message *does*, not what it is *about*.

Prototype, `claude-haiku-4-5`, 18 hard cases drawn from the real incident archive, 3
runs each: **17 of 18 stable across runs**, 1.7–2.1 s, 815 input / ~300 output tokens
for all 18 messages at once.

Two initial failures were fixed by **one line each**:

- "Ayoub snatched that spot 😭" routed `none` → added *"A completed join stated about
  someone else IS other_att"*. Fixed, 3/3.
- "Najib said in as well" was unstable → added *"Relayed commitment IS other_att"*.
  Fixed, 3/3.

**One failure survives and I have not fixed it: "move Mustafa to the bench, keep Idris
in" routes to `team_ops`, 3/3.** My route *name* is at fault — "bench" reads as
team-shaped vocabulary. That is a genuine finding, not a footnote: **route taxonomy is a
design surface with its own failure mode and needs its own eval set.** It must be fixed
before shipping, probably by renaming `team_ops` → `balancer` and adding `lineup_ops`.

The contrast is the point. Fixing a rule in the 18,315-token prompt has unpredictable
interactions with 38 other sections and is measurable only by re-running everything.
Fixing a rule in a 360-token router with a 40-case eval set takes ten minutes and
produces a number.

### 6.2 Stage 2 — extractors return facts, never decisions

```ts
{ claims: Array<{
    subject:     "sender" | "other"
    personRef:   string        // verbatim, as written; never invented
    personNamed: boolean       // "my brother" / "2 of my guys" → false
    polarity:    "in" | "out" | "bench"
    contingent:  boolean
    conditionOn: "squad" | "self" | "none"
    tense:       "present" | "future" | "past" | "hypothetical"
    reported:    boolean       // relaying what someone else said
    confidence:  number
}> }
```

Enforced with `output_config: {format: {type: "json_schema", schema}}`, so
`safeParseJson`'s fence-stripping (`:1873-1885`) and most of `normaliseVerdict`'s 120
lines of hand-rolled coercion disappear.

Note what is **absent**: no `intent`, no `registerAttendance`, no `registerFor`, no
`react`, no `reply`, no `reasoning`. **There is no field in which the model can express a
decision, and no prose for a regex to parse.**

Prototype, `claude-sonnet-5`, strict schema, 3 runs per case:

| message | extracted | stable? |
|---|---|---|
| `@Kemal Ediz my brother can play if needed` | `{other, "my brother", named=false, in, contingent:squad}` | **3/3** ✅ |
| `I'll be the 14th if you're short` | `{sender, in, contingent:squad, future}` | 3/3 ✅ |
| `in if my back holds up` | `{sender, in, contingent:self, present}` | 3/3 ✅ |
| `my dad Najib is also in` | `{other, "my dad Najib", named=true, in}` | 3/3 ✅ |
| `move Mustafa to the bench, keep Idris in` | `{other, Mustafa, bench}` `{other, Idris, in}` | 3/3 ✅ |
| `I was in last week` | `{sender, in, **past**}` | 3/3 ✅ |
| `I can bring 2 players with me` | `{other, "2 players", **named=false**, in, future}` | 3/3 ✅ |
| `Zeeshan is out 😂😂 vote him out lads` | `{other, Zeeshan, out}` / no claims | ⚠️ 2/3 |
| `Ayoub snatched that spot 😭` | `{other, Ayoub, in, past}` / no claims | ⚠️ 2/3 |
| `If u can make happy to drop` | **no claims** | ❌ **0/3 — a miss** |

The message that started this — `my brother can play if needed` — extracts **correctly
and stably**, with `personNamed: false` and `subject: "other"`. Those two booleans are
all the engine needs to (a) not bench Amir and (b) not provision a ghost user. The
current system gets it wrong 6/6.

Honest about the three imperfect rows:

- **`If u can make happy to drop` extracts nothing — a real miss on a real incident
  message** (Erdal, 2026-06-09). My extractor prompt does not cover that phrasing. It
  needs a rule, in a ~1,200-token specialist where it is testable in isolation. But note
  the *consequence*: the engine does nothing, so **Erdal stays in the squad, which is the
  correct outcome**. The current system's failure on this exact message was to drop him.
  **The redesign's worst case here is a missed action; the status quo's was a wrong
  action on a paid match.**
- **`Zeeshan is out 😂😂`** — the extractor sometimes reports the claim. That is
  *correct behaviour for an extractor*: the text does contain it. Deciding it is banter
  requires corroboration the extractor cannot see (is Zeeshan talking in this window? is
  the speaker an admin?) and the engine can. **This is why the banter-drop guard
  survives** (§9).
- **`Ayoub snatched that spot`** — unstable at both stages. Two stages disagreeing is not
  ideal, but it fails closed.

### 6.3 Stage 3 — the decision engine

Pure functions: `(facts, squadState, actor, orgFeatures) → Decision[]`. No I/O, no
model, no clock. This is what MatchTime already does best — the cold audit calls the
pure-function core *"the best part of this codebase"*.

The category-B rules move here as code rather than prose:

```ts
// A third-party claim about someone never actually named cannot register anyone.
if (claim.subject === "other" && !claim.personNamed) return ask("what's their name?");

// A contingent claim never writes immediately. Where it parks depends on what the
// condition is about — the model told us that; it did not decide it.
if (claim.contingent) {
  return claim.conditionOn === "squad"
    ? standingOffer(claim)      // bench IF AND ONLY IF the subject is the sender
    : tentative(claim);         // personal uncertainty: record, chase later
}

// Past and hypothetical never write. (Replaces looksLikeHypotheticalOrPast.)
if (claim.tense === "past" || claim.tense === "hypothetical") return noop();
```

Incident A5 dies at line 1 and again at line 2.

The engine also owns the two things the model got catastrophically wrong: **arithmetic**
(format switch, capacity) and **capacity invariants** — including the third bug in the
brief, `forceBench` writing a BENCH row with four slots open
(`attendance.ts:132-136`). That is a decision, in decision-engine territory, and it
should assert rather than write.

### 6.4 Stage 4 — composition

Every outgoing message is composed from the database *after* the writes land.
`composeSquadStatusPost()` is the model; generalise it. Numbers and names are never
model-authored, so they cannot be wrong, so nothing needs to check them afterwards.

The model keeps exactly one job: **tone**, on free-form Q&A only (stats, MoM, "who's
been the most consistent"). Even there the facts come from the Recent History block, not
the model's memory.

The honest-ack pattern (`out-of-band-self-attendance.ts:84-152`, and `9f19040` on the DM
path) becomes structural rather than a rule: because the composer runs after the write
and reads its outcome, it is **impossible** to tell a player they are in when the write
threw. That closes cold-audit finding 1.1 by construction, on the path carrying ~20× the
traffic.

---

## 7. Alternatives considered

| option | verdict | why |
|---|---|---|
| **One call, strict tool use, prose rules deleted** | **Runner-up. Worth doing as a step; not the destination.** | Fixes schema drift, fence-stripping, field-shape bugs, cheaply. Does **not** fix the root cause: the model still emits `registerAttendance`, so `intent` can still contradict it, so the regex-over-prose seatbelt survives. Does not reduce output tokens. Kills ~7 of 54 seatbelts. |
| **Keep one call, move all decisions to code** | Rejected as an end state, adopted as steps 3–5 | Most of the value. But one prompt covering 13 intents means a change to the conditional-drop rule cannot be tested without re-validating all 13, and the modal banter batch still costs $0.04 and 16 s. |
| **Fine-tuning** | Rejected | No labelled corpus, and the obvious source is poisoned: `AnalyzedMessage.action` records the **intent, not the outcome** (`route.ts:1373-1377`, cold-audit 1.3), so the labels would encode the bugs. One customer. Re-training on every product change. Loses the auditability that is the point. |
| **Constrained decoding / grammar** | Folded in | This is `output_config.format` + `strict: true`. Used in the design. |
| **Cheap router + strong model for hard cases** | **Adopted** | This is the recommendation. |
| **`window-analyzer.ts` — one coherent diff per window** | Rejected as target, **adopted as migration harness** | See below. |
| **No LLM — regex plus a state machine** | Rejected | This was tried. The regex fast-path existed and was **deliberately deleted on 2026-04-21** (`handlers.ts:7-10`, *"Kemal explicitly asked for this"*). What remains is genuinely ambiguous English. |

### 7.1 On the existing shadow analyzer

`src/lib/window-analyzer.ts` (2026-05-29) is a serious, well-made attempt at this exact
problem. Its header diagnoses it in the same terms I have:

> *"That bandaid layer is itself the source of recurring incidents (Kemal dropped from
> his own squad 2026-05-28; Mojib not dropped 2026-05-26; Erdal/Najib before that).
> Every fix loosens or tightens a regex and the next case finds a new gap."*

Its prompt is **49 lines with 10 rules** and closes with a line I admire:

> *"There is no safety net behind you that will 'fix' a mistake — what you emit is what
> would happen."*

It has run in shadow for three months, writing to `WindowVerdict` with a comparison UI
at `/admin/shadow`. It never cut over.

**Why I think it stalled**, and why I am not simply proposing it: it changed the
*granularity* of the decision but not *who decides*. It still asks the model for
`stateChanges: [{action: "drop", targetName: "..."}]` — a decision, in the model's
output. Its R4 reads *"Third-party adds ('bringing Najib', 'my dad Faris is in') →
'add' for the named player"* with **no named-vs-unnamed distinction**, so `my brother
can play if needed` would still add a player called "my brother". Same class of bug, one
call later.

But its **infrastructure is exactly right** and is the migration harness (§10). Building
it was not wasted work; it was the previous step of this same journey.

### 7.2 One thing to do regardless

The analyzer is pinned to `claude-sonnet-4-5` (`message-analyzer.ts:51`).
`claude-sonnet-5` is **$2/$10 per MTok against Sonnet 4.5's $3/$15 — 33% cheaper on
both**, newer, 1M context. A one-constant change, as the comment above the constant
itself observes ("instantly revertible"). A/B it against the live suites this week
whatever else is decided.

---

## 8. Cost and latency

Rates: Sonnet 4.5 $3/$15 per MTok, Sonnet 5 $2/$10, Haiku 4.5 $1/$5; cache read 0.1×,
1-hour cache write 2×.

### 8.1 Two bugs are inflating today's bill by ~30%

**Bug 1 — the prompt cache is being busted on every call.**
`buildMatchContextBlock` renders `kickoffHint` = `` `${hoursToKickoff.toFixed(1)}h until
kickoff` `` (`message-analyzer.ts:668-671`) into the match-context block at `:709`. That
block carries `cache_control: {ttl: "1h"}` at `:1011-1016`. The value changes every
**6 minutes**; flushes are **10 minutes** apart. So it changes essentially every call.

Verified empirically — four identical requests, changing only that one figure:

| request | cache_write | cache_read |
|---|---|---|
| identical context | 0 | 20,429 |
| **only `32.4h` → `32.2h`** | **2,120** | 18,309 |
| **only `32.4h` → `32.0h`** | **2,120** | 18,309 |

2,120 tokens flip from a $0.30/MTok read to a $6/MTok write: **+$0.0121 per call, a
+40% overhead on the whole batch.** And it compounds — `loadRecentHistory`
(`match-history.ts:74-91`) has **no `take:` clause** (verified: zero matches for `take:`
in the file), so the Recent History block inside that same never-cached breakpoint grows
monotonically for the life of the club.

**Fix: move `kickoffHint` into `freshBlock`.** It is already recomputed per call; it just
sits on the wrong side of the breakpoint. One line. Free.

**Bug 2 — every batch pays for two analyses.** `runShadowAnalysis` fires on every batch
via `after()` (`route.ts:1624-1638`) — a second, **entirely uncached**
`claude-sonnet-4-5` call, ~$0.014, capped at $5/day. Running since 29 May with the
stated plan *"after a week of comparison data we decide: cut over, hybrid, or scrap."*
Three months on, no decision. It is ~30% of the bill.

**Neither of these is an architecture problem.** Both are step 0.

### 8.2 Per batch, measured

| batch | cache read | cache write | fresh in | out | **total** | latency |
|---|---|---|---|---|---|---|
| 3 msgs, 1 action | 18,309 | 2,120 | 260 | 730 | **$0.0300** | 7.8–14.9 s |
| + shadow | — | — | ~2,500 | ~450 | **$0.0440** | (async) |
| 8 msgs, all banter | 18,309 | 2,120 | 479 | 1,285 | **$0.0389** | 14.0–18.6 s |
| + shadow | — | — | ~2,500 | ~450 | **$0.0529** | (async) |

**Output is 37–50% of the main call and the single largest line.** The 18,315-token
prompt is nearly free once cached. Any redesign that shrinks the prompt but keeps the
model writing the replies saves very little.

### 8.3 Proposed, per batch

| stage | model | in | out | cost |
|---|---|---|---|---|
| Router (8 msgs) | haiku-4-5 | 363 cached + ~450 fresh | ~140 | **$0.0012** |
| Extractor × 2 | sonnet-5 | ~900 cached + ~270 fresh each | ~180 each | **$0.0049** |
| Composer | — | — | — | $0 |
| Stats tone pass (~0.3/batch) | sonnet-5 | ~1,500 | ~200 | **$0.0012** |
| | | | | **≈ $0.0073** |

The extractors' cached prefix contains no clock-derived value, so it actually caches.

All-banter batch: router only. **$0.0012 and ~2 s** against **$0.053 and 16 s** —
**44× cheaper on the case that happens most.**

### 8.4 Per club per month

**I do not know the real batch volume and did not query production.** What is known:
the flush timer is 10 minutes (`smart-analysis.ts:49`) so at most **144 timer flushes per
day per group**; empty flushes early-return before the POST (`smart-analysis.ts:527-535`),
so idle ticks are free; and additional flushes fire on a bot mention or within 1 h of
kickoff (`:86-87`), with **no buffer cap** (`maxBufferLen: Infinity`, `:413`).

*(A "440 messages/day" figure circulates from the `seen=340` line in
`SESSION-HANDOFF-2026-08-27.md:389`. I checked: that line is an **illustrative example of
a new log format** inside a fix description, not a production reading. I am not going to
repeat it as measured.)*

One query settles it:
`SELECT date_trunc('day',"createdAt"), count(*) FROM "AnalyzedMessage" GROUP BY 1;`
and `WindowVerdict` already stores a real per-call `costUsd` (`schema.prisma:1189-1218`),
so **the actual bill can be read out of the database today**.

| batches/day | today, all-in | after step 0 (bugs fixed) | proposed |
|---|---|---|---|
| 40 | **$58/mo** | $28/mo | **$9/mo** |
| 70 | **$101/mo** | $49/mo | **$15/mo** |
| 144 (timer ceiling) | **$207/mo** | $101/mo | **$32/mo** |

The `MODEL` comment at `message-analyzer.ts:46-50` estimates "~£10/mo each" and
`smart-analysis.ts:43` says "~£2/month". **Both predate the shadow analyzer and the
cache-buster and are stale by roughly an order of magnitude.**

### 8.5 The rest of the LLM surface

The analyzer is not the only caller. There are **11 `messages.create` sites across 9
files**, none with an env-overridable model id:

| file:line | purpose | model | max_tokens |
|---|---|---|---|
| `message-analyzer.ts:986` | the main batch analyzer | sonnet-4-5 | 16,384 |
| `message-analyzer.ts:1068` | re-prompt for dropped verdicts | sonnet-4-5 | **64,000** ⚠️ |
| `message-analyzer.ts:1206` | `composeChaseText` | sonnet-4-5 | **64,000** ⚠️ |
| `window-analyzer.ts:247` | shadow | sonnet-4-5 | 4,096 |
| `dm-qa.ts:212` | scoped DM Q&A | sonnet-4-5 | 600 |
| `rating-adjuster.ts:153` | chat-derived rating nudges | sonnet-4-5 | dynamic |
| `squad-from-list.ts:285` | parse pasted squad lists | sonnet-4-5 | 4,000 |
| `onboarding-analyzer.ts:139` | chat-export → ratings | sonnet-4-5 | 6,000 |
| `match-availability-classifier.ts:108` | DM in/out | haiku-4-5 | 200 |
| `roster-survey-classifier.ts:78` | survey DM replies | haiku-4-5 | 200 |
| `onboarding-conversation.ts:539` | onboarding extraction | haiku-4-5 | 400 |

**⚠️ The two `max_tokens: 64000` sites need checking.** `5381859` (2026-05-26) lowered
`analyzeBatch` to 16,384 because *"the Anthropic SDK refuses non-streaming calls whose
implied runtime > 10 min... tanked the whole analyzer for ~30 min"*. Lines 1068 and 1206
were never lowered. If that SDK guard still applies, **the dropped-verdict retry always
throws into its catch, and every scheduled chase silently falls back to static text** via
`composeOrFallback` (`bot-scheduler.ts:832-845`). That would be a live, invisible
degradation. It is a five-minute check and it is in step 0.

Also worth an audit: several `cache_control` markers sit on prompts below the minimum
cacheable prefix (1,024 tokens on Sonnet, higher on Haiku) and are silent no-ops, and
`dm-qa.ts` / `window-analyzer.ts` have no caching at all.

### 8.6 Latency

Router ~2 s, extractors in parallel ~2–4 s, engine <5 ms, composer 0. **~5–7 s** against
today's **8–19 s**. Against a 10-minute flush budget neither matters — except on the
**urgency** path (`smart-analysis.ts:87`), where kickoff is within an hour and every
message flushes immediately. There the modal case (a banter message during an urgent
flush) goes from 16 s to 2 s.

---

## 9. What happens to the 54 seatbelts

### Dies — 19, because the error becomes unrepresentable

| seatbelt | `file:line` | why it evaporates |
|---|---|---|
| **OUT safety net** (regex over `reasoning`) | `route.ts:1012-1056` | one `polarity` cannot contradict itself; no prose to parse |
| **Bench-demote safety net** (regex over `reply`) | `route.ts:1060-1111` | the model does not write replies, so a write cannot be reverse-engineered from one |
| **IN safety net** | `route.ts:973-996` | exists only because `intent` and `registerAttendance` are separately hallucinated |
| **`enforceCanonicalRoster`** (6 sub-passes, 140 lines) | `message-analyzer.ts:1482-1623` | rosters composed from the DB |
| **`rewriteOverconfidentPromotion`** | `message-analyzer.ts:1639-1710` | the model cannot claim a promotion it does not author |
| Offer-independent promotion strip | `route.ts:1318-1350` | ditto |
| **Squad-status collapse** + `looksLikeSquadStateReply` | `route.ts:1508-1582` | one deterministic post per batch by construction |
| `enforceProximity` (incl. the UTC/BST patch) | `message-analyzer.ts:1335-1379` | the composer knows the kickoff time |
| React reconciliation (batch-final) | `route.ts:1472-1506` | reacts derived from write outcome |
| Duplicate-IN react backfill | `route.ts:1584-1605` | ditto |
| `👍`→`✅`/`🪑` last-mile rewrite | `route.ts:2151-2161` | ditto |
| OUT pre-check reply suppression | `route.ts:2210-2224` | the composer only describes writes that happened |
| Bench-confirmation reply suppression | `route.ts:2170-2192` | ditto |
| `generate_teams` / `show_teams` reply overrides | `route.ts:2471-2653` | already deterministic; the override goes with the thing overridden |
| Self double-register skip | `route.ts:2325-2327` | `subject` is a field, not an inference |
| Team-swap seatbelt | `route.ts:899-923` | exists because a prompt rule misfires; becomes an extracted relation |
| Colour-swap bypass | `route.ts:864-888` | ditto |
| `isLeaderboardLine` exclusion | `message-analyzer.ts:1386-1393` | only needed because a roster-rewriter clobbers stats output |
| `safeParseJson` fence-stripping | `message-analyzer.ts:1873-1885` | structured output |

### Survives — 22, because they were never about the model

**Not technical debt.** These stay and should get *better* tests, not deletion:

- **Authorisation** — stats blast (`route.ts:340-420`), score (`:2415-2427`), bulk
  payment (`:2675-2696`), `promote-authorization.ts`. Nothing about the model's
  competence changes who may do what.
- **Tenancy** — per-org feature gates (`route.ts:2091-2111`); `ATTENDANCE_OFF_OVERRIDE`
  becomes a router/engine capability filter instead of a 12-line prompt appendix.
- **The tag gate** — `interaction-contract.ts:114-143`. Policy over
  `(subject, polarity, wasBotTagged)`. Already pure, already tested. Keep exactly.
- **The banter-drop guard** — `route.ts:1125-1190`. My prototype *proves* this is needed:
  the extractor correctly reports that "Zeeshan is out 😂😂" contains an OUT claim. The
  corroboration policy is engine work. **Improve it**: today it only sees the current
  batch (`route.ts:1155-1165`), so a target who spoke ten minutes ago is unprotected.
- **Coverage** — every input id must produce exactly one route (S1's incident, in code
  rather than prose). The dropped-id re-prompt (`:1035-1103`) survives, applied to the
  router.
- **Confidence floor** — `:2038-2058`, now per-fact rather than blanket.
- **Identity resolution** — `route.ts:1753-1776`, `:1879-1900`, `:1937-1945`,
  `isRawDigitName`. Ambiguity bails are load-bearing and orthogonal.
- **Value clamps** — reminder window, score range, `sanitiseTeamNames`.
- **Unresolved-sender nudge** — `route.ts:1362-1414`. "Message understood, action
  silently not taken" is this product's signature failure and is independent of who
  decides.
- **The partial-response admin DM** — `route.ts:648-720`. Keep, but **fix the mechanism**:
  today it prefix-matches free-text `reasoning`; under the new design it matches a typed
  error, which is what it always wanted to be.

### Becomes a schema field — 7

`looksLikeHypotheticalOrPast` → `tense`. `looksLikeConditionalDrop` — which today
requires a **literal `if`** (`route.ts:3095`), so *"happy to drop **when** you find
someone"* bypasses the hold entirely — → `contingent`. `"me"`/`"myself"` rebinding in
`teamOverrides` and `coveredNames` → `subject: "sender"`. The tentative/standing-offer
split → `conditionOn`.

---

## 10. Migration

A big-bang rewrite is not on the table. The good news: **the parallel-run harness already
exists and is running in production today.**

`window-analyzer.ts` + `WindowVerdict` + `/admin/shadow` give us a second analysis of the
same window fired via `after()` (so it cannot affect the live path), batch-hash dedupe, a
daily cost cap, per-call `costUsd` and `modelMs`, and a side-by-side dashboard. It was
built for exactly this decision and then left running for three months without one.

**Step 1 is to repoint it and finally use it.**

| # | step | ships | risk | revert |
|---|---|---|---|---|
| **0** | **Free wins, zero design risk.** Move `kickoffHint` out of the cached block (§8.1, ~30% of the bill). Decide the shadow: cut over or `SHADOW_DAILY_USD_CAP=0`. Check the two `max_tokens: 64000` sites (§8.5) — the chase composer may be silently dead. Add `take:` to `loadRecentHistory`. Delete the duplicated line 372; add `bulk_payment_credit` to the schema at `:244`; fix the false DM claim at `:346`; delete the keycap rule at `:270`; fix the stale fast-path comment at `smart-analysis.ts:44`. A/B `sonnet-4-5` → `sonnet-5`. | day 1 | none | revert |
| **1** | **Build the corpus.** The 26 incidents in §3.2 are the spec: each has a concrete message, a named player and a known-correct outcome. Today they live inlined in bespoke specs, or nowhere. One replayable JSONL corpus, run against any candidate pipeline. **This is the artefact that unblocks every later step and it does not exist.** | week 1 | none | — |
| **2** | **Repoint the shadow.** Replace `analyzeWindow`'s payload with router → extractors → **engine in dry-run**. Persist proposed writes to `WindowVerdict.verdictJson`. Still zero writes. Extend `/admin/shadow` to diff proposed-vs-actual on `registerAttendance`, `registerFor`, and reply-would-differ. | week 2 | **none** — `after()`, cost-capped, never writes | env flag |
| **3** | **Run two weeks; read the diff.** Criteria fixed in advance: **zero** cases where the new pipeline would write and the old correctly did not; **≤2%** where it would miss a write the old one correctly made; every disagreement triaged into a corpus case. Do not proceed on vibes. | week 4 | none | — |
| **4** | **Composition first — the safest real change.** Route every squad-state reply through `composeSquadStatusPost()` on the **existing** analyzer. Delete `enforceCanonicalRoster`, `rewriteOverconfidentPromotion`, both promotion strips, `enforceProximity`, the squad-status collapse. Big, visible, **entirely reversible**: changes only text, never a write. Cuts output tokens ~40% immediately and removes the largest regex surface. | week 5 | low — text only | revert |
| **5** | **Router in front, mega-call behind.** `none`-routed messages skip the analyzer; everything else hits the existing prompt unchanged. Captures the 44× banter saving with no change to how decisions are made. **Ship the regex floor and the `none`-bucket shadow with it** (§11.1). | week 6 | **medium** — where a real IN could be dropped | one flag |
| **6** | **Swap the attendance path to extractor + engine.** `self_att`, `other_att`, `offer` only — the three routes covering every incident in the archive. Everything else still runs the old prompt. Delete the OUT net, the IN net, the bench-demote net, and both prose-parsing regexes. | week 8 | **highest** — only after step 3's data | flag flips the three routes back |
| **7** | **Migrate the rest** — `question`, `team_ops`, `score`, `admin_ops`, one per week. Retire the mega-prompt when the last route leaves. Retire the shadow. | weeks 9-13 | low each | per-route flag |

Ordering rationale: **free wins, then evidence, then text, then reads, then the
attendance write** — the only thing that can put a player at a pitch with no slot goes
last. Steps 0 and 4 are worth shipping even if nothing else is funded: step 0 halves the
bill for a day's work, and step 4 deletes the 140-line regex without risking a
registration.

---

## 11. How this design fails

### 11.1 Router misclassification — the biggest risk, and a genuine regression

Today every message gets a verdict, and if the model misreads one, 54 seatbelts get a
look at it. In the new design a message routed `none` **disappears silently**: no write,
no reply, no reaction, no `AnalyzedMessage.action`. My own prototype misrouted "move
Mustafa to the bench" 3/3.

Containment, all shipping *with* step 5:

- **Bias the router toward action.** "When in doubt between `none` and anything else,
  choose the other route" is already in the prototype prompt. A false positive costs one
  extractor call (~$0.002) that returns no claims. A false negative costs a player their
  slot. The asymmetry must be built in, not hoped for.
- **A deterministic floor.** ⚠️ **Correction to my own first draft:** I assumed the
  existing regex fast-path could serve as this floor. It cannot — it was **deleted on
  2026-04-21** and `handlers.ts:7-10` records that *"Kemal explicitly asked for this"*.
  So the floor must be **built new**, and reintroducing one is a product decision that
  needs his sign-off. The upside is real: a ~20-line matcher for bare `in`/`out`/`+1`
  that force-routes regardless of the router would also **restore instant reactions** for
  the most common message in the group, which the 10-minute batch took away.
- **Shadow the `none` bucket forever.** Sample `none`-routed messages through the full
  extractor nightly, offline, and alert on any that produce a claim. This is the
  regression detector the current architecture has never had.
- **A frozen router eval set** — the step-1 corpus, in CI. This is what the
  18,315-token prompt has never had: a number that says whether a change helped.

### 11.2 Two-stage disagreement

Router says `other_att`, extractor returns nothing → silence, with the reason split
across two calls. Seen in the prototype on "Ayoub snatched that spot". Mitigation: log
the route alongside the extracted facts on `AnalyzedMessage`, so triage is one query.
Still better than today, where the reason lives in a prose field that five regexes also
depend on.

### 11.3 Schema drift

A model upgrade changes how a field is populated — `personNamed` starts counting
nicknames, say. Structured output guarantees *shape*, never *semantics*. Containment: the
corpus runs against any candidate model before it goes live; model ids are pinned; the
engine treats every field as untrusted and asserts its own invariants (capacity,
authorisation, ordering) rather than trusting the facts to be sane. Today the equivalent
risk is strictly worse and invisible: a model upgrade silently changes what
`/\b(definite|definitely)\s+(drop|out)\b/.test(reasoning)` matches, and nobody would know
until a player is dropped.

### 11.4 More moving parts

Two-to-three calls per batch instead of one; a router timeout with healthy extractors is
a new state. Mitigations: the router is the only *serial* dependency (extractors fan out
in parallel); on router failure, route **everything** to the attendance extractor —
expensive, correct, self-limiting since batches are small; on extractor failure, fail
closed and surface it through the existing partial-response admin DM. The operational
surface does grow. That is a real cost.

### 11.5 Things that get worse

- **Two prompts plus per-route eval sets** — more artefacts than one file, even if each
  is 20× smaller.
- **Debugging spans calls.** "Why did nothing happen?" needs two logs. Better than
  today's answer ("somewhere in 18,315 tokens and 54 guards"), but it is two places.
- **The engine becomes a single point of failure.** Every decision in one module. That
  is the *intent* — testable, versioned, reviewable — but a bug there has wider blast
  radius than a bug in one of 54 narrow guards. Mitigated the way all pure code is:
  exhaustive unit tests, which this codebase already does well (675 tests in 547 ms).
- **Loss of "the model will figure it out".** A genuinely novel message shape sometimes
  gets handled sensibly today because an 18,315-token prompt has seen something like it.
  A router with nine routes and an engine with explicit rules will do nothing instead.
  For a system writing to a paid squad, doing nothing is the right default — but it is a
  real behavioural loss, and **the club will experience it as "the bot got dumber" before
  they experience it as "the bot stopped being wrong."** That is worth saying out loud
  before shipping, and worth watching for in week 1 of step 6.

---

## 12. Testability

The point of the redesign, more than cost.

### 12.1 What exists today

| runner | command | scope | live model? |
|---|---|---|---|
| Vitest | `npm run test:unit` | 41 files, pure logic, 675 tests in 547 ms | no |
| Playwright | `npm run test:sim` | 26 sim specs against a stub seam (`MT_TEST_LLM_STUB_FILE`, `message-analyzer.ts:796`) | no |
| Live sims | `MT_SIM_LIVE_LLM=1 …` | ~9 `-live.spec.ts` files | yes |

Two traps worth knowing before anyone leans on the live suite:

1. **`MT_SIM_LIVE_LLM=1 npm run test:sim` disables the stub for *all* sim specs**,
   including the ~17 written against canned verdicts, and there is no single script that
   runs only the live ones.
2. **The shadow analyzer has no stub seam** (`window-analyzer.ts:245` reads
   `ANTHROPIC_API_KEY` directly), so every live sim run **silently doubles the bill**.
   Worth fixing in step 0.

### 12.2 What has no coverage at all

Notable, given §3.2:

- **`conditional_in` flavour (a)** — the standing-offer rule at `:357`. **This is the
  exact A5 bug.** Flavour (b) is tested; (a), whose outcome is the *opposite*, is not.
- **The CONDITIONAL DROP hold** — a named production incident (Erdal 2026-06-09).
  `e2e/README.md:167` still lists it as deferred.
- **`composeChaseText` / `CHASE_SYSTEM_PROMPT`** — a second LLM call in the same file, on
  the scheduled path, with **no test, stubbed or live**. And possibly dead (§8.5).
- **`bulk_payment_credit`** — real money, live on Sutton FC, **zero tests anywhere**.
- Plus `reminder_request` execution, FACT-CHECK, SHORT CONFIRMATION, REPOSTED ROSTER,
  state collapse, the confidence downgrade, the verdict-coverage admin DM, the truncation
  retry, the colour swap, `enforceProximity`, and `ATTENDANCE_OFF_OVERRIDE` at the model
  level.

**There is no golden corpus.** No transcript fixture file exists anywhere in the repo.
Real production wording lives in three places: two bespoke spec files and **inside
`SYSTEM_PROMPT` itself** (`:469-489`, "drawn from real transcripts"). Prompt and corpus
are the same artefact, so **they drift together, undetected**, and there is no way to
re-run "everything the model has ever got wrong" after a prompt edit.

That is why building the corpus is step 1 and not an afterthought.

### 12.3 What the redesign changes

| stage | how it is tested | live model? |
|---|---|---|
| Router | ~60-case frozen corpus, ≥95% exact match, 3 runs each for stability | **yes**, but cheap: ~$0.02, ~2 min, per PR |
| Extractors | ~40 cases per route, asserting **fields**, not outcomes | **yes**, ~$0.15 for a full sweep |
| **Decision engine** | **pure unit tests — the whole incident archive as fixtures** | **no** |
| Composer | golden-file snapshots | **no** |

The repo rule that LLM-dependent behaviour needs live validation is right — it exists
because a stubbed sim passed while the real model still misclassified. **This design
shrinks the surface that rule applies to.**

Today, "does an admin demote work?" is only answerable by running the real model through
the whole pipeline: minutes, dollars, non-deterministic. Afterwards it splits in two:
*"does the extractor return `{subject: other, personRef: Mustafa, polarity: bench}`?"* —
one live call, one assertion, stable — and *"given that fact and this squad, what should
happen?"* — a pure unit test running in a millisecond that can enumerate every capacity
edge case, **including the `forceBench`-with-open-slots bug, which is currently
untestable without a live model.**

Every dated incident in §3.2 becomes a fixture. The 27 real player names move from
instructions the model re-reads on every call into test data that runs in CI.
**That is the actual deliverable: the incident archive stops being a prompt and becomes
a test suite.**

---

## 13. What must not change

- **`format-switch.ts`.** The template for the whole redesign. Do not touch it; extend
  its pattern.
- **The pure-function core** — `registration-match-select.ts`, `next-upcoming-match.ts`,
  `promote-authorization.ts`, `recruit-chase.ts`, `interaction-contract.ts`,
  `payments.ts`, `block-booking.ts`. The engine is built *out of* these, not beside them.
- **The interaction contract.** Tag-gating for directed ops, tag-free for self-attendance
  and pure IN-adds (`19f43e3`, `bd3305d`) is a *product* decision reached after real
  incidents. It moves into the engine unchanged in meaning.
- **`dispatch-claim.ts` + `instance-lock.ts` + `deploy-pi.sh`.** Untouched by this work.
  The duplicate-send incident must not be re-litigated.
- **The bench-offer model** — broadcast to the whole bench, first-claim-wins, **nobody
  ever dropped**, daytime-gated. That design exists because the old sequential chain
  marked Karahan DROPPED while he slept. Preserve the semantics exactly.
- **The honest-ack pattern** (`out-of-band-self-attendance.ts:84-152`). Not merely
  preserved — made structural.
- **The conservative default.** *"A missed add is recoverable in one message; a wrong
  registration on a paid match is not"* (`message-analyzer.ts:475`) is the correct value.
  It must be encoded in the engine, not left to a router prompt.
- **`composeSquadStatusPost()`.** Already correct. Promoted, not rewritten.
- **Every rule in §9's "survives" list.** They are product rules that happen to live in a
  seatbelt today. Moving them must not lose them.

---

## 14. Where I am uncertain

1. **Real batch volume.** I did not query production, so §8.4 is parameterised rather
   than answered. Two queries settle it, and `WindowVerdict.costUsd` already holds the
   real per-call spend.
2. **Router accuracy on real traffic.** 18 adversarial cases is a smoke test, not an
   evaluation. Real chat is mostly banter and the router will look better on it than on
   my set — but the tail is where the incidents live. **Step 3 exists precisely to replace
   this guess with a measurement, and I would not commit to step 6 without it.**
3. **The `question` route is the least designed part of this document.** S16 is the
   heaviest section at 2,091 tokens and covers six unrelated sub-cases. Squad/bench/phone
   answers are deterministic; free-form stats genuinely needs a model. Splitting that
   cleanly is real work I have not specified.
4. **Sonnet 5 vs Haiku 4.5 for the extractors.** I prototyped extraction on Sonnet 5 and
   routing on Haiku 4.5 without testing the cross. Haiku extractors would be ~2× cheaper
   again. Worth an experiment; not worth guessing.
5. **Why the shadow never cut over.** I inferred it from its design (§7.1). If there is
   another reason — the comparison data looked good and nobody had time, or it looked bad
   for reasons I have not seen — **that evidence should be read before funding this**. It
   is the closest thing to a prior experiment we have, and three months of `WindowVerdict`
   rows are sitting there unexamined.
6. **The two `max_tokens: 64000` sites.** I could not verify whether the SDK's
   non-streaming runtime guard still trips at that value. If it does, the chase composer
   has been silently falling back to static text since May, which would be a live bug
   this document has surfaced but not confirmed.

---

## Appendix — reproducing the measurements

Throwaway scripts under the session scratchpad (deliberately not committed):

- `measure.mjs` — `count_tokens` against the live `SYSTEM_PROMPT` and each context block
- `inventory.mjs` — segments the prompt into the 39 units of §3.2 and measures each
- `repro.mjs` / `repro2.mjs` — the live `SYSTEM_PROMPT` against the A5 incident message
- `cachebust.mjs` — the `kickoffHint` cache-buster proof in §8.1
- `proto.mjs` — the router + extractor prototype of §6

None writes to the database, sends a message, or modifies the repo.
