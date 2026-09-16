# Multi-language design: how MatchTime speaks the group's language

Written 2026-09-16, read-only. No code was changed, nothing was sent, no
production write. The production database was read (organisation, sport
and activity rows) to confirm the live state; the numbers below come from
reading the code on `main` at `292627d`.

Scope: everything about OUTBOUND language and about knowing a group's
language. Phase 1 (READING Turkish attendance: the router and extractor
prompts plus a Turkish deterministic floor beside `FLOOR_IN` /
`FLOOR_OUT` in `src/lib/pipeline/router.ts:287`) is being implemented by
another agent in parallel and is referenced here, not redone. Its spec
is section 2 of `MDs/second-group-readiness-erdal-2026-09-16.md`.

## The short version

- **The bot has about 185 distinct outbound templates (about 230 rendered
  variants): about 120 group-facing, about 65 DMs, plus 9 reactions that
  need nothing.** Only two of them are written by a model (the five
  scheduled chase kinds and the DM Q&A answer). Everything else is an
  English template literal in TypeScript. Full tables in section 1.
- **Recommendation: `Organisation.language` (ISO code, default `"en"`),
  a typed per-language string table under `src/lib/i18n/` where every
  parameterised entry is a function, `English as the type, Turkish must
  satisfy it` so a missing key fails `tsc`, a language line in the
  uncached tail of the two model prompts, and the output guards taught
  each language's vocabulary.** Never translate at send time (section 4).
- **The hard part is not the strings.** It is the 14 English regular
  expressions that read the bot's own output back (`displaysSquadState`,
  `contradictsSquadState`, `enforceProximity`), the roughly 45 English
  inbound allowlists behind DMs that say "reply YES" or "reply IN", and
  four places where English prose doubles as a database key or a prompt
  literal. Three of these are bugs today, in English (section 7).
- **Friday minimum, stated plainly (section 5.4):** Phase 1 (reading)
  plus Phase 0 (the column, no consumer) is the honest floor. With that
  alone, Erdal's group reads Turkish and hears English: about 10 to 12
  English group posts and 1 to 6 English DMs per player in week one with
  Sutton's feature set, or 6 to 8 group posts and zero DMs with the
  trimmed set in 5.4. A "week-one subset" of 14 group strings (5.5) is
  the stretch goal if Phase 1 merges Thursday morning; it needs about 6
  agent-hours, 30 minutes of the owner's Turkish review, and two live
  dry runs.
- **Risk to Sutton FC: zero by construction, proven by a snapshot.** The
  first PR pins every English composer's bytes on `main` as it is today;
  the refactor must keep that file identical (section 4.5). Sutton stays
  `"en"` by the column default and never sees a Turkish word.

## 1. Inventory: every outbound string, by mechanism

A "string" is one distinct message template or send site. Reactions and
pure-name or pure-emoji messages are counted separately because they
need no translation. Every line reference is to `main` at `292627d`.

Quoted texts are abbreviated. The English source strings use an em dash
as a separator in many places (between "the latest squad" and the count
in the squad post, for instance); this document does not reproduce that
character, so a quoted string here is a paraphrase of shape, not the
bytes. `{x}` marks an interpolation. "Pinned" means a unit or sim test
asserts the exact bytes today.

### 1.1 Deterministic composers, group-facing (the pipeline and its pure copy modules)

`src/lib/pipeline/compose.ts` is the single composer for the analyze
path: one `speech.kind` per row. The rest are the pure modules it and the
scheduler share.

| # | file:line | Composer | Trigger | Shape | Locale-sensitive parts | Pinned |
|---|---|---|---|---|---|---|
| 1 | group-copy.ts:28 | `composeSquadStatusPost` | every squad-state reply | `📋 Based on all the messages I've picked up, here's the latest squad{ and bench}, *{n}/{max}*, need *{k} more* 🙏` or `✅ full squad.` then `*Playing:*`, `{i}. {name}` or `{i}. 🥁`, `*Bench ({n}):*` | counts, " and bench", headers read back by the guards | compose.test.ts:621, squad-post.spec.ts:110 |
| 2 | group-copy.ts:58 | `formatTeamsPost` | teams generated or re-shown | `⚽ *Teams for tonight*, {kickoff} at {venue}`, two labelled lists, `Objections? Reply \`swap X Y\`, admin will confirm.` | kickoff HH:mm, team labels, the typed command `swap` | teams-post.test.ts:26 |
| 3 | group-copy.ts:403 | `buildRatePromoPost` | after the last rating DM lands | `🎯 Just DM'd every player from the *{activity}* on {EEE d MMM} a personal rating link ...` | date label | no-time-of-day-greeting.test.ts:63 |
| 4 | group-copy.ts:419 | `buildMatchDayChaseFallback` | match-day morning chase, model unavailable | `☀️ Still *{need} short* for tonight's *{activity}*. Any takers? 👀` | "tonight" | no-time-of-day-greeting.test.ts:90 |
| 5 | compose.ts:87 | `safeName` fallback | pushname is a phone number | `a player` | the noun | compose.test.ts:196 |
| 6 | compose.ts:131 | `answer_count` | "how many are we?" | `{Not quite, we're / We're} {n}/{max} for {kickoffLabel}{, need {k} more 🙏 / ✅ full squad.}` | kickoffLabel (`EEE HH:mm`) | answer-batch.test.ts:640 |
| 7 | compose.ts:148 | `answer_squad` | "who's playing?" | row 1 | | answer-batch.test.ts:1080 |
| 8 | compose.ts:169 | `answer_fixture` | "what time / where?" | `⚽ {kickoffLabel} at {venue}.` | kickoffLabel | compose.test.ts:673 |
| 9 | compose.ts:195 | `answer_score`, no match | "did we win?" | `I haven't got a played match on record for this group yet.` | | regex only |
| 10 | compose.ts:202 | `answer_score`, no score | | `No score reported for {kickoffLabel} yet, tell me the result and I'll record it.` | | regex only |
| 11 | compose.ts:209 | `answer_score`, result | | `⚽ {kickoffLabel}: {red} {r} - {y} {yellow}. {A draw. / {X} won.}` | team labels | compose.test.ts:348 |
| 12 | compose.ts:247 | `answer_payments`, not tracked | | `I don't track payments for this group ...` | | regex |
| 13 | compose.ts:249 | `answer_payments`, no settled match | | `There's no settled match for me to check payments against yet.` | | regex |
| 14 | compose.ts:251 | `answer_payments`, no signal | | `No payments have reached me for {kickoffLabel} ...` | | none |
| 15 | compose.ts:253 | `answer_payments`, all paid | | `💳 All settled for {kickoffLabel} 🙌` | | regex |
| 16 | compose.ts:254 | `answer_payments`, unpaid | | `💳 {u} of {c} still to pay for {kickoffLabel}. I don't put names to that in the group.` | "N of M" deliberately, never "N/M" | compose.test.ts:420 |
| 17 | compose.ts:282 | `answer_rating_progress` | admin asks | `formatRatingProgressReply`, row 41 | | answer-batch.test.ts:1290 |
| 18 | compose.ts:291 | `answer_bench`, empty | "who's on the bench?" | `Nobody's on the bench right now.` | | none |
| 19 | compose.ts:292 | `answer_bench`, list | | `On the bench: {A, B and C}.` | `joinList` ("and") | qa.spec.ts |
| 20 | compose.ts:303 | `answer_person_status`, not down | "is X playing?" | `{who} isn't down for {kickoffLabel} yet.` | | none |
| 21 | compose.ts:305 | same, bench | | `{who} is on the bench for {kickoffLabel}.` | | none |
| 22 | compose.ts:306 | same, confirmed | | `Yes, {who} has a slot for {kickoffLabel}.` | | none |
| 23 | compose.ts:336 | `answer_phones`, none missing | | `Everyone in the squad has a number on record.` | | regex |
| 24 | compose.ts:337 | `answer_phones`, missing | | `No number on record for {A, B and C}.` | `joinList` | names only |
| 25 | compose.ts:383 | `answer_stats`, empty | "most consistent?" | `I don't have any completed matches in the last {N} days to go on ...` | window label | none |
| 26 | compose.ts:387 | `answer_stats`, rows | | `Most appearances in the last {N} days:` then `{i}. {name} [em dash] {n} match/matches` | the em dash separator is load-bearing: `isLeaderboardLine` keys on it; match/matches | answer-batch.test.ts:985 |
| 27 | compose.ts:429 | `answer_options`, lead | "what are our options?" | `We're {n} of {max}, need {k} more 🙏` / `✅ full squad.` | "N of M" | answer-batch.test.ts:1006 |
| 28 | compose.ts:435 | `answer_options`, no formats | | `There's no smaller format set up for this group, so it's more players or nothing.` | | none |
| 29 | compose.ts:436 | `answer_options`, none viable | | `No smaller format would be filled by the squad we have ...` | | none |
| 30 | compose.ts:439 | `answer_options`, proposals | | appends format-switch proposal lines (row 36) | | compose.test.ts:319 |
| 31 | compose.ts:453 | `teams_post` | | row 2 | | compose.test.ts:729 |
| 32 | compose.ts:470 | `teams_not_generated` | "show the teams" too early | `No teams generated yet, say 'generate the teams' and I'll sort them.` | quotes an English command | regex |
| 33 | compose.ts:479 | `guest_name_ask` | unnamed guest offered | row 44 | | compose.test.ts:517 |
| 34 | compose.ts:486 | `score_ack` | score reported | `Got it 👍 {red} {r} - {y} {yellow}, recorded.` | team labels | none |
| 35 | compose.ts:493 | `payment_ack` | bulk payment claim | `Noted 🙌 {first} covered {n} player/players.` | first name, plural | none |
| 36 | compose.ts:508 | `reminder_ack`, resolved | "remind me Thursday" | `👍 Got it, I'll DM you {whenLabel}.` | `whenLabel` from reminder-time.ts (`EEE d MMM 'at' HH:mm`) | admin-ops-engine-batch.test.ts:386 |
| 37 | compose.ts:509 | `reminder_ack`, unresolved | | `Will do 👍 I'll give you a nudge {phrase}.` | echoes the player's own words | none |
| 38 | compose.ts:529 | `bench_offer_open` | a slot opens, bench exists | `A slot just opened 🎟 {A, B and C}, first to say IN takes it. Nobody gets dropped.` | `joinList`, the typed token `IN` | attendance-engine.spec.ts |
| 39 | compose.ts:585 | `slot_opened` | confirmed player drops | `{X and Y are out, / That's} {n} of {max} for {kickoffLabel}. {One slot open, say *IN* to take it. / {k} slots open, say *IN* to take one.}` | first names, is/are, one/{k}, it/one, "slot" not "spot" and "N of M" not "N/M" (both load-bearing for the guards) | compose.test.ts:865, :944 |
| 40 | compose.ts:610 | `needs_tag_for_rest` | untagged third-party OUT refused | `One thing I've left alone: I've not {taken {A} out}{ or }{moved {B} to the bench}. That bit needs an @Match Time tag ...` | names, clause join, the literal handle | compose.test.ts:767 |
| 41 | compose.ts:631 | `bench_claim_too_late` | bench claim lost the race | `Thanks {first} 🙏 someone got there first, so the squad is back to {n}/{max} ...` | first name | none |
| 42 | compose.ts:652 | `pending_confirmed_ack` | pending names confirmed | `Got it 🙌 {A and B} is/are down for {kickoffLabel}.` | `joinList`, is/are | none |
| 43 | squad-announce.ts:72 | squad complete | confirmed reaches max | `✅ *Squad complete, {max}/{max}* for *{activity}* on {kickoff} 🙌`, `*Playing:*`, roster, bench, `See you all there ⚽` | its own `Intl.DateTimeFormat("en-GB")` at :47, a second date formatter | attendance.spec.ts |
| 44 | guest-name-ask.ts:398 | `renderGuestNameAsk` | unnamed guest | `Nice one {first} 🙌 What's their name? Reply with it and I'll add them to the squad.` / plural variant | singular/plural chosen by `PLURAL_RE` (:368) over the inbound English | guest-name-ask.test.ts:449 |
| 45 | mom-announcement.ts:30 | `buildMomAnnouncement` | MoM settled | `🏆 *{mvpLabel}, {activity}*`, `Congrats *{name}* ({top}/{total} vote/votes) 🎉` or `Shared between *{A & B}* ...`, `Votes:` bullets, `Your trophy awaits next match.` | `Sport.mvpLabel` (free text, per org), two plurals, `&` joiner | mom-announcement.test.ts:41 |
| 46 | format-switch.ts:137 | proposal line (2 variants) | squad short, smaller format fits | `If we don't find {k} more, we could switch to {format} ({total} players), {names} go/goes on the bench. Admins can rebook and flip it in the portal.` | `shortFormatName` strips the sport name's first word (:103), " + " joiner, goes/go; the model must paste it verbatim | format-switch.test.ts:111 |
| 47 | format-switch-time.ts:165 | `renderKickoffMoveLine` | admin switches format | `⏰ *Kickoff moves to {HH:mm}* (was {HH:mm}).` | times | none |
| 48 | out-of-band-attendance.ts:86 | 3 lines (IN / OUT / bench) | a DM, app or reaction registration the group did not see | `✅ *{name}* is IN ({replied by DM / from the app / 👍 on their invite}). Squad *{n}/{max}*.` | the emoji's meaning is carried in words ("gave a 👍") | out-of-band-attendance.test.ts:69 |
| 49 | bench-confirmation.ts:178 | 3 announcements | a bencher claims the slot | `🎟 *{claimer}* grabbed the slot, taking *{dropped}*'s place on *{team}* 🙌` + `_Say "regenerate teams" ..._` / `✅ *{claimer}* is in, replacing *{dropped}*, squad *{n}/{max}* 🙌` / open-slot variant | possessive 's, team label, quoted command | none |
| 50 | unresolved-nudge.ts:98 | 2 variants | IN/OUT from an unresolved sender | `Heads up, I got a message to *{join / drop out}* from *{pushname}*, but that name isn't matching anyone ...` | the verb is interpolated | unresolved-nudge.test.ts |
| 51 | stats-blast.ts:192 | `composeStatsBlastReply` | after an admin stats blast | `📊 Done, DM'd {n} player/players their personal stats link ...` | plural | stats-blast.test.ts:64 |
| 52 | bench-offer-copy.ts:94 | `buildBenchOfferGroupPost` | slot opens, whole bench tagged | `🎟 A slot just opened {context}. *First to claim it plays.*` + tags + `Just reply *IN* here to take it.` ... | `{context}` built in bot-scheduler.ts:1324 ("on *{team}* (replacing {name}) for *{activity}* tonight"); two variants behind `BENCH_PROMPT_MENTION_REACTIONS` (false) | bench-offer-copy.test.ts:82 |
| 53 | bench-offer-copy.ts:152 | `buildBenchIntroLine` | in the intro post | `🔁 *Bench promotion*, If someone drops, I tag the bench here and {how}. No timeout ...` | flag-gated fragment | bench-offer-copy.test.ts |
| 54 | bench-offer-copy.ts:221 | `buildFullSquadBenchInvite` | recruit ask while full | `*{match}* is full at {n} of {max}, but the bench is open. Say *IN* and I'll put you on the bench ...` | "N of M" | recruit-full-squad-bench.test.ts |
| 55 | bench-offer-copy.ts:239 | `buildBenchAskedLine` | no live caller | `Asking *{name}* to step up ...` | | bench-offer-copy.test.ts:176 |
| 56 | bench-offer-copy.ts:252 | `benchClaimPhrasingExample` | injected into a prompt as approved wording | `"<name>, you're up, just reply IN here to take it"` | the model imitates it | |
| 57 | bench-upgrade-ack.ts:49 | `buildBenchUpgradeReply` (2) | DEAD since 2026-09-06 (analyze route :229 says so) | `Thanks {first} 🙌 You're in the squad ...` | | bench-upgrade-ack.test.ts |
| 58 | attendance-write-outcome.ts:102 | `buildAttendanceFailureReply` (3 clauses) | a write threw | `Sorry {first}, I couldn't save that just now, so you're still down as playing ... 🙏` | first name | attendance-write-outcome.test.ts |
| 59 | rating-progress-answer.ts:199 | `formatRatingProgressReply` | admin asks | `📋 *{match}* ({EEE d MMM}), rating progress:` bullets `Rated: {a}/{b}`, `Picked MoM: ...`, `Still to rate ({n}): {names}` / `Everyone's rated ✅` | date, "MoM" abbreviation | rating-progress-answer.test.ts:51 |
| 60 | rating-progress.ts:90 | reason line | no completed match | `There's no recent completed match to check yet.` | | :65 |
| 61 | recruit.ts:373 | full-squad refusal | recruit ask, bench off | `The squad for *{match}* is already full, no open spots to recruit for.` | | recruit-full-squad-bench.test.ts |
| 62 | recruit.ts:269 | no-match refusal | | `There's no upcoming match to invite players to.` | | none |
| 63 | block-booking.ts:260 | `buildBulkCancelAnnouncement` | admin bulk-cancels | `❌ *Schedule update*, the following *{activity}* match is / matches are OFF:` bullets of `EEE d MMM` | irregular plural, dates | block-booking.test.ts |
| 64 | app/actions/matches.ts:152 | format-switch announcement | admin switches | `🔁 *Match switched*, now *{sport}* ({max} players).` + row 47 + `*Playing ({n}/{max}):*` + `_nobody yet_` | | format-switch-time.test.ts |
| 65 | app/actions/matches.ts:192 | cancel announcement | admin cancels | `❌ *Match cancelled*, {activity} on {EEE d MMM 'at' HH:mm}. Not enough players this week. See you next week!` | date | none |
| 66 | team-ops-engine-batch (via compose) | teams refusals | generate teams impossible | `No match lined up to build teams for.` / `Can't build teams right now, not enough confirmed players, {n}/{max}.` | | team-ops-engine-batch.test.ts:319 |

**Subtotal: 66 group-facing deterministic templates** (about 85 rendered
variants once the is/are, one/N, flag and source-label branches are
expanded).

### 1.2 Scheduler static templates, group-facing (`src/lib/bot-scheduler.ts`)

| # | file:line | Job key | Trigger and timing | Shape | Locale-sensitive parts |
|---|---|---|---|---|---|
| 67 | :402 | `org-{id}:bot-intro` | first tick for a new org | `👋 Hi all, MatchTime bot is live for this group.` + up to 7 feature blocks (🗓 Attendance "Say IN / OUT here", 🔁 bench, ⚽ Teams "generate teams", "swap X Y", 🏆 Ratings & MoM, ⏰ Reminders "@MatchTime remind me Monday", 📊 Stats, 💳 Payments) + `Questions? Just ask here. Let's go.` | quotes every typed command |
| 68 | :948 | `{match}:announce-match` | 09:00 to 12:59 London, more than 24h out, squad empty | `📅 *{activity}*, *{EEEE d MMMM 'at' HH:mm}* at {venue}. Say *IN* to join. First {max} confirmed play.` | long date, the token `IN` |
| 69 | :352 | evening update, match day, teams exist | 17:00 to 17:59 on match day | `⚽ *Tonight at {HH:mm}*, *{activity}* at {venue}` + two team lists + `See you tonight 🙌` | "Tonight", team labels |
| 70 | :1049 | evening update, match day, no teams | same, squad full | `⚽ *Tonight at {HH:mm}* ... Squad is locked. Say *@MatchTime generate teams* ...` + roster block | quoted command |
| 71 | :316 | `buildSquadRosterBlock` | inside 70 and 72 | `*Confirmed ({n}/{max}):*`, `_nobody yet_`, `*Bench ({n}):*`, numbered names, `(unnamed)` | headers read back by the guards |
| 72 | :1062 | evening update, squad short (`daily-in-list`) | 17:00 daily while short | LLM-composed; static fallback `🗓 *{activity}*, need *{k} more*.` + row 71 | count |
| 73 | :300 | `buildUnpaidTail` | appended to 72, or alone | `💳 1 payment still pending for last week's match ...` / `💳 *{n}* payments still pending ...` | two whole-sentence plurals, "the poll above" |
| 74 | :1531 | `{match}:chase-pre-kickoff` | 3 to 4h before kickoff while short | LLM; fallback `⏳ Still *{k} short* for *{activity}* at {HH:mm}. Anyone free tonight?` | time, "tonight" |
| 75 | :1556 | `{match}:pre-kickoff` | 0.5 to 2h before kickoff while short | LLM; fallback `⏰ Tonight *{HH:mm}* at *{venue}* · {n}/{max}, *still need {k}*, last chance to jump in. 🙏` | time |
| 76 | :1581 | `{match}:football-gear-reminder` | 1.5 to 2h before, sport name starts "football" | `⚽ *{HH:mm} at {venue}*, see you there! Quick reminder: ... *goalie gloves*, a *ball*, and *spare bibs*.` | football nouns |
| 77 | :1607 | `{match}:ask-score` | 1h after the end, no score | `🏁 *{activity}*, hope it was a good one. What was the final score? ...` | |
| 78 | :1637 | `{match}:payment-poll` | the instant the match ends | poll question `💳 Payments for *{activity}*, tick when you've paid`; options = the two team labels | any option counts as paid (poll-vote/route.ts:106), so a translated label is safe |
| 79 | :1885 | `{match}:rate-promo` | after the last rating DM | row 3 | |
| 80 | :1979 | `{match}:mom-announcement` | MoM settled | row 45 | |
| 81 | :1324 | bench offer context | with row 52 | `on *{team}* (replacing {name}) for *{activity}* tonight` | "tonight", team label |

**Subtotal: 15 scheduler group templates** (67 to 81), two of them
LLM-composed with static fallbacks.

### 1.3 DMs (scheduler, flows and routes)

| # | file:line | Job or function | To whom, when | Shape | Locale-sensitive parts |
|---|---|---|---|---|---|
| 82 | bot-scheduler.ts:540 | provisional review | admin, daily while provisional members exist | `✨ *New players to review*, {n} person was / people were auto-added ... {names} ... {url}` | irregular plural |
| 83 | bot-scheduler.ts:688 | tentative follow-up | player, 24h before kickoff | `Hi {first} 👋 You were a *maybe* for *{activity}* on {EEE d MMM 'at' HH:mm}. Are you in or out? Just reply *IN* or *OUT* ...` | date, tokens IN / OUT read back at dm-reply/route.ts:415 |
| 84 | recruit-chase.ts:216 | recruit chase | player, once, 3h after their invite | `👋 {first}, still after {n} player/players for *{activity}* on {when}. Reply *IN* ... or *OUT* and I'll stop asking 🙏` | plural, date, tokens |
| 85 | bench-offer-copy.ts:117 | `buildBenchOfferDm` | bench player, with row 52 | `👋 Hi{ first}, a slot just opened {context} and you're on the bench. Want it? Reply *YES* here, or *IN* on the message I tagged you in ...` | tokens YES / IN read back at dm-reply/route.ts:144 |
| 86 | bot-scheduler.ts:1433 | switch nudge | admin, day before 10:00 | `⚠️ *Low numbers*, {n}/{max} confirmed for *{activity}* tomorrow. Switch to *{sport}* ({k} players) ... {url}` | "tomorrow" |
| 87 | bot-scheduler.ts:1474 | cancel nudge | admin, day before 18:00 | `🚨 *Match in trouble*, only *{n}* confirmed ... below the minimum to play ({min}) ...` | |
| 88 | bot-scheduler.ts:1688 | fee ask | money collector, at match end | `💷 {first}, how much should each player pay for *{activity}* ({n} played)? ... e.g. "£8 each" or "£80 total to split"` | £ examples; the reply is parsed by `parseFeeReply` (£ and "each / total / split") |
| 89 | bot-scheduler.ts:1746 | pay chase | player, 18:00 daily up to 10 days | `💷 {opener}, your *{gbp}* for *{activity}* is still outstanding. Pay by bank, card, Apple or Google Pay, or settle directly: {url}` | 3 day-toned openers, `gbp()` |
| 90 | bot-scheduler.ts:1781 | direct-pay collector nudge | collector | `🤝 {n} player/players said they'd pay you directly for *{activity}*. Tick off whoever's settled up: {url}` | plural |
| 91 | bot-scheduler.ts:1867 (duplicated at app/actions/players.ts:809) | rating DM | player, the morning after | `🏆 *{activity}*, {EEE d MMM}` / `Rate your teammates and pick {mvpLabel}. Takes ~1 minute.` / `Your personal link:` / `Link expires in 5 days.` / `📊 Your season stats ... any time:` | date, `mvpLabel`, "5 days" |
| 92 | bot-scheduler.ts:191 | rating reminders, 5 day-toned variants | player, 18:00 daily for 5 days | `Hey {first} 👋, hope last night's *{activity}* was a good one ...` through `Last call {first} 🔔 ... closes tomorrow.` | "last night", "Halfway", "two days left", fallback name "mate" |
| 93 | recruit.ts:191 | `buildRecruitInviteDm` | player, on a recruit blast | `👋 {first}, we're putting the squad together for *{match}* on {when}. {n} spot/spots left. Playing? Just reply *IN*. Can't make it? Reply *OUT* ...` | plural, date, tokens; flag-gated 👍/👎 lines |
| 94 | recruit.ts:211 | `buildRecruitGroupInviteDm` | player, attendance off | `... Fancy it? Just reply *IN* in the group and you're sorted 🙌` | |
| 95 | payment-flow.ts:61 | pay link | player, fee confirmed | `💷 {first}, match fee for *{activity}* is *{gbp}*. Tap to pay (bank, card, Apple or Google Pay, or pay the organiser directly): {url} You can also pay for anyone you brought along.` | `gbp()` |
| 96 | payment-flow.ts:318 | fee confirmed ack | collector | `✅ Done, sent {n} pay link/links at *{gbp}* each for *{match}* ...` | plural |
| 97 | payment-flow.ts:326 | fee cancelled ack | collector | `No problem, cancelled. Just tell me the amount per player when you're ready.` | |
| 98 | payment-flow.ts:421 | `confirmPrompt` | collector | `Got it, *{gbp}* per player (split across {n} players) for *{match}*, {n} players to charge. Reply *✅* (or "yes") to send everyone their pay link ...` | two plurals; this exact wording is quoted inside `FEE_REPLY_SYSTEM_PROMPT` (fee-confirm.ts:326) |
| 99 | dm-subscriptions.ts:136 | 4 opt-in/out acks | player | `Done, I'll only message you about payments from now on. Text "start messages" anytime ...` etc. | quotes the English re-subscribe commands the parser accepts |
| 100 | stats-blast.ts:181 | `composeStatsBlastDm` | player | `📊 Hi {first}, here are your MatchTime stats ... {url} Keep this link, it doesn't expire.` | fallback "there" |
| 101 | out-of-band-self-attendance.ts:139 | `buildSelfAttendanceAck`, 5 variants | player, after a DM IN/OUT or invite reaction | `✅ You're in for *{match}* on {EEE d MMM, HH:mm}. See you there ⚽` / bench / out / no-op / failure | date |
| 102 | tentative-followup.ts:124 | 3 acks | player | `✅ Brilliant, you're in! See you there ⚽` / `👋 No worries, thanks for letting me know. Maybe next time!` / failure | |
| 103 | dm-reply/route.ts:166 | bench DM clarification | bench player | `Want the open slot for tonight? Reply *YES* to grab it. If not, no worries ...` | |
| 104 | dm-reply/route.ts:184 | 4 bench DM acks | bench player | `👍 No worries, you're still on the bench ...` / `✅ You got it, you're in for tonight! ⚽` / `Ah, someone just grabbed that one first ...` / `👍 Got it.` | |
| 105 | dm-reply/route.ts:452 | tentative re-ask | player | `No worries, just reply *IN* if you can play or *OUT* if you can't ...` | tokens |
| 106 | dm-reply/route.ts:678 | blast done | admin | `📣 Done, DM'd {n} recent player/players who hadn't replied ... ({k} spot/spots left) ...` | plurals |
| 107 | dm-reply/route.ts:691 | nobody to invite | admin | `Everyone who played recently has already responded to *{match}*, nobody new to invite. 👍` | |
| 108 | dm-reply/route.ts:676 | generic refusal | admin | `Couldn't do that right now.` | |
| 109 | dm-reply/route.ts:938 | roster-survey clarification | player | `Sorry {first}, wasn't sure if that was a reply to the roster check-in for *{org}*. Was your answer: • yes / I'm in • maybe / sometimes • not for now / out ...` | the English prefix is used as a DB dedupe probe at :927 (see section 7) |
| 110 | dm-reply/route.ts:1007 | 3 survey confirmations | player | `Got it {first}, marked you as in 👍, thanks!` / maybe / out | fallback "mate" |
| 111 | dm-qa.ts:223 | `APOLOGY` | player, DM Q&A fallback | `Sorry, I couldn't work that one out, try asking again? 🙂` | |
| 112 | attendance/route.ts:199 | auto-enrol / rejoin notices (2) | admin | `🆕 New player on *{org}*, just said IN on WhatsApp. Name: ... Phone: ...` | |
| 113 | group-join/route.ts:145 | join notices (2) | admin | `🆕 New player joined *{org}* on WhatsApp ...` | |
| 114 | group-leave/route.ts:96 | leave notice | admin | `👋 *{name}* left *{org}*'s WhatsApp group{ (was an admin)} ...` | |
| 115 | bot-health.ts:677 | health alert (+ about 11 finding lines) | admins, operator-facing | `⚠️ MatchTime's WhatsApp layer is degraded for *{org}*.` ... | English is fine (owner-facing) |
| 116 | app/actions/payments.ts:304 | direct-pay notice | collector | `💸 *{player}* says they'll pay you directly for *{activity}*, *{gbp}* ({q} players) ...` | |
| 117 | app/actions/claim.ts:92, phone-signup.ts:79 | verification codes (2) | web user | `🔐 *MatchTime, Claim your account* Your verification code: *{code}* It expires in 10 minutes ...` | |
| 118 | onboarding-conversation.ts:1256, :1299, :1447 | co-admin, admin magic link, enrichment ready (3) | admin | `📋 I read {n} past messages from *{group}* and drafted positions + seed ratings for {k} players ...` | |
| 119 | operator-note.ts:441 | operator note | the operator | `⚠️ MatchTime: {n} message/messages in the latest batch for *{org}* ...` | English is fine (owner-facing) |

**Subtotal: 38 DM templates** (82 to 119), about 60 rendered variants.
Two are owner-facing and stay English (115, 119).

### 1.4 LLM-composed paths, reactions, help and onboarding

**Only two prompts in the product make a model write words a user
reads.** Every other prompt classifies or extracts (13 of them: the
router, five extractors, four DM classifiers, three onboarding and
squad-list readers) and needs a "messages may be Turkish" line, which is
Phase 1's job, not a "write Turkish" line.

| # | Path | file:line | Model | Audience | What it composes | State it interpolates (already English) | English the model copies | Guards applied after | Static fallback |
|---|---|---|---|---|---|---|---|---|---|
| 120 | Scheduled chase, 5 kinds | message-analyzer.ts:823 `CHASE_SYSTEM_PROMPT`, :886 `buildChaseComposePrompt`, :859 `AT_RISK_BLOCK`, entry :431 | claude-sonnet-4-5 (:92) | GROUP | lead + numbered roster + bench block | `buildMatchContextBlock` :194 (names, counts, labels, format-switch facts) and `buildMatchClockBlock` :352 with `Kickoff (London): Tue 8 Sept at 21:30 (5.2h until kickoff, proximity=tonight)` from `londonDayLabel` :316 (`Intl "en-GB"`) | `Use roster header:` one of `*Playing tonight:*`, `*Playing tomorrow:*`, `*Playing {day}:*`, `*Squad:*` (:375); `*Bench (N):*` (:831); `Tentative: <Name> (will play if nobody steps in)` (:839); `'🗓 Squad update'`, `'☀️ Squad update'` (:902, :917); the format-switch line pasted verbatim | `enforceProximity` :768 (rewrites `*Playing ...:*`, "tonight", "this evening", "tomorrow" with `DAY_PREPOSITION` :724); fence strip; `max_tokens` discard | 4 fallbacks in bot-scheduler.ts (rows 72, 4, 74, 75); `pre-kickoff-full` has no caller since 2026-04-21 |
| 121 | DM Q&A | dm-qa.ts:28 `SYSTEM_PROMPT`, entry :162, call :217 | claude-sonnet-4-5 (inline literal at :218) | DM | a free-text answer, sent verbatim | `buildScopedContext` :76: org, `format(date, "EEE d MMM 'at' HH:mm")` plus literal `(UK time)` at :121 (bare `format`, so UTC), venue, `Squad: n/max confirmed`, names, season stats, `formatRecentHistoryBlock` (en-GB dates) | `"No number on record: Aaron, Idris."`, `"Everyone has a number on record 👍"` (:35); refusal `"I can only help with <group> match stuff 🙂"` (:37); style line (:47). Nothing about language | `max_tokens` discard only | `APOLOGY` :223 (row 111). Pre-gate `looksLikeQuestion` :248 is an English word list, so a Turkish question never reaches the model |

The batch answers in `src/lib/pipeline/answer-batch.ts` are NOT
model-composed: the question extractor picks a topic and `compose.ts`
renders the answer deterministically (rows 6 to 30). That is better news
than the brief assumed: the "answer composers" are already string-table
material.

Route-authored deterministic strings (`src/app/api/whatsapp/analyze/route.ts`):

| # | file:line | Audience | Shape |
|---|---|---|---|
| 122 | :721 | DM | `📊 Hey {first}, here are your MatchTime stats ... Link works for 48h.` (fallback "there") |
| 123 | :2687 | GROUP | `Couldn't do that right now.` |
| 124 | :2689 | GROUP | `📣 On it, DM'd {n} recent player/players ... I'll add anyone who taps in. 🙏` |
| 125 | :2705 | GROUP | `Already pinged the recent players for *{match}*, just waiting on their replies. 🙏` |
| 126 | :2707 | GROUP | `No new players to ask for *{match}* right now. 👍` |
| 127 | :3681 | GROUP | `sheet()` team block (`*{label}*`, numbered names) |
| 128 | :3690 | GROUP | `Both *{A}* and *{B}* are already in, nobody's dropped. Teams aren't generated yet; say *generate teams* ...` |
| 129 | :3711 | GROUP | `🔁 Swapped *{A}* and *{B}*, nobody dropped. Updated teams:` |
| 130 | :3744 | GROUP | `🔁 *{to}* takes *{from}*'s place on *{team}*, same teams otherwise ...` |
| 131 | :3865 | GROUP | `🎨 Swapped the colours, same teams, sides flipped:` |
| 132 | admin-ops-engine.ts:144 | DM | `composeReminderDm`: `⏰ Reminder, {first}, you asked me to nudge you: _{note}_ (reply in the group when you're ready 👍)` |
| 133 | admin-ops-engine.ts:162 | GROUP | `composePaymentAck`: `💳 Got it, credited *{payer}* with {names} for *{match}*. Unpaid: {n}/{m}.` + ignored-names note |
| 134 | team-ops-engine.ts:95, :99, :111 | GROUP | `TEAM_OPS_NO_MATCH_REPLY`, `composeBalancerRefusal` (`Can't build teams right now, {reason}.`), `composeGenerateTeamsReply` (4 italic notes: `_Including {names} as CONFIRMED per the request._` ...) |

Onboarding and help (`src/lib/onboarding-conversation.ts`, group-facing,
about 48 strings; Phase 3):

| # | file:line | Shape |
|---|---|---|
| 135 | :240 `BOT_ADDED_INTRO_FEATURES` + :251 `BOT_ADDED_INTRO_CHOICE` = :259 `BOT_ADDED_INTRO` | 7 feature paragraphs + `*Want me to run this group?*` + `• *YES*` / `• *EVERYTHING*` / name the bits + `Not for you? Just ignore me ... 🤐`. Read back by `parseBundleReply` (onboarding-parse.ts:48, an English yes-list). |
| 136 | :139 `INTRO` | legacy setup opener, 5 bullets |
| 137 | :956 `nextEventQuestion`, 7 questions | `👋 Let's get MatchTime set up ... what should I call your club/group?`, players per side, `Which *day of the week*`, `What *kickoff time*? (e.g. 9:30pm)`, venue, weekly or one-off, date. Answers parsed by onboarding-parse.ts (English day words :290). |
| 138 | :220 `ADMIN_QUESTION`; onboarding-parse.ts:505 `detailsFollowUpQuestion` | `Who else helps run this group? ... say *just me*`; `One thing I need: *when and where do you play?* ...` |
| 139 | :988 `featureMenuText` | numbered menu + `Reply with the ones you want, e.g. "Man of the Match and player ratings", "everything", or "all except payments".` |
| 140 | :1177, :1376 completion | `✅ *All set!* ...`, `📅 First match: *{Thursday} {21:00}* at *{venue}*` (`DOW` :128 hardcoded English day names), `say *"in"* when you're playing`, `*How to use me* 👇` |
| 141 | :172 `buildHowToUseMe`, 13 feature-gated lines | `✅ Say *"In"* or *"Out"*`, `🤔 Not sure? Just say *"maybe"*`, `💬 Tag *@Match Time*`, `🤐 I stay quiet the rest of the time`, `Type *"@Match Time help"* any time to see this again.` |
| 142 | :297 `HELP_EXPLAINERS`, 6 topics | ratings, teams, mom, availability, reminders, payments; each quotes commands back (`@Match Time swap Sam and Alex`, `@Match Time show the teams`, `@Match Time remind me Thursday`, `@Match Time who still owes?`). Topic aliases :334 (16 English words), `HELP_RE` at analyze/route.ts:954. |
| 143 | :401 `buildHelpReply` | `That one isn't switched on for this group. Type *@Match Time help* to see what is.`; `ℹ️ *MatchTime help*, here's what I can explain. Tag me with one of these:`; `• *@Match Time help {topic}*, {label}` |

The Raspberry Pi composes exactly one string of its own
(`whatsapp-bot/src/index.ts:467`, a DM: `Hey 👋 I can only read text
replies for the check-in ...` with three English answer bullets); every
other Pi send is server text passed through, and there is no model call
on the Pi. `whatsapp-bot/src/messages.ts` holds five English builders
with no importer (dead code).

**Reactions (language-free, nothing to translate):** 9 distinct outbound
emoji. ✅ sender's own row confirmed (engine.ts:2490, route.ts:2480), 🪑
own row benched (engine.ts:2491), 👋 own row dropped, also the help ack
(engine.ts:2492, route.ts:980), 👍 a third-party claim applied or a score
recorded (engine.ts:2489, :1792), 📊 stats link DM'd (route.ts:734), 📩
answered by DM (route.ts:846), ⚽ teams generated (team-ops-engine.ts:328),
🤔 team op refused (team-ops-engine.ts:277), 👀 balancer route with teams
already present (answer-batch.ts:1258). The Pi applies whatever the server
chose and picks none of its own. **The only prose that explains a
reaction to a group is one clause in the intro (bot-scheduler.ts:411, "I
react with 👍 to confirm"), and it is wrong**: the engine gives ✅ / 🪑 /
👋 for the sender's own row and 👍 only for third-party claims. Fix the
sentence in both languages when the intro is translated.

### 1.5 Emails

Three templates in `src/lib/email.ts` (verification :10, rating emails
:58, health alert :139). Owner-facing or web-account-facing; out of
scope, counted only.

### 1.6 Totals

| Mechanism | Distinct templates | Rendered variants (approx.) | Phase |
|---|---|---|---|
| Deterministic composers, group (1.1) | 66 | 85 | 2 |
| Scheduler static templates, group (1.2) | 15 | 20 | 2 |
| Route-authored and engine notes, group (1.4, 122 to 134) | 13 | 16 | 2 |
| LLM-composed (1.4, 120 to 121) | 2 paths (5 chase kinds + DM Q&A) | n/a | 2 (chase), 3 (DM Q&A) |
| DMs (1.3), excluding the 2 owner-facing | 36 | 58 | 3 |
| Onboarding and help, group (1.4, 135 to 143) | about 48 | about 48 | 3 |
| Pi-composed | 1 | 1 | 3 |
| Owner-facing (operator note, health alert, emails) | 2 + 3 emails | | stays English |
| Reactions | 9 emoji | | nothing to do |
| **Total user-facing** | **about 185 templates** (about 120 group, about 65 DM) | **about 230** | |

Two of the 185 are model-composed; 183 are template literals in
TypeScript with no indirection of any kind. There is no message
catalogue, no locale column, no snapshot test, and the guards that police
the bot's own output are English regular expressions (14 of them, section
4.3). Inbound, about 45 English keyword lists and regexes sit outside
Phase 1 (section 2).

## 2. Inbound vocabulary that is not Phase 1

Phase 1 covers the router and the attendance extractor (the messages a
player sends to the group about playing). Everything below is a
different inbound seam: a deterministic allowlist sitting behind a DM or
a group post that told the user to type a specific English word. Each
one either needs a Turkish vocabulary or is already read by a model.

| Seam | file:line | What it reads today | Turkish vocabulary needed? |
|---|---|---|---|
| Fee confirmation (collector DM) | fee-confirm.ts:236 `YES_WORDS` (46 phrases: y, yes, yep, ok, send, go ahead, approved ...), :257 `NO_WORDS` (31: no, nope, cancel, wait, hold on, not yet ...), :226 emoji sets, :290 `anchoredFeeReply` (emoji stripped, remainder must be empty or an exact member) | **Yes**: evet, tamam, gönder, onay, olur, hadi / hayır, yok, bekle, iptal, dur, şimdi değil. The allowlist is anchored on purpose (`fix/fee-confirm-anchored-allowlist`), so the Turkish list must be as short and as literal. The model fallback `FEE_REPLY_SYSTEM_PROMPT` (:324) quotes row 98's English wording and 14 English examples; it needs the Turkish prompt text too. |
| Fee amount (collector DM) | payments.ts:113 `parseFeeReply` (`£?\d+`, total markers "total, split, altogether, the pitch"), payment-flow.ts:200 `looksLikeFeeAmount` (`each, pp, per head, quid, pounds ...`) | **Yes, small**: "kişi başı", "toplam", "bölüşelim", "8 pound", "£8". Currency stays GBP. |
| Bench prompt answers (group and DM) | bench-prompt-answer.ts:114 `FILLER` (mate, bro, cheers ...), :157 `YES_LEAD`, :158 `NO_LEAD`, :161 `YES_CORE` (yes, ok, in, count me in, take it, deal ...), :188 `NO_CORE` (no, nah, can't make it, pass, out, next time ...), :84 emoji | **Yes**: evet, tamam, varım, alırım, ben / hayır, yok, olmaz, gelemem, geçiyorum, bu sefer değil. Emoji sets are language-free. The fast path in dm-reply/route.ts:144 duplicates a shorter list inline and needs the same words. |
| Tentative follow-up answers (DM) | dm-reply/route.ts:415 inline lists (in, i'm in, count me in, yes / out, can't make it, no ...), then `match-availability-classifier.ts` (LLM, closed enum in / out / unclear) | **Yes for the fast path** (varım, geliyorum, evet / yokum, gelemiyorum, hayır); the classifier is model-read and needs only a language line. |
| DM self-attendance ("IN" by DM) | dm-self-attendance.ts:84 `LEAD`, :87 `TAIL` (includes English weekday names), :90 `IN_CORE`, :100 `OUT_CORE` | **Yes**: same vocabulary as the Phase 1 floor (varım, ben varım, geliyorum / yokum, gelemiyorum, ben yokum), plus Turkish weekdays in `TAIL` (pazartesi ... pazar). Share one `vocab.tr.ts` with the router floor so the two never drift. |
| DM subscription commands | dm-subscriptions.ts:49 (stop, unsubscribe, no more, mute / start messages, start ratings, resume, opt in ...) | **Yes**: dur, durdur, mesaj atma, artık yazma / başlat, tekrar gönder, açık. Row 99's acks quote these commands, so copy and parser move together. |
| DM intent (admin DMs: blast, questions) | dm-intent.ts (model-classified since 2026-09-11) | **No**: model-read; a language line only. |
| DM Q&A gate | dm-qa.ts:248 `looksLikeQuestion` (ack words "ok, thanks, cheers"; question words "when, where, who, what, how, kickoff, venue, squad, score ...") | **Yes, small**: ne zaman, nerede, kim, kaç, saat kaçta, kadro, skor, maç; ack words tamam, sağol, teşekkürler. Without it a Turkish question is dropped as an ack. |
| Roster survey replies | roster-survey-classifier.ts (LLM, closed enum) | **No**: model-read. Row 109's menu ("yes / I'm in, maybe / sometimes, not for now / out") must match the Turkish prompt's examples. |
| Recruit invite replies | recruit-reaction.ts:76 `IN_EMOJI` / `OUT_EMOJI`; text replies go through the DM self-attendance seam | emoji: none. Text: covered above. |
| "@Match Time help <topic>" | interaction-contract.ts:68 `messageTagsBot` (`@match time`, `matchtime`, `@mt`); topic words in onboarding-conversation.ts (see 1.4) | **Yes**: the tag itself is JID-based on the Pi (`mentions.ts:158`, `Contact.isMe`), so "@Match Time" works in any language. The word "help" and the topic names ("teams", "bench", "ratings" ...) are English; add "yardım" and Turkish topic aliases. |
| "@MatchTime setup" | analyze/route.ts:383 (the Phase 2 onboarding trigger) | **Yes, one word**: "kurulum". Not for Friday (self-onboarding is NO-GO anyway). |
| `swap X Y` and colour swaps | team-slot-swap.ts:174 `parseSwapNames` (`swap|switch` + connectors `with|and|for|&`, English STOP words), analyze/route.ts:3801 `hasSwapVerb` (`swap|switch|flip|reverse|invert|change`, a hard pre-gate), :3829 the custom-label branch (needs the literal English `swap` before it can see the org's labels), extractors.ts:166 teams prompt (never receives `teamLabels`) | **Yes**: verbs "değiştir", "takas", "yer değiştir"; connectors "ile", "ve"; and the teams extractor must be handed the org's labels so "Ali'yi Kırmızı'ya al" maps to RED. Today "swap Ali Kırmızı" fails (the parser looks for a player called Kırmızı) and "Kırmızı ile Sarı'yı değiştir" is refused at the verb gate. |
| Team colour names | `resolveTeamLabels` (team-labels.ts:29): outbound works with any labels; inbound score reading is positional (extractors.ts:173, "first team mentioned"), MoM votes are by player id | **Data, not code**: set `Organisation.teamLabels = ["Kırmızı", "Sarı"]` on the settings page. Scores work in either language as long as the RED-slot team is named first (already the case in English). |
| Reminder time phrases | reminder-time.ts:83 `WEEKDAYS`, :93 `PARTS_OF_DAY` (morning 9, afternoon 14, evening 18, tonight 20), "tomorrow", "in a week" | **Yes** if reminders are on: pazartesi ... pazar, sabah, öğleden sonra, akşam, yarın, haftaya. Off for Erdal in week one (section 5). |
| Guest-name ask singular/plural | guest-name-ask.ts:67 `DETERMINED_NOUN`, :121 `PERSON_CUE` + `AVAILABILITY_CUE` (17 English phrases), :368 `PLURAL_RE` | **Yes, but Phase 1-adjacent**: these decide whether "+1 arkadaşım" is a guest offer at all, and which copy variant to send. Belongs with the reading work, flagged in section 7. |
| Interaction contract heuristics | interaction-contract.ts:421 `looksLikeHypotheticalOrPast` (English tenses), :443 `THIRD_PARTY_NOUN` (brother, mate ...), `FIRST_PERSON` | **Yes, Phase 1-adjacent**: a Turkish "kardeşim de geliyor" has no "brother" to match. Flagged in section 7 for the reading agent. |
| Output guards reading the bot's own words | group-copy.ts:126 `isLeaderboardLine`, :146 `displaysSquadState`, :192 `MOVE_CLAIM_PATTERNS`, :244 `contradictsSquadState`; message-analyzer.ts:640 `enforceProximity`, :727 `replaceRelativeDay` | **Yes**: covered in 4.3. Not vocabulary a user types, but English the code must recognise in Turkish output. |

## 3. Locale-sensitive formatting

| Concern | Today | For Turkish |
|---|---|---|
| Timezone | `src/lib/london-time.ts:14` hardcodes `Europe/London`; `reminder-time.ts:52` duplicates it. No org or activity carries a timezone (checked `prisma/schema.prisma`). | Unchanged. Erdal's club plays in London. Locale and timezone are separate axes; only locale moves. |
| Date patterns | date-fns via `formatLondon(d, pattern)`: `EEE d MMM` (rating DM, promo, follow-ups), `EEEE d MMMM 'at' HH:mm` (announce), `EEE d MMM, HH:mm` (recruit, DM acks), `EEE HH:mm` (`state.kickoffLabel`, load-state.ts:210, the pipeline's single label), `HH:mm` everywhere else. Plus three hand-rolled `Intl.DateTimeFormat("en-GB", ...)` sites: squad-announce.ts:47, message-analyzer.ts:317 and :327 (`londonDayLabel` / `londonTimeLabel`), match-history.ts:324. | One `dates.ts` in `src/lib/i18n/` with `dayLabel(lang, d)`, `dayTimeLabel(lang, d)`, `longDayTimeLabel(lang, d)`, `timeLabel(d)`; date-fns takes `{ locale: tr }` and renders `Sal 15 Eyl`, `Salı 15 Eylül`. The literal `'at'` inside patterns becomes part of the per-language function (Turkish writes "15 Eylül Salı 21:30" or "Saat 21:30"). The three `Intl` sites move to the same helper so there is one formatter, not four. |
| Five sites use bare `format()` (server zone, UTC on Vercel) instead of `formatLondon` | dm-qa.ts:121 (appends "(UK time)" to a UTC time), match-completion.ts:92, player-stats.ts:283, whatsapp/status/route.ts:51, whatsapp/teams/route.ts:62 | A real defect, not an i18n one. Fix while touching the formatter. |
| Times | 24h `HH:mm` everywhere | Same in Turkish. |
| Currency | `gbp()` (payments.ts:129, "£8" / "£8.50"), duplicated at fee-confirm.ts:507 and payment-roster.tsx:19; `£` regex inbound; `stripe.ts:150` `currency: "gbp"`; literal "£8 each" examples in the fee ask and the classifier prompt | Stays GBP (a London club). The Turkish strings write "£8" the same way; only the surrounding words change ("kişi başı *£8*"). No `Intl.NumberFormat` needed for two languages and one currency. |
| Team labels | `resolveTeamLabels` (team-labels.ts:29): Match, then Organisation, then Sport, then "Red" / "Yellow". Editable at `/admin/settings` (page.tsx:246, action org.ts:295, sanitised to 24 chars, no zod). Sport presets carry "Red"/"Yellow", "Home"/"Away", "Shirts"/"Skins". | Data: Erdal's org sets `["Kırmızı", "Sarı"]` at onboarding. The Sport preset table stays English (it is a library the admin edits); `Sport.mvpLabel` ("Man of the Match") is the same kind of per-org free text and is set to "Maçın Adamı" the same way. Inbound colour words: see section 2. |
| First-name extraction | No shared helper: compose.ts:91 `firstName` (fallback "a player"), attendance-write-outcome.ts:57, bench-upgrade-ack.ts:44, guest-name-ask.ts:376, identity.ts:81, plus about 13 inline `.split(" ")[0]` with fallbacks "there" and "mate" | One `firstName(name)` in `name-normalise.ts` used by every composer; the fallback word comes from the string table (`s.fallback_player`, `s.fallback_vocative`). Turkish pushnames split on space the same way. |
| Name matching and case | `normaliseName` (name-normalise.ts:29) NFD-strips diacritics then lower-cases, so ı/İ/ş/ğ/ç/ö/ü fold; the guards' `statusOfClaimedName` uses plain `toLowerCase()` on both sides | Consistent as long as both sides use the same fold. Add a unit test with "İlkay", "Işık", "Çağrı" to pin it; any new lower-casing in guard vocabulary uses `toLocaleLowerCase("tr")`. |
| Pluralisation | No helper; about 20 inline ternaries (`player/players`, `slot/slots`, `is/are`, `goes/go`, `person was/people were`, `match is/matches are`, `vote/votes`, `win/wins`) | Inside the per-language functions. Turkish has no plural after a numeral ("3 oyuncu") and no is/are agreement, so the Turkish entries are simpler than the English ones. |
| List joining | `joinList` (compose.ts:104, "A, B and C"), `joinNames` (attendance-write-outcome.ts:65, same), format-switch.ts:109 ("A + B"), mom-announcement.ts:40 ("A & B") | `joinList(lang, names)` in `i18n/dates.ts` (or a `text.ts`): Turkish "A, B ve C". The "+" and "&" house styles stay as they are, they are language-free. |
| Ordinals | One site, app/actions/payments.ts:231 (`do MMMM`, a Stripe description) | Out of scope. |
| Time-of-day words | "tonight" (bot-scheduler.ts:367, :1050, :1324, :1534, :1556; group-copy.ts:419), proximity buckets and `friendlyDay` (message-analyzer.ts:706), `replaceRelativeDay` + `DAY_PREPOSITION` (:727, an English preposition engine) | "bu akşam", "yarın", "{gün}" from the table; `replaceRelativeDay` is English grammar and cannot be translated, only bypassed: for `lang !== "en"` the model is told the day label and the header up front and the rewrite pass is skipped (section 4.3). |
| Emoji semantics | The only prose that explains an emoji: out-of-band-attendance.ts:78 ("👍 on their invite", "gave a 👍") and the flag-gated bench copy ("react 👍 here"). ✅ / 🪑 / 🥁 reactions and slot markers are never explained in words. | Those two sentences translate; the glyphs do not. The intro post explains "I react with 👍 to confirm", which is a translated sentence too. |

## 4. Decisions

### 4.1 Where does language live? `Organisation.language`

**Recommendation: one column, `Organisation.language String @default("en")`,
holding a lowercase ISO 639-1 code, validated by a zod enum of the
languages the string table actually ships (`"en" | "tr"` today). Set at
onboarding, editable on `/admin/settings` next to the team labels.**

Per-org, not per-group, because an org has exactly one WhatsApp group
today (`Organisation.whatsappGroupId` is a single nullable string) and
every scheduler job, DM and composer is already keyed on the org. If a
second group per org ever exists it will need its own row for the group
id first, and the language can move with it then. Per-Activity is wrong:
a Turkish group that runs two fixtures does not switch language between
them.

Not a `User.language`. Every DM the bot sends is on behalf of one org to
a member of that org; a bilingual player in a Turkish group should get
Turkish. A per-user override can be layered later without touching the
composers, because every composer will take a `lang` value, not a user.

Not a timezone. Erdal's group plays in London; every date and time stays
`Europe/London` (`src/lib/london-time.ts` is hardcoded to it and that is
correct for both live clubs). Locale (what the date LOOKS like) and
timezone (what the date IS) are separate decisions, and only the first
one is on the table.

**How the pipeline gets it.** Follow the features path exactly:

- `src/lib/org-features.ts` `SELECT` gains `language: true`, `fromRow`
  maps it, `OrgFeatures` gains `language: Lang`, `ALL_OFF` uses `"en"`.
  `loadSquadState` (`src/lib/pipeline/load-state.ts:31`) already calls
  `getOrgFeatures` once per batch and stores the result on
  `SquadState.features`, so the engine and `compose()` read
  `state.features.language` with no extra query. `load-state.ts` has a
  comment about avoiding "an extra findUnique"; this adds none.
- The scheduler (`src/lib/bot-scheduler.ts`) and the DM senders select
  the org row themselves; each adds `language` to its `select`.
  `composeChaseText` (`src/lib/message-analyzer.ts:439`) selects
  `{ id, name, teamLabels }` and gains `language`.
- A single `Lang` type and a `normaliseLang(raw: string | null): Lang`
  helper live in a new `src/lib/i18n/lang.ts` (client-safe, no Prisma,
  same reason `org-features-meta.ts` is split from `org-features.ts`).
  Anything unknown normalises to `"en"`, so a bad value in the column
  can never produce a blank message.

Migration: one additive column with a default, applied the way every
other org column was (the "strictly additive schema" convention the
feature flags cite in `org-features.ts`). Sutton FC gets `"en"` by the
default and nothing about its rows changes.

### 4.2 Templates versus LLM for output: a typed string table

**Recommendation: a per-language string table for every deterministic
composer, a language instruction plus language-aware server-computed
headers for the LLM-composed chases and answers, and the composition
guards taught the vocabulary of each language they guard. Never
LLM-translate a template at send time.**

Shape:

```
src/lib/i18n/
  lang.ts          Lang, normaliseLang, DEFAULT_LANG = "en"
  strings.en.ts    export const en = { squad_status_lead_short: (p) => `...`, ... }
  strings.tr.ts    export const tr: Strings = { ... }   // the owner reviews THIS file
  t.ts             export type Strings = typeof en; export function t(lang): Strings
  dates.ts         dayLabel(lang, date), timeLabel(date), joinList(lang, names)
```

- Keys are typed from the English table (`type Strings = typeof en`).
  `strings.tr.ts` is declared `const tr: Strings`, so a key missing from
  Turkish is a `tsc` error and the build fails. That is the "missing key
  fails the build" rule, with no runtime machinery.
- Every entry with parameters is a FUNCTION `(p) => string`, not a
  `"{name}"` interpolation string. Turkish attaches case suffixes to the
  thing it names ("Salı'ya", "Sim Arena'da") and vowel harmony decides the
  suffix, so a placeholder dropped into a fixed sentence is wrong for
  half the venues and names. A function lets the native speaker write
  the sentence so the interpolated value sits in a suffix-free position
  ("Yer: Sim Arena", "Saat: 21:30"), which is how Turkish announcements
  are written anyway. English keeps its current wording byte for byte.
- English plurals ("1 slot open" / "2 slots open", "player" / "players")
  move inside the English functions; Turkish does not pluralise after a
  number ("3 oyuncu"), so the Turkish functions are simpler, not harder.
- `t(lang)` returns the whole table; a composer does
  `const s = t(state.features.language)` once and reads `s.key(...)`.
  Unknown languages fall back to English through `normaliseLang`; a
  known language never falls back per key, because the type system has
  already proven the key exists.

Why this and not LLM translation at send time:

1. It would undo §6.4. The deterministic composers exist so that
   "numbers and names are never model-authored, so they cannot be wrong,
   so nothing needs to check them afterwards" (`src/lib/pipeline/compose.ts:4`).
   A model asked to translate "*8/14*, need *6 more*" can and will
   occasionally write 7, and the five regex post-processors that were
   deleted on 2026-09-06 would have to come back, in Turkish.
- It is non-deterministic. The sim suite asserts on substrings of
  `composeSquadStatusPost` and `formatTeamsPost` ("keep the output
  byte-stable: the sim suite asserts on its substrings",
  `src/lib/group-copy.ts:57`). A translation that varies run to run
  cannot be tested that way, and cannot be reviewed by the owner once
  and trusted.
- It fails open to English. A model error on the translation call has
  only one sane fallback, the English template, which is the exact
  outcome the feature exists to prevent, delivered silently.
- It costs a model call on every scheduled post and every DM, for text
  that changes maybe twice a year.
- The owner cannot review what is generated fresh each time. With a
  file he reviews thirty Turkish sentences once.

The LLM is still the right tool for DRAFTING `strings.tr.ts`; a model
writes the first Turkish draft, the owner corrects it, the file is
committed. That is translation at build time by a human, which is the
thing send-time translation only imitates.

### 4.3 The LLM-composed paths: what actually has to change

The chases (`composeChaseText`, five `ChaseKind`s) and the batch answers
(`src/lib/pipeline/answer-batch.ts`) let a model write the human half. To
make them speak Turkish, three seams change, none of them the prompt's
rules:

1. **A language instruction in the UNCACHED tail.** `CHASE_SYSTEM_PROMPT`
   (`message-analyzer.ts:823`) and the Match Context are cached for one
   hour with `cache_control`; the per-kind compose prompt
   (`buildChaseComposePrompt`, `:886`) is not. The line "Write the
   message in Turkish. Names stay as written. Copy the roster header and
   the bench header exactly as given" goes in the tail, so the cached
   prefix stays identical for both languages and Sutton's cache is
   untouched. (A per-language system prompt would also work, at the cost
   of one more cache entry; the tail is simpler.)
2. **Server-computed headers come from the string table.** The model is
   ordered to copy `Use roster header:` and `*Bench (N):*` verbatim; they
   are computed in `buildMatchClockBlock` (`:352`) and `computeProximity`
   (`:659`), both hardcoded to "*Playing tonight:*", "*Playing
   tomorrow:*", "*Playing Tue 15 Sep:*", "*Squad:*". Those become
   `s.roster_header_tonight` etc., so a Turkish chase copies a Turkish
   header the server chose. The format-switch line the model must paste
   "character-for-character" comes from `buildFormatSwitchFacts` and
   moves to the table for the same reason.
3. **The guards learn the vocabulary they guard.** Three functions read
   the model's output back through English words:
   - `enforceProximity` (`message-analyzer.ts:~640`): rewrites
     "*Playing <anything>:*" and a loose "tonight" / "this evening" in
     the lead to match the real proximity.
   - `displaysSquadState` (`src/lib/group-copy.ts:145`): rule (a), a run
     of two or more numbered lines, is language-neutral and catches the
     roster itself; rules (b) and (c) key on `*Playing`, `*Squad`,
     `*Bench (N)`, `N/M` plus "squad|bench|slot|full|need|player", and
     "bench is empty".
   - `contradictsSquadState` (`group-copy.ts:239`): the move-claim verbs
     ("goes on the bench", "is now in", "dropping X"), "need N more",
     "full squad", "N slots open".
   Each takes `lang` and reads its vocabulary from a per-language
   `guard-vocab` entry in the same table (headers, the need/full/slot
   phrases, the move verbs). For Turkish the move-claim list will be
   thinner at first; the protection that matters most, "a numbered
   roster the model wrote is replaced by the database's", is rule (a)
   and needs no words.

There is a cleaner option for the chases that removes seam 3 for them
entirely: stop asking the model for the roster block at all. The analyze
path already works that way (the model writes the lead and emits
`[SQUAD]`, `composeSquadStateReply` appends the database's post). If the
chase composer did the same, the model would write only the lead in the
group's language and the roster, bench and headers would come from
`composeSquadStatusPost` via the table. That is a behaviour change for
Sutton too (the chase roster would be byte-identical to the squad post
instead of model-typed), so it is proposed as Phase 2b, measured with
`CHASES=1 REPEAT=15` in both languages, and not bundled into the
language work.

The batch answers (`answer-batch.ts`) get the same tail instruction. Their
static fallbacks move to the table.

### 4.4 Who writes the Turkish strings, and how they are reviewed

The owner is a native speaker and reviews exactly one file,
`src/lib/i18n/strings.tr.ts`, in a PR whose diff is that file plus the
Turkish snapshot output (section 4.5), so every sentence is seen both as
source and in context with real names and numbers.

Conventions the file must follow, written at its top:

- WhatsApp formatting, not markdown: bold is `*single asterisks*`, no
  headings, no backticks except for literal commands the user should
  type (`swap X Y` stays a backtick because it is typed).
- Keep the emoji the English copy uses in the same positions (📋, 🙏, ✅,
  🥁, ⚽, 🪑); the group learns them once and they are language-free.
- **Register: warm-informal, "sen" in DMs, plural imperatives in the
  group.** A DM is one person talking to one person and the club chat
  is on first names, so "sen" ("puanını ver", "linkin aşağıda") reads
  right and "siz" reads like a bank. A group post addresses everyone at
  once, so it uses the plural imperative ("yazın", "haber verin"), which
  is grammatically the siz-form but reads as "all of you", not as
  formality. The bot does not say "abi" or "beyler": that is the
  players' register with each other, and a bot adopting it reads as
  trying too hard, and assumes a gender the roster may not have. The
  owner can overrule any of this in the file; the point is that it is
  decided once.
- Interpolated values (names, venues, dates, counts) sit where Turkish
  needs no suffix on them: "Yer: Sim Arena", "Maç: Salı 15 Eylül", not
  "Sim Arena'da". Where a suffix is unavoidable the function computes it
  from the last vowel (a small `suffix.ts` helper, tested), never a
  fixed guess.
- No time-of-day greeting and no send-time stamp (section 4.5); in
  Turkish that means no "Günaydın", "İyi akşamlar", "17:00 güncellemesi".
- Dotted and dotless i: any lower-casing of Turkish text for matching
  must use `toLocaleLowerCase("tr")`; `"İlkay".toLowerCase()` produces
  "i̇lkay" with a combining dot and `"I".toLowerCase()` produces "i",
  which breaks name comparison and the guard vocabulary. The guards'
  name matching (`statusOfClaimedName`) lower-cases both sides the same
  way today so it stays consistent, but any NEW regex must be written
  with this in mind, and the string-table tests assert it.

### 4.5 Testing

1. **Pin English first, on its own PR, before any refactor.** A vitest
   file renders every deterministic composer (each function in the
   inventory) against three fixed fixtures (short squad with bench,
   full squad, teams generated) and writes them to
   `src/lib/i18n/__tests__/__snapshots__/copy.en.snap` with
   `toMatchSnapshot`. That snapshot is generated on `main` as it is
   TODAY and committed. The string-table PR then has to keep it
   byte-identical, and CI proves it. This is the test that makes the
   risk to Sutton zero rather than "we were careful".
2. **Per-language snapshots.** The same renderer runs for `"tr"` and
   commits `copy.tr.snap`. That file is the owner's review artefact in
   context; it changes only when a Turkish string changes.
3. **Completeness and hygiene.** `strings.test.ts`: every key in `en`
   exists in every other table (belt and braces over the type check,
   and it catches an `any`); no entry returns an empty string; every
   parameterised entry uses each of its parameters at least once; no
   entry contains a time-of-day greeting or a send-time stamp in either
   language (the `no-time-of-day-greeting` list gains its Turkish
   words); no entry contains an em dash.
4. **Live Turkish dry runs for the LLM paths.** `scripts/dryrun-pipeline.ts
   CHASES=1` composes the five chase kinds against live state and checks
   them (doubled prepositions, kickoff time once, kickoff present where
   required). It gains `LANG=tr` (or reads the org's column) and a
   Turkish check set: the roster header equals the table's, no English
   token from a short blocklist ("Playing", "Bench", "need", "tonight",
   "squad"), no send-time stamp, no greeting. Run with `REPEAT=15` per
   kind and report counts, per the playbook ("Report counts, 0 of 15,
   never it works", `MDs/llm-pipeline-testing-playbook.md:56`). The
   answer paths run through the corpus `QUESTIONS=1` mode the same way.
5. **The guards get Turkish fixtures.** `group-copy.test.ts` gains the
   Turkish equivalents of every English case: a model-written Turkish
   roster is detected and replaced, a Turkish "3 kişi daha lazım" that
   disagrees with the rows is caught, a Turkish stats answer is left
   alone.
6. **The sim suite stays green with Sutton as `"en"`**, and one sim spec
   creates a `"tr"` org and asserts the squad post and teams post bytes.

### 4.6 Rollout and rollback

Language is one per-org field. Sutton FC keeps `"en"` (the column
default, no data migration touches it) and, by the snapshot in 4.5, every
English string is the same bytes before and after. A Turkish org is
flipped to `"tr"` by the admin settings page or one `UPDATE`, and flipped
back to `"en"` the same way; nothing is cached per language except the
model's prompt prefix, which is keyed on content and needs no
invalidation. A wrong Turkish string is fixed by editing one file and
deploying; no data changes.

## 5. Phasing

Effort is in agent-hours (an Opus subagent working TDD, red then green,
with the main session reviewing). Every phase is its own PR or PR series
against `main`. Sutton FC is `"en"` throughout and the English snapshot
from Phase 0 must be byte-identical at the end of every phase; that is
the acceptance test that never changes.

### 5.0 Phase 0: pin English, add the column, plumb it (3 to 4 agent-hours)

Ships before any string moves. Zero behaviour change.

1. `src/lib/i18n/__tests__/copy-golden.test.ts` renders every
   deterministic builder in sections 1.1 to 1.4 (rows 1 to 66, 67 to 81,
   122 to 134, and the DM builders in 1.3 that are pure functions) against
   three fixtures and commits `copy.en.snap`. Red: the file does not exist.
   Green: generated from `main`. This is the byte-identity proof for the
   whole programme.
2. `prisma/schema.prisma`: `language String @default("en")` on
   `Organisation`, with a doc comment in the style of `teamLabels`.
   Applied with `prisma db push` (this repo does not run
   `prisma migrate`, `MDs/skills.md:24`), so the DB-level default exists
   and the raw-SQL fixtures in `e2e/sim/group.ts:277` and
   `e2e/api/dormant-org-fixtures.spec.ts:96` keep working.
3. `src/lib/i18n/lang.ts` (`Lang`, `normaliseLang`, `LANGS` for the
   picker) and `OrgFeatures.language` plumbed through
   `org-features.ts` (`SELECT`, `fromRow`, `ALL_OFF`).
4. `/admin/settings`: a two-option select next to the team labels
   (`src/app/admin/settings/page.tsx:246`), saved by a new
   `setOrgLanguage` action beside `setOrgTeamLabels`
   (`src/app/actions/org.ts:295`), validated against `LANGS`.
5. `/api/org/settings` returns `language`.

Acceptance: `tsc` clean, `vitest` green including the new golden, e2e
green, Sutton's row reads `"en"` (read-only check), the setting round
trips on the settings page.

### 5.1 Phase 1: reading Turkish attendance (in flight, other agent)

Per `MDs/second-group-readiness-erdal-2026-09-16.md` section 2: a
language line in the router and attendance-extractor prompts with
Turkish worked examples, and a Turkish floor beside `FLOOR_IN` /
`FLOOR_OUT` (`router.ts:287`). Measured with `REPEAT=15` on the TR1 to
TR20 table before merge. Section 7 lists four reading-adjacent English
heuristics that agent should know about (`interaction-contract.ts`,
`guest-name-ask.ts`, `clause-peel.ts`, `bench-prompt-answer.ts`), because
they sit in front of or beside the router and are not prompts.

### 5.2 Phase 2: everything the bot says in the GROUP (16 to 24 agent-hours, 3 to 4 PRs)

Scope: rows 1 to 66, 67 to 81, 120 (the chase), 122 to 134. About 96
templates.

PR 2a, the table and the composers (8 to 10 h):
- `src/lib/i18n/strings.en.ts` holds every group string as a typed entry;
  the composers in `compose.ts`, `group-copy.ts`, `bench-offer-copy.ts`,
  `squad-announce.ts`, `mom-announcement.ts`, `format-switch.ts`,
  `format-switch-time.ts`, `out-of-band-attendance.ts`,
  `bench-confirmation.ts`, `unresolved-nudge.ts`, `guest-name-ask.ts`,
  `stats-blast.ts`, `block-booking.ts`, `attendance-write-outcome.ts`,
  `admin-ops-engine.ts`, `team-ops-engine.ts`, `app/actions/matches.ts`,
  the analyze route's ten literals and the scheduler's fifteen read
  from `t(lang)`. `dates.ts` replaces the four date formatters and the
  three list joiners. `firstName` becomes one helper.
- `compose()` takes `lang` from `state.features.language`; the scheduler
  and the routes take it from the org row they already load.
- Acceptance: `copy.en.snap` unchanged byte for byte; `strings.test.ts`
  green; the existing ~30 whole-message goldens and ~500 substring
  assertions untouched and green; e2e and sim green.

PR 2b, the Turkish table (3 to 4 h agent, 1 to 2 h owner):
- `strings.tr.ts` drafted by the agent, reviewed by the owner in one
  file with `copy.tr.snap` beside it. Conventions from 4.4 at the top of
  the file. Nothing else in the diff.
- Acceptance: owner sign-off on the PR; `strings.test.ts` proves
  completeness; the em dash check and the greeting check pass in Turkish.

PR 2c, the model path and the guards (5 to 8 h):
- `buildChaseComposePrompt` gains the language tail;
  `buildMatchClockBlock` and `computeProximity` read headers from the
  table; `enforceProximity` and `replaceRelativeDay` run only for
  `"en"` (for other languages the header is given and the rewrite is
  skipped; the day label is already in the lead because the tail tells
  the model to use it).
- `displaysSquadState`, `contradictsSquadState`, `isLeaderboardLine`
  take `lang` and read a `guardVocab` entry per language (headers,
  need/full/slot phrases, move verbs, leaderboard nouns). `CLAIM_NAME`
  becomes `\p{Lu}` (section 7, a bug today).
- `scripts/dryrun-pipeline.ts CHASES=1` gains `LANG=tr` and the Turkish
  check set from 4.5; run `REPEAT=15` per kind, report counts.
- Acceptance: `group-copy.test.ts` has a Turkish twin for every English
  case; live dry run counts reported for all five kinds in both
  languages, with the English run identical in behaviour to before
  (same headers, same fallbacks); the corpus `mustNotMatch` guards
  (`e2e/corpus/incidents.jsonl`) are given Turkish alternates so they do
  not pass vacuously.

PR 2d, optional (4 to 6 h): the chase composer asks the model for the
LEAD only and appends `composeSquadStatusPost` from the rows, in either
language. Removes the roster-copying instructions and `enforceProximity`
from the chase path entirely. A behaviour change for Sutton (the roster
block becomes byte-identical to the squad post), so it ships alone and is
measured alone.

Risk to the live English club: the golden snapshot, the existing
goldens, and the unchanged `"en"` guard vocabulary. The one place where
English behaviour could drift without a byte changing is the guards; the
Turkish twin tests are written by copying the English ones, so the
English ones are not touched.

### 5.3 Phase 3: DMs, onboarding, help, and the DM-side vocabulary (16 to 24 agent-hours, 3 to 4 PRs)

Scope: rows 82 to 119 (minus the two owner-facing), 121 (DM Q&A), 135 to
143, the Pi's one string, and every inbound seam in section 2 that is
not Phase 1. About 90 templates plus about 10 vocabulary lists.

PR 3a, DM copy (6 to 8 h): the scheduler DMs, `payment-flow.ts`,
`fee-confirm.ts` (the prompt that embeds row 98 must be built from the
same table entry, not a copy), `recruit.ts`, `recruit-chase.ts`,
`tentative-followup.ts`, `out-of-band-self-attendance.ts`,
`dm-subscriptions.ts`, `dm-qa.ts` (language tail + a Turkish
`looksLikeQuestion`), the dm-reply route's acks, the duplicated rating
DM in `app/actions/players.ts:809` collapsed into one builder, the Pi
string moved server-side or duplicated in the Pi's own tiny table (the
Pi has no access to the org row; simplest is for the server to hand it
the text, which is how every other Pi send works).

PR 3b, DM-side vocabulary (5 to 7 h): `vocab.tr.ts` shared with the
Phase 1 floor; `fee-confirm.ts` YES/NO lists per language;
`bench-prompt-answer.ts` normaliser rewritten to keep `\p{L}` and its
lists per language; `dm-self-attendance.ts` lists; `dm-subscriptions.ts`
command words; the tentative and bench fast paths in `dm-reply/route.ts`;
`reminder-time.ts` day and part-of-day words; the roster-survey dedupe
probe at `dm-reply/route.ts:927` changed from a text prefix to a
`BotJob.kind` (or a key), so it stops depending on English at all.
Acceptance: each list has a Turkish unit test mirroring the English one;
`scripts/dryrun-fee-confirm.ts` run in Turkish with `REPEAT=15`; the
`matchAvailability` and roster-survey classifiers dry-run on Turkish
replies with counts.

PR 3c, onboarding and help (5 to 8 h): `BOT_ADDED_INTRO`, the seven
setup questions, the feature menu, completion, `buildHowToUseMe`,
`HELP_EXPLAINERS` and the topic aliases; `parseBundleReply` and the
onboarding day/time parsers get Turkish words; "yardım" and "kurulum"
accepted. The intro's "I react with 👍 to confirm" sentence corrected in
both languages. Not needed for Friday: self-onboarding is NO-GO for
other reasons.

Risk to the live English club: same snapshot discipline; the vocabulary
lists gain entries under a `tr` key and the `en` lists are not edited.
The one structural change that touches English behaviour is the
`bench-prompt-answer.ts` normaliser (keeping letters instead of
`[a-z0-9]`); its English tests must stay green unchanged.

### 5.4 The Friday minimum, stated plainly

**Floor: Phase 1 plus Phase 0.** Erdal's group is provisioned by script
with `language = "tr"` set on the row (so nothing has to be migrated
later), Phase 1 reads their Turkish, and every word the bot says is
English. Turn OFF for week one: `featureBench`, `featurePlayerRating`,
`featureMomVoting`, `featureReminders`, `featureStatsQa`,
`paymentTrackingEnabled`, `paymentCollectionEnabled`. Keep ON:
`featureAttendance` and `featureTeamBalancing`. That removes every DM the
bot would send (bench offers, rating links, reminders, pay links) and
most English answers, and leaves the posts in section 6. The owner
pins one Turkish message in the group explaining the four things the bot
will say in English and what the ticks mean. Erdal accepts this in
advance, per the readiness doc.

Two things fire whatever the feature flags say and cannot be turned off
without code: the **bot intro** (row 67, `org-{id}:bot-intro`, fires on
the first scheduler tick after the org has an active activity, in
English, about 11 lines) and the **payment poll** (row 78, gated by
`Match.postMatchEndFlow`, not by the payment features). For the intro the
provisioning script sets the `org-{id}:bot-intro` SentNotification row
itself so it never posts (the owner's pinned Turkish message replaces
it). For the poll, set `postMatchEndFlow = false` on the first match in
the same script.

**Stretch: the week-one subset (section 5.5)**, only if Phase 1 merges
by Thursday morning. It costs about 6 agent-hours, 30 minutes of the
owner's review, two live dry runs, and one Vercel deploy. No Pi change:
all copy is server-side, and the Pi restart the new org needs anyway
(`scripts/deploy-pi.sh`, quiet hour) is the same restart either way.

If Phase 1 is not merged by Thursday morning, do not attempt the
subset; go with the floor and ship Phase 2 for the second Friday.

### 5.5 The week-one subset (about 6 agent-hours)

Phase 0 in full, plus a `strings.tr.ts` containing only these entries,
wired into their composers, with `copy.en.snap` unchanged:

| Row | What the group sees in week one | Why it is in the subset |
|---|---|---|
| 68 | announce-match | the first thing the group reads |
| 1 | `composeSquadStatusPost` | every squad-state reply, and the fallback shape the 17:00 post takes |
| 71, 72 | roster block and the 17:00 static fallback | the daily post |
| 120 tail + headers | the 17:00 chase in Turkish: language tail, `Use roster header:` from the table, `enforceProximity` skipped for `tr`, `displaysSquadState` rule (b) accepts the Turkish headers | the daily post when the model path works |
| 43 | squad complete | the moment the 14th "varım" lands |
| 2 | teams post | Friday evening |
| 39 | slot opened | a drop, the most common Friday event |
| 6, 7, 8 | count, squad, fixture answers | the three questions a new group asks |
| 44 | guest-name ask | "+1" is common; the ask must be readable |
| 74, 75, 76 | pre-kickoff fallbacks and the gear reminder | Friday afternoon |
| 4 | match-day fallback | Friday morning |

Fourteen entries, all group-facing, no DMs, no inbound vocabulary beyond
Phase 1. Everything not in the table stays English and is listed in
section 6 so the owner can tell Erdal exactly what to expect.

## 6. What the Turkish group sees on Friday with Phase 1 only

Assumptions: the org is provisioned by script on Thursday 17 Sep in the
afternoon, one Activity, Friday 21:00 kickoff (the real time is Erdal's
to confirm), 14 a side, a large group. Phase 1 has shipped, so the
group's Turkish is READ. Two columns: what happens with Sutton's feature
set (everything on), and with the trimmed set from 5.4. "Reacts" are
language-free in both.

| When | Event | Everything on (as Sutton) | Trimmed set (5.4) |
|---|---|---|---|
| Thu, first scheduler tick after the Pi restart | Bot intro (row 67) | 11 lines of English: "👋 Hi all, MatchTime bot is live for this group. Here's what I do: 🗓 Attendance, Say "IN" / "OUT" here ..." with every command quoted in English | Suppressed by the script pre-writing `org-{id}:bot-intro`; the owner's pinned Turkish message stands in |
| Thu 17:00 | Daily 17:00 update (row 72), squad short | English, model-composed: "🗓 Squad update ... need *14 more* 🙏" then "*Playing tomorrow:*" with fourteen 🥁 rows. If the model call fails: "🗓 *Cuma Maçı*, need *14 more*." + "*Confirmed (0/14):*" "_nobody yet_" | Same, in English. This is the one post the group cannot avoid seeing in English on day one |
| Thu evening | "varım", "ben varım", "geliyorum" | ✅ react on each, no words. Correct and silent | Same |
| Thu evening | "yokum" from someone not yet in | 👋 react or nothing (no row to drop); silent | Same |
| Thu evening | "Ali de geliyor" (third party, untagged) | Untagged third-party claims need an @Match Time tag. Silence, or the English `needs_tag_for_rest` line (row 40): "One thing I've left alone: I've not ... That bit needs an @Match Time tag" | Same |
| Thu evening | "kaç kişiyiz?" | If the question extractor reads it (it reads full Turkish sentences, per the readiness table): "We're 6/14 for Fri 21:00, need 8 more 🙏" in English. If not: silence | Same; `statsQa` off does not gate the count question |
| Thu evening | "+1" or "kardeşim de gelecek" | Guest offer detection is English-keyed (`guest-name-ask.ts:121`), so most likely nothing. If detected: "Nice one Erdal 🙌 What's their name? ..." in English | Same |
| Thu evening | "belki" | Phase 1 aims to register a tentative; then at Thu 21:00 a DM in English: "Hi Mehmet 👋 You were a *maybe* for *Cuma Maçı* on Fri 18 Sep at 21:00. Are you in or out? Just reply *IN* or *OUT* ..." | No DM (`featureReminders` does not gate this; the tentative follow-up is attendance-side, so it DOES still fire in English). Note this for the owner |
| Thu, 14th "varım" lands | Squad complete (row 43) | "✅ *Squad complete, 14/14* for *Cuma Maçı* on Fri 18 Sep 21:00 🙌 *Playing:* 1. ... See you all there ⚽" in English | Same |
| Thu, 15th "varım" | Bench | 🪑 react, and, with bench on, later English bench offers when someone drops: "🎟 A slot just opened on ... *First to claim it plays.* ... Just reply *IN* here to take it." plus an English DM to each bencher "Reply *YES* here ..." whose YES/NO answers are parsed by an English list that strips Turkish letters | 🪑 react only; no bench post, no bench DM (`featureBench` off). A drop produces the English `slot_opened` line: "Ali is out, 13 of 14 for Fri 21:00. One slot open, say *IN* to take it." |
| Fri 08:00 to 08:59 | Match-day morning chase (row 4 / 120) if short | English: "☀️ Squad update ... still need 2 ... *Playing tonight:*" | Same |
| Fri 09:00 to 12:59 | Announce-match (row 68) | Does not fire (kickoff is under 24h away and the squad is not empty) | Same |
| Fri 17:00 | Evening update, match day | Teams exist: "⚽ *Tonight at 21:00*, *Cuma Maçı* at {venue} *Red:* 1. ... *Yellow:* ... See you tonight 🙌". Full, no teams: "Squad is locked. Say *@MatchTime generate teams* ..." Short: the chase | Same (team balancing is on). Labels are "Kırmızı"/"Sarı" if the script set `teamLabels`; the sentences are English |
| Fri 17:00 to 18:00 | Pre-kickoff chase (row 74) if short | English: "⏳ Still *2 short* for *Cuma Maçı* at 21:00. Anyone free tonight?" | Same |
| Fri 19:00 to 19:30 | Gear reminder (row 76) | English: "⚽ *21:00 at {venue}*, see you there! ... *goalie gloves*, a *ball*, and *spare bibs*." | Same |
| Fri 19:00 to 20:30 | Pre-kickoff short (row 75) if short | English: "⏰ Tonight *21:00* at *{venue}* · 12/14, *still need 2*, last chance to jump in. 🙏" | Same |
| Fri, "takımları oluştur" / "@Match Time takımlar" | Teams (row 2) | If the teams extractor reads the Turkish request (untested; its prompt is English): "⚽ *Teams for tonight*, 21:00 at {venue} *Kırmızı*: 1. ... Objections? Reply `swap X Y`, admin will confirm." Otherwise silence and an operator note to the owner | Same |
| Fri 22:00 (kickoff + duration) | Payment poll (row 78) | A WhatsApp poll: "💳 Payments for *Cuma Maçı*, tick when you've paid" with options Kırmızı / Sarı. Fires whatever the payment features say | Suppressed by `postMatchEndFlow = false` on the match |
| Fri 23:00 | Ask for score (row 77) | English: "🏁 *Cuma Maçı*, hope it was a good one. What was the final score? ..." A Turkish "3-2 kazandık" is read positionally (first team named = RED) | Same |
| Sat from 08:00 | Rating DMs (row 91) to every player with a phone, one per minute | English DM to each: "🏆 *Cuma Maçı*, Fri 18 Sep. Rate your teammates and pick Man of the Match. Takes ~1 minute. Your personal link: ... Link expires in 5 days. 📊 Your season stats ..." followed by the group promo (row 3): "🎯 Just DM'd every player ... Check your DMs from me 👇" | Nothing (`featurePlayerRating` off) |
| Sat to Wed 18:00 daily | Rating reminders (row 92) to anyone who has not rated | Up to 5 English DMs per player: "Hey Mehmet 👋, hope last night's *Cuma Maçı* was a good one ..." through "Last call Mehmet 🔔 ..." | Nothing |
| Wed at the latest | MoM announcement (row 45) | English: "🏆 *Man of the Match, Cuma Maçı* Congrats *Ali* (6/12 votes) 🎉 ... Your trophy awaits next match." | Nothing (`featureMomVoting` off) |
| Any day | Pay links, pay chases, fee ask (rows 88, 89, 95) | Only with `paymentCollectionEnabled` and a connected Stripe account, which Erdal will not have on Friday | Nothing |
| Sat 09:00 to 12:59 | Announce-match for the next Friday (row 68) | English: "📅 *Cuma Maçı*, *Friday 25 September at 21:00* at {venue}. Say *IN* to join. First 14 confirmed play." | Same |
| Sat onward | The weekly cycle repeats from the Thu 17:00 row | | |

**Count for the week, everything on:** about 10 to 12 English group
posts (intro, 17:00 update on two or three days, squad complete, teams,
pre-kickoff, gear, score ask, promo, MoM, next announce) and 1 to 6
English DMs per player (rating link, up to five reminders, a tentative
follow-up for anyone who said "belki", bench offers for anyone on the
bench). **Trimmed set:** about 6 to 8 English group posts and zero DMs
except the tentative follow-up, which is attendance-side and still
fires; if that matters, the script can leave `belki` unread for week one
by not shipping the tentative part of Phase 1, or the owner can accept
one English DM to the few who hedge.

**With the week-one subset (5.5) on top:** the announce, the 17:00 post
(model and fallback), squad complete, teams, slot opened, the three
common answers, the guest ask, the two pre-kickoff posts and the gear
reminder are Turkish. What stays English in week one is then: the
`needs_tag_for_rest` line, the score ask, the score ack, the unresolved
sender nudge, and every DM.

## 7. Things in the code that make this harder than it looks

Each of these was verified against the source on `main` at `292627d`.
The first four are defects today, in English, independent of this work.

1. **`CLAIM_NAME = "([A-Z][\p{L}'-]+)"` (`group-copy.ts:180`).** The
   `[A-Z]` first-letter class excludes Ç, Ğ, İ, Ö, Ş, Ü. So
   `contradictsSquadState`, the guard that stops the bot announcing a
   move the database never made (the Erdal S7 incident), is blind to any
   name starting with a Turkish capital, in English text, today. Fix:
   `\p{Lu}`. One line, one test.
2. **`bench-prompt-answer.ts:101` strips every non-ASCII letter**
   (`.replace(/[^a-z0-9\s]/g, " ")`) before matching. "evet" survives,
   "hayır" and "değil" do not; and a Turkish player's own name is
   mangled. The module needs its normaliser rewritten to keep `\p{L}`,
   not its word lists extended.
3. **`clause-peel.ts:103` knows only English coordinators** (`and, but,
   also, plus, then, so, &`). A compound Turkish message ("Ali'yi değiştir
   ve ben yokum") does not split, so the attendance half is dropped,
   which is the bug class that file's header documents six incidents of.
   Reading-side; flagged for the Phase 1 agent.
4. **Five bare `format()` calls render in the server's zone** (UTC on
   Vercel): `dm-qa.ts:121` appends "(UK time)" to a UTC time,
   `match-completion.ts:92`, `player-stats.ts:283`,
   `whatsapp/status/route.ts:51`, `whatsapp/teams/route.ts:62`. Fix while
   consolidating the formatter.
5. **English prose doubles as a key in three places.** The roster-survey
   clarification dedupe is a `text: { startsWith: ... }` query on the
   English opening of row 109 ("Sorry {first}, wasn't sure ...", with
   the source's em dash) at `dm-reply/route.ts:927`; `OPERATOR_NOTE_MARKER`
   (`operator-note.ts:157`) is both the note's first line and its
   one-hour dedupe key (`analyze/route.ts:2448`); `FEE_REPLY_SYSTEM_PROMPT`
   (`fee-confirm.ts:326`) embeds the collector prompt from
   `payment-flow.ts:421` byte for byte. Translate any of these in one
   place only and a guard stops working with no error. The design moves
   the first to a `BotJob.kind`, leaves the second English (owner-facing),
   and builds the third from the same table entry.
6. **The chase model is asked to WRITE the roster, not just the lead**,
   and the server then patches its English after the fact
   (`enforceProximity`, `replaceRelativeDay` with `DAY_PREPOSITION`:
   `message-analyzer.ts:724`, :768). That machinery is English grammar,
   not strings, and cannot be translated. Phase 2c bypasses it for
   Turkish; Phase 2d removes the need for it in both languages.
7. **`state.kickoffLabel` is formatted at load time** (`load-state.ts:210`,
   `EEE HH:mm`) and interpolated by about ten composers. The label must
   be produced per language before it reaches `compose()`, which means
   `loadSquadState` needs the language before it formats, which it has,
   because it loads features first. Order matters in that function.
8. **There are zero snapshot tests and the existing copy guards read
   `src/` as text.** `no-time-of-day-greeting.test.ts:102` walks
   `src/**/*.ts(x)`; so do `no-conjunction-classifiers`,
   `no-stale-fast-path-claims`, `seatbelt-deletion`, `max-tokens-ceiling`
   and `zero-writes`. Put the string tables under `src/lib/i18n/`, never
   in a `locales/*.json` outside `src/`, or those guards go blind while
   still reporting green. Section 4.5 point 1 is the snapshot.
9. **The repo applies schema with `prisma db push`, not migrations**
   (`MDs/skills.md:24`; the migrations directory is out of sync). The
   column is additive with a default, which is the "strictly additive"
   rule (`skills.md:267`), and three e2e fixtures insert `Organisation`
   rows with raw SQL, so the DB default (not only the Prisma default)
   must exist. `db push` creates it.
10. **Two builders are duplicated**: the rating DM exists in
    `bot-scheduler.ts:1867` and `app/actions/players.ts:809`; `gbp()`
    exists three times (`payments.ts:129`, `fee-confirm.ts:507`,
    `payment-roster.tsx:19`). Translate one and the other stays English.
    Phase 3a collapses the first; the second is fine (currency does not
    change).
11. **Two feature flags are off and hide a second English branch in six
    builders**: `BENCH_PROMPT_MENTION_REACTIONS` (`bench-offer-copy.ts:76`)
    and `RECRUIT_DM_MENTION_REACTIONS` (`recruit.ts:173`). The Turkish
    table must cover both branches or flipping a flag later resurrects
    English.
12. **The Sport preset library is English** (`sport-presets.ts`: "Football
    7-a-side", "Man of the Match", "Red"/"Yellow") and is copied into each
    new org's sports. That is data the admin edits, not code, so the
    provisioning script sets Turkish `Sport.name`, `mvpLabel` and
    `teamLabels` for Erdal; the preset table itself is not translated in
    this design.
13. **Dead code that looks like copy**: `bench-upgrade-ack.ts` (no caller
    since 2026-09-06, `analyze/route.ts:229` says so), `pre-kickoff-full`
    chase kind (no caller since 2026-04-21), `whatsapp-bot/src/messages.ts`
    (five builders, no importer). Delete rather than translate.
14. **The bot intro fires by itself** for a new org on the first
    scheduler tick with an active activity (`bot-scheduler.ts:492`), in
    English, eleven lines, and its "I react with 👍 to confirm" clause is
    wrong today (the engine gives ✅ / 🪑 / 👋 for the sender's own row).
    For Friday the provisioning script pre-writes its SentNotification
    key so it never posts; the sentence is fixed in Phase 3c.
15. **The corpus grader is English-keyed and passes vacuously in
    Turkish.** `e2e/corpus/grade.ts:405` `claimedMoves()` and the
    `mustNotMatch` properties in `incidents.jsonl` are English regexes,
    mostly negative, so a Turkish output that violates the property
    matches nothing and passes. Phase 2c gives them Turkish alternates.
16. **`scripts/enable-sutton.ts` is untracked** in the main checkout and
    was not readable from this worktree; `scripts/onboard-amir.ts:205` is
    the closest committed template. Whoever writes Erdal's provisioning
    script should commit it.
