# Friday group features: rolling squad, organiser-picked bench, weekly deadlines, 9-a-side

Design only. 2026-09-30. No code in this PR.

**Status: decided.** Kemal accepted every section 8 recommendation (D1 to D10) on 2026-09-30, and added the admin channel and the admin WhatsApp group to slice 2 (D11 to D13). This version is written with those decisions in.

Written for Hamzah's Friday 9-a-side group (admins Hamzah, Raihan, Wasim) after Kemal's demo. Everything here is a per-club setting that is OFF by default, so Sutton FC (`cmnnwhdx30000zfr85q18lyy9`) behaves exactly as it does today.

---

## Summary for Kemal (one screen)

**What Hamzah's group does today, by hand:** if you played last week you are in this week unless you tell an admin you can't. Payments happen over the weekend. Monday is the drop-out deadline and chase day. The list goes out Tuesday evening. When a place opens, the admins choose who fills it from the waiting list, by position and preference, not first come first served. They pay by bank transfer. The admins talk in their own HQ WhatsApp group. Their worry is "losing control as to who's playing".

**What we build, in four slices (slice 2 is two PRs):**

1. **Rolling squad.** At 08:00 the morning after a match, everyone who actually played it (confirmed at the final whistle) is put straight into next week's squad. The morning post says "You're in unless you say OUT by Monday 21:00." Bench players, phoneless guests and anyone who has left the group are not carried over. An OUT after the deadline still counts (the squad must be true), but the admin channel is told it was late. No model calls are added; the club's scheduled chase posts actually switch from the model-written text to fixed text, so it costs less.
2. **Admin channel, and organiser picks from the waiting list.**
   - *2a, admin channel.* A club chooses where admin messages go: one person by DM (a new club's default: the owner), an admin WhatsApp group, or each admin by DM (today; every existing club, Sutton included, stays on this). The admin group is linked once: the settings page shows a code, the organiser adds MatchTime to the HQ group and sends "@Match Time admin group CODE", and MatchTime replies "✅ Linked as the admin group for <club>." Adding MatchTime to the HQ group never starts the in-group setup: an add by an admin of an existing club waits silently for the code.
   - *2b, organiser pick.* MatchTime never fills an open place by itself. Anyone who says IN goes on the waiting list. When a place is open and someone is waiting, the admin channel gets one message with the numbered list (position and club rating). An admin replies "2", "Wasim" or "@Wasim": the admin channel gets "✅ Done: Wasim is in, replacing Hamzah (picked by Raihan).", the group gets "✅ Wasim is in, replacing Hamzah. Squad 18/18.", and Wasim gets a DM. The first reply wins; a second admin gets "Already filled". In the admin group MatchTime reads only numbers, names, tags, ALL, NONE and YES while a pick is open, and ignores everything else, so the group costs nothing in AI. If nobody picks in time, the place is offered to the whole waiting list, first to say IN. The match page gets a waiting list the admins can reorder and pick from.
3. **Weekly deadlines.** Two club settings: drop-out deadline (e.g. Monday 21:00) and list publish time (e.g. Tuesday 20:00). MatchTime posts a reminder in the group 3 hours before the deadline, sends the admin channel a summary (and the waiting list to pick from) when it passes, and posts the final list at publish time. The daily 17:00 post is replaced by this rhythm for these clubs, except on match day.
4. **9-a-side preset.** `football-9aside`: GK 1, DEF 3, MID 3, FWD 2 per team, 18 players. 8-a-side from #148 checked and fine.

**How an organiser turns it on:** a new "Weekly routine" section and an "Admin messages go to" control on `/admin/settings`, each setting with an ⓘ explaining it (EN and TR). Not in the in-group setup.

**Order (D10):** slice 4 first (tiny, independent), then 1, 2a, 2b, 3. Slice 1 works without slice 3 (it uses the match's existing sign-up deadline until a weekly one is set).

**No prompt changes anywhere.** "Waiting list" is already bench vocabulary for the router. No live-LLM runs are needed for any slice. Slice 2a is the only slice with a Pi change; server and Pi can deploy in either order (2.17).

**Decisions:** all taken, see section 8.

---

## 0. What I checked

- Code read on `origin/main` at `75b87d9`: `bot-scheduler.ts`, `attendance.ts`, `bench-confirmation.ts`, `team-slot-fill.ts`, `team-requests.ts`, `late-message.ts`, `tentative-followup.ts`, `recruit.ts`, `recruit-chase.ts`, `attendance-events.ts`, `pipeline/engine.ts` (capacity and slot-open arms), `dm-reply/route.ts`, `cron/generate-matches`, `match-completion.ts`, `next-upcoming-match.ts`, `sport-presets.ts`, `club-connect-rules.ts`, `org-features*.ts`, `/admin/settings`, the match page components, the i18n tables.
- Prod DB, plain SELECTs only. There is a "FNF test" org (`cmuh0m1e6000b05ldc1zhfetz`, created 2026-09-25, activity "FNF (16/18 players)", Friday 20:30, bot not enabled, no group linked, 1 owner and 2 players, sport `football-7aside` with 7 per side). If that is the demo org for Hamzah, its Sport row has to become 9-a-side (slice 4) before it goes live; presets are copied at creation and never re-applied.
- Sutton FC's only active activity is Tuesday 7-a-side, 21:30, `deadlineHours = 0`, bench on.
- For the admin channel (slice 2a), on `origin/main` at `ed1eb47`: `bot-added/route.ts`, `group-add.ts`, `club-approval.ts` (silence rails), `orgs/route.ts`, `onboarding-parse.ts` (`ONBOARDING_AUTOSTART`, which is `1` in production), the call sites of `findOrgAdminsWithPhone`, `pipeline/mention-names.ts` (PR #161), and on the Pi `handlers.ts`, `index.ts`, `bot-added.ts`, `org-refresh.ts`, `mentions.ts`, `scheduler.ts`.

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
- **OUT after the deadline** is still recorded, the player gets the normal 👋 react and nothing else, and the admin channel (slice 2a) gets one message saying it was late.
- **Everything else** (IN from a new player, bench, bench offers, teams, payments, ratings) works as it does today.

### 1.2 Exactly which match is "last"

`pickSeedSource(target, candidates)` (pure), in `src/lib/rolling-squad-rules.ts`:

- Same recurring fixture as the target, using `isSameRecurringFixture` (org, venue, weekday). This is the identity the rollover guard already uses, and it is deliberately NOT `activityId`, because a format switch re-points a match to the other activity.
- `status = COMPLETED`, `isHistorical = false`, `date < target.date`.
- The most recent one within `ROLLING_LOOKBACK_DAYS = 21`.
- **After a cancelled week:** the cancelled match is skipped and the one before it is used, if it is within 21 days. The cancelled week's own attendance (people who said OUT for that week only) is ignored. Decided, D1.
- **Longer gap** (summer break, a month off): no source, no seeding. The match opens empty and the ordinary cold announcement fires. The admin can press "Carry over last squad" on the match page (1.9) if they want it anyway.
- **The target** is the soonest live (UPCOMING) match of that fixture after the source, not already seeded, with `now < date`. Only one target per source.

### 1.3 Who is carried over

`decideSeed({ sourceRows, memberships, users, targetRows, maxPlayers })` (pure) returns an ordered list of `{userId, status: "CONFIRMED" | "BENCH", note}`.

| Player on the source match | Carried over? | Why |
|---|---|---|
| CONFIRMED at completion | Yes, CONFIRMED | "If you played last week you're in." |
| BENCH (never got a place) | No | Did not play. Decided, D2. |
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
- places open, organiser-pick club (slice 2b): "{k} places open: say *IN* to go on the waiting list, and the organisers will pick who plays."
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

**R4. Late drop-out notice to the admin channel**, one per drop, sent through `sendAdminNotice` (slice 2a, 2.2), key `<matchId>:late-drop:<userId>` plus the channel suffix, London 08:00 to 21:59 (held until 08:00 otherwise). If slice 1 ships before 2a, it goes to the owner and admins with a phone (`findOrgAdminsWithPhone`), key suffix `:<adminId>`, and 2a moves it onto the router.
- EN: "Late drop-out: *{name}* said OUT for *{activity}* ({when}) at {time}, after the {deadline} deadline. Squad is now {n}/{max}."
- TR: "Geç çıkış: *{name}*, *{activity}* ({when}) için {time} saatinde YOKUM dedi, son çıkış {deadline} idi. Kadro şimdi {n}/{max}."

With organiser pick on (slice 2b), this is folded into the pick message instead (its first line becomes "*{name}* dropped out after the deadline."), so the admin channel gets one message, not two.

### 1.6 OUT after the deadline, precisely

- **The time that counts is when the player sent it**, not when it reached us. The analyze path already carries the WhatsApp `timestamp` (see `late-message.ts`); DMs carry one too. `cancelAttendance` gets an optional `{ occurredAt?: Date }` argument; callers that know the send time pass it, the web button passes nothing (now). A "sorry can't make it" typed at 20:55 and delivered at 21:40 is on time.
- **Recorded:** the row goes DROPPED, bench offer or pick round follows as normal. MatchTime does not refuse a late OUT. A squad that lists someone who has told us they are not coming is the worst state this product can be in.
- **Marked:** the `AttendanceEvent` note says "after the drop-out deadline ({deadline})". No new column; the admin view derives lateness from event time vs deadline.
- **Money:** a DROPPED player is not in the CONFIRMED set, so MatchTime sends them no payment link and does not list them as unpaid. Decided (D6): late drop-outs owe nothing in these slices; a setting can come later if Hamzah wants it.
- **Late-message rule unchanged:** a message more than 30 minutes old on arrival still records attendance silently; the late-drop notice (R4) still goes, because it is to the admin channel, not a reply in the group.

### 1.7 Interactions

| Area | What happens | Change needed |
|---|---|---|
| Bench and bench offers | A rolling club with first-come bench: drop opens a `BenchSlotOffer` exactly as today. | None. |
| Tentative ("maybe") | A carried-over player saying "might not make it" writes nothing (as today). The follow-up guard already skips CONFIRMED players, so they are not DMed and stay in. Slice 3's admin summary lists them under "Said maybe". | None in slice 1. No new DM, so no new model call on the reply path. |
| Recruit invites (`inviteRecentPlayers`) | Already excludes anyone with any attendance row on the match (`recruit.ts` ~278). Carried players have a row, so they are never invited. | Test only, to pin it. |
| Recruit chase-ups | Signal 1 (any attendance row) already treats them as responded. | Test only. |
| 17:00 update | R2 line; static text for rolling clubs. Slice 3 silences it off match day (D4). | Scheduler branch. |
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

## 2. Slice 2: Admin channel and organiser-picked waiting list

Slice 2 ships as two PRs, 2a then 2b, in the D10 slot (after slice 1, before slice 3):

- **2a. Admin channel.** The "Admin messages go to" setting, linking an admin WhatsApp group with a code, keeping that group out of the in-group setup, the Pi changes, and routing every admin-only notice through one router. Useful on its own: a club stops getting three copies of every admin notice.
- **2b. Organiser pick.** The shared capacity rule, pick rounds, and reading the admin's reply in a DM or in the admin group, by code only.

### 2.1 Behaviour

**Admin channel (2a).** Every admin-only notice goes to the club's admin channel, chosen on `/admin/settings` under "Admin messages go to":

| Choice | Who receives | Replies read from |
|---|---|---|
| **One person** (default for a new club: the owner) | a chosen owner or admin, by DM | that person's DM |
| **Admin WhatsApp group** | one post in a group linked once with a code (2.3) | that group, deterministic replies only (2.8) |
| **Each admin by DM** | the owner and every admin with a phone, as today | each admin's DM |

The migration sets every existing club, Sutton FC included, to "each admin by DM", so their notices, texts and keys are byte for byte today's. New clubs start on "one person", the owner.

The notices routed through the channel:
- the waiting-list pick (P1) and every pick follow-up (2.9, 2.10, 2.11);
- the deadline summary (D2, slice 3);
- late drop-outs (R4, slice 1);
- the unpaid list (U1, new, 2.12), only for clubs not on "each admin by DM", so existing clubs get no new message;
- new-player review: the daily provisional-member review and the "new player said IN" notice.

The remaining admin DMs (someone joined or left the group, the switch-format nudge, the cancel nudge) go through the same router, so a club on "one person" really has one recipient. For "each admin by DM" they are unchanged.

**Organiser pick (2b).** A club with `benchPickMode = "organiser"`:

- **No open place is ever filled by MatchTime on its own.** A non-admin IN, from a new player or from the bench, lands on the waiting list (BENCH), even with places open. The only ways into the squad are: carried over (slice 1), an admin pick (admin channel or match page), an admin instruction in the community group ("@Match Time put Wasim in", already admin-authorised), an admin adding on the match page, or the fallback offer (2.11).
- **One exception, the reclaim:** a player who was CONFIRMED on this match, said OUT, and says IN again while a place is still free gets it back. "Sorry, wrong group, I'm in" must not cost a regular his place.
- **When there is a free place and someone waiting**, a pick round opens and the admin channel gets one pick message (P1).
- **Team sheet** unchanged: balanced teams, admins swap if they want.

### 2.2 The admin channel router (2a)

`resolveAdminNoticeTargets(org, admins, piCaps)` (pure, `src/lib/admin-channel-rules.ts`) returns either `{ kind: "dm", users }` or `{ kind: "group", groupId }`:

- **each-admin:** every OWNER/ADMIN with a phone and an active membership, exactly today's `findOrgAdminsWithPhone`.
- **one-person:** `adminChannelUserId` if that user is still OWNER/ADMIN, active and has a phone; otherwise the owner; otherwise each-admin (and a health note on `/admin/health`). NULL means the owner.
- **admin-group:** the linked group, but only when the Pi polling due-posts has advertised the `admin-group` capability (2.5). Otherwise, and when no group is linked, the one-person rule with the owner. A rolled-back Pi therefore never swallows a notice.

`sendAdminNotice(org, notice)` (`src/lib/admin-channel.ts`) is the one door. Every call site that today loops over `findOrgAdminsWithPhone` (`attendance/route.ts`, `group-join/route.ts`, `group-leave/route.ts`, the provisional-review, switch-nudge and cancel-nudge blocks in `bot-scheduler.ts`) and every new notice in slices 1 to 3 goes through it.

**Keys.** For each-admin the keys stay today's (`...:<adminId>`), which is what keeps Sutton's sends identical. For one-person the key ends `:<userId>`; for the group it ends `:admin-group`. Switching channel mid-week can therefore deliver a notice that is still due once more, on the new channel. That is intended: the new channel has not seen it.

**Links.** DMs keep their personal signed-in, club-pinned links (#160). A post in the admin group carries the plain club-pinned URL, which asks for sign-in: a personal sign-in link posted in a group would let anyone in that group sign in as that admin.

**Quiet hours.** Group notices use the same 08:00 to 21:59 London gate as admin DMs. Group posts are not subject to the Pi's one-DM-a-minute gap, so a group notice reaches all admins at once, where three DMs take three minutes.

### 2.3 Linking the admin WhatsApp group (2a)

**On the settings page**, choosing "Admin WhatsApp group" shows a **Link admin group** button. Pressing it (OWNER/ADMIN, `createAdminGroupLinkCode`) creates a single-use 6-character code from an unambiguous alphabet (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`, e.g. `K7P3QX`), valid 48 hours, unique across clubs, and shows three steps:

1. Keep this page open. Your code: *K7P3QX*.
2. Add MatchTime to your admins' WhatsApp group.
3. In that group, send: `@Match Time admin group K7P3QX`

The page polls and turns into "Linked: *{group subject}*" with an **Unlink** button. Until the link completes, the saved mode stays what it was; the choice only takes effect once a group is linked. Pressing the button again replaces the code.

**In WhatsApp**, the organiser sends `@Match Time admin group K7P3QX` (TR `@Match Time yönetici grubu K7P3QX` also accepted). The Pi forwards it (2.5) to `POST /api/whatsapp/admin-group-link`. The server, `linkAdminGroup` in `src/lib/admin-group-link.ts`:

1. Parses the code from the text (pure `parseAdminGroupLinkMessage`: bot mention or "match time", then "admin group" or "yönetici grubu", then a 6-character token; case-insensitive).
2. Resolves the sender by phone (or a LID pair the server already stores), never by pushname.
3. Checks, in one transaction: the code exists and is unexpired; the sender is OWNER/ADMIN of that club; the group is not any club's community group; the group is not another club's admin group.
4. Writes `adminGroupId`, `adminGroupSubject`, `adminGroupLinkedAt`, `adminGroupLinkedByUserId`, clears the code, sets `adminChannelMode = "admin-group"`. Marks the group's `UnsolicitedGroup` row left (so it is no longer silent and no 48-hour leave fires) and abandons any active `OnboardingSession` for the group.
5. Answers with `replyText` and `adminGroup: { groupId, orgId }`, so the Pi treats the group as an admin group at once, not at its next `/orgs` refresh.

| Key | When | EN | TR |
|---|---|---|---|
| L1 | linked | "✅ Linked as the admin group for *{club}*." | "✅ *{club}* için yönetici grubu olarak bağlandı." |
| L2 | wrong or expired code, sender IS an owner or admin of an approved club | "That code isn't valid any more. Open Settings on the website and press *Link admin group* for a new one." | "Bu kod artık geçerli değil. Sitede Ayarlar sayfasını açıp yeni kod için *Yönetici grubunu bağla* düğmesine basın." |
| L3 | the group is the club's community group | "This is *{club}*'s main group, so it can't be the admin group. Add me to a separate group for the admins." | "Bu, *{club}* kulübünün ana grubu; yönetici grubu olamaz. Beni yöneticiler için ayrı bir gruba ekleyin." |
| L4 | MatchTime removed from the admin group; DM to the owner | "I was removed from *{club}*'s admin group, so admin messages now come to you by DM. You can link a group again in Settings." | "*{club}* yönetici grubundan çıkarıldım, bu yüzden yönetici mesajları artık size DM olarak gelecek. Ayarlar'dan yeniden bir grup bağlayabilirsiniz." |

Anyone else (a wrong code from someone who is not an admin anywhere, a group that is another club's admin group) gets **no reply**: the group stays silent, so the command cannot be used to probe codes or clubs.

**Unlink** (settings page, `unlinkAdminGroup`): clears the group, sets the mode to one-person (the owner), and queues a leave through `queuePlatformLeaveGroup`. **Removed from the group** (`bot-removed` for a linked admin group): the same clearing, plus L4 to the owner. Language: the club's `Organisation.language`.

### 2.4 Keeping the admin group out of the in-group setup (2a)

**The risk.** `ONBOARDING_AUTOSTART=1` in production. With self-join off, `bot-added` today treats any group that is not a club's group and not silent as a new club: it creates an `OnboardingSession` and hands the Pi the setup intro to post. Adding MatchTime to Hamzah's HQ group would start the in-group setup there. With self-join on, the same add is recorded as unsolicited: silent, and left after 48 hours.

**The rule.** `bot-added` recognises an **admin-group candidate** and waits for the code instead. `isAdminGroupCandidate` (pure, `admin-channel-rules.ts`) is true when either holds:

- the adder, resolved by phone or by a LID pair the server stores, is OWNER/ADMIN of an approved club; or
- an unexpired admin-group link code exists for an approved club, and one of the group's participants (from the snapshot the Pi already sends) is OWNER/ADMIN of that club. This covers an adder whose LID cannot be resolved yet.

A candidate gets: an `UnsolicitedGroup` row with `awaitingAdminLink = true`, no session, no intro, no owner-approval DM, no organiser ack, and the answer `{ ignored: "admin-group-awaiting-code", silent: true, introText: null }`. The group is silent from that moment, so nothing in it reaches `analyze`, and the "@MatchTime setup" trigger is dropped by the existing rail (`isSilentGroup` in the Pi, `inGroupSetupRefusal` on the server). The one thing that still gets through is the link command (2.5).

**Where the check sits**, so no path runs before it:

- **Self-join off (today in prod):** step 1a of `bot-added/route.ts`, right after the live-org check and before `inGroupSetupRefusal`, the active-session check and session creation.
- **Self-join on:** in `handleSelfJoinGroupAdd` (`group-add.ts`), after the approved-owner, other-owner and already-linked checks and after the connect-request match, before recording `unsolicited`. A matching connect request wins: an organiser who asked to connect a new club with a code has said what he wants.
- The reconnect sweep (`discovered: true`) never creates a candidate; it stays what it is today.

**Lifetime of a candidate.** With self-join on, the existing 48-hour auto-leave applies to candidate rows too, so the code must be sent within 48 hours; the settings page says so. With self-join off, nothing leaves: the group sits silent until linked or until an admin removes MatchTime.

**If the check misses** (an admin whose phone and LID are both unknown adds MatchTime before pressing the button), today's behaviour follows. That is why the settings page orders the steps "press the button, then add MatchTime". If the setup intro did go out, the link still works: linking abandons the session, and the intro only asks for consent, so nothing has been created.

**Not a candidate:** an adder who is only a player somewhere, or nobody we know, with no open code. That is a new club and follows today's path unchanged.

### 2.5 The Pi (2a)

- **`/orgs`** gains `adminGroups: [{ groupId, orgId }]`. `computeSilentGroups` never lists a linked admin group, and `loadSelfJoinSweep` counts admin groups as known. An older Pi ignores the new field.
- **`handlers.ts`** gets a third set, `adminGroups`, with `setAdminGroups`, `addAdminGroup`, `isAdminGroup`. An admin group is never in `monitoredGroups` or `onboardingGroups`, and `addAdminGroup` removes it from the silent set.
- **Inbound, in `index.ts`, before the `isMonitoredGroup` drop:**
  1. `isAdminGroup(gid)`: forward the message at once (no 10-minute batch) to `POST /api/whatsapp/admin-group` with `{ groupId, messageId, text, mentionNames, senderPhone, senderLid, senderAltPhone, timestamp }`, flagged `channel: "admin-group"`. Mentions go through the same `rewriteMentions` path as the community group, so a LID mention carries the phone behind it (PR #161). The message is never put in the analysis history and never enqueued for `analyze`. Joins, leaves, reactions and polls in an admin group are not forwarded (an HQ group must never enrol members into the club); only the bot's own removal is.
  2. Not a live club group and not an admin group, and `looksLikeAdminGroupLink(body, mentionsBot)`: forward to `POST /api/whatsapp/admin-group-link`. This runs even for a silent group, which is the one narrow exception to the silence rail: only a message shaped exactly like the link command leaves the Pi, and the server decides. On `adminGroup` in the answer, `addAdminGroup`; on `replyText`, post it.
  3. Everything else from unmonitored and silent groups is dropped, as today.
- **Outbound.** A new due-post instruction kind, `admin-group-message { groupId, text, key }`, carrying its own group id, returned in the owning club's normal due-posts poll. The Pi sends it only if `groupId` is in its `adminGroups` set. The Pi advertises support with the header `x-mt-pi-caps: admin-group` on the due-posts request; the server emits the kind only when it sees that header (2.2).
- **Deploy** with `scripts/deploy-pi.sh`, never a bare `systemctl restart`.

### 2.6 The shared capacity rule (2b, the one real refactor)

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

### 2.7 Pick rounds (2b)

**Opening a round.** `sweepOrganiserPicks(orgId, now)` runs in `/api/whatsapp/due-posts` next to `sweepExpiredBenchConfirmations`, before `computeDuePosts`. For the next live match of each fixture (`isNextUpcomingForPosting`), it opens a round when ALL hold:
- `openPlaces = maxPlayers - confirmed > 0`
- the waiting list (BENCH rows, active membership) is not empty
- the weekly drop-out deadline has passed (slice 3) or none is set
- London 08:00 to 21:59
- no open round for the match, OR the open round is stale (a new drop since, or the list changed) AND its message went out at least 60 minutes ago; then the old round is closed `superseded` and a new one opens. That 60-minute floor is the rate limit: at most one pick message per channel per hour per match.

The round records the channel it was sent on (`dm` or `admin-group`) and, for DMs, the recipients. Replies are read only where the round was sent.

**Closing a round.** The sweep closes it when `openPlaces` reaches 0 (`filled`), at kickoff (`closed-at-kickoff`), or at `fallbackAt` (2.11).

**The message.** `computeDuePosts` emits it through `sendAdminNotice`: one DM per recipient (key `pick-<roundId>:dm:<userId>`) or one admin-group post (key `pick-<roundId>:admin-group`). Positions come from `PlayerActivityPosition` for the match's activity; rating is the raw club rating players see (`loadClubRating(...).rating`, one small read each, the list is short), or "new" when there is none. The seed rating is never shown.

**P1. The pick message**, EN:
```
*Hamzah* dropped out of *{activity}* ({when}). 1 place open, squad 17/18.

Waiting list:
1. Kemal (GK, 7.4)
2. Wasim (MID, 7.9)
3. Ali (no position, new)

Reply with a number or a name to bring someone in, e.g. *2*, or *2 3* for two. Reply *NONE* to leave it open.
If nobody picks by {fallbackWhen}, I'll offer the place to the whole waiting list.
```
In the admin group the instruction line reads: "Reply here with a number, a name or an @tag, e.g. *2*, or *2 3* for two. *NONE* leaves it open."

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
Admin group line: "Buraya numara, isim ya da @etiket yazın, örneğin *2*, iki kişi için *2 3*. *HİÇBİRİ* yazarsanız yer boş kalır." Other TR variants: "*Ali* ve *Sam*, ... maçından çıktı."; "*Ali*, ... maçından son çıkış saatinden sonra çıktı."; "*{activity}* ({when}) için 1 yer boş, kadro 17/18."; "*{activity}* ({when}) için son çıkış saati geçti."; leave-empty: "{fallbackWhen} saatine kadar kimse seçmezse yer boş kalır."

### 2.8 Reading replies (2b; deterministic, no model)

One parser, two doors. Nothing on either path calls a model, so a pick costs nothing.

**The parser.** `parsePickReply(text, mentions, ctx, lang)` (pure, `src/lib/organiser-pick-rules.ts`). Text is folded with Turkish-aware lower-casing and accent folding (`name-normalise.ts`) after the bot mention is stripped. It returns a pick, NONE, YES, not-understood, or not-a-pick:
- **Numbers:** `2`, `2 3`, `2, 3`, `2 and 3`, `2 ve 3`, ranges `1-3` (max 10). Resolved against the round's stored `listUserIds` (the list as sent), never the live bench.
- **Names:** a full name, or a first name unique within the candidates, separated by commas, "and" or "ve". A leading `@` typed as plain text is ignored, so `@Wasim` typed by hand reads as `Wasim`. Candidates are looked up in this order: the round's list, then the match's CONFIRMED players (answer E2), then the club's other active members (answer E1).
- **@tags:** a real WhatsApp mention is resolved through `resolveMentionNames` (PR #161): the phone the Pi forwards behind a LID, then the LID pairs the server stores, matched against the club's roster (not the admin group's members). WhatsApp only offers tags for members of the group being typed in, so in the admin group this works for players who are in it; anyone else is typed by name.
- **ALL / HEPSİ:** the list in order, up to the free places (useful for week one).
- **NONE:** `NONE`, `NOBODY`, `LEAVE IT`, `HİÇBİRİ`, `KİMSE`. Not "YOK": an admin who is also playing may mean his own OUT.
- **YES / EVET:** only when an E1 question is pending on the round (2.10); otherwise not-a-pick.

**Door 1, a DM** (one-person and each-admin modes). `handleOrganiserPickDm` in `src/lib/organiser-pick.ts`, called in `dm-reply/route.ts` right after the self-join handlers and BEFORE the bench-DM block and every model call (the admin-commands classifier, Q&A). It engages only when the sender, **resolved by phone only** (pushname is attacker-controlled; see the removed collector fallback), is a recipient of an open round's DM. A reply that looks like a pick but does not parse (a digit, or a token equal to a listed first name) gets P6; anything else falls through to today's DM handling, so a normal DM from an admin still works.

**Door 2, the admin group.** `handleAdminGroupMessage` in `src/lib/admin-group.ts`, behind `POST /api/whatsapp/admin-group`. The route imports no model module, and a test pins that. Rules:
- No open round for the club: ignore the message, whatever it says, tags included.
- The sender, resolved by phone or stored LID pair, is not OWNER/ADMIN of the club: ignore.
- **Only a whole-message pick is read.** After stripping the bot mention and punctuation, the whole message must be one of: numbers, names that all resolve, one or more @tags, ALL, NONE, or YES while a question is pending. "2" and "Wasim" and "@Wasim" are picks. "Wasim played well last week" is chat and is ignored. There is no P6 in the group: an admins' group talks, and MatchTime answers only what it can act on. The one exception is a real @tag it cannot resolve while a round is open, which gets E4.
- Every answer is posted in the same group, as the Pi's immediate reply to the forward (`replyText`), so the admins see the confirmation next to the reply.
- Idempotent per WhatsApp message id (`admin-group-msg:<messageId>` claim), so a Pi retry never applies a pick twice.

**Both doors:**
- **Stale numbers.** If numbers answer a round that has since been superseded, nothing is applied and the reply is P5 with the current list. Names and tags are still accepted (they are unambiguous).
- **Late replies.** A reply more than 30 minutes old on arrival (same rule and constant as `late-message.ts`) is not executed; the reply is P5 with the current list.
- **First reply wins** (2.9).

### 2.9 Applying a pick, and who is told what (2b)

`applyOrganiserPick(matchId, userIds, admin, source)`, one transaction under `lockTeamSlots(tx, matchId)`:
1. Re-read the squad. For each picked player in reply order: must still be BENCH on this match (or be confirmed with YES, 2.10); a place must still be free (`confirmed < maxPlayers`). Excess picks are dropped (P7).
2. `BENCH -> CONFIRMED` (or a new CONFIRMED row after YES), `AttendanceEvent` cause `organiser-pick`, actorKind `admin`, `actorUserId = admin`, `sourceRef = round id` (or `admin:web`).
3. `fillVacatedSlots(tx, matchId)` so a pick after the teams exist inherits the slot actually vacant, the 29 September rule. Every post names the slot really inherited (`AppliedSlotMove.fromUserId`), never the round's `vacatedByUserIds`.
4. Update the round (`pickedUserIds`, `lastPickedByUserId`); resolve it `filled` if no place is left.

After commit, each keyed so a retry sends nothing twice:

**A1. The admin channel.** In the admin group, the reply to the pick; by DM, to the picker, and to every other DM recipient of the round.
- EN: "✅ Done: *Wasim* is in, replacing *Hamzah* (picked by Raihan)." Open place, no one replaced: "✅ Done: *Wasim* is in (picked by Raihan)."
- TR: "✅ Tamam: *Wasim*, *Hamzah* yerine kadroda (Raihan seçti)." / "✅ Tamam: *Wasim* kadroda (Raihan seçti)."
- In a DM to the picker himself the "(picked by ...)" part is left out.

**A2. The community group**, one post per picked player:
- EN: "✅ *Wasim* is in, replacing *Hamzah*. Squad *18/18*." With teams: "✅ *Wasim* is in, replacing *Hamzah* on *{team}*. Squad *18/18*." Open place: "✅ *Wasim* is in. Squad *18/18*."
- TR: "✅ *Wasim*, *Hamzah* yerine kadroda. Kadro *18/18*." With teams: "✅ *Wasim*, *{team}* takımında *Hamzah* yerine kadroda. Kadro *18/18*." Open place: "✅ *Wasim* kadroda. Kadro *18/18*."
- The group is not told which admin picked. `announceSquadFullIfJustFilled` runs as today.

**A3. DM to the picked player** (a match-invite category DM, so it honours `subMatchInviteDm`; if unsubscribed, A2 is their notice):
- EN: "You're in for {dayTime} at {venue} ⚽ Can't make it after all? Just say *OUT*." For example "You're in for Friday 20:30 at Goals ⚽ ..."
- TR: "{dayTime}, {venue}: kadrodasın ⚽ Gelemeyecek olursan *YOKUM* yazman yeterli."

**The rest of the waiting list** is told nothing and keeps its order. No "you were not picked" messages.

**If the picked player later says OUT**, it is an ordinary drop: the place reopens, and the next sweep opens a new round, so a new P1 ("*Wasim* dropped out of ...") goes to the admin channel.

### 2.10 Pick edge cases (2b)

| Case | What happens | EN | TR |
|---|---|---|---|
| E1 picked player is a club member but not on the waiting list | Nothing applied; the question is stored on the round (`pendingConfirmUserId`, asked by, asked at). A YES from any admin on the same channel within 30 minutes, while a place is free, brings them in (A1 to A3). A new pick replaces the question. | "*Wasim* isn't on the waiting list. Bring them in anyway? Reply *YES*." | "*Wasim* yedek listesinde değil. Yine de kadroya alayım mı? *EVET* yazın." |
| E2 picked player is already in | Nothing applied. | "*Wasim* is already in. Pick someone else?" | "*Wasim* zaten kadroda. Başka birini seçer misiniz?" |
| E3 two admins at once | The lock and the capacity check decide: the first commit wins; the second finds no place. | "Already filled: *Wasim* is in (picked by Raihan)." | "Bu yer doldu: *Wasim* kadroda (Raihan seçti)." |
| E4 a real @tag MatchTime cannot resolve, round open | Nothing applied. | "I couldn't tell who that is, can you type their name?" | "Bunun kim olduğunu anlayamadım, adını yazar mısınız?" |
| E5 a first name that fits two candidates | Nothing applied. | "Two players are called *Ali*: *Ali Khan* and *Ali Demir*. Which one? Reply with the full name." | "İki oyuncunun adı *Ali*: *Ali Khan* ve *Ali Demir*. Hangisi? Tam adını yazın." |
| A tag, name or number in the admin group with no round open | Ignored. No reply. | | |
| A name that matches nobody in the club | Admin group: ignored (it is chat). DM: P6 only if it matches the pick shape. | | |

**Other admin-channel replies:**

| Key | EN | TR |
|---|---|---|
| P5 list changed | "The waiting list has changed since my last message. Here it is again:" + list + instructions | "Son mesajımdan beri yedek listesi değişti. Güncel hali:" + list + instructions |
| P6 not understood (DM only) | "I couldn't match that to the waiting list. Reply with a number from the list (e.g. *2*) or a full name. *NONE* leaves the place open." | "Bunu yedek listesiyle eşleştiremedim. Listeden bir numara (örneğin *2*) ya da tam isim yazın. *HİÇBİRİ* yazarsanız yer boş kalır." |
| P7 more picks than places | "Only {k} place was open, so I brought in your first pick: *Wasim*." | "Sadece {k} yer boştu, bu yüzden ilk seçiminizi aldım: *Wasim*." |
| P8 NONE | "OK, I'll leave the place open. You can still pick from the waiting list on the match page." | "Tamam, yeri boş bırakıyorum. Maç sayfasından yine yedek listesinden seçebilirsiniz." |
| P11 fallback, offer | "Nobody picked for *{activity}*, so I've offered the place to the waiting list: the first to say IN gets it." | "*{activity}* için kimse seçim yapmadı, bu yüzden yeri yedek listesine açtım: ilk VARIM diyen alır." |
| P12 fallback, leave empty | "Nobody picked for *{activity}*, so the place stays open. Squad {n}/{max}." | "*{activity}* için kimse seçim yapmadı, yer boş kalıyor. Kadro {n}/{max}." |

### 2.11 If no admin answers (2b)

`fallbackAt = min(round opened + 24h, kickoff - 4h)`, but never sooner than 1 hour after the round opened. A superseding round keeps the earlier `fallbackAt` (floored the same way). Setting `benchPickFallback`:

- **`bench-offer` (the default, D5):** create one `BenchSlotOffer` per free place (`replacingUserId` from the round's unfilled drops, else null), close the round `fallback-bench-offer`, send P11 to the admin channel. From there the existing first-come machinery runs unchanged: group post tagging the waiting list, a DM to each, first IN wins (`canTakeFreePlace` allows it because an offer is open).
- **`leave-empty`:** close the round `fallback-left-open`, send P12 to the admin channel. The ordinary short-squad chases still run.

### 2.12 Other interactions

- **The engine's "a place just opened" group post** (the slot-opened arm in `engine.ts`): in organiser mode it is suppressed while the waiting list is non-empty (the admins are being asked). With an empty waiting list it posts a variant, P13: EN "A place just opened in *{activity}*. Say *IN* to go on the waiting list, and the organisers will pick who plays." TR "*{activity}* kadrosunda bir yer açıldı. *VARIM* yazın, yedek listesine ekleyeyim; kimin oynayacağını organizatörler seçer." Pure code, no prompt.
- **`requestBenchConfirmationOnDrop`:** returns without creating an offer in organiser mode. Only the fallback creates offers.
- **Recruit invite text** gets the waiting-list wording for these clubs (a small variant in `recruit.ts`'s static copy). Recruit already skips anyone with a row.
- **The web "I'm in" button** goes through `registerAttendance`, so it lands on the waiting list like a message.
- **Admin in the community group, "@Match Time put Wasim in":** admin authority, confirms, cause `admin-message`, and it closes any open round on the next sweep.
- **Rolling squad:** seeding is not subject to the rule (it is not a claim). Organiser mode and rolling squad are independent settings; Hamzah wants both.
- **U1. The unpaid list** (new; clubs on one-person or admin-group only). At 10:00 London two days after a COMPLETED match with payments on and at least one unpaid CONFIRMED player, once, key `<matchId>:unpaid-list`. Uses the same unpaid computation as the group's unpaid tail, which is unchanged. EN "💷 Unpaid for *{activity}* ({when}): {names}. {paid} of {n} paid." TR "💷 *{activity}* ({when}) için ödemeyenler: {names}. {n} kişiden {paid} kişi ödedi."
- **AI cost:** zero model calls. The DM handler runs before every model call on the DM path; the admin-group route has no model path at all; an unparseable DM reply that looks like a pick gets P6 rather than reaching the admin-commands classifier.

### 2.13 Admin pages

**Match page.** On the attendance list (`src/components/match/attendance-list.tsx`), admins of an organiser club see the waiting list with position and club rating, up and down arrows to reorder, and a "Bring in" button per player.
- Reorder: `reorderWaitingList(matchId, orderedUserIds)`. It rewrites `position` for BENCH rows only, reusing the set of positions they already hold, so confirmed positions never move. One `AttendanceEvent` per moved row, cause `admin-squad-edit`, note "waiting list reordered". The pick list order is this order.
- Bring in: `pickFromWaitingList(matchId, userId)`, which calls the same `applyOrganiserPick` (sourceRef `admin:web`), so the web, the DM and the admin group have one writer, one set of posts and the slot fill. A web pick sends A1 to the admin channel with the web admin as the picker.

Observation, not in scope: the existing `moveUpFromBench` action does not call `fillVacatedSlots` or close offers. Sutton's behaviour is left alone; organiser clubs use the new action.

**Settings page.** The "Admin messages go to" control, the person picker, the link flow and Unlink are in section 5.

### 2.14 Data model (additive)

```prisma
model Organisation {
  /// Who fills an open place: "first-come" (today, default) or "organiser".
  benchPickMode     String @default("first-come")
  /// When no admin picks in time: "bench-offer" (default) or "leave-empty".
  benchPickFallback String @default("bench-offer")

  /// Where admin-only notices go: "one-person" | "admin-group" | "each-admin".
  /// New clubs: "one-person" (the owner). The migration backfills every
  /// existing club to "each-admin", today's behaviour.
  adminChannelMode   String  @default("one-person")
  /// one-person: who. NULL = the owner.
  adminChannelUserId String?

  /// The linked admin WhatsApp group. One club per group.
  adminGroupId             String?   @unique
  adminGroupSubject        String?
  adminGroupLinkedAt       DateTime?
  adminGroupLinkedByUserId String?
  /// The pending link code shown on the settings page. Single use.
  adminGroupLinkCode          String?   @unique
  adminGroupLinkCodeExpiresAt DateTime?
}

model UnsolicitedGroup {
  /// Added by an owner or admin of an approved club: silent, no setup,
  /// waiting for "@Match Time admin group CODE".
  awaitingAdminLink Boolean @default(false)
}

/// One ask to the admin channel to fill open places from the waiting list.
model OrganiserPickRound {
  id                 String    @id @default(cuid())
  matchId            String
  match              Match     @relation(fields: [matchId], references: [id], onDelete: Cascade)
  orgId              String
  /// "dm" | "admin-group", fixed when the round opens.
  channel            String
  /// DM recipients when channel = "dm". Replies are read only from these.
  recipientUserIds   String[]  @default([])
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
  /// E1: a "not on the waiting list, YES?" question waiting for an answer.
  pendingConfirmUserId        String?
  pendingConfirmAskedByUserId String?
  pendingConfirmAskedAt       DateTime?
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
Plus `Match.organiserPickRounds OrganiserPickRound[]`, `AttendanceEvent` cause `organiser-pick`, `OrgFeatures.benchPickMode`.

**Migration detail.** `adminChannelMode` is added with `DEFAULT 'each-admin'` (so every existing row, Sutton included, gets today's behaviour), then the default is changed to `'one-person'` in the same migration, so only clubs created afterwards start on the owner. A row CHECK keeps `adminGroupId` different from `whatsappGroupId`; across clubs the link transaction enforces it. 2a carries the Organisation admin-channel columns and `awaitingAdminLink`; 2b carries the pick columns and the round table.

### 2.15 Files touched

**2a:** `prisma/schema.prisma` + migration; `src/lib/admin-channel-rules.ts` (new, pure: targets, candidate rule, link code alphabet and parse); `src/lib/admin-channel.ts` (new: `sendAdminNotice`); `src/lib/admin-group-link.ts` (new: create code, link, unlink, removal); `src/app/api/whatsapp/admin-group-link/route.ts` (new); `src/app/api/whatsapp/bot-added/route.ts` (step 1a); `src/lib/group-add.ts` (candidate outcome); `src/lib/club-approval.ts` (`computeSilentGroups` excludes linked admin groups); `src/app/api/whatsapp/orgs/route.ts` (`adminGroups`); `src/app/api/whatsapp/bot-removed/route.ts`; `src/lib/platform-jobs.ts` (the 48-hour leave skips linked admin groups); `src/app/api/whatsapp/due-posts/route.ts` (reads `x-mt-pi-caps`); the call sites that loop `findOrgAdminsWithPhone` (`attendance/route.ts`, `group-join/route.ts`, `group-leave/route.ts`, `bot-scheduler.ts`); `src/app/admin/settings/page.tsx`, `src/components/settings/admin-channel-section.tsx` (new), `src/app/actions/org.ts` (`setAdminChannel`, `createAdminGroupLinkCode`, `unlinkAdminGroup`); i18n tables + goldens. Pi: `whatsapp-bot/src/handlers.ts`, `org-refresh.ts`, `index.ts`, `api.ts`, `scheduler.ts`.

**2b:** schema + migration; `src/lib/squad-capacity.ts` (new); `src/lib/organiser-pick-rules.ts` (new, pure: parser, round-open decision, `fallbackAt`, message assembly); `src/lib/organiser-pick.ts` (new, DB: sweep, apply, DM handler); `src/lib/admin-group.ts` + `src/app/api/whatsapp/admin-group/route.ts` (new); `src/lib/pipeline/engine.ts` (`applyClaim` via `canTakeFreePlace`, slot-opened arm variant); `src/lib/pipeline/load-state.ts` (reclaim fact, pick mode); `src/lib/attendance.ts`; `src/lib/bot-scheduler.ts` (round messages, U1, `requestBenchConfirmationOnDrop` guard); `src/app/api/whatsapp/due-posts/route.ts` (sweep); `src/app/api/whatsapp/dm-reply/route.ts` (handler, placed first after self-join); `src/lib/attendance-events.ts`; `src/lib/recruit.ts` (copy variant); i18n tables + goldens; `src/components/match/attendance-list.tsx` + `waiting-list-controls.tsx`; `src/app/actions/players.ts` (`reorderWaitingList`, `pickFromWaitingList`); settings page and action.

### 2.16 Tests (TDD: red first)

**2a unit (vitest, no model):**
- `resolveAdminNoticeTargets`: each mode; one-person falls back to the owner when the chosen admin is demoted, left or has no phone, and to each-admin when the owner has no phone; admin-group falls back to the owner without the Pi capability or without a linked group; each-admin equals `findOrgAdminsWithPhone` on every fixture.
- Keys: each-admin keys identical to today's at every converted call site (Sutton); group posts carry plain links, DMs carry personal links.
- `isAdminGroupCandidate`: admin adder by phone; admin adder by stored LID pair; unknown adder with an open code and an admin among participants; a player-only adder with no code is not a candidate; an expired code does not count.
- `bot-added`, self-join off, `ONBOARDING_AUTOSTART` on: candidate gives no session, no intro, a silent `awaitingAdminLink` row; a non-candidate still gets today's session and intro; a live club's group still answers `live-org`.
- `handleSelfJoinGroupAdd`, self-join on: a matching connect request wins over the candidate rule; otherwise the candidate outcome, with no owner-approval DM and no organiser ack.
- `parseAdminGroupLinkMessage`: EN and TR forms, raw bot phone mention, case, missing code, 5 or 7 characters refused.
- `linkAdminGroup`: valid code by an admin links, clears the code, abandons an active session, marks the candidate row left, returns L1; wrong or expired code by an admin gets L2; by anyone else, no reply; the club's own group gets L3; another club's admin group, no reply; a code reused after linking fails.
- `computeSilentGroups` never lists a linked admin group and does list a candidate; the 48-hour leave refuses a linked admin group; `bot-removed` for an admin group clears it, sets one-person and sends L4.
- Pi: `org-refresh` parses `adminGroups` (absent means none); an admin-group message is forwarded to `/admin-group` and never recorded or enqueued for analysis; a join or leave in an admin group is not forwarded; in a silent group only a link-shaped message is forwarded; `admin-group-message` is sent only to a known admin group; the caps header is sent.

**2b unit:**
- `canTakeFreePlace`: first-come identical to today on every input (property-style table); organiser: non-admin IN with room goes BENCH; admin confirms; reclaim confirms; open offer confirms; full is BENCH for everyone.
- Engine: the react for a non-admin IN in organiser mode is 🪑 and matches the write; slot-opened arm suppressed with a waiting list and P13 without.
- `parsePickReply`: numbers, lists, ranges, names (full, unique first, accents, Turkish İ/ı), `@Wasim` typed as text, resolved LID tags (phone forwarded, stored pair), ALL/HEPSİ, NONE/HİÇBİRİ, "yok" NOT none, YES only with a pending question, out of range is not-understood; in the admin group, a sentence containing a name is not a pick.
- Round decisions: opens only with places and a list; not before the drop-out deadline when set; quiet hours; supersede only after 60 minutes; `fallbackAt` arithmetic including a drop 3 hours before kickoff; the round's channel follows the setting at open time.
- `applyOrganiserPick` against the in-memory `SlotFillTx` world: two admins racing for one place (one A1, one E3); pick after teams exist seats in the vacant slot and names the real holder (the 29 September shape: three drops, a join, then a pick); picked player no longer on the bench; E1 then YES; E2; the picked player's later OUT opens a new round.
- Admin-group route: no open round ignores everything, tags included; non-admin sender ignored; the route calls no model (a spy on the Anthropic client sees 0 calls across the whole suite); unresolved tag gives E4; duplicate message id applies once; late reply gets P5.
- dm-reply: pushname-only sender is ignored; a non-recipient admin falls through; a non-admin with digits falls through; late reply gets P5.
- Copy goldens EN and TR for L1 to L4, A1 to A3, E1 to E5, P1 variants, P5 to P8, P11 to P13, U1; `strings.test.ts` no-dash check; existing English bytes unchanged.

**Playwright (free):**
- `e2e/api/admin-group.spec.ts`: bot-added for an admin adder answers silent with no intro and no session; the link command with the code links and replies L1; `/orgs` lists the admin group and not as silent; a notice for a one-person club goes to the owner only.
- `e2e/api/organiser-pick.spec.ts`: drop, due-posts emits one admin-group post; admin-group reply "2" picks (A1 reply, A2 due, A3 due); a second reply "3" gets E3; "@Match Time put Wasim in" still works; fallback at `x-test-now` creates a `BenchSlotOffer`; DM mode with one-person reads only that person's replies.
- `e2e/web`: settings "Admin messages go to" persists, shows the code and the three steps, Unlink; match page reorder and Bring in.

No prompt changes. No live-LLM run needed: every reply path is code, and the engine change is pure capacity logic covered by the stubbed-extractor unit tests.

### 2.17 Rollout (server and Pi deploy in either order)

1. **Migration** (2a): existing clubs `each-admin`, no admin groups, no codes. Nothing changes for Sutton; the goldens and the each-admin key tests prove it.
2. **Server and Pi, either order:**

| State | What happens | Safe because |
|---|---|---|
| New server, old Pi | `/orgs` has `adminGroups`, the old Pi ignores it. The link command never reaches the server, so no group gets linked. No caps header, so no `admin-group-message` is emitted; group mode would fall back to the owner by DM. | Nothing can be linked yet, and a notice never targets a group the Pi cannot send to. |
| Old server, new Pi | No `adminGroups`, so the set is empty. A link command is forwarded to a route that does not exist yet (404), logged, no reply. The caps header is ignored. | The Pi sends nothing new and the group stays silent. |
| Both new | Linking works. | |
| Pi rolled back after linking | The old Pi drops admin-group messages and sends no caps header, so notices fall back to the owner by DM. Replies in the group are not read; the match page still works. | The router never depends on the Pi for delivery. |

3. **The one ordering rule, for people, not deploys:** nobody adds MatchTime to an admin group until the server with the `bot-added` candidate check is live, because with `ONBOARDING_AUTOSTART=1` that check is what stops the setup intro. Server deploys ride the merge to main (Vercel); the Pi goes out with `scripts/deploy-pi.sh`.
4. **Prove on MT Test:** a test HQ group with two admin phones. Check in the DB that the add created no `OnboardingSession` and an `awaitingAdminLink` row, link with the code, drive a drop with `x-test-now`, pick with "2", race with a second admin, pick with an @tag, and confirm no model call was logged for any admin-group message.
5. **2b migration** (default first-come), then Hamzah's club: set "Admin messages go to: Admin WhatsApp group", link the HQ group, turn on organiser pick.

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
| First tick after the deadline (08:00 to 21:59) | D2 summary; with organiser pick it IS the first pick round (reason `deadline-summary`) | the admin channel (2.2) | `<matchId>:deadline-summary` plus the channel suffix, or the round key |
| First tick after publish time, before kickoff | D3 the list | group | `<matchId>:list-published` |

All use the existing instruction and `SentNotification` mechanism, and the `isNextUpcomingForPosting` gate so next week's match never posts while this week's is live.

**D1. Drop-out reminder.**
- EN: "⏰ *{activity}*, {when}: the drop-out deadline is *today at {time}*. If you can't play, say *OUT* before then.\n\n{rosterBlock}"
- TR: "⏰ *{activity}*, {when}: son çıkış saati *bugün {time}*. Oynayamayacaksanız o saatten önce *YOKUM* yazın.\n\n{rosterBlock}"

**D2. Deadline summary** (admin channel; first-come clubs, or organiser clubs with nothing to pick):
- EN: "Drop-out deadline passed for *{activity}* ({when}). Squad {n}/{max}.\nOut this week: {names or 'nobody'}.\nSaid maybe: {names}.\nWaiting list: {names or 'empty'}.\n{k} places open." (the "Said maybe" and "places open" lines only when non-empty)
- TR: "*{activity}* ({when}) için son çıkış saati geçti. Kadro {n}/{max}.\nBu hafta çıkanlar: {names or 'kimse'}.\nBelki diyenler: {names}.\nYedek listesi: {names or 'boş'}.\n{k} yer boş."

"Said maybe" is unresolved `TentativeAvailability` rows for CONFIRMED players: the only place the rolling squad surfaces a "maybe", with no DM to the player and no model call.

**D3. List publish.**
- EN: "📋 *{activity}* list, *{dateLabel}*, {venue}\n\n*Playing ({n}/{max}):*\n1. ...\n\n*Waiting list ({k}):*\n1. ...\n\n{k} places still open. (only if any)\nCan't make it now? Say *OUT* as soon as you can so a replacement can be brought in."
- TR: "📋 *{activity}* listesi, *{dateLabel}*, {venue}\n\n*Oynayanlar ({n}/{max}):*\n1. ...\n\n*Yedek listesi ({k}):*\n1. ...\n\n{k} yer hâlâ boş.\nArtık gelemiyorsanız yerinize birinin alınabilmesi için hemen *YOKUM* yazın."

After publish, every change is announced by the post that makes it (bench claim, A2). The list is not re-posted.

### 3.3 Interaction with the existing scheduler posts

| Existing post | With weekly deadlines set |
|---|---|
| Announce (cold, or R1 rolling) | Unchanged timing. |
| 17:00 evening update | **Decided (D4): off on every day except match day.** The week's rhythm becomes announce, reminder, summary, list. On match day the line-up (2-pre) and the full-squad-no-teams nudge (2-pre-alt) still fire. |
| Recruit invites and chase-ups | Unchanged (gated on short squad and sociable hours). |
| Match-day morning chase, 3-4h chase, 2h last call | Unchanged, static text for rolling or organiser clubs (1.5). |
| Bench offers (first-come) | Unchanged, 08:00 to 21:59. |
| Pick rounds (organiser) | Do not open before the drop-out deadline; the deadline summary opens the first. Admins can still pick early on the match page. |
| Tentative follow-ups, reminders, gear reminder, score ask, payments, MoM, ratings | Unchanged. |
| Switch-format and cancel nudges | Unchanged. |

**Quiet hours.** Settings validation keeps D1 and D3 inside waking hours. D2 and pick messages use the 08:00 to 21:59 gate; a deadline at 21:30 whose tick slips past 22:00 waits until 08:00. Every post is claimed once by its key, so a Pi outage delays it rather than doubling it.

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

Unit: `weeklyDeadlinesFor` (Friday match, Monday and Tuesday; same weekday earlier time; refusal of later time; the October DST weekend); validation; D1 at deadline minus 3h but not before 09:00; D2 once per admin-channel target; D3 once, only for the next live match; 17:00 silent off match day and present on match day for a deadline club, byte-identical for Sutton; "Said maybe" lists only CONFIRMED players' open tentatives.
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

**`/admin/settings` only (D7)**, OWNER/ADMIN, `requireOrgAdmin`, two new sections under "Bot features".

**"Weekly routine"** (`setWeeklyRoutine` action):

1. Rolling squad: on/off
2. Who fills an open place: "First to say IN" / "The organisers pick"
3. If nobody picks in time: "Offer it to the waiting list" / "Leave it open" (shown only when 2 is "organisers")
4. Drop-out deadline: day + time
5. List published: day + time

**"Admin messages go to"** (slice 2a; `setAdminChannel`, `createAdminGroupLinkCode`, `unlinkAdminGroup`):

6. One of three:
   - "One person": a picker of the owner and admins who have a phone, default the owner.
   - "Admin WhatsApp group": shows **Link admin group**; pressing it shows the code, the three steps and the 48-hour validity (2.3), then "Linked: *{group subject}*" with **Unlink** once done. The choice takes effect only when a group is linked.
   - "Each admin by DM".

Each gets an ⓘ (`src/components/stats/info-button.tsx`, the F1 pattern in `MDs/findings.md`), EN and TR from `src/lib/i18n`. None is added to `FEATURE_META`, because that list also feeds the in-group setup menu.

**Not in the in-group setup (D7).** The setup is a short conversation; more questions make it longer and each needs parsing. A deterministic line at the end of setup is cheap and safe:
- EN: "Tip: to carry the squad over each week, to pick replacements from a waiting list yourself, or to get admin messages in your admins' group, open Settings on the website."
- TR: "İpucu: kadroyu her hafta devam ettirmek, yerine geçecekleri yedek listesinden kendiniz seçmek ya da yönetici mesajlarını yöneticilerin grubunda almak için sitedeki Ayarlar sayfasını açın."

For Hamzah, Kemal (or Hamzah on a call) sets them once.

### ⓘ texts

| Setting | EN | TR |
|---|---|---|
| Rolling squad | "When this is on, everyone who played the last match is automatically in for the next one, and only needs to say OUT if they can't make it. Players who were on the waiting list, guests without a phone number and anyone who has left the group are not carried over. The squad is carried over at 08:00 the morning after each match, so you have the night to remove anyone who didn't turn up. Anyone still on the list at the final whistle counts as having played, for payments and ratings." | "Bu açıkken, son maçta oynayan herkes bir sonraki maçta otomatik olarak kadroda olur; gelemeyecekse sadece YOKUM yazması yeterli. Yedek listesindekiler, telefon numarası olmayan misafirler ve gruptan ayrılanlar aktarılmaz. Kadro her maçtan sonraki sabah 08:00'de aktarılır, böylece gelmeyenleri o gece listeden çıkarabilirsiniz. Maç bittiğinde listede olan herkes ödeme ve puanlama için oynamış sayılır." |
| Who fills an open place | "First to say IN: when a place opens, MatchTime offers it to the waiting list and the first to say IN gets it. The organisers pick: MatchTime never fills a place by itself. Anyone who says IN goes on the waiting list, and your admin messages (see Admin messages go to) get the waiting list with positions and club ratings. The first admin to reply with a number, a name or a tag brings that player in." | "İlk VARIM diyen: bir yer açılınca MatchTime yeri yedek listesine sunar, ilk VARIM diyen alır. Organizatörler seçer: MatchTime hiçbir yeri kendisi doldurmaz. VARIM diyen herkes yedek listesine girer; yönetici mesajlarınız (bkz. Yönetici mesajları) yedek listesini, mevkileri ve kulüp puanlarını içerir. Numara, isim ya da etiketle ilk yanıt veren yöneticinin seçtiği oyuncu kadroya girer." |
| If nobody picks in time | "If no admin replies within a day, or 4 hours before kickoff at the latest, MatchTime either offers the place to the whole waiting list (first to say IN gets it) or leaves it open." | "Hiçbir yönetici bir gün içinde, en geç maçtan 4 saat önce yanıt vermezse, MatchTime yeri ya tüm yedek listesine sunar (ilk VARIM diyen alır) ya da boş bırakır." |
| Drop-out deadline | "The last time players can pull out without it counting as late. MatchTime reminds the group 3 hours before, then messages the admins with who is out and who is waiting. An OUT after the deadline still counts, and the admins are told it was late." | "Oyuncuların geç sayılmadan çıkabileceği son saat. MatchTime 3 saat önce gruba hatırlatır, sonra yöneticilere kimin çıktığını ve kimin beklediğini yazar. Son çıkış saatinden sonra YOKUM yine geçerlidir, yöneticilere geç olduğu bildirilir." |
| List published | "When MatchTime posts the final list in the group: who is playing and who is on the waiting list. With this and a drop-out deadline set, MatchTime stops the daily 17:00 post, except on match day." | "MatchTime'ın son listeyi gruba gönderdiği zaman: kim oynuyor, kim yedekte. Bu ve son çıkış saati ayarlıysa MatchTime, maç günü dışında her gün 17:00'de gönderdiği mesajı durdurur." |
| Admin messages go to | "Where MatchTime sends messages only admins should see: the waiting list to pick from, the drop-out summary, late drop-outs, who hasn't paid and new players to check. One person: a DM to the person you choose. Admin WhatsApp group: one message in your admins' group, and admins can reply there with a number, a name or a tag to pick a player. MatchTime reads nothing else in that group. Each admin by DM: every admin gets their own copy." | "MatchTime'ın yalnızca yöneticilerin görmesi gereken mesajları nereye gönderdiği: seçim için yedek listesi, son çıkış özeti, geç çıkanlar, ödemeyenler ve kontrol edilecek yeni oyuncular. Tek kişi: seçtiğiniz kişiye DM. Yönetici WhatsApp grubu: yöneticilerin grubuna tek mesaj; yöneticiler orada numara, isim ya da etiketle oyuncu seçebilir. MatchTime o grupta başka hiçbir şeyi okumaz. Her yöneticiye DM: her yönetici kendi kopyasını alır." |
| Link admin group | "Press the button, then add MatchTime to your admins' WhatsApp group and send the code shown here in that group. The code works once and lasts 48 hours. MatchTime will not start a club setup in that group." | "Düğmeye basın, sonra MatchTime'ı yöneticilerin WhatsApp grubuna ekleyip burada görünen kodu o gruba gönderin. Kod bir kez çalışır ve 48 saat geçerlidir. MatchTime o grupta kulüp kurulumu başlatmaz." |

Playwright covers both sections (EN and TR), each ⓘ opening, validation messages, and the link code flow.

---

## 6. Cross-cutting

- **Prompts:** none change in any slice. The router and extractors already read "waiting list" and "yedek" as bench; players are only ever told to say IN or OUT (VARIM, YOKUM), words the pipeline already handles. Every new message is composed by code from database facts.
- **Model calls:** slices 1 to 4 add zero. Slice 1 removes the composer calls for rolling clubs' 17:00 short-squad post and three chases. Admin-group messages never reach a model: the Pi forwards them to a route with no model path, and a test pins that. No live-LLM suite or dry run is needed for any slice (the CLAUDE.md approval rule does not apply: no prompt changes).
- **Copy:** every new string in EN and TR via `src/lib/i18n`, pinned by `copy-golden.test.ts`, no em or en dashes (`strings.test.ts`). Existing English bytes unchanged.
- **Sutton FC:** every setting defaults to today's behaviour; the migration puts every existing club on "each admin by DM" with today's keys; the first-come branch of `canTakeFreePlace` is today's arithmetic; goldens prove the bytes.
- **The Pi:** only slice 2a changes it (admin groups, the link command, the `admin-group-message` kind, the caps header). Either-order deploy, 2.17. Deploy with `scripts/deploy-pi.sh`.
- **Silence rails:** the HQ group is silent until linked; the link command is the only message that leaves the Pi from a silent group, and the server answers it only for a real admin. A linked admin group is never monitored as a club group, so it can never enrol members, post attendance or reach `analyze`.
- **AttendanceEvent:** two new causes, `rolling-squad` and `organiser-pick`, both written in the same transaction as their change.
- **Terminal short-circuits:** the new scheduler branches are separate blocks with their own keys and no `continue` or `return` above existing guards; the new dm-reply handler returns only when it handled the DM; the admin-group branch in the Pi's message handler returns only for admin groups and link-shaped messages.

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
| Carried player says maybe | Stays in; listed under "Said maybe" in the admin channel. |
| Late OUT | Recorded, 👋, admin-channel notice, not charged by MatchTime (D6). |
| OUT typed before the deadline, delivered after | On time (send time counts). |
| Organiser club, new player IN with places open | Waiting list 🪑; the admin channel gets a pick message. |
| Dropped player says IN again, place still free | Reclaims it. |
| Two admins reply at once | Lock and capacity: the first wins (A1), the other gets E3 "Already filled". |
| Admin replies with old numbers | P5, nothing applied. |
| Admin picks a player who left the bench | Skipped with the reason; others applied. |
| Admin picks a club member not on the waiting list | E1, then YES brings them in. |
| Admin picks someone already in | E2. |
| Admin tags someone MatchTime cannot identify | E4, "can you type their name?". |
| Admin is also on the waiting list | Can pick himself. |
| Pick after teams exist | Seated in the slot actually vacant; the group post names that slot's holder and team. |
| Picked player later says OUT | Ordinary drop; the place reopens and a new pick message goes to the admin channel. |
| Chat, tags or names in the admin group with no pick open | Ignored, no reply, no model call. |
| A non-admin member of the HQ group replies with a number | Ignored. |
| One-person target demoted, left or without a phone | Falls back to the owner, then to each admin; health note. |
| No admin has a phone, and no admin group | No pick messages; fallback runs at `fallbackAt`; health note on `/admin/health`. |
| Drop 3 hours before kickoff | Round opens, fallback 1 hour later. |
| Drop at 23:00 | Round waits for 08:00. |
| An admin adds MatchTime to the HQ group (`ONBOARDING_AUTOSTART=1`) | No setup intro, no session; silent until the code (2.4). |
| HQ group added, code never sent | Self-join on: MatchTime leaves after 48 hours. Self-join off: stays silent. |
| Code sent by someone who is not an admin, or a wrong code | Silent; an admin with a wrong or expired code gets L2. |
| Code sent in the club's own community group | L3, not linked. |
| MatchTime removed from the admin group | Link cleared, channel back to the owner by DM, L4 to the owner. |
| Pi rolled back after linking | Notices fall back to the owner by DM; picks on the match page still work. |
| Admin channel switched mid-week | Notices still due are sent once on the new channel. |
| Bot muted | Seeding still happens; nothing is posted or DMed until unmuted. |
| Club dormant or not approved | No seeding, no posts. |

---

## 8. Decisions (all taken, 2026-09-30)

Kemal accepted D1 to D10 as recommended and decided D11 to D13 himself.

| # | Question | Decided |
|---|---|---|
| D1 | After a cancelled week, who is carried over? | The last PLAYED match within 21 days. Longer gap: no carry-over, admin can press "Carry over". |
| D2 | Do last week's bench players carry onto the waiting list? | No. "Rolling" means "played". They say IN again. |
| D3 | When is the squad carried over? | 08:00 the morning after the match, so admins can remove no-shows first. |
| D4 | With weekly deadlines set, does the daily 17:00 post stop? | Yes, except on match day. The reminder, summary and list replace it. |
| D5 | No admin picks in time: offer to the waiting list, or leave empty? | Offer to the waiting list (first to say IN), after a day or at kickoff minus 4h, whichever is first. Club can switch to "leave empty". |
| D6 | Should a late drop-out still owe the fee? | Not in these slices (MatchTime charges only who played). A setting later if Hamzah wants it. |
| D7 | Settings page only, or also the in-group setup? | Settings page only, plus a one-line tip at the end of setup. |
| D8 | Club-level or fixture-level deadlines? | Club-level (one group per club; a format switch must not move the deadline). |
| D9 | When several players are picked, can admins choose which vacated slot each fills (e.g. the GK for the GK)? | No. Sheet order, as the bench claim does today; admins swap on the teams page. |
| D10 | Shipping order | 4 first (tiny), then 1, 2 (2a then 2b), 3. |
| D11 | Where do admin notifications go? | A per-club setting: one person by DM (a chosen admin; new clubs default to the owner), an admin WhatsApp group, or each admin by DM (the original design, and what existing clubs keep). |
| D12 | How is the admin group linked, and how is it kept out of the setup? | Once, with a code from the settings page, sent as "@Match Time admin group CODE"; reply "✅ Linked as the admin group for <club>." An add by an admin of an existing club waits silently for the code instead of starting setup. |
| D13 | What does MatchTime read in the admin group, and how is a pick confirmed? | Only numbers, names, @tags, ALL, NONE and YES while a pick is open; everything else is ignored and never sent to a model. Replies are confirmed in the same group; the community group and the picked player are told as in 2.9; the edge cases in 2.10. |
