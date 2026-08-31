# Session handoff, 2026-07-18 to 2026-08-27

Picks up where `SESSION-HANDOFF-2026-07-14.md` left off. Covers the
duplicate-send incident, the block-booking feature, the summer break, and
the season restart.

---

## ✅ STATUS: LIVE AND HEALTHY (verified 27 Aug 2026, ~20:30 London)

The season is configured and the bot is connected. Nothing outstanding.

Verified end to end after the WhatsApp re-pair:

| Check | Result |
|---|---|
| WhatsApp auth | ready, `Monitoring 1 group(s)` |
| Bot processes on the Pi | exactly 1 |
| Live matches in block | 20 |
| **Postable right now** | **exactly 1** (Tue 1 Sept) — the other 19 silent |
| Sent in last hour | 0 |
| Pending BotJobs | 0 |

First announcement goes out **09:00 London on Fri 28 Aug** (the natural
window — Kemal chose not to queue an early one). Daily attendance chase at
17:00 thereafter.

### Historical note: the QR outage that blocked this

On 27 Aug the bot sat in a QR-code loop and could neither send nor receive.
The `.wwebjs_auth` session folder was rebuilt at **12:50**, roughly seven
hours BEFORE the Pi was restarted at 19:48 — so the session had already
dropped earlier that day; the restart surfaced it rather than caused it.
Do NOT assume `pkill -9` in `deploy-pi.sh` corrupted it. Resolved by
scanning a fresh QR with the burner phone.

Worth knowing for next time: `initScheduler` and `startBatchFlushTimer`
both live INSIDE `client.on("ready")` (`whatsapp-bot/src/index.ts:63,105,112`),
so while auth is lost the bot does not even poll `/api/whatsapp/due-posts`
and NOTHING sends, queued or not. Queued BotJobs persist and fire ~30s
after a successful scan.

To re-pair if it happens again:

```bash
ssh davidediz@matchtime-pi.tail1437f5.ts.net 'tail -f ~/matchtime-bot/bot.log'
```

Scan a freshly-printed QR (they rotate every ~20s): WhatsApp → Linked
devices → Link a device. Success is `WhatsApp bot is ready!` then
`Monitoring 1 group(s)`.

---

## 1. THE DUPLICATE-SEND INCIDENT (2026-07-19) — 30+ copies of one message

A customer group received 30+ copies of the same roster post in ~20
minutes.

**Root cause: duplicate bot processes on the Pi.** Repeated
`sudo systemctl restart` had left node processes running OUTSIDE systemd's
cgroup (confirmed: two `sh -c node … src/index.ts` trees while `MainPID`
tracked only one). Every orphan was logged into the same WhatsApp account
and every one polled due-posts on a 30s timer.

The dedupe key was only written when the bot ACKed — i.e. AFTER composing
text via an LLM and sending. Inside that window **every process received
the same instruction and every one sent it.** They then all ACKed the same
key, which upserts, producing exactly ONE `SentNotification` row. **That is
why the group saw 30+ messages while the database looked perfectly
healthy** and the first pass of diagnosis found nothing.

### Fixes shipped (PR #9, `822ed77`)

- **Claim-on-dispatch.** `/api/whatsapp/due-posts` now creates the
  `SentNotification` row at hand-off, using the existing `@unique` on
  `key` as the arbiter: first writer wins, concurrent claimants get
  **P2002** and skip. Tested with a 30-poller race → exactly 1 send. ACK is
  demoted to an idempotent update.
- **Trade-off, deliberate: delivery is now AT-MOST-ONCE.** A bot that
  claims an instruction then dies before sending loses that message. A
  missed roster post beats 30 duplicates. Two cases are explicitly
  RELEASED (claim row deleted, only while `waMessageId IS NULL`): the
  bot's DM rate-limiter hold, and unknown instruction kinds. A send that
  THREW is deliberately not released — it may have landed.
- **Circuit breaker.** `MAX_GROUP_MESSAGES_PER_HOUR = 10` per org (normal
  traffic is 1-2 group posts/day). Trips → nothing claimed, logs CRITICAL.
  **SUPERSEDED 2026-08-31 — see "Outbound guards" below.**
- **`scripts/deploy-pi.sh`** — the ONLY sanctioned way to restart the bot.
  Stops the unit, kills orphans by PROCESS PATTERN (cgroup membership is
  exactly what orphans escape), verifies zero, starts once, verifies
  EXACTLY ONE, exits non-zero otherwise. **Never use bare
  `systemctl restart` again.**
- **Startup instance lock** (`whatsapp-bot/src/instance-lock.ts`):
  liveness-verified pidfile, steals dead locks. Under systemd it exits **0**
  so `Restart=on-failure` cannot cause a respawn storm.

### Outbound guards, reshaped (2026-08-31)

The raw volume cap above was the wrong shape and has been replaced. It
gagged the bot exactly when a group was busiest — match day, players
dropping out, questions flying — and every message it suppressed was
legitimate. Normal traffic is 1-2 group posts/day, but a chaotic Tuesday
can plausibly clear 10/hour with entirely real replies.

The insight: **a runaway sends many copies of the SAME message; a busy
match day sends many DIFFERENT messages.** So guard on repetition, not
volume.

| Guard | Constant | Behaviour |
|---|---|---|
| **Repetition** (the real protection) | `MAX_IDENTICAL_GROUP_MESSAGES = 3` over `REPETITION_WINDOW_MS = 5 min` | The same normalised group text a 4th time inside 5 minutes is refused. Per-message: only the repeat is dropped, every other post still goes. Logs CRITICAL. |
| **Volume ceiling** (last resort) | `MAX_GROUP_MESSAGES_PER_HOUR = 40` over the same 1-hour window | Should never fire. If it does it is an incident, not a tuning problem. Whole-org stop, logs CRITICAL. |

Both apply to `GROUP_DIRECTED_KINDS` only. **DMs are gated by neither** —
a player asking a question or dropping out must always get their reply,
and identical DM text across many players is completely normal.

**Where the recent text comes from, with no migration.** `SentNotification`
has no body column and adding one was not on the table. Every dispatched
group post now also writes a ledger row into the table we already write
to:

```
key  = txtlog:<orgId>:<sha256-16 of normalised text>:<instructionKey>
kind = outbound-text-log
```

It is inert to every existing reader: the scheduler's dedupe set only
loads rows joined to this org's matches or keyed `org-<id>:`; the hourly
count filters on `kind IN GROUP_DIRECTED_KINDS` and this kind is
deliberately not one of them; poll-vote matches on `waMessageId`, null
here; `planAckSideEffects` has no `txtlog:` branch. `matchId` is left
null on purpose, which does mean `wipe-org` will not sweep these (same
as the existing `botjob-` rows).

Both guards are **best-effort and fail open**: if the ledger read throws
the guard degrades to within-batch only, and if the ledger write throws
the message still goes out. A broken guard must never silence a
customer's group.

Normalisation is trim → collapse whitespace runs → lowercase. Lowercasing
costs nothing in detection (a runaway re-renders one template, so its
copies never differ in case) and catches near-duplicates that differ only
by casing.

Decision logic is pure and unit-tested (`evaluateRepetition`,
`evaluateCircuitBreaker`); the DB reads/writes live in the route.

### Diagnostic gotchas worth remembering

- `pgrep -f "sh -c node --env-file"` **also matches the invoking SSH
  shell's own command line**. This wasted real time during diagnosis —
  exclude `$$`/`$PPID` or count a different way.
- The service has `Restart=on-failure`, so a bare `pkill` triggers a
  respawn; stop the unit first or you end up chasing your own tail.
- `SentNotification` rows keyed `botjob-…` are written with `matchId =
  NULL`, and the scheduler's dedupe set is built from
  `OR: [{ match: { activity: { orgId }}}, { key: { startsWith: 'org-<id>:' }}]`
  — so those keys are **invisible** to it. Saved today only by the separate
  `sentAt` guard, and now moot because the claim is authoritative.

---

## 2. BLOCK BOOKINGS + ADMIN BULK CANCEL (PR #10, `f345522`)

Built because the admin had no way to cancel a run of future matches and
had to ask an engineer to run scripts and switch the whole bot off.

**Model.** `BlockBooking` (orgId, activityId, startDate, endDate, time,
`costPerMatch`, notes) + `Match.blockBookingId` with **ON DELETE SET NULL**
so deleting a block detaches rather than destroys history. Migration SQL at
`prisma/migrations/20260720100000_block_bookings/`. **Already applied to
prod** (table created, column added, 41 match rows intact).

**Posting rule — "don't post until it's on".** No new gate was needed:
`isNextUpcomingForPosting` (`src/lib/next-upcoming-match.ts`) already
suppresses any match with an earlier LIVE match in the same recurring
fixture; COMPLETED/CANCELLED stop blocking. That is exactly
"on = not cancelled AND previous finished". With 20 future matches, only
the soonest is ever announced.

**DST is handled and verified in production.** Occurrences resolve
London→UTC per calendar date. Real proof from the live block: 20 Oct =
`20:30Z` (BST) but 27 Oct = `21:30Z` (GMT), both showing 21:30 London. A
naive implementation puts the last matches an hour out.

**Admin screens:**

- `/admin/block-bookings` — list blocks, per-block silent cancel-remaining
  / restore / delete.
- `/admin/block-bookings/new` — create form, **previews every date with its
  resolved kickoff before confirming** (this is where a DST error would
  otherwise be invisible).
- `/admin/matches/bulk` — date-range bulk cancel/restore, tick-list, warns
  where players are already IN.

**Silence guarantees:** creating a block emits ZERO group messages. Bulk
cancel emits zero **by default** — it does NOT reuse `cancelMatch` (which
queues an announcement); `buildBulkCancelAnnouncement` returns `null`
unless the admin explicitly ticks announce. Restore and delete are always
silent.

---

## 3. SUMMER BREAK (July → 27 Aug)

Applied when the club paused for holidays:

- Both Tuesday activities set `isActive: false` (stops the weekly cron
  generating matches — this was the important one, otherwise a fresh match
  appears every Tuesday all summer, each with its own announcements).
- The 21 Jul match set to CANCELLED **directly in the DB** so it did NOT
  post a cancellation announcement.
- `whatsappBotEnabled: false`.

---

## 4. SEASON RESTART (27 Aug 2026) — current state

**Block created:** `1 Sept 2026 → 12 Jan 2027`, 20 consecutive Tuesdays
21:30, £142/match = **£2,840** total. The venue's original 25 Aug slot was
already past and is NOT included.

Kemal chose to **keep all 20 including 22 and 29 Dec** (festive period).
They can be bulk-cancelled from `/admin/matches/bulk` if plans change.

**State now:**

| Thing | Value |
|---|---|
| `whatsappBotEnabled` | **true** |
| `tuesday-7aside.isActive` | **true** |
| `tuesday-5aside.isActive` | false |
| Matches in block | 20, all UPCOMING |
| Next match | Tue 1 Sept 2026, 21:30 London (`20:30Z`) |
| Pi git HEAD | `9c1fbad` |
| Pi processes | exactly 1 (verified via `deploy-pi.sh`) |
| WhatsApp auth | ✅ ready (re-paired 27 Aug ~20:20) |

**Payment-chase risk checked and cleared:** there are 101 CONFIRMED
attendances with `paidAt = null`, but every one belongs to a match whose
payment links were released **43+ days ago**, far outside the 10-day chase
cap, and there are ZERO completed matches in the scheduler's 14-day
window. Re-enabling cannot trigger a wave of "you owe money" DMs.

**`bot-intro` already sent** for this org, so enabling does not re-post the
one-time introduction. The `org-…:provisional-review:<date>` keys are
per-day admin DMs to Kemal about unreviewed guest players (Kieran, Rashad,
Ayoub) — expect one; harmless, not a group post.

---

## 5. POSTING WINDOWS (why nothing fires immediately)

Both are London local, in `src/lib/bot-scheduler.ts`:

- **Match announcement** ("Say IN to join"): `lh >= 9 && lh < 13`, and only
  when `hoursUntilMatch > 24`.
- **Daily attendance chase / evening roster**: `londonHour >= 17 && < 18`.

These exist so the bot only posts at sociable hours. If a window has passed
for the day, the next post is the following day. To bypass a window, queue a
`BotJob` (`kind: "group"`) — it sends on the next poll, ~30s.

---

## 6. DECISIONS MADE (do not re-litigate)

- **Per-player match fee stays MANUAL.** The block's `costPerMatch` (£142)
  is only a record of what is owed to the venue; it must NOT auto-drive the
  player fee, because turnout varies week to week and the fee is split
  across who actually played.
- **Festive dates kept** (22 + 29 Dec 2026).
- **Block starts 1 Sept**, not the venue's original 25 Aug.

---

## 7. PROCESS FEEDBACK FROM KEMAL (2026-08-27)

He pulled me up for drifting off the agreed workflow. Recorded in memory
(`feedback_subagent_dev_and_review`):

- **All dev/code work goes to a subagent that opens a PR, and the main
  session reviews the diff before merging.** That held for PRs #8/#9/#10;
  it slipped during the season restart.
- **Do not stretch the "ops" carve-out.** A read-only peek or a one-line
  data flip is ops. A 40-line script with real logic that writes to prod is
  NOT — that goes through a subagent + PR + review.
- **Prefer the shipped feature over a bypass script.** Once
  `/admin/block-bookings` exists, use it (or drive it in the browser)
  instead of hand-rolling a script. Bypassing means the real code path
  never gets exercised and Kemal never sees the UI working.
- Run parallel agents in **isolated worktrees** — two agents shared one
  working tree on 20 Jul and collided mid-commit. No damage (zero file
  overlap, both PRs verified clean) but avoidable.

---

## 8. OPEN ITEMS

1. ~~Scan the QR~~ — **done 27 Aug**, verified connected.
2. ~~Verify only the 1 Sept match announces~~ — **done**, postable count
   confirmed as exactly 1 against live data.
3. **Watch the first real post at 09:00 Fri 28 Aug.** Confirm exactly one
   announcement lands (not 20, not duplicated). This is the first live
   exercise of both the block-booking gate AND claim-on-dispatch.
4. **Recovery-window weakness, still unfixed** (from the 7 Jul outage):
   `recoverGroupMessages` only re-feeds the last 2 hours, and right after a
   restart `fetchMessages` often cannot load history and falls back to just
   the last cached message. A long outage is therefore NOT reliably
   recoverable. Suggested fix: recover since **last-seen** rather than a
   fixed 2h window.
5. **Single Pi, no failover.** When it drops, the bot goes fully dark.
   Worth a watchdog or moving off a home Pi.
6. **Set the per-match fee by hand** each week once the squad is known
   (£142 ÷ turnout; 14 players ≈ £10.15).

---

## 9. QUICK REFERENCE

```bash
# Restart the bot — the ONLY sanctioned way
ssh davidediz@matchtime-pi.tail1437f5.ts.net 'cd ~/matchtime-bot && sudo ./scripts/deploy-pi.sh'

# Watch the bot log (and see the QR)
ssh davidediz@matchtime-pi.tail1437f5.ts.net 'tail -f ~/matchtime-bot/bot.log'

# Health check
ssh davidediz@matchtime-pi.tail1437f5.ts.net \
  'systemctl is-active matchtime-bot.service; pgrep -c -f "^node --env-file"'
```

Tailscale SSH periodically demands a browser re-auth; it prints a
`login.tailscale.com` URL and the connection closes. It is not a Pi fault.

Prod scripts used this session live in `scripts/` (untracked):
`create-sutton-block.ts`, `extend-sutton-block.ts`, `verify-block.ts`,
`enable-sutton.ts`, `check-reenable.ts`.

---

## 10. INBOUND OUTAGE, 30 Aug 2026 — every "IN" was silently discarded

Attendance tracking was dead for ~3 days before the Tue 1 Sept fixture.
The bot was connected and healthy (`bot is ready`, 1 group, exactly 1
process, 18.5h uptime) and `[msg]` lines scrolled for every inbound
message, but **zero `AnalyzedMessage` rows were written**.

**Root cause.** `enqueueForAnalysis` opened with:

```ts
const waMessageId = waMessageIdFrom(msg);
if (!waMessageId) return;
```

`waMessageIdFrom` came from `send-result.ts` (PR #11), where a missing id
genuinely means "there is nothing to ACK". Reusing it on the INBOUND path
turned "we couldn't read an id" into "bin the message". Once
whatsapp-web.js's injected page code fell out of step with the live
WhatsApp Web build (the minified `r: r` failures), inbound `Message`
objects stopped exposing `id._serialized` and **every** group message hit
that `return` before it was buffered.

It was invisible because `flushGroup` early-returned on an empty buffer
**without logging**, so ~111 flushes over 18.5h said nothing at all.

**Fix (PR #13, `fix/inbound-missing-message-id`).**

- An unreadable id now degrades to a deterministic synthetic id,
  `synthetic:<16 hex of sha256(from ⊘ author ⊘ timestamp ⊘ body)>`
  (`whatsapp-bot/src/message-id.ts`). No `Date.now()`, no randomness, no
  counter: `/api/whatsapp/analyze` dedupes on `waMessageId`, so the id
  MUST hash the same when `recoverGroupMessages` replays the last 2h, or
  attendance would be registered twice.
- Every remaining raw read in the enqueue path (`from`, `author`, `body`,
  `_data.body`, `mentionedIds`, `timestamp`) is now total — on a broken
  build any of them can be a throwing getter, and any throw lost the
  message exactly like the id guard did.
- `index.ts`: the DM path sent `msg.id?._serialized ?? ""` and
  `/api/whatsapp/dm-reply` **400s on an empty waMessageId**, so DM replies
  (bench confirmations, tentative follow-ups, collector fee replies) were
  dropped by the same failure. It now uses the same resolver. The
  unmonitored-group setup trigger's `client.info.wid` / `mentionedIds`
  reads are guarded too.
- Diagnostics: per-process counters (`seen`, `buffered`, `synthetic`,
  `notGroup`) printed on every empty flush, e.g.
  `[smart] flush <gid>: buffer empty (seen=340 buffered=0 synthetic=0 notGroup=0)`.
  **`seen` far exceeding `buffered` is the signature of this class of
  failure** and is now visible within 10 minutes instead of never. The
  first synthetic id logs CRITICAL, then rate-limited (1, 10, 100, then
  every 1000).

**Known degradation.** Messages carrying a synthetic id cannot be matched
by the `message_reaction` handler (that event carries a real WhatsApp id),
so a 👍/👎 on such a message is not mapped back. Attendance registration,
which is what matters, works.

**Watch for after deploy:** `[smart] flush … buffer empty (seen=… buffered=…)`
lines, and any `CRITICAL: could not read id._serialized` line — the latter
means the library is still out of step and `WA_WEB_VERSION` /
whatsapp-web.js should be revisited.
