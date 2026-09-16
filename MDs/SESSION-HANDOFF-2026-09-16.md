# Session handoff, 2026-09-10 → 16: six merged fixes, four waiting, and an outage that is still open

Follows `SESSION-HANDOFF-2026-09-09.md`. Two halves, and they are unrelated:
**Part 1** is a week of shipped work. **Part 2** is the 2026-09-16 WhatsApp
outage, which is UNRESOLVED at the time of writing and is the only thing
that matters until it is fixed.

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

# PART 2 — THE 2026-09-16 OUTAGE (OPEN)

**Status at handoff: the bot is authenticated but not functional. It has
recorded nothing since 2026-09-15 22:35. A Fable agent is mid-investigation.**

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
permanently: they will never be retried without deleting the
`SentNotification` rows.

Nothing in MatchTime's own code was wrong. `whatsapp-web.js` drives a real
browser against WhatsApp's minified internals; when those move, the injected
calls throw.

## Three library versions, three different walls

| version | pairing | app init |
|---|---|---|
| **1.34.6** (shipped) | works — owner linked successfully | crashes, `null.Socket` at `Client.inject` |
| **1.34.7** | worked, then threw `t: t` at `requestPairingCode`, 16 crash-restarts | init clean, never reached |
| **2.0.0-alpha.0** + `WA_WEB_VERSION_CACHE_TYPE=none` | QR only (ignores `WA_PAIR_PHONE`) | authenticates, survives restart, zero crashes, **never emits `ready`** |

The alpha's `Events` constants still use `ready`/`authenticated`, so it is
NOT a renamed event. It authenticates and then does nothing.

## Process failures worth more than the technical notes

1. **The restart cost the SESSION, and there was no working inbound half to
   lose.** The bot had been running since 9 September with a code injection
   made against an older build. Inbound was almost certainly dead from 06:57
   too: the self-update is a page navigation, and it took the in-page
   listeners `inject()` had registered with it, so the re-inject that failed
   took inbound down alongside outbound. The DB agrees, with nothing analysed
   after 2026-09-15 22:35. What the restart destroyed was the session:
   WhatsApp ended it (`Client disconnected: LOGOUT`), forcing repeated
   re-pairing and eventually the loss of phone-number pairing.
   **A long-running process can hold a SESSION that a restart cannot
   recreate. Say so before touching it.**
2. **The diagnosis chased the wrong layer for hours.** The first error was a
   LIBRARY error. The runbook prescribes pinning the web build, so pinning is
   what got tried — three times, plus a QR/pairing switch and a number
   hypothesis. The pin cannot help when the injected code is what broke.
3. **Too many variables at once.** Library version, pin, cache type and login
   mode all moved inside an hour, which made every result uninterpretable.
4. **`MDs/whatsapp-web-version-pinning.md` says upgrading the library "is not
   a reliable fix".** That line is why the library was not tried first. On
   today's evidence it is wrong, or at least badly incomplete, and the
   runbook needs rewriting around "identify the failing LAYER first".

## The lead that was missed for hours

`~/matchtime-bot/whatsapp-bot/.wwebjs_cache/` holds
**`2.3000.1046967158.html` on local disk** — the exact build that was serving
this bot until 06:57. The remote pin failed with a 404 because the
wa-version archive prunes old builds, but `web-version.ts` supports
`WA_WEB_VERSION_CACHE_TYPE=local`. **Reverting to 1.34.6 plus a local-cache
pin to that build is the most plausible route back to the pre-outage state**
and is what the Fable agent was dispatched to test first.

## State of the Pi at handoff

- `whatsapp-web.js@2.0.0-alpha.0` installed (backup at
  `whatsapp-bot/package.json.bak-pre-alpha`); **the repo still declares
  1.34.6**, so any `git pull && npm install` deploy silently reinstalls the
  broken version. Do not run a pulling deploy until this is resolved.
- `.env`: `WA_PAIR_PHONE=447575534985`, `WA_WEB_VERSION_CACHE_TYPE=none`, no
  `WA_WEB_VERSION`. Backups at `.env.bak-*`.
- Session linked by QR and it SURVIVES restarts (no QR on restart).
- `deploy-pi.sh` worked correctly throughout and never touched HomeTenant.

## Deadlines and consequences

- **The rating window closes 09:30 London on 2026-09-17.** The scheduler only
  issues rating DMs while `hoursSinceMatch <= 36 && hourNow >= 8`. After that
  MatchTime will not send them at all, whatever is done with the claims.
- **The 14 consumed claims** are `SentNotification` rows keyed
  `cmtbro26i0003tt9kzarkcd8m:rate-dm:<userId>` plus `:rate-promo`. Deleting
  them is what lets the scheduler re-issue. NOT yet done — pointless while
  sending is broken, and it would burn them a second time.
- **Live attendance is being missed right now.** Players began saying IN for
  Tuesday 22 Sept; the match sits at 0/14. Those messages are safe in
  WhatsApp and the match is six days out, but `message-recovery` has been
  degraded since July so automatic recovery on reconnect should not be
  assumed. It did not run at the 13:39 UTC restart, which logged
  `message-recovery is unavailable ... Error: r`.
- **Email is not a fallback.** Only 4 of 14 players have a deliverable
  address; the rest are `@matchday.local` / `@matchtime.local` placeholders.
- Per-player rating magic links were generated and given to the owner as a
  manual option. **He declined to send them**, to avoid signalling to players
  that MatchTime is broken. Nothing was sent.

## The standing recommendation

This is the **third** WhatsApp Web update to take the product down, the
documented workaround did not hold, and the remaining choices are an
unreleased alpha or waiting for upstream. The 2026-08-30 audit named a
protocol client (Baileys) as the strategic answer and it has now been
deferred three times. The owner's position, stated today, is that ratings and
money must be settled before any migration — **money is settled** (13 pay
links delivered 2026-09-15 22:02), ratings are not.
