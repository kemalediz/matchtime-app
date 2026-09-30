# Friday group features: rolling squad, organiser-picked bench, weekly deadlines, 9-a-side

Design only. 2026-09-30. No code in this PR.

Written for Hamzah's Friday 9-a-side group (admins Hamzah, Raihan, Wasim) after Kemal's demo. Everything here is a per-club setting that is OFF by default, so Sutton FC (`cmnnwhdx30000zfr85q18lyy9`) behaves exactly as it does today.

---

## Summary for Kemal (one screen)

**What Hamzah's group does today, by hand:** if you played last week you are in this week unless you tell an admin you can't. Payments happen over the weekend. Monday is the drop-out deadline and chase day. The list goes out Tuesday evening. When a place opens, the admins choose who fills it from the waiting list, by position and preference, not first come first served. They pay by bank transfer. Their worry is "losing control as to who's playing".

**What we build, in four PR-sized slices:**

1. **Rolling squad.** At 08:00 the morning after a match, everyone who actually played it (confirmed at the final whistle) is put straight into next week's squad. The morning post says "You're in unless you say OUT by Monday 21:00." Bench players, phoneless guests and anyone who has left the group are not carried over. An OUT after the deadline still counts (the squad must be true), but the admins get a DM saying it was late. No model calls are added; the club's scheduled chase posts actually switch from the model-written text to fixed text, so it costs less.
2. **Organiser picks from the waiting list.** MatchTime never fills an open place by itself. Anyone who says IN goes on the waiting list. When a place is open and someone is waiting, the owner and admins each get one DM: "Hamzah dropped out. Waiting list: 1. Kemal (GK, 7.4) 2. Wasim (MID, 7.9). Reply with a name or number." The first admin to reply wins; the others get "Done: Wasim is in (picked by Raihan)". Replies are read by code, never by a model. If nobody picks in time, MatchTime offers the place to the whole waiting list, first to say IN (recommended; "leave it empty" is the other option). The match page gets a waiting list the admins can reorder and pick from.
3. **Weekly deadlines.** Two club settings: drop-out deadline (e.g. Monday 21:00) and list publish time (e.g. Tuesday 20:00). MatchTime posts a reminder in the group 3 hours before the deadline, DMs the admins a summary (and the waiting list to pick from) when it passes, and posts the final list at publish time. The daily 17:00 post is replaced by this rhythm for these clubs, except on match day.
4. **9-a-side preset.** `football-9aside`: GK 1, DEF 3, MID 3, FWD 2 per team, 18 players. 8-a-side from #148 checked and fine.

**How an organiser turns it on:** a new "Weekly routine" section on `/admin/settings`, each setting with an ⓘ explaining it (EN and TR). Not in the in-group setup chat for now.

**Order:** slice 4 is tiny and independent, ship it first. Then 1, 2, 3. Slice 1 works without slice 3 (it uses the match's existing sign-up deadline until a weekly one is set).

**No prompt changes anywhere.** "Waiting list" is already bench vocabulary for the router. No live-LLM runs are needed for any slice.

**Decisions I need from you** are listed at the end (section 8), each with my recommendation. The big ones: which match counts as "last" after a cancelled week, whether the 17:00 daily post should go quiet for these clubs, the no-pick fallback, and whether late drop-outs should still owe the fee.

---

## 0. What I checked

- Code read on `origin/main` at `75b87d9`: `bot-scheduler.ts`, `attendance.ts`, `bench-confirmation.ts`, `team-slot-fill.ts`, `team-requests.ts`, `late-message.ts`, `tentative-followup.ts`, `recruit.ts`, `recruit-chase.ts`, `attendance-events.ts`, `pipeline/engine.ts` (capacity and slot-open arms), `dm-reply/route.ts`, `cron/generate-matches`, `match-completion.ts`, `next-upcoming-match.ts`, `sport-presets.ts`, `club-connect-rules.ts`, `org-features*.ts`, `/admin/settings`, the match page components, the i18n tables.
- Prod DB, plain SELECTs only. There is a "FNF test" org (`cmuh0m1e6000b05ldc1zhfetz`, created 2026-09-25, activity "FNF (16/18 players)", Friday 20:30, bot not enabled, no group linked, 1 owner and 2 players, sport `football-7aside` with 7 per side). If that is the demo org for Hamzah, its Sport row has to become 9-a-side (slice 4) before it goes live; presets are copied at creation and never re-applied.
- Sutton FC's only active activity is Tuesday 7-a-side, 21:30, `deadlineHours = 0`, bench on.

### Two facts from the code that shape the whole design

1. **Next week's match exists before this week's is played.** `generate-matches` runs daily at 00:00 UTC and, on match day, `daysUntil <= 0` rolls to +7, so next Friday's row is created at 01:00 on this Friday. Block bookings create every match up front. So a rolling squad cannot be copied "when the match is created"; it has to be copied when the previous match is over. That is why seeding hangs off the `complete-matches` cron.
2. **Capacity is decided twice, identically, in two places.** `pipeline/engine.ts:applyClaim` decides CONFIRMED vs BENCH for the reply and the react, and `attendance.ts:registerAttendance` decides it again for the write. Any change to who may take an open place (slice 2) has to go into one shared pure function called by both, or the react will say ✅ while the row says BENCH.

---

## 1. Slice 1: Rolling squad

### 1.1 Behaviour

A club with `rollingSquadEnabled = true`:

- **Seeding.** At 08:00 London on the morning after a match ends, every player who was CONFIRMED on that match when it completed is written CONFIRMED on the next match of the same fixture.
- **The announcement** (09:00 to 12:59, same morning) changes from the cold "Say IN to join" to "you're in unless you say OUT by <deadline>", with the carried-over squad listed.
- **OUT before the deadline** works exactly like OUT today.
- **OUT after the deadline** is still recorded, the player gets the normal 👋 react and nothing else, and every admin gets one DM saying it was late.
- **Everything else** (IN from a new player, bench, bench offers, teams, payments, ratings) works as it does today.

### 1.2 Exactly which match is "last"

`pickSeedSource(target, candidates)` (pure), in `src/lib/rolling-squad-rules.ts`:

- Same recurring fixture as the target, using `isSameRecurringFixture` (org, venue, weekday). This is the identity the rollover guard already uses, and it is deliberately NOT `activityId`, because a format switch re-points a match to the other activity.
- `status = COMPLETED`, `isHistorical = false`, `date < target.date`.
- The most recent one within `ROLLING_LOOKBACK_DAYS = 21`.
- **After a cancelled week:** the cancelled match is skipped and the one before it is used, if it is within 21 days. The cancelled week's own attendance (people who said OUT for that week only) is ignored. Recommended, see decision D1.
- **Longer gap** (summer break, a month off): no source, no seeding. The match opens empty and the ordinary cold announcement fires. The admin can press "Carry over last squad" on the match page (1.9) if they want it anyway.
- **The target** is the soonest live (UPCOMING) match of that fixture after the source, not already seeded, with `now < date`. Only one target per source.

### 1.3 Who is carried over

`decideSeed({ sourceRows, memberships, users, targetRows, maxPlayers })` (pure) returns an ordered list of `{userId, status: "CONFIRMED" | "BENCH", note}`.

| Player on the source match | Carried over? | Why |
|---|---|---|
| CONFIRMED at completion | Yes, CONFIRMED | "If you played last week you're in." |
| BENCH (never got a place) | No | Did not play. Recommended, decision D2. |
| DROPPED | No | Did not play. |
| Membership `leftAt` set, or no membership any more | No | Left the group or removed by an admin. |
| `User.isActive = false` | No | Deactivated. |
| Phoneless provisional placeholder (a guest: `provisional+` email or `provisionallyAddedAt` set, and no phone) | No | A one-off guest someone else registered. Cannot be DMed, never asked to play again. |
| Phoneless but admin-confirmed member | Yes | A real regular whose number we lack (Sutton has these). |
| Provisional member WITH a phone (auto-added unknown sender) | Yes | A real person who played. |
| Already has any row on the target (said IN, OUT or bench early) | Untouched | The player's own statement wins. An early OUT stays OUT. |

**Order and overflow.** Carried players keep the source match's `position` order and are written with new positions after any rows already on the target. If carried players plus the target's existing CONFIRMED rows exceed `maxPlayers` (next week is a smaller format, or people said IN early), the first ones fill the squad and the rest go to BENCH, note "rolling overflow: no place left", keeping their order. They are told nothing individually; the announcement shows them under "Waiting list".

### 1.4 When and how the seed is written

- **When:** `rollingSeedDue(sourceEnd, now)` is true from the first 08:00 London after `source.date + matchDurationMins`. Waiting until the morning gives the admins the night to remove a no-show from last week before it rolls into next week. DST-safe through `londonWallClockToUtc`.
- **Where:** a new step in `/api/cron/complete-matches` (every 15 minutes, server side, does not depend on the Pi being up): after `completeFinishedMatches`, call `seedDueRollingSquads(now)`. No new cron.
- **Only for** approved, non-dormant clubs with the setting on (`APPROVED_CLUB_WHERE`, `dormantAt IS NULL`), the same axes `generate-matches` checks. The mute switch (`whatsappBotEnabled`) does NOT stop seeding, for the same reason it does not stop fixture generation: an hour of engineering must not cost a club its squad. Posts are still muted by it.
- **How:** `seedRollingSquad(targetId, sourceId, actor)` in `src/lib/rolling-squad.ts`, one transaction:
  1. `UPDATE "Match" SET rollingSeededAt = now(), rollingSeededFromMatchId = $source WHERE id = $target AND rollingSeededAt IS NULL` (claim; zero rows means someone else did it, stop).
  2. Read the target's rows inside the transaction, run `decideSeed`.
  3. `createMany` the attendance rows (`respondedAt = now`).
  4. One `AttendanceEvent` per row, cause `rolling-squad`, actorKind `scheduler` (or `admin` for the button), `sourceRef = <sourceMatchId>`, note "carried over from <date>" or "rolling overflow". Same transaction, so the e2e coverage trigger (`prisma/sql/attendance-event-coverage.sql`) holds.
  5. `announceSquadFullIfJustFilled` is deliberately NOT called when the seed fills the squad: its "Squad complete" post would land at 08:00, before the announcement. The rolling announcement (1.5) carries the full roster instead. The `<matchId>:squad-locked` claim is written with the seed, so a later drop and refill announces normally.
- **Not re-synced.** If an admin edits last week's squad after 08:00, next week is not rewritten. They edit next week's squad directly. Keeps one writer and one moment.
- **Registration guard:** `registerAttendance` refuses a future match while an earlier one is in flight. Seeding runs after completion, so it never meets that guard, and it does not go through `registerAttendance` at all (it is a bulk write with its own events, like the format-switch recut).

### 1.5 Posts and wording

**The drop-out deadline used by this slice** is `dropOutDeadlineFor(match, org)` (pure, `src/lib/weekly-deadlines.ts`): the weekly drop-out deadline from slice 3 when set, otherwise the match's existing `attendanceDeadline` (kickoff minus `deadlineHours`). So slice 1 ships on its own. Label format: `longDayTimeLabel` (EN "Monday 21:00", TR "Pazartesi 21:00").

**R1. Rolling announcement** (group). Scheduler block 1 gets a rolling branch: same 09:00 to 12:59 window, same `isNextUpcomingForPosting` gate, `hoursUntilMatch > 24`, fires once on key `<matchId>:rolling-announce`, only when `rollingSeededAt` is set and at least one player was carried. The existing cold announce keeps its `squadEmpty` gate, so it cannot fire as well. If nobody was carried, the cold announce fires as today.

EN:
```
📅 *{activity}*, *{dateLabel}*, {venue}.

Everyone who played last time is in again. Drop-out deadline: *{deadline}*. Until then, you're in unless you say *OUT*.

*In ({n}/{max}):*
1. Hamzah
2. ...

{tail}
```
`{tail}` is one of:
- places open, first-come club: "{k} places open: say *IN* to take one."
- places open, organiser-pick club (slice 2): "{k} places open: say *IN* to go on the waiting list, and the organisers will pick who plays."
- full: "The squad is full. Say *IN* to go on the waiting list."

(With one place: "1 place open".) Overflow players, if any, are listed under "*Waiting list ({k}):*" before the tail.

TR:
```
📅 *{activity}*, *{dateLabel}*, {venue}.

Geçen maçta oynayan herkes yine kadroda. Son çıkış: *{deadline}*. O saate kadar *YOKUM* yazmazsanız kadrodasınız.

*Kadroda ({n}/{max}):*
1. Hamzah
2. ...

{tail}
```
- "{k} yer boş: almak için *VARIM* yazın."
- "{k} yer boş: *VARIM* yazın, yedek listesine ekleyeyim; kimin oynayacağını organizatörler seçer."
- "Kadro dolu. Yedek listesine girmek için *VARIM* yazın."
- overflow header: "*Yedek listesi ({k}):*"

**R2. 17:00 evening update, one extra line** while `now < deadline` (branches 2a and 2b; not the match-day branches):

- EN: "Drop-out deadline: *{deadline}*. Until then, you're in unless you say *OUT*."
- TR: "Son çıkış: *{deadline}*. O saate kadar *YOKUM* yazmazsanız kadrodasınız."

**Static text instead of the composer, for rolling clubs only.** Branch 2a and the three chases (`match-day-morning`, `chase-pre-kickoff`, `pre-kickoff-short`) call `composeChaseText`, a model call whose prompt knows nothing about rolling squads and would tell a rolling squad to "say IN". For a rolling club they use the existing static fallbacks (`buildDailyInListFallback`, `buildMatchDayChaseFallback`, ...) plus R2. This is the design choice that avoids a prompt change, and it removes up to four model calls a week for the club. Sutton keeps the composer.

**R3. Bot intro line** (the once-per-club intro, `buildBotIntro`), rolling clubs only, replaces the attendance line:
- EN: "🔁 *Rolling squad*: if you played last time, you're in next time too. Say *OUT* if you can't make it, before the drop-out deadline."
- TR: "🔁 *Kadro devam eder*: geçen maçta oynadıysanız bir sonrakinde de kadrodasınız. Gelemeyecekseniz son çıkış saatinden önce *YOKUM* yazın."

**R4. Late drop-out DM to each admin** (owner and admins with a phone, `findOrgAdminsWithPhone`), one per drop, key `<matchId>:late-drop:<userId>:<adminId>`, London 08:00 to 21:59 (held until 08:00 otherwise):
- EN: "Late drop-out: *{name}* said OUT for *{activity}* ({when}) at {time}, after the {deadline} deadline. Squad is now {n}/{max}."
- TR: "Geç çıkış: *{name}*, *{activity}* ({when}) için {time} saatinde YOKUM dedi, son çıkış {deadline} idi. Kadro şimdi {n}/{max}."

With slice 2 on, this is folded into the pick DM instead (its first line becomes "*{name}* dropped out after the deadline."), so admins get one message, not two.

### 1.6 OUT after the deadline, precisely

- **The time that counts is when the player sent it**, not when it reached us. The analyze path already carries the WhatsApp `timestamp` (see `late-message.ts`); DMs carry one too. `cancelAttendance` gets an optional `{ occurredAt?: Date }` argument; callers that know the send time pass it, the web button passes nothing (now). A "sorry can't make it" typed at 20:55 and delivered at 21:40 is on time.
- **Recorded:** the row goes DROPPED, bench offer or pick round follows as normal. MatchTime does not refuse a late OUT. A squad that lists someone who has told us they are not coming is the worst state this product can be in.
- **Marked:** the `AttendanceEvent` note says "after the drop-out deadline ({deadline})". No new column; the admin view derives lateness from event time vs deadline.
- **Money:** a DROPPED player is not in the CONFIRMED set, so MatchTime sends them no payment link and does not list them as unpaid. If Hamzah's group charges late drop-outs anyway, that is decision D6 (a later setting), not this slice.
- **Late-message rule unchanged:** a message more than 30 minutes old on arrival still records attendance silently; the late-drop admin DM (R4) still goes, because it is to the admins, not a reply in the group.

### 1.7 Interactions

| Area | What happens | Change needed |
|---|---|---|
| Bench and bench offers | A rolling club with first-come bench: drop opens a `BenchSlotOffer` exactly as today. | None. |
| Tentative ("maybe") | A carried-over player saying "might not make it" writes nothing (as today). The follow-up guard already skips CONFIRMED players, so they are not DMed and stay in. Slice 3's admin summary lists them under "Said maybe". | None in slice 1. No new DM, so no new model call on the reply path. |
| Recruit invites (`inviteRecentPlayers`) | Already excludes anyone with any attendance row on the match (`recruit.ts` ~278). Carried players have a row, so they are never invited. | Test only, to pin it. |
| Recruit chase-ups | Signal 1 (any attendance row) already treats them as responded. | Test only. |
| 17:00 update | R2 line; static text for rolling clubs. Slice 3 may silence it (D4). | Scheduler branch. |
| AttendanceEvent | New cause `rolling-squad` in `ATTENDANCE_EVENT_CAUSES` (actorKind `scheduler`, or `admin` via the button). | `attendance-events.ts`. |
| Payments | Only CONFIRMED rows on a COMPLETED match are charged, polled or chased. A carried player who drops is not charged. **New risk:** a carried player who says nothing and does not turn up stays CONFIRMED and would be charged and rated. Mitigation: the list is posted daily or at publish, and the admin removes a no-show on the match page before the fee is set. No inference. | None. Risk stated in the ⓘ text. |
| Ratings, MoM, Elo | Same CONFIRMED set; same no-show caveat. | None. |
| Multi-drop slot logic (`team-slot-fill.ts`) | Seeding happens days before teams exist (teams are match-day only), so there is no sheet to fill. | None. |
| Teams on request (`team-requests.ts`) | Unchanged: built only on match day, only on an explicit ask. | None. |
| Format switch | A switch this week recuts the seeded squad like any squad. Next week's seed uses next week's `maxPlayers`. | None. |
| Late messages | Send time decides lateness (1.6). | `cancelAttendance` option. |
| Registration guard (future match while previous in flight) | Seeding is after completion, not via `registerAttendance`. | None. |
| AI cost | Zero new model calls. Removes the composer calls for this club's 17:00 short post and three chases. | None. |

### 1.8 Data model (additive)

```prisma
model Organisation {
  /// Rolling squad (2026-09-30): each new match starts with the players
  /// who played the previous one. Default OFF; Sutton FC unchanged.
  rollingSquadEnabled Boolean @default(false)
}

model Match {
  /// When the rolling squad was copied onto this match. NULL = never.
  /// Written once, by the claim in seedRollingSquad. Idempotency key.
  rollingSeededAt          DateTime?
  /// The match it was copied from. Plain string, no FK (history).
  rollingSeededFromMatchId String?
}
```
`OrgFeatures.rollingSquad: boolean` (so `SquadState.features` has it with no extra query). NOT added to `FEATURE_META`: that list also drives the in-group setup menu.

### 1.9 Files touched

- `prisma/schema.prisma`, `prisma/migrations/<ts>_rolling_squad/`
- `src/lib/rolling-squad-rules.ts` (new, pure), `src/lib/rolling-squad.ts` (new, DB)
- `src/lib/weekly-deadlines.ts` (new, pure: `dropOutDeadlineFor`; slice 3 extends it)
- `src/lib/attendance-events.ts` (cause), `src/lib/attendance.ts` (`occurredAt`, late-drop hook)
- `src/app/api/cron/complete-matches/route.ts`
- `src/lib/bot-scheduler.ts` (R1 branch, R2 line, static-text switch, R4 emission)
- `src/lib/scheduler-copy.ts`, `src/lib/i18n/strings.en.ts`, `strings.tr.ts`, golden snapshots
- `src/lib/org-features.ts`
- `src/app/admin/settings/page.tsx`, `src/app/actions/org.ts` (`setWeeklyRoutine`, see section 5)
- `src/app/actions/matches.ts` + a small `src/components/match/carry-over-squad-button.tsx` (admin only, calls `seedRollingSquad` with actorKind `admin`; only enabled when the match has no rows and a source exists). This is also how Hamzah's first week goes live: MatchTime has no history for them, so week one is built by INs and admin adds, and from week two it rolls.

### 1.10 Tests (TDD: red first)

Unit (vitest, no model):
- `pickSeedSource`: same fixture only; skips CANCELLED; skips historical; 21-day lookback; format-switched source on the other activity still counts; nothing within 21 days returns null.
- `decideSeed`: each row of the table in 1.3; overflow order; existing target rows untouched (early OUT stays OUT, early IN not duplicated).
- `rollingSeedDue`: 08:00 London next morning, across the BST to GMT change (last Sunday of October) and a Friday 22:00 end.
- `dropOutDeadlineFor`: falls back to `attendanceDeadline`.
- Late-drop: `occurredAt` before deadline is on time even if written after; after is late.
- Scheduler (existing test style with fixtures): R1 fires once in window with the seeded list and correct tail for first-come, organiser and full; cold announce does not fire when seeded; R2 before deadline only; `composeChaseText` called 0 times for a rolling club and still called for a non-rolling club; recruit and recruit-chase skip carried players.
- Copy golden: every new EN and TR row pinned; `strings.test.ts` no-dash check covers the new keys; all existing English bytes unchanged (Sutton).

Playwright (free):
- `e2e/api/rolling-squad.spec.ts`: complete-matches cron seeds once (second call no-op), events have cause `rolling-squad` in the same `txId`, due-posts with `x-test-now` returns the rolling announce.
- `e2e/web/admin-settings.spec.ts`: toggle persists; `e2e/web` match page "Carry over last squad" button.

No prompt changes. No live-LLM run needed.

### 1.11 Rollout

1. Migration (defaults off). Sutton reads `false`; golden proves its bytes.
2. Turn on for "MT Test", drive a week with `x-test-now` and the cron by hand.
3. Turn on for Hamzah's club after its first played week (or press "Carry over" once).

---

## 2. Slice 2: Organiser-picked waiting list

### 2.1 Behaviour

A club with `benchPickMode = "organiser"`:

- **No open place is ever filled by MatchTime on its own.** A non-admin IN, from a new player or from the bench, lands on the waiting list (BENCH), even with places open. The only ways into the squad are: carried over (slice 1), an admin pick (DM or web), an admin instruction in the group ("@Match Time put Wasim in", which is already admin-authorised), an admin adding on the match page, or the fallback offer (2.6).
- **One exception, the reclaim:** a player who was CONFIRMED on this match, said OUT, and says IN again while a place is still free gets it back. "Sorry, wrong group, I'm in" must not cost a regular his place.
- **When there is a free place and someone waiting**, a pick round opens and each admin gets one DM.
- **Team sheet** unchanged: balanced teams, admins swap if they want.

### 2.2 The shared capacity rule (the one real refactor)

New pure function in `src/lib/squad-capacity.ts`:

```ts
canTakeFreePlace({
  confirmed, maxPlayers,
  pickMode,            // "first-come" | "organiser"
  actorIsAdmin,        // an OWNER/ADMIN instruction or screen
  isReclaim,           // this player's last transition on this match was CONFIRMED -> DROPPED
  openBenchOffer,      // a BenchSlotOffer is open (the fallback is running)
}): boolean
```
- first-come: `confirmed < maxPlayers` (today's rule, byte for byte).
- organiser: `confirmed < maxPlayers && (actorIsAdmin || isReclaim || openBenchOffer)`.

Called by `pipeline/engine.ts:applyClaim` (for `squadHasRoom` and `wantsPromotion`) and by `attendance.ts:registerAttendance`. Both already hold the same capacity arithmetic; this makes them hold the same policy too, so the react (✅ vs 🪑) cannot disagree with the row. The engine needs `features.benchPickMode` on `SquadState` (via `OrgFeatures`) and the reclaim fact (loaded with the rows). `registerAttendance` reads the org once. The BENCH note for these rows: "organiser picks who plays".

### 2.3 Pick rounds

**Opening a round.** `sweepOrganiserPicks(orgId, now)` runs in `/api/whatsapp/due-posts` next to `sweepExpiredBenchConfirmations`, before `computeDuePosts`. For the next live match of each fixture (`isNextUpcomingForPosting`), it opens a round when ALL hold:
- `openPlaces = maxPlayers - confirmed > 0`
- the waiting list (BENCH rows, active membership) is not empty
- the weekly drop-out deadline has passed (slice 3) or none is set
- London 08:00 to 21:59
- no open round for the match, OR the open round is stale (a new drop since, or the list changed) AND its DMs went out at least 60 minutes ago; then the old round is closed `superseded` and a new one opens. That 60-minute floor is the rate limit: at most one round DM per admin per hour per match.

**Closing a round.** The sweep closes it when `openPlaces` reaches 0 (`filled`), at kickoff (`closed-at-kickoff`), or at `fallbackAt` (2.6).

**The DM.** `computeDuePosts` emits one `dm` per admin (owner and admins with a phone) per round, key `pick-<roundId>:dm:<adminId>`. Positions come from `PlayerActivityPosition` for the match's activity; rating is the raw club rating players see (`loadClubRating(...).rating`, one small read each, list is short), or "new" when there is none. The seed rating is never shown.

**P1. The pick DM**, EN:
```
*Hamzah* dropped out of *{activity}* ({when}). 1 place open, squad 17/18.

Waiting list:
1. Kemal (GK, 7.4)
2. Wasim (MID, 7.9)
3. Ali (no position, new)

Reply with a number or a name to bring someone in, e.g. *2*, or *2 3* for two. Reply *NONE* to leave it open.
If nobody picks by {fallbackWhen}, I'll offer the place to the whole waiting list.
```
Variants of the first line: two drops, "*Ali* and *Sam* dropped out of ..."; a late drop, "*Ali* dropped out of ... after the deadline."; no drop (a place was never filled), "There is 1 place open in *{activity}* ({when}), squad 17/18."; from the deadline summary (slice 3), "Drop-out deadline passed for *{activity}* ({when})." Last line for the leave-empty fallback: "If nobody picks by {fallbackWhen}, the place stays open."

TR:
```
*Hamzah*, *{activity}* ({when}) maçından çıktı. 1 yer boş, kadro 17/18.

Yedek listesi:
1. Kemal (GK, 7.4)
2. Wasim (MID, 7.9)
3. Ali (mevki yok, yeni)

Birini almak için numara ya da isim yazın, örneğin *2*, iki kişi için *2 3*. Boş bırakmak için *HİÇBİRİ* yazın.
{fallbackWhen} saatine kadar kimse seçmezse yeri tüm yedek listesine açarım.
```
TR variants: "*Ali* ve *Sam*, ... maçından çıktı."; "*Ali*, ... maçından son çıkış saatinden sonra çıktı."; "*{activity}* ({when}) için 1 yer boş, kadro 17/18."; "*{activity}* ({when}) için son çıkış saati geçti."; leave-empty: "{fallbackWhen} saatine kadar kimse seçmezse yer boş kalır."

### 2.4 Reading the admin's reply (deterministic, no model)

New handler `handleOrganiserPickDm` in `src/lib/organiser-pick.ts`, called in `dm-reply/route.ts` right after the self-join handlers and BEFORE the bench-DM block and every model call (the admin-commands classifier, Q&A). It only engages when the sender, **resolved by phone only** (pushname is attacker-controlled; see the removed collector fallback), is OWNER/ADMIN of a club with an open round.

Parser `parsePickReply(text, list, lang)` (pure, `src/lib/organiser-pick-rules.ts`):
- Folded with Turkish-aware lower-casing and accent folding (`name-normalise.ts`).
- **Numbers:** `2`, `2 3`, `2, 3`, `2 and 3`, `2 ve 3`, ranges `1-3` (max 10). Resolved against the round's stored `listUserIds`, never the live bench.
- **Names:** a full name from the list, or a first name unique within the list, separated by commas, "and" or "ve".
- **All:** `ALL` or `HEPSİ` brings in the list in order up to the free places (useful for week one).
- **None:** `NONE`, `NOBODY`, `LEAVE IT`, `HİÇBİRİ`, `KİMSE`. Not "YOK": an admin who is also playing may mean his own OUT.
- **Anything else:** if it contains a digit or a token equal to a listed first name, reply P6 (not understood). Otherwise it is not a pick; fall through to the existing DM handling, so a normal DM from an admin still works.

**Applying a pick** (`applyOrganiserPick(matchId, userIds, admin, source)`), one transaction under `lockTeamSlots(tx, matchId)`:
1. Re-read the squad. For each picked player in reply order: must still be BENCH on this match; place must still be free (`confirmed < maxPlayers`). Excess picks are dropped (P7).
2. `BENCH -> CONFIRMED`, `AttendanceEvent` cause `organiser-pick`, actorKind `admin`, `actorUserId = admin`, `sourceRef = round id` (or `admin:web`).
3. `fillVacatedSlots(tx, matchId)` so a pick after the teams exist inherits the slot actually vacant, the 29 September rule. The group post names the slot really inherited (`AppliedSlotMove.fromUserId`), never the round's `vacatedByUserIds`.
4. Update the round (`pickedUserIds`, `lastPickedByUserId`); resolve it `filled` if no place is left.

After commit: `announceSquadFullIfJustFilled`, the group post (P9), the player DM (P10), the ack to the picker (P2), a "Done" DM to each other admin (P3), each keyed so a retry sends nothing twice.

**First admin wins** falls out of the lock and the capacity check: Raihan's reply takes the last place; Hamzah's reply a minute later finds none and gets P4.

**Stale numbers.** Each admin's last DMed round is known from the `pick-<roundId>:dm:<adminId>` keys. If an admin replies with numbers to a round that has since been superseded, nothing is applied and they get P5 with the current list. Names are still accepted (they are unambiguous).

**Late replies.** A pick reply more than 30 minutes old on arrival (same rule and constant as `late-message.ts`) is not executed; the admin gets P5 with the current list.

**Admin copy:**

| Key | EN | TR |
|---|---|---|
| P2 ack to picker | "Done: *Wasim* is in for *{activity}*. Squad {n}/{max}." | "Tamam: *Wasim*, *{activity}* kadrosunda. Kadro {n}/{max}." |
| P3 other admins | "Done: *Wasim* is in (picked by Raihan). Squad {n}/{max}. Nothing for you to do." | "Tamam: *Wasim* kadroda (Raihan seçti). Kadro {n}/{max}. Sizin bir şey yapmanıza gerek yok." |
| P4 too late | "No place is open now. *Wasim* is in (picked by Raihan), squad {n}/{max}." | "Artık boş yer yok. *Wasim* kadroda (Raihan seçti), kadro {n}/{max}." |
| P5 list changed | "The waiting list has changed since my last message. Here it is again:" + list + instructions | "Son mesajımdan beri yedek listesi değişti. Güncel hali:" + list + instructions |
| P6 not understood | "I couldn't match that to the waiting list. Reply with a number from the list (e.g. *2*) or a full name. *NONE* leaves the place open." | "Bunu yedek listesiyle eşleştiremedim. Listeden bir numara (örneğin *2*) ya da tam isim yazın. *HİÇBİRİ* yazarsanız yer boş kalır." |
| P7 more picks than places | "Only {k} place was open, so I brought in your first pick: *Wasim*." | "Sadece {k} yer boştu, bu yüzden ilk seçiminizi aldım: *Wasim*." |
| P8 NONE | "OK, I'll leave the place open. You can still pick from the waiting list on the match page." | "Tamam, yeri boş bırakıyorum. Maç sayfasından yine yedek listesinden seçebilirsiniz." |
| P11 fallback, offer | "Nobody picked for *{activity}*, so I've offered the place to the waiting list: the first to say IN gets it." | "*{activity}* için kimse seçim yapmadı, bu yüzden yeri yedek listesine açtım: ilk VARIM diyen alır." |
| P12 fallback, leave empty | "Nobody picked for *{activity}*, so the place stays open. Squad {n}/{max}." | "*{activity}* için kimse seçim yapmadı, yer boş kalıyor. Kadro {n}/{max}." |

### 2.5 What the group and the chosen player are told

**P9. Group** (one post per picked player):
- no sheet, replacing someone: EN "✅ *Wasim* is in for *{activity}*, replacing *Hamzah*. Squad *{n}/{max}*." TR "✅ *Wasim*, *Hamzah* yerine *{activity}* kadrosunda. Kadro *{n}/{max}*."
- no sheet, open place: EN "✅ *Wasim* is in for *{activity}*. Squad *{n}/{max}*." TR "✅ *Wasim*, *{activity}* kadrosunda. Kadro *{n}/{max}*."
- sheet exists: EN "✅ *Wasim* is in, playing for *{team}* in *Hamzah*'s place. Squad *{n}/{max}*." TR "✅ *Wasim* kadroda, *{team}* takımında *Hamzah* yerine oynuyor. Kadro *{n}/{max}*."

The group is not told which admin picked. Admins see that in P3.

**P10. DM to the picked player** (a match-invite category DM, so it honours `subMatchInviteDm`; if unsubscribed, the group post is their notice):
- EN "Good news {first}, you're in for *{activity}* ({when}). If you can't make it now, reply *OUT*."
- TR "Müjde {first}, *{activity}* ({when}) kadrosundasın. Artık gelemiyorsan *YOKUM* yaz."

The rest of the waiting list is told nothing. No "you were not picked" messages.

### 2.6 If no admin answers

`fallbackAt = min(round opened + 24h, kickoff - 4h)`, but never sooner than 1 hour after the round opened. A superseding round keeps the earlier `fallbackAt` (floored the same way). Setting `benchPickFallback`:

- **`bench-offer` (recommended default):** create one `BenchSlotOffer` per free place (`replacingUserId` from the round's unfilled drops, else null), close the round `fallback-bench-offer`, DM admins P11. From there the existing first-come machinery runs unchanged: group post tagging the waiting list, a DM to each, first IN wins (`canTakeFreePlace` allows it because an offer is open). An empty place at kickoff is worse for a 9-a-side than a first-come fill, and the admins had a full day.
- **`leave-empty`:** close the round `fallback-left-open`, DM admins P12. The ordinary short-squad chases still run.

Decision D5.

### 2.7 Other interactions

- **The engine's "a place just opened" group post** (the slot-opened arm in `engine.ts`): in organiser mode it is suppressed while the waiting list is non-empty (the admins are being asked). With an empty waiting list it posts a variant, P13: EN "A place just opened in *{activity}*. Say *IN* to go on the waiting list, and the organisers will pick who plays." TR "*{activity}* kadrosunda bir yer açıldı. *VARIM* yazın, yedek listesine ekleyeyim; kimin oynayacağını organizatörler seçer." Pure code, no prompt.
- **`requestBenchConfirmationOnDrop`:** returns without creating an offer in organiser mode. Only the fallback creates offers.
- **Recruit invite text** gets the waiting-list wording for these clubs (a small variant in `recruit.ts`'s static copy). Recruit already skips anyone with a row.
- **The web "I'm in" button** goes through `registerAttendance`, so it lands on the waiting list like a message.
- **Admin in the group, "@Match Time put Wasim in":** admin authority, confirms, cause `admin-message`, and it closes any open round on the next sweep.
- **Rolling squad:** seeding is not subject to the rule (it is not a claim). Organiser mode and rolling squad are independent settings; Hamzah wants both.
- **AI cost:** zero model calls. The handler runs before every model call on the DM path, and an unparseable reply that looks like a pick gets P6 rather than reaching the admin-commands classifier.

### 2.8 Admin page control

On the match page's attendance list (`src/components/match/attendance-list.tsx`), admins of an organiser club see the waiting list with position and club rating, up and down arrows to reorder, and a "Bring in" button per player.
- Reorder: `reorderWaitingList(matchId, orderedUserIds)`. It rewrites `position` for BENCH rows only, reusing the set of positions they already hold, so confirmed positions never move. One `AttendanceEvent` per moved row, cause `admin-squad-edit`, note "waiting list reordered". The DM list order is this order.
- Bring in: `pickFromWaitingList(matchId, userId)`, which calls the same `applyOrganiserPick` (sourceRef `admin:web`), so the web and the DM have one writer, one set of posts and the slot fill.

Observation, not in scope: the existing `moveUpFromBench` action does not call `fillVacatedSlots` or close offers. Sutton's behaviour is left alone; organiser clubs use the new action.

### 2.9 Data model (additive)

```prisma
model Organisation {
  /// Who fills an open place: "first-come" (today, default) or "organiser".
  benchPickMode     String @default("first-come")
  /// When no admin picks in time: "bench-offer" (default) or "leave-empty".
  benchPickFallback String @default("bench-offer")
}

/// One ask to the admins to fill open places from the waiting list.
model OrganiserPickRound {
  id                 String    @id @default(cuid())
  matchId            String
  match              Match     @relation(fields: [matchId], references: [id], onDelete: Cascade)
  orgId              String
  /// The numbered waiting list exactly as sent. Reply numbers resolve here.
  listUserIds        String[]
  /// The drops this round is about (wording only).
  vacatedByUserIds   String[]  @default([])
  /// Of those, which were after the drop-out deadline (wording only).
  lateDropUserIds    String[]  @default([])
  openPlaces         Int
  /// "drop" | "open-place" | "deadline-summary"
  reason             String
  fallbackAt         DateTime
  resolvedAt         DateTime?
  /// "filled" | "none-by-admin" | "fallback-bench-offer" |
  /// "fallback-left-open" | "superseded" | "closed-at-kickoff"
  outcome            String?
  pickedUserIds      String[]  @default([])
  lastPickedByUserId String?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  @@index([matchId, resolvedAt])
  @@index([orgId, resolvedAt])
}
```
Plus `Match.organiserPickRounds OrganiserPickRound[]`. `AttendanceEvent` cause `organiser-pick`. `OrgFeatures.benchPickMode`.

### 2.10 Files touched

`prisma/schema.prisma` + migration; `src/lib/squad-capacity.ts` (new); `src/lib/organiser-pick-rules.ts` (new, pure: parser, round-open decision, fallbackAt, DM text assembly); `src/lib/organiser-pick.ts` (new, DB: sweep, apply, DM handler); `src/lib/pipeline/engine.ts` (`applyClaim` via `canTakeFreePlace`, slot-opened arm variant); `src/lib/pipeline/load-state.ts` (reclaim fact, pick mode); `src/lib/attendance.ts`; `src/lib/bot-scheduler.ts` (round DMs, `requestBenchConfirmationOnDrop` guard); `src/app/api/whatsapp/due-posts/route.ts` (sweep); `src/app/api/whatsapp/dm-reply/route.ts` (handler, placed first after self-join); `src/lib/attendance-events.ts`; `src/lib/recruit.ts` (copy variant); i18n tables + goldens; `src/components/match/attendance-list.tsx` + `waiting-list-controls.tsx`; `src/app/actions/players.ts` (`reorderWaitingList`, `pickFromWaitingList`); settings page and action.

### 2.11 Tests

Unit:
- `canTakeFreePlace`: first-come identical to today on every input (property-style table); organiser: non-admin IN with room goes BENCH; admin confirms; reclaim confirms; open offer confirms; full is BENCH for everyone.
- Engine: the react for a non-admin IN in organiser mode is 🪑 and matches the write; slot-opened arm suppressed with a waiting list and P13 without.
- `parsePickReply`: numbers, lists, ranges, names (full, unique first, accents, Turkish İ/ı), ALL/HEPSİ, NONE/HİÇBİRİ, "yok" NOT none, out of range gives not-understood, plain chat falls through.
- Round decisions: opens only with places and a list; not before the drop-out deadline when set; quiet hours; supersede only after 60 minutes; `fallbackAt` arithmetic including a drop 3 hours before kickoff.
- `applyOrganiserPick` against the in-memory `SlotFillTx` world: two admins racing for one place (one wins, one gets P4); pick after teams exist seats in the vacant slot and names the real holder (the 29 September shape: three drops, a join, then a pick); picked player no longer on the bench.
- dm-reply: pushname-only sender is ignored; a non-admin with digits falls through; late reply gets P5.
- Copy goldens EN and TR; no dashes.

Playwright: `e2e/api/organiser-pick.spec.ts` (drop, due-posts emits one DM per admin, DM reply "2" picks, second admin reply gets "No place is open now", fallback at `x-test-now` creates a `BenchSlotOffer`); `e2e/web` match page reorder and Bring in; settings persists.

No prompt changes. No live-LLM run needed: the reply path is code, and the engine change is pure capacity logic covered by the stubbed-extractor unit tests.

### 2.12 Rollout

Migration (default first-come). Golden and the `canTakeFreePlace` first-come table prove Sutton unchanged. Try on MT Test with two admin phones. Then Hamzah's club.

---

## 3. Slice 3: Weekly deadlines

### 3.1 Settings

Club level (Organisation), because Kemal's rule is one group per club and the deadline must not change when a format switch re-points a match to another activity:

- `dropOutDeadlineDay` (0 to 6) and `dropOutDeadlineTime` ("HH:mm", London), e.g. Monday 21:00
- `listPublishDay` and `listPublishTime`, e.g. Tuesday 20:00

`weeklyDeadlinesFor(matchDate, settings)` (pure, `weekly-deadlines.ts`): each is the LAST occurrence of that weekday and time strictly before kickoff, resolved per date with `londonWallClockToUtc` (DST-safe). For a Friday 20:00 match: Monday 21:00 and Tuesday 20:00 of the same week.

**Validation** in the settings action, for every active activity of the club:
- both times between 08:00 and 21:30 (so every post lands inside waking hours and quiet hours need no special case);
- drop-out before publish;
- both after the previous week's kickoff (a same-weekday time later than kickoff would resolve to the week before, which is refused);
- either both days set or neither, per pair.

Clearing a setting returns to today's behaviour.

### 3.2 What MatchTime posts

| When | What | To | Key |
|---|---|---|---|
| Deadline minus 3h, not before 09:00; skipped if that leaves under 1h | D1 drop-out reminder with roster | group | `<matchId>:dropout-reminder` |
| First tick after the deadline (08:00 to 21:59) | D2 summary; with organiser pick it IS the first pick round (reason `deadline-summary`) | each admin, DM | `<matchId>:deadline-summary:<adminId>` or the round key |
| First tick after publish time, before kickoff | D3 the list | group | `<matchId>:list-published` |

All use the existing instruction and `SentNotification` mechanism, and the `isNextUpcomingForPosting` gate so next week's match never posts while this week's is live.

**D1. Drop-out reminder.**
- EN: "⏰ *{activity}*, {when}: the drop-out deadline is *today at {time}*. If you can't play, say *OUT* before then.\n\n{rosterBlock}"
- TR: "⏰ *{activity}*, {when}: son çıkış saati *bugün {time}*. Oynayamayacaksanız o saatten önce *YOKUM* yazın.\n\n{rosterBlock}"

**D2. Deadline summary** (admins; first-come clubs, or organiser clubs with nothing to pick):
- EN: "Drop-out deadline passed for *{activity}* ({when}). Squad {n}/{max}.\nOut this week: {names or 'nobody'}.\nSaid maybe: {names}.\nWaiting list: {names or 'empty'}.\n{k} places open." (the "Said maybe" and "places open" lines only when non-empty)
- TR: "*{activity}* ({when}) için son çıkış saati geçti. Kadro {n}/{max}.\nBu hafta çıkanlar: {names or 'kimse'}.\nBelki diyenler: {names}.\nYedek listesi: {names or 'boş'}.\n{k} yer boş."

"Said maybe" is unresolved `TentativeAvailability` rows for CONFIRMED players: the only place the rolling squad surfaces a "maybe", with no DM to the player and no model call.

**D3. List publish.**
- EN: "📋 *{activity}* list, *{dateLabel}*, {venue}\n\n*Playing ({n}/{max}):*\n1. ...\n\n*Waiting list ({k}):*\n1. ...\n\n{k} places still open. (only if any)\nCan't make it now? Say *OUT* as soon as you can so a replacement can be brought in."
- TR: "📋 *{activity}* listesi, *{dateLabel}*, {venue}\n\n*Oynayanlar ({n}/{max}):*\n1. ...\n\n*Yedek listesi ({k}):*\n1. ...\n\n{k} yer hâlâ boş.\nArtık gelemiyorsanız yerinize birinin alınabilmesi için hemen *YOKUM* yazın."

After publish, every change is announced by the post that makes it (bench claim, P9). The list is not re-posted.

### 3.3 Interaction with the existing scheduler posts

| Existing post | With weekly deadlines set |
|---|---|
| Announce (cold, or R1 rolling) | Unchanged timing. |
| 17:00 evening update | **Recommended (D4): off on every day except match day.** The week's rhythm becomes announce, reminder, summary, list. On match day the line-up (2-pre) and the full-squad-no-teams nudge (2-pre-alt) still fire. |
| Recruit invites and chase-ups | Unchanged (gated on short squad and sociable hours). |
| Match-day morning chase, 3-4h chase, 2h last call | Unchanged, static text for rolling or organiser clubs (1.5). |
| Bench offers (first-come) | Unchanged, 08:00 to 21:59. |
| Pick rounds (organiser) | Do not open before the drop-out deadline; the deadline summary opens the first. Admins can still pick early on the match page. |
| Tentative follow-ups, reminders, gear reminder, score ask, payments, MoM, ratings | Unchanged. |
| Switch-format and cancel nudges | Unchanged. |

**Quiet hours.** Settings validation keeps D1 and D3 inside waking hours. D2 and pick DMs use the 08:00 to 21:59 gate; a deadline at 21:30 whose tick slips past 22:00 waits until 08:00. Every post is claimed once by its key, so a Pi outage delays it rather than doubling it.

### 3.4 Data model (additive)

```prisma
model Organisation {
  dropOutDeadlineDay  Int?     // 0=Sun..6=Sat, London
  dropOutDeadlineTime String?  // "HH:mm", London wall clock
  listPublishDay      Int?
  listPublishTime     String?
}
```
Computed per match on the fly; nothing stored on `Match`.

### 3.5 Files, tests, rollout

Files: schema + migration; `weekly-deadlines.ts`; `bot-scheduler.ts` (D1, D3, D2 emission, 17:00 gate); `organiser-pick.ts` (deadline gate, `deadline-summary` reason); i18n + goldens; settings page and action.

Unit: `weeklyDeadlinesFor` (Friday match, Monday and Tuesday; same weekday earlier time; refusal of later time; the October DST weekend); validation; D1 at deadline minus 3h but not before 09:00; D2 once per admin; D3 once, only for the next live match; 17:00 silent off match day and present on match day for a deadline club, byte-identical for Sutton; "Said maybe" lists only CONFIRMED players' open tentatives.
Playwright: due-posts with `x-test-now` at Mon 18:00, Mon 21:05, Tue 20:05; settings form validation errors in EN and TR.
No prompt changes, no model calls.
Rollout: migration, all NULL, nothing changes until set.

---

## 4. Slice 4: 9-a-side preset (and the 8-a-side check)

```ts
{
  key: "football-9aside",
  name: "Football 9-a-side",
  playersPerTeam: 9,
  positions: ["GK", "DEF", "MID", "FWD"],
  teamLabels: ["Red", "Yellow"],
  mvpLabel: "Man of the Match",
  balancingStrategy: "position-aware",
  positionComposition: { GK: 1, DEF: 3, MID: 3, FWD: 2 },
}
```
Inserted between 8-a-side and 11-a-side.

Where presets are listed or chosen:
- `src/lib/sport-presets.ts`: the list.
- `src/lib/club-connect-rules.ts`: `sportForPlayersPerSide(9)` now returns the preset instead of the rating-only fallback. `PLAYERS_PER_SIDE_OPTIONS` already offers 9, and the TR label is already "9'a 9".
- `src/lib/onboarding-conversation.ts`: `presetForSide(9)` picks it by key.
- `src/app/onboarding/page.tsx` and `src/app/actions/onboarding.ts`: map `SPORT_PRESETS`, so it appears with no change.
- `src/lib/onboarding-parse.ts`: already parses "9-a-side", "9s", "9'a 9".

8-a-side (#148) checked: in the list, position-aware, `sportForPlayersPerSide(8)` covered by `sport-presets.test.ts`.

Test change: `sport-presets.test.ts` asserts 11-a-side sits right after 8-a-side; that becomes 8, 9, 11. Add: 9-a-side exists with 9 per side and composition summing to 9; `sportForPlayersPerSide(9).preset === "football-9aside"`; the balancer splits 18 players 9 and 9 with one GK each when two GKs are present.

Existing Sport rows are copies and are not migrated. The FNF test org would need its Sport edited (or recreated) to 9 per side.

---

## 5. How an organiser turns these on

**Recommended: `/admin/settings` only, a new "Weekly routine" section** (OWNER/ADMIN, `setWeeklyRoutine` action, `requireOrgAdmin`), under "Bot features":

1. Rolling squad: on/off
2. Who fills an open place: "First to say IN" / "The organisers pick"
3. If nobody picks in time: "Offer it to the waiting list" / "Leave it open" (shown only when 2 is "organisers")
4. Drop-out deadline: day + time
5. List published: day + time

Each gets an ⓘ (`src/components/stats/info-button.tsx`, the F1 pattern in `MDs/findings.md`), EN and TR from `src/lib/i18n`. These are NOT added to `FEATURE_META`, because that list also feeds the in-group setup menu.

**Not in the in-group setup, for now** (decision D7). The setup is a short conversation; more questions make it longer and each needs parsing. A deterministic line at the end of setup is cheap and safe:
- EN: "Tip: to carry the squad over each week, or to pick replacements from a waiting list yourself, open Settings on the website."
- TR: "İpucu: kadroyu her hafta devam ettirmek ya da yerine geçecekleri yedek listesinden kendiniz seçmek için sitedeki Ayarlar sayfasını açın."

For Hamzah, Kemal (or Hamzah on a call) sets them once.

### ⓘ texts

| Setting | EN | TR |
|---|---|---|
| Rolling squad | "When this is on, everyone who played the last match is automatically in for the next one, and only needs to say OUT if they can't make it. Players who were on the waiting list, guests without a phone number and anyone who has left the group are not carried over. The squad is carried over at 08:00 the morning after each match, so you have the night to remove anyone who didn't turn up. Anyone still on the list at the final whistle counts as having played, for payments and ratings." | "Bu açıkken, son maçta oynayan herkes bir sonraki maçta otomatik olarak kadroda olur; gelemeyecekse sadece YOKUM yazması yeterli. Yedek listesindekiler, telefon numarası olmayan misafirler ve gruptan ayrılanlar aktarılmaz. Kadro her maçtan sonraki sabah 08:00'de aktarılır, böylece gelmeyenleri o gece listeden çıkarabilirsiniz. Maç bittiğinde listede olan herkes ödeme ve puanlama için oynamış sayılır." |
| Who fills an open place | "First to say IN: when a place opens, MatchTime offers it to the waiting list and the first to say IN gets it. The organisers pick: MatchTime never fills a place by itself. Anyone who says IN goes on the waiting list, and the owner and admins get a WhatsApp message with the waiting list, positions and club ratings. The first admin to reply with a number or a name brings that player in." | "İlk VARIM diyen: bir yer açılınca MatchTime yeri yedek listesine sunar, ilk VARIM diyen alır. Organizatörler seçer: MatchTime hiçbir yeri kendisi doldurmaz. VARIM diyen herkes yedek listesine girer; kulüp sahibi ve yöneticiler yedek listesini, mevkileri ve kulüp puanlarını içeren bir WhatsApp mesajı alır. Numara ya da isimle ilk yanıt veren yöneticinin seçtiği oyuncu kadroya girer." |
| If nobody picks in time | "If no admin replies within a day, or 4 hours before kickoff at the latest, MatchTime either offers the place to the whole waiting list (first to say IN gets it) or leaves it open." | "Hiçbir yönetici bir gün içinde, en geç maçtan 4 saat önce yanıt vermezse, MatchTime yeri ya tüm yedek listesine sunar (ilk VARIM diyen alır) ya da boş bırakır." |
| Drop-out deadline | "The last time players can pull out without it counting as late. MatchTime reminds the group 3 hours before, then messages the admins with who is out and who is waiting. An OUT after the deadline still counts, and the admins are told it was late." | "Oyuncuların geç sayılmadan çıkabileceği son saat. MatchTime 3 saat önce gruba hatırlatır, sonra yöneticilere kimin çıktığını ve kimin beklediğini yazar. Son çıkış saatinden sonra YOKUM yine geçerlidir, yöneticilere geç olduğu bildirilir." |
| List published | "When MatchTime posts the final list in the group: who is playing and who is on the waiting list. With this and a drop-out deadline set, MatchTime stops the daily 17:00 post, except on match day." | "MatchTime'ın son listeyi gruba gönderdiği zaman: kim oynuyor, kim yedekte. Bu ve son çıkış saati ayarlıysa MatchTime, maç günü dışında her gün 17:00'de gönderdiği mesajı durdurur." |

Playwright covers the section (EN and TR), each ⓘ opening, and validation messages.

---

## 6. Cross-cutting

- **Prompts:** none change in any slice. The router and extractors already read "waiting list" and "yedek" as bench; players are only ever told to say IN or OUT (VARIM, YOKUM), words the pipeline already handles. Every new message is composed by code from database facts.
- **Model calls:** slices 1 to 4 add zero. Slice 1 removes the composer calls for rolling clubs' 17:00 short-squad post and three chases. No live-LLM suite or dry run is needed for any slice (the CLAUDE.md approval rule does not apply: no prompt changes).
- **Copy:** every new string in EN and TR via `src/lib/i18n`, pinned by `copy-golden.test.ts`, no em or en dashes (`strings.test.ts`). Existing English bytes unchanged.
- **Sutton FC:** every setting defaults to today's behaviour; the first-come branch of `canTakeFreePlace` is today's arithmetic; goldens prove the bytes.
- **AttendanceEvent:** two new causes, `rolling-squad` and `organiser-pick`, both written in the same transaction as their change.
- **Terminal short-circuits:** the new scheduler branches are separate blocks with their own keys and no `continue` or `return` above existing guards; the new dm-reply handler returns only when it handled the DM.

---

## 7. Edge cases, collected

| Case | Behaviour |
|---|---|
| First week in MatchTime (no source) | Cold announce; squad built by IN and admin adds; "Carry over" button available from the week after. |
| Previous match cancelled | Skip it, use the one before within 21 days (D1). |
| Two fixtures in one club | Each fixture seeds from its own previous match. Club-level deadlines resolve per match. |
| Next week smaller format | Overflow to waiting list in last week's order. |
| Player said OUT for next week before seeding | Stays OUT. |
| Admin removes a no-show from last week after 08:00 | Not re-synced; edit next week directly. |
| Carried player says IN | Idempotent, ✅ as today. |
| Carried player says maybe | Stays in; listed under "Said maybe" for admins. |
| Late OUT | Recorded, 👋, admin DM, not charged by MatchTime (D6). |
| OUT typed before the deadline, delivered after | On time (send time counts). |
| Organiser club, new player IN with places open | Waiting list 🪑; admins get a pick round. |
| Dropped player says IN again, place still free | Reclaims it. |
| Two admins reply at once | Lock and capacity: one wins, the other gets P4. |
| Admin replies with old numbers | P5, nothing applied. |
| Admin picks a player who left the bench | Skipped with the reason; others applied. |
| Admin is also on the waiting list | Can pick himself. |
| Pick after teams exist | Seated in the slot actually vacant; the group post names that slot's holder. |
| No admin has a phone | No round DMs; fallback runs at `fallbackAt`; health note on `/admin/health`. |
| Drop 3 hours before kickoff | Round opens, fallback 1 hour later. |
| Drop at 23:00 | Round waits for 08:00. |
| Bot muted | Seeding still happens; nothing is posted or DMed until unmuted. |
| Club dormant or not approved | No seeding, no posts. |

---

## 8. Decisions for Kemal

| # | Question | Recommendation |
|---|---|---|
| D1 | After a cancelled week, who is carried over? | The last PLAYED match within 21 days. Longer gap: no carry-over, admin can press "Carry over". |
| D2 | Do last week's bench players carry onto the waiting list? | No. "Rolling" means "played". They say IN again. |
| D3 | When is the squad carried over? | 08:00 the morning after the match, so admins can remove no-shows first. |
| D4 | With weekly deadlines set, does the daily 17:00 post stop? | Yes, except on match day. The reminder, summary and list replace it. |
| D5 | No admin picks in time: offer to the waiting list, or leave empty? | Offer to the waiting list (first to say IN), after a day or at kickoff minus 4h, whichever is first. Club can switch to "leave empty". |
| D6 | Should a late drop-out still owe the fee? | Not in these slices (MatchTime charges only who played). Add a setting later if Hamzah wants it. |
| D7 | Settings page only, or also the in-group setup? | Settings page only, plus a one-line tip at the end of setup. |
| D8 | Club-level or fixture-level deadlines? | Club-level (one group per club; a format switch must not move the deadline). |
| D9 | Pick numbering: should picking several players let admins choose which vacated slot each fills (e.g. the GK for the GK)? | No. Sheet order, as the bench claim does today; admins swap on the teams page. |
| D10 | Shipping order | 4 first (tiny), then 1, 2, 3. |
