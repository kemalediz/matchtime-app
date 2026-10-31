# Friend link: design plan (2026-10-31)

Status: PHASE 1, plan only. No production code written. For the engineering
manager's review before the build.

Worktree: `/Users/kemal/Projects/Cressoft/Sports/mt-friend-link`, branch
`feat/friend-link` from `origin/main` at `611b2350`.

Cost of writing this plan: **$0**. No model calls, no paid APIs.

---

## 0. Kemal's build rules, baked in

1. **Prompts.** No prompt changes in this plan (section 9 says why). If the
   build finds a prompt has to change after all, the builder reads the whole
   prompt and rewrites it as a whole. A small additive patch is only allowed
   when it is tiny and cannot change or conflict with any other behaviour,
   and the builder must say which of the two applies and why before touching it.
2. **TDD in every slice, red first.** Every slice below lists the tests to
   write first. They must be run and seen failing for the right reason before
   any implementation.
3. **Sandboxed WhatsApp scenarios (`e2e/sim`) for every scenario Kemal
   listed:** named friend, unnamed friend, friend signs up and is booked,
   match full so bench, link after kick-off, organiser removes him (by tag
   too), friend already a pool member, monthly club PAYG and weekly club fee,
   duplicate code delivery, cancelled match. Section 7 maps each to a slice
   and a spec file; nothing on that list is left to a unit test alone.
4. **Run the relevant tests around the area changed**: each slice names the
   neighbouring suites to re-run (guest-name-ask, third-party-offer, pool
   confirm, pool offers, partner guests, monthly week, payments).
5. **Modular code: pure rules plus thin adapters, no duplication.** The
   modules are named in section 2. Every decision is a pure function in a
   `*-rules.ts` file with no Prisma; the I/O files only load facts, call the
   rule and write. The one guest writer (`placePoolGuest`) is generalised,
   not copied.

---

## 1. How it works end to end

### 1.1 Today (traced in code)

- `src/lib/pipeline/engine.ts` ~1338-1428: a third-party claim. A `named`
  person not on the roster with polarity `in` becomes a `Target` with
  `provisional: true` (engine.ts 1414-1420); `applyClaim` (engine.ts ~3903)
  turns it into `userId = "new:<name>"`, and `applyEngineWrites`
  (`src/lib/attendance-engine.ts`, `PROVISIONAL_PREFIX`) creates the User
  and Membership. The row moved was not the sender's, so
  `movedSomeoneElsesRow = true` and the batch posts one `squad_status`
  (engine.ts ~3672). The message gets 👍 (`reactFor`, engine.ts 3853).
- An unnamed person (`personKind` relation or placeholder) with polarity `in`
  goes into `guestAsks` (engine.ts 1361-1381), and `shouldAskForGuestName`
  (`src/lib/guest-name-ask.ts`) may push a `guest_name_ask` speech act
  ("What's their name?"), claimed once per player per match in
  `attendance-engine-batch.ts` stage 3a (~1081).
- An IN is tag-free for everyone (engine.ts ~1197), so both happen untagged.

### 1.2 New behaviour

```
players' group: "my friend Ali is in" / "+1" / "my brother can play"
        |
   router + extractor  (UNCHANGED: subject "other", personKind, polarity "in")
        |
   engine.ts third-party branch
        |-- friend-link-rules.decideThirdPartyIn()  (pure)
        |      -> "friend_link"  (non-admin sender, unknown named OR unnamed)
        |      -> "provision" / "name_ask"  (organisers: today's behaviour, see D1)
        |
   MessageOutcome.friendLinks = [{ friendName | null }]   (no recipient field)
   no target, no write, no squad_status, no guest_name_ask
        |
   attendance-engine-batch.ts new stage 3a'': deps.issueFriendLinks()
        |      friend-link/issue.ts: FriendLink row(s) (idempotent on
        |      message id + claim index), cap check, ONE DM to the SENDER
        |      (club BotJob "dm", REPLY_PRIORITY)
        |-- queued  -> react ✉️ on the message
        |-- not queued (no phone, cap, no match) -> see 4.6
        |
   friend opens  matchtime.ai/play/f/<linkId>.<sig>
        |      friend-link/page.ts -> /play form + match card + name prefilled
        |      POST /api/play/signup { ...fields, friendToken }
        |      -> createPoolSignup(..., friendLinkId)  pending-verify row
        |
   friend sends "...code K7QP2" to MatchTime (platform number)
        |      /api/whatsapp/dm-reply -> handlePoolConfirmDm (confirm.ts)
        |      decidePoolConfirm: new branch for a friend-link row
        |
   friend-link/book.ts  bookFriend()
        |      claim the link (compare-and-set, unique usedMessageId)
        |      placeGuestOnMatch()  (generalised placePoolGuest, per-match lock)
        |      -> CONFIRMED or BENCH, GuestPlace (source pool, friendLinkId)
        |
        |-- players' group: "Ali Y. (Shane's friend) is in for Monday 2 Nov"
        |      (SentNotification once, quiet hours)
        |-- friend DM (platform channel): you are in / on the bench, fee, settings
        |
   later: organiser removes him (match page, tagged group msg, tagged HQ)
        -> cancelAttendance (actor admin) -> tellGuestTakenOffByAdmin
        -> guestVia "pool" -> pool/removal.ts -> friend copy when the
           GuestPlace has a friendLinkId
```

### 1.3 Who the rule applies to

The rule sits in the engine, so it is one architecture for every place
`decide()` reads attendance (players' group, and a member's DM if a
third-party IN reaches the engine there; HQ only has organisers, who keep
today's behaviour, see D1). The answer gate in `analyze/route.ts` (~2282) and
`interaction-contract.ts messageAddressesBot` are NOT touched.

A friend link is decided when ALL hold (pure, `friend-link-rules.ts`):

- claim `subject: "other"`, `polarity: "in"` (bench-asked claims too: the
  friend still goes through the link; capacity decides on booking);
- tense not past or hypothetical (already filtered above the branch);
- `personKind` is `relation` or `placeholder`, OR `named` and
  `resolvePerson` says `unknown` and `refWrittenIn(personRef, body)` (the
  existing verifier). `group` ("everyone") never;
- sender resolved (`msg.senderUserId`), and NOT an owner or admin (D1);
- `state.features.attendance` on and `state.matchId` set;
- contingent claims ("my brother can play if needed") also get a link (D4).

A named person who IS on the roster is unchanged (ordinary third-party IN).
A raw-digits mention keeps `ask_who_mentioned`.

---

## 2. Modules: what is added, changed and reused

### New (pure rules, no Prisma)

| File | What |
|---|---|
| `src/lib/friend-link/rules.ts` | `decideThirdPartyIn(facts)` -> `friend_link` / `provision` / `name_ask` / `none` with a reason; `FRIEND_LINK` constants (open links per member per match: 3); `friendLinkState({ usedAt, revokedAt, matchStatus, isHistorical, kickoff, now })` -> `open` / `used` / `started` / `called-off` / `invalid`; `friendBookingRefusal({ isIssuer, alreadyOnMatch, clubBlocked, pausedReason, guestElsewhere })`; `friendConfirmBranch(...)` (the confirm decision for a friend-link row, called from `decidePoolConfirm`); `friendCodeExpiry(now, kickoff)` = min(3 days, kick-off). |
| `src/lib/friend-link/token.ts` | `friendLinkToken(id)`, `friendLinkPath(id)`, `friendLinkIdFromToken(token)`, all on `poolSignature("friend-link", id)` from `pool/offer-token.ts` (no new secret, purpose keeps it from passing as an offer token). |
| `src/lib/i18n/friend-link.en.ts`, `.tr.ts`, `friend-link.ts` | Every string in section 4, typed table like `pool-safety.*`. |
| `src/lib/i18n/tr-genitive.ts` | `trGenitive("Shane")` -> `Shane'in` (vowel harmony, consonant/vowel ending), next to the existing `tr-locative.ts`. Needed for "Shane'in arkadaşı". |

### New (thin adapters)

| File | What |
|---|---|
| `src/lib/friend-link/issue.ts` | `issueFriendLinks({ orgId, matchId, sender, messageId, friends[], lang })`: upsert `FriendLink` rows on `(sourceMessageId, claimIndex)`, apply the cap, queue ONE `BotJob` DM to the sender. Returns `{ queued, reason }`. Shape copied from `stats-link-request.ts`: no recipient parameter. |
| `src/lib/friend-link/page.ts` | `loadFriendLinkPage(linkId, now)`: link state, `loadMatchOfferFacts` (club, kickoff, venue, fee incl. monthly PAYG), the issuer's first name, prefill name, language. |
| `src/lib/friend-link/book.ts` | `bookFriend({ linkId, userId, waMessageId, now })`: claim the link, refusal rule, `placeGuestOnMatch`, group notice, friend DM. Never throws. |
| `src/app/play/f/[token]/page.tsx` | The /play form with the match card (reuses `PlaySignup`). |

### Changed

| File | Change |
|---|---|
| `src/lib/pipeline/types.ts` | `MessageOutcome.friendLinks?: Array<{ claimIndex: number; friendName: string \| null }>`. |
| `src/lib/pipeline/engine.ts` | Third-party branch calls `decideThirdPartyIn`; on `friend_link` pushes to `out.friendLinks`, a reason line, `disposition "acted"`, `continue` (no target, no guest ask). Not a terminal branch for the message: other claims in it (the sender's own IN) still run. |
| `src/lib/attendance-engine-batch.ts` | New stage after 3a: for owned messages with `friendLinks`, `deps.issueFriendLinks`; react ✉️ only when queued; `intent` "friend_link". `EngineMessageOutcome.react` carries it. |
| `src/lib/owner-deps.ts` | Wires `issueFriendLinks` to `friend-link/issue.ts`. |
| `src/lib/partner-guest.ts` | `placePoolGuest` becomes `placeGuestOnMatch(w)` with `ref: { kind: "offer"; offerId; fill } \| { kind: "friend"; linkId }`; `placePoolGuest` stays as a one-line wrapper so `pool/accept.ts` is untouched. Friend: same per-match lock (`xask-fill:<matchId>`), no round fill check, `registerAttendance` decides CONFIRMED or BENCH. GuestPlace written with `friendLinkId`. |
| `src/lib/pool/signup.ts` | `createPoolSignup` takes optional `friendLinkId`; sets `source "friend"`, `referrerUserId` = issuer, code expiry = `friendCodeExpiry`. |
| `src/app/api/play/signup/route.ts` | Reads optional `friendToken`, checks the link is open (`friendLinkState`), passes `friendLinkId`. Same validation, cap and response. |
| `src/lib/pool/confirm-rules.ts` | `decidePoolConfirm` gets `friendLink: boolean` and the sender's profile; for a friend row a sender WITH a profile is `{ action: "friend-existing" }` instead of `already-signed-up`. |
| `src/lib/pool/confirm.ts` | `friend-existing`: book with his existing account, delete the pending row, no new consent unless stopped (D6). `confirm`: after `activatePendingProfile`, `bookFriend`. The welcome DM is replaced by the friend DM for a friend row (one DM, not two). Duplicate check also looks at `FriendLink.usedMessageId`. |
| `src/lib/pool/removal.ts` | When the GuestPlace has `friendLinkId`, the friend copy (section 4.5) instead of `dm_removed`; same once-only rule. |
| `src/lib/platform-jobs.ts` | Purposes `friend-booked`, `friend-not-booked`, `friend-removed`. |
| `src/lib/pool/vocab.ts` | `POOL_PROFILE_SOURCES` + `"friend"`. |
| `src/lib/pool/housekeeping.ts` | Nothing new needed if pending rows already expire by `confirmCodeExpiresAt`; verify in S3. |

### Reused unchanged

`resolvePerson`, `refWrittenIn`, `registerAttendance` (capacity, organiser
pick, monthly week), `cancelAttendance` -> `tellGuestTakenOffByAdmin`,
`tellClubAboutGuest` claim + quiet hours (`message-hours.ts`),
`loadMatchOfferFacts` + `poolFeeOf` + `guestPaygPence` (PR #462),
`shortDisplayName`, `activatePendingProfile`, `recordPoolConsent`,
`buildPoolManageLink`, `queuePlatformDm`, `signup-status-token.ts` (the /play
reminder), payment flow (`payment-flow.ts` charges every CONFIRMED row; the
monthly week marks a non-regular "payg").

---

## 3. Data model

### 3.1 Prisma

```prisma
/// A member vouched for a friend for ONE match (friend link, 2026-10-31).
/// The link names the match; the friend's details arrive only through the
/// /play form and his own WhatsApp code. One per (message, claim).
model FriendLink {
  id              String       @id @default(cuid())
  orgId           String
  org             Organisation @relation(fields: [orgId], references: [id], onDelete: Cascade)
  matchId         String
  match           Match        @relation(fields: [matchId], references: [id], onDelete: Cascade)
  /// The member who said his friend is coming.
  issuedByUserId  String
  issuedBy        User         @relation("FriendLinkIssuer", fields: [issuedByUserId], references: [id], onDelete: Cascade)
  /// The name as written in the message, for the form's prefill. NULL for "+1".
  friendName      String?
  /// The WhatsApp id of the group message, and which claim in it.
  sourceMessageId String
  claimIndex      Int          @default(0)
  /// The DM that carried it (BotJob id).
  botJobId        String?
  /// Set together, once: who used it and with which WhatsApp message.
  usedAt          DateTime?
  usedByUserId    String?
  usedMessageId   String?      @unique
  /// "in" | "bench" | a refusal ("issuer", "already-on-match", "blocked", ...).
  outcome         String?
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt
  profiles        PoolProfile[]
  guestPlace      GuestPlace?

  @@unique([sourceMessageId, claimIndex])
  @@index([matchId, issuedByUserId])
}
```

`PoolProfile.friendLinkId String?` (FK, SetNull, index) and
`GuestPlace.friendLinkId String? @unique` (FK, SetNull). Back relations on
Organisation, Match, User.

No expiry column: the link is open while the match is live and before its
CURRENT kick-off, read at use time, so a moved match moves the expiry.

### 3.2 Migration `prisma/migrations/20261101090000_friend_link/migration.sql`

```sql
CREATE TABLE "FriendLink" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orgId" TEXT NOT NULL REFERENCES "Organisation"("id") ON DELETE CASCADE,
  "matchId" TEXT NOT NULL REFERENCES "Match"("id") ON DELETE CASCADE,
  "issuedByUserId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "friendName" TEXT,
  "sourceMessageId" TEXT NOT NULL,
  "claimIndex" INTEGER NOT NULL DEFAULT 0,
  "botJobId" TEXT,
  "usedAt" TIMESTAMP(3),
  "usedByUserId" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "usedMessageId" TEXT,
  "outcome" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "FriendLink_usedMessageId_key" ON "FriendLink"("usedMessageId");
CREATE UNIQUE INDEX "FriendLink_sourceMessageId_claimIndex_key" ON "FriendLink"("sourceMessageId", "claimIndex");
CREATE INDEX "FriendLink_matchId_issuedByUserId_idx" ON "FriendLink"("matchId", "issuedByUserId");
ALTER TABLE "FriendLink" ADD CONSTRAINT "FriendLink_used_check"
  CHECK (("usedAt" IS NULL) = ("usedMessageId" IS NULL) AND ("usedAt" IS NULL OR "outcome" IS NOT NULL));

ALTER TABLE "PoolProfile" ADD COLUMN "friendLinkId" TEXT REFERENCES "FriendLink"("id") ON DELETE SET NULL;
CREATE INDEX "PoolProfile_friendLinkId_idx" ON "PoolProfile"("friendLinkId");
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_source_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_source_check"
  CHECK ("source" IS NULL OR "source" IN ('web', 'profile', 'referral', 'campaign', 'friend'));

ALTER TABLE "GuestPlace" ADD COLUMN "friendLinkId" TEXT REFERENCES "FriendLink"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "GuestPlace_friendLinkId_key" ON "GuestPlace"("friendLinkId");
ALTER TABLE "GuestPlace" ADD CONSTRAINT "GuestPlace_friend_check"
  CHECK ("friendLinkId" IS NULL OR ("source" = 'pool' AND "poolOfferId" IS NULL));
```

The same CHECKs go into `prisma/sql/pool-check.sql` (the e2e database).

**Existing rows: none touched.** Two nullable columns (NULL on every existing
row), one widened source list, one new CHECK that every existing row passes
because its new column is NULL. `Membership_guest_check` is unchanged: a
friend guest is `guestVia "pool"` (he is a pool member), so every existing
pool-guest path (guest tags, guest players page, no-show panel, removal hook,
`retirePastGuests`) already covers him.

---

## 4. Every message (EN and TR drafts)

House rules checked: no em or en dashes, no slashes as separators, "bench"
and "yedek", no time-of-day greetings. `{day}` is `dayCommaTimeLabel`,
`{name}` the friend's `shortDisplayName` ("Ali Y."), `{member}` the
issuer's first name.

### 4.1 Reaction on the member's message

`✉️`, only when the DM to him was queued. Replaces today's 👍 and the roster
post. (No reaction when nothing was sent; see 4.6.)

### 4.2 DM to the member (club bot, REPLY_PRIORITY, in the club's language)

Named:
- EN: `Here's the link for Ali to join *Sutton FC* on Monday 2 Nov, 8pm at Goals Sutton. Please forward it to him. He can only join this game by opening it, filling in his details and sending the WhatsApp code it gives him. It works for one person, until kick-off.`
  `{link}`
- TR: `Ali'nin *Sutton FC* ile 2 Kasım Pazartesi 20:00 Goals Sutton maçına katılması için bağlantı aşağıda. Lütfen ona ilet. Bu maça yalnızca bağlantıyı açıp bilgilerini doldurarak ve verdiği WhatsApp kodunu göndererek katılabilir. Bağlantı tek kişilik ve maç başlayana kadar geçerli.`
  `{link}`
  (Builder: if the genitive on a free-text name is risky, use `Ali için bağlantı aşağıda: ...`.)

Unnamed: `Here's the link for your friend to join ...` / `Arkadaşının ... maçına katılması için bağlantı aşağıda.` Same rest.

Several friends in one message: one DM, one link per friend, numbered
(`1. Ali: {link}`), with `Each friend needs his own link.` /
`Her arkadaşın kendi bağlantısını kullanmalı.`

Cap reached (3 unused links for this match): no new link; the same DM lists
his unused links again with `You already have links for this game that
nobody has used yet:` / `Bu maç için henüz kimsenin kullanmadığı
bağlantıların var:`.

### 4.3 The /play page (friend's language: browser, with the switch)

Match card at the top:
- EN: `*{member}* invited you to play` / `{club}` / `{day}` / `{venue}, {address}` / `Fee: £6` (or `Free`; line left out when unknown). Below: `Fill in your details, then send the WhatsApp code to take your place. This link works until kick-off.`
- TR: `*{member}* seni maça davet etti` / ... / `Ücret: £6` / `Bilgilerini doldur, sonra yerini almak için WhatsApp kodunu gönder. Bu bağlantı maç başlayana kadar geçerli.`

Name field prefilled with `friendName` when given (editable). The rest of the
form, the consent text, the code screen and the returning-visitor reminder
are the normal /play ones.

Link states:
- used: `This link has already been used.` / `Bu bağlantı zaten kullanıldı.`
- started: `This game has already started, so the link no longer works.` / `Bu maç başladı, bağlantı artık geçerli değil.`
- called off: `This game was called off.` / `Bu maç iptal edildi.`
- invalid: the existing pool "link not recognised" line.
- In every refused state: `You can still join the MatchTime player pool to hear about games near you.` with a link to plain `/play`.

### 4.4 After his code (platform channel)

Booked, in:
- EN: `You're in for *Sutton FC* on Monday 2 Nov, 8pm at Goals Sutton. Shane brought you in. Fee: £6, asked of you after the game. You're now in the MatchTime player pool too, so you'll hear about other games near you. Your settings: {manageLink}`
- TR: `*Sutton FC* ile 2 Kasım Pazartesi 20:00 Goals Sutton maçındasın. Seni Shane getirdi. Ücret: £6, maçtan sonra senden istenecek. Artık MatchTime oyuncu havuzundasın, yakınındaki diğer maçlardan da haberin olacak. Ayarların: {manageLink}`

Monthly club: fee line `Fee: £7 as a pay as you go player, asked of you after the game.` / `Ücret: maç başı ödeyen oyuncu olarak £7, maçtan sonra senden istenecek.`

Bench: `You're on the bench for ... The squad is full; if a place opens I'll tell you.` / `... maçında yedektesin. Kadro dolu; bir yer açılırsa sana haber veririm.` Organiser-pick club: `You're on the bench for ...; the organisers pick who plays from the bench.` / `... yedektesin; yedeklerden kimin oynayacağını organizatörler seçer.`

Not booked (link already used, game started, called off, he is the member
himself, already on the match, blocked): `You're in the MatchTime player
pool now. {reason}` with reasons:
- used: `The place on that link was already taken, so you're not booked into that game.` / `O bağlantıdaki yer zaten alındı, bu yüzden o maça kaydın yapılmadı.`
- started: `That game has already started.` / `O maç zaten başladı.`
- called off: `That game was called off.` / `O maç iptal edildi.`
- already on the match: `You're already on the list for that game.` / `O maçın listesinde zaten varsın.`
- issuer: `That link is for a friend of yours. To play yourself, say IN in the club's group.` / `O bağlantı bir arkadaşın için. Kendin oynamak için kulübün grubunda IN yaz.`
- blocked or paused for reports: neutral `You're not booked into that game.` / `O maça kaydın yapılmadı.` (never says why).

Existing pool member, booked: the same booked DM without the "now in the
pool" sentence.

### 4.5 Players' group post (BotJob "group", quiet hours, once per link)

- in: `🙋 Ali Y. (Shane's friend) is in for Monday 2 Nov, 8pm.` / `🙋 Ali Y. (Shane'in arkadaşı) 2 Kasım Pazartesi 20:00 maçında.`
- bench: `🙋 Ali Y. (Shane's friend) is on the bench for Monday 2 Nov, 8pm.` / `🙋 Ali Y. (Shane'in arkadaşı) 2 Kasım Pazartesi 20:00 maçı için yedekte.`
- organiser-pick bench: the bench line plus the existing `group_notice_bench_pick` tail.

No roster post with it (one line, attendance news only, so it is also fine
for a club whose organisers announce the list).

### 4.6 When the link cannot be sent

- Sender has no phone on record: no ✉️; one group reply to him:
  `Shane, I couldn't DM you the link for your friend. Message me privately once and tag me here again.` / `Shane, arkadaşının bağlantısını sana özelden gönderemedim. Bana bir kez özelden yaz, sonra burada beni yeniden etiketle.` (D7)
- No active match, attendance off: nothing (a reason line only), as the name ask today.

### 4.7 Organiser removes him (platform channel, `friend-removed`)

- EN: `The organisers of *Sutton FC* took you out of the game on Monday 2 Nov, 8pm. You stay in the MatchTime player pool and will keep hearing about new games near you.`
- TR: `*Sutton FC* organizatörleri seni 2 Kasım Pazartesi 20:00 maçından çıkardı. MatchTime oyuncu havuzunda kalıyorsun ve yakınındaki yeni maçlardan haberin olmaya devam edecek.`

Note: this deliberately differs from the pool's neutral `dm_removed` (L7
never says "removed"), because Kemal asked for it. The pool's own copy and
its test (`pool-safety-copy.test.ts`) stay as they are.

---

## 5. Rules for the edges

| Case | Behaviour |
|---|---|
| Pool not open in his town (`earlyList`) | Booking does not depend on it. His profile is created with `earlyList` as the platform switch says, area = the district he typed. He is booked into the match either way. The early-list sentence in the DM is left out (he is playing now). |
| Club has no venue area | Irrelevant to booking; the card shows the activity's venue text, or no venue line. His area is his own district. |
| Pool sign-up paused (`isPoolSignupPaused`) | D5. Recommended: friend links keep working (the club asked for him). |
| Consent | Nothing is sent to the friend before his own code message. The link DM goes only to the member who wrote. The friend's number is never in a link. Consent is recorded by `activatePendingProfile` as today (same version, channel whatsapp, his message id). |
| Forwarded to several people | Each can fill the form (each gets his own code). The first code to arrive uses the link; the others become pool members (they consented) and get the "already taken" DM. Organisers hear only about the one booked. |
| Re-use | `usedAt` compare-and-set, `usedMessageId` unique. A used link never books again. |
| Stranger uses it | Accepted risk: the member vouched with a link he forwarded. Mitigations: the group post names whose friend he is; organisers remove by tag as with anyone; club blocks (`PoolBlock` by club) refuse booking. |
| Many links from one member | 3 unused links per member per match (constant, D3). Duplicate delivery of the same group message reuses the same rows (`sourceMessageId, claimIndex`). |
| Cancelled match | Page "called off"; a code after that books nothing ("called off" DM). |
| Moved match | Link follows the match; expiry is the current kick-off; card shows the new time. If he was already booked, existing move handling applies to him as to any guest. |
| After kick-off | Page "started"; code books nothing. The pending sign-up's code also expires at kick-off (`friendCodeExpiry`). |
| Duplicate WhatsApp delivery of the code | First message: consent record + `usedMessageId`. Replay: `poolConsentRecord.evidence` or `FriendLink.usedMessageId` hit, return "duplicate", nothing sent. |
| Last place, two at once | `placeGuestOnMatch` takes `xask-fill:<matchId>` for friend bookings (serialised with pool and partner guests); `registerAttendance` decides CONFIRMED or BENCH. A member's own group IN is not under this lock today (pre-existing, not widened by this feature). Flagged for the adversarial review. |
| Organiser-pick club | Booked to the bench by the club's rule, as a pool guest is (D2). |
| He is already this club's guest for ANOTHER match | One guest match per membership row (`elsewhere`). Not booked; neutral not-booked DM. Rare. |
| He is an ordinary member of this club | Booked as a member (no guest marks), the `ordinary` branch of the guest writer. |
| The issuer uses his own link | Not booked ("issuer" DM). |
| Open pool ask on the same match | The round tick re-counts open places (`round.ts placesOpenOf`) so a friend filling the last place closes it at the next tick. |
| Teams already generated | Same as any late IN via `registerAttendance` (not special-cased). |

---

## 6. Payments

No new money code expected. Weekly club: the payment flow requests the fee
from every CONFIRMED row after the game (`payment-flow.ts`), which now
includes him; the fee stated on the card and DM comes from `poolFeeOf`, the
same source as the pool offer. Monthly club: in a running month a
non-regular CONFIRMED row is marked `payg` (`monthly-week-rules.ts`
`markOf`) and charged the PAYG price; the card shows `guestPaygPence`
(PR #462). Slice S5 proves both with sim scenarios; if either fails, the fix
is scoped there and reviewed as money work.

---

## 7. Slices in build order (TDD, red first in each)

Each slice: tests written and seen failing first; then code; then the
slice's own tests + the neighbouring suites listed + `tsc` + build. The
full suite runs once at the end (S7).

**S0. Schema and vocab** (`schema.prisma`, migration, `pool-check.sql`,
`vocab.ts`, `platform-jobs.ts`).
Tests first: a DB test on the e2e database that the CHECKs accept a friend
GuestPlace and refuse `friendLinkId` with `poolOfferId`, and that
`FriendLink_used_check` holds. Neighbours: `src/lib/pool/__tests__` schema tests.

**S1. Pure rules and copy** (`friend-link/rules.ts`, `friend-link/token.ts`,
`i18n/friend-link.*`, `i18n/tr-genitive.ts`).
Tests first: every branch of `decideThirdPartyIn` (named unknown, relation,
placeholder, group, member on roster, admin sender, no match, attendance
off, raw digits, contingent); `friendLinkState` (open, used, started at
exactly kick-off, called off, historical, moved); `friendBookingRefusal`;
`friendCodeExpiry`; token round trip, tamper, an offer token refused as a
friend token; copy: EN and TR keys match, no em or en dash, no " / ",
"bench"/"yedek" only, never "waiting list"; `trGenitive` table.

**S2. Engine and batch: the ✉️ and the DM** (`engine.ts`, `types.ts`,
`attendance-engine-batch.ts`, `owner-deps.ts`, `friend-link/issue.ts`).
Tests first (unit): engine emits `friendLinks` and NO write, NO
`squad_status`, NO `guest_name_ask` for a player; the sender's own IN in
the same message still writes; admin unchanged. Batch: react ✉️ only when
`issueFriendLinks` says queued. Issue: idempotent on replay, cap, no phone.
Sim (`e2e/sim/friend-link/issue.spec.ts`, new world helpers on
`e2e/sim/pool/world.ts`): **named friend**, **unnamed friend**, two friends
in one message, squad full (link still sent), no active match (silent),
member with no phone, cap, the same group message delivered twice (one DM),
an organiser's "Ali is in" (today's add, unchanged).
Existing specs whose expectations change and are rewritten in this slice:
`e2e/sim/guest-name-ask.spec.ts`, `e2e/sim/third-party-offer.spec.ts`,
the player cases in `src/lib/pipeline/__tests__/engine.test.ts`,
`src/lib/__tests__/guest-name-ask.test.ts` (gate stays, now organiser-only),
`attendance-engine-batch.test.ts`. Neighbours: `e2e/sim/interaction-contract.spec.ts`,
`attendance-engine.spec.ts`, `src/lib/pipeline/__tests__`.

**S3. The page and the sign-up** (`friend-link/page.ts`,
`app/play/f/[token]/page.tsx`, `play-signup.tsx` props, `api/play/signup`,
`pool/signup.ts`).
Tests first: unit for `loadFriendLinkPage` states; API: a friend token
creates a pending row with `friendLinkId`, `source "friend"`, code expiry at
kick-off when sooner; a used or started link is refused (409) and writes
nothing. Playwright (`e2e/web/play-friend-link.spec.ts`): card shows club,
date, time, venue and fee; name prefilled; no phone field; used, started,
called-off and invalid states; EN and TR. Neighbours: `e2e/web/play*.spec.ts`,
`e2e/sim/pool/signup-confirm.spec.ts`.

**S4. Confirm and booking** (`confirm-rules.ts`, `confirm.ts`,
`friend-link/book.ts`, `partner-guest.ts` generalisation).
ADVERSARIAL REVIEW (consent, concurrency).
Tests first: unit for the new `decidePoolConfirm` branches; `placeGuestOnMatch`
keeps every existing `placePoolGuest` test green unchanged (the refactor is
proved by the old tests). Sim (`e2e/sim/friend-link/confirm.spec.ts`):
**friend signs up and is booked** (group post exact text, friend DM, Attendance
CONFIRMED, GuestPlace with friendLinkId, consent record); **match full goes
to bench**; organiser-pick club bench; **link after kick-off**; **cancelled
match**; moved match (new time on the card, still bookable); **friend
already a pool member** (no second profile, booked, pending row gone);
account with no profile (profile attached to it); the issuer's own number;
already on the match; **duplicate code delivery** (one booking, one DM, one
group post); two strangers from one link (one booked, one "already taken");
two codes for the last place at once (one CONFIRMED, one BENCH); group post
held through quiet hours. Neighbours: `e2e/sim/pool/signup-confirm.spec.ts`,
`confirm-edges.spec.ts`, `confirm-abuse.spec.ts`, `offers-accept.spec.ts`,
`partner-ask-guest-notice.spec.ts`, `src/lib/pool/__tests__`.

**S5. Payments** (proof, code only if a gap is found).
ADVERSARIAL REVIEW (money) only if S5 changes money code.
Sim (`e2e/sim/friend-link/payments.spec.ts`): **weekly club fee** (after the
game the fee request reaches his number at the match fee); **monthly club
PAYG** (in a running month, marked payg, charged the PAYG price; card and DM
show it). Neighbours: `e2e/sim/pool/monthly-week.spec.ts`, payment sims,
`src/lib/__tests__/monthly-week*.test.ts`.

**S6. Removal** (`pool/removal.ts`, copy).
Tests first: unit for the copy branch. Sim
(`e2e/sim/friend-link/removal.spec.ts`): **organiser removes him** from the
match page; **by tag** in the players' group (`@Match Time take Ali out`)
and in HQ (tagged); each gives the friend DM once, GuestPlace "withdrawn",
he stays an active pool member; his own OUT gives no removal DM; after
kick-off nothing is sent. Neighbours: `e2e/sim/pool/no-shows*.spec.ts`,
`blocks-reports.spec.ts`, `hq-*` sims.

**S7. Wrap-up**: housekeeping check for pending friend sign-ups, the full
unit suite, `tsc`, build, the whole `sim/pool/` and `sim/friend-link/`
folders, the touched Playwright specs. $0 (stubbed).

---

## 8. Risks and reviews

- **Consent (S4, adversarial review):** a forwarded code or link must never
  attach a number to someone else's account. The existing L3 rules
  (`confirmTarget`) still apply; the friend branch only adds "existing
  profile -> book, no new profile".
- **Concurrency (S4, adversarial review):** the last place, double delivery,
  two strangers, link claim vs booking failure (if `placeGuestOnMatch`
  fails, the link claim is given back, like `acceptOffer` does).
- **Money (S5):** review only if code changes there.
- **Behaviour change in the group:** untagged third-party INs by players no
  longer add anyone. Players used to "+1 Ali" adding him at once will now
  depend on Ali doing the form. Clubs to tell: Sutton FC, FNF, Vets MNF,
  Erdal's group.
- **Removal wording** is explicit, unlike the pool's neutral line (Kemal's
  ask, noted).
- **Lost signal:** `guest_name_ask` remains only for organisers.

---

## 9. Prompts and paid tests

**No prompt change is needed.** The extractor already returns everything the
rule reads (`subject "other"`, `personKind` named, relation, placeholder or
group, `polarity`, `tense`, `contingent`), and the router already routes these
messages to the attendance owner (`other_att` / `offer`). What changes is
only what the engine does with that reading, which is deterministic code.

So no paid tests are required (a non-LLM change never triggers live runs).
Optional, only with Kemal's yes: one pass of
`e2e/sim/third-party-offer-live.spec.ts` and
`e2e/sim/guest-name-ask-live.spec.ts` (17 cases, about 34 calls, roughly
$0.10 to $0.20 on `ANTHROPIC_API_KEY_DEV`) to confirm the readings on today's
models. All stubbed suites in section 7 cost $0.

---

## 10. Decisions for Kemal

- **D1. Organisers.** Recommended: an owner or admin saying "Ali is in" keeps
  today's direct add (and "+1" keeps the name ask), because that is roster
  work by the person in charge. Alternative: links for everyone.
- **D2. Organiser-pick clubs.** Recommended: the friend lands on the bench
  like every non-organiser (club rule). Alternative: a vouched friend takes a
  free place directly.
- **D3. Cap.** Recommended: 3 unused links per member per match.
- **D4. Conditional offers** ("my brother can play if needed"). Recommended:
  send the link; he books like anyone else.
- **D5. Pool sign-up paused.** Recommended: friend links still work.
- **D6. Friend who stopped his pool profile** (withdrew consent). Recommended:
  his new code is fresh consent: book him and turn the profile active again
  with a new consent record. Paused for no-shows: book him, keep the pause.
  Paused for reports or by the MatchTime team, or blocked by the club: not booked.
- **D7. Member with no phone on record.** Recommended: the one group line in 4.6.
- **D8. HQ clubs.** Kemal's rule from 2026-10-29 sends guest notices to HQ
  when HQ exists. Recommended for friends: the players' group always (his
  2026-10-31 words: attendance news is for the whole group), HQ not told
  separately. Alternative: also a line in HQ.
- **D9. Referral credit.** Recommended: the member counts as having brought
  him (`referrerUserId`), so "Brought by" and referral badges work.
- **D10. "+2".** One link per claim the extractor returns. If it returns one
  claim for "+2", Shane gets one link and the DM says each friend needs his
  own link. Getting a count would need an extractor change, which this plan
  avoids.
