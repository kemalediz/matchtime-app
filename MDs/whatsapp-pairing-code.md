# Logging the bot into WhatsApp from a phone alone (pairing codes)

Written 2026-08-29. Companion to `whatsapp-web-version-pinning.md` and
`SESSION-HANDOFF-2026-08-27.md`.

## The problem this fixes

The bot could only authenticate by scanning an ASCII-art QR code printed to
`~/matchtime-bot/bot.log`. Re-pairing therefore needed **a screen showing that
log AND the burner phone in hand at the same time**. Whenever the owner was on
mobile only, the bot stayed logged out, and because `initScheduler` and
`startBatchFlushTimer` both live inside `client.on("ready")`
(`whatsapp-bot/src/index.ts`), a logged-out bot does not even poll for due
posts. Nothing sends, nothing is received: the product is dead.

That went from rare to routine. Since the whatsapp-web.js injected-code
breakage the session has been dropping on restarts, so re-pairing is now a
recurring operation and it has to be doable from a phone alone.

WhatsApp's own "Link with phone number instead" flow does exactly that: it
hands out an 8-character code you type into the burner phone. No camera, no
second screen. `whatsapp-web.js@1.34.6` supports it.

## Env vars

Set these in `~/matchtime-bot/.env` on the Pi. (`whatsapp-bot/.env.example` is
gitignored, which is why they are documented here.)

| Var | Required | Default | Meaning |
|---|---|---|---|
| `WA_PAIR_PHONE` | no | unset | **The BOT's own WhatsApp number** (the burner), international format, digits only, no `+`. E.g. `447700900123`. **Not the admin's number.** Unset → QR only, exactly as before. |
| `WA_PAIR_INTERVAL_SEC` | no | `180` | How often a fresh code is generated. WhatsApp expires a code after ~3 minutes, so the default matches. Values outside 30-3600 are ignored and the default kept. |
| `WA_PAIR_NOTIFY` | no | on | `0` / `false` / `no` / `off` suppresses the push notification WhatsApp sends to the burner phone alongside the code. |

Format is forgiving on input: a leading `+`, spaces, dashes, dots and brackets
are stripped (`+44 7700 900123` works). Everything else is rejected rather than
guessed at, because a wrong number sends the pairing prompt to a stranger. A
leading `0` (`07700…`) or `00` (`0044…`) is rejected: WhatsApp wants the bare
country code.

## Using it

```bash
# 1. Set the number once on the Pi
ssh davidediz@matchtime-pi.tail1437f5.ts.net \
  "grep -q '^WA_PAIR_PHONE=' ~/matchtime-bot/.env || echo 'WA_PAIR_PHONE=447xxxxxxxxx' >> ~/matchtime-bot/.env"

# 2. Restart — the ONLY sanctioned way (never bare `systemctl restart`)
ssh davidediz@matchtime-pi.tail1437f5.ts.net 'cd ~/matchtime-bot && sudo ./scripts/deploy-pi.sh'

# 3. Read the current code (this is the whole mobile recovery procedure)
ssh davidediz@matchtime-pi.tail1437f5.ts.net \
  "grep 'WA_PAIRING_CODE:' ~/matchtime-bot/bot.log | tail -1"
#   → WA_PAIRING_CODE: ABCD-EFGH
```

Then on the burner phone: **WhatsApp → Linked devices → Link a device → "Link
with phone number instead"** → type the code.

The log also prints an unmissable banner around it:

```
================================================================
 WA_PAIRING_CODE: ABCD-EFGH

 On the burner phone: WhatsApp > Linked devices > Link a device >
 "Link with phone number instead", then type the code above.

 Expires in ~180s; a fresh one is printed automatically if it lapses.
 Grep the newest:  grep WA_PAIRING_CODE ~/matchtime-bot/bot.log | tail -1
================================================================
```

Success looks the same as before: `WhatsApp bot is ready!` then
`Monitoring 1 group(s)`.

`WA_PAIRING_CODE:` (with the colon) appears on exactly ONE line per code and
nowhere else, so `| tail -1` is always the newest live code. Prose in the
banner and the startup line deliberately omit the colon so they cannot poison
that grep.

## Behaviour and trade-offs

- **Setting `WA_PAIR_PHONE` does NOT force a re-pair.** whatsapp-web.js only
  enters the pairing branch inside `if (needAuthentication)`
  (`Client.js:141`), i.e. when the app state is `UNPAIRED` / `UNPAIRED_IDLE`.
  A good existing session is untouched.
- **QR and pairing code are mutually exclusive in this library.**
  `Client.js:161` is `if (pairWithPhoneNumber.phoneNumber) { …code… } else
  { …qr… }`, so the `qr` event is never registered while the var is set. While
  `WA_PAIR_PHONE` is set there is **no QR in the log**. To get the laptop/QR
  route back, remove the var from `.env` and redeploy. Both handlers are
  registered in `index.ts` unconditionally, so the switch is env-only.
- **Codes refresh themselves.** `requestPairingCode` (`Client.js:394`) sets an
  interval that clears as soon as the state leaves `UNPAIRED`, so a lapsed code
  is replaced without anyone touching the Pi, and the refresh stops the moment
  pairing succeeds.
- **A bad value can never take the bot down.** An invalid `WA_PAIR_PHONE` logs
  a `CRITICAL:` line naming the exact problem and falls back to the QR flow.
  All decision and formatting logic is pure (`whatsapp-bot/src/pair-phone.ts`,
  tests in `pair-phone.test.ts`).
- **With the var unset, the auth flow is unchanged.** The client is constructed
  identically; the only difference is one extra startup log line saying which
  login mode is active.

## Where the code lives

| File | Role |
|---|---|
| `whatsapp-bot/src/pair-phone.ts` | Pure: validation, the decision, the log formatting. |
| `whatsapp-bot/src/pair-phone.test.ts` | Unit tests (`cd whatsapp-bot && npx vitest run`). |
| `whatsapp-bot/src/index.ts` | Wiring: spreads the client option, logs the banner on `code`. |
