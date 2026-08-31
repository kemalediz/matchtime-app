# Cold audit — MatchTime, 31 August 2026

Independent, adversarial, read-only. No source file was modified, no message
sent, no database write performed. Findings were formed from the code, then
checked against live production data (read-only Prisma queries) and the Pi's
own logs (read-only SSH). Every claim carries a `file:line` citation and is
labelled VERIFIED or SUSPECTED.

Live context established during the audit:

| Fact | Value |
|---|---|
| Paying org | Sutton Football Club (`cmnnwhdx30000zfr85q18lyy9`), bot enabled |
| Next fixture | Tue 1 Sept 2026, 21:30 London, 10 confirmed of 14 |
| Other orgs | Sutton Lads + a BenchTest org, both bot-disabled |
| Users / memberships | 130 / 135 (73 in Sutton) |
| Pi | HEAD `c7571c2`, 1 process, `active`, restarted 11:49 today |
| Unit tests | 675 pass |
| e2e | 144 pass; 12 web specs fail only because the Playwright browser binary is not installed locally |

---

## ⚠️ ACTIVE HARM RIGHT NOW

**The whatsapp-web.js injected layer is broken on the live Pi, today, and five
product behaviours are silently degraded because of it.** This is one root
cause, not five bugs. VERIFIED from `~/matchtime-bot/bot.err.log` on the Pi and
corroborated in the database.

The Pi logs, from the current process:

```
CRITICAL: group-enumeration is unavailable … Error: r
CRITICAL: participant-sync is unavailable for Sutton Football Club … Error: r
CRITICAL: message-recovery is unavailable for 447525334985-1607872139@g.us … Error: r
CRITICAL: reaction-forwarding is unavailable … msgId=? senderId=…@lid emoji=👍
CRITICAL: sendMessage returned undefined for dm (botjob-cmth7dx9a…)
```

`WA_WEB_VERSION` is the documented escape hatch
(`whatsapp-bot/src/web-version.ts`, `MDs/whatsapp-web-version-pinning.md`) and
it is **not set**. The startup log's own words: group-enumeration "is the canary
for the whole injected layer".

### A1. Inbound reactions are dropped. The bot asks for them anyway. (VERIFIED)

`whatsapp-bot/src/index.ts:600` reads `reaction.msgId._serialized`, which the
broken build no longer exposes, so `index.ts:608-621` logs and returns. Live
evidence: 👍, 👋 and 🤝🏼 reactions from real `@lid` senders were dropped in the
last few days.

Meanwhile the bench-slot offer the bot posts to the group says:

> "React 👍 here (or reply *IN*) to take it."
> — `src/lib/bot-scheduler.ts:1290-1292`

and the accompanying DM says "Reply *YES* here (or 👍 / *IN* on the message I
tagged you in, in the group)" — `src/lib/bot-scheduler.ts:1315`.

The 👍 does nothing. A benched player taps it, believes they have claimed the
slot, and the team turns up short. The reply-IN fallback works, which is the
only reason this has not already cost a match.

This is doubly damning because the team **already identified this exact
failure** and built a gate for it: `RECRUIT_DM_MENTION_REACTIONS = false`
(`src/lib/recruit.ts:171`) removes the 👍 instruction from the recruit DM for
precisely this reason, with an excellent comment explaining why. The gate was
applied to the low-stakes message and not to the high-stakes one.

### A2. Every outbound message loses its WhatsApp id. (VERIFIED)

`whatsapp-bot/src/send-result.ts:39-52` reads `sent.id._serialized` — the same
property the inbound path stopped trusting. `whatsapp-bot/src/message-id.ts:111-125`
already knows how to **reconstruct** the canonical id from the raw `_data.id`
parts that survive the breakage. That technique was applied to inbound messages
and to nothing else.

Database confirmation: the most recent `SentNotification` with a non-null
`waMessageId` is **2026-07-18**. Every dispatch since has stored NULL.

Downstream: `src/app/api/whatsapp/poll-vote/route.ts:38-41` finds the poll by
`waMessageId`, so the match-end payment poll ("tick when you've paid",
`src/lib/bot-scheduler.ts:1585`) cannot register a tick. Dormant today only
because Sutton has `paymentTrackingEnabled = false`. MoM voting is unaffected —
it runs through the rating magic link, not a poll.

### A3. `lastSeenInGroupAt` is frozen, so the app's self-IN gate rejects real players and tells them a falsehood. (VERIFIED)

`participant-sync` (`whatsapp-bot/src/index.ts:220-283`) is the **only** writer
of `Membership.lastSeenInGroupAt`, and it fails on every startup. Most recent
value in the database across all of Sutton: **2026-07-07**.

`src/lib/group-membership-gate.ts:44-53` requires a non-null
`lastSeenInGroupAt` for role `PLAYER`. `src/app/actions/attendance.ts:30-34`
throws when the gate denies:

```
You need to be in the Sutton Football Club WhatsApp group to mark yourself in.
```

Live counts: 73 active Sutton memberships, 64 with `lastSeenInGroupAt` set. So
**8 existing players and every future joiner** are blocked from the app's "I'm
in" button and told, untruthfully, that they are not in the group they are
sitting in. This degrades monotonically: it cannot get better while the sync is
broken.

### A4. Restart loses inbound messages permanently. (VERIFIED)

`recoverGroupMessages` (`whatsapp-bot/src/index.ts:205-211`) fails with the same
`r`. Its own log line states the consequence: "an IN typed during a deploy will
never be registered". `scripts/deploy-pi.sh` is the sanctioned and frequently
used restart path, so this fires on every deploy.

Separately, and unfixed since the 7 July outage,
`recoverGroupMessages` only replays a fixed ~2h window rather than "since
last seen" — noted as open item 4 in `MDs/SESSION-HANDOFF-2026-08-27.md`.

### A5. Amir is on the bench for Tuesday because he offered his brother. (VERIFIED, live data)

Production `AnalyzedMessage` rows, 30 Aug 23:03:

```
by=llm intent=conditional_in action=BENCH  author=Amir  body="@Kemal Ediz my brother can play if needed"
by=llm intent=in            action=react   author=Amir  body="Shahrokh"
```

Production `Attendance` for match `cmtbro2270001tt9k1tyc10hw`:
`pos=10 BENCH Amir`, `pos=11 CONFIRMED Shahrokh`.

The brother got a squad place. Amir got put on the bench for a match he never
said he wanted to play in, while **four slots stood open**.

Root cause is a prompt rule with no subject check. `src/lib/message-analyzer.ts:352`
maps a "standing-offer conditional" to `registerAttendance: "BENCH"` for the
**sender**, and every example given is first-person ("I'll be the 14th",
"happy to fill in"). Nothing in the prompt or in the server requires the offer
to be *about the sender*. `src/app/api/whatsapp/analyze/route.ts:2170-2181`
then calls `registerAttendance(user.id, …, { forceBench: true })` on the author.

`forceBench` deliberately bypasses capacity (`src/lib/attendance.ts:132-136`),
so a squad with four openings acquired a bench player instead of a fourth
recruit. Then 13 recruit DMs went out to fill those slots
(`SentNotification` `recruit-dm` rows, 31 Aug 12:07 and 13:17).

---

## 1. SILENT FAILURES

### 1.1 The group path still tells players they are in when the write threw. (VERIFIED — HIGH)

`src/app/api/whatsapp/analyze/route.ts:2168-2194`:

```ts
try {
  if (verdict.registerAttendance === "IN" || … === "BENCH") {
    const result = await registerAttendance(...);
    finalReact = result.status === "CONFIRMED" ? "✅" : "🪑";
  } else {
    await cancelAttendance(...);
    finalReact = "👋";
  }
  ...
} catch (err) {
  console.error("[analyze] attendance update failed:", err);
}
```

The catch swallows. `finalReact` and `finalReply` keep whatever the LLM emitted
and are returned to the bot at `route.ts:2299`. The post-batch reconciliation
that would catch this (`route.ts:1428-1457`) computes the correct emoji from the
database — but `reactForStatus` returns `null` when **no row exists at all**
(`route.ts:1437-1438`), and the guard `if (want && …)` then skips the fix. So the
one case that matters most, "no attendance row was written", is exactly the case
the reconciliation cannot repair.

This is the identical bug fixed **today** on the DM path, commit `9f19040`
("never tell a player they're in when the write failed"), with a dedicated
`buildTentativeFollowupAck` and five tests
(`src/lib/__tests__/tentative-followup.test.ts:131-177`). The correct pattern
also already exists in `src/lib/out-of-band-self-attendance.ts:84-94,126-152`.
It was not applied to the highest-traffic path in the product.

`registerAttendance` genuinely throws in production conditions: the in-flight
guard at `src/lib/attendance.ts:61-65` throws whenever a previous match is still
un-completed, and any Prisma/Supabase blip throws too.

### 1.2 When there is no active match, the bot posts the LLM's unchecked reply. (VERIFIED — HIGH)

`findRegistrationMatch` returns `null` when a previous match is still in flight
(`src/lib/registration-match-select.ts:72-75`). Two things then happen:

1. `executeVerdict` skips the whole attendance block (`route.ts:2142`) and
   returns the LLM's react and reply untouched.
2. `nextMatchForReply` is also `null` (`route.ts:606-618`), so
   `enforceProximity`, `enforceCanonicalRoster`, the overconfident-promotion
   strip and the batch-final squad-status collapse **all skip**
   (`route.ts:1223`, `route.ts:1526`).

Result: the model's raw text goes into the customer's group with none of the
five correctness passes that exist specifically to stop it lying, and no row is
written. Blast radius is bounded by the 15-minute `complete-matches` cron
(`vercel.json`), so the window is short — unless that cron fails, in which case
it is permanent and invisible.

### 1.3 A failed write is recorded in the database as a successful one. (VERIFIED — HIGH)

`route.ts:1373-1377` writes `AnalyzedMessage.action` from
`verdict.registerAttendance ?? …` — the **intent**, not the outcome. An IN whose
write threw is persisted as `action: "IN"`, `handledBy: "llm"`. There is no way
to tell it apart from a success.

And nothing surfaces `handledBy: "error"` either. The only consumer of
`handledBy` outside the route is `src/app/admin/shadow/page.tsx:55`. The admin
"unresolved" queue (`src/app/actions/unresolved.ts:46-56`) filters on
`authorUserId: null`, which is a different failure. `handledBy: "error"` exists
nowhere in any admin view. The database currently holds zero such rows, which is
reassuring but also means the surface has never been exercised.

The partial-response admin DM (`route.ts:651-714`) is a genuinely good idea and
covers LLM-side drops well. It does not cover execution failures.

### 1.4 The LLM reasons about a different match than the one it writes to. (VERIFIED — MEDIUM, latent HIGH)

`route.ts:600-607` carries a comment stating the reply match "MUST be the exact
same match every attendance write lands on", and uses `selectRegistrationMatch`.
But the LLM's own context block is built by
`src/lib/message-analyzer.ts:805-812`, which was never updated and still uses
the old query:

```ts
status: { in: ["UPCOMING","TEAMS_GENERATED","TEAMS_PUBLISHED"] },
attendanceDeadline: { gt: now },
orderBy: { date: "asc" },
```

No in-flight guard, no shared selector. The two diverge whenever the active
match's deadline has passed. For Sutton `deadlineHours = 0`, so divergence
starts at kickoff and runs until the completion cron — the post-match window,
where the LLM sees next Tuesday's empty squad. For any org on the **default**
`deadlineHours = 5` (`prisma/schema.prisma:471`; both other orgs have it), it
starts five hours before kickoff, i.e. right through the 17:00 chase and the
late-drop rush. `src/lib/window-analyzer.ts:281` and
`src/lib/message-analyzer.ts:1145` carry the same stale filter.

Sutton's `deadlineHours = 0` looks like someone hit this and worked around it in
data rather than fixing it in code. The next club inherits the bug.

### 1.5 A missed time window is lost forever. (VERIFIED — MEDIUM)

The 17:00 evening update keys on `${matchId}:evening-update:${dayKey}` and only
fires when `londonHour >= 17 && < 18` (`src/lib/bot-scheduler.ts:917-919,940`).
The match announcement needs `lh >= 9 && lh < 13`
(`bot-scheduler.ts:875-882`). If the Pi is not polling during that hour, that
day's post never happens and nothing retries or reports it.

Live evidence: the current match has an `announce-match` on 28 Aug and one
`evening-update` on 30 Aug. There is no evening-update for 28 or 29 Aug, and on
29 Aug at 20:12 a manual `BotJob` was queued to post the squad by hand. Whatever
the cause, the system had no idea it had missed two days.

---

## 2. CORRECTNESS OF WHAT PEOPLE RELY ON

### 2.1 Money — the Stripe webhook cannot tell a paid bank transfer from a failed one. (VERIFIED — HIGH)

`src/app/api/stripe/webhook/route.ts:36-44` handles only
`checkout.session.completed` and `checkout.session.async_payment_succeeded`.
`applyCheckoutPaid` (`src/lib/payment-flow.ts:71-95`) stamps `paidAt`
unconditionally and never reads `session.payment_status`.

Pay by Bank is a delayed-notification rail: `completed` fires with
`payment_status: "unpaid"`, and settlement arrives later as either
`async_payment_succeeded` **or `async_payment_failed`**. There is no case for
`async_payment_failed`, `checkout.session.expired`, `charge.refunded` or
`charge.dispute.created`; `default: break` swallows them all. A bank payment
that fails after checkout leaves the player marked paid, the chase suppressed
(`src/lib/bot-scheduler.ts:1668`) and the collector out of pocket, with nothing
anywhere in MatchTime showing it.

Pay by Bank is live in the player menu (`src/app/pay/[matchId]/page.tsx:129`);
`MDs/SESSION-HANDOFF-2026-06-09-payments-golive.md:144` claims it is hidden and
is out of date — commit `dcb7dd8` re-enabled it.

Live blast radius today is small: only 3 attendances have ever carried a
`stripeSessionId`, and the current match has no fee set. It is a loaded gun, not
a fire.

### 2.2 There is no refund code anywhere. (VERIFIED — HIGH)

A repo-wide search for `refund` across `src`, `whatsapp-bot/src`,
`prisma/schema.prisma` and `scripts` returns one hit, and it is chat copy about
a venue booking (`src/lib/bot-scheduler.ts:1423`). If a match is cancelled after
people paid, or a player pays and is then benched, or a fee is confirmed wrong,
there is no path to return money and no record of a reversal. MatchTime will go
on reporting those players as paid.

Compounding it: `loadPayContext` (`src/app/actions/payments.ts:186-192`) checks
only that the match exists, a fee is set, and an Attendance row exists. It does
**not** check `match.status`, `attendance.status`, or `paidAt`. Pay links carry
`MAGIC_LINK_TTL.permanent` (`src/lib/payment-flow.ts:49`). So a link DM'd for a
match that is later cancelled still works, forever, and takes the money.

### 2.3 An unknown DM sender can become the money collector by display name. (VERIFIED — HIGH)

`src/app/api/whatsapp/dm-reply/route.ts:296-327`: when a DM sender's phone does
not resolve to a user, the code queries **every** payment-collecting org
platform-wide for its `paymentHolderId`, then matches the sender's WhatsApp
pushname — attacker-controlled free text — against those collectors' names,
including a **first-name-only** match. On a unique hit it does `user = pick`.

That identity then flows into every handler below it, including
`handleCollectorFeeReply` (`route.ts:545`), which accepts an amount, echoes a
confirm, accepts "✅", writes `Match.feePerPlayer` and calls
`releaseMatchPayments` — DMing the whole squad a pay link at the impostor's
amount (`src/lib/payment-flow.ts:206-224`). The confirmation goes back to the
**impostor's** phone (`route.ts:546-552`), so the real collector never sees it.
It also grants the impostor the collector's self-attendance and Q&A surface.

Sutton has exactly one collector, so the bar is "DM the bot from a WhatsApp
account whose pushname's first token matches the collector's first name". The
adjacent pushname fallback above it (`route.ts:252-292`) is correctly scoped to
users with an open roster survey; this one is scoped to nothing.

### 2.4 `PaymentCredit` is a floating counter nobody reconciles. (VERIFIED — MEDIUM)

Created from "Amir paid for 4 players" at `route.ts:2698-2707`. It is subtracted
only from the group-message unpaid **count**
(`src/lib/bot-scheduler.ts:280-285`). The per-player pay-chase loop
(`bot-scheduler.ts:1665-1690`) reads only `paidAt` and `directPendingAt`. So
those four players each keep getting a daily DM saying their money is
outstanding, with a live pay link, and can pay again. A credit is never linked
to a person, never consumed, and never reconciled. Creation is also not
idempotent and always targets "the most recent COMPLETED match"
(`route.ts:2626-2629`), not the one the admin was talking about.

### 2.5 The poll un-vote can wipe a real Stripe payment. (VERIFIED — MEDIUM, dormant)

`src/app/api/whatsapp/poll-vote/route.ts:126-129` writes
`paidAt: optionName ? new Date() : null` with no regard for `stripeSessionId`.
An un-vote nulls a genuinely-paid row; the chaser then re-sends a pay link and
`payByMethod` has no already-paid guard, so a second charge goes through.
Dormant for Sutton (`paymentTrackingEnabled = false`, checked live), and the
poll lookup is dead anyway (A2) — but the two flags are independent and any org
turning tracking on hits this.

### 2.6 A total-split fee makes the collector play for free. (VERIFIED — MEDIUM, product question)

`src/lib/payment-flow.ts:200-203` computes the split denominator as CONFIRMED
minus the collector, and `parseFeeReply` divides the stated total by it
(`src/lib/payments.ts:118-123`). "£142 total" with 14 who played, one of them
the collector, charges the other 13 £10.92 each — recovering the full £142 and
leaving the collector's own game free. The comment says this is deliberate, and
it consistently mirrors the "don't send the collector a link" rule. But
"exclude from charging" and "exclude from the denominator" are different
decisions, and the second one silently transfers the collector's share onto
everyone else. Worth confirming the club knows.

Rounding also disagrees with itself: `parseFeeReply` uses `Math.round`
(`payments.ts:121`), leaving the collector short, while `totalForMethod`
deliberately `Math.ceil`s so the residual favours them (`payments.ts:85`).

---

## 3. HONESTY OF WHAT THE BOT SAYS

Beyond A1 (asking for a 👍 it cannot receive) and A3 (telling players they are
not in a group they are in):

### 3.1 The prompt instructs the model to assert something false. (VERIFIED — LOW, but corrosive)

`src/lib/message-analyzer.ts:341`:

> "CRITICAL — the bench player is asked by an IN-GROUP @mention …, NOT a private
> DM. NEVER write 'in DMs' … that is factually FALSE (the bot does not DM bench
> players)"

The bot does DM bench players. `src/lib/bot-scheduler.ts:1305-1320` sends a
"Personal DM to each bencher" for every open offer. A rule written to stop the
model lying now forces it to describe the system inaccurately.

### 3.2 The unpaid tail points at a poll that cannot be ticked. (VERIFIED — dormant)

"tick your team in the poll above to clear it" — `src/lib/bot-scheduler.ts:294-297`.
Per A2 the tick is unrecoverable. Returns `null` for Sutton today because
tracking is off.

---

## 4. DATA MODEL GAPS

- **No `@lid` → user mapping.** `whatsapp-layer-hardening-2026-08-30.md`
  establishes this and it remains true: `lidId` is discarded by
  `src/lib/participant-sync.ts:52-56`, and the only durable bridge is
  `UserAlias`, keyed by normalised pushname. Identity for a privacy-mode player
  is therefore a **display name they control**, which is what makes 2.3
  possible and what makes every fuzzy resolver in the codebase load-bearing.
- **Ambiguous names are already present.** Live in Sutton: two users named
  `Akin` (one with a phone, one without), two `Mehmet*`, and **4 users with
  `name: null`**. Every fuzzy resolver — `route.ts:1782` (`resolveOrProvisionByName`),
  `dm-reply/route.ts:252-292`, `poll-vote/route.ts:72-101` — decides only on a
  unique match, so these collapse to "no match" rather than a wrong match. Safe,
  but it means those players' messages resolve to nobody. The null-name users
  render as `(unnamed)` in every roster (`bot-scheduler.ts` roster block).
- **An OUT from someone never IN writes nothing.** `cancelAttendance` throws
  "Not attending this match" (`src/lib/attendance.ts:287`); the analyze path
  pre-checks and stays silent (`route.ts:2153-2166`). Correct as far as it goes,
  but there is no representation for "asked, said no", so the recruit chase has
  to infer a reply from four separate proxy signals
  (`bot-scheduler.ts:1130-1160`), one of which is "did we DM them for any
  reason since".
- **`SentNotification` is doing four jobs**: dedupe key, dispatch claim,
  reaction anchor, and now a text-repetition ledger keyed `txtlog:` with a null
  `matchId` (`MDs/SESSION-HANDOFF-2026-08-27.md`). Each new job has needed a
  careful argument about why it is inert to the other three readers. That is a
  table that will eventually be got wrong.

---

## 5. LLM VS DETERMINISTIC CODE

The stated principle — "LLM extracts, code decides" — is right, and the pure,
unit-tested selectors (`registration-match-select.ts`, `next-upcoming-match.ts`,
`promote-authorization.ts`, `interaction-contract.ts`, `recruit-chase.ts`) are
the best part of this codebase. But the boundary has drifted in one direction.

**`src/app/api/whatsapp/analyze/route.ts` now contains twelve regex-based
seatbelts** applied to the model's output before it is executed: hypothetical/
past-tense strip (`:764-787`), tag gate (`:794-819`), attendance-off drop
(`:828-855`), colour swap (`:857-884`), team swap (`:886-914`), conditional-drop
hold (`:916-956`), IN backfill (`:958-991`), OUT backfill (`:993-1050`),
bench-demote synthesis (`:1052-1105`), banter-drop guard (`:1107-1177`),
generate-teams dedupe (`:1179-1194`), plus four reply post-processors. Each was
added after a named production incident, and each is individually defensible.
Collectively they are a second, undocumented classifier whose interactions
nobody can hold in their head.

The worst of them is the OUT backfill at `route.ts:1030-1043`, which decides
whether to drop a player from the squad by **running regexes over the model's
free-text `reasoning` prose**:

```ts
const strongDrop = /\b(definite|definitely)\s+(drop|out)\b/.test(r) || …
if (strongDrop && !notDropping) { verdict = { …verdict, registerAttendance: "OUT" }; }
```

The comment above it records that the previous version of this regex wrongly
dropped Kemal on 2026-05-28. The prose being parsed is not a stable interface;
a model upgrade or a prompt tweak silently changes what these regexes match, and
the failure mode is dropping a real player from a paid match. If the signal is
needed, the model should emit a structured field for it. This is the clearest
case in the codebase of asking prose to do a schema's job.

Going the other way: **the `conditional_in` (a) rule at
`message-analyzer.ts:352` should not be an LLM judgement at all** in its current
shape (see A5). "Is this offer about the sender or a third party?" is a question
the model can answer, but the *consequence* — a `forceBench` write that bypasses
capacity — is severe enough that it needs the same sender-subject seatbelt the
IN and OUT paths already have. Today it has none.

---

## 6. SECURITY, PRIVACY, TENANCY

### 6.1 Password injection onto passwordless accounts, plus an unthrottled 6-digit code. (VERIFIED — HIGH)

`src/app/actions/auth.ts:20-29` lets **any unauthenticated caller set a password
on any existing user that has none**:

```ts
if (existing) {
  if (existing.password) { throw ... }
  const hashedPassword = await bcrypt.hash(parsed.password, 12);
  await db.user.update({ where: { id: existing.id }, data: { password: hashedPassword } });
}
```

Live check: **all 130 users have `password: null`.** So every account is a valid
target, including both admins (Kemal on Sutton, Amir on Sutton Lads).

The email is derivable — bot-provisioned players get
`wa-<phone>@placeholder.matchtime` (`src/app/actions/players.ts:322`,
`src/lib/onboarding-conversation.ts:443`), and everyone in the WhatsApp group
can see everyone's phone number.

`verifyEmail` (`src/app/actions/auth.ts:63-83`) then has **no attempt counter,
no lockout and no rate limit** on a 6-digit code, and `resendVerification`
(`:88`) mints fresh 10-minute windows unthrottled. There is no rate-limiting
anywhere in the repo.

Honest severity: the brute force is 900k-wide against a 10-minute window, so
this is sustained-effort rather than trivial, and Vercel would notice the load.
But step 1 — writing a password onto someone else's account — is unambiguous and
is a two-line fix. All 130 accounts also have `emailVerified: null`, so there is
no one-step variant available today.

**Contrast:** the phone OTP flow is done correctly —
`src/app/actions/phone-signup.ts:109-128` has `crypto.randomInt`, 10-minute
expiry, `usedAt` consumption, a 5-attempt cap and 3 codes per hour per phone.
That is what the email flow should look like.

### 6.2 100-year magic links are full-privilege sign-in credentials. (VERIFIED — HIGH)

`src/lib/magic-link.ts:118` defines `permanent: 100 * 365 * 24 * 60 * 60`. The
magic-link credentials provider (`src/lib/auth.ts:49-70`) verifies the HMAC and
returns a full session; the token's `purpose` field is **never consulted for
authorisation**. A "your season stats, any time" link is therefore an
unrevocable admin session if it belongs to an admin.

These are DM'd routinely: pay links (`src/lib/payment-flow.ts:45-50`), stats
links (`src/lib/bot-scheduler.ts:1677,1805`), and the stats card is explicitly
designed to be shared. `ShortLink` has no `usedAt` (`src/lib/short-link.ts:74-82`),
so a short code is replayable forever too. There are 6,514 `ShortLink` rows with
no cleanup. Revocation means rotating `AUTH_SECRET`, which kills every
outstanding link at once.

The crypto itself is right: HMAC-SHA256, `timingSafeEqual` behind a length check
(`magic-link.ts:74-79`), 8-byte random codes with collision retry
(`short-link.ts:23-27,56-60`), and a `//`-rejecting same-origin `nextPath` guard
(`src/app/r/[token]/page.tsx:105-111`). The authority model is what is wrong.

### 6.3 Unauthenticated arbitrary-content DM from the club's bot number. (VERIFIED — HIGH for business continuity)

`src/app/actions/phone-signup.ts:43-44,79-89`: `startPhoneSignup` is
unauthenticated, `name` has a minimum length but **no maximum and no
sanitisation**, and it is interpolated into a `BotJob` that the Pi delivers as a
WhatsApp DM to an attacker-chosen number. Three per hour per target, unlimited
distinct targets, no CAPTCHA.

For a business that is one unofficial WhatsApp account, the realistic outcome is
Meta banning the number. That is a total outage no code change fixes. The
account has already taken a 21h spam restriction once
(`whatsapp-bot/src/scheduler.ts:34-40`).

### 6.4 Cron routes fail open if `CRON_SECRET` is unset. (VERIFIED — MEDIUM, latent)

All five compare `authHeader !== \`Bearer ${process.env.CRON_SECRET}\`` —
e.g. `src/app/api/cron/complete-matches/route.ts:29`. With the variable missing,
the literal string `"Bearer undefined"` authenticates. The WhatsApp routes get
this right by accident of types (`headers.get()` returns `string | null`, never
`=== undefined`), so they fail closed — copy that shape.

### 6.5 Cross-org reads. (VERIFIED — LOW today, structural)

`src/app/api/players/[playerId]/route.ts:15-32` authenticates and then does a
bare `findUnique` selecting `email` **and `phoneNumber`** with no org check.
Same at `src/app/api/matches/[matchId]/route.ts:14-43` and
`src/app/matches/[matchId]/page.tsx:24-47`. `unresolvedCount`
(`src/app/actions/unresolved.ts:88-102`) omits the `requireOrgAdmin` its sibling
has. `seedPlayerRating` (`src/app/actions/players.ts:161-175`) and
`ensureOrgPlayer` (`:661-666`) let an admit of one org touch or absorb a user
from another. `/api/wrapped/[playerId]` is fully public and renders a
1080×1350 PNG per request with no `(org, player)` pairing check
(`src/app/api/wrapped/[playerId]/route.tsx:24-44`, allowlisted at
`src/middleware.ts:27`).

Ids are cuids so none of this is enumerable, and there is one paying club. These
stop being theoretical the day there are two.

### 6.6 Bench prompts print raw phone numbers into the group. (SUSPECTED — MEDIUM)

`src/lib/bot-scheduler.ts:1281` builds `tagList` as `@447…` strings and passes
`mentions` as `${phone}@c.us` (`whatsapp-bot/src/scheduler.ts:211-212`). For a
member whose WhatsApp identity is an `@lid`, the `@c.us` JID will not match and
WhatsApp renders the literal text — i.e. bench players' mobile numbers, in the
group. I could not confirm the rendering without a live WhatsApp session, and
the club already sees each other's numbers, so impact is limited. Flagging
because the same construction is used for the payment chase.

---

## WHAT IS GENUINELY SOLID — do not re-harden

- **Claim-on-dispatch and the instance lock.** `src/lib/dispatch-claim.ts` plus
  `whatsapp-bot/src/instance-lock.ts` and `scripts/deploy-pi.sh`. The at-most-once
  trade-off is correctly reasoned and correctly documented, the P2002 arbiter is
  the right mechanism, and the 625-line test file
  (`src/lib/__tests__/dispatch-claim.test.ts`) is serious. The reshaped
  repetition guard (guard on repetition, not volume) is the right insight.
- **The pure-function core.** 675 unit tests over 38 files run in 547ms because
  the decision logic is genuinely pure. `registration-match-select.ts`,
  `next-upcoming-match.ts`, `match-slot.ts`, `promote-authorization.ts`,
  `recruit-chase.ts`, `payments.ts`, `block-booking.ts` are all clean, well
  documented, and testable. This is the asset the product is built on.
- **The org-admin authorisation pattern.** `requireOrgAdmin` / `isOrgAdmin`
  (`src/lib/org.ts:99-112`) resolve the org **from the resource**, never from the
  request. Across all 47 server actions the mutating admin paths follow it. The
  `orgId` cookie is re-verified against the database on every read
  (`org.ts:47-52`). `src/app/actions/block-bookings.ts:280-284,341-345`
  explicitly refuses batches spanning orgs rather than checking only the first
  element. That is the bug I went looking for and it is not there.
- **Stripe pricing and tenancy on the charge side.** `totalForMethod`
  (`src/lib/payments.ts:78-86`) solves the gross-up correctly and ceils so the
  collector never nets short; the client button and the server charge call the
  same function (`src/components/pay/pay-options.tsx:73`), so displayed price
  cannot diverge from charged price. Pence conversion happens once, at the
  boundary (`src/lib/stripe.ts:138`). No client-supplied amounts anywhere.
  Webhook signature verification is real (`src/lib/stripe.ts:174-179`). The
  connected account is always read from the match's own org
  (`src/app/actions/payments.ts:163-185`).
- **Phone OTP** (`src/app/actions/phone-signup.ts:109-128`) — see 6.1.
- **Rating and MoM submission** (`src/app/actions/ratings.ts:26-31,183-188`) —
  participation-gated, window-gated, self-rating blocked, targets validated
  against an attendee allow-list.
- **DST handling in block bookings.** `src/lib/block-booking.ts:144-151` resolves
  each occurrence London→UTC per calendar date, and the create form previews
  every resolved kickoff before confirming. Verified against live data: the block
  contains `20 Oct = 20:30Z` and `27 Oct = 21:30Z`, both 21:30 London.
- **The honest-ack pattern.** `src/lib/out-of-band-self-attendance.ts:84-152` is
  exactly the right model — derive the message from what the database did, never
  from what you asked it to do. The problem is that it exists in two places and
  needs to exist in all of them.
- **The degraded-mode logging.** `whatsapp-bot/src/degraded.ts` and the
  `degradedMessage()` call sites produce the best operational log lines I have
  seen in a codebase this size: they name the product consequence, not the
  symptom. That is why this audit could diagnose five live problems from one
  `tail`.

---

## THE THREE THINGS I WOULD FIX FIRST

**1. Fix the WhatsApp injected layer, and finish the id work.**
One root cause is behind A1 through A4: bench 👍 dropped, participant sync dead
so players are locked out of the app with a false message, restart losing
messages, and every sent message losing its id. Two moves: pin `WA_WEB_VERSION`
(or upgrade whatsapp-web.js) to stop the bleeding, and apply the
`resolveWaMessageId` reconstruction technique already proven in
`whatsapp-bot/src/message-id.ts:111-125` to the **three paths it was never
applied to** — `message_reaction` (`index.ts:600`), `vote_update`
(`index.ts:654`), and `sendMessage` results (`send-result.ts:39-52`). Until
then, remove "React 👍 here" from the bench prompt
(`bot-scheduler.ts:1290-1292`) the same way `RECRUIT_DM_MENTION_REACTIONS`
already removed it from the recruit DM. The bot must not ask for something it
cannot receive.

*Why first:* it is the only finding that is actively costing this club today,
it is one cause with five symptoms, and the club's own product promise (a slot
opened, tap to claim it) is currently a dead end.

**2. Apply the honest-ack rule to the group path, and make a failed write
visible.**
`analyze/route.ts:2192-2194` must not react ✅ or post a reply when the write
threw; `route.ts:2142` must not let the LLM's unchecked text through when there
is no active match; `route.ts:1373-1377` must record what happened, not what was
intended; and `handledBy: "error"` needs somewhere a human will see it. The
correct implementation already exists in
`src/lib/out-of-band-self-attendance.ts` and was applied to the DM path today in
`9f19040` — this is the same fix on the path that carries 20x the traffic.

*Why second:* this is the failure class the product has a documented history of,
the one that ends with a player at the pitch who is not on the list, and the
tooling to fix it is already written.

**3. Close the money paths that can take or lose real money.**
In order: handle `payment_status` and `async_payment_failed` / `expired` /
`refunded` in the webhook (`src/app/api/stripe/webhook/route.ts:36-44`); delete
the pushname collector fallback at `dm-reply/route.ts:296-327`; and guard
`payByMethod` on `paidAt == null`, `match.status !== "CANCELLED"` and
`attendance.status === "CONFIRMED"` (`src/app/actions/payments.ts:186-241`).

*Why third and not first:* only 3 Stripe payments have ever settled and the
current match has no fee set, so nothing is being lost this week. But the club
is one "£142 total" DM away from exercising all three, and unlike a squad bug a
money bug cannot be fixed by re-typing a message — there is no refund code in
the product at all.

---

*Also worth doing early because they are two-line changes with high downside:*
refuse `signUpWithEmail` against accounts that already exist without a password
(`src/app/actions/auth.ts:20-29`), add an attempt cap to `verifyEmail`
(`:63-83`), clamp and strip `name` in `startPhoneSignup`
(`src/app/actions/phone-signup.ts:43-44`), and switch the five cron routes to
the fail-closed comparison the WhatsApp routes already use.
