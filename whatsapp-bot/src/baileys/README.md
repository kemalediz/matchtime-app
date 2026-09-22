# The Baileys observer (Phase 1)

Phase 1 of `MDs/baileys-migration-plan-2026-09-21.md`: a Baileys socket,
an auth state, a reconnect policy, and inbound message receipt.

It **observes**. No sends, no scheduler, no flush, no MatchTime API calls.
`src/index.ts` is untouched and is still the only thing systemd runs.

```bash
cd whatsapp-bot
npm ci
npm run start:baileys
```

## Before you run it, twice

1. **Running this links a SECOND WhatsApp device.** WhatsApp allows about
   four. It is safe beside the live bot only because this process cannot
   send: two drivers replying to the same message is the 2026-07-19
   duplicate flood with a nicer origin story.
2. **Never point it at a number and ask WhatsApp about that number.** About
   a hundred directory lookups from HomeTenant's production account got
   *every* linked device on the number unlinked on 2026-09-17, and took
   down a live product for 36 minutes. Nothing in `main.ts` may call
   `onWhatsApp`, `executeUSyncQuery`, `getLIDForPN` or `getLIDsForPNs`, and
   `main.source.test.ts` fails the build if it does.

## Environment

None of these affect `npm start`.

| Var | Default | What it does |
|---|---|---|
| `BAILEYS_AUTH_DIR` | `.baileys_auth` under `whatsapp-bot/` | Where the Signal session lives. Relative paths resolve against the bot directory. Created `0700`. Expect roughly 11 MB across a few thousand small files once paired. **Never commit it and never let a deploy script delete it:** losing it costs a re-pair, which needs a human with the phone. |
| `WA_BAILEYS_LOG_LEVEL` | `warn` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Baileys is very chatty and logs whole auth-state objects, so everything goes through the redactor in `logging.ts` whatever the level. |
| `WA_PAIR_PHONE` (or `PAIR_PHONE`) | unset | Link by 8-character code instead of a QR, which is far easier over ssh. Digits only, no `+`. Requested **once per socket**; a loop here hammers WhatsApp's pairing endpoint from one number and risks the number itself. |
| `MT_BAILEYS_LOCK_PATH` | `/tmp/matchtime-baileys.pid` | Its own lockfile, deliberately not the live bot's `/tmp/matchtime-bot.pid`. Two Baileys sockets on one auth folder evict each other in a `440` loop and churn `creds.json`. |

## What it prints, and the one measurement it exists to take

One line per inbound message, shaped like `index.ts`'s `[msg]` line so a
shadow run can be diffed against the live bot:

```
[baileys][msg] upsert=notify chat=1203...@g.us group=true sender=4477...@s.whatsapp.net
  phone=447700900123(jid) name=Sam type=chat bodyLen=2 media=false mentions=0 ts=... id=3EB0...
```

`upsert=` is the interesting field. Whether messages that arrive while the
process is down come back on reconnect, and whether they come back as
`notify` or `append`, decides whether `recoverGroupMessages`' two-hour
replay can be retired or has to be rebuilt on `fetchMessageHistory`. That
is the open question in the plan (§2.15), and HomeTenant cannot answer it
because its bot drops everything that is not `notify`. **Nothing is
dropped on `type` here.** To take the measurement: stop the process, post
three messages in the group, start it, count what arrives.

A sender whose phone could not be resolved gets a second, louder line.
Phase 4 adds the group-participant path (`GroupParticipant.phoneNumber`)
that should close most of those.

## Where the logic lives

`main.ts` is wiring and nothing else. Every decision is a pure module
beside it with its own tests, because **no test in this repo may open a
socket**:

| Module | Decides |
|---|---|
| `jid.ts` | parsing, classification, phone extraction, and the sender-resolution order. Cross-checked against Baileys' own `jidDecode`. |
| `inbound.ts` | one `WAMessage` flattened, via `normalizeMessageContent` then `getContentType`. Fixtures are built with `proto.Message.fromObject` so a field-name typo fails the test rather than the Pi. |
| `connection.ts` | reconnect, back off, or exit, per `DisconnectReason`. |
| `logging.ts` | redaction and caps, because Baileys logs key material. |
| `config.ts` | environment, and the pairing decision. |
| `dedupe.ts` | Baileys can deliver the same message twice. |
| `key.ts` | Phase 3. `serializeKey` / `parseKey`: a Baileys message key as the whatsapp-web.js id string the database already holds, and back (plan §2.5). A bijection on canonical keys; the header names the three places it is not. |
| `outbound.ts` | Phase 3. What the driver hands to `sendMessage`: texts with `linkPreview: null` (§2.6), mentions, polls, reactions, and `completeOwnKey`, which keeps our own group posts' ids in the four-part form reactions join on. |
| `sent-store.ts` | Phase 3. The bounded store of what we sent, for `getMessage` (§2.12), with polls pinned. |

The Baileys **driver** (`src/drivers/baileys.ts`, Phase 3) uses the last three.
It is the outbound half only and `WA_DRIVER=baileys` is still refused.
| `main.source.test.ts` | asserts on `main.ts`'s source text. Brittle on purpose: each test is a named past incident. |
