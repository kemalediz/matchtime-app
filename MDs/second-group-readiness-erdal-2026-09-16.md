# Second group readiness: Erdal's Turkish group, Friday 2026-09-18

Written 2026-09-16, read-only. No message was sent, no BotJob created, no
production write, no Pi restart. Live LLM measurements were made with
`scripts/dryrun-pipeline.ts` (zero-write harness, `REPEAT=10`) against the
live Sutton FC state; the Turkish cases were added to the harness for the
run and removed again.

## The prospect, in one paragraph

Erdal (already on the Sutton FC roster) runs a large Turkish-speaking group
that manages TWO matches from one WhatsApp group. The owner told him to add
MatchTime's number and it will ask who the admin is and when they play, and
set itself up. This document checks three things that promise depends on.

## Verdict

| Item | Friday | Why |
|---|---|---|
| 1. Self-onboarding by adding the number | NO-GO | The flag is ON in Vercel prod (has been for 93 days), but the flow has never run once in production, every word of it is English, and the Pi never flushes an un-tagged reply from a group that was not a live org at startup, so the "YES" answer never reaches the server. On the current whatsapp-web.js build the roster snapshot and group name also come back empty. |
| 2. Turkish attendance | NO-GO as-is | Full sentences read 10 of 10. The bare forms "var", "yok", "yokum" are lost 30 of 30 at the router, silently. Hedges never register a firm IN (0 of 32) but also never become a tentative. All outbound copy is English. |
| 3. Two matches from one group | NO-GO as-is | Every attendance write lands on the soonest open match, org-wide, whatever day the player names. Scheduled posts, rating DMs and pay links do work per match. |

The realistic path for Friday is manual provisioning by script plus one Pi
restart, with a single Friday fixture only, and with the caveats in section
2 accepted by Erdal in advance. Details and exact steps are under each item.

---

## 1. Self-onboarding: what is actually switched on

### Facts established

| Question | Answer | Evidence |
|---|---|---|
| Flag value in Vercel production | `ONBOARDING_AUTOSTART=1` (plain Config var, value readable), created 93 days ago, Production only | `npx vercel env ls production` |
| Where the flag is read | Only `src/app/api/whatsapp/bot-added/route.ts` via `isOnboardingAutostartEnabled()` in `src/lib/onboarding-parse.ts`. The Pi reads nothing; the server is authoritative. | grep |
| Has it ever fired in prod? | No. `OnboardingSession` has 0 rows. | read-only DB query |
| Local `.env` on the Pi | no `ONBOARDING_*` key, not needed | ssh, read-only |

### What happens today when the bot is added to an unknown group (flag ON, which is the live state)

1. whatsapp-web.js 1.34.7 emits `group_join` from the inbound message
   listener (`Client.js:602`, subtype add or invite). The Pi checks whether
   its own JID is in `recipientIds` and the group is not monitored
   (`whatsapp-bot/src/index.ts` ~882).
2. It calls `client.getChatById(groupId)` for the subject, then
   `collectGroupParticipants` (also `getChatById`) and `collectGroupHistory`.
   On the live WhatsApp Web build `getChatById` throws (`r`), which is what
   PR #84 worked around for the restart catch-up. All three calls are inside
   try/catch, so the flow continues with **no group name, no participant
   snapshot and no history**.
3. `POST /api/whatsapp/bot-added`. With the flag on and no live org for the
   group, the server creates an `OnboardingSession` at stage `introduced` and
   returns `BOT_ADDED_INTRO`.
4. The Pi posts the intro (an ~11 line English feature pitch ending in
   "reply YES / EVERYTHING / or name the bits you want") and adds the group
   to its in-memory monitored set.
5. Every later message from the group is buffered by `enqueueForAnalysis`.
   The 10-minute flush timer only iterates the group list captured at
   `ready` from `getEnabledOrgs` (bot-enabled orgs only; onboarding groups
   are monitored but are NOT in the flush list, see `index.ts` 187-205 and
   `smart-analysis.ts` 848-866). The only immediate flush is an explicit
   @-mention of the bot or kickoff urgency (no kickoff is known for a group
   with no match). So a plain "YES" sits in the buffer and never reaches
   `/api/whatsapp/analyze`. The session stays at `introduced` and the bot
   goes silent, which the intro itself promises ("Not for you? Just ignore
   me"). A restart does not fix it: after restart the group is again
   monitored but again not in the flush list, and the buffer is gone.
6. If the replier does @-mention the bot on every answer, the flow works as
   the e2e suite (`e2e/api/onboarding.spec.ts`) tests it: YES -> admins
   question -> "when and where do you play?" -> one Activity, one first
   match, roster import from the participant snapshot (empty on this build),
   magic-link DMs to the admins.

With the flag OFF, step 3 returns `ignored: "autostart-disabled"` and the Pi
logs `[bot-added] server says stay silent`; nothing is posted and the group
is not monitored. The `@MatchTime setup` Phase 2 trigger in the analyze
route is NOT behind the flag; typing it in an unmonitored group starts a
`collecting` session regardless (the Pi pre-filter requires the @-mention
plus "setup").

### Language

Everything the flow says and reads is English. `parseBundleReply` accepts
only `yes / yes please / yeah / yep / go for it / let's do it ...`
("evet" does not match), the admin question and details question are
English, day parsing is English day names with an English-example LLM
backfill. The intro alone is 1,300 characters of English marketing copy.

### Isolation from Sutton FC and HomeTenant

- Sutton FC: the server short-circuits any group that already has a
  bot-enabled org (`ignored: "live-org"`), and the Pi skips monitored groups
  before calling the server. A kick-and-re-add of Sutton cannot restart
  onboarding.
- HomeTenant: separate process, separate session directory
  (`.wwebjs_auth/session-hometenant` vs `session`), separate WhatsApp
  number. MatchTime's self-add detection compares against MatchTime's own
  JID inside MatchTime's process only. HomeTenant's groups cannot trigger
  it. (`scripts/deploy-pi.sh` never touches HomeTenant, confirmed again in
  today's outage notes.)

### Standing caution

The Phase 1 handoff and memory both say this flow must be proven on a
throwaway test group before any real group. It has not been: 0 sessions in
prod, the sim harness exercises the server route only, and the Pi half
(step 5 above) is where it currently breaks.

### Minimal work to GO on self-onboarding (not for Friday)

1. Pi: include onboarding groups in the flush timer list (or refresh the
   list from `getEnabledOrgs` periodically, which also fixes the manual
   route below). Small change, needs a Pi deploy.
2. Pi: build the participant snapshot and group subject without
   `getChatById` (same technique as PR #84), or accept an empty roster and
   "Match" as the activity name.
3. Prove it on a throwaway group with three phones, including a restart in
   the middle.
4. Only then think about a Turkish intro. That is a per-org language
   setting for OUTBOUND copy, which does not exist today.

### If Friday must happen anyway: the manual route

This is how Sutton FC was set up (`scripts/enable-sutton.ts`); the
dashboard has no action that sets `whatsappGroupId`.

1. Before Erdal adds the number: set `ONBOARDING_AUTOSTART=0` in Vercel
   production and redeploy, otherwise the English intro posts into his
   group the moment the bot is added and a dead session is created.
2. Erdal adds the number. Read the group JID from
   `~/matchtime-bot/bot.log`: the line `[bot-added] self-add detected in
   <id>@g.us` is logged before the server is consulted. If `group_join`
   does not fire on this build (unverified), there is no silent way to get
   the JID: the `@MatchTime setup` trigger logs it but also starts a
   session and posts English into the group, and that session would then
   shadow the real org in `handleOnboardingIfApplicable` (it checks for an
   active session before the live org). Test `group_join` on a throwaway
   group first.
3. Script (modelled on `enable-sutton.ts`): create the Organisation with
   `whatsappGroupId`, `whatsappBotEnabled: true`, OWNER membership for
   Erdal's user, one Activity (Friday, time, venue, playersPerSide), then
   `generateMatchesForActivity`. Features: attendance and reminders on;
   ratings and MoM on only if he wants English DMs going to his players.
4. Restart the Pi bot with `scripts/deploy-pi.sh` (never bare
   `systemctl restart`). The org list, scheduler and flush list are all
   captured at `ready`, so nothing works for the new org until then.
   Today's four restarts on 1.34.7 kept the session (QR-linked, survives
   restart), but the 06:57 outage shows a restart can still cost a
   session; do it at a quiet hour, not at 17:00.
5. Roster: no import will happen. Players are provisioned on their first
   message; the "lurker gap" backfill at startup also uses `getChatById`
   and will log a degraded capability rather than import.

---

## 2. Turkish attendance: does the pipeline read it?

Method: `ONLY=TR1..TR20 REPEAT=10 FACTS=1`, live router (Haiku) and
attendance extractor (Sonnet), against the live Sutton state (22 Sep
match, 6 confirmed, bench feature on). History was two lines: MatchTime's
English squad-update post and a Turkish owner chase ("hadi beyler, salı
için birkaç kişi daha lazım"). For "ben de" a third line was added,
"Ilkay: ben varım". IN cases were sent as Erdal (not in the squad); OUT
cases as Wasim, force-confirmed in memory so a drop had a target.

| id | Phrase | Meaning | Route (of 10) | Extracted claim (of 10) | Engine write (of 10) | Verdict |
|---|---|---|---|---|---|---|
| TR1 | varım | I'm in | self_att 10 | in, decision 10 | CONFIRMED 10 | reads |
| TR2 | ben varım | I'm in | self_att 10 | in, decision 10 | CONFIRMED 10 | reads |
| TR5 | geliyorum | I'm coming | self_att 10 | in, decision 10 | CONFIRMED 10 | reads |
| TR8 | sayın beni | count me | self_att 10 | in, decision 10 | CONFIRMED 10 | reads |
| TR10 | kaleye geçerim | I'll go in goal | self_att 10 | in, decision 10 (conf 0.70 to 0.75, just above the 0.7 floor) | CONFIRMED 10 | reads, but on the edge |
| TR11 | abi ben varım | bro I'm in | self_att 16 of 16 | in, decision 16 | CONFIRMED 16 | reads (16 runs, two logs) |
| TR7 | ben de | me too (after "Ilkay: ben varım") | self_att 10 | in, decision 10 | CONFIRMED 10 | reads in context |
| TR4 | gelemiyorum | I can't come | self_att 10 | out, decision 10 | DROPPED 10 | reads |
| TR9 | bu hafta yokum | not this week | self_att 10 | out, decision 10 | DROPPED 10 | reads |
| TR20 | ben yokum | I'm out | self_att 10 | out, decision 10 | DROPPED 10 | reads |
| TR3 | yokum | I'm out (bare) | none 10 | no extractor call | nothing 10 | **LOST: the router calls it banter every time** |
| TR13 | yok | out (bare) | none 10 | no extractor call | nothing 10 | **LOST: banter every time** |
| TR12 | var | in (bare) | self_att 6, none 3, unsure 1 | empty claims 7, none 3 | nothing 10 | **LOST: never registers** |
| TR6 | +1 | one guest | self_att 10 | empty claims 7, sender IN 3 | nothing 8, CONFIRMED sender 2 | wrong twice: the SENDER was registered, no guest ask. Not Turkish-specific, same as English "+1" |
| TR14 | belki | maybe | unsure 10 | empty claims 10 | nothing 10 | safe: no firm IN. But no tentative row and no 24h follow-up DM either |
| TR15 | bakarız | we'll see | none 10 | no extractor call | nothing 10 | safe as banter, invisible as a maybe |
| TR16 | kesin değil | not certain | unsure 10, offer 2 (12 runs) | empty claims 12 | nothing 12 | safe: no firm IN |
| TR19 | cuma varım | in for Friday | self_att 10 | in, decision 8 but conf 0.55 to 0.6 in 6; availability 1; empty 1 | nothing 8 (below the 0.7 floor), CONFIRMED 2 | when it does write it writes the SOONEST match (Tuesday), see section 3 |
| TR17 | in | English control | self_att 10 | in, decision 10 | CONFIRMED 10 | baseline |
| TR18 | out | English control | self_att 10 | out, decision 10 | DROPPED 10 | baseline |

Every run was silent in the group (an IN or OUT gets a react, not a reply,
since PR #78), so a lost message is lost without any signal, exactly the
router risk `router.ts` documents.

### Reading the table

- The full-sentence INs and OUTs are read 10 of 10, including the two
  idioms ("sayın beni", "kaleye geçerim") and "ben de" in context. The
  Sonnet extractor reads Turkish without being told to.
- The failures are all at the ROUTER (Haiku), on the shortest forms, and
  they fail closed to `none`: "yokum" 0 of 10, "yok" 0 of 10, "var" 0 of
  10. These are the Turkish equivalents of "in" and "out", the single most
  common attendance messages a group sends. The English floor regex
  (`FLOOR_IN` / `FLOOR_OUT`) catches "in" and "out" before the model; there
  is no Turkish floor.
- The hedges are safe in the sense the task asked for: 0 firm INs across
  32 runs of "belki", "bakarız", "kesin değil". They are also useless: no
  tentative row is written, so the 24h follow-up DM never fires for them.
- "cuma varım" is read as an IN 8 of 10 but with confidence 0.55 to 0.6,
  under the engine's 0.7 floor, so it usually writes nothing. The two
  writes went to the Tuesday match. Naming a day the extractor cannot
  place in the state costs confidence, not accuracy.
- Turkish does NOT work as-is. It is not "mostly works": the bare forms
  that dominate real traffic are lost 30 of 30.

### The narrowest fix

Narrowest, in order of cost:

1. **A language line in both prompts** (router and attendance extractor):
   "Messages may be in Turkish or English; classify on meaning. Bare
   Turkish tokens are attendance: var / varım / ben de = in, yok / yokum /
   gelemiyorum = out, belki / bakarız / kesin değil = tentative." Plus five
   Turkish worked examples in the router's example block, since the block
   is what the Haiku router copies from. This is a prompt edit, measured
   the same way (`REPEAT=15` on the table above), no schema change.
2. **A Turkish floor** beside `FLOOR_IN` / `FLOOR_OUT` in `router.ts`
   (`^(ben\s+)?varım$`, `^var$`, `^(ben\s+)?yokum$`, `^yok$`), which takes
   the three lost forms off the model entirely. Ten lines, deterministic,
   unit-testable, and the cheapest guarantee for the highest-volume
   messages.
3. **A per-org language setting** is NOT needed for reading; the models
   are multilingual and the router prompt is shared. It IS needed for what
   the bot says, which is a much bigger job (every composer, chase and
   scheduler string is English). Do not conflate the two.

Recommendation: 1 and 2 together, in one PR, measured before merge. Not
done in this task.

---

## 3. Two matches from one group: what the product actually does

### The mechanics

- One org can hold several Activities (Sutton has `Tuesday 7-a-side`
  active and `Tuesday 5-a-side` inactive; Sutton Lads had a Thursday one).
  Each Activity gets its own weekly Match from `/api/cron/generate-matches`
  (`where: { isActive: true }`), so a Tuesday and a Friday Activity produce
  two open matches at once.
- **Where a write lands** is decided by `selectRegistrationMatch`
  (`src/lib/registration-match-select.ts`), called from
  `src/lib/pipeline/load-state.ts` for the group path and from
  `src/lib/dm-registration-target.ts` for the DM path: the soonest active
  match dated today or later, org-wide, ignoring fullness, and `null`
  (blocked) while any active match dated before today exists. The
  pipeline loads exactly ONE match into `SquadState`; the extractor has no
  field for "which match" and its prompt says "Naming a day settles
  nothing either way". The engine therefore cannot target a second match.
- **Scheduled posts** (`bot-scheduler.ts`) run per match and are gated by
  `isNextUpcomingForPosting`, whose suppression is scoped to the SAME
  fixture (orgId, venue, dayOfWeek). A Tuesday match does not suppress a
  Friday one (unit test: "an earlier Tuesday does NOT suppress a later
  Thursday"). So both fixtures announce and both post the 17:00 update.
- **Rating DMs, rate-promo, payment poll, fee-ask, pay-chase** are all
  keyed `${matchId}:...` in `SentNotification` and computed per match, so
  they work per match. `buildUnpaidTail` looks at the last completed match
  of the activity in question.
- A match is auto-completed by `/api/cron/complete-matches` (every 15 min)
  once `now >= kickoff + duration`.

### The scenarios, concretely

| Scenario (Tuesday and Friday both open) | What happens |
|---|---|
| Bare "in" / "varım" on Saturday to Tuesday | Registers on TUESDAY, whoever meant Friday. If Tuesday is full it goes to Tuesday's bench (fullness is ignored by design after the 2026-06-18 incident). |
| "in for Friday" / "cuma varım" on Sunday | Same: registers on Tuesday when it registers at all (TR19: 2 of 10 wrote, both to Tuesday; 8 of 10 fell under the confidence floor and wrote nothing). Silent either way: an IN gets a react and no reply since PR #78. |
| "in" on Tuesday between kickoff and completion (~20 min after the final whistle at worst) | Blocked: no active match, nothing written, nothing said. |
| "in" from Wednesday to Friday | Registers on Friday. Correct by accident. |
| "out" from a player on both squads | Drops from the soonest match only. |
| 17:00 update | Two posts every evening, one per fixture, each with its own "we need N more" line. Both `announce-match` posts also fire in the 09:00-13:00 window when each squad is empty and more than 24h out. |
| Rating DMs after each match | Work per match; two rating windows a week, two sets of DMs, two MoM polls. |
| Pay links / payment poll | Per match, work. |
| Team generation, MoM | Per match, work. |
| Questions ("who's in?", "what time is kickoff?") | Answer about the soonest match only. |
| Onboarding (either flow) | Creates ONE Activity. The second must be added in the dashboard (`createActivity` + `generateMatchesForActivity`). |

### Bottom line

"Supported" only in the sense that nothing crashes and the post-match
machinery is per match. The registration side is single-match by
construction, so from roughly Saturday to Tuesday every Friday IN lands on
Tuesday's list, and the player is told nothing. With a large group this is
"will register everyone for the wrong game", not an edge case.

If both fixtures are on the SAME day (two pitches, one evening), the
co-timed tie-break in `isNextUpcomingForPosting` suppresses the second
match's posts entirely (lower id wins), and registration still goes to
whichever sorts first. Worse, not better.

### Minimal work to GO on two fixtures

1. Extractor: add a `matchRef` field (day name or "this one") to the
   attendance claim; router untouched.
2. `load-state.ts`: load all active matches in the current cycle, not one;
   engine resolves `matchRef` against them, defaulting to the soonest.
3. `selectRegistrationMatch` keeps its "blocked while an earlier match is
   in flight" rule per fixture, not org-wide.
4. Evening update: one combined post listing both squads, or keep two
   posts but name the day in the first line.
5. Live-LLM dry run of "in", "in for Friday", "out of Tuesday, in Friday"
   over both matches, `REPEAT=15`.

For Friday: give Erdal ONE Activity and say so. The second fixture stays
off MatchTime until the above is built.

---

## Not in scope, but load-bearing for the decision

- Everything the bot SAYS is English: intro, 17:00 update, announce,
  rating DMs, pay chases, help replies, the guest-name ask. There is no
  per-org language on `Organisation`. A Turkish group will get English
  posts from day one, whatever the inbound reading does.
- The WhatsApp layer is on `whatsapp-web.js@1.34.7` as of this afternoon
  (bot ready 16:27, monitoring 1 group), the third outage from a WhatsApp
  frontend change was this morning, and `getChatById` still throws on the
  live build. Adding a second real group doubles the blast radius of the
  next one.
