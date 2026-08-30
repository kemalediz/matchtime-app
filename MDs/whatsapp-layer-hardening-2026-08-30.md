# WhatsApp injected-layer hardening, 2026-08-30

Follow-on to PRs #11, #12 and #13. Those stopped the bot **losing** messages.
This one makes sure a message that survives can still be **acted on**, and
that anything which genuinely cannot work says so in a way a human reading
the Pi's journal will understand.

Context for the breakage itself: `MDs/SESSION-HANDOFF-2026-08-27.md` and
`MDs/whatsapp-web-version-pinning.md`.

## The shape of the problem

`whatsapp-web.js@1.34.6` injects its own code into the WhatsApp Web page.
When WhatsApp ships a frontend change that code drifts out of step and every
call routed through it throws a minified `r`. The properties it hands back
stop being plain values and become throwing getters.

Two consequences, and the second is the one that kept biting:

1. An unguarded read throws from wherever it sits. Because nearly every
   handler on the Pi is one big `try { … } catch (err) { console.error(…) }`,
   the throw aborts the **whole handler**, losing the customer's message
   rather than just the field being read.
2. Everything that was left still logged something. The three-day outage was
   not caused by missing error handling; it was caused by error handling that
   said `[sync-participants] Sutton FC failed: r` and nothing about what it
   cost.

## Audit: every dependency on the injected layer

| Call | Product rule it serves | Old behaviour on the broken build | New behaviour |
| --- | --- | --- | --- |
| `msg.body` / `msg._data.body` / `msg.from` / `msg.type` / `msg.hasMedia` in the `message` handler | Every inbound message, group and DM | **Threw before `enqueueForAnalysis` was reached.** Optional chaining guards a null `_data`, not a throwing one. Message lost with one `message handler failed` line | Read through `readInboundHeadline()`, total. Message always reaches the pipeline |
| `msg.getContact()` in `enrichInbound` | Sender's name, the ONLY identity an `@lid` player has | `authorName: null` → server resolved `{userId: null}` → **no attendance**, one layer later than before | Falls back to `msg._data.notifyName` (raw payload, no page call). Contact reads are individually total |
| `Contact.number` (group path) | `@lid` → real phone | Never attempted on the group path at all | Attempted; upgrades an empty `authorPhone`. Never overwrites a JID-derived phone; nonsense values discarded |
| `client.getContactById()` (mention resolution) | `@Name` rewriting so the LLM sees names, not lid digits | Already per-mention try/caught; body degrades to raw `@<digits>` | Unchanged (was already correct) |
| `msg.react()` | The ✅/🪑 that IS the player's confirmation | `[smart] react failed:` per message. Attendance recorded, player saw nothing, assumed the bot was dead | Collected per flush → one `CRITICAL` naming the count and that attendance IS recorded → one text catch-up per batch (see below) |
| `client.sendMessage()` (reply) | Answers to questions in the group | Already fell back to `chat.sendMessage` | Unchanged |
| `client.getChats()` at startup | Group listing; canary for the whole layer | Two log lines, the second already `CRITICAL` | One `degradedMessage("group-enumeration")`, consistent shape |
| `getChatById().participants` + `getContactById()` (startup sweep) | Writes `Membership.lastSeenInGroupAt` — the **only** writer | `[sync-participants] <org> failed: r` | `CRITICAL` naming `lastSeenInGroupAt` and the web-app self-IN gate. An **empty** participants array (nothing throws) is now treated as failure too |
| `recoverGroupMessages` (`getChatById` + `fetchMessages`) | Replays the last ~2h after a restart; closes the deploy gap | `[recover-group] <gid> failed: r` — reads like a blip | `CRITICAL` naming the restart gap |
| `reaction.msgId._serialized` (`message_reaction`) | Bench-prompt 👍/👎 | Bare `return`. Silent | Total reads. An empty emoji is a normal un-react and stays quiet; a missing id/sender is `CRITICAL` |
| `msg.id._serialized` (inbound) | Server dedupe + reaction mapping | Synthetic id (PR #13) | Now tries harder for a REAL id first (see below), and counts reconstructions in the flush heartbeat |
| `client.sendMessage()` (scheduler) | Posting reminders, DMs, polls | Handled in PR #11 (`send-result.ts`) | Unchanged. **Claim-on-dispatch is untouched** |

## The definitive `@lid` answer

**A degraded message could NOT be attributed to a user, and this was the
biggest hole left.** Traced through the server (read-only):

- `resolveSender()` — `src/app/api/whatsapp/analyze/route.ts:1629` — uses
  exactly two identity inputs, in this order: `authorPhone`
  (`route.ts:1633`), then `authorName` (`route.ts:1644`, gated on
  `.trim().length >= 2`).
- `phoneFromAuthor()` — `whatsapp-bot/src/smart-analysis.ts` — returns `""`
  for any JID not ending `@c.us`, so every `@lid` sender arrives phone-less
  by design.
- With `authorPhone === ""` and `authorName` null, the name/alias block is
  skipped entirely and `createProvisionalByName` bails at
  `route.ts:1894` (`if (!name || name.length < 3) return null`).
  `resolveSender` returns `{ userId: null }` (`route.ts:1761`).
- `executeVerdict` writes attendance only under
  `if (verdict.registerAttendance && user)` — `route.ts:2141`. So **nothing
  is registered**.
- The "who was that?" group nudge is itself gated on
  `(msg.authorName ?? "").trim().length >= 1` (`route.ts:1319`), so with no
  name the bot does not even ask. The message dies leaving only an
  `AnalyzedMessage` row.
- There is **no `@lid` → User mapping anywhere in the schema**. `lidId`
  exists only inside JSON blobs and is discarded by
  `src/lib/participant-sync.ts:52-56`. The only durable bridge is
  `UserAlias`, keyed by **normalised pushname**, not by lid.

So on the degraded path the name was not a nice-to-have. It was the entire
identity, and it was being thrown away.

**The fix:** `msg._data.notifyName` is the sender's pushname serialised onto
the message when the event fired. It is plain data, not a page call, so it
survives. `index.ts`'s `message` handler already read it for the history
buffer and then dropped it; it now travels with the message, on the healthy
path and every degraded one. Precedence:
`contact.pushname → contact.name → contact.verifiedName → _data.notifyName`.

No new fields were added to the `/api/whatsapp/analyze` payload. The route
has no validator (it is a bare cast at `route.ts:141`, so unknown keys are
accepted), but it **reads** nothing beyond the existing fields, so a `lid`
field would be inert. See "For the server side" below.

## Reactions: why a text fallback, and why this shape

The reaction is the whole feedback loop, and the reason the bot does not
reply in words to every "in" — twenty text confirmations in an evening would
be unusable in a customer's group. When `react()` is dead the player sees
nothing at all while the data looks perfectly healthy.

A text fallback was added **deliberately, not reflexively**, and is
constrained so it cannot become the spam it replaces:

- One message per flush for the whole batch, never one per player.
- Only for reactions that actually failed, so on a healthy layer it produces
  nothing and the group never knows it exists.
- Only for players we can name. A confirmation addressed to a bare `@lid`
  number is worse than silence.
- Labelled in words (`✅ In: …`, `🪑 On the bench: …`), because "🪑 Baki"
  means nothing to a player who has never been benched.
- Behind a 20-minute cooldown per group (two flush intervals).
- Killable from the Pi's `.env` with `BOT_REACT_TEXT_FALLBACK=0`, since it is
  the only change here a customer's group actually sees.
- The `CRITICAL` log fires **whether or not** the post does.

## Known degradations — what still cannot work

These need the injected layer repaired (pin `WA_WEB_VERSION`, or upgrade
`whatsapp-web.js`). Nothing on the Pi can substitute for them:

1. **Participant sync.** Enumerating a group's members has exactly one
   source: `getChatById().participants`. There is no second path. While it
   is down, `Membership.lastSeenInGroupAt` goes stale and the web app's
   self-IN gate will start rejecting real players. It now shouts; it cannot
   self-heal. *(Considered and rejected: synthesising participants from
   whoever speaks. It would refresh `lastSeenInGroupAt` for active players,
   but `importParticipants` auto-provisions Users, so a degraded, partial
   roster would create ghost players — a worse failure than the one it
   fixes.)*
2. **`recoverGroupMessages`.** Same single source. When it fails the restart
   gap is open and messages sent during a deploy are gone.
3. **Reaction delivery.** `Message.react()` is page-code all the way down.
   Retrying via `client.getMessageById()` was considered and rejected: it
   goes through the same code and would fail identically at the cost of a
   round-trip per message. The text catch-up is the mitigation.
4. **Bench 👍/👎 with an unreadable message id.** No synthetic-id trick is
   available: the server must JOIN the reaction to the bench prompt it
   already sent, and only the real WhatsApp id can do that.
5. **`recoverGroupMessages`' window** is still `limit: 50` messages capped at
   2h. In a busy group 50 messages can be well under 2h, so a long outage is
   only partly replayed. Not addressed here — it is orthogonal to the layer
   breakage and changing it alters replay volume against a live customer two
   days before a fixture.

## Also improved

- **Real ids are now recovered before synthesising.** `resolveWaMessageId`
  tries `id._serialized`, then `id` as a flat string, then rebuilds
  `${fromMe}_${remote}_${id}[_${participant}]` from the key's parts, on both
  `msg.id` and the raw `msg._data.id`. This matters because `message_reaction`
  events carry the REAL id: a synthetic id keeps attendance working but
  permanently severs reaction tracking, whereas a reconstructed one does not.
  Reconstruction is refused unless BOTH `remote` and `id` are present — a
  partial rebuild would be a *wrong* id, and the server dedupes on it.
- **`reconstructed=N` in the flush heartbeat.** A non-zero count is the
  earliest hard evidence the layer has drifted, usually days before anything
  user-visible breaks.
- **Per-field degradation.** `enrichOrDegrade` now falls back field by field
  instead of discarding a half-good enrichment (the common case is
  `getContact()` throwing while mention resolution completes).

## For the server side (not changed here — bot-only PR)

Reported, not fixed, since this branch touches `whatsapp-bot/**` only:

1. **No `@lid` → User mapping exists.** `sync-participants` is the one
   endpoint that sees `lidId` next to a resolvable identity and it discards
   it (`src/lib/participant-sync.ts:52-56`). A `lidId` column on `User` or
   `Membership`, written there, would make `@lid` senders resolvable by a
   stable key instead of by a fuzzy name match that breaks when someone
   changes their WhatsApp display name.
2. **Three copies of the first-name matching rule have drifted.**
   `resolveSender` uses an asymmetric 3/2 threshold (`route.ts:1677-1699`)
   while `resolveOrProvisionByName` (`route.ts:1810-1821`) and
   `findExistingOrgMember` (`src/lib/resolve-player.ts:104-113`) use 3/3. So
   the same pushname can resolve down one path and not another.
3. **`/api/whatsapp/analyze` has no request validation.** The body is a bare
   cast (`route.ts:141`) and `msg.body.trim()` at `route.ts:235` throws a 500
   for the WHOLE batch if any message omits `body`. One malformed message
   from any bot build takes out every other message in that flush.
4. **`normalisePhone` would accept a raw lid.** If any client ever sent
   `"158055467598020@lid"` as `authorPhone`, `src/lib/phone.ts:24-46` strips
   the non-digits and produces a plausible-looking `+158055467598020` that
   gets a real `User.phoneNumber` lookup. The current bot never does this,
   but nothing server-side rejects it.
