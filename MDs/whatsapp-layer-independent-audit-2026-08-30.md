# Independent audit: the WhatsApp injected layer

**Date:** 2026-08-30
**Scope:** read-only. No source file was changed.
**Baseline:** `HEAD = ba5f46f` (PR #13 merged). A concurrent agent has
untracked WIP at `whatsapp-bot/src/wa-read.ts` / `wa-read.test.ts`; my
findings are against `ba5f46f` and I note where that WIP overlaps.
**Installed library:** `whatsapp-bot/node_modules/whatsapp-web.js` @ `1.34.6`.

---

## 0. Headline verdicts

1. **The framing "pinning is futile because the archive only has newer
   builds than the library declares" is wrong.** `webVersion:
   '2.3000.1017054665'` (`Constants.js:10`) is a dead constant on this
   deployment — see §5. The bot has *never* run that build. Pinning is a
   cheap, reversible, worth-doing-today experiment. It is not a stable
   state.
2. **The "IN" fix (PR #13) is incomplete, and the hole is exactly where you
   suspected.** A message that loses `authorName` cannot be attributed,
   registers no attendance, returns HTTP 200, and is *excluded by
   construction* from the admin queue built to catch this. Definitive
   answer with citations in §3.
3. **The mitigations are the right instinct applied one layer too low.**
   They make the Pi survive. They do not make the *product* survive,
   because the server silently discards what the Pi now successfully
   delivers. Three of them also have real defects (§4).
4. **The single biggest problem is not the injected layer at all — it is
   that every failure signal is a `console.error` on a Raspberry Pi that
   nobody reads.** There is no heartbeat, no server-side staleness check,
   no alert. That is why August cost three days. Nothing merged so far
   changes it.
5. **Upgrading `whatsapp-web.js` will not help.** Upstream has 6 commits in
   the 4 months since 1.34.7, none touching the injected page code (§5).

---

## 1. What actually broke — mechanism, with evidence

`whatsapp-web.js` injects `window.WWebJS.*` helpers written against
WhatsApp's minified internals (`src/util/Injected/Utils.js`) and a
`window.Store` module map built by name lookups (`src/util/Injected/Store.js:45+`).

**The Store map is still resolving.** If `ExposeStore` threw, `inject()`
would reject and the client would never emit `ready` (`Client.js:235-251`).
The bot *is* ready and *does* deliver messages. So this is not a wholesale
injection failure: specific runtime calls moved, the module map did not.

**Two concrete, code-level explanations for the two headline symptoms.**

**(a) `sendMessage()` delivers but returns `undefined`.**
`Utils.js:363-368`:

```js
const [msgPromise, sendMsgResultPromise] =
  window.Store.SendMessage.addAndSendMsgToChat(chat, message);
await msgPromise;
if (options.waitUntilMsgSent) await sendMsgResultPromise;
return window.Store.Msg.get(newMsgKey._serialized);
```

The send happens on line 363. The return value is a *separate lookup* of
the just-sent message by `newMsgKey._serialized`. If WhatsApp changed how
`MsgKey` serialises or how `Store.Msg` is keyed — which is precisely what a
LID-addressing migration does (note `Utils.js:249-252`, which already
branches on `chat.groupMetadata.isLidAddressingMode`) — that `get` returns
`undefined`, `Client.js:1098-1100` returns `undefined`, and the message is
already in the customer's group. **This is a lookup failure after a
successful send, not a send failure.** That matches the reported symptom
exactly.

**(b) `msg.id._serialized` unreadable.**
`Message.js:36` is `this.id = data.id` — a plain assignment, not a getter.
`Utils.js:559-561` then does `if (typeof msg.id.remote === 'object')`,
which does **not** throw if `msg.id` is a string. So the most likely
explanation is not that the id is *gone* but that **`msg.id` arrives as a
string rather than the `{fromMe, remote, id, _serialized}` object**.

This matters enormously, because `resolveWaMessageId` cannot see it:

- `message-id.ts:108` — `read(read(msg, "id"), "_serialized")`
- `message-id.ts:60-67` — `read()` returns `undefined` for any non-object

**So if `msg.id` is a string, the real WhatsApp id is sitting in hand and
the code throws it away to hash a synthetic one.** That would also explain
why reactions vanished silently — `Message.react` (`Message.js:409-417`)
passes `this.id._serialized`, which for a string id is `undefined`, and the
injected function returns `null` at line 411 **without throwing**. The
`try/catch` at `smart-analysis.ts:511-516` therefore logs nothing. A
completely silent no-op.

> ⚠️ **I could not verify (a) or (b) against the live page** — that needs
> one diagnostic line on the Pi. See §7 R0. Both are code-supported
> hypotheses, not observations. If (b) holds, the highest-value fix in this
> whole report is four lines long and restores reactions, correct dedupe,
> bench-offer mapping and MoM poll mapping at once.

**On the minified `r`:** I cannot identify it from the repo. It is a
WhatsApp-internal minified error escaping `pupPage.evaluate`. Not
diagnosable without the live page; do not spend time on it.

---

## 2. Dependency audit — every injected-layer call, and what it costs

Legend for **Silent?**: *to users* means the club sees nothing; *to logs*
means not even the Pi log says anything.

| # | Call | file:line | Product rule served | Failure today | Silent? |
|---|---|---|---|---|---|
| 1 | `client.getChats()` | `index.ts:143` | startup group enumeration | throws `r` (observed) | No — CRITICAL logged (`index.ts:158-168`) |
| 2 | `client.getChatById()` + `.participants` | `index.ts:233-237` | participant sync / lurker backfill | throws `r` (observed) | No to logs, **yes to users** — new members never provisioned, @lid→phone never learned |
| 3 | `client.getContactById()` | `index.ts:253,263,706,716,817,889` | @lid → phone + pushname | swallowed by bare `catch {}` | **Yes, entirely** — no log at all |
| 4 | `msg.getContact()` | `smart-analysis.ts:362-365` | **`authorName` on the analyze payload** | returns null via `enrichOrDegrade` | No to logs (CRITICAL at `smart-analysis.ts:290`), **catastrophic to users** — see §3 |
| 5 | `client.getContactById(jid).isMe` | `smart-analysis.ts:384` | `botMentioned` → **all tag-gated commands** | `enrichOrDegrade` returns `botMentioned:false` | **Yes to users.** Server fallback `messageTagsBot` (`interaction-contract.ts:51-59`) only matches literal "match time" text; a tapped @-mention puts *digits* in the body (`index.ts:530-534`). So every tapped `@Match Time` command is ignored, and the mention-triggered immediate flush (`smart-analysis.ts:64`) never fires |
| 6 | `target.react(emoji)` | `smart-analysis.ts:513` | **✅ / 1️⃣-🔟 / 🪑 confirmation** | no-ops silently if `msg.id` is a string (`Message.js:416`) | **Yes, completely** |
| 7 | `client.sendMessage()` | `scheduler.ts:214,234,248,280`; `smart-analysis.ts:525`; `index.ts:923` | every outbound post, poll, DM, bench prompt | delivers, returns `undefined` | No — CRITICAL logged (`send-result.ts:71-81`). **But** `SentNotification.waMessageId` is left NULL |
| 8 | ↳ consequence of 7 | — | **bench offers (👍/👎) and MoM poll votes** | prompt/poll has no stored `waMessageId`, so the inbound `message_reaction` / `vote_update` can never be matched (`reaction/route.ts:40` looks up `where: { waMessageId }`) | **Yes to users** |
| 9 | `client.getMessageById()` | `scheduler.ts:299` | `update-reaction` (slot emoji refresh after a drop) | throws — a `synthetic:` id fails `params.length !== 3` at `Client.js:1253` | Near-silent (`console.warn`), then **ACKed anyway** (`scheduler.ts:308`) so it never retries |
| 10 | `chat.fetchMessages()` | `smart-analysis.ts:582`; `index.ts:752` | **outage recovery** (`recoverGroupMessages`) | `getChatById` throws first (observed) | No to logs, **yes to users** — no catch-up after any restart |
| 11 | `client.info.wid` | `index.ts:239,543,854,953`; `smart-analysis.ts:419` | self-identification | plain data (`ClientInfo.js:26`), **survives** | n/a |
| 12 | `msg.mentionedIds` | `smart-analysis.ts:281` | mention forwarding | plain data (`Message.js:194`), **survives** | n/a |
| 13 | `msg.reply()` | `index.ts:448` | non-text DM nudge | throws, caught | No |
| 14 | onboarding capture | `index.ts:692-830` | Phase-2 onboarding | all injected, degrades to `[]` | Gated off by `ONBOARDING_AUTOSTART`; not a live risk |
| 15 | `group_join`/`group_leave` | `index.ts:840-955` | auto-onboard / mark leaver | event data is plain, but `extractPhones` (`index.ts:672-679`) keeps only `@c.us`; @lid joins yield `[]` and return early | **Yes** |
| 16 | payments / collector DMs | `index.ts:466-514` | fee replies, OTPs | uses `_data.notifyName` (`index.ts:468`) — **injection-free**, plus a `getContact()` best-effort | Least exposed path in the codebase. Good. |

**Rows 11, 12 and 16 are the important ones.** They prove the codebase
already knows how to read WhatsApp data without touching the injected
layer — `_data.notifyName`, `mentionedJidList`, `client.info.wid` are all
plain properties. The inbound-analysis path simply doesn't use them.

---

## 3. Question 2 — definitive answer

> **Can a degraded inbound message be attributed to a user and register
> attendance?**

**No. It is silently discarded at the server, and it is invisible to every
mechanism built to catch exactly this.** The "IN" fix is incomplete.

Two independent degradations, and they compose:

- **`authorPhone` is lost** for any `@lid` sender — `phoneFromAuthor`
  (`smart-analysis.ts:211-217`) returns `""` for anything not ending
  `@c.us`. It is *also* lost for `@c.us` senders if `msg.author` is
  unreadable, because `safeRead` yields `undefined` and the function falls
  back to the **group** JID (`smart-analysis.ts:212, 237`), which never
  ends `@c.us`.
- **`authorName` is lost** whenever `msg.getContact()` throws —
  `inbound-enrich.ts:51` returns `authorName: null`.

### The server-side trace (`src/app/api/whatsapp/analyze/route.ts`)

| Step | Line | Keys on | With `phone === ""`, `authorName === null` |
|---|---|---|---|
| Validation | `142` | `groupId`, `messages` only | passes |
| Phone match | `1633-1643` | `User.phoneNumber` | **skipped** — `""` is falsy |
| Exact name | `1644, 1668-1675` | normalised `Membership.user.name` | **skipped** — guard is `msg.authorName && …length >= 2` |
| Fuzzy first-token / prefix | `1677-1696` | first name token | **skipped**, same guard |
| `UserAlias` (both branches) | `1705-1728`, `1736-1748` | `orgId_alias` | **skipped**, same guard |
| Auto-provision | `1757` → `1770` → `1888-1894` | name | `createProvisionalByName(orgId, null, "")` → `if (!name \|\| name.length < 3) return null` at **`1894`** → **nothing created** |
| Result | `1761-1763` | — | `{ userId: null, name: null, phone: null }` |

Then the attendance write:

- **`route.ts:2141`** — `if (verdict.registerAttendance && user)`. With
  `user === null` (set at `route.ts:1206`) the entire IN/OUT/BENCH block is
  skipped. No log, no throw, no marker.
- Both server-side backfill safety nets also require a resolved sender:
  IN at `route.ts:967-990` (`sender.userId &&` at `970`), OUT at
  `route.ts:1006-1012`.
- `Attendance.userId` is non-nullable with an FK (`prisma/schema.prisma:905-906`),
  `@@unique([matchId, userId])` at `:945`. There is no nullable-user path.

### And it is silent in the worst possible way — the safety nets exclude it

- **HTTP 200**, `{ok:true}` (`route.ts:1592-1597`), and `handledBy: "llm"`
  (`route.ts:1394-1401`). The bot cannot tell anything went wrong.
- **The "never silently drop an unresolved attendance message" nudge does
  not fire.** `route.ts:1319-1324`:

  ```ts
  if (!sender.userId && attendanceRelevant && nextMatchForReply &&
      (msg.authorName ?? "").trim().length >= 1)
  ```

  With `authorName === null` the length is 0. **The one mechanism written
  for this exact failure class is gated on the very field that
  degradation destroys.**
- **The admin unresolved queue excludes it by construction.**
  `src/app/api/admin/unresolved-count/route.ts:27` and
  `src/app/actions/unresolved.ts:47-55, 93-100` all require
  `authorName: { not: null }` alongside `authorUserId: null`. A nameless
  unresolved message never appears in the badge or the queue.
- **The provisional-review admin DM does not fire** either
  (`src/lib/bot-scheduler.ts:499-537`) — it keys on
  `Membership.provisionallyAddedAt`, and no provisional row was created.
- **Worse: the bot may still confirm it.** `executeVerdict` returns the
  LLM's `react`/`reply` unmodified when `user` is null (`route.ts:2826`,
  surfaced at `1394-1401`). `enforceCanonicalRoster` (`route.ts:1241-1246`)
  patches roster *numbers* to DB truth but not the acknowledgement
  sentence. So a player can be told "you're in" while nothing was written.
- **Exception, for completeness:** the third-party path
  `verdict.registerFor` (`route.ts:2213-2291`) does *not* require a
  resolved sender. "Najib is in" still registers Najib. Only the sender's
  *own* IN/OUT is lost.

### Practical severity right now

Two regimes, and I cannot tell from the repo which one Sutton is in:

- **`@c.us`-addressed group** — `msg.author` is a phone JID, phone
  resolution at `route.ts:1633` works, attendance is recorded. Only `@lid`
  privacy members are silently lost. **Partial, ongoing, invisible loss.**
- **LID-addressed group** (WhatsApp's LID migration is a prime candidate
  for "the frontend change during the pause", and `Utils.js:249-252` shows
  the library already branches on `isLidAddressingMode`) — *every*
  sender's author is `@lid`, phone is `""` for everyone, and with
  `authorName` degraded **no one's attendance is recorded at all**, exactly
  as before PR #13, with the same total silence.

**The single cheapest fix closes both regimes.** `index.ts:568-578` already
computes `authorName` from `msg._data.notifyName` — a plain data field
requiring **no injected call** — and then uses it only for `recordHistory`
(`index.ts:585`). `enqueueForAnalysis` throws that away and re-derives the
name from `msg.getContact()` alone (`smart-analysis.ts:362-365`). **A
perfectly good, break-proof name is computed six lines earlier and
discarded.** Forwarding it restores name-based resolution
(`route.ts:1644-1748`) and auto-provisioning (`route.ts:1877-1948`), and
re-arms both the group nudge and the admin queue.

*(The concurrent agent's untracked `wa-read.ts` exports a `readNotifyName`
helper, so it appears to have found the same gap independently. Good
corroboration; verify it is actually wired into the analyze payload and
not just into the helper module.)*

---

## 4. Defects in the already-merged mitigations

These are the right instinct. Four of them have real problems.

### 4.1 `planFlushRetry` is dead code for the most likely failure — HIGH

`postAnalyzeFull` **does not throw on an HTTP error**:

```ts
// whatsapp-bot/src/api.ts:357-360
if (!res.ok) {
  console.error("analyze post failed:", res.status, await res.text());
  return { results: [], nextKickoffMs: null };
}
```

`flushGroup` clears the buffer optimistically at `smart-analysis.ts:445`
and only requeues from a `catch` (`smart-analysis.ts:464-486`). A `catch`
that a non-throwing function can never trigger.

So a **500 from the analyze route, a Vercel 504 on a slow LLM call, or a
401 on a stale API key silently bins the entire batch of IN/OUT messages**
— buffer already cleared, no requeue, no `CRITICAL`, and the flush then
cheerfully logs `sent N, 0/0 actionable` as if all was well. The analyze
route runs an LLM; 5xx and timeouts are its *expected* failure mode, not an
exotic one. The retry logic only ever fires on a fetch-level network throw.

### 4.2 Synthetic ids probably throw away a real id — HIGH (see §1b)

If `msg.id` is a string, `resolveWaMessageId` synthesises unnecessarily
(`message-id.ts:60-67, 108`), and every downstream consumer of a real
WhatsApp id breaks for no reason. Accept `typeof id === "string"`, and
reconstruct `${fromMe}_${remote}_${id}` from `_data.id` parts before
hashing. Hashing should be the *last* resort, not the second.

### 4.3 Synthetic-id collision is worse than documented — MEDIUM

`message-id.ts:41-44` documents the risk as "two byte-identical messages
from the same author in the same second". The real exposure is broader:
`synthesizeWaMessageId` (`message-id.ts:78-94`) hashes
`from ∥ author ∥ timestamp ∥ body`, and `read()` yields `""` for anything
unreadable (`:69-71`). **`smart-analysis.ts:236-237` already assumes
`msg.author` can be unreadable.** If `author` is unreadable in the same
break, the material collapses to `groupId ∥ "" ∥ timestamp ∥ body` — and
two different players typing "in" in the same second collide. The second is
deduped away at `route.ts:214-234` with no attendance and no signal.
Nothing checks that the hash material carries any entropy beyond `from`
and `body`. Add that check and log loudly when it fails.

Note the trade is also asymmetric in a way the comment doesn't say:
`AnalyzedMessage.waMessageId` is `@unique` **globally**, not per-org
(`prisma/schema.prisma:1027`).

### 4.4 "ACK anyway" is right; the *throw* path is the hole — MEDIUM

`ackMessageId` (`scheduler.ts:184-197`) is correct: at-most-once, a
duplicate flood is worse than a lost id. I agree with the reasoning.

But the case it doesn't cover is worse. If `client.sendMessage()` **throws**
rather than returning `undefined`, control goes to the outer catch at
`scheduler.ts:322-329`, which **neither acks nor releases**. The server has
already claimed the key (claim-on-dispatch), so **that instruction is lost
permanently, and the only trace is one `console.error` on the Pi.** The
comment argues a throw may mean the message landed — true for a *timeout*,
but not for `getChat` throwing `r` before `addAndSendMsgToChat` is ever
reached (`Client.js:1083-1086`), which is precisely the current failure
mode. Distinguish "threw before dispatch" (safe to release) from "threw
after/around dispatch" (do not release). Today they are conflated, in the
lossy direction, on the exact path that is broken.

### 4.5 Every signal is a Pi-local `console.error` — HIGH

`missingSendResultMessage`, `missingMessageIdMessage`, the enrichment
CRITICAL, the empty-flush counters, the `getChats` canary: **all of them
write to `bot.log` on a Raspberry Pi.** There is no heartbeat model, no
staleness check, no alert — I grepped `src/`, `whatsapp-bot/src/` and
`prisma/schema.prisma` and found nothing. The August outage lasted three
days *because nobody reads that file*, and every mitigation since has
routed its alarm to the same place. **This is the highest-leverage
unaddressed problem in the whole incident.**

---

## 5. Pinning verdict

### The premise in the brief is not right

`webVersion: '2.3000.1017054665'` (`Constants.js:10`) pairs with
`webVersionCache: { type: 'local' }` (`:11-13`). `LocalWebCache.resolve()`
reads `./.wwebjs_cache/2.3000.1017054665.html`; when absent it returns
`null` non-strictly (`LocalWebCache.js:20-30`), and `initWebVersionCache`
then **skips request interception entirely** and lets the page load
WhatsApp's **live** build (`Client.js:849-872`). Persist writes under the
*detected live* version, not the default (`Client.js:227-231`), so the
default filename is never created.

**The bot has always run WhatsApp's live build. `2.3000.1017054665` is a
dead constant.** "The archive only has newer builds than the library
declares" therefore says nothing about whether pinning works. The right
question is whether the archive holds a build from *before the break*.

### It does

Checked live against the GitHub API today:

- `wppconnect-team/wa-version/html/` holds **391 builds**,
  `2.3000.1042391138-alpha` → `2.3000.1046380673-alpha`.
- The **oldest is dated 2026-06-30**; the newest 2026-08-30.
- The club paused in July (`SESSION-HANDOFF-2026-08-27.md` §3) and the bot
  worked before that.

So there are candidate builds that predate the break. **Pinning is worth
one bounded attempt, today. It is not futile.**

### But it is not a stable state, and here is exactly why it may still fail

`RemoteWebCache` intercepts **only the top-level document** for
`https://web.whatsapp.com/` (`Client.js:853-865`). Every JS chunk still
loads live from WhatsApp's CDN via the hashed URLs baked into that
two-month-old `index.html`. Three ways that goes wrong:

1. **Purged chunk assets** → the page never boots → `throw 'auth timeout'`
   (`Client.js:113`). Loud and instantly reversible (unset the env var).
2. **Server-side minimum-version enforcement** → hard "update WhatsApp"
   block.
3. Every archived build is `-alpha` (beta channel), which may not behave
   like the release channel the session was paired against on 27 Aug.

And structurally it is a treadmill: the archive keeps a rolling ~400 builds
(~2 months), so **any pin you choose expires within weeks**, and it makes
every bot startup depend on a third-party `raw.githubusercontent.com` fetch.

### Upgrading the library will not help — verified

`whatsapp-web.js` latest on npm is **1.34.7 (2026-04-24)**. `wwebjs/whatsapp-web.js`
has exactly **6 commits since**, last on 2026-07-27, and **none touches the
injected page code** for a new WhatsApp build (they are: addParticipants
inviteV4 fallback, duplicate ready events, big-file downloads, auth-store
refactor, block/unblock, version bump). Installing from `main` buys nothing.
This is consistent with the upstream issue cited in
`MDs/whatsapp-web-version-pinning.md` reporting the same `r: r` against
1.34.7.

### What I would actually recommend for a stable state

**Stop trying to make the injected layer reliable — it cannot be.** Rank
the work by how much control you have:

1. **Make the product survive a broken injected layer** (§3, §4). Entirely
   in your control, no third party, permanent value. This is what decides
   whether the next break costs you a reaction or costs you the product.
   **Do this first, regardless of what happens with pinning.**
2. **Time-boxed pin attempt** — 30 minutes, today, as immediate relief.
   Start at the oldest archived build (`2.3000.1042391138-alpha`,
   2026-06-30) and walk forward. Success signal is
   `=== Groups this account is a member of (N) ===` printing without
   `Failed to enumerate groups`. Abort and unset on `auth timeout`.
3. **Plan the migration off browser injection.** Given upstream is
   effectively dormant on this class of bug, the strategic answer is a
   protocol-level client: **Baileys** (`@whiskeysockets/baileys`,
   `7.0.0-rc14`, published 2026-07-29) speaks the multi-device WebSocket
   protocol directly — no Chromium, no page injection, no minified `r`.
   Honest caveats: it is a release candidate, it is a substantial rewrite
   (auth state, message model, group metadata, reactions, polls all
   differ), it re-pairs the account, and it is not immune to protocol
   changes — just to *frontend* changes, which is the class that has bitten
   you twice. A shorter hop is `@wppconnect-team/wppconnect` (`2.3.1`,
   2026-08-18), far more actively maintained, but it is the *same*
   browser-injection approach and so the same class of risk.
   **You are not choosing between viable and non-viable; you are choosing
   which maintenance treadmill to be on.** Baileys' is the slower one.
4. The official WhatsApp Business API is correctly ruled out (8-participant
   group cap, cannot join an existing group). I agree, no further analysis.

---

## 6. Ranked risk to the live club (next fixture Tue 1 Sept, 21:30)

| # | Risk | Severity | Why now |
|---|---|---|---|
| **R0** | **The actual object shapes on the broken build are unknown.** Every fix below is guesswork until someone logs `typeof msg.id`, `msg._data.id`, `msg.author`, `msg._data.notifyName` from one real inbound message | **Blocking** | 20 minutes of work that determines whether the correct fix is 4 lines or 400 |
| **R1** | Degraded messages silently unattributed → **attendance under-recorded, invisible to the admin queue** (§3) | **Critical** | If the group is LID-addressed this is total; if not, it is every @lid member. The roster is wrong on match day and nobody knows |
| **R2** | **No off-Pi detection.** Any recurrence is found by a human noticing days later (§4.5) | **Critical** | This is what turned a bug into a three-day outage. Unchanged |
| **R3** | Analyze POST HTTP-error bins the whole batch, no retry (§4.1) | **High** | One LLM 5xx or Vercel 504 during the Tuesday 17:00 chase loses every IN in that batch, silently |
| **R4** | `sendMessage` → `undefined` → `SentNotification.waMessageId` NULL → **bench offers and MoM poll votes unmappable** (row 8) | **High** | Bench offers are match-day-critical: a drop at 19:00 Tuesday cannot be filled by 👍 |
| **R5** | **✅/slot reactions dead, possibly with zero log** (row 6, §1b) | **High** | Players lose their only confirmation, repost, and trust drops. Reads to the club as "the bot is broken" |
| **R6** | Tag-gated commands dead — `botMentioned` false, body-text fallback misses tapped mentions (row 5) | **Medium-High** | Self IN/OUT is tag-free so the main flow survives; drops/swaps *for others*, team changes and help are silently ignored |
| **R7** | A `sendMessage` **throw** loses the instruction permanently — no ack, no release (§4.4) | **Medium-High** | A roster post or attendance chase silently never sent, never retried |
| **R8** | `recoverGroupMessages` dead (row 10) | **Medium** | Any restart before Tuesday loses in-flight messages, with the pre-existing 2h-window weakness on top (`SESSION-HANDOFF-2026-08-27.md` §8.4) |
| **R9** | Synthetic-id collision if `author` is also unreadable (§4.3) | **Medium** | Two players saying "in" in the same second; one silently deduped |
| **R10** | `sync-participants` dead (row 2) | **Low-Medium** | New members not provisioned; matters for onboarding, not for Tuesday |
| **R11** | `@lid` group joins/leaves dropped (row 15) | **Low** | Pre-existing, unchanged by this incident |
| **R12** | Single Pi, no failover | **Low for Tuesday** | Pre-existing (`SESSION-HANDOFF-2026-08-27.md` §8.5) |

---

## 7. Recommendations

### R0 — before writing any more code, spend 20 minutes on facts

On the Pi, log once per process from the inbound handler:
`typeof msg.id`, `JSON.stringify(msg._data?.id)`, `msg.author`,
`msg._data?.notifyName`, `msg._data?.participantAlt`, `msg._data?.senderPn`.
And on the server, query `AnalyzedMessage` since the PR #13 deploy for the
org: how many rows, and how many with `authorUserId IS NULL`.

Those two answers decide everything:
- `msg.id` a string → §1b holds; a 4-line fix restores ids, reactions,
  bench offers and poll mapping. Highest value in the report.
- `authorUserId` mostly NULL → §3 is live and R1 is Critical *today*.
- `msg.author` ending `@lid` for everyone → the group is LID-addressed and
  the degradation is total, not partial.

**Do not skip this.** Every other recommendation is cheaper and more
certain once it is done.

### Top 3

**1. Close the attribution hole, not just the delivery hole.**
Four small, independent changes:
- Forward `msg._data.notifyName` as `authorName` on the analyze payload —
  it is injection-free and already computed at `index.ts:568-578`. Prefer
  it over `getContact()`, don't fall back to it.
- Drop the `(msg.authorName ?? "").trim().length >= 1` clause at
  `route.ts:1323` so the unresolved-sender group nudge actually fires for
  the nameless case (the `isRawDigitName` branch at `1343` already handles
  the copy).
- Drop `authorName: { not: null }` from `unresolved-count/route.ts:27` and
  `actions/unresolved.ts:47-55, 93-100` so nameless unresolved messages are
  visible to the admin.
- Make `postAnalyzeFull` **throw** on `!res.ok` (`api.ts:357-360`) so the
  requeue at `smart-analysis.ts:464` stops being dead code.

Per house TDD rules: write the failing tests first —
`resolveSender` is currently **untested and not exported**
(`route.ts:1629`), which is why this hole survived a review.

**2. Get one signal off the Raspberry Pi.**
The bot already POSTs to `/api/whatsapp/analyze` every 10 minutes. Send the
`inboundStats` counters (`seen`/`buffered`/`synthetic`/`notGroup`) plus a
degraded-enrichment count with it, persist them, and alert when any of
these holds for an enabled org: no analyzed message in N hours during a
match week; `synthetic > 0`; `seen ≫ buffered`; an unresolved sender with
no name. Route it to a DM or an email — anywhere that is not `bot.log`.
**Without this, every other fix is one WhatsApp release away from being
invisible again.**

**3. Time-box the pin, then commit to getting off browser injection.**
Try `WA_WEB_VERSION=2.3000.1042391138-alpha` (oldest archived, 2026-06-30)
and walk forward; abort on `auth timeout`; unset to revert. Treat any
success as **weeks of breathing room, not a fix** — the archive prunes.
Then schedule the Baileys evaluation as real planned work rather than
incident response, on the evidence that upstream `whatsapp-web.js` has
shipped nothing for this class of bug in four months.

### Also worth doing, in order

4. Fix `resolveWaMessageId` to accept a string `id` and to reconstruct from
   `_data.id` parts before hashing (§4.2). Likely restores reactions,
   bench-offer mapping and MoM poll mapping in one change.
5. Guard the synthetic-id hash: refuse to synthesise (and log CRITICAL)
   when `author` **and** `timestamp` are both empty, rather than silently
   emitting a colliding id (§4.3).
6. Compute the `botMentioned` JID-set match **outside** `enrichOrDegrade`
   — `mentionedIds` and `client.info.wid` are both plain data
   (`Message.js:194`, `ClientInfo.js:26`) and need no injected call. Note
   `info?.lid` / `info?.wid?.lid` at `smart-analysis.ts:421-423` are almost
   certainly always `undefined` (`ClientInfo._patch` sets only `pushname`,
   `wid`, `me`, `phone`, `platform`), so under @lid mentions the fallback
   cannot match today. Capture the bot's own `@lid` once and store it (env
   var or DB) to make the fallback real.
7. In `executeInstruction`, distinguish "threw before dispatch" (release)
   from "threw at/after dispatch" (keep the claim) (§4.4).
8. Suppress the LLM's confirmation `reply`/`react` when
   `sender.userId === null` (`route.ts:2826`) — telling a player "you're
   in" when nothing was written is worse than silence.

---

## 8. Explicitly not verified

- **The live shape of `msg.id`, `msg.author`, `msg._data.notifyName`.**
  §1b is a code-supported hypothesis, not an observation. R0 resolves it.
- **Whether Sutton's group is LID-addressed.** Decides whether §3 is
  partial or total.
- **The identity of the minified `r`.** Not determinable from the repo.
- **Whether any archived build actually boots.** Depends on WhatsApp's CDN
  asset retention and server-side minimum-version enforcement; only an
  attempt on the Pi settles it.
- **The exact date the bot last worked**, hence which archived build to
  target first. `SESSION-HANDOFF-2026-08-27.md` §3 says "July" without a day.
- **Baileys migration cost.** I checked that it is maintained and
  protocol-level; I did not scope the port.
- **Nothing here was run.** No tests executed, no Pi accessed, no code
  changed. Findings are from reading `ba5f46f`, the installed
  `whatsapp-web.js@1.34.6` source, and live npm/GitHub API queries.
