# Session handoff, 2026-06-27 to 2026-07-14

Covers a run of production bug fixes (mostly one bug family), two behaviour
changes, a Pi outage, and the venue commercialisation strategy work.

---

## 1. THE BIG THEME: `activityId`-keyed logic breaks under a format switch

`switchMatchFormat` (`src/app/actions/matches.ts`) re-points a Match's
`activityId` to the other-format Activity (Tuesday 7-a-side to Tuesday
5-a-side) and leaves the old Activity `isActive: true`. **Three separate
production bugs** all traced to code that keyed on `activityId` and did not
survive that re-pointing.

**Standing rule: any logic keyed on `activityId` is suspect. Ask "what happens
after a format switch?" Prefer the recurring-fixture key.**

The two activities of one fixture also carry **different configured kickoff
times** in prod (`tuesday-7aside` = "21:30", `tuesday-5aside` = "21:15"). Do
not assume they match. This detail broke fix #2 below.

### Bug 1: ghost matches (PR #1, `6900408`)
The weekly generator (`api/cron/generate-matches`) deduped by `activityId`.
After a switch, the still-active 7-a-side Activity had no match in the window,
so the cron manufactured an empty ghost 7-a-side match. The bot then chased
"0/14" for the ghost. Fixed by deduping on the recurring slot, plus a co-timed
lower-id tie-break in `next-upcoming-match.ts`.

### Bug 2: exact-time slot key was wrong (PR #2, `1298a81`)
Fix #1 keyed the slot on `(orgId, venue, dayOfWeek, time)` with **exact time
equality**. Because the two formats have different times (21:30 vs 21:15), it
saw two different slots and the ghost came back **after the fix deployed**.
Now dedupes on `(orgId, venue, dayOfWeek)` plus **match instant proximity
(±90 min)**, comparing the real `Match.date` against the computed `matchDate`.
The instant is the source of truth; it is immune to activity-time config drift.
See `src/lib/match-slot.ts`, `SLOT_TIME_TOLERANCE_MS`.

### Bug 3: next week's match announced early (PR #7, `c65559b`)
The scheduler's rollover guard (`isNextUpcomingForPosting`) suppressed next
week's match only when an earlier live match shared the **same `activityId`**.
After switching this week's match to 5-a-side, next week's 7-a-side match saw
no earlier match on its activity, so the bot announced it ("Say IN to join")
while this week's game was still live. Fixed by keying the guard on
`isSameRecurringFixture(orgId, venue, dayOfWeek)`, now shared with
`match-slot.ts`. Deliberately excludes `time`, and has **no** instant proximity
(this guard compares matches a week apart). Multi-activity orgs preserved: a
different dayOfWeek or venue still announces independently.

**Side-effect to remember:** a premature announce **consumes the
`<matchId>:announce-match` SentNotification key**, so the match would never
announce again. Delete that key after fixing, but only **after** the fix is
deployed, otherwise it simply re-announces.

---

## 2. `@lid` tag detection was broken (PR #3, `b86c420`)

**Symptom:** a properly tagged `@Match Time Kieran and Rashad are IN` was
dropped as "untagged, suppressed". The bot could not recognise its own
@-mention, so **every tagged admin command was being silently swallowed**.

**Cause:** WhatsApp now encodes @-mentions as opaque `<digits>@lid` JIDs, but
`client.info.wid` is the phone-based `<digits>@c.us` form. The old
`mentionedIds.includes(selfId)` compared two different identity strings for the
same account, so `botMentioned` was always `false`. The server gate trusted that
`false` absolutely and never fell back to text matching.

**Fix:** the Pi computes `botMentioned` via the resolved `Contact.isMe` plus
every bot identity form (`isSelfMention` in `whatsapp-bot/src/smart-analysis.ts`),
and the server's `messageTagsBot` now falls back to a text tag whenever
`botMentioned !== true` (not only when `undefined`).

Same `@lid` family as the earlier DM breakage. See `project_whatsapp_lid_dms`.

---

## 3. Auto-register untagged third-party IN-adds (PR #4, `bd3305d`)

Kemal chose "auto-register, confidence-gated" over a confirm-prompt.

- **Tag-free now:** a `registerFor` whose entries are **all `IN`** ("Add Rashad
  please", "his name is Kieran", "Ayoub snatched that spot").
- **Still tag-gated:** questions, team ops, and any `registerFor` that DROPS,
  BENCHES or SWAPS OUT another player. Removing someone from banter is the
  dangerous direction.
- **Relay guard** (`analyze/route.ts`): the in-intent safety net no longer
  force-joins the SENDER when the verdict is a third-party add. Critical now
  that IN-adds are tag-free: a casual "add X" must never silently register the
  non-playing relayer on a paid match.
- **Live-LLM validated 5/5** on all 9 real transcript cases, including the hard
  "Ayoub snatched that spot" borderline. `e2e/sim/auto-register-adds-live.spec.ts`,
  run with `npm run test:sim:live:adds`.

---

## 4. App self-IN requires WhatsApp group membership (PR #6, `301560d`)

**Why:** a guest (Rashad) was confirmed for a match and no-showed. He has no
phone and `lastSeenInGroupAt = NULL`, so he was never a real group member.
Guests added **from inside the group** are fine by design. The loophole was
someone marking **themselves** IN from matchtime.ai without being in the group.

**Gate** (`src/lib/group-membership-gate.ts`, `canSelfMarkIn`), applied only in
the `attendMatch` server action:
- deny if membership is null,
- deny if `leftAt != null` (overrides the admin exemption),
- allow if role is `OWNER` or `ADMIN`,
- otherwise allow only if `lastSeenInGroupAt != null`.

Untouched: `registerAttendance` (shared by the bot path, guest-adds, admin),
`dropFromMatch` (players may always drop out), and admin add-player.
The error surfaces as a toast via the existing handler in `attend-button.tsx`.

At the time: 64 of 72 active Sutton memberships would pass, 8 blocked (5 with no
phone, i.e. guest names).

---

## 5. MoM announcement: drink offer removed (PR #5, `257614b`)

"Your trophy & drink awaits next match." is now "Your trophy awaits next match."
Text extracted into a pure `buildMomAnnouncement` (`src/lib/mom-announcement.ts`)
so the copy is unit-testable.

---

## 6. Pi outage, 2026-07-07, and a real recovery limitation

The Pi dropped off the network for about 3 hours (host offline, not a bot crash).
The bot auto-recovered on boot and reconnected without a QR (session persisted).

**Limitation worth fixing:** `recoverGroupMessages` re-feeds only the **last 2
hours** and, right after a restart, `fetchMessages` often cannot load history and
**falls back to just the last cached message**. Widening the window did not help
for that reason. So a long outage is **not reliably recoverable**, and messages
sent during it can be lost.

**Suggested fix (not built):** recover since **last-seen** rather than a fixed 2h,
with a more robust history fetch, so outages self-heal.

Also note: a single Pi with no failover means the bot goes fully dark when it
drops. Worth a watchdog or a move off a home Pi.

---

## 7. Commercialisation strategy and the WhatsApp platform question

Full strategy: `MDs/venue-commercialisation-strategy-2026-07-14.md`.

**Headline research find:** Goals launched **its own organiser app in 2014**
(drop-out replacement, digital match fees) and the board said publicly it would
cut cancelled matches. It is dead. So Goals does not need convincing the problem
is real. They need convincing the **adoption** problem is solved, which is exactly
the WhatsApp-native wedge.

**Recommended model:** free to clubs forever, venue pays flat per-site retention
SaaS (about £249 per site per month, a guess anchored on "one retained block pays
for the year"). Reject the player-marketplace idea for now. Run a free 90-day
pilot at Goals North Cheam, exploiting the fact that **Sutton FC already plays
there and runs entirely on MatchTime with real Stripe money**.

### CRITICAL: the official WhatsApp Business API cannot host MatchTime

Meta shipped a Groups API (June 2026), but:
- **Max 8 participants** per group (a squad is 10 to 14; the Sutton group is 72).
- A business can only **create** groups. It **cannot join an existing group**.
- No reactions, polls, interactive buttons or @mentions in groups.

So migrating is not "losing some features", it is **losing the product**. The
strategy doc's line about migrating before an estate contract is **not
satisfiable**. Watch the Groups API for a "join an existing group" capability;
that single change would make an estate deal clean.

**Legal position:** using an unofficial client is a **breach of Meta's terms**,
not a crime. The bot is a real account invited into the group by its own admin,
so it is not unauthorised access. The practical blocker is **procurement and
brand risk** at a PE-owned buyer, not law. The real legal exposure is **GDPR**,
which is solvable with a DPA and aggregate-only venue reporting.

**The sharp problem:** the per-group burner-number mitigation is fine at current
scale but does **not** scale to 44 sites and thousands of groups, where it starts
to look like systematic evasion. **The terms problem gets worse exactly as the
venue strategy succeeds.** This is another argument for direct-to-club as the
engine.

Structure any venue deal so the venue is a **referrer, not an operator**: the
club adds the bot to its own group, the venue never touches the account or player
data and receives aggregate anonymised stats only.

---

## Open items

1. **Recovery window fix** (section 6) — recover since last-seen, robust history
   fetch. Not built.
2. **Flip `ONBOARDING_AUTOSTART`** — self-onboarding is built but off. It is the
   highest-leverage prerequisite for any venue-led distribution.
3. **Venue monthly report** (PDF or email per site) — the pilot proof artefact.
   Days of work over data already stored.
4. **Draft a one-page DPA** before any venue conversation gets serious.
5. **Verify the 2014 Goals app source** before quoting it in a meeting. It is the
   linchpin of the pitch.
6. Sutton FC's permission is needed before their name appears in any material.
