# Migrating the WhatsApp layer from whatsapp-web.js to Baileys

**Date:** 2026-09-21
**Status:** plan. Nothing in here has shipped.
**Decision:** Kemal, 2026-09-21, mid-outage: *"i think we need to migrate to
baileys if it is a bot problem. hometenant has been running on it and so far
so good"* and *"start the migration asap"*.

Read first, in this order:
`MDs/whatsapp-outage-2026-09-16-runbook.md`,
`MDs/whatsapp-web-version-pinning.md`,
`MDs/whatsapp-layer-independent-audit-2026-08-30.md`,
`MDs/hometenant-whatsapp-layer-review-2026-09-09.md`.

---

## 0. Why now, and the fact that closes the argument

Four outages, all the same shape, all from WhatsApp changing a frontend we do
not control:

| date | what broke | how it was fixed |
|---|---|---|
| 2026-08-28 | injected code, minified `r: r` on every chat and contact lookup | pinned the WhatsApp Web build |
| 2026-08-30 | same class; inbound ids unreadable, attendance silently dead for 3 days | defensive reads plus synthetic ids |
| 2026-09-16 | `Client.sendMessage` and `getChat` throwing; re-injection failed after a page navigation | upgraded `whatsapp-web.js` 1.34.6 to 1.34.7 |
| **2026-09-20 14:33 BST, ongoing** | group enumeration `Error: r`, participant sync `Error: t`, `Cannot read properties of undefined (reading 'getChat')`, `Execution context was destroyed`, then the process died on `Failed to add page binding with name onQRChangedEvent: window['onQRChangedEvent'] already exists!` at `Client.inject` (Client.js:224) | **nothing yet** |

**The Pi runs `whatsapp-web.js` 1.34.7 and `npm view whatsapp-web.js version`
is also 1.34.7.** The lever that fixed September 16 does not exist any more.
There is no build to pin either, because a pin only pins the bootstrap loader
and WhatsApp serves newer modules into it
(`whatsapp-web-version-pinning.md`, "Why a pin cannot freeze the frontend").
The remaining options were an unreleased 2023 alpha or waiting for upstream,
which the September 16 runbook already called "neither is a plan".

Baileys does not drive a browser. It speaks WhatsApp's multi-device wire
protocol over a WebSocket, with Signal-protocol encryption, and decodes
protobufs. There is no minified frontend to be out of step with, no Chromium,
and no injected `window.WWebJS.*`.

**Three honest caveats, up front.**

1. **Baileys is not immune.** WhatsApp can change the protocol, and Baileys has
   its own breakages. What changes is the class and the frequency: protocol
   changes are rarer than frontend changes, they break loudly (a decrypt or
   auth error, not a silent `return null`), and the library moves faster. This
   reduces the outage class substantially. It does not eliminate risk.
2. **Baileys has its own way of taking the line down, and it is worse.**
   HomeTenant lost **every linked device on the account** on 2026-09-17 after
   about 100 directory lookups went out from a Baileys session
   (`HomeTenant/MDs/learnings.md:262-279`). whatsapp-web.js has no equivalent
   foot-gun because it cannot make those queries. See §2.2.
3. **HomeTenant proves less than it looks like it proves.** Its bot is
   **DM-only**: `src/baileys/jid.ts:70` drops every `@g.us` message before
   anything else happens. It has **no** groups, **no** mentions, **no**
   reactions, **no** participant handling and **no** history recovery. Those
   are exactly the things MatchTime lives on. What HomeTenant gives us is a
   proven socket, auth, reconnect, pairing, logging and testing skeleton, and
   a set of expensive lessons. It gives us nothing on the group half, which we
   must spike ourselves.

**The one piece of luck in the timing:** the bot is already sitting on a QR
code with the session gone. Re-pairing is normally the main cost of this
migration. Right now it costs nothing, because we have to re-pair anyway.

---

## 1. Capability inventory

Everything the current bot does, read out of `whatsapp-bot/src/` in full.
Verdicts are measured against **Baileys `7.0.0-rc14`**, the version HomeTenant
runs in production, whose type definitions and compiled source were read
directly in `HomeTenant/whatsapp-bot/node_modules/baileys` rather than
recalled.

### 1.1 Bootstrap, session and lifecycle

| # | Capability | Today | Baileys equivalent | Verdict |
|---|---|---|---|---|
| 1 | Single-instance guard | `acquireInstanceLock()`, `/tmp/matchtime-bot.pid` (`instance-lock.ts`) | unchanged, library-independent. **More important than before:** two Baileys sockets on one auth folder evict each other in a `440 connectionReplaced` loop and churn `creds.json` | **no change, higher stakes** |
| 2 | Client construction | `new Client({ authStrategy: new LocalAuth(), puppeteer: {...} })` plus `client.initialize()` (`index.ts:135-144, 912`) | `makeWASocket({ auth, logger, markOnlineOnConnect, syncFullHistory, getMessage })`. HomeTenant passes exactly those five and nothing else | **easier** |
| 3 | Headless Chromium | `/usr/bin/chromium`, `--no-sandbox` | **gone.** Baileys has one platform binary in its tree, `sharp` (a required, non-optional peer), and the arm64 prebuild exists. `whatsapp-rust-bridge` is WebAssembly, not a native addon, so there is no compile step on the Pi | **much easier.** Removes roughly 300 to 400 MB RSS and the slowest part of startup |
| 4 | QR login | `client.on("qr")` plus `qrcode-terminal` (`index.ts:150`) | the `qr` field on `connection.update`, rendered with the same `qrcode-terminal`. **`printQRInTerminal` is deprecated in 7.x** and does nothing but log a warning | **same** |
| 5 | Pairing-code login | `WA_PAIR_PHONE` plumbing in `pair-phone.ts`, 281 lines of workarounds for the library owning the refresh loop | `sock.requestPairingCode(digits)`, called by us, once per socket, from the `qr` branch. HomeTenant's `src/pairing.ts` is a pure `decidePairingAction()` plus a banner | **much easier.** Most of `pair-phone.ts` can be deleted. HomeTenant prefers the code over a QR "over a remote terminal", which is our situation exactly |
| 6 | WhatsApp Web build pinning | `web-version.ts` (154 lines), `.wwebjs_cache/`, three env vars and a reachability probe | **obsolete.** There is no web build | **deleted** |
| 7 | `ready` | `client.on("ready")` (`index.ts:193`) | `connection.update` with `connection === "open"` | **same**, and it still fires more than once (§2.8) |
| 8 | `disconnected` | `client.on("disconnected", reason)` (`index.ts:888`) just stops the timers | `connection.update` with `connection === "close"`; the status code is dug out of `lastDisconnect.error.output.statusCode`. `DisconnectReason`: `401 loggedOut`, `403 forbidden`, `408 connectionLost`, `411 multideviceMismatch`, `428 connectionClosed`, `440 connectionReplaced`, `500 badSession`, `503 unavailableService`, `515 restartRequired` | **harder, and better.** Baileys expects the caller to reconnect. We must write a policy we do not have today. Copy HomeTenant's `src/baileys/connection.ts` wholesale (§3, Phase 1) |
| 9 | Shutdown | `client.destroy()` on SIGINT/SIGTERM | `sock.end(undefined)`. **Never `sock.logout()`**, which unlinks the device | **same**, with a sharp edge (§2.10) |
| 10 | Auth persistence | `LocalAuth` writes a Chromium profile to `.wwebjs_auth/` | `useMultiFileAuthState(dir)` wrapped in `makeCacheableSignalKeyStore(state.keys, logger)`, plus `ev.on("creds.update", saveCreds)` | **easier**, but not convertible (§2.1) |

### 1.2 Inbound

| # | Capability | Today | Baileys equivalent | Verdict |
|---|---|---|---|---|
| 11 | Group and DM message receipt | `client.on("message", msg)` (`index.ts:452`) | `sock.ev.on("messages.upsert", { messages, type })`, where `type` is `"notify"` (live) or `"append"` (history and backfill) | **easier**, but the `type` filter is a decision, not a copy (item 41) |
| 12 | Reading the body | `readInboundHeadline` / `readMessageBody` (`wa-read.ts`), every field behind `safeRead` because the live build turns them into throwing getters | `normalizeMessageContent(msg.message)` **first** (it unwraps `ephemeralMessage`, `viewOnceMessageV2`, `deviceSentMessage`, `documentWithCaptionMessage` in one call), then `getContentType(content)`, then read `conversation` or `extendedTextMessage.text` | **much easier.** The entire throwing-getter defence becomes unnecessary. Keep the helpers anyway; they cost nothing and are already tested |
| 13 | Sender identity | `msg.from`, `msg.author` | `key.remoteJid` (chat) and `key.participant` (group sender), plus `key.remoteJidAlt` / `key.participantAlt` which carry the **other** addressing form straight off the wire (§2.7) | **easier, and it closes a real hole** |
| 14 | Pushname | `msg._data.notifyName`, deliberately preferred over `getContact()` because it survives a broken build (`smart-analysis.ts:543`) | `msg.pushName`, a first-class field on the WAMessage | **easier.** The field we already chose for robustness is now simply the normal one |
| 15 | `fromMe` filter | `head.fromMe` | `key.fromMe`. `emitOwnEvents` defaults to `true`, so our own sends do come back; HomeTenant uses two layers, `key.fromMe` and `type !== "notify"` | **same** |
| 16 | Timestamp | `msg.timestamp` (seconds) | `msg.messageTimestamp`, a number **or a protobuf `Long`**. Must be normalised (§2.11) | **same, with a footgun** |
| 17 | Message id | `resolveWaMessageId` (`message-id.ts`, 228 lines): `_serialized`, else reconstruct `${fromMe}_${remote}_${id}[_${participant}]`, else a deterministic content hash | `key` is `{ remoteJid, fromMe, id, participant }`, always present, never a getter | **much easier, the single biggest code win.** The synthetic-id machinery exists solely because whatsapp-web.js stopped exposing ids. **But the id format changes, and §2.5 is the biggest single hazard in this migration** |
| 18 | Duplicate delivery | not handled; the server dedupes on `waMessageId` | **Baileys can deliver the same message twice** (a reconnect mid-delivery, a retried decrypt). HomeTenant keeps a bounded first-sighting set (`core.ts:293-304`) | **new work**, small. The server still dedupes, so this is an optimisation, not a correctness fix |
| 19 | Mentions on an inbound message | `msg.mentionedIds` | `message.extendedTextMessage.contextInfo.mentionedJid`. **HomeTenant has no precedent: it never reads mentions at all** | **same API, zero borrowed experience** |
| 20 | Mention display names | `client.getContactById(jid)` per mention, then `rewriteMentions` (`mentions.ts`) rewrites only the bot's own | **partially missing.** There is no contact-lookup API. Names come from `msg.pushName`, from `GroupParticipant.name` / `.notify`, and from `contacts.upsert` during app-state sync | **harder** (§2.9) |
| 21 | Bot self-mention detection | compares `mentionedIds` against `client.info.wid`, `info.me`, `info.lid`, `info.wid.lid` (`smart-analysis.ts:612-625`) | `sock.user.id` and `sock.user.lid`; the id **carries a device suffix** and must be normalised (§2.4) | **easier**, once the JID handling is right |
| 22 | Quoted / reply context | not read | `contextInfo.quotedMessage` and `stanzaId` | **available, unused** |
| 23 | Media / non-text DM detection | `head.hasMedia` plus a type allowlist (`index.ts:496`) | the content type off `getContentType`, mapped to the same strings whatsapp-web.js used (`chat`, `ptt`, `audio`, `image`, `video`, `document`, `sticker`). HomeTenant does exactly this mapping so one shared classifier serves both drivers | **same, and there is a proven mapping to copy** |
| 24 | Replying to a message | `msg.reply(text)` (`index.ts:505`) | `sock.sendMessage(jid, content, { quoted: waMessage })`, passing the whole inbound message | **same** |
| 25 | Batch buffer and flush | `smart-analysis.ts`, pure logic over an in-memory map | untouched. It takes a client only to react and to reply | **no change** |

### 1.3 Outbound

| # | Capability | Today | Baileys equivalent | Verdict |
|---|---|---|---|---|
| 26 | Group text | `client.sendMessage(groupId, text)` (`scheduler.ts:228`) | `sock.sendMessage(groupId, { text, linkPreview: null })` (§2.6) | **same** |
| 27 | DM text | `client.sendMessage(phone + "@c.us", text)` (`scheduler.ts:261`) | `sock.sendMessage(phone + "@s.whatsapp.net", { text, linkPreview: null })`. **The suffix changes** (§2.4) | **same shape, pervasive edit** |
| 28 | Mentions in an outbound message | `{ mentions: ["447...@c.us"] }` (`scheduler.ts:227, 294`) | `{ text, mentions: ["447...@s.whatsapp.net"], linkPreview: null }`. rc14 also has `mentionAll` | **same shape, same suffix change.** HomeTenant never sends mentions, so again no borrowed experience |
| 29 | Send result and its message id | `send-result.ts` exists because `client.sendMessage()` **resolves to `undefined`** on a broken build, and `scheduler.ts` acks anyway rather than risk a duplicate | `sock.sendMessage` resolves to a full `WAMessage` with a real `key`. HomeTenant keeps the returned object | **easier.** Keep the ack-anyway behaviour regardless: at-most-once is a deliberate product decision, not a workaround (`SESSION-HANDOFF-2026-08-27.md` §1) |
| 30 | Polls, sending | `new Poll(q, opts, { allowMultipleAnswers })` (`scheduler.ts:243`) | `sock.sendMessage(jid, { poll: { name, values, selectableCount } })` | **same** |
| 31 | Poll votes, receiving | `client.on("vote_update")` gives a decrypted `{ parentMessage, voter, selectedOptions }` (`index.ts:702`) | **harder.** Votes arrive encrypted on `messages.update` as `pollUpdates` and are decrypted with `getAggregateVotesInPollMessage({ message, pollUpdates }, meId)`, which needs the **original poll message** via the `getMessage(key)` socket option | **genuinely harder** (§2.12) |
| 32 | Reactions, sending | `react-with-id.ts` (284 lines) calling `client.getMessageById` then `client.sendReaction` through `client.pupPage`, written after `Message.react()` was found to resolve without placing anything | `sock.sendMessage(chatJid, { react: { text: emoji, key: targetKey } })`. One call. `text: ""` removes a reaction | **much easier on paper**, but it needs the **full key**, not an id string (§2.5). **HomeTenant has never sent a reaction**, so this is unverified and must be spiked |
| 33 | Reactions, receiving | `client.on("message_reaction")` with `msgId._serialized`, `senderId`, `reaction` (`index.ts:645`) | `sock.ev.on("messages.reaction", [{ key, reaction }])`, where `key` is the reacted-to message's key | **same API, unverified** |
| 34 | Link previews | whatsapp-web.js does not generate them | **Baileys generates a preview for the first URL in any outgoing text, which means the Pi fetches that URL itself before sending.** MatchTime sends short magic links | **a new hazard we must switch off** (§2.6) |
| 35 | Send timeout guard | `withTimeout(..., SEND_TIMEOUT_MS)` around DM sends (`scheduler.ts:157`) | keep it; HomeTenant has the same helper | **no change** |
| 36 | Typing and presence | not used | `sock.sendPresenceUpdate`. **`markOnlineOnConnect` defaults to `true` and must be set `false`** | **a default that will bite** (§2.13) |

### 1.4 Groups and roster

**HomeTenant implements none of this.** Everything in this table is read from
the library, not from a running system.

| # | Capability | Today | Baileys equivalent | Verdict |
|---|---|---|---|---|
| 37 | Group enumeration at startup | `client.getChats()` filtered on `isGroup` (`index.ts:197`); the canary for the whole injected layer; degraded capability `group-enumeration` | `sock.groupFetchAllParticipating()` returns `Record<jid, GroupMetadata>` | **easier** |
| 38 | Participant sweep | `getChatById(gid).participants` plus `getContactById(id)` per member, for the lurker backfill (`index.ts:265-330`); degraded capability `participant-sync` | `sock.groupMetadata(jid).participants`, typed `GroupParticipant = Contact & { admin }`, each carrying **`id`, `lid`, `phoneNumber`, `name`, `notify`, `username`** | **easier, and it fixes a real defect.** `phoneNumber` here is a **network** LID-to-phone path, which HomeTenant never had. See §2.7 |
| 39 | Group subject | `chat.name`, or `group-snapshot.ts`'s page-level read | `GroupMetadata.subject` | **easier.** `group-snapshot.ts`'s 211 lines exist purely to avoid `getChatModel`; all of it goes |
| 40 | Join and leave events | `client.on("group_join" / "group_leave")` with `{ chatId, recipientIds, author }` (`index.ts:820, 871`) | `sock.ev.on("group-participants.update", { id, author, participants, action })` where action is `add`, `remove`, `promote`, `demote` or `modify` | **same, cleaner** |
| 41 | Bot-added-to-a-group (self-setup) | `handleGroupJoinForSelfAdd` (`bot-added.ts`), self-id match against `client.info.wid` with a `pupPage.evaluate` fallback | `groups.upsert` fires with the new group's metadata; match against the normalised `sock.user.id` and `sock.user.lid` | **easier** |
| 42 | Group metadata caching | not applicable | `cachedGroupMetadata` is a socket option that **we** supply; `sendMessage` asks it on every group send (`useCachedGroupMetadata` defaults true). Baileys ships no cache of its own | **new work**, small, and worth doing to avoid a metadata fetch per send |
| 43 | Listing DM chats | `client.getChats()` filtered on `!isGroup`, used only by the one-shot `BOT_RECOVER_DM_REPLIES=1` tool (`index.ts:361`) | **missing.** Baileys has no chat store | **missing**, and acceptable to drop (§2.14) |

### 1.5 Recovery, health and scheduling

| # | Capability | Today | Baileys equivalent | Verdict |
|---|---|---|---|---|
| 44 | Restart catch-up (the 2h replay) | `recoverGroupMessages` (`smart-analysis.ts:959`) calls `fetchRecentGroupMessages`, which uses a **bare chat handle**'s `fetchMessages({ limit })` to dodge `getChatModel`. Exists because whatsapp-web.js silently drops messages that arrive while the socket is down (Kemal 2026-06-06, Ibrahim's lost "in"); degraded capability `message-recovery` | **different, and unresolved.** Baileys is a real linked device, so WhatsApp buffers undelivered messages and replays them. The open question is **what `type` they arrive with**: HomeTenant deliberately drops everything that is not `"notify"`, so its production experience tells us nothing about whether the replay would have been caught. There is also `sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)`, answered on `messaging-history.set` | **the highest-uncertainty item in the migration** (§2.15). Measure it, do not assume it |
| 45 | Self-setup history capture (600 messages from a freshly joined group) | `collectHistoryForServer` (`index.ts:756`), retried 3x because WhatsApp may not have synced history yet | **uncertain, probably reduced.** History arrives on `messaging-history.set`, governed by `syncFullHistory` (**default `true`**) and `shouldSyncHistoryMessage`. For a group joined **while already connected** there is no documented push, and `fetchMessageHistory` needs an existing key from that chat, which we would not have | **most likely a loss.** Cost is currently theoretical: the onboarding flag has been on in prod since June and has **never fired** (0 sessions). Say so honestly rather than pretending it is free |
| 46 | Scheduler loop and BotJob dispatch | `scheduler.ts` polls `/api/whatsapp/due-posts` every 30s; claim-on-dispatch at-most-once; `ackInstruction` / `releaseInstruction` | untouched. Purely HTTP against our own server | **no change.** Only `executeInstruction` is WhatsApp-facing |
| 47 | Heartbeat, counters and degraded capabilities | `heartbeat.ts`, `reportHealth`, `degraded.ts` | untouched, library-independent. The four `DegradedCapability` names survive; their causes change | **no change.** Revise `degraded.ts`'s wording in Phase 7 |
| 48 | Org refresh timer | `org-refresh.ts` | untouched | **no change** |
| 49 | `deploy-pi.sh` | discriminates our processes from HomeTenant's by **working directory**, because both run a byte-identical `node --env-file=.env --import tsx src/index.ts` | unchanged, provided the install directory does not move | **no change.** Do not rename the bot directory during this migration |

### 1.6 Headline gaps: what Baileys cannot do that we rely on

Three real losses:

1. **On-demand contact and pushname lookup by JID** (`getContactById`). There
   is no API, and the only network substitute (a USync directory query) is the
   thing that unlinked HomeTenant's account. Mitigated, not eliminated (§2.9).
2. **History for a group joined while already connected** (item 45). Currently
   unused in anger.
3. **Listing DM chats** (item 43). One env-gated recovery tool.

Two things are *harder* rather than missing: **poll-vote decryption**
(item 31) and **writing a reconnect policy** (item 8). The second is work we
should have done anyway.

And one thing is **unknown rather than either**: whether the restart replay
(item 44) still needs to exist.

---

## 2. What will bite

Named honestly, worst first.

### 2.1 Re-pairing is unavoidable. Assume it and plan for it.

`.wwebjs_auth/` is a **Chromium user-data directory** holding WhatsApp Web's
own IndexedDB. Baileys auth state is **Signal protocol keys** in JSON written
by `useMultiFileAuthState`. They are not the same artefact, there is no
conversion, and WhatsApp treats them as two different linked devices.

**So yes: the bot must be linked again, by QR or by pairing code.** Plan the
cutover around a human being present. HomeTenant's cutover was exactly this,
and they prefer the pairing code because a QR over a remote terminal is
awkward.

For scale, HomeTenant's paired Baileys auth folder is **11 MB across 2,832
files**: `creds.json`, about 800 pre-keys, a handful of sessions and app-state
keys, and around 2,000 `lid-mapping-*.json` files that arrived from the
pairing-time app-state sync. Plan for that on the Pi's SD card, and keep the
directory at `mode 0700`.

Operational rules carried over:

- Call `requestPairingCode` **once per socket**, only while unpaired. A crash
  loop that hammers the pairing endpoint risks the number itself
  (September 16 runbook §5).
- **One socket per auth folder, ever.** Two sockets on one folder evict each
  other in a `440` loop and churn `creds.json`.
- **Never delete the auth folder and never call `logout()`**, whatever
  happens. `deploy-pi.sh` must be checked for this before Phase 6.

The consolation, stated once: the session is **already gone** as of
2026-09-20, so this cost is currently zero.

### 2.2 Do not ask WhatsApp about numbers. It unlinked HomeTenant's whole account.

This is the most dangerous thing in the migration and it has nothing to do
with code quality.

On 2026-09-17, about 100 USync "is this number on WhatsApp" lookups of mostly
synthetic `07700 900xxx` numbers went out from HomeTenant's production account
through a Baileys session. **Within the hour WhatsApp unlinked every linked
device on the number.** The Baileys session returned 401, the live
whatsapp-web.js bot fell back to a QR, crash-looped, and systemd latched it
off. The line was down from 15:59 to about 16:35.
(`HomeTenant/MDs/learnings.md:262-279`.)

Causation is not proven. Nothing else changed.

**Rules for MatchTime:**

- **Never call `onWhatsApp()` or `executeUSyncQuery` on a number that is not a
  real person in our own database.** No probing, no test numbers, no sweeps.
- Prefer the **group-metadata path** (§2.7), which is a normal thing for a
  group member to ask and is not a directory query.
- Pin this with a source-level test that bans `onWhatsApp`, `getLIDForPN` and
  `getLIDsForPNs` from the driver outright, the way HomeTenant does
  (`tests/baileys-driver-source.test.ts:37-41`).
- If a directory lookup ever becomes necessary, copy HomeTenant's rationing
  wholesale: 10 per query, one query per minute, a 200-per-day ceiling, a
  one-hour back-off on any failure, an `off` kill switch, and numbers sourced
  only from our own roster.

### 2.3 Two libraries on one number means two linked devices, and that means duplicate sends

WhatsApp allows about four linked devices per account. Running
whatsapp-web.js and Baileys against the same number at once is two devices,
and **both receive every inbound message**. If both have the scheduler and the
flush timer running, both POST to `/api/whatsapp/analyze` and both poll
`/api/whatsapp/due-posts`. Claim-on-dispatch protects the due-posts path, but
the reply and reaction actions come back in the flush response to whichever
bot asked, so **both would post replies**.

That is the 2026-07-19 duplicate-flood class, which cost a customer group 30+
copies of the same roster message.

**Rule: exactly one writer, always.** Side-by-side running is allowed only in
a receive-only shadow mode where the Baileys process has the scheduler, the
flush timer and all sends hard-disabled at the driver, and logs what it would
have done. That shape is genuinely useful and is Phase 5.

### 2.4 JID handling changes in three separate ways

| form | whatsapp-web.js | Baileys |
|---|---|---|
| a person | `447700900123@c.us` | `447700900123@s.whatsapp.net` |
| a group | `1234567890@g.us` | `1234567890@g.us` (same) |
| privacy-mode identity | `<digits>@lid` | `<digits>@lid`, and also `@hosted.lid` |
| **our own id** | `client.info.wid._serialized`, no device suffix | `sock.user.id` is `447700900123:12@s.whatsapp.net`, **with a device suffix** |

Consequences:

- Every `${phone}@c.us` in `scheduler.ts` (lines 227, 261, 294) and every
  `.endsWith("@c.us")` / `.replace("@c.us", "")` across `index.ts`,
  `smart-analysis.ts` and `bot-added.ts` needs a decision, not a
  find-and-replace. **Put it behind one tested module** (`baileys/jid.ts`:
  `toUserJid`, `phoneFromJid`, `isGroupJid`, `isUserJid`, `isLidJid`,
  `bareUser`) rather than sprinkling a new suffix around.
- `sock.user.id` must have the device suffix stripped before any comparison,
  or every self-check silently returns false. This is the classic Baileys
  first-week bug.
- Do not forget `hosted` and `hosted.lid` as servers. HomeTenant's test suite
  has both.
- `0@s.whatsapp.net` is WhatsApp's own PSA account and must not be read as a
  phone. Require `/^\d{6,15}$/`.
- The server side stores phones, not JIDs, so **no database migration is
  needed for identity**. Only the bot's string handling changes.

Technique worth copying: HomeTenant hand-writes `parseJid` so the module has
no Baileys import and stays pure, then **unit-tests it against Baileys' real
`jidDecode`** on a table of sample JIDs. Best of both.

### 2.5 The waMessageId format changes, and that breaks the reaction join across the cutover

This is the sharpest code edge and deserves its own paragraph.

`message-id.ts:112-133` documents the exact format the whole system uses:

```
${fromMe}_${remote}_${id}                  // DM
${fromMe}_${remote}_${id}_${participant}   // group
```

A Baileys `WAMessageKey` is `{ remoteJid, fromMe, id, participant }`. That is a
**field-for-field match**, so the serialisation is reproducible and,
crucially, **reversible**. That matters because:

- `SentNotification.waMessageId`, `BenchSlotOffer.waMessageId` and
  `AnalyzedMessage.waMessageId` all hold strings in the old format.
- `sock.sendMessage(jid, { react: { text, key } })` needs the **whole key**,
  not a string. The server hands the bot a `waMessageId` string in an
  `update-reaction` instruction and nothing else.
- HomeTenant hit the same wall and simply accepted the change
  (`README.md:131-133`), because it stores no ids and sends no reactions. We
  cannot.

**Proposed fix, built in Phase 3:** a tested pair of pure functions,

```
serializeKey(key: WAMessageKey): string
parseKey(serialized: string): WAMessageKey | null
```

with `remote` and `participant` **normalised to the `@c.us` form** on the way
out and back to `@s.whatsapp.net` on the way in. Then ids stay byte-identical
across the cutover, `update-reaction` works from the string the server already
has, `AnalyzedMessage` dedupe keeps working so the restart replay stays
idempotent, and there is no server change and no database migration.

The `@lid` case does not round-trip cleanly, because a group participant may
be addressed as `@lid` under Baileys where whatsapp-web.js used `@c.us`. That
is a **partial** break, limited to reactions on messages from privacy-mode
members sent before the cutover. Cut over when no bench offers are open and
the cost is zero.

**If `serializeKey` is not built, the fallback is "no reactions on any message
sent before the cutover"**, which for a Wednesday-morning cutover means a few
hours of ratings DMs. Survivable, but the shim is cheap.

### 2.6 Baileys fetches every link we send, before it sends it

Baileys generates a link preview for the first URL in an outgoing text, and
generating it means **the Pi makes an HTTP request to that URL**.

MatchTime sends **short magic links** (memory: "short magic links 2026-06-05").
Those are credentials. A preview of one means the first visit to a player's
private link comes from us, and it would land in whatever analytics or
one-time-use logic sits behind it.

**Fix, from day one:** every outgoing text goes through one helper that sets
`linkPreview: null`. Not `undefined`: Baileys only skips generation when the
field is **present**, because its check is `typeof urlInfo === 'undefined'`.
Ban a bare `{ text }` in the driver with a source-level test, as HomeTenant
does.

Bonus: `link-preview-js` is an **optional peer dependency that is not
installed**, so leaving generation on also fills `bot.err.log` with
`Cannot find package 'link-preview-js'` on every message carrying a link.
Turning it off fixes that without touching the lockfile.

### 2.7 The `@lid` problem, which Baileys solves differently and in our case better

This is the section that shelved the Baileys migration at HomeTenant once and
then reversed it. The facts, verified in the installed library today:

**`LID -> phone` has no network path in Baileys.**
`lib/Signal/lid-mapping.js:221-269` checks a memory cache, then the local key
store, then gives up. There is no IQ and no network call. It returns `null` in
about 1ms for an unknown LID. `onWhatsApp` refuses LID input outright
(`Socket/socket.js:226-228`, "LIDs are not supported with onWhatsApp"). This
is architectural: whatsapp-web.js can do it only because it drives the real
WhatsApp Web client and can call WhatsApp's own resolver
(`Client.js:3307 getContactLidAndPhone`). Baileys reimplements the protocol
from outside, so it cannot have this. **It is not a missing feature someone
will add.**

**But we have three paths HomeTenant did not.**

1. **The wire itself.** `key.remoteJidAlt` and `key.participantAlt` carry the
   other addressing form, lifted from the stanza's `sender_pn` /
   `participant_pn` attributes. **This needs no prior knowledge of the sender,
   so it works for a first-time player.** Baileys also auto-stores the pair
   when an alt is present (`Socket/messages-recv.js:1279-1291`), so the local
   mapping store self-heals from live traffic.
2. **Group metadata, which is a network path.** `Socket/groups.js:333-341`
   returns each participant's `phoneNumber` when the participant is addressed
   by LID. **That is a genuine network LID-to-phone resolution for anyone in
   our groups, and HomeTenant never had it**, because it has no groups. For a
   group-based bot this probably removes the need for a directory seeder
   entirely, and with it the account-unlink risk of §2.2.
   **Caveat, verified:** rc14 carries a literal `// TODO: Store LID MAPPINGS`
   at `groups.js:334` and does **not** seed its own mapping store from group
   metadata. We must call
   `sock.signalRepository.lidMapping.storeLIDPNMappings(pairs)` ourselves on
   every participant sweep.
3. **The local store**, `signalRepository.lidMapping.getPNForLID(lid)`, as the
   last resort.

**Resolution order for MatchTime** (copy HomeTenant's `resolveInboundSender`
and add the group path):

1. a phone JID on `key.participant` or `key.remoteJid`;
2. a phone JID on `key.participantAlt` or `key.remoteJidAlt`;
3. the local `getPNForLID` store;
4. the group's cached participant list, `phoneNumber` for that `lid`;
5. give up and report the sender as unresolved. **Never guess a phone from LID
   digits** (HomeTenant pins this with a test, because a guessed number can
   match somebody else's record).

`GroupMetadata.addressingMode` is `'lid' | 'pn'`, so we can tell per group
which regime we are in.

**Strategic note, worth Kemal's attention.** HomeTenant's `learnings.md:52-65`
records that WhatsApp opened username reservation in June 2026, and that **a
sender with a username returns a LID and no phone number, ever**. E.164 is
dying as an identity key. That is a protocol change, not a library choice, and
it reaches whatsapp-web.js too. This migration does not cause it and does not
fix it, but MatchTime resolves players by phone in several places and will
have to face it.

### 2.8 `connection.update` fires a lot, and `ready` already was not once-only

`recoverGroupMessages` already guards against a double sweep with
`recoverySweepInFlight`, because whatsapp-web.js re-emits `ready` on every
re-injection (two `ready` lines under one PID on 2026-09-16). Baileys is the
same or worse: `connection: "open"` fires on every successful reconnect, and
**`515 restartRequired` always fires once immediately after a fresh pairing**.

Every on-open action must be idempotent: group enumeration, org refresh,
participant sweep, recovery sweep, and every timer start. Most already are.
Check each one explicitly rather than assuming.

HomeTenant's answer to stacked sockets is a **generation counter**: each
`connect()` increments it, and every handler opens with
`if (gen !== generation) return;`. Copy that.

Their reconnect policy, which is the thing to copy in Phase 1:

- fatal, so `process.exit(1)` and let systemd supervise:
  `401 loggedOut`, `403 forbidden`, `411 multideviceMismatch`,
  `440 connectionReplaced`, `500 badSession`, each with a sentence telling the
  operator what to do;
- `515 restartRequired`: reconnect with **zero** delay;
- anything else: reconnect after `min(1000 * 2 ** failures, 60_000)`;
- 10 consecutive failures without a successful open: exit, so systemd restarts
  cleanly rather than flapping forever.

**One interaction to check before Phase 6:** exiting on a fatal means systemd
restarts, and `StartLimitBurst=5` / `StartLimitIntervalSec=300` will leave the
unit **permanently stopped** after five failures in five minutes, answering
`systemctl start` with "start request repeated too quickly". That reads like a
rate limit rather than a dead line.
`sudo systemctl reset-failed` clears it. Put it in the runbook.

### 2.9 There is no contact lookup, so display names must be harvested, not fetched

`getContactById(jid)` has no Baileys equivalent, and the network substitute is
forbidden by §2.2. Names reach us three ways:

1. **`msg.pushName` on every inbound message.** The main source, and already
   the preferred one (`smart-analysis.ts:543` chose it deliberately because it
   survives a broken build). No regression at all.
2. **`GroupParticipant`** from `groupMetadata()` carries `name`, `notify`,
   `phoneNumber`, `lid` and `username`. This is strictly **more** than the
   participant sweep gets today, where `getContactById` is exactly the call
   that dies.
3. **`contacts.upsert` / `contacts.update`** during app-state sync, with
   `Contact.notify` as the pushname. Persist these to a small JSON cache.

What genuinely degrades: the display name of an @-mentioned person we have
never seen speak and who is not in a monitored group, and the name of a
reactor or poll voter under the same conditions. Note `mentions.ts` already
establishes that the Pi must **not** paste these names into the analyser's
input; they travel as untrusted `mentionNames` for the server to check against
the roster. So the blast radius is "the server sees one fewer lookup key",
not "the analyser is misled".

### 2.10 `sock.logout()` is not `client.destroy()`

`client.destroy()` closes a browser. `sock.logout()` **unlinks the device and
destroys the session**, which means a re-pair. The shutdown path must call
`sock.end(undefined)`. Getting this wrong on a SIGTERM during a deploy would
turn every deploy into a re-pair. Pin it with a source-level test that bans
`.logout(` from the driver.

### 2.11 Protobuf `Long` will bite at least twice

`messageTimestamp` is `number | Long`, and so is `fileLength` on media nodes.
`safeTimestampSec` and the synthetic-id hash both assume a number, and a
`Long` stringifies to something else entirely, which would make the synthetic
id non-deterministic across the two shapes. Normalise once, at the edge, with
a tested helper: `typeof v?.toNumber === "function" ? v.toNumber() : Number(v)`.

### 2.12 Poll votes are encrypted, and `getMessage` is needed for more than polls

`client.on("vote_update")` handed us a decrypted vote. Baileys does not. Votes
arrive on `messages.update` as `pollUpdates`, and
`getAggregateVotesInPollMessage({ message, pollUpdates }, meId)` needs the
**original poll message**. That is what the `getMessage(key)` socket option is
for.

**`getMessage` is not optional even if we drop polls.** HomeTenant supplies it
for a different reason: it lets Baileys re-encrypt a message when a
recipient's phone asks for a retry. Without it, the recipient sees "waiting
for this message" forever. Their implementation is a bounded 500-entry
`Map<id, proto.IMessage>` of messages **we sent**, populated from the
`WAMessage` that `sendMessage` returns.

We need the same map, and for polls we keep the poll's entry pinned. It does
not need to be a general message store.

If poll voting slips, MoM polls degrade to app-only voting, which is a known,
bounded loss.

### 2.13 Defaults and log hygiene that will bite

- **`markOnlineOnConnect` defaults to `true`.** Leave it and the bot's phone
  stops receiving push notifications. Set it `false`.
- **`syncFullHistory` defaults to `true`** in rc14 (verified in
  `lib/Defaults/index.js:63`, alongside `emitOwnEvents: true` and
  `markOnlineOnConnect: true`). On a fresh pair that pulls a large history onto
  a Pi. HomeTenant sets it `false`. For us it is the only thing that could
  revive item 45, so decide deliberately, and pair it with
  `shouldSyncHistoryMessage`.
- **`printQRInTerminal` is deprecated** and does nothing but warn. Render the
  `qr` string ourselves.
- **Baileys writes auth key material into the log.** It logs pino-style,
  `logger.warn(object, "message")`, and some of those objects are the whole
  multi-device auth state: noise keys, Signal sessions, ratchet chain keys,
  registration ids, buffers. HomeTenant's first shim JSON-stringified them and
  put key material into a root-owned log file on the Pi. **Copy
  `HomeTenant/whatsapp-bot/src/baileys/logging.ts` more or less verbatim**: a
  600-character line cap, depth and field caps, buffers rendered as
  `<N bytes>`, an exact-match redaction set (`keys`, `creds`, `session`,
  `advsecretkey`, `registrationid`, `prekeys`, `secret`, `token`, `password`)
  plus a `/(key|keys|keypair|secret)$/` suffix rule, and a deliberate
  exception for `key` itself because `msg.key` is the useful part of an
  inbound log line.
- **The app-state-sync "parking" warning repeats endlessly** on a freshly
  linked device and there is nothing to do about it. HomeTenant demotes that
  one known pattern to `debug` and leaves every other warning alone.
- **Log rotation.** HomeTenant's `bot.log` reached 48 MB before rotation
  existed. Use `logrotate` with `copytruncate`, because systemd holds the file
  open in append mode.
- **Use the hand-rolled logger object, not pino.** Baileys' `ILogger` is
  structural and not re-exported from the package root; a plain object with
  `level`, `child: () => self`, and the six level methods satisfies it. That
  also keeps `pino` out of our own imports.
- **`npm ci`, never `npm install`, and never `--omit=dev`.** `tsx` is a
  devDependency and a runtime requirement.

### 2.14 Things we are choosing to drop

- `BOT_RECOVER_DM_REPLIES=1` (item 43). A one-shot tool, replaceable by a
  script against the database.
- `web-version.ts`, `.wwebjs_cache/`, `WA_WEB_VERSION*` (item 6).
- Most of `pair-phone.ts` (item 5).
- `group-snapshot.ts`'s page-evaluation path (item 39).
- `react-with-id.ts`'s page-evaluation path (item 32). The **pure** half
  (`planReaction`, `describeReactionFailure`, the synthetic-id skip) stays,
  because the failure taxonomy is still what the log needs.

Delete none of these until Phase 7. A rollback needs them.

### 2.15 The thing we cannot know from reading code

**Whether Baileys actually gives us the messages sent while the Pi was down,
and in what shape.**

The theory is sound: Baileys is a real linked device, so WhatsApp buffers and
replays. **HomeTenant is not evidence**, because it drops everything that
arrives with `type !== "notify"`, which is very likely how a replay arrives.
Its bot simply loses those messages and accepts it, because its recovery model
is a server-side outbox with leases. MatchTime has no such thing on the
inbound path: a player's "IN" typed during a deploy is gone if we do not catch
it.

This is the single item that most needs a real measurement. It is measured by
stopping a Baileys process attached to a throwaway group, posting three
messages, starting it, and counting what arrives and with which `type`. Ten
minutes of work on a throwaway number, and it decides whether
`recoverGroupMessages` can be retired or must be rebuilt on
`fetchMessageHistory`.

**Do not cut over before this measurement exists.** The Phase 5 PR
(2026-09-22) built the version that works IF the replay happens, and left the
`fetchMessageHistory` rebuild unbuilt on purpose, because nobody knows yet
whether it is needed. The runbook under Phase 5 says exactly what to read and
what each reading decides.

### 2.16 The dependency itself

- The package is **`baileys`**, not `@whiskeysockets/baileys`. Same repo, same
  versions, published within a minute of each other; `baileys` is the current
  name.
- `npm view baileys dist-tags` today: **`latest: 7.0.0-rc14`,
  `legacy: 6.7.24`**. A plain `npm i baileys` installs a **release
  candidate**. Pin the exact version, no caret.
- **HomeTenant runs `"baileys": "7.0.0-rc14"`, pinned exactly**, in
  production on the same Pi. Match it. One set of surprises, not two.
- **HomeTenant added no transitive dependencies at all.** `qrcode-terminal` is
  the only addition beyond Baileys, and we already have it. `pino`,
  `@hapi/boom`, `protobufjs`, `ws`, `libsignal` all arrive through Baileys.
- **`sharp` is a required, non-optional peer**, so npm installs it. It is the
  only platform binary in the tree and the arm64 glibc prebuild exists.
  `jimp`, `link-preview-js` and `audio-decode` are optional and should stay
  uninstalled (see §2.6).
- `whatsapp-rust-bridge` is **Rust compiled to WebAssembly, not a native
  addon**: one 2 MB JS file, no compile step. No arm64 prebuild risk.
- Baileys requires **Node >= 20**, enforced by a `preinstall` script. The Pi is
  on Node 20. Fine.
- Baileys is **ESM-only**. `whatsapp-bot` is already `"type": "module"` with
  `tsx`, so this costs nothing. Relative imports keep their `.js` extensions.

---

## 3. The phased plan

Every phase is independently revertible and every phase below Phase 6 is
invisible to Sutton FC.

### Scheduling constraint, non-negotiable

**Sutton FC is LIVE with real money and plays every Tuesday at 20:30.**

- No cutover, and no deploy of anything in this migration, **from Monday
  morning through Wednesday 06:00**. The roster messages, the bench offers and
  the pre-match reminder all land in that window, and the ratings DMs fire for
  up to 36 hours after kickoff.
- **The cutover window is Wednesday morning**, the day after a fixture, which
  leaves six clear days before the next one.
- The re-pair needs a human at a terminal. Book it.

### Phase 0: restore the current bot (Kemal, in progress, not this work)

Not ours. Named because every phase below assumes a working bot to compare
against and to roll back to.

### Phase 1: the connection, auth state, and inbound receipt (PR `feat/baileys-connection`)

The smallest thing that stands on its own.

- `whatsapp-bot/src/baileys/` as a new directory. **Nothing in
  `whatsapp-bot/src/index.ts` changes.**
- A second entry point run by a new `npm run start:baileys`. Not wired into
  systemd, not deployed.
- `useMultiFileAuthState` at a path resolved from env, defaulting to
  `.baileys_auth/`, created `mode 0700`, added to `.gitignore` next to
  `.wwebjs_auth/`, wrapped in `makeCacheableSignalKeyStore`.
- QR rendering, plus a `requestPairingCode` path called **once per socket**
  when unpaired.
- The reconnect policy of §2.8 as a pure function, plus the generation
  counter.
- The redacting, capped logger of §2.13.
- `messages.upsert` logging one `[baileys][msg]` line per message with the
  same fields the existing `[msg]` line carries, so the two can be compared
  side by side later, **and logging the `type`** so §2.15 can be measured.
- **No sends. No scheduler. No flush. No server calls.** It observes.

TDD, and the testable surface is most of it. Each of these is a pure module
with a failing test first: `jid.ts` (parse, classify, phone extraction, device
suffix, `hosted.lid`, the `0@s.whatsapp.net` rejection, and a cross-check
against Baileys' own `jidDecode`), `inbound.ts` (`normalizeMessageContent`
then `getContentType`, every wrapper shape, the whatsapp-web.js-compatible
type strings), `connection.ts` (the reason-to-action decision table),
`logging.ts` (redaction, caps, the `key` exception), `auth-path.ts`,
`timestamp.ts` (`number | Long`), `dedupe.ts` (bounded first-sighting set).
The socket itself is never opened (§4.2).

**Rollback:** delete the directory. Nothing imports it.

### Phase 2: the driver seam

Extract the interface that `index.ts`, `scheduler.ts` and `smart-analysis.ts`
actually use from a WhatsApp client. From the inventory that is roughly
`sendText`, `sendTextWithMentions`, `sendPoll`, `sendReaction`, `listGroups`,
`groupParticipants`, `selfIds`, `onMessage`, `onReaction`, `onPollVote`,
`onParticipantsUpdate`, `onOpen`, `onClose`, `close`.

**Implement it over whatsapp-web.js first**, and switch the existing bot to go
through it. A pure refactor, no behaviour change, and it is the step that
makes the swap a one-line decision later. HomeTenant has exactly this shape
(`src/core.ts` plus `src/drivers/baileys.ts` behind `WA_DRIVER`), and says the
split is what made their rollback real rather than aspirational.

**Rollback:** revert one PR.

### Phase 3: the Baileys driver, outbound half, plus the key serialiser

`serializeKey` / `parseKey` (§2.5) with their tests. Sends, mentions, quotes
and reactions against the interface. Every text through one helper that sets
`linkPreview: null` (§2.6). The bounded sent-message map for `getMessage`
(§2.12). Still not running anywhere.

**Rollback:** the driver is selected by env and defaults to whatsapp-web.js.

### Phase 3b: startup, identity and inbound on the Baileys driver (PR `feat/baileys-lifecycle-inbound`)

**Why this phase exists.** Phase 3's author found a gap: no phase owned the
driver's startup, its identity checks or message receipt. Phase 1 built those
pieces for a watch-only observer (`src/baileys/main.ts`), Phase 3 built the
sends, and Phase 4 covers groups. Nothing moved the socket lifecycle and the
inbound path into the driver itself, and without them a bot on Baileys could
send but never hear anybody. This is that phase.

Scope, all against the Phase 2 interface in `src/driver.ts`:

- **Lifecycle.** `start`, `close` (`end(undefined)`, never `logout()`),
  `onOpen` (fires on EVERY open, as `ready` already did: every reconnect and
  the `515` straight after pairing), `onClose` (fires on every close, so the
  timers stop and restart around a blip). The reconnect policy of §2.8,
  unchanged from Phase 1's `connection.ts`, now owned by the driver behind
  the generation counter. Two additions whatsapp-web.js never needed:
  - **a logged-out latch.** A `401` exits without reconnecting AND writes a
    marker into the auth folder, so the next start refuses to connect with
    the dead session instead of looping through systemd. Recovery is the
    re-pair runbook: move the folder aside, never delete it.
  - **a pairing-code budget**, persisted in the auth folder so it survives
    restarts: one request per socket (Phase 1's rule), at least a minute
    apart, at most five in any hour. Past the budget the bot shows the QR
    instead. Hammering `requestPairingCode` risks the number itself.
- **Identity.** `selfId`, `selfIdentities` and `selfIds` from `sock.user`,
  device suffix stripped, in whatsapp-web.js spelling (`@c.us`, `@lid`) so
  every comparison above the seam still compares like with like. Kept as
  three members, not collapsed (see the driver's header for why).
- **Inbound.** `onMessage` hands up a whatsapp-web.js-shaped view of each
  `WAMessage` (so `wa-read.ts`, `message-id.ts` and `enqueueForAnalysis`
  read it unchanged) with the raw message kept for `replyTo`. `onReaction`
  hands up `{ msgId, senderId, reaction }`, with a DM target converted to
  the phone form the database stored before it is serialised.
  `contactOf` and `getContact` answer from names HARVESTED off inbound
  messages and `contacts.upsert`, never from a network lookup (§2.2, §2.9).
- **The `degraded.ts` contract.** A reaction whose target cannot be mapped
  to the stored id is handed up with no `msgId`, which is exactly the shape
  `index.ts` already records as `reaction-forwarding` degraded, so it
  reaches the heartbeat like a whatsapp-web.js failure does.

Still refused at the time of Phase 3b: groups, participants, join and leave,
polls (Phase 4) and the restart replay (Phase 5 decides).
`WA_DRIVER=baileys` stays unselectable. **All three have since landed:**
Phase 4 built the groups half, and the Phase 5 PR built the restart replay
and made `WA_DRIVER=baileys` selectable **in shadow mode only**.

**The offline-replay measurement, to be run FIRST in Phase 5.** This phase
logs one `[baileys][msg] upsert=<notify|append>` line for every message,
including duplicates and skipped types, with its `age=` in seconds, and
filters nothing on `type`. So the measurement is a reading, not a build:

1. Link the throwaway number with the Baileys driver (or the Phase 1
   observer) in the Phase 5 test group. Post one control message and confirm
   its `upsert=notify age=0s` line.
2. Stop the process with SIGTERM (it calls `end`, never `logout`). Note the
   time.
3. While it is down, post three numbered texts ("offline 1", "offline 2",
   "offline 3") from two different phones, at least one of them a
   privacy-mode (`@lid`) member; react to one of the bot's earlier messages;
   and send the bot a DM.
4. Wait **two minutes**, start the process, and capture every
   `[baileys][msg]` and `[baileys][reaction]` line for five minutes.
5. Record, per message: did it arrive, with which `upsert=`, with what
   `age=`, and did it arrive more than once. Same for the reaction and the
   DM.
6. Repeat with a **30-minute** gap and a **3-hour** gap (beyond
   `recoverGroupMessages`' two-hour window).

Decision rule. All three arrive every time: `recoverGroupMessages` retires
under Baileys. They arrive as `append`: keep forwarding `append` (this phase
does) and decide whether old `append` messages need an age gate before the
analyzer. Any go missing: rebuild the replay on `fetchMessageHistory`.

**Corrected 2026-09-22, in the Phase 5 PR.** The sentence that used to close
this paragraph said every Baileys `open` records `message-recovery` degraded
because the driver refuses `fetchRecentGroupMessages`. That is no longer
true and would have been the wrong design anyway: a CRITICAL line on every
quiet restart, which on a club that plays once a week is most of them, is how
a log stops being read. The member now answers from the live delivery buffer
(`src/baileys/replay.ts`) after a settle window, and the honest signal is the
numbers it reports rather than a throw. See the decision table under Phase 5.

**Rollback:** as Phase 3. The driver is still unselectable.

### Phase 4: groups, participants, join and leave, polls

`groupFetchAllParticipating`, `groupMetadata` with our own
`cachedGroupMetadata`, `group-participants.update`, `groups.upsert`, the
`storeLIDPNMappings` call on every sweep (§2.7), and the poll decryption path
(§2.12).

**As built (PR `feat/baileys-groups-polls`), and two corrections to this
plan found in rc14's source:**

- **§2.12 is wrong about how votes arrive.** rc14's vote decryption in
  `lib/Utils/process-message.js` is commented out; nothing ever emits
  `pollUpdates` on `messages.update`. A vote is an ordinary
  `messages.upsert` carrying an encrypted `pollUpdateMessage`, and we
  decrypt it (`baileys/polls.ts`) against the poll we sent. Which JIDs the
  voter's phone signs with (phone or LID) cannot be read from code, so all
  candidate pairs are tried; GCM authentication makes that safe. Polls are
  archived on disk so a restart does not cost the votes still to come.
- **§2.9 point 2 is wrong about names.** `extractGroupMetadata` gives each
  participant `id`, `phoneNumber`, `lid`, `username` and `admin`, and no
  `name` or `notify`. Names still come only from `pushName` and
  `contacts.upsert`; they now persist across restarts.
- Rosters reach `index.ts` in phone form wherever WhatsApp gave a phone. A
  roster read younger than 15 minutes is served from a cache kept exact by
  `group-participants.update`, so a flapping line does not re-read every
  roster on every reconnect.
- The pre-cutover phone gate is `whatsapp-bot/scripts/measure-group-phones.ts`.

**Rollback:** as Phase 3.

### Phase 5: shadow run, on a throwaway number, in a throwaway group

A second WhatsApp number, linked to a Baileys process, in a test group with
Kemal and one or two willing testers. **Receive-only: scheduler off, flush
off, sends hard-disabled at the driver.** It logs what it would have done.

**The mode is built (PR `feat/baileys-shadow-mode`, 2026-09-22).** Nothing
below needs code work; it needs a SIM.

The measurements that only exist here:

1. **the offline-replay question and its `type`** (§2.15), by the exact
   experiment written out under Phase 3b, run before anything else;
2. `@lid` to phone resolution through all four paths of §2.7, with a real
   privacy-mode member;
3. a reaction round-trip, both directions, including on a message from before
   a restart. **HomeTenant has never sent one**, so this is unproven;
4. an outbound mention actually tagging somebody. Also unproven;
5. a poll vote decrypting;
6. `group-participants.update` on a real add and a real remove;
7. history behaviour when the bot is added to a group while connected
   (item 45);
8. Pi memory and CPU without Chromium.

Run it for at least one full week, including a deliberate stop and start.

**Rollback:** turn it off. It never touched Sutton.

---

#### How shadow mode is enforced

Two environment variables, and a refusal that lives below every caller.

| variable | meaning |
|---|---|
| `WA_SHADOW=1` | receive-only. Required. |
| `WA_DRIVER=baileys` | use Baileys. **Refused unless `WA_SHADOW` is also on.** |
| `WA_SHADOW_GROUP=<jid>@g.us` | optional; the group the one diagnostic read asks about. |
| `BAILEYS_AUTH_DIR=<path>` | the throwaway session. Never the live one. |
| `WA_PAIR_PHONE=<digits>` | optional; pair by code instead of QR. |

- **Sends are refused at the driver**, not at the caller.
  `driver-select.ts` wraps whatever driver it builds in `shadowGuard`
  (`src/shadow.ts`), a Proxy that intercepts every member named in
  `SHADOW_SEND_MEMBERS`. Six of the seven throw `ShadowModeSendRefused`;
  `sendReaction` returns `{ok:false, reason:"shadow-mode"}`, because its
  contract is that it never throws. Every refusal is counted and logged as
  `[shadow] REFUSED <member>: <what it would have done>`.
- **It cannot be outgrown.** `shadow.source.test.ts` reads the `Outbound`
  section of `src/driver.ts` and fails if a member exists there that the
  guard does not name. Adding a send to the interface without covering it
  is a red test, not a silent hole.
- **It cannot be gone around.** The unwrapped driver never leaves
  `createDriver`, and `driver-seam.test.ts` already forbids every module
  outside `src/drivers/` and `src/baileys/` from importing a WhatsApp
  library or touching a client.
- **Server writes are refused too**, at `api.ts`'s single `apiFetch`. This
  matters more than it sounds: a reaction, a poll vote, a DM reply and above
  all a self-add (`bot-added`) are forwarded straight from their inbound
  handlers, so a shadow number added to a throwaway group would otherwise
  create a real onboarding session in production. A refused write returns a
  200 carrying `{"shadowMode":true}`, so callers take their ordinary quiet
  path. GETs are left alone.
- **`index.ts` starts nothing that acts**: no scheduler, no batch-flush timer
  (and so no heartbeat, which would otherwise pollute the live Pi's health
  signal), no org refresh, no participant sweep, no restart catch-up. Inbound
  is fully wired, which is the entire point.
- **`WA_DRIVER=baileys` without `WA_SHADOW` throws**, naming the shadow run
  and the phone gate. Running Baileys for real is a deliberate edit to
  `driver-select.ts` after this week, not an env var.

#### Running it: the steps

Do this on a machine that is **not** the Raspberry Pi serving Sutton FC. A
laptop is fine. If it has to be the Pi, use a second checkout, a second auth
directory and a different `MT_BAILEYS_LOCK_PATH`, and never
`scripts/deploy-pi.sh`.

1. **Get the second number onto a phone** and install WhatsApp on it. Add
   Kemal and one or two testers to a new group, e.g. "MT shadow". At least
   one member must have **privacy mode on** (so they appear as `@lid`), or
   measurement 2 is not measured.
2. **Check out and install:**
   ```bash
   git clone git@github.com:kemalediz/matchtime.git mt-shadow
   cd mt-shadow/whatsapp-bot
   npm ci            # never npm install, never --omit=dev: tsx is a runtime need
   ```
3. **Write `whatsapp-bot/.env`:**
   ```bash
   WA_DRIVER=baileys
   WA_SHADOW=1
   BAILEYS_AUTH_DIR=/absolute/path/to/.baileys_shadow_auth
   WA_BAILEYS_LOG_LEVEL=info
   # Optional: pair by code instead of QR. Digits only, no "+".
   # WA_PAIR_PHONE=447700900123
   # Optional: the group the one diagnostic read asks about (step 7).
   # WA_SHADOW_GROUP=120363000000000000@g.us
   # API_URL / API_KEY can point at production. Every write is refused.
   ```
4. **Start it and watch for the banner:**
   ```bash
   npm start 2>&1 | tee shadow.log
   ```
   The first lines must include `SHADOW MODE IS ON (WA_SHADOW=1). Driver:
   baileys.` **If that banner is absent, stop.** Something is wrong and the
   process is not guarded.
5. **Link the device.** A QR appears in the terminal, or a pairing-code
   banner if `WA_PAIR_PHONE` is set. WhatsApp on the second phone: Settings,
   Linked devices, Link a device (or Link with phone number). Codes expire in
   a couple of minutes; a restart issues a new one, and the budget is one per
   socket, a minute apart, five an hour.
6. **Confirm it is alive.** Expect `connection: "open"`, then
   `WhatsApp bot is ready!`, then the group listing with the shadow group in
   it, then `[shadow] receive-only: not starting the scheduler…`.
7. **Put the group JID in `WA_SHADOW_GROUP` and restart** once you can read
   it off the listing. That is what arms the one diagnostic read in step 4 of
   the first experiment.

#### The experiments, in order

**Experiment 1 comes first and everything else waits for it.** It is the only
one that can change what still has to be built.

---

**1. The offline replay (§2.15). Does WhatsApp give us the gap, and as what?**

This is the plan's single most important unknown. Run it three times, with a
gap of **2 minutes**, then **30 minutes**, then **3 hours** (past the
catch-up's two-hour window).

1. With the bot running, post one control message in the shadow group.
   Confirm a line like
   `[baileys][msg] upsert=notify chat=…@g.us id=… age=0s`.
2. Stop the process with `SIGTERM` (Ctrl-C once, or `kill <pid>`; it calls
   `end`, never `logout`). **Note the time.**
3. While it is down: post **three numbered texts** ("offline 1", "offline 2",
   "offline 3") from **two different phones**, at least one of them the
   privacy-mode member; **react** to one of the bot's earlier messages; and
   send the bot a **DM**.
4. Wait out the gap, start the process again, and capture five minutes of log.
5. Read, per message: **did it arrive**, with **which `upsert=`**, with what
   **`age=`**, and **did it arrive more than once**. Same for the reaction and
   the DM.

What to grep for, and what each line means:

```bash
grep '\[baileys\]\[msg\]' shadow.log        # every message, type and age, nothing filtered
grep '\[baileys\]\[reaction\]' shadow.log   # every reaction
grep '\[baileys\]\[history\]' shadow.log    # what the restart catch-up was handed
grep '\[shadow\] REFUSED' shadow.log        # anything that tried to send or write
```

The `[baileys][history]` line is the same question answered in the shape the
real catch-up sees. With `WA_SHADOW_GROUP` set it is printed once per open:

```
[baileys][history] <group>: served N of the last 50 from the live buffer
  (holding M) | since this open: notify=… append=… | whether WhatsApp replays
  messages sent while the bot was down is the plan's open measurement (§2.15) …
[shadow] the restart catch-up would have been handed N message(s) for <group>.
```

**The decision rule.** It is unchanged from Phase 3b, and it decides code:

| what the log shows | what it means | what to do |
|---|---|---|
| all three arrive every time, `upsert=notify` | WhatsApp replays as live traffic | `recoverGroupMessages` can retire under Baileys; the live buffer serves it anyway |
| all three arrive, `upsert=append` | replay is a distinct type | keep forwarding `append` (the driver does), and decide whether OLD `append` messages need an age gate before the analyser |
| some or all missing, `served 0`, `since this open: none` | **WhatsApp replays nothing** | the catch-up must be rebuilt on `sock.fetchMessageHistory` before cutover |
| anything arrives twice | duplicate delivery | check `duplicates` in `stats()`; the driver dedupes by `chat|id`, so this should already be counted and not handed up again |

**What was built for the "rebuild" branch, and what was not.**
`fetchRecentGroupMessages` now answers from `src/baileys/replay.ts`, a
bounded per-chat buffer of everything the socket delivered, after a
**10-second settle window** measured from the last open (the catch-up runs
inside `index.ts`'s open handler, so an immediate answer would race the very
delivery it is collecting). That is the version that works **if** the replay
happens. It does **not** call `fetchMessageHistory`, deliberately, because
nobody knows yet whether it is needed. If the table above sends us down the
rebuild branch, the mechanism in rc14 is:
`sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)` returns a
**request id** and delivers **asynchronously** on `messaging-history.set`
with `syncType = ON_DEMAND` and `peerDataRequestSessionId` set to that id.
`processHistoryMessage` also carries LID/PN mappings out of it. That path
fetches messages **older** than the anchor key, so the anchor is the newest
message we hold, or a synthetic anchor at "now".

`fetchRecentGroupMessages` deliberately does **not** throw when it has
nothing. Throwing would record `message-recovery` degraded on every quiet
restart, which on a club that plays once a week is most of them, and a
CRITICAL line that cries wolf every deploy is how a log stops being read. The
honest signals are the numbers: `historyServed`, `historyEmpty` and
`sinceOpen` on the driver's `stats()`, and the `[baileys][history]` line.

---

**2. `@lid` to phone resolution (§2.7).** Have the privacy-mode member post.
Expect `[baileys][msg] … sender=<lid> phone=<digits>(<source>)`, where
`<source>` names which of the four paths answered. A line reading
`sender UNRESOLVED` is the failure, and it is logged CRITICAL. Then add and
remove that member (experiment 6) and see whether a roster read resolves them.

**3. Reactions, both directions.** Have a tester react to a message. Expect
`[baileys][reaction] <emoji> from=… on=<id>`. `on=UNRESOLVED` is the failure
and is logged CRITICAL. Outbound reactions cannot be observed in shadow mode:
they appear as `[shadow] REFUSED sendReaction: react ✅ on <id>`, which proves
the id was parsed and the emoji chosen but not that WhatsApp accepts it.
**Outbound reactions and mentions are the two things this week cannot fully
prove; they are proved on the cutover morning, Phase 6 step 5.**

**4. Outbound mentions.** Same limitation: the log shows
`[shadow] REFUSED sendTextWithMentions: post in … tagging N (…)`. What it
does prove is that the bot picked the right people.

**5. Poll votes.** A poll cannot be sent in shadow mode, so this one needs a
poll that already exists: have a human post a poll in the shadow group and
vote. The driver decrypts votes only against polls **it** sent, so expect the
CRITICAL `a vote on poll … could not be read` line. That is correct
behaviour, not a bug, and it means **poll decryption is the one measurement
Phase 5 cannot make.** It is made on the cutover morning instead, or by a
deliberate one-off with the guard lifted by hand and a human watching.

**6. Joins and leaves.** Add somebody to the shadow group, then remove them.
Expect `[baileys][groups]` lines and the roster cache staying exact. Confirm
`[shadow] REFUSED server write /api/whatsapp/group-join` rather than a real
POST.

**7. History on join (item 45).** Remove the bot from the group and add it
back while it is connected. Read the `[baileys][history]` line that follows.
A probable loss; this is where it is confirmed.

**8. Memory and CPU.** `ps -o pid,rss,%cpu -p <pid>` daily. Compare with the
whatsapp-web.js process on the Pi (which carries Chromium). Expect a large
drop; record the number, because it is the argument for the migration.

#### The phone gate, and where it fits

`whatsapp-bot/scripts/measure-group-phones.ts` is a **separate, one-off
read**, and it is about **Sutton's** group, not the shadow group. It answers
the question the shadow week cannot: when Baileys reads Sutton's roster, does
it get a phone for every member MatchTime already knows, or do some come back
as `@lid` with no mapping? A member who comes back unresolved is a player
whose attendance would stop being attributed after the cutover.

It takes the Baileys process lock and it never sends, so it is safe to run
beside the live whatsapp-web.js bot (a different linked device), but **not**
beside the shadow process or the Phase 1 observer on the same auth directory.

Run it **after the shadow week and before Phase 6**, from a checkout that has
a paired Baileys session:

```bash
cd whatsapp-bot
# One phone per line, E.164 digits. Export with a READ-ONLY query.
node --env-file=.env --import tsx scripts/measure-group-phones.ts \
  --group=<Sutton's group JID> --known-phones=sutton-phones.txt
```

Exit codes: 0 report printed, 1 bad arguments or the group read failed, 2 the
line never opened. **Any unresolved member is a cutover blocker until it is
explained.**

#### Finishing the week

- Keep `shadow.log`. The §2.15 verdict, the memory numbers and the unresolved
  count are the evidence Phase 6 rests on.
- Write the verdict into this document, under §2.15, as a fact with a date.
- If the replay did not happen, **build the `fetchMessageHistory` path before
  the cutover**. It is the one thing that can still be missing.
- Then, and only then, edit `driver-select.ts` so Baileys can run without
  `WA_SHADOW`. That edit is Kemal's decision and it is the last thing before
  Phase 6.


### Phase 6: cutover

**Wednesday morning.** One writer, always.

1. `scripts/deploy-pi.sh` stop. Confirm zero processes.
2. Back up `.wwebjs_auth/` to a tarball off the Pi. It is the rollback.
3. Confirm `deploy-pi.sh` cannot delete or rsync away `.baileys_auth/`, and
   that no recursive delete touches it.
4. Set the driver env var to `baileys`. Start. Link the device with a human
   watching.
5. Verify, in order: `connection: "open"`, group enumeration lists Sutton FC,
   the participant sweep posts a non-empty roster, a test message in the group
   produces a `[smart] flush` line, a reaction lands, the heartbeat reaches the
   server.
6. Send one real message end to end and confirm the tick appears.
7. Watch for 24 hours.

**Rollback, at any point:** stop, flip the env var back, restore
`.wwebjs_auth/`, start, re-link if WhatsApp has expired the old session.
The old code path is still present and still the default until Phase 7. Budget
for the possibility that the old session needs re-pairing too: HomeTenant warns
that WhatsApp drops a companion device that has been idle for weeks.

### Phase 7: remove whatsapp-web.js

**Only after two clean match weeks.** Delete `whatsapp-web.js`,
`web-version.ts`, `.wwebjs_cache/`, the pinning env vars, `pair-phone.ts`'s
workaround half, and the page-evaluation paths in `group-snapshot.ts`,
`react-with-id.ts` and `bot-added.ts`. Remove Chromium from the Pi. Rewrite
`degraded.ts`'s consequence wording for the new causes. Update the three
outage MDs to point here.

---

## 4. Testing, without spending money

**No live-LLM suite is needed for any part of this migration, at any phase.**
The model sits behind `/api/whatsapp/analyze` on the server. This work changes
the transport that delivers a message to that endpoint and does not touch a
single prompt, router, extractor or composer. Per `CLAUDE.md`, the approval
rule's first condition is not met, so the question does not arise.

### 4.1 What is free and stays mandatory

- `cd whatsapp-bot && npm test` (vitest). Zero model calls. Every new module
  ships with tests, written first.
- `npm run test:unit` at the repo root. Zero model calls.
- `npm run test:e2e` (Playwright, with its embedded Postgres). Zero model
  calls.
- `npm run test:sim` (the group simulator at `e2e/sim`). **The non-`-live`
  specs make no model calls.** They exercise the server-side pipeline, which
  this migration does not touch, so they are the regression net that proves we
  broke nothing on the far side of the HTTP boundary. They do not and cannot
  test the WhatsApp layer.

### 4.2 How to prove the WhatsApp layer offline

**No test may ever open a socket.** HomeTenant writes the reason into its own
test file: a lookup from the production account got every linked device
unlinked on 2026-09-17. Their technique is worth copying in full, and it is
four things.

**(a) Pure modules with injected dependencies.** The driver file owns only the
socket wiring; every decision lives in a pure module with its dependencies
passed in (`getPNForLID` as a `vi.fn()`, a fake clock, a `fetch` stand-in, a
`Set` for the mapping store). That single choice is what makes essentially
100% of the behaviour testable without a connection.

**(b) Protobuf fixtures built with Baileys' own classes.**

```ts
function wa(message: Record<string, unknown> | null, key: Partial<proto.IMessageKey> = {}): WAMessage {
  return {
    key: { remoteJid: "447700900123@s.whatsapp.net", fromMe: false, id: "3EB0C0FFEE", ...key },
    message: message === null ? null : proto.Message.fromObject(message),
    messageTimestamp: 1758100000,
    pushName: "Sam",
  } as WAMessage;
}
```

`proto.Message.fromObject` validates field names against the real schema, so a
typo fails the test instead of silently passing, and it produces real
protobuf `Long`s so §2.11 is exercised honestly. Both imports come from
`baileys` itself and neither needs a socket.

**(c) A source-level invariant test.** Read the driver's source, strip
whole-line comments, and assert on the text. Each assertion encodes a past
incident and names it. Ours would assert: never `.logout(`, never
`rm`/`rmSync`/`unlink` near the auth dir, `markOnlineOnConnect: false` is
present, `onWhatsApp` / `getLIDForPN` / `getLIDsForPNs` appear **zero** times
(§2.2), every outgoing text goes through the `linkPreview: null` helper and a
bare `{ text }` appears nowhere (§2.6), and the inbound drop filter runs
before the sender resolution. The five usable techniques are: count call
sites, assert proximity between two calls, assert ordering by `indexOf`, slice
one function out by name and assert inside it, and ban an API or literal shape
outright. Brittle on purpose.

**(d) A fake socket** implementing the small surface we use (`ev.on`,
`ev.off`, `sendMessage`, `groupMetadata`, `groupFetchAllParticipating`, `user`,
`signalRepository.lidMapping`, `requestPairingCode`, `end`), driven by
payloads recorded during Phase 5. That proves the full inbound path reaches
`enqueueForAnalysis` with the right body, phone, name and id, for every message
shape, and that a reaction produces the right `{ react: { text, key } }`.

Together these prove offline: every inbound shape; the reconnect policy per
status code; `serializeKey(parseKey(s)) === s` for every id format in the
database; that shutdown calls `end` and never `logout`; that every on-open
action is idempotent when fired twice; and that the log redacts key material.

### 4.3 What genuinely needs a real WhatsApp group

These cannot be faked, and all of them belong in Phase 5 on a **throwaway
number in a throwaway group, never Sutton's**: the eight measurements listed
under Phase 5.

Note that three of them (reactions, outbound mentions, group participants)
have **no HomeTenant precedent at all**, which is precisely why Phase 5 is not
optional.

### 4.4 The gates for every PR in this migration

`npx tsc --noEmit` in both the repo root and `whatsapp-bot`, `npm test` in
`whatsapp-bot`, `npm run test:unit` and `npm run test:e2e` at the root, and
`npm run lint`. All free. All run by the reviewer, not taken on the author's
word.

---

## 5. Honest sizing

Large. This is not a week.

| phase | size | note |
|---|---|---|
| 1, connection, auth, inbound | 1 to 2 days | mostly pure helpers and their tests; the logger and reconnect modules are near-copies of HomeTenant's |
| 2, driver seam | 2 to 3 days | a refactor across `index.ts`, `scheduler.ts`, `smart-analysis.ts`; the riskiest *code* change, because it touches the working bot |
| 3, outbound, key serialiser, link previews, `getMessage` | 2 days | |
| 3b, lifecycle, identity, inbound | 1 to 2 days | the gap Phase 3 found; added 2026-09-22 |
| 4, groups, participants, LID seeding, polls | 3 to 4 days | **no HomeTenant precedent for any of it**; the poll path is the fiddly part |
| 5, shadow run | **1 week of wall-clock**, a day of work | the calendar, not the code, is the constraint |
| 6, cutover | half a day, plus 24h watching | needs a human for the link |
| 7, removal | 1 day | after two clean match weeks |

**Roughly two to two and a half weeks of engineering across four to five
calendar weeks**, with the shadow week and the two clean match weeks setting
the floor. Anyone promising a cutover this week is not counting Phase 5, and
Phase 5 is the part that stops us finding out about §2.15 in production.

**What could be done faster, if the outage forces it:** Phases 1, 3 and 4
without Phase 2's seam, cutting over by swapping `index.ts` wholesale behind an
env var. That saves two or three days and costs the ability to roll back
cheaply, because there would then be two divergent copies of the inbound
handler. **Not recommended**, but it is the lever if the current outage cannot
be restored at all.

---

## 6. Open questions for Kemal

1. **The throwaway number for Phase 5.** Do we have a spare SIM or eSIM we can
   link? If not, Phase 5 would have to run against the MatchTime number in a
   throwaway group after the cutover, which means no shadow week.
   **Status 2026-09-22: this is the only thing left.** Shadow mode is built,
   `WA_DRIVER=baileys` is selectable with `WA_SHADOW=1`, and the runbook under
   Phase 5 is written. A SIM, and the week can start the same day.
2. **Poll votes.** If they slip past the cutover, is MoM voting degrading to
   app-only for a week acceptable?
3. **The self-setup history capture** (item 45) is a probable loss and the
   onboarding flow that uses it has never fired. Confirm it can be dropped
   rather than rebuilt.
4. **Phase 2's seam:** worth two to three days of refactoring the working bot,
   or cut straight to a parallel `index.ts`?
5. **E.164 is dying as an identity key** (§2.7, last paragraph). Not caused by
   this migration and not fixed by it, but it is coming for MatchTime's
   phone-keyed identity. Worth its own piece of thinking, separately.
