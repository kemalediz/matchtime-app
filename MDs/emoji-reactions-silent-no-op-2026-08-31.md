# Emoji reactions: the silent no-op, and the proper fix (2026-08-31)

Companion to `whatsapp-layer-hardening-2026-08-30.md`. That document covers
the inbound side (messages being dropped). This one covers the outbound
confirmation: the ✅ / 🪑 the player actually sees.

---

## Symptom

Players typed "in". Attendance was recorded correctly server-side. No emoji
ever appeared. Nothing in the logs. The `CRITICAL` alarm and the text
catch-up added on 2026-08-30 never fired, because from the bot's point of
view every reaction had succeeded.

## Root cause: `Message.react()` returns without throwing

`whatsapp-bot/node_modules/whatsapp-web.js/src/structures/Message.js`
(v1.34.6):

```js
async react(reaction){
    await this.client.pupPage.evaluate(async (messageId, reaction) => {
        if (!messageId) return null;                    // ← A
        const msg = window.Store.Msg.get(messageId)
            || (await window.Store.Msg.getMessagesById([messageId]))?.messages?.[0];
        if(!msg) return null;                           // ← B
        await window.Store.sendReactionToMsg(msg, reaction);
    }, this.id._serialized, reaction);                  // ← passes undefined
}
```

Since WhatsApp Web's frontend change, `id._serialized` is **unreadable** on
inbound `Message` objects — the same breakage that produced the minified
`r: r` errors and forced `message-id.ts` into existence. So `react()` passed
`undefined`, took branch **A**, and **resolved**.

That is why nothing caught it. The call site was wrapped in a try/catch, so a
THROW would have been reported and the players would have got the text
catch-up. A silent resolve is indistinguishable from success. Two `return
null` branches turned a product outage into a green tick.

## The fix: react with the id we already have

We were never short of a correct id. `resolveWaMessageId()`
(`whatsapp-bot/src/message-id.ts`) reconstructs the canonical
`${fromMe}_${remote}_${id}` string from the raw `_data.id` parts, which
survive the breakage. Production counters read `reconstructed=9,
synthetic=0` — every recent inbound message yielded a real, correctly
formatted id, confirmed in the database
(`false_447525334985-1607872139@g.us_3B0B7E9`). We simply never passed it to
the reaction call.

**`whatsapp-bot/src/react-with-id.ts`** runs the same page code the library
runs, with our id, and returns a structured result:

- `planReaction(id, emoji)` — pure. Decides `react` / `skip`.
- `reactionPageFunction(id, emoji)` — what runs inside the page. Self
  contained (puppeteer serialises it), guards `window.Store`,
  `window.Store.Msg` and `window.Store.sendReactionToMsg` before use, and
  returns a **named** result on every branch.
- `interpretReactionResult(raw)` — maps what came back. A bare `null` (the
  library's silent-no-op signature) becomes a loud `unknown-result`, never
  success.
- `reactWithId(client, id, emoji)` — thin adapter over `pupPage.evaluate`.
- `reactAndReport(...)` — the one-call form: silent on success, one
  explanatory line naming the reason on anything else.

### Failure reasons now distinguishable

| Reason | Meaning |
|---|---|
| `no-page` | `client.pupPage` missing — browser session down or starting |
| `store-unavailable` | `window.Store` / `.Msg` absent inside the page |
| `send-reaction-unavailable` | `Store.sendReactionToMsg` renamed or moved |
| `lookup-threw` | `Store.Msg.get` / `getMessagesById` threw |
| `message-not-found` | id genuinely unknown to this session |
| `send-threw` | WhatsApp rejected the reaction |
| `evaluate-threw` | the page is gone, navigating, or injected code broken |
| `unknown-result` | un-understood return value, **including the library's `null`** |

Plus the skip reasons `synthetic-id`, `no-id`, `no-emoji`.

The batch `CRITICAL` line now carries a per-cause breakdown, e.g.
`[evaluate-threw×3, message-not-found×1]`.

## Both call sites fixed

1. **`smart-analysis.ts`** (flush) — reacts with `entry.waMessageId`, the id
   threaded through from the buffer, which is **the same id POSTed to the
   analyzer**. `Pending.msg` was deleted outright so the two cannot drift
   apart again.
2. **`scheduler.ts`** (`update-reaction`) — was doing
   `getMessageById(id)` then `msg.react(emoji)`: two round-trips through the
   injected layer that threw the known-good id away and ended in the same
   silent no-op. Now `reactAndReport(client, instr.waMessageId, ...)`.

## What still cannot work

A **`synthetic:` id** cannot be reacted to. It is an id we invented for a
message whose real id could not be read at all; WhatsApp never issued it, so
no page lookup can resolve it. This is a documented degradation, not a bug.
Those messages are skipped without a page round-trip, logged as
`synthetic-id`, and the affected players are named in the text catch-up
instead. Production is currently at `synthetic=0`.

## Unchanged on purpose

- **No fallback to `Message.react()`.** A fallback that resolves without
  doing anything would reinstate the exact failure this work removes.
- **A failed reaction never blocks the attendance write** (which is
  server-side and already done) and never breaks the rest of the flush.
- The text catch-up keeps its one-post-per-batch cooldown and its
  `BOT_REACT_TEXT_FALLBACK=0` kill switch; the alarm fires regardless.
- Claim-on-dispatch, the instance lock and the PR #11/#13/#14 hardening are
  untouched.

## Verification

Unit tests only. `pupPage.evaluate` cannot be exercised without a live
browser, so **live confirmation requires deploying to the Pi
(`scripts/deploy-pi.sh`) and watching a real ✅ appear on a real message.**
Until that is observed, treat this as fixed-in-code, not fixed-in-prod.
