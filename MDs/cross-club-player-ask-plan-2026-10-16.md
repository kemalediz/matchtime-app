# Asking a partner club for a player (cross-club player ask)

Plan, 2026-10-16. Planning only: no code, no PR, nothing touched in production.

**The ask (Kemal):** FNF (Friday 9-a-side, organisers pick who plays) had an open place on
match day. The organisers asked MatchTime to find a player: first FNF's own members, and if
nobody, another club MatchTime runs (Sutton FC, owned by Kemal). Today nothing in MatchTime
posts one club's need into another club's group, or registers another club's player for a
game.

**In one paragraph:** two clubs agree, once, that one may ask the other for players. When the
asking club still has a place open (at a set time, or when its organisers ask), MatchTime asks
the partner club's organisers to approve, then posts one short ask in the partner's players'
group. A partner player answers by **replying to that post**, so their IN can never be mistaken
for an IN to their own club's game. They join the asking club's waiting list as a **guest for
that one match**, the asking club's organisers pick as they do today, the guest gets a DM, plays,
pays the asking club's fee, is rated by the asking club only, and stops being a guest the morning
after. Nothing changes for any club that has not switched it on.

---

## 0. Open decisions for Kemal

Each has a recommendation. Nothing in slice 1 or later should start until D1 to D6 are settled;
D7 onward can be settled per slice.

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Who creates a pairing?** Only the platform owner (you), or club organisers by exchanging a code? | **You only, in v1**, from the owner's clubs page. Both clubs' owners then accept on their settings page. No discovery, no club can spam another. A code handshake can come later. |
| D2 | **One way or both ways?** Is "FNF may ask Sutton" the same agreement as "Sutton may ask FNF"? | **One way, each direction its own row.** Sutton may be happy to lend players to FNF without wanting FNF asked. A reciprocal pair is just two rows. |
| D3 | **Partner approval: every ask, or standing permission?** | **Both offered, default "ask us each time".** The partner's organisers approve each ask (YES in their admin group, or a link in the DM). A partner can switch to "post without asking", and is then told after each post. |
| D4 | **When is the partner asked?** | **On the asking organisers' request by default**, plus an optional automatic time ("if a place is still open at 16:00 on match day"). Never before the club's own members have had a chance: the automatic ask only fires when the club's own waiting list is empty. |
| D5 | **How does a partner player say yes?** | **By replying (quoting) to MatchTime's ask post** with IN, or by DM after tapping the reply. A plain unquoted IN in the partner group keeps its meaning today: the player's own club's game. Optional extra (D5b): when an unquoted IN arrives within 60 minutes of the ask from someone with **no** row on their own club's game, MatchTime asks one short question ("For FNF on Friday? Reply to my FNF message"). **Recommend D5b yes**, it is a code decision on state, no model change. |
| D6 | **Who picks among volunteers in the asking club?** | **Whatever the club does today.** An organiser-pick club (FNF) sees volunteers on its waiting list labelled "(Sutton FC)" and picks by number. A first-come club confirms the first volunteer. In the organiser-pick fallback (D5 of the Friday plan, "offer to the waiting list"), **a guest volunteer counts as having already said yes**, earliest volunteer first. |
| D7 | **What does the asking club see about a guest?** | **Name and club only** ("Ali K (Sutton FC)"), position if he gives one. **No phone number, ever, and no rating from the partner club.** His rating in the asking club starts empty and shrinks to that club's mean, exactly as for any new member (club-scoped ratings rule: "a default is a carried-over opinion"). Option for later: the partner may consent to share its rating as a seed. |
| D8 | **What does the partner group see afterwards?** | **One line, as a reply to the ask:** "FNF's place is filled, thanks all 🙌". Never the asking club's player names or numbers. The volunteer who got the place is told by DM, not in the partner group. |
| D9 | **Language of the guest's DMs?** | **The guest's own club's language** (he reads Sutton's group, not FNF's). Notices to the asking club stay in its language; the ask post is in the partner's language. |
| D10 | **When does a guest stop being a guest?** | **The morning after the match** (the complete-matches cron), or at once if not picked. The asking club's organisers can keep him as a member from the match page ("Add to FNF"), which makes him an ordinary member. |
| D11 | **Billing.** | **No change, guests do not count.** The club fee is per game played, not per player (`club-billing-months.ts`, plan 2A.3). FNF's game is FNF's game; Sutton is not charged for it. The partner group's model calls for replies to the ask count against the partner's AI cap as today (they arrive in its group). |
| D12 | **Caps.** | One open ask per (asking match, partner). At most **2 asks per London day into one partner group**, from all partners together. An ask closes **60 minutes before kickoff** (travel time). |
| D13 | **Ratings and MoM for guests.** | **The guest is rated and can be MoM in the asking club only**, and gets that club's rating DM (he played with them). Nothing is written to the partner club: ratings and Elo are already club-scoped through the match's club and the membership. |
| D14 | **Organisers asking in their own words** ("ask Sutton if anyone can play") needs one new fact on the admin extractor, which is a prompt change. The prompt is rewritten, not appended, and it needs **your approval for one live check** (section 6). Slices 1 to 5 need none. Approve the slice 6 approach now, the run later. |

---

## 1. What exists today (traced in code)

**Recruiting inside one club**
- `inviteRecentPlayers(orgId, lookback)` in `src/lib/recruit.ts` DMs players from the club's last
  completed matches who have not answered the next match; organiser-pick copy says IN puts you on
  the waiting list (`buildRecruitInviteDm`, `organiser: true`). Idempotent per match through
  `SentNotification` key `<matchId>:recruit-dm:<userId>`.
- It is reached from the shared pipeline: the admin extractor returns `action: "recruit"`
  (`AdminFacts`, `src/lib/pipeline/types.ts`), the engine's `admin_ops` branch emits
  `recruit_blast` only for an admin and only when tagged (`engine.ts`, the
  `facts.action === "recruit"` branch, `RECRUIT_BLAST_REQUIRES_TAG`).
- The short-squad chases in `src/lib/bot-scheduler.ts` section 4c (morning of match day, 3 to 4
  hours before, 2 hours before) go to the organisers instead of the players' group when the club
  is in organisers mode (`toOrganisers(key, "chase")`).

**Organiser pick (FNF's mode)**
- `Organisation.benchPickMode = "organiser"`, `benchPickFallback`. `src/lib/organiser-pick.ts`:
  `sweepOrganiserPicks` opens an `OrganiserPickRound` when a place is free and somebody is waiting
  (reasons drop, open-place, deadline-summary, bench-update), `handlePickReply` reads a numbered
  pick, `applyOrganiserPick` is the one writer, `announcePickToGroupAndPlayers` tells people.
- The waiting list is "BENCH rows of members who have not left" (`loadMatchWorld`), and the list
  shown to organisers is `loadPickListRows` (name, position, club rating).

**The shared pipeline**
- Router, extractors, pure engine, composer (`src/lib/pipeline/*`). Since #283 the club's admin
  group (HQ) goes through the same router (`src/lib/admin-group-understand.ts`), with HQ-only
  routes `approve`, `poster`, `team_sheet`, `help`.
- Safe YES: `src/lib/admin-group-confirm-rules.ts` approves only a quoted reply to MatchTime's
  question or the next HQ message within 15 minutes. `PendingItem.kind` is `"teams" | "list"`
  today.
- `SquadState` (`load-state.ts`) is built for **one** active match per club
  (`selectRegistrationMatch`, `src/lib/registration-match-select.ts`). There is no notion of a
  second match in one group. The 2026-09-16 language work listed "two matches per group
  unsupported" as a NO-GO; this plan does not lift it, it sidesteps it (section 3.6).
- Open questions MatchTime asked are already a routing fact: `awaiting-answer.ts`
  (`BenchSlotOffer`, `PendingBenchConfirmation`, `TentativeAvailability`) move a `none` route to
  `unsure` for 60 minutes.

**Quoted replies**
- The Pi reads a reply's quoted id, text and whether it was MatchTime's
  (`whatsapp-bot/src/smart-analysis.ts`, `quotedFields`), but **only for admin-group messages**
  (`readGroupMessageForServer`, called from `routeAdminGroupInbound` in `whatsapp-bot/src/index.ts`).
  The players' group payload to `/api/whatsapp/analyze` has a `quotedBody` field that "no Pi build
  sends yet" (`src/app/api/whatsapp/analyze/route.ts`).
- `/api/whatsapp/ack` stamps `SentNotification.waMessageId` on the claim row of a sent post, so a
  quoted id can be mapped back to the post MatchTime made.

**Attendance writes, guests, members**
- `registerAttendance(userId, matchId, { event, benchIntent, actorIsAdmin, ... })` in
  `src/lib/attendance.ts` is the writer; every change is logged in `AttendanceEvent` with its cause.
- Out-of-band lines tell a group about a DM or app registration
  (`src/lib/out-of-band-attendance.ts`, `OutOfBandSource = "dm" | "app" | "reaction"`).
- Rolling squad already refuses to carry anyone with no live membership
  (`carryOverExclusion` in `src/lib/rolling-squad-rules.ts`: "left the group").
- A cold DM attendance statement lands on the soonest active match across **all** the sender's
  live memberships (`findDmRegistrationTarget`, `src/lib/dm-registration-target.ts`).

**Ratings, payments, billing**
- Ratings are club-scoped: `Membership.seedRating` and `Membership.matchRating`; `Rating` rows
  belong to a match, so to its club.
- Pay links go to every CONFIRMED attendance with a phone, in the match club's language
  (`releaseMatchPayments`, `src/lib/payment-flow.ts`). Payment DMs have no opt-out flag.
- Club fee: per game played, per club (`ClubBillingMonth`, `MDs/club-fee-billing-plan-2026-10-01.md`
  2A.3). Nothing is per player.

**Gates a post must pass**
- Mute `whatsappBotEnabled`, dormancy `dormantAt` (`org-lifecycle.ts`), approval and billing pause
  (`isClubOperational`, `servingClubWhere` in `club-approval-state.ts`), setting up
  (`club-setup-rules.ts`), and whether MatchTime may post at all (`group-postability-rules.ts`).
  A group post is a `BotJob` with the club's `orgId`, so a muted club sends nothing.

**Settings and their explanations**
- `/admin/settings` (`src/app/admin/settings/page.tsx`), writes in `src/app/actions/org.ts`
  (`setOrgFeature`, `setWeeklyRoutine`), ⓘ text in `src/lib/settings-info.ts` (EN and TR side by
  side, house rules checked by a test).

---

## 2. Architecture rules this design keeps

1. **One pipeline.** A partner player's reply in the partner group goes through the partner
   group's normal router, extractors and engine. The only new inputs are **structured facts**: the
   quoted message id (from the Pi) and the open asks (from the database, in `SquadState`). No new
   route, no new pipeline, no second registration path.
2. **No exact-phrase parsing.** Whether a reply is about the ask is decided by *which message it
   quotes*, a fact WhatsApp gives us. Whether it says IN or OUT is decided by the existing
   attendance extractor. Nothing reads "for FNF" out of text with a pattern.
3. **Existing owners do the work.** The waiting list and the pick are `organiser-pick.ts`; the
   write is `registerAttendance`; the notices are `sendAdminNotice`; the HQ YES is
   `admin-group-confirm-rules.ts`; the group lines are `out-of-band-attendance.ts`; pay links are
   `payment-flow.ts`. New code is the ask's lifecycle and the guest marker, nothing else.
4. **Short prompts.** Slices 1 to 5 change no prompt. Slice 6 adds one field to the admin
   extractor by rewriting that prompt (house rule), with an approved live check.
5. **Code decides, model reports.** The engine decides who may volunteer (overlap, already
   confirmed, ask closed), never the model.
6. **Off by default.** No club has a partner until you pair them. Sutton's group is byte-identical
   until an ask is approved and posted there.

---

## 3. Design

### 3.1 Partnerships and who may ask whom

A new table `ClubPartnership`, one row per direction:

- `askerOrgId` may ask `partnerOrgId` for players.
- `status`: `proposed` (you created it) to `active` (both owners accepted) to `paused` (either
  side switched it off) or `ended`.
- `partnerApproval`: `"each-ask"` (default) or `"standing"`, set by the **partner** side only.
- `askerAcceptedAt/By`, `partnerAcceptedAt/By`: an OWNER of each club accepts on its own settings
  page. Either side can pause at any time; a pause closes nothing already filled but stops new asks
  and closes open unfilled ones (volunteers thanked).

Creation: your owner page (`/admin/clubs`, superadmin only) gets "Pair with another club". Both
clubs then see the request on `/admin/settings` with Accept and Decline. That is D1 and D2.

### 3.2 Settings page and ⓘ explanations

New section "Partner clubs" on `/admin/settings`, OWNER and ADMIN may change it:

| Setting | Choices | New clubs |
|---|---|---|
| Partner clubs (list) | each partner: Accept, Pause, Remove | none |
| Ask partner clubs for players | Off, When we ask, Automatically at a time | Off |
| Automatic ask time | match day "HH:MM" (only with Automatically) | 16:00 |
| Asks from partner clubs | Ask our organisers each time, Post without asking | Ask each time |

New keys in `SETTING_INFO_KEYS` (`src/lib/settings-info.ts`): `partnerClubs`, `partnerAskWhen`,
`partnerAskTime`, `partnerApproval`, each with `what`, `example`, `choices`, `newClubs`, `suits`,
`together`, in English and Turkish, no dashes, no slashes (the existing copy test covers them).
`together` must say: the automatic ask waits for an empty waiting list; it does nothing while the
club is paused; the partner's organisers approve unless they chose otherwise. Every sentence traced
to the code that does it, as the file's header requires.

The settings writes go through `src/app/actions/org.ts` like the others, and the keys join
`settingsSetByOrganiser` so the learned setup never overrides them.

### 3.3 The flow, end to end (FNF asking Sutton FC, Friday)

1. **A place opens** (a drop, or the squad is short). Today's behaviour, unchanged:
   organiser pick round to FNF's organisers with the waiting list; short-squad chases to the
   organisers (`bot-scheduler.ts` 4c).
2. **FNF's own members first.** The organisers can ask MatchTime to find someone, which is today's
   recruit blast (`inviteRecentPlayers`, organiser copy: IN puts you on the waiting list). Replies
   land on the waiting list; the pick round updates (`bench-update`).
3. **The partner is asked** when either:
   - an FNF organiser asks: the match page button "Ask Sutton FC" (slice 2), the reply line on the
     organisers' short-squad notice (slice 5), or their own words in HQ or by DM (slice 6); or
   - the automatic time passes on match day, a place is still open, **and FNF's waiting list is
     empty** (D4).
4. **Partner approval** (unless standing): Sutton's organisers get one notice through
   `sendAdminNotice` (Sutton's channel, admin group or each admin by DM):
   > "FNF ask if one Sutton player can play for them tonight: Fri 16 Oct, 20:30 at Goals Sutton,
   > 9-a-side, £8. OK to post this in the Sutton FC group? Reply YES, or tap: <link>"
   It also says, when true, "Your own game tonight is 12/14" so Sutton never lends a player it
   needs. HQ YES uses the safe-YES rule with a new `PendingItem.kind = "partner-ask"`; a DM YES
   uses the same rule on the DM thread (next DM within 15 minutes of the notice, or quoting it);
   the link is a magic link to an approve page and needs no reading at all. No answer by the
   ask's close time: the ask expires, FNF is told.
5. **The post** in the Sutton FC players' group (a `BotJob`, key `xask:<askId>:post`), in Sutton's
   language (section 3.5).
6. **Volunteers** reply to the post with IN (section 3.6). Each one becomes an FNF guest on FNF's
   waiting list, labelled "(Sutton FC)", and MatchTime acknowledges with a reply to them:
   "Thanks Ali, you're on FNF's list. Their organisers pick and I'll DM you either way."
7. **FNF picks** as today: the pick round lists the guest by number; an organiser replies with the
   number; `applyOrganiserPick` writes CONFIRMED. A first-come asking club confirms the first
   volunteer through the capacity rule instead.
8. **Told:** the picked guest by DM (section 3.7); unpicked volunteers by DM ("FNF have their
   player now, thanks for offering"); the Sutton group by one reply to the ask (D8); FNF's
   organisers by the existing pick announcement, with the club label.
9. **Match, payment, ratings** as for any player (sections 3.8, 3.9).
10. **Afterwards** the guest membership ends the next morning (section 3.10).

### 3.4 The ask itself

New table `PartnerAsk`:

- `partnershipId`, `askerOrgId`, `partnerOrgId`, `matchId` (the asker's match), `places`.
- `status`: `awaiting-approval`, `posted`, `filled`, `declined`, `expired`, `cancelled`,
  `refused` (a gate said no; `reason` says which).
- `requestedByUserId`, `requestedVia` (`"button" | "hq" | "dm" | "auto"`), `approvedByUserId`,
  `approvedAt`, `postedAt`, `closesAt` (kickoff minus 60 minutes, D12), `closedAt`.
- The post's `SentNotification` key `xask:<askId>:post`; its `waMessageId` (stamped by `/ack`) is
  how a quoted reply finds the ask.
- `volunteerUserIds[]`, `pickedUserIds[]` for audit and wording.

**Rules, in a pure module `partner-ask-rules.ts`** (no DB, no model, fully unit-tested):

- `canAsk`: partnership active both sides; asker setting not Off; requester is OWNER or ADMIN of the
  asker (or the automatic timer); the match is the asker's live next match
  (`isNextUpcomingForPosting`), not cancelled, places open now; before `closesAt`; no open ask for
  this (match, partner); partner under its daily cap (2).
- `partnerReachable`: partner not muted, not dormant, approved, not billing-paused, not setting
  up, group postable (`group-postability-rules.ts`). If not, the ask is `refused` and the asker's
  organisers are told in plain words ("Sutton FC's group can't be asked right now"), never the
  internal state.
- `closeReason`: filled (places now zero by any route, the club's own player included), kickoff
  minus 60, partnership paused, match cancelled or rescheduled.

**Sweeps** run in the same due-posts poll as `sweepOrganiserPicks`: open automatic asks, expire
approvals, close asks, queue the closing lines. Each step is claimed with a `SentNotification` key
so a second poll does nothing twice (the house pattern).

**Several asks.** One open ask per partner per match. A second partner may be asked at the same
time; volunteers from both land on the same waiting list and the pick decides. A place that opens
while an ask is posted does **not** repost; the ask's `places` is raised and the next
acknowledgement says the new number.

### 3.5 What the post in the partner group says

English (Sutton FC):
> ⚽ *FNF* need 1 player tonight: Fri 16 Oct, 20:30 at Goals Sutton (9-a-side, £8).
> Fancy a game? *Reply to this message* with *IN* and their organisers will confirm by DM.

Turkish (a Turkish partner club):
> ⚽ *FNF* bu akşam 1 oyuncu arıyor: Cuma 16 Eki, 20:30, Goals Sutton (9'a 9, £8).
> Oynamak ister misin? *Bu mesajı yanıtlayıp* *VARIM* yaz, organizatörleri sana DM ile dönecek.

Built from database facts only (club name, `dayCommaTimeLabel(lang, date)`, venue, format, the
match fee or the activity default, places). No names of the asking club's players, no numbers. The
"reply to this message" instruction is what makes the answer unambiguous (section 3.6). Strings go
in `src/lib/i18n/strings.en.ts` and `strings.tr.ts`, both renderings in the PR.

### 3.6 Telling a partner player's IN apart from IN for their own game

This is the hard part, and it is decided by facts, not words.

**The Pi forwards quoted replies for the players' group** (slice 0): the same `quotedFields` it
already sends for admin groups (`quotedMessageId`, `quotedText`, `quotedFromMatchTime`), added to
the analyze payload. The server carries it on `EngineMessage` as `quoted`.

**`SquadState` gains `partnerAsks`**: the asks posted **into this group** that are still open, each
with its post's `waMessageId`, the asker's club name, match id, kickoff and window. Loaded in
`load-state.ts` (read only, like everything there).

**The engine, in the attendance branch** (no new route; the router still says `self_att` and the
extractor still returns a claim with `subject: "sender"` and `polarity: "in"` or `"out"`):

- The message quotes the post of an open ask (`msg.quoted.id === ask.waMessageId`): the claim is
  **about the ask, not about the club's own match**. The engine emits a new proposed write
  `partner_volunteer { askId, userId, polarity }` instead of an attendance write on the own match.
  Same claim, different target, chosen by a fact.
- It quotes the post of a **closed** ask: no write; one reply "That place has gone now, thanks".
- It does not quote an ask: **exactly today's behaviour**, the claim is about the own club's
  match. Nothing changes for Sutton unless someone replies to an ask.
- D5b (recommended): it does not quote, an ask was posted in the last 60 minutes, and the sender
  has **no row at all** on their own club's active match: the engine still writes nothing for the
  ask and asks one question in the group, "For FNF on Friday? Reply to my FNF message so I know".
  A sender who already has a row is clearly talking about their own game and hears nothing new.
  This is a state rule in the engine, not a reading of words.
- The open ask also joins `awaiting-answer.ts` as `AwaitingKind = "partner-ask"` with the same
  60-minute TTL, so a bare 👍 or "me" replying to the post is never routed `none`.

**Who may volunteer** (engine decision, pure):
- the sender is a resolved member of the partner club (unknown senders are not provisioned
  through an ask);
- their own club's match does not overlap the asker's: kickoff windows
  `[kickoff minus 60 min, kickoff plus duration plus 60 min]` must not intersect if they are
  CONFIRMED or BENCH there. Overlap: a reply "You're in Sutton's 20:30 game tonight, so I can't put
  you on FNF's list";
- they are not already an FNF member (then they are simply an FNF player and the write is an
  ordinary FNF IN, no guest marker);
- the ask is still open.

**Who executes it:** a new executor `partner-guest.ts`, called by the analyze route for
`partner_volunteer` writes. It does the guest membership (3.7), calls `registerAttendance` on the
**asker's** match with `event.cause = "partner-ask"` and `sourceRef = "xask:<askId>"`, records the
volunteer on the ask, and queues the acknowledgement reply. It is the only place a person is
written onto another club's match, so it is the only place that needs a guard test.

**A volunteer changes their mind:** a quoted OUT (or OUT by DM, below) drops their row on the
asker's match through the same writer. In an organiser-pick club that is just a waiting-list
change; if they had been picked, it is a drop, and the existing pick round reopens.

### 3.7 Becoming a guest for one match

**Membership with a guest marker** (recommended over no membership). New nullable columns on
`Membership`: `guestFromOrgId` and `guestMatchId`. The volunteer gets (or reuses) a membership in
the asking club with both set and `role: PLAYER`.

Why a membership, traced: the waiting list is built from members who have not left
(`loadMatchWorld`); names in replies come from `SquadState.roster` (memberships); Elo writes go to
`Membership.matchRating`; the balancer reads `Membership.seedRating`. Without a membership every one
of those readers would need a guest branch. With one, they all work, and the guest marker is only
read where a guest must be **left out**:

| Reader | What it does with a guest |
|---|---|
| `inviteRecentPlayers` (`recruit.ts`) | skip guests: never DM a partner player for the asker's later games |
| rolling squad (`rolling-squad-rules.ts`) | already excluded once the membership has `leftAt` (3.10); also excluded by marker so a same-week rolling seed can never carry him |
| badges (`badge-announcements.ts`) | no badge posts about guests in the asker's group |
| leaderboards and stats answers | guests not listed in the asker's tables |
| seed nudge (`seed-nudge.ts`) | guests not counted in "0 of 24 seeded" |
| `/admin/players`, `/admin/players/phones` | guest shown as "Ali K, guest from Sutton FC", **phone hidden**, not exportable |
| cold DM target (`dm-registration-target.ts`) | see below |
| organiser-pick list (`loadPickListRows`) | adds the label "(Sutton FC)"; `PickListRow` gains `fromClub` |

**Cold DMs while a guest.** `findDmRegistrationTarget` takes the soonest match across live
memberships, so a guest's DM "IN" meant for his own Tuesday could land on FNF's Friday. Rule: a
guest membership is a DM target **only for an OUT about that one match**; when the sender has both
a live guest place and an own-club active match and says OUT by DM, MatchTime asks which ("FNF on
Friday or Sutton on Tuesday?"), a code decision from the two rows.

**The DM to the picked guest** (his own club's language, D9):
> ✅ You're playing for *FNF* tonight: Fri 16 Oct, 20:30 at Goals Sutton. £8, pay link after the
> game. Can't make it after all? Reply *OUT*.

Sent through the existing pick announcement path (`announcePickToGroupAndPlayers` already DMs the
picked player), with the guest copy chosen when the membership has a guest marker.

**The asking club's own group** hears about it as any out-of-band registration does:
`OutOfBandSource` gains `"partner"`, the line names the club ("Ali K from Sutton FC is in").
In organisers mode that line goes to the organisers, as the other squad lines already do.

### 3.8 Payments

- The guest pays the **asking** club's fee to the **asking** club's collector. Nothing changes in
  `releaseMatchPayments`: he is a CONFIRMED attendance with a phone, so he gets a pay link.
- One change: the pay link and the pay chases for a guest are written in **his** club's language
  (D9). `releaseMatchPayments` reads the language per attendance via the guest marker.
- A monthly-squad asking club: the guest is a PAYG player at `paygPricePence`, exactly like any
  PAYG player (`monthly-week.ts`).
- The ask post shows the fee when one is known (match fee, else the activity default) and leaves it
  out otherwise. MatchTime never shows bank details in the partner group.
- Payment DMs have no opt-out today and stay that way: a guest who played owes the fee.

### 3.9 Ratings, MoM, Elo, badges

- **Club-scoped already.** `Rating` and `MoMVote` hang off the match, so off the asking club.
  Elo goes to the guest's membership in the asking club. The partner club's numbers never move.
- The guest's asking-club rating starts empty (`seedRating` NULL), so the balancer shrinks him to
  the asking club's mean (D7). The pick list shows "new".
- The guest gets the asking club's rating DM (he played) and is in the MoM options. He cannot vote
  in a MoM poll posted in a group he is not in; that is fine.
- No badge announcements about guests (3.7 table).

### 3.10 Leaving afterwards

- **Not picked:** when the ask closes, the guest's waiting-list row is dropped
  (`cause = "partner-ask-closed"`) and the guest membership gets `leftAt`. One DM: "FNF have
  their player now, thanks for offering".
- **Played:** the morning after the match, `complete-matches` (or the 08:00 rolling sweep, same
  run) sets `leftAt` on every guest membership whose `guestMatchId` is finished. History stays
  attributable (attendance, ratings, payment).
- **Kept:** "Add to FNF" on the asker's match page clears both guest columns. He is then an
  ordinary FNF member, still without his phone shown unless he joins FNF's group (the participant
  sweep then sees him as any member).

### 3.11 Privacy

| Who | Sees | Never sees |
|---|---|---|
| Partner club's group | the ask: asking club's name, day, time, venue, format, places, fee; then "filled, thanks" | the asking club's player names, numbers, ratings, its group |
| Partner club's organisers | the approval notice, then who from their club is playing for the asker | the asking club's squad |
| Asking club's organisers and group | the guest's name, his club's name, his position if given | his phone number, his partner-club rating, other volunteers' phones |
| The guest | the asking club's game details; the asking club's names only once he is in the match (rating DM, team sheet if posted to him) | anything else about the asking club |

Phone numbers are used only by MatchTime to DM; no post, notice or page shows a guest's number to
the other club. The guest's stored `User.phoneNumber` is unchanged (it is one global user).

### 3.12 Billing

- **Club fee:** unchanged. A game is counted once, for the club whose game it is
  (`ClubBillingMonth`, games played). Guests do not count, and no per-player charge exists.
- **AI cap:** replies to the ask arrive in the partner group and are routed there, so they use the
  partner's daily AI allowance (`ai-budget.ts`) like any message in that group. The volume is a
  handful of messages per ask; no change proposed (D11).

### 3.13 Edge cases

| Case | What happens |
|---|---|
| Both clubs play the same evening | Overlap rule (3.6) refuses volunteers already in their own game at an overlapping time. The approval notice tells the partner's organisers how their own squad stands; an **automatic** ask is not posted into a partner whose own overlapping game is short. |
| Partner group silent (nobody answers) | The ask closes at kickoff minus 60; the asker's organisers get "Nobody from Sutton FC took it". |
| Partner muted, paused, dormant, setting up, not postable | Not posted; `refused` with a plain reason to the asker's organisers. A muted club's queued post would not go anyway (BotJob gate). |
| Partner organisers don't approve | Expires at close; asker told. A partner who often ignores asks can switch to standing permission or pause the partnership. |
| Place filled by the club's own player after the ask | Ask closes as filled; volunteers thanked; partner group told once. |
| Two places, three volunteers | The pick decides; the unpicked two are thanked at close. |
| Volunteer later says OUT | Quoted OUT or DM OUT drops his asker row; if picked, the existing pick round reopens for that place. |
| Volunteer is already a member of both clubs | Ordinary IN for the asker's match, no guest marker. |
| Match cancelled or moved after the post | Ask cancelled; guests told by DM; partner group told once. |
| Several partners | Each its own ask; same waiting list; pick decides. |
| Daily cap reached for a partner group | `refused`, asker told "Sutton FC has had two asks today already". |
| Turkish clubs | The post is in the partner's language, the guest's DMs in his club's language, the asker's notices in the asker's. The attendance extractor already reads Turkish replies (VARIM, YOKUM). A pairing across languages is allowed; MatchTime does not judge whether a player will understand the other team. |
| Unknown sender replies IN to the ask | No guest is provisioned from an ask; MatchTime replies once asking him to message an organiser of his own club. |
| The ask post's `waMessageId` never came back from `/ack` | Quoted replies cannot be matched; the sweep notices the missing id after 10 minutes and tells the asker's organisers the ask may not have posted. Never silent. |

---

## 4. Data model (all additive)

```prisma
model ClubPartnership {
  id                 String   @id @default(cuid())
  askerOrgId         String
  partnerOrgId       String
  status             String   @default("proposed") // proposed | active | paused | ended
  partnerApproval    String   @default("each-ask") // each-ask | standing
  askerAcceptedAt    DateTime?
  askerAcceptedBy    String?
  partnerAcceptedAt  DateTime?
  partnerAcceptedBy  String?
  createdByUserId    String
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
  @@unique([askerOrgId, partnerOrgId])
}

model PartnerAsk {
  id                String    @id @default(cuid())
  partnershipId     String
  askerOrgId        String
  partnerOrgId      String
  matchId           String
  places            Int
  status            String    @default("awaiting-approval")
  reason            String?
  requestedByUserId String?
  requestedVia      String    // button | hq | dm | auto
  approvedByUserId  String?
  approvedAt        DateTime?
  postedAt          DateTime?
  closesAt          DateTime
  closedAt          DateTime?
  volunteerUserIds  String[]  @default([])
  pickedUserIds     String[]  @default([])
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  @@index([partnerOrgId, status])
  @@index([matchId, status])
}
```

`Organisation`: `partnerAskWhen String @default("off")` (off | on-request | auto),
`partnerAskTime String?`. `Membership`: `guestFromOrgId String?`, `guestMatchId String?`.
CHECK constraints in `prisma/sql/` as the other enums-in-strings have (status values,
`askerOrgId <> partnerOrgId`, both guest columns null or both set). Single writer per table,
pinned by source guard tests, like `club-billing.ts` and `club-setup.ts`.

---

## 5. Slices

Each slice is small, ships alone, TDD (red, green, refactor), unit tests plus Playwright where there
is a page, English and Turkish for every string. Slices 0 to 5 change no prompt and need **no live
model run**.

**S0. Quoted replies from the players' group.** Pi: add `quotedFields` to the players' group
payload (`whatsapp-bot/src/smart-analysis.ts`, the analyze forwarder in `index.ts`). Server: parse
`quotedMessageId`, `quotedFromMatchTime` in `analyze/route.ts` onto `EngineMessage.quoted`. No
reader yet, no behaviour change.
Tests: Pi unit (a reply forwards its quote, a plain message forwards nothing); route parse unit;
the existing corpus stubbed suite unchanged. Pi deploy through `scripts/deploy-pi.sh` only.

**S1. Partnerships and settings.** Tables, columns, CHECKs, migration. Owner page "Pair with
another club" on `/admin/clubs`; Accept, Decline, Pause on `/admin/settings`; the asker settings and
the partner approval setting; four `settings-info.ts` entries.
Tests: unit for the writer and its rules (one row per direction, accept by OWNER only, pause);
`settings-info` copy test; Playwright `admin-settings.spec.ts` and `info-buttons.spec.ts` extended
(section shows, ⓘ opens in both languages, a PLAYER cannot change it).

**S2. The ask, approved and posted.** `partner-ask-rules.ts` (pure) and `partner-ask.ts` (DB):
`canAsk`, `partnerReachable`, caps, close reasons; the match page button "Ask Sutton FC"; partner
approval through `sendAdminNotice`, HQ YES via `PendingItem.kind = "partner-ask"` in
`admin-group-confirm-rules.ts`, approve link page; the post; the sweep in the due-posts poll
(expire, close, closing lines); refusal notices to the asker.
Tests: unit for every rule and every refusal; idempotency of every claim key; HQ YES approves only
the ask it quotes or follows; Playwright: button visible only with an active partnership, approve
page approves once.

**S3. Volunteers.** `SquadState.partnerAsks`; `awaiting-answer.ts` kind `partner-ask`; the engine
branch (quoted reply to an open ask becomes `partner_volunteer`; closed ask reply; overlap; already
a member); `partner-guest.ts` executor (guest membership, `registerAttendance` with
`cause = "partner-ask"`, acknowledgement reply); quoted OUT; `PickListRow.fromClub`;
`OutOfBandSource = "partner"`.
Tests: pure engine tests on plain `SquadState` objects (quoted IN, quoted OUT, unquoted IN
unchanged byte for byte, overlap, closed ask, unknown sender); executor unit with the real write
path; a stubbed `e2e/sim` spec with two clubs in one world (Sutton player replies IN, appears on
FNF's pick list, organiser picks, DM queued); a guard test that `partner-guest.ts` is the only
cross-club attendance writer.

**S4. Guest lifecycle and exclusions.** Picked guest DM, unpicked thanks, partner "filled" line;
`leftAt` at close and the morning after; "Add to FNF" on the match page; every exclusion in the
3.7 table; DM OUT ambiguity question; guest-language pay links and chases; PAYG for monthly clubs.
Tests: unit per exclusion (recruit, rolling squad, badges, seed nudge, stats); pay link language;
Playwright: players page shows the guest label and no phone, phones page excludes guests, match page
"Add to FNF" clears the marker.

**S5. Automatic ask and the organisers' notice line.** The `auto` timer (only with an empty waiting
list, places open, partner reachable, partner's own overlapping game not short); one line on the
organisers' short-squad notice naming the partner ("Want me to ask Sutton FC? Tap: <link>"), the
link opening the S2 button.
Tests: unit for the timer across the October DST change and for each condition; scheduler test that
Sutton FC's own posts are byte-identical with no partnership.

**S5b (if D5b is yes). The one question for an unquoted IN.** Engine state rule only, composed
from state, EN and TR.
Tests: pure engine tests: asked only with no own-match row and within 60 minutes; never asked twice
to the same sender for one ask.

**S6. Organisers asking in their own words.** The admin extractor gains one fact, `clubRef`: the
other club's name as written, absent when none ("ask Sutton if anyone can play" gives
`action: "recruit"`, `clubRef: "Sutton"`). The engine resolves it against the asker's active
partners (a lookup like a name against the roster, not a phrase rule); one partner and "another
club" with no name resolves to that partner; no partner, or no match, gives one plain reply. The
admin extractor prompt is **rewritten as a whole** (house rule), sizes reported before and after,
above the cache floor (`cache-threshold.test.ts`). Applies in HQ, by DM (through `dm-intent.ts`'s
recruit path) and tagged in the players' group, admins only, tag rules unchanged.
Tests: unit for the resolution; stubbed sim; **the live check in section 6, with your approval**.

---

## 6. Live checks (none until you approve)

- S0 to S5 (and S5b): **no live model run.** No prompt changes; the router and attendance
  extractor are unchanged; the new decisions read structured facts. Unit and Playwright suites
  only.
- S6 only, when built, and only with your yes: the cheap plan. (1) the new cases once each, about
  eight messages in English and Turkish ("ask Sutton if anyone can play", "try the other club",
  "Sutton'a sor bakalım oynayan var mı", plus near misses such as "Sutton were great last week");
  (2) **one** pass of the existing admin_ops cases, because a rewrite widens the regression risk to
  every behaviour the prompt already handles (bulk payment, reminder, recruit, stats blast, other);
  (3) report the number of model calls made. On the development key only
  (`ANTHROPIC_API_KEY_DEV`). A single pass cannot prove an occasional miss will not happen; one
  would be caught live, where the worst outcome is an organiser retyping or using the button.

---

## 7. Risks worth naming

- **Mistaking an IN.** The design's answer is the quoted reply; the residual risk is a player who
  replies IN to the ask meaning his own game. The acknowledgement reply names FNF, so he finds out
  at once and can say OUT.
- **Spam into a partner group.** Caps, approval by default, and pause on either side.
- **Quoted ids not coming back** from the Pi or `/ack`: the S2 sweep checks the post's id and
  tells the asker; S0 tests both drivers' quote reading.
- **A second club's player in the asker's data.** Every exclusion in 3.7 is a test, and guests end
  the morning after, so a missed reader leaks for one day at most, not forever.
- **Organisers mode posts.** FNF's players' group receives nothing new; every new FNF-side line goes
  to its organisers, matching `listAnnouncer = "organisers"`.
