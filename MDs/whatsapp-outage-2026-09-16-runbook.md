# When the WhatsApp layer breaks: diagnose the LAYER before you touch anything

Written during the 2026-09-16 outage, which took a working-ish bot and made
it worse. It supersedes the reflex in
`MDs/whatsapp-web-version-pinning.md` — that document is still correct about
HOW to pin, and wrong about when pinning is the answer.

Read this before running a single command.

---

## 0. The rule that would have saved the day

**A long-running bot process holds a session that a restart cannot
recreate.**

`whatsapp-web.js` injects code into a live WhatsApp Web page at startup,
against whatever build was live at that moment. A process that has been up
for a week is running an injection against a week-old build.

**A WhatsApp Web self-update is a page navigation, and the injection does not
survive it.** The library registers its inbound listeners INSIDE the page
during `inject()`: `attachEventListeners()` in
`whatsapp-web.js/src/Client.js` wires `Store.Msg.on('add')` to
`window.onAddMessageEvent`. The navigation discards those listeners along
with everything else in the page. The library's `framenavigated` handler then
re-runs `inject()` against the NEW build, and that re-injection is what failed
at 06:57. So when the injection broke, inbound broke with it. **There was no
working half.**

The database confirms it: the last analysed group message is 2026-09-15
22:35 UTC (`AnalyzedMessage`), and nothing was recorded between 06:57 and the
13:39 UTC recovery. The Pi's `bot.log` was truncated by the redeploy, so the
DB is the only surviving evidence.

What the restart DID cost was the **session**. WhatsApp ended it outright
(`Client disconnected: LOGOUT`), which cost several rounds of re-pairing and,
eventually, the ability to pair by phone number at all.

**Before you restart, establish which LAYER is broken and write down what the
restart puts at risk.** Write down what you have VERIFIED works, not what you
assume works. On 2026-09-16 inbound was assumed to be fine, it was not, and
the session was spent for nothing.

---

## 1. Identify the failing layer FIRST

Four layers can fail independently and they need different fixes:

| layer | symptom | fix |
|---|---|---|
| **WhatsApp Web build** | worked yesterday, a new file appeared in `.wwebjs_cache/` today | pin the build |
| **the library's injected code** | single-letter errors (`r: r`, `t: t`), `Cannot read properties of undefined/null` inside `Client.*` | change the LIBRARY version |
| **the session** | `LOGOUT`, QR or pairing code printing | re-pair |
| **the Pi** | no process, no logs, duplicate processes | `scripts/deploy-pi.sh` |

**The distinguishing question: does the stack trace end inside
`whatsapp-web.js/src/Client.js`?** If it does, it is the library's injected
code and **pinning the web build cannot fix it.** That is the mistake this
document exists to prevent: on 2026-09-16 the first error was

```
Cannot read properties of undefined (reading 'getChat')
  at Client.sendMessage (whatsapp-web.js/src/Client.js:1083)
```

which is layer 2, and three separate build pins were attempted before
anyone tried a library version.

---

## 2. Change ONE variable at a time, and write down the result

There are four knobs and they interact:

```
WA_WEB_VERSION              which build to load
WA_WEB_VERSION_CACHE_TYPE   remote | local | none
WA_PAIR_PHONE               pairing code instead of QR
the whatsapp-web.js version itself
```

On 2026-09-16 all four moved inside an hour and every result became
uninterpretable. Keep a table like the one in
`SESSION-HANDOFF-2026-09-16.md`; it is the only thing that made the eventual
picture legible.

---

## 3. The local cache is a real escape hatch, and the remote archive is not

`~/matchtime-bot/whatsapp-bot/.wwebjs_cache/` accumulates **every build this
bot has ever loaded, on local disk.** The build that was working an hour ago
is almost certainly sitting there.

It is on disk, but it is not a freeze. That cached `<version>.html` is a
bootstrap page, not the application: it loads WhatsApp's modules lazily from
WhatsApp's servers at page load, so a pin pins the loader and WhatsApp can
still serve newer modules into it. Treat a local pin as a mitigation worth one
attempt, not a way to hold the frontend still. The evidence is in
`MDs/whatsapp-web-version-pinning.md`, "Why a pin cannot freeze the frontend".

The wppconnect `wa-version` remote archive **prunes**: it holds a rolling
window (~430 builds, all `-alpha` suffixed as of 2026-09-16) and the exact
build you want is often gone. A 404 pin is silently a no-op — the library
falls back to WhatsApp's live build — which is why the bot logs
`CRITICAL: pinned WhatsApp Web build is NOT reachable`. **Always `curl -sI`
the URL before pinning**, and prefer `WA_WEB_VERSION_CACHE_TYPE=local` with a
build you can see on disk.

```bash
ls ~/matchtime-bot/whatsapp-bot/.wwebjs_cache/          # what you already have
curl -sI https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/<V>.html | head -1
```

---

## 4. Library versions are not interchangeable, and each fails somewhere else

Measured on 2026-09-16 against WhatsApp Web `2.3000.1047086005`:

| version | pairing | init | notes |
|---|---|---|---|
| **1.34.6** | works | crashes `null.Socket` at `Client.inject` | the version the repo declares |
| **1.34.7** | **QR works; this is the fix.** The `t: t` crash loop at `requestPairingCode` only happened because `WA_PAIR_PHONE` was set while unpaired; unset it and link by QR | clean; `window.WWebJS.getChat` is a function on the live build (probed) | the version the repo now declares (`a2c3769`) |
| **2.0.0-alpha.0** | QR only, ignores `WA_PAIR_PHONE` | authenticates, **never emits `ready`** (a `waitForFunction` with no timeout on a 2023 `moduleRaid` that finds no `window.Store`) | **published 2023-08-10; the oldest option, not the newest. Do not use.** |

Two things to know before reaching for the alpha:
- it **loses phone-number pairing**, which is the only login route that does
  not need a terminal wide enough to scan a QR;
- `LocalWebCache.persist` throws
  `Cannot read properties of null (reading '1')` on the current page, so the
  cache must be disabled.

---

## 5. Protect the WhatsApp number

A crash loop that calls `requestPairingCode` hammers WhatsApp's pairing
endpoint from one number. **Stop the service rather than let it loop.**
Losing the bot's number is far worse than being down for an hour.

```bash
sudo systemctl stop matchtime-bot      # stopping is a legitimate action
systemctl show matchtime-bot -p NRestarts   # 8, 14, 16 … means stop it now
```

Restart only via `cd ~/matchtime-bot && sudo sh scripts/deploy-pi.sh`.
It behaved correctly throughout the incident and never touched HomeTenant.

---

## 6. Failures are consumed, not retried — know what you are burning

The Pi **acks a failed send as done**:

```
DM send failed for <phone> (botjob-…), acking to skip
```

Claim-on-dispatch is at-most-once by design (a duplicate send is considered
worse than a missing one), so **every message attempted during an outage is
permanently consumed.** On 2026-09-16 that silently destroyed 13 rating DMs
and a group promo in the first fifteen minutes.

Recovering them means deleting the `SentNotification` rows so the scheduler
re-issues. **Do not do that while sending is broken** — it burns them again.
And check the scheduler's window first: rating DMs only fire while
`hoursSinceMatch <= 36 && hourNow >= 8`, so there is a hard deadline after
which no amount of un-claiming helps.

---

## 7. `waMessageId` proves nothing

It is NULL for every message this system has ever sent, including messages
known to have arrived. The bot acks without it on purpose. **Do not use it to
decide whether something was delivered.** This was asserted twice during the
incident before being caught, and it sent the diagnosis down a false path.

The honest delivery signals are: the owner saw it, a reply arrived, or a
downstream effect landed (a rating row, a payment).

---

## 8. What this class of failure costs, and the standing recommendation

Three outages now (2026-08-28, 2026-08-30, 2026-09-16), all from WhatsApp
changing its frontend, all unfixable from our side. The pinning workaround
held for the first two and did not hold for the third. The remaining choices
during an outage are an unreleased alpha or waiting for upstream — neither is
a plan.

The 2026-08-30 audit's answer was a protocol client (Baileys) that speaks the
wire protocol instead of driving a browser. It has been deferred three times.
Each deferral has been reasonable in isolation; the cumulative cost is now a
full round of ratings, a day of live attendance, and a customer-facing outage
on match week.
