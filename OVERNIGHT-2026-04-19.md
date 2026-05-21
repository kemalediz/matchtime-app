# Overnight build log — 2026-04-19

Summary for Kemal in the morning. Two commits landed, both deployed to prod
and both Vercel auto-builds green.

## Shipped — 9 of 10 from the approved plan

| # | Feature | Status |
|---|---|---|
| 1 | Magic-link auth + `/r/[token]` placeholder | ✅ |
| 2 | Bot DMs magic link per player + group promo post | ✅ |
| 3 | Rating page polish | ⏸️ (deferred — we design together this morning) |
| 4 | Widened IN/OUT regex + 👍 reaction on confirm | ✅ |
| 5 | Scheduling brain (`/api/whatsapp/due-posts`) + idempotency table | ✅ |
| 6 | Bench confirmation via 👍/👎 emoji reactions | ✅ |
| 7 | Payment poll auto-post after match-end | ✅ |
| 8 | MoM announcement at match.date + 5 days, 15:00 London | ✅ |
| 9 | Elo calibration (`User.matchRating`) | ✅ |
| 10 | Bulk-edit seed ratings + info modal | ✅ |

## What you'll see in production

- `/admin/players` — two new buttons at the top: **Phones** and **Seed
  ratings**. The latter (bulk editor at `/admin/players/ratings`) has a
  "What is this?" link that opens a modal explaining the seed → peer → Elo
  blend.
- `/r/[token]` — public route, signs players in via the magic-link
  credentials provider and redirects to the rating page (currently still
  the old tap-button UX — intentional placeholder).
- Bot on Pi now runs a polling scheduler every 5 min. Zero external
  triggers needed — as soon as you generate a match via
  `/admin/activities`, the next 5-min tick posts the announcement in the
  Sutton FC group. Same for every other scheduled message.

## Design decisions worth knowing

- **All schedule timing lives server-side**, in `src/lib/bot-scheduler.ts`.
  Bot is a dumb executor. Adding a new reminder type = server code only.
  London local time used for all hour/day comparisons (DST-safe).
- **`SentNotification` table** with unique `key` column is the idempotency
  ledger. Every post the bot makes generates a row like
  `{matchId}:{kind}:{optional}` so nothing fires twice.
- **Bench flow changed.** `cancelAttendance` no longer auto-promotes the
  first bencher — it creates a `PendingBenchConfirmation` with a 2h expiry.
  The next scheduler tick posts a 👍/👎 prompt tagging the bencher.
  Their own 👍 promotes them; 👎 or 2h silence chains to the next bencher.
  Message count per drop (happy path) = 2 (prompt + updated roster).
- **Elo blend.** Once a player has 3+ peer ratings,
  `balancer_input = 0.5 × peer_avg + 0.5 × (matchRating ÷ 200)`. Bootstrap
  (<3 ratings) uses `0.7 × seed + 0.3 × (matchRating ÷ 200)`. Elo K =
  `32 × (1 + |scoreDiff|/5)` so 7-2 blowouts shift ratings more than 4-3
  squeakers.
- **Magic links** are HMAC-SHA256 signed compact tokens (no external lib).
  TTL 5 days to match the MoM-announcement window.

## What hasn't moved yet

- **Rating page UX.** Lands from magic link at `/matches/[id]/rate` — it
  works but still has the old slider/tap UI. We agreed to redesign it
  together this morning.
- **No synthetic data was created overnight** — so no bot messages were
  posted in the group. First real post happens when you generate a match
  via the admin UI.
- `/admin/sports` CRUD still deferred (the 9 preset sports are already
  seeded for your org; you can pick them in the activity dialog).

## Quick morning sanity checks

1. Prod deploys green:
   ```
   vercel ls --scope cressoft | head -3
   ```
2. Bot still running on Pi:
   ```
   ssh davidediz@192.168.0.63 "systemctl is-active matchday-bot"
   ```
3. Scheduler endpoint responds:
   ```
   curl -s -H "x-api-key: $WHATSAPP_API_KEY" \
     "https://matchday-nine-zeta.vercel.app/api/whatsapp/due-posts?groupId=447525334985-1607872139@g.us"
   ```

## Commits

- `5733d86` — Magic-link auth + bot scheduler + bench confirmation flow
- `8632faf` — Elo calibration + bot scheduler integration + bulk seed ratings
