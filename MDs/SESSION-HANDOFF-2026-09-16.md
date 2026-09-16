# Session handoff, 2026-09-10 → 16: twelve merged PRs, four waiting, and an outage opened and closed in a day

Follows `SESSION-HANDOFF-2026-09-09.md`. Two halves, and they are unrelated:
**Part 1** is a week of shipped work. **Part 2** is the 2026-09-16 WhatsApp
outage, which is **CLOSED** — the bot went down at 06:57 on a WhatsApp Web
self-update and was live again at 13:39 UTC on `whatsapp-web.js` 1.34.7. The
day's other five merges all came out of that recovery.

Part 2 was written mid-outage and said the opposite; it has been rewritten
against what actually happened. The corrected operational account is
`MDs/whatsapp-outage-2026-09-16-runbook.md` (PR #83), and the Friday
second-group assessment is
`MDs/second-group-readiness-erdal-2026-09-16.md`.

Method notes that generalise are in `MDs/llm-pipeline-testing-playbook.md`.
The router measurement is its own document,
`MDs/router-accuracy-2026-09-11.md`.

---

# PART 1 — WHAT SHIPPED

| PR | what |
|---|---|
| #72 | the stats blast is classified by the model, not three ANDed keywords |
| #73 | the last two conjunction classifiers deleted; the DM surface is model-read |
| #76 | a router prompt that loses NO attendance, plus a per-model cache threshold |
| #74 | the `none`-bucket sweep files a row nightly; a missing one alerts |
| #75 | a thumbs-up inside a sentence no longer releases the squad's pay links |
| #77 | a full squad is an invitation to the bench, not a refusal |
| #78 | a drop that opens a spot speaks; an IN still does not |

Open, reviewed, gates green, NOT merged: **#79** (one team-generation path),
**#80** (inactive players leave the leaderboard), **#81** (one health alert a
day — carries a migration), **#82** (a replacement inherits the dropped
player's slot). #81's migration has NOT been applied; apply it BEFORE
deploying that code or the cron throws on a missing column.

## The week's theme: deleting classifiers

Four regex classifiers were deleted after **2026-09-10, 18:38**, when this
sentence from the owner to his players

> "please do not forget to rate the players via the link from Matchtime
>  DM'ed to you. the more accurate ratings, the more balanced teams next
>  time"

matched three unrelated keyword tests ANDed together and **queued 69 mass
DMs**. One was delivered before the queue was killed. The same shape had
already caused the 2026-09-01 incident. `src/lib/stats-blast.ts` carries
the full argument; the pattern that replaced it — model extracts a typed
fact, engine gates it, route performs it — is now the template.

**The tag gate was weaker than anyone believed.** `messageTagsBot` counts
the bare word "matchtime" ANYWHERE in a body, so the incident message was
`tagged: true`. Every "it requires a tag" safety argument made that week was
softer than claimed. `messageMentionsBotExplicitly` (Pi mention signal, or a
literal `@`) now guards the bulk-DM doors only; widening it everywhere is a
separate decision.

**A second mass-DM path was found in a file nobody had looked at.**
`looksLikeRecruitRequest`, deleted from the group on 2026-09-01, was still
live on the DM surface where it could DM 13–27 people. Both it and
`looksLikeRatingProgressRequest` are now deleted outright.

## Measured, not asserted

- **Router prompt rewrite (#76).** Owner accuracy 83.3% → **93.4%**;
  attendance-routed-`none` **3, 2, 4 of 373 → 0, 0, 0 of 373** across three
  live runs each; `admin_ops` precision 13.4% → 82.5%. Cost **+$0.69/month**.
  A bigger model on the OLD prompt was *worse* at the metric that matters.
- **Rating decay, decided.** Inactive players leave the leaderboard after 3
  months; **the balancer is untouched**. Rust is already handled per-match by
  `rating-adjuster.ts`'s ±2 delta, which is temporary and self-correcting; a
  permanent decay would double-count it and never recover. The club's break
  is **1.5 months**, so 3 months is deliberately double it. Verified against
  real fixtures: the 2026 shutdown was **49 days** and the table bottomed at
  28 of 41, never empty.
- **Team generation unified** on `computePlayerRating` (Bayesian
  `(sumPeer + seed×3)/(peerCount+3)`). The dashboard's Elo-blended formula is
  deleted. **Elo `matchRating` is leaderboard-only** and has no say in team
  selection — it never did on the path actually in use.

## Corrections to this codebase's own records

1. **The balancer is NOT deterministic.** `balancePositionAware`'s
   1,000-iteration hill-climb draws swaps from `Math.random()`. 401 runs over
   one squad produced **19 distinct sheets**. "Regenerate" is a reroll, not a
   recomputation. Two agents found this independently. Undecided whether to
   seed it.
2. **The router prompt is 669 tokens, not "~360"** (`llm.ts`, two test files).
3. **`MIN_CACHEABLE_CHARS = 4_000` was a Sonnet threshold on Haiku calls.**
   Probed live: 2,521 tokens does not cache, 5,005 does. But the attendance
   extractor was NEVER a silent no-op — extractors run Sonnet (min 1,024) and
   it caches correctly. The risk in fixing this was *losing* a working cache.
4. **The `none`-bucket sweep had filed ONE row ever** (2026-09-09) because the
   cron only wrote on an alert, making a clean night and a dead cron
   indistinguishable. Fixed in #74.
5. **`waMessageId` is not a delivery signal.** It is null for every message
   this system has ever sent, including ones known to have arrived; the bot
   acks without it deliberately, because a duplicate send is considered worse
   than a missing id. Any reasoning that treats it as proof of delivery is
   wrong. **This was asserted twice in this session before being caught.**
6. **The recall harness's miss rate is biased optimistic** — `noise`/`unclear`
   map to benign, so a real IN the mega-prompt mislabelled counts as a saving.

## The unfixed thing underneath the week's bugs

**`L1` — a polite hedge only registers 2 times in 10.** Wasim's real drop,

> "…If there is someone who can take my place, then please do."

is read as a CONTINGENT drop 8 times in 10, so nothing is written, and the
router splits 5/5 on self vs third party. Production got the lucky branch on
the night. **Re-run that evening four more times and he stays in the squad**,
with nobody told and a team a man short. #82's state check heals the *sheet*
once a drop lands; if the drop never lands there is nothing to heal. This is
a router/extractor problem and it is the highest-value open item in Part 1.

---

# PART 2 — THE 2026-09-16 OUTAGE (CLOSED)

**Status at handoff: closed the same day.** Down 06:57 UTC, live again
**13:39 UTC** on `whatsapp-web.js` **1.34.7**, QR-linked, and the session
survived all four restarts that followed that afternoon (bot ready 16:27,
monitoring 1 group). The rating round was recovered inside its window, the
outage window's attendance was walked back out of WhatsApp, and five PRs plus
the version bump were merged off the back of it.

## What broke

At **06:57** WhatsApp Web self-updated to build `2.3000.1047086005`. Every
outbound send after that failed:

```
Cannot read properties of undefined (reading 'getChat')
  at Client.sendMessage (whatsapp-web.js/src/Client.js:1083)
```

~1,018 failures. The 13 rating DMs and the group promo, claimed 07:00–07:15,
were the first casualties. **The Pi acks a failed send as done**
("DM send failed …, acking to skip"), so claim-on-dispatch consumed all 14
permanently; they can only come back by deleting the `SentNotification` rows.

The mechanism, established after the fact: a WhatsApp Web self-update is a
**page navigation**, the library's `framenavigated` handler re-runs
`inject()` against the new build, and on 1.34.6 that re-injection **failed
silently** — the rejection happened inside a puppeteer `exposeFunction`
callback, where rejections are swallowed — leaving `window.WWebJS` undefined.
Every later send read `getChat` off `undefined`. **Inbound died with the same
navigation**, because `attachEventListeners()` registers the inbound
listeners inside the page during `inject()` and the navigation discarded
them. Nothing in MatchTime's own code was wrong.

## The fix: 1.34.6 → 1.34.7 (`a2c3769`)

Tested on the Pi against the live build before it was trusted: 1.34.7's
`ExposeAuthStore` and `LoadUtils` both inject cleanly and
**`window.WWebJS.getChat` is a function**, which is the exact thing 1.34.6
could no longer produce. The bot came back on 1.34.7 with **zero crash
restarts** and delivered DMs the owner confirmed receiving.

The repo bump matters on its own: the Pi was already on 1.34.7 by hand, and
without `a2c3769` the next deploy that pulls and installs would silently
reinstall 1.34.6 and take the bot down again.

### What the mid-outage "three versions, three walls" table got wrong

| claim made during the outage | what it actually was |
|---|---|
| 1.34.7 throws `t: t` at `requestPairingCode` and crash-loops | not a library wall. `WA_PAIR_PHONE` was set while the client was unpaired; that is what produced the pairing crash loops. On QR, 1.34.7 initialises and runs clean |
| `2.0.0-alpha.0` was the promising escape hatch | it is a **2023** release. It authenticates, never emits `ready`, and loses phone-number pairing. It was never a candidate |
| the local-cache pin to `2.3000.1046967158.html` is "the most plausible route back" | **a pin cannot freeze the frontend.** The cached `<version>.html` is a bootstrap page that lazily loads WhatsApp's modules from their servers at load time, so the pin pins the loader and WhatsApp still serves the new modules into it. Verified on the Pi and written up in `MDs/whatsapp-web-version-pinning.md` |

**The library version is the lever when the failing call is inside the
injected code** (`src/Client.js`, `src/util/Injected/*`). Three build pins
were tried before anyone tried a library version.

## Ratings: settled inside the window

The 14 consumed claims (`cmtbro26i0003tt9kzarkcd8m:rate-dm:<userId>` plus
`:rate-promo`) were **deleted at 14:50 UTC**, once sending was proven, and
MatchTime re-issued **all 13 rating DMs plus the group promo by 15:05 UTC** —
inside the 36h window that would otherwise have closed at 09:30 London on
2026-09-17. The owner's precondition ("ratings and money settled first") is
now met on both halves: the 13 pay links landed 2026-09-15 22:02, the ratings
on 2026-09-16.

The re-issued promo is what produced the day's next bug: it opened
**"🎯 Morning all"** at **16:05 London**, because copy written for the 08:00
window went out in the late afternoon. See **#85** below.

Two facts from the day that outlive it. **Email is not a fallback**: only 4 of
14 players have a deliverable address, the rest are `@matchday.local` /
`@matchtime.local` placeholders. And the per-player rating magic links
generated as a manual route were **never sent** — the owner declined them, to
avoid signalling to players that MatchTime was broken. Nothing went out by
hand; everything that reached a player came from the product.

## The outage window's INs: recovered, not lost

~15h of Sutton FC group messages (players saying IN for Tuesday 22 Sept) sat
unread on the phone, and the 13:39 UTC restart's catch-up walk logged
`message-recovery is unavailable ... Error: r`.

**#84 (`b39137f`)** fixed the walk: its first injected call was
`client.getChatById(gid)`, which throws on this build from `getChatModel`, so
`recoverGroupMessages` now builds a **bare `Chat` handle** from the group id
and fetches through it (`Chat.fetchMessages` never calls `getChatModel`), with
`RECOVER_LOOKBACK_HOURS` / `RECOVER_FETCH_LIMIT` making the window
env-driven. A repeat `ready` from the same process no longer starts a second
scheduler.

The one-off wide run, `RECOVER_LOOKBACK_HOURS=24` and
`RECOVER_FETCH_LIMIT=400`: **fetched 400, re-queued 20, 7 actionable, 5 INs
registered.** The sixth, Idris's lowercase `in`, was dropped by the
confidence floor (0.6 < 0.7) and **registered by hand**. Tuesday 22 Sept went
**0/14 → 6/14**.

The 17:00 evening update was **held by an `evening-update` row that had
already been claimed** during the broken hours, and was released only once the
recovered INs had landed and the squad count was right. It then fired at
**17:00 London** with the correct numbers.

## The five merges the recovery produced

| PR | commit | what |
|---|---|---|
| — | `a2c3769` | `whatsapp-web.js` 1.34.6 → **1.34.7**, the version whose injection matches live WhatsApp |
| **#84** | `b39137f` | the restart catch-up reads the group without `getChatById`; a repeat `ready` starts no second scheduler |
| **#85** | `7e9ec4b` | **no scheduled post greets the group with a time of day** |
| **#86** | `6f3268f` | reactions go through the library on 1.34.7; a failed reaction no longer speaks in the group |
| **#87** | `4aa2c6b` | a member's own IN is never dropped by the confidence floor; the catch-up feeds the extractor its context |
| **#83** | `9a08f97` | the outage runbook and the pinning doc corrected |

**#85 — the greeting is gone, not made clock-aware.** Rate promo, match-day
chase fallback and the `match-day-morning` compose instruction all lost their
time-of-day opener, and `CHASE_SYSTEM_PROMPT` now bans it outright; the promo
also stopped saying "last night's", because its window is 6–36h after
kickoff. Same class as the 2026-09-04 "Quick 5pm update" bug. The old test's
carve-out — *"a greeting is not a clock stamp"* — was withdrawn deliberately.

**#86 — the reaction fallback text is deleted, by the owner's ruling.** After
the upgrade every ✅/🪑 failed, five for five on the catch-up, because
`react-with-id.ts` ran page code of ours against `window.Store`, and **1.34.7
has no `window.Store` at all** (0 hits in `src`; no `Injected/Store.js`). The
fix runs no page code of ours: `client.getMessageById(ourId)` then
`client.sendReaction(ourId, emoji)`, the library's own path. The
"⚠️ WhatsApp won't let me add my usual reactions right now, so here it is in
words" post **fired once in the live group** on a day it had already had too
many bot messages, and the owner's ruling is that **it must never post
again** — a bot announcing it cannot react reads as a broken bot, which is
worse than a missing tick. `react-fallback.ts`, its spec, the
`BOT_REACT_TEXT_FALLBACK` switch and the cooldown are gone; a failed reaction
now makes **zero** `sendMessage` calls and is only logged and counted
(`CRITICAL: N of M reaction(s) could not be delivered`,
`inboundStats.reactFailures`).

**#87 — the owner's hard rule, and the real cause of the 0.6.** The rule,
verbatim: *"self-declared IN from a known squad member should [n]ever be
dropped by a confidence floor at all."* `isFloorExempt` implements exactly
that — `subject === "sender"`, polarity `in`, the sender resolved to a user,
and that user a current `Membership` of this org. OUT, BENCH and every
third-party claim keep the floor. The floor had fired **twice in the engine's
whole production record**: `@Wasim can Najib come please?` (rightly refused)
and Idris.

The **0.5-versus-0.7 question was measured on the real corpus** (970 batches,
1,744 messages, 143 days; 617 extractor calls, $4.32) and **0.7 stays
global**. In the [0.5, 0.7) band, third-party claims are overwhelmingly
questions, team swaps and corrections (7 wrong to 1 correct on third-party
IN, 3 wrong to 0 on third-party OUT), and self OUT/BENCH is 3 correct to 2
wrong, where a wrong OUT silently leaves a paid squad a man short. Self IN is
the one shape where the asymmetry runs the other way: a wrong IN is one tick
to undo, in public. The honest description of the trade over 143 days is
roughly two real INs rescued (three counting Idris) against four wrong INs.

And the 0.6 itself was **context starvation, not the model**:
`recoverGroupMessages` enqueued replayed messages **without** `recordHistory`
after a fresh restart, so the extractor saw no recent chat and a stale last
post about a match that had already been played. Fifteen live runs per
context: in the live handler's context a bare `in` sits at 0.9 every time; the
catch-up's starved context is what produced the 0.6. The catch-up now records
history before enqueueing and replays oldest-first. **A bigger model was
considered and rejected on the numbers.**

## Process failures worth more than the technical notes

1. **The restart cost the SESSION, and there was no working half to lose.**
   Inbound died at 06:57 with the same failed re-injection that killed
   outbound; the DB agrees, with nothing analysed between 2026-09-15 22:35
   and the 13:39 UTC recovery, and `bot.log` was truncated by the redeploy so
   the DB is the only surviving evidence. Inbound was *assumed* fine, it was
   not, and the session was spent for nothing: WhatsApp ended it
   (`Client disconnected: LOGOUT`), which cost several rounds of re-pairing
   and eventually phone-number pairing itself.
   **Establish the failing LAYER first, write down what you have VERIFIED
   works, and say what a restart puts at risk before you touch it.**
2. **The diagnosis chased the wrong layer for hours.** The first error was a
   LIBRARY error — the stack ends inside `whatsapp-web.js/src/Client.js` —
   and the runbook prescribed pinning the web build, so three pins, a
   QR/pairing switch and a number hypothesis were tried before a library
   version was.
3. **Too many variables at once.** Library version, pin, cache type and login
   mode all moved inside an hour, which made every result uninterpretable —
   including the pairing crash loop that was blamed on 1.34.7 and was
   actually `WA_PAIR_PHONE` set while unpaired.
4. **`MDs/whatsapp-web-version-pinning.md` said upgrading the library "is not
   a reliable fix".** That line is why the library was not tried first. It is
   now replaced (#83) by the layer test and by "Why a pin cannot freeze the
   frontend", verified on the Pi against the cached build.

## The standing recommendation, unchanged

This was the **third** WhatsApp Web update to take the product down
(2026-08-28, 2026-08-30, 2026-09-16) and the first where the documented
pinning workaround did not hold. What ended it was an upstream library
release that happened to exist; during the outage the only other options were
an unreleased alpha or waiting. The 2026-08-30 audit named a protocol client
(Baileys) as the strategic answer and it has now been deferred three times.
The owner's stated precondition — ratings and money settled — **is now met**,
so the next deferral has to be argued on its own merits.

---

# WHAT IS OPEN AFTER TODAY

**Four PRs reviewed, gates green, still not merged** (all opened 2026-09-15):

| PR | one line |
|---|---|
| **#79** | one team-generation path; the Elo stops picking teams |
| **#80** | a player who stops turning up leaves the leaderboard, and his rating is never touched |
| **#81** | one health alert a day, newest thing first — **carries a migration** |
| **#82** | a replacement takes the dropped player's slot, and the roster stops once the teams are out |

**#81's migration has NOT been applied. Apply it BEFORE deploying that code**
or the cron throws on a missing column.

**The second group, Erdal's Turkish group, Friday 2026-09-18 — three NO-GOs.**
Full measurements and the exact work to reach GO are in
`MDs/second-group-readiness-erdal-2026-09-16.md`:

1. **Self-onboarding by adding the number.** `ONBOARDING_AUTOSTART=1` has been
   on in Vercel production for 93 days and the flow has **never run once**
   (`OnboardingSession`: 0 rows). The Pi never flushes an un-tagged reply from
   a group that was not a live org at startup, so the player's "YES" sits in
   the buffer forever; and on this build `getChatById` throws, so the group
   name and the roster snapshot come back empty.
2. **Turkish attendance.** Full sentences read 10 of 10, including idioms. The
   bare forms — "var", "yok", "yokum", the Turkish equivalents of "in" and
   "out" — are **lost 30 of 30 at the router**, silently, because the floor
   regex is English-only. Hedges never become a firm IN (0 of 32) but never
   become a tentative either. All outbound copy is English.
3. **Two matches from one group.** Every attendance write lands on the soonest
   open match, org-wide, whatever day the player names; the extractor has no
   field for "which match". Scheduled posts, rating DMs and pay links do work
   per match.

The realistic Friday path is manual provisioning by script plus one Pi
restart, a single Friday fixture only, and the caveats accepted by Erdal in
advance.

**Carried over from the outage:**

- **Reaction delivery on the new library path is unproven live.** #86's tests
  drive a storeless fake page, and the fix is the exact code path 1.34.7's own
  `Message.react()` takes, but no real ✅ has landed in the group since the
  upgrade. The first real IN is the test.
- **`group-enumeration` and `participant-sync` are still degraded.**
  `message-recovery` was the third of that trio and #84 fixed it; the other
  two still ride on `getChatById`, which throws on the live build. They matter
  for the lurker-gap backfill and for any new group's roster import.

**Still the highest-value open item in Part 1:** `L1`, the polite hedge that
only registers 2 times in 10. #87 exempted a member's own IN from the floor,
which is a different failure — Wasim's drop never produces a claim to floor in
the first place.

---

# HomeTenant

HomeTenant runs the other `whatsapp-web.js` bot on the same Raspberry Pi
(`hometenant-bot.service`, `~/hometenant-bot/whatsapp-bot`) and it handles
gas-leak and tenant reports, so the owner asked for today's learnings written
up for that repo. **HomeTenant was never down**: it already runs `1.34.7`,
because its `package.json` declares the caret range `^1.26.1-alpha.3` which
floated to 1.34.7 in July and its lock file froze it there, so the 06:57
re-injection succeeded where ours failed. Its `.wwebjs_cache/` gained
`2.3000.1047451014.html` at 07:04, its log carries a second `bot ready` line
under one PID with `NRestarts=0` (the same repeat-`ready` behaviour #84 fixed
here), and it received and routed an inbound message at 11:34. The full
write-up, with each finding mapped onto a HomeTenant file and line and the
MatchTime commit to copy from, is
`/Users/kemal/Projects/Cressoft/HomeTenant/MDs/whatsapp-web-js-1.34.7-upgrade-from-matchtime-2026-09-16.md`
(HomeTenant `f188b7c`). It extends the earlier review pointer at
`HomeTenant/MDs/whatsapp-layer-review-from-matchtime-2026-09-09.md`. Their
open work is to pin the version exactly, keep `window.Store` out of any page
code they add, build the catch-up walk they do not have, and move their
liveness signal off the outbox poll, which is plain HTTP and would have read
healthy through a seven-hour WhatsApp outage. Their outbox is at-least-once
with leases and dead-lettering, so unlike ours it does not consume a message
attempted during an outage, and that difference should not be "fixed".
