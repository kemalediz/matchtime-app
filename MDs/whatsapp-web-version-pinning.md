# Pinning the WhatsApp Web build (the `r: r` escape hatch)

Written after the 2026-08-28 outage. Read this the next time the bot is
connected, receiving messages, and yet nothing works.

---

## Why this exists

`whatsapp-web.js` does not talk to a WhatsApp API. It drives a real
web.whatsapp.com page in headless Chromium and injects code against
WhatsApp's own minified, unversioned, undocumented internals
(`window.WWebJS.getChat`, `getMessageModel`, and friends).

When WhatsApp ships a frontend change, those internals move and every
injected call starts throwing. Because the page is minified the error is a
single letter:

```
Failed to enumerate groups: r: r
[recover-group] <groupId> failed: r
[sync-participants] Sutton Football Club failed: r
```

The socket is fine. Auth is fine. The server is fine. Only the injected code
is broken, and it breaks **partially** — sends kept working on 2026-08-28
while every chat/contact lookup died.

Upstream is aware and slow: `Client.getState()`/`getChats()` throwing `r: r`
is reported against **1.34.7**, the latest release, on WhatsApp Web
`2.3000.1043270046`
([wwebjs/whatsapp-web.js#201845](https://github.com/wwebjs/whatsapp-web.js/issues/201845)).
So upgrading the library is not a reliable fix. Pinning the WhatsApp Web
build the library loads is.

## The lever

Three env vars on the Pi, read at startup by `whatsapp-bot/src/web-version.ts`.
**No code change and no deploy of the app is needed** — edit
`~/matchtime-bot/.env` and restart with `scripts/deploy-pi.sh`.

| Var | Meaning |
|---|---|
| `WA_WEB_VERSION` | Pin this WhatsApp Web build, e.g. `2.3000.1046248368-alpha`. Fetched from the wppconnect `wa-version` archive. |
| `WA_WEB_VERSION_REMOTE_PATH` | Full URL override for where the build's `index.html` comes from. May contain the literal `{version}` placeholder. Wins over the default archive URL. |
| `WA_WEB_VERSION_CACHE_TYPE` | `none` \| `local` \| `remote`. Only consulted when neither of the above is set. `none` = always take WhatsApp's live build. |

**With none of them set, the client is constructed exactly as before.**
Opting in is deliberate.

Startup logs one line either way:

```
WhatsApp Web version: library default (unpinned)
WhatsApp Web version: 2.3000.1046248368-alpha via remote cache from https://raw.githubusercontent.com/…
```

## How to pick a build

The archive is <https://github.com/wppconnect-team/wa-version> (directory
`html/`). **It keeps only a rolling window of builds** — roughly the last 400
— and prunes older ones. As of 2026-08-28 it held
`2.3000.1042271047-alpha` … `2.3000.1046248368-alpha`, and
`2.3000.1017054665` (whatsapp-web.js's own default `webVersion`) **404s**.

Always check the exact URL before pinning:

```bash
curl -sI https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/<VERSION>.html | head -1
```

A 404 is not an error at runtime: `RemoteWebCache` is non-strict, so it
resolves to null and whatsapp-web.js **silently** falls back to WhatsApp's
live build. A typo'd pin therefore looks exactly like a working pin. The bot
probes the URL at startup and logs `CRITICAL: pinned WhatsApp Web build is
NOT reachable …` when it 404s — but do the `curl` anyway.

Strategy when the injected code breaks:

1. Note the WhatsApp Web version in the logs / from a working browser
   session, and the date things last worked.
2. Pin a build from **before** the break, working backwards in the archive.
3. Restart with `scripts/deploy-pi.sh` and watch for
   `=== Groups this account is a member of (N) ===` in `bot.log`. If that
   block prints without `Failed to enumerate groups`, the injected code is
   healthy again.
4. If no archived build helps, check the upstream issue tracker for a
   library release that re-syncs the injected code, and bump
   `whatsapp-web.js` instead.

## What happens when it breaks anyway

Since 2026-08-28 a broken injected layer degrades instead of stopping the
pipeline:

- **Inbound.** Pushname lookup and `@`-mention resolution are wrapped
  (`src/inbound-enrich.ts`). If they throw, the message still goes to
  `/api/whatsapp/analyze` with its **raw** body, and the bot logs
  `CRITICAL: enrichment failed for <id> …`. Attendance keeps being recorded.
- **Outbound.** `client.sendMessage()` can resolve to `undefined` even when
  the message was delivered. The scheduler ACKs anyway and logs
  `CRITICAL: sendMessage returned undefined …`. Only reaction tracking for
  that one message is lost. It does **not** re-send — at-most-once delivery
  is deliberate, see `MDs/SESSION-HANDOFF-2026-08-27.md` §1.
- **Replies** prefer `client.sendMessage` over `client.getChatById(...)`,
  because the latter is the call that breaks first.
- **Every flush logs a line** (`[smart] flush <group>: sent N, X/Y
  actionable`), including flushes with nothing actionable. Absence of that
  line now genuinely means "the flush did not run".

## Diagnosing from the Pi

```bash
ssh davidediz@matchtime-pi.tail1437f5.ts.net
grep -c '\[msg\]'   ~/matchtime-bot/bot.log      # inbound arriving?
grep -c '\[smart\] flush' ~/matchtime-bot/bot.log # …reaching the analyzer?
grep -E 'CRITICAL|: r$|r: r'  ~/matchtime-bot/bot.err.log | tail -30
```

`[msg]` climbing while `[smart] flush` is flat is the signature of the
inbound pipeline being dead. That combination is what took four days to
spot in August 2026.
