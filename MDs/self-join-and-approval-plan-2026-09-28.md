# Self-join with owner approval

Plan, 2026-09-28. Design only: no code, schema or prompt was changed to write it.
Direction approved by Kemal. Every claim about the current code cites the file it
was read from, on `origin/main` at `6f465fd`.

---

## One-screen summary (for Kemal)

**What organisers do**

1. Sign up on matchtime.ai with name and mobile (WhatsApp code, as today) and
   create their club.
2. Only then does the site show **Add MatchTime to WhatsApp**. It opens WhatsApp
   with a message already typed: "Connect Riverside FC, code 7KQ2". They press send.
3. MatchTime replies: "Now add me to your football group."
4. They add MatchTime to the group. MatchTime checks the person who added it is
   the same phone that signed up, and links the group to the club **as pending**.

**What you do**

5. You get **one** WhatsApp DM: club, organiser (name, phone, verified), group
   name, member count. Reply **APPROVE 7KQ2** or **REJECT 7KQ2** from your own
   phone. The same buttons are on a new owner page, `/admin/clubs`, as a fallback.

**What MatchTime does**

6. Until you approve: total silence in that group. No posts, no ticks, no DMs to
   members, **zero AI calls**. On approve: a short hello in the group explaining
   IN and OUT, in the club's language (English or Turkish). On reject: it leaves
   the group without a word, and sends the organiser one polite DM (recommended).

**Spend and abuse limits (numbers)**

| Control | Limit |
|---|---|
| AI spend, waiting for approval | **$0. Zero AI calls**, whatever any cap says |
| AI spend, every approved group, forever | **$1.00 a day** (hard cap, real dollars) |
| AI spend, first 4 weeks after approval | **$0.25 a day** (the 4 weeks start when you approve, not at sign-up) |
| When the cap is hit | Plain IN and OUT keep working with no AI at all. A tagged question gets one line, once a day: "I've answered a lot today, ask me again tomorrow." Everything else waits until tomorrow. Shown on the owner dashboard, **never** a DM to you. |
| Clubs per verified phone | 1 |
| Sign-up codes sent by WhatsApp, whole site | 20 a day |
| New groups linked, whole site | 5 a day |
| Connect codes | 1 live per club, valid 60 minutes, 3 a day |
| DMs to members from a new club, first 4 weeks | 20 a day |
| Off switch per club | On `/admin/clubs`: MatchTime leaves the group and goes silent |

The dollar cap itself is being built separately on `feat/ai-daily-cap`; this plan
depends on it and only adds what approval needs on top (section 9). For scale:
Sutton FC's whole September production AI bill was about $3.50, about $0.12 a day
(`MDs/llm-spend-september-2026.md`), so the worst any one group can cost is about
$30 a month, and $7.50 in its first month.

**Safety for Sutton FC:** every existing club is treated as already approved, so
nothing in the self-join flow changes anything Sutton sees.

**No prompt changes, so no paid AI test runs are needed.** Everything here is
tested with the free unit and Playwright suites.

**Decisions I need from you** are listed in section 13 (eight of them, each with a
recommendation).

---

## 1. What exists today (verified in code)

| Piece | Where | What it does now |
|---|---|---|
| Phone sign-up | `src/app/actions/phone-signup.ts` | 6-digit code by WhatsApp DM. Queues a `BotJob` under "the first bot-enabled org" as a sender, because `BotJob.orgId` is required. Limits: 3 codes per phone per hour, 10-minute expiry, 5 attempts. **No site-wide cap.** |
| Create club | `src/app/create-org/page.tsx`, `createOrganisation` in `src/app/actions/org.ts` | Creates an `Organisation` and an OWNER `Membership`. No group, `whatsappBotEnabled` false by default. |
| Link a group | `scripts/set-whatsapp-group.ts` | Manual. |
| Bot added to a group | `whatsapp-bot/src/bot-added.ts`, `src/app/api/whatsapp/bot-added/route.ts` | Pi detects self-add, posts subject, adder phone, participant snapshot and history. Server, if `ONBOARDING_AUTOSTART` is on, creates an `OnboardingSession` and hands back an intro to post. The flag is on in prod but this has never fired. |
| In-group setup | `src/lib/onboarding-conversation.ts` | Multi-turn setup. Calls Haiku (`anthropic.messages.create`, line 490). |
| Legacy "@MatchTime setup" trigger | `whatsapp-bot/src/index.ts` ~571, `handleOnboardingIfApplicable` in `src/app/api/whatsapp/analyze/route.ts` ~3730 | An **unmonitored** group that types "@MatchTime setup" is monitored on the spot and starts a session. This is a hole for pending groups; see 4.3. |
| Which groups the Pi listens to | `GET /api/whatsapp/orgs` | Orgs with `whatsappBotEnabled` and a group id, plus active onboarding groups. The Pi drops everything else at `isMonitoredGroup`. |
| Server gates | `analyze`, `due-posts`, `group-join`, `group-leave`, `sync-participants`, `bot-added` | All look the org up with `whatsappBotEnabled: true`. `score`, `teams`, `status`, `attendance` and `heartbeat` look up by group id **without** it. |
| Mute vs lifecycle | `Organisation.whatsappBotEnabled` (mute), `Organisation.dormantAt` (declared dormancy), `src/lib/org-lifecycle.ts` | The schema comments are explicit that the mute switch must not be read as a lifecycle state. |
| DMs from people | `index.ts` DM branch, `POST /api/whatsapp/dm-reply` | Pi forwards `{phone, authorName, body, waMessageId}`. No LID is forwarded. The server resolves by phone, returns `unknown-sender` before any model call when it cannot (route line ~334). Some later branches call models (`dm-intent`, `dm-qa`). |
| DMs to Kemal today | `src/app/api/cron/bot-health/route.ts` ~297 | Health alerts are queued as `BotJob kind:"dm"` to the org's OWNER and ADMIN phones. This is what `feat/health-to-dashboard` is moving off WhatsApp. |
| Outbound pacing | `whatsapp-bot/src/scheduler.ts` | Polls `due-posts` every 30s per org; at most one DM per 60s (`DM_GAP_MS`), added after WhatsApp's 21-hour restriction on 2026-04-30 (about 56 DMs in quick succession). |
| Leaving a group | nowhere | `WaDriver` (`whatsapp-bot/src/driver.ts`) has no leave method. |
| AI cost per call | `src/lib/pipeline/llm.ts` `costOf()`; `usage.costUsd` on every router and extractor response; summed in `src/lib/pipeline/run.ts` | Measured per call. Storing and capping it per org per day is `feat/ai-daily-cap` (section 9). |
| Deterministic floor | `routeFloor()` in `src/lib/pipeline/router.ts` ~447 | Bare IN / OUT / VARIM / YOKUM, and "@Name in", skip the **router** call. **They still call the Sonnet extractor** (`run.ts` stage 2, `attendance-engine-batch.ts` ~584). That matters to `feat/ai-daily-cap`; see section 9. |
| Static fallbacks | `src/lib/message-analyzer.ts` | Every scheduled chase composer falls back to static copy when the model fails. |

---

## 2. How the person who added MatchTime is identified (Baileys)

This is the load-bearing part, so it is spelt out.

### 2.1 What Baileys hands us on a group add

- A normal add arrives as `group-participants.update` with `action: "add"`,
  `author` and, when WhatsApp includes it, `authorPn`
  (`whatsapp-bot/src/baileys/groups.ts`, `membershipEvent`, line ~383).
- A group created with us already in it arrives as `groups.upsert` with
  `meta.author` and `meta.authorPn` (`drivers/baileys.ts`, `receiveGroupUpsert`).
- Both go through `authorId(author, authorPn, phoneForLid)`
  (`groups.ts` ~399): the author is handed up as `<phone>@c.us` when **any** phone is
  known, otherwise as the bare `<lid>@lid`.
- `phoneForLid` (`drivers/baileys.ts` ~534) reads only what we have been told:
  the harvested directory (`baileys/contacts.ts`), then Baileys' **local**
  `getPNForLID` store. It never asks WhatsApp. That respects the source ban in
  `drivers/baileys.source.test.ts` (`onWhatsApp`, `executeUSyncQuery`,
  `getLIDForPN`, `getLIDsForPNs` are forbidden).

### 2.2 Why the connect DM makes this reliable

The organiser **messages MatchTime before adding it**. That inbound DM does two
things for free:

1. `contacts.learnFromMessage(key, pushName)` (`drivers/baileys.ts` ~766) records
   the pair (sender, alt) off the envelope, so if the DM arrived LID-addressed with
   a phone in `remoteJidAlt` (or the reverse), we now hold the organiser's
   LID-to-phone pair locally.
2. `resolveInboundSender` (`baileys/jid.ts` ~202) gives the phone from the JID, the
   alt, or the local store.

Then, when the same person adds MatchTime minutes later, their LID resolves to a
phone locally even if WhatsApp sends no `authorPn`. As a third path, the self-add
triggers `groupSnapshot`, whose `groupMetadata` read seeds every participant's
pair through `seedFrom` (the only network LID-to-phone path, and an allowed one).

### 2.3 The matching rule (server side, in order)

The Pi sends, on a self-add: `addedByPhone` (as today), **new** `addedByLid` (the
bare LID when the author was LID-addressed, even if a phone was also found), and
it re-resolves the author **after** the snapshot read, so the snapshot's seeding
can fill a phone the event lacked.

The server compares against the organiser's open connect request:

| Result | Condition | `adderMatch` |
|---|---|---|
| Matched by phone | `addedByPhone` equals the organiser's verified signup phone | `phone` |
| Matched by LID | `addedByLid` equals the LID recorded from the organiser's connect DM | `lid` |
| Someone else added it, organiser is in the group | adder known but different; organiser's phone or LID is in the snapshot | `other-organiser-present` |
| Adder unknown | no author at all, or a LID we cannot map and that does not equal the DM's LID | `unknown` |
| Someone else, organiser absent | adder known, different, organiser not in snapshot | `mismatch` |

Only `phone` and `lid` are "verified". **Every other case still becomes a pending
request, clearly labelled**, and Kemal decides; nothing is auto-rejected. The DM to
Kemal says which line applied ("Added by: the organiser, matched by phone" or
"Added by: unknown, organiser IS in the group").

Which connect request does an add belong to? The one whose organiser matches the
adder. If the adder is unknown, and exactly **one** DM-verified request has its
organiser in the snapshot, link to that one with `adderMatch: unknown`. Otherwise the
add is recorded as **unsolicited** (section 5.6).

### 2.4 What must be measured on the throwaway test (Phase 0 of the rollout)

- Which path resolved the connect DM's phone (`jid`, `alt`, `lid-mapping`), from the
  existing `[baileys][msg]` log line.
- Whether the add event carried `authorPn`, and whether `author` was a LID.
- Whether the post-snapshot re-resolve was needed.

If the organiser's phone comes back unresolved at the DM step (possible for a
privacy-mode account with no alt on the envelope), the plan still works: the
request is bound to the DM's LID (see 5.3), and the add matches on LID.

---

## 3. Data model (all additive)

### 3.1 `Organisation`: four new columns

```prisma
/// Approval state for clubs that joined themselves. Every existing org
/// (Sutton FC included) is "approved" by the default, so nothing changes
/// for them. Values: "draft" | "pending" | "approved" | "rejected" | "suspended".
approvalStatus    String    @default("approved")
/// When Kemal approved. NULL for every pre-existing org, which is what
/// exempts them from the new-club spend cap and DM cap.
approvedAt        DateTime?
/// When and by whom the last decision was made ("whatsapp:<phone>" or a userId).
approvalDecidedAt DateTime?
approvalDecidedBy String?
```

`approvedAt` is also the start of the new-club AI allowance on
`feat/ai-daily-cap` (section 9). No cap columns are added here; that branch owns
them.

**Reuse, not parallel flags.** Silence is still enforced by the existing
`whatsappBotEnabled` gate (every route and the Pi already honour it). The new
column only records *why* the club is off. One invariant ties them together, and it
is enforced three times:

1. A Postgres check constraint in the migration:
   `CHECK (NOT "whatsappBotEnabled" OR "approvalStatus" = 'approved')`.
2. A single writer, `setClubApproval()` in a new `src/lib/club-approval.ts`, used by
   the DM path and the owner page alike.
3. A unit test that fails if any file other than that module and the existing mute
   paths writes `approvalStatus`.

`whatsappGroupId` is **not** set while pending. It is written at approval, from the
connect request. That keeps the five routes that look up by group id without the
enabled flag (`score`, `teams`, `status`, `attendance`, `heartbeat`) blind to
pending groups, and keeps `scripts/set-whatsapp-group.ts` meaning what it means.

### 3.2 New `ClubConnect`: one row per "Add MatchTime to WhatsApp" attempt

```prisma
model ClubConnect {
  id              String    @id @default(cuid())
  orgId           String
  userId          String              // the organiser (OWNER of a draft org)
  phone           String              // their verified signup phone, digits only
  code            String              // 4 chars, alphabet without 0 O 1 I L
  /// "issued" | "dm_verified" | "group_linked" | "expired" | "superseded" | "closed"
  status          String    @default("issued")
  issuedAt        DateTime  @default(now())
  expiresAt       DateTime            // issuedAt + 60 min
  // The connect DM
  dmAt            DateTime?
  dmPhone         String?             // resolved sender phone, if any
  dmLid           String?             // sender LID, if the envelope had one
  dmPhoneMatched  Boolean?            // dmPhone == phone
  dmWaMessageId   String?   @unique   // idempotency for a re-forwarded DM
  lastMismatchAt  DateTime?           // a DM with this code from another number
  lastMismatchPhoneMasked String?     // shown on the organiser's page
  addWindowEndsAt DateTime?           // dmAt + 24h
  // The group add
  groupId         String?
  groupSubject    String?
  memberCount     Int?
  addedByPhone    String?
  addedByLid      String?
  adderMatch      String?             // "phone" | "lid" | "other-organiser-present" | "unknown" | "mismatch"
  participants    Json?               // snapshot, imported at approval
  detectedLang    String?             // detectGroupLang on subject + history
  linkedAt        DateTime?
  ownerDmQueuedAt DateTime?           // the one DM to Kemal, once
  botRemovedAt    DateTime?           // MatchTime removed while pending
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([code, status])
  @@index([orgId, status])
  @@index([groupId])
}
```

The 4-character code is not the security. It is a pointer; the proof is the phone
(or LID) match. Codes are unique among unexpired rows only.

### 3.3 New `PlatformJob`: DMs and actions that belong to no live club

```prisma
model PlatformJob {
  id         String    @id @default(cuid())
  kind       String            // "dm" | "leave-group"
  phone      String?           // for "dm", digits
  groupId    String?           // for "leave-group"
  text       String?   @db.Text
  purpose    String            // "otp" | "connect-reply" | "owner-approval" | "organiser-decision" | "owner-ack"
  refId      String?           // ClubConnect.id etc., for dedupe and the owner page
  sendAfter  DateTime?
  claimedAt  DateTime?         // claim-on-dispatch, same rule as due-posts
  sentAt     DateTime?
  createdAt  DateTime  @default(now())

  @@index([sentAt, sendAfter])
}
```

Why not `BotJob`: `BotJob.orgId` is required and `BotJob` is only dispatched
through `due-posts`, which 404s for any org that is not bot-enabled. The sign-up
code already works around that by borrowing "the first bot-enabled org" as a
sender. If Kemal mutes Sutton (he did twice in the week of 2026-09-06) and it is
the only live org, **sign-up codes silently stop**. `PlatformJob` removes the
borrowing; sign-up codes move onto it in the same slice.

### 3.4 Counters that need no table

Site-wide caps are counted from rows that exist anyway: `PhoneOtp.createdAt` for
sign-up codes, `ClubConnect.dmAt` / `linkedAt` for connects and links, `Organisation`
created in self-join mode for new clubs. Each count is one indexed query.

---

## 4. States and transitions

### 4.1 The club (`Organisation.approvalStatus`)

| From | Event | To | Side effects |
|---|---|---|---|
| (none) | Organiser creates a club, `SELF_JOIN_ENABLED` on | `draft` | OWNER membership, as today |
| `draft` | MatchTime added to a group and linked (any `adderMatch`) | `pending` | `ClubConnect.group_linked`; one DM to Kemal; ack DM to organiser if matched |
| `pending` | Kemal APPROVE (DM or page) | `approved` | see 6.2 |
| `pending` | Kemal REJECT | `rejected` | leave group; one DM to organiser (recommended) |
| `pending` | MatchTime removed from the group | `draft` | `botRemovedAt`; Kemal's pending item marked "removed"; no DM |
| `approved` | Kemal "Turn off" on the page | `suspended` | `whatsappBotEnabled=false`; leave group; no DM to the group |
| `suspended` | Kemal "Allow reconnect" | `draft` | organiser may run the connect flow again, which needs a fresh approval |
| any | (existing) dormancy, mute | unchanged | `dormantAt` and the mute switch keep their meanings |

`rejected` is final for that phone (one club per phone). Kemal can reopen from the
page (`rejected` to `draft`) if he changes his mind.

### 4.2 The connect request (`ClubConnect.status`)

| From | Event | To |
|---|---|---|
| (none) | Organiser taps the button | `issued` (any older live row for the club becomes `superseded`) |
| `issued` | DM with the code from the signup phone | `dm_verified` |
| `issued` | DM with the code, phone unresolvable, LID present | `dm_verified` with `dmPhoneMatched=null` (flagged to Kemal) |
| `issued` | DM with the code from a **different** resolved phone | stays `issued`; `lastMismatchAt` set; **no reply** (see 5.3) |
| `issued` or `dm_verified` | Group add matched to it | `group_linked` |
| `issued` | 60 minutes pass | `expired` |
| `dm_verified` | 24 hours pass with no add | `expired` |
| `group_linked` | Kemal decides | `closed` |

An add that matches an `issued` row by phone (the organiser skipped the DM) is
accepted: the DM exists to prove the WhatsApp number and to seed the LID, and a
phone-matched add already proves it.

### 4.3 The silence guarantee while not approved

Six layers, each with its own test. Any one of them alone keeps the group silent.

1. **Pi does not listen.** A pending group is not in `/api/whatsapp/orgs`, so
   `isMonitoredGroup` is false and messages are dropped on the Pi.
2. **Pi cannot be talked into listening.** `/orgs` gains `silentGroups` (pending,
   rejected, suspended and unsolicited group ids) and `legacySetupTrigger: false`
   when `SELF_JOIN_ENABLED` is on. The Pi's "@MatchTime setup" pre-filter
   (`index.ts` ~571) returns early for both. Today that trigger would monitor a
   pending group and forward its messages.
3. **Server refuses onboarding.** `handleOnboardingIfApplicable` returns
   `ignored` for any group in `silentGroups` before it creates a session or reaches
   the Haiku call. With the flag on, the legacy trigger is off server-side too.
4. **Server refuses the intro.** `bot-added` never returns `introText` for a
   self-join add or an unsolicited add.
5. **Server gates stay as they are.** `analyze`, `due-posts`, `group-join`,
   `group-leave`, `sync-participants` require `whatsappBotEnabled`, which the check
   constraint forbids for a non-approved club.
6. **Nothing else spends for them.** Crons (`generate-matches`, `generate-teams`,
   `close-ratings`, `extract-squads`, `complete-matches`, `none-bucket-shadow`,
   `bot-health`) skip orgs whose `approvalStatus` is not `approved`, through one
   helper `isClubOperational(org)` = approved and not dormant. In `dm-reply`, a
   sender whose only memberships are non-approved clubs is handled by the
   deterministic connect handler and nothing else, so an organiser chatting to
   MatchTime before approval can never reach `dm-intent` or `dm-qa` (both call
   models).

---

## 5. The organiser's journey, step by step

### 5.1 Sign up and create the club

Unchanged pages, two additions behind the flag:

- `createOrganisation` refuses a second self-join club for a phone that already
  owns a `draft`, `pending`, `approved` or `rejected` self-join club. Superadmins
  are exempt. Message: "You already have a club on MatchTime. Open it from your
  profile." (and Turkish).
- New clubs start in `draft`, with a language picker (English, Türkçe), defaulting
  from the browser. `detectGroupLang` at add time is shown to Kemal as a hint and
  never overrides the organiser's pick.

### 5.2 The button

On the club's admin home, only for its OWNER, only in `draft`:

- **Add MatchTime to WhatsApp** issues a `ClubConnect` and renders
  `https://wa.me/<number>?text=<prefilled>`.
- The number comes from a **server-only** env var, `MATCHTIME_WA_NUMBER` (never
  `NEXT_PUBLIC_`), so it is not in any JS bundle, public page or sitemap. A
  Playwright test fetches every public route signed out and asserts the digits
  never appear.
- Prefilled text:
  - English: `Connect Riverside FC, code 7KQ2`
  - Turkish: `Riverside FC'yi bağla, kod 7KQ2`
- The server parser reads only the code (`/(?:code|kod)\W*([A-HJ-KM-NP-Z2-9]{4})/i`),
  so an organiser who edits the text still gets through.

Below the button, a status card (English and Turkish) that the page polls:

| State | Card text (English) |
|---|---|
| issued | Step 1: send the message that opens in WhatsApp. This code works for 60 minutes. |
| issued, wrong number seen | We got your code from +44 77** ***123. Please send it from +44 7700 900123, the number you signed up with. |
| dm_verified | Step 2: add MatchTime to your football group. Save the number as a contact called MatchTime, then Add participant in the group. |
| pending | Step 3: we're checking your group, usually within a day. MatchTime stays quiet in the group until then. |
| pending, adder not you | MatchTime was added to "{group}" by someone else. We'll check it before switching on. |
| approved | You're live. MatchTime said hello in "{group}". |
| rejected | We can't take this group on right now. |
| expired | That code expired. Tap the button again for a new one. |
| site cap reached | We're taking on a few new groups each day. Please try again tomorrow. |

### 5.3 The connect DM

Handled at the **top** of `dm-reply`, deterministic, before bench confirmation and
before any model path. The Pi forwards one new field, `senderLid`.

| Case | What MatchTime does |
|---|---|
| Code found, `issued`, phone matches | `dm_verified`; reply (5.4) |
| Code found, phone unresolved, LID present | `dm_verified`, bound to the LID, flagged for Kemal; reply. Possession of the code already means the sender had the organiser's signed-in page. |
| Code found, **different** resolved phone | **No reply.** The organiser's page shows the masked number instead. MatchTime never messages a number that is not a verified signup or a member of one of its groups. |
| Code expired or superseded, phone matches a signup | One reply: "That code has expired. Open your club on matchtime.ai and tap Add MatchTime to WhatsApp again." |
| Code already `dm_verified`, same sender | One reply: "You're already connected. Now just add me to your group." |
| Unknown code, or no code | Silence, falls through to the existing DM handling |
| Same `waMessageId` forwarded twice | Idempotent through `dmWaMessageId` |

Replies are queued as `PlatformJob` DMs (purpose `connect-reply`), so they go through
the scheduler's one-DM-per-60s pacing like every other DM.

### 5.4 DM texts to the organiser (English and Turkish, through `src/lib/i18n`)

**After the connect DM**

> EN: Hi {name}, got it: {club} is connected to this chat.
> Next, add me to your football group. Save this number as a contact called MatchTime first, then open the group, tap Add participant and pick MatchTime.
> I'll stay quiet in the group until we've switched it on for you, usually within a day.

> TR: Merhaba {name}, tamamdır: {club} bu sohbete bağlandı.
> Sıradaki adım: beni futbol grubunuza ekleyin. Önce bu numarayı MatchTime adıyla rehberinize kaydedin, sonra grubu açıp Katılımcı ekle'ye dokunun ve MatchTime'ı seçin.
> Sizin için açana kadar grupta sessiz kalacağım, genellikle bir gün içinde.

**After a matched add**

> EN: Thanks, I'm in "{group}". I'll stay quiet there until we switch you on, and I'll message you here when it's done.
> TR: Teşekkürler, "{group}" grubuna katıldım. Sizi açana kadar orada sessiz kalacağım, bitince size buradan yazacağım.

**Approved**

> EN: Good news: {club} is live. I've said hello in "{group}". You can set or change your weekly game here: {link}
> TR: Güzel haber: {club} artık aktif. "{group}" grubunda herkese merhaba dedim. Haftalık maçınızı buradan ayarlayabilir ya da değiştirebilirsiniz: {link}

**Rejected (recommended, see decision 1)**

> EN: Thanks for trying MatchTime. We can't take "{group}" on right now, so I've left the group. We'll be in touch if that changes.
> TR: MatchTime'ı denediğiniz için teşekkürler. "{group}" grubunu şu an alamıyoruz, bu yüzden gruptan ayrıldım. Bu değişirse size haber vereceğiz.

### 5.5 The group add

`bot-added` gains a self-join branch that runs **before** the existing autostart
logic when `SELF_JOIN_ENABLED` is on:

1. A live (approved, bot-enabled) org already owns this group: ignore, as today.
2. A `ClubConnect` matches by the rule in 2.3: store subject, member count,
   snapshot, adder fields, detected language; set the club `pending`; queue the
   owner DM once (`ownerDmQueuedAt`); queue the organiser's ack if matched.
   **No `introText`.** A re-add of the same group is idempotent: no second owner DM.
3. Nothing matches: record unsolicited (5.6). **No `introText`.**

The Pi still adds nothing to its monitored set, because nothing comes back to post.

### 5.6 Unsolicited adds (someone adds MatchTime with no code)

Recorded as a `ClubConnect` with no org (`orgId` nullable is avoided by using a
small separate table, `UnsolicitedGroup {groupId, subject, memberCount,
addedByPhone, addedByLid, addedAt, leftAt}`). Silent. Listed on `/admin/clubs` with a
**Leave** button. Recommended: auto-leave after 48 hours (decision 3). No DM to
anyone, including Kemal.

### 5.7 Removed while pending

The Pi forwards a self-removal for any group in `silentGroups` to a new
`POST /api/whatsapp/bot-removed`. The club goes back to `draft`, the organiser's
card offers the button again, Kemal's pending item shows "removed". No DMs.

---

## 6. Kemal's side

### 6.1 The approval DM

Queued as `PlatformJob` (purpose `owner-approval`) to every phone in a new env var
`SELF_JOIN_APPROVER_PHONES` (Kemal's only). English only: it is owner-facing copy,
not player-facing, so the i18n rule does not apply. Held until 08:00 London if it
would land between 22:00 and 08:00 (`sendAfter`), because nothing about a waiting
group is urgent.

> New club waiting: **Riverside FC** (ref 7KQ2)
> Organiser: Ali Demir, +44 7700 900123 (phone verified at sign-up)
> Added by: the organiser (matched by phone)
> Group: "Riverside Tuesday 5s", 18 members, looks Turkish (club chose Türkçe)
> Also in your other clubs: 3 members play at Sutton FC
> Reply APPROVE 7KQ2 or REJECT 7KQ2, or use matchtime.ai/admin/clubs

The "Added by" line is one of: "the organiser (matched by phone)", "the organiser
(matched by WhatsApp id)", "someone else; the organiser IS in the group",
"unknown; the organiser IS / IS NOT in the group", "someone else; the organiser is
NOT in the group". If the connect DM phone was unresolved it adds "(organiser's
WhatsApp number not confirmed)".

### 6.2 Kemal's reply

Handled first in `dm-reply`, before every other branch and before any model, and
only when the resolved sender phone is in `SELF_JOIN_APPROVER_PHONES`. A message
from any other number, including a LID-only sender whose phone cannot be resolved,
never reaches this handler (logged; the owner page is the fallback).

Grammar (case-insensitive, deterministic): `APPROVE <ref>`, `REJECT <ref>`. A bare
`APPROVE` or `REJECT` is accepted only when exactly one club is pending.

| Input | Reply to Kemal |
|---|---|
| APPROVE 7KQ2 | Approved Riverside FC. The hello goes out in the group within a few minutes. |
| REJECT 7KQ2 | Rejected Riverside FC. Leaving the group now. |
| bare APPROVE, two pending | Two clubs are waiting: 7KQ2 Riverside FC, 9XT4 Hackney Weds. Reply APPROVE and the ref. |
| unknown ref | No club waiting with ref 7KQ2. Waiting now: 9XT4 Hackney Weds. |
| already decided | Riverside FC was already approved on 28 Sept at 19:04. |

Every decision, DM or page, goes through one function, `decideClub(orgId, decision,
decidedBy)` in `src/lib/club-approval.ts`, inside one transaction with a
compare-and-set on `approvalStatus = 'pending'`, so a DM and a button press at the
same moment cannot both act.

**Approve does, in order:**

1. Refuse if another approved org already has this `groupId`.
2. `whatsappGroupId = groupId`, `language` = the organiser's pick,
   `approvalStatus = approved`, `approvedAt = now`, `whatsappBotEnabled = true`.
3. `importParticipants(orgId, snapshot)` (`src/lib/participant-sync.ts`), so the
   roster is there before the first IN.
4. Queue the group hello as a normal `BotJob kind:"group"` for the org. The Pi
   picks the group up on its next org refresh (a few minutes), starts polling
   `due-posts`, and posts it.
5. Queue the organiser's "approved" DM (`PlatformJob`).
6. Queue Kemal's one-line ack.

**Reject does:** status `rejected`, `PlatformJob kind:"leave-group"`, organiser DM
(if decision 1 says so), Kemal's ack.

### 6.3 The group hello (English and Turkish, `src/lib/i18n`)

> EN: 👋 Hi everyone, I'm *MatchTime*. {organiser} has set me up to run this group's games.
> Playing? Just write *IN*. Can't make it? Write *OUT*. I'll tick your message and keep the squad list up to date.
> Anything else, tag me: *@Match Time help*

> TR: 👋 Herkese merhaba, ben *MatchTime*. {organiser} beni bu grubun maçlarını düzenlemem için kurdu.
> Oynuyor musun? *VARIM* yazman yeterli. Gelemiyorsan *YOKUM* yaz. Mesajına ✅ koyar, kadro listesini güncel tutarım.
> Başka bir şey için beni etiketle: *@Match Time yardım*

VARIM and YOKUM are exactly what the floor recognises (`FLOOR_IN_TR`,
`FLOOR_OUT_TR` in `router.ts`), and "@Match Time yardım" is the existing help
trigger (`strings.tr.ts` ~810). If no weekly game is set yet (decision 2), the hello
still goes out and the IN/OUT line waits for the first match: the organiser's
"approved" DM links to the game setup page.

### 6.4 The owner page, `/admin/clubs`

Superadmin only (`isSuperadmin`, the same gate as `/admin/organisations`). Sections:

1. **Waiting for you**: each pending club with everything in the DM, plus the
   snapshot's member list (names, masked phones), **Approve** and **Reject**.
2. **New clubs (first 4 weeks)**: approved date, group posts today, DMs today
   against 20, today's AI spend and cap hits (read from `feat/ai-daily-cap`'s
   usage table), **Turn off** (suspend: leave the group, go silent).
3. **Pending clubs, AI spend**: must always read $0.00. Any non-zero value is a
   bug in the silence rails and is shown in red (section 9).
4. **Unsolicited groups**: subject, when, by whom, **Leave**.
5. **Today's site limits**: sign-up codes 7 of 20, links 1 of 5, and so on.

**Overlap with `feat/health-to-dashboard`.** That branch is building the owner
health dashboard and moving routine alerts off WhatsApp and email. Coordination:

- AI cap hits belong to that dashboard and to `feat/ai-daily-cap`, never to a DM.
  `/admin/clubs` only reads their data; it does not record cap hits itself.
- The approval DM stays a real WhatsApp DM. It goes through a new, named helper,
  `queueOwnerDm(text, purpose, refId)` in `src/lib/owner-dm.ts`, on `PlatformJob`.
  **That branch must not remove `PlatformJob` or `owner-dm.ts`**, and should not
  route health alerts through `queueOwnerDm` (that would bring back the noise it is
  removing). I will say this on both PRs.
- That branch changes `src/app/api/cron/bot-health/route.ts`; this plan only adds an
  `isClubOperational` skip there, so the conflict is one line.

---

## 7. Abuse controls

| # | Control | Number | Where enforced | What the person sees |
|---|---|---|---|---|
| 1 | Clubs per verified phone | 1 (superadmins exempt) | `createOrganisation` | "You already have a club on MatchTime." |
| 2 | Sign-up code DMs, whole site | 20 a day (plus today's 3 per phone per hour) | `startPhoneSignup` | "We're busy right now, please try again tomorrow." |
| 3 | Sign-up attempts per IP | 5 an hour | `startPhoneSignup` (header `x-forwarded-for`) | same |
| 4 | New self-join clubs, whole site | 10 a day | `createOrganisation` in self-join mode | "We're taking on a few new clubs each day." |
| 5 | Connect codes per club | 1 live, 60 min, 3 a day | button action | "Try again in a bit." |
| 6 | New groups linked, whole site | 5 a day, counted at the connect DM | connect handler | The card shows the site-cap message; no WhatsApp reply beyond one line saying the same |
| 7 | AI spend per group | $0 while not approved; then $1/day, $0.25/day for 28 days after approval | silence rails (4.3) plus `feat/ai-daily-cap` | section 9 |
| 8 | DMs to members, new club | 20 a day for 28 days | `due-posts` DM selection | held until tomorrow, logged |
| 9 | Group posts | existing 40 an hour ceiling and repetition guard | `due-posts` | unchanged |
| 10 | Off switch | per club | `/admin/clubs` | group: nothing (MatchTime leaves) |
| 11 | Unsolicited groups | never post; auto-leave 48h (recommended) | Pi + server | nothing |
| 12 | Who MatchTime can message | only members of an approved club's group, verified signups, and approver phones | `PlatformJob` and `BotJob` creation check | n/a |

Rule 12 has one standing exception: the sign-up code itself goes to a number that
is not verified yet, because that is how it gets verified. Rules 2 and 3 are its
cap. (A later option is inbound-first verification, where the person sends a code
to MatchTime rather than receiving one; not in this plan.)

Why these numbers: WhatsApp restricted the MatchTime number for 21 hours after
about 56 DMs in quick succession (`scheduler.ts`). The daily totals above keep new
activity to a small fraction of that per day, and the existing 60-second DM gap
still applies on top. The bot joining groups is not itself a send, but a burst of
new groups followed by hellos is the pattern to avoid, hence 5 links a day.

---

## 8. Failure modes

| What goes wrong | What the organiser sees | What Kemal sees | Recovery |
|---|---|---|---|
| Code expired before sending | Card: expired, button again | nothing | new code |
| Sent from a different phone | Card: masked number and the right number | nothing | send from the right phone |
| Organiser's phone unreadable at the DM | Normal reply; card moves on | "number not confirmed" in the DM | Kemal decides |
| Can't add MatchTime (not a contact) | DM already tells them to save the contact first | nothing | as told |
| MatchTime's account blocks group adds (privacy) and WhatsApp sends an invite link instead | Card stays at Step 2 | nothing | **Pre-flight check**: the linked phone's "Who can add me to groups" must be Everyone. Accepting invites is a possible later slice (5b), only from a DM-verified organiser. |
| Pi offline at the moment of the add | Card stays at Step 2 | nothing | **Reconnect sweep**: after reconnect the Pi lists groups (`listGroups`), sends any it is in that the server does not know to `bot-added` with `discovered: true`; the same matching applies |
| Adder is someone else | Card: "added by someone else, we'll check" | labelled line in the DM | Kemal decides |
| Adder unknown | Card: Step 3 | "Added by: unknown; organiser IS / IS NOT in the group" | Kemal decides |
| MatchTime removed while pending | Card: button again | "removed" on the page | re-run |
| Kemal's reply unresolvable (LID only) | nothing | no ack in WhatsApp | use `/admin/clubs`; logged |
| Approval, but Pi slow to refresh | Hello a few minutes late | ack says "within a few minutes" | automatic |
| Group already owned by another approved club | n/a | approve refused with the reason | Kemal resolves |
| Site cap reached | Card: "try again tomorrow" | today's limits panel | automatic next day |
| Pending for days | Card: Step 3 | item stays on the page, oldest first | decision 8 |

---

## 9. AI spend: the dependency on `feat/ai-daily-cap`, and what approval adds

The per-group daily dollar cap is **built separately on `feat/ai-daily-cap`** and
is a dependency of this plan, not part of it. As briefed, that branch provides: a
hard cap on real `usage.costUsd` (`costOf()` in `src/lib/pipeline/llm.ts`) of
**$1.00 a day per group forever** and **$0.25 a day in a club's first 4 weeks**; a
usage table per org per London day; plain IN and OUT kept working through the
deterministic floor (`routeFloor`) with no model call; one polite line to a tagged
question at most once a day; everything else waiting until tomorrow; cap hits shown
on the owner dashboard, never DMed.

One fact from the code that branch has to handle, noted here so it is not missed:
today `routeFloor` skips only the **router** call. A floor-routed bare IN still goes
to the Sonnet extractor (`pipeline/run.ts` stage 2,
`attendance-engine-batch.ts` ~584). "IN works with no model call when capped"
therefore needs a deterministic extraction for floor hits on that branch.

### What the approval flow adds on top (and only this)

1. **Not approved means zero model calls, whatever the cap says.** A draft,
   pending, rejected or suspended club never reaches a model. This is enforced by
   the silence rails in 4.3, not by the cap: the cap allows up to $0.25 a day,
   which is $0.25 too much for a group Kemal has not approved. The rails keep the
   request from arriving at all (Pi does not listen, server refuses onboarding,
   `analyze` requires `whatsappBotEnabled`, crons skip, `dm-reply` routes the
   organiser to the deterministic connect handler only). Defence in depth: the cap's
   "can this org spend?" check also returns **false** for any org whose
   `approvalStatus` is not `approved`, so a future path that forgets the rails
   still spends nothing. A test asserts both.
2. **The 4-week clock starts at approval.** For a self-join club the new-club
   allowance runs from `Organisation.approvedAt`, not from `createdAt`: a club that
   waited a week in `pending` still gets its full four weeks at $0.25 once live.
   The rule for that branch is `approvedAt ?? createdAt`, which leaves every
   existing club (null `approvedAt`) exactly as that branch designs it. If that
   branch lands first with `createdAt`, slice 7 of this plan changes the one line.
3. **Pending spend is visible.** `/admin/clubs` shows each pending club's AI spend
   from that branch's usage table, which must read $0.00; anything else is shown in
   red as a rails bug.
4. **The cap reply is not a greeting.** A group's first message from MatchTime must
   be the approval hello. Because pending groups make no calls and send nothing, the
   cap's polite line can never be the first thing a new group hears; slice 7's
   simulator test pins this.

Nothing else about the cap is designed here.

## 10. Test plan (free suites only)

**No prompt changes anywhere in this plan.** The connect parser and the approval
parser are deterministic; the new copy is static i18n strings. So
**no live-LLM suite or dry run is needed or requested**. Unit (vitest) and Playwright
suites run on every slice, as TDD, red first.

### 10.1 Unit (vitest), server

- `club-approval.ts`: every transition in 4.1 and 4.2 as a pure `nextState`
  function; illegal transitions refused; the compare-and-set race (two decisions,
  one wins).
- Check constraint: a migration test that `whatsappBotEnabled = true` with
  `approvalStatus = 'pending'` is rejected by Postgres.
- Source guard: only `club-approval.ts` writes `approvalStatus`.
- Connect parser: English and Turkish prefilled texts, edited texts, lowercase,
  missing code, lookalike characters.
- Adder matching (2.3): all five `adderMatch` outcomes, and the "exactly one
  candidate" rule.
- `dm-reply`: connect cases in 5.3; approver cases in 6.2; a non-approver sending
  "APPROVE 7KQ2" is ignored; an organiser of a draft club never reaches `dm-intent`
  or `dm-qa` (the Anthropic client mock is asserted to have **zero calls**).
- Silence layers 2 to 6 in 4.3: for a pending group, `orgs` lists it in
  `silentGroups`, `analyze` returns ignored with zero model calls, `bot-added`
  returns no intro, `due-posts` 404s, each cron skips it.
- Sutton unchanged: an org with the defaults (`approved`, `approvedAt` null)
  passes every gate exactly as before; the existing copy-golden tests stay green.
- Caps: each number in section 7 at its limit and one over.
- AI, on top of `feat/ai-daily-cap`'s own tests: the "can this org spend?" check is
  false for draft, pending, rejected and suspended orgs even with $0 spent today;
  the new-club window starts at `approvedAt` when set and at `createdAt` otherwise.
- i18n: every new player-facing string exists in `strings.en.ts` and
  `strings.tr.ts` (the existing parity test covers this once they are added).

### 10.2 Unit (vitest), Pi

- `bot-added.ts`: self-join responses never post; `addedByLid` forwarded;
  post-snapshot re-resolve fills the phone.
- `drivers/baileys.ts`: new `leaveGroup` against `baileys/fake-socket.ts`
  (`groupLeave`); the source test still bans directory lookups and now also covers
  the new files.
- Setup trigger: ignored for `silentGroups` and when `legacySetupTrigger` is false.
- `PlatformJob` poller: claim, send, ack; shares `DM_GAP_MS` with the org DMs;
  `leave-group` executes once; a failed send is released, not acked.
- DM branch forwards `senderLid`.
- Self-removal from a silent group is forwarded to `bot-removed`.

### 10.3 Playwright (web, free)

- Organiser: sign up (code read from the test DB, as existing helpers do), create a
  club, see the button, the `wa.me` link carries the code and the server-only
  number; card moves through each state as the test drives the API with
  `WHATSAPP_API_KEY` (connect DM, add, approve).
- Second club for the same phone is refused.
- Signed out, no public page contains the WhatsApp number digits.
- `/admin/clubs`: superadmin sees pending, approves and rejects; a non-superadmin
  gets redirected; pending clubs' AI spend reads $0.00.
- Group simulator (`e2e/sim`, stubbed model): a pending group produces zero
  outbound messages and zero model calls; after approval the hello is the first
  message, before any cap line could be.

---

## 11. Rollout

1. **Flags, off by default:** `SELF_JOIN_ENABLED` (server). The Pi reads `legacySetupTrigger` and
   `silentGroups` from `/orgs`, so the Pi needs no flag of its own.
2. **Slice by slice to production dark.** Each slice keeps Sutton byte-identical
   (unit, e2e, copy-golden). Pi changes deploy with `scripts/deploy-pi.sh`, never a
   bare restart.
3. **`feat/ai-daily-cap` live and enforcing** (its own rollout), with the
   `approvedAt` rule from section 9.
4. **Pre-flight on the MatchTime phone:** Settings, Privacy, Groups: "Everyone".
   `SELF_JOIN_APPROVER_PHONES` set to Kemal's number. `MATCHTIME_WA_NUMBER` set.
   `ONBOARDING_AUTOSTART` switched **off** (decision 4).
5. **Throwaway test.** A second WhatsApp number (not Kemal's, decision 7) signs up,
   creates "MT Test Club", connects, creates a new group with two people and adds
   MatchTime. Check: the silence (send IN, a question, "@MatchTime setup": nothing,
   and the Anthropic console shows no calls from that group); the DM to Kemal; the
   Phase 0 measurements in 2.4; APPROVE by DM; the hello; IN ticks. Then REJECT on a
   second throwaway group and confirm MatchTime leaves. Then suspend the first.
6. **First real organiser**, one only, with Kemal watching the owner page.
7. Review the numbers in section 7 after two weeks.

Rollback: `SELF_JOIN_ENABLED` off stops new drafts, buttons and links at once;
pending clubs stay silent by construction.

---

## 12. Slices (one PR each, in order)

| # | PR | Depends on | Main files |
|---|---|---|---|
| 1 | **Schema and silence rails.** `approvalStatus` and friends, check constraint, `ClubConnect`, `UnsolicitedGroup`, `isClubOperational`, `silentGroups` and `legacySetupTrigger` in `/orgs`, Pi honours them, onboarding and `bot-added` refuse silent groups, crons skip non-approved. No visible change. | none | `prisma/`, `src/lib/club-approval.ts`, `api/whatsapp/orgs`, `analyze` (onboarding gate only), `bot-added`, crons, `whatsapp-bot/src/index.ts` |
| (2) | **Not in this plan: `feat/ai-daily-cap`**, built separately. This plan needs from it only the two rules in section 9 (non-approved spends nothing; window from `approvedAt ?? createdAt`). If it merges first, slice 1 adds the first rule and slice 7 the second. | none | owned by that branch |
| 3 | **Platform channel.** `PlatformJob`, `GET /api/whatsapp/platform-jobs` and ack, Pi poller in the scheduler tick, `leaveGroup` on `WaDriver` (Baileys `groupLeave`; whatsapp-web.js implements or refuses), `queueOwnerDm`, `queuePlatformDm`, sign-up codes moved off the borrowed org, site caps 2 and 3. | 1 | `src/lib/owner-dm.ts`, `scheduler.ts`, `driver.ts`, `drivers/baileys.ts`, `phone-signup.ts` |
| 4 | **Organiser web.** Draft clubs, one per phone, language pick, the button, codes, the status card, caps 4 and 5, number stays server-only. | 1 | `create-org`, `actions/org.ts`, new club connect component |
| 5 | **Connect DM.** Pi forwards `senderLid`; deterministic handler at the top of `dm-reply`; replies via `PlatformJob`; cap 6. | 3, 4 | `dm-reply`, `whatsapp-bot/src/index.ts` |
| 6 | **Group add linking.** Self-join branch in `bot-added`, `addedByLid` and the re-resolve, pending, Kemal's DM, organiser ack, unsolicited, `bot-removed`, reconnect sweep. | 3, 5 | `bot-added` (both sides), new `bot-removed` |
| 7 | **Decisions.** APPROVE and REJECT by DM, `decideClub`, `/admin/clubs`, roster import, hello (EN and TR), organiser DMs, leave, suspend, cap 8. | 6 | `club-approval.ts`, `dm-reply`, `/admin/clubs` |

Slices 3 and 4 can run in parallel after 1. `feat/ai-daily-cap` and slice 1 both
touch `analyze/route.ts`; whichever merges second rebases (slice 1 only touches the
onboarding gate near line 3730, the cap branch the pipeline path).

Real groups only after slice 7 **and** `feat/ai-daily-cap` enforcing.

---

## 13. Decisions needed from Kemal

1. **On reject, what does the organiser hear?** Recommend: MatchTime leaves the
   group silently, and the organiser (a verified signup) gets one polite DM (5.4).
   The alternative, one line in the group before leaving, speaks to people who never
   asked for MatchTime.
2. **When is the weekly game set up?** Recommend: on the website, as part of
   creating the club (day, time, venue, players per side), before the button appears,
   so the hello lands on a group that already has its next match. The alternative is
   the existing in-group question flow, which is unused and calls a model.
3. **Unsolicited adds** (no code): recommend silent, listed on the owner page,
   auto-leave after 48 hours. Alternative: stay until you press Leave.
4. **Retire the in-group self-setup** (`ONBOARDING_AUTOSTART` and the
   "@MatchTime setup" trigger) while self-join is on? Recommend yes: flag off, code
   kept. It has never fired, and it is the only path by which an unapproved group
   could reach a model.
5. **The new-club AI window starts at approval** (`approvedAt`), not at sign-up.
   Recommend yes, so a club that waited in pending still gets its full four weeks.
   This is the one rule this plan asks `feat/ai-daily-cap` to adopt.
6. **Site limits** in section 7 (20 sign-up codes, 10 new clubs, 5 links a day,
   20 member DMs a day for new clubs). Confirm or adjust.
7. **Test organiser number**: a second WhatsApp number that is not yours, so the
   organiser and the approver are different people in the test.
8. **Pending too long**: recommend no automatic action, just oldest-first on the
   page. Alternative: auto-reject after 14 days with the polite DM.
