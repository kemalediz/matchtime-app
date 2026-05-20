# MatchTime — Session Handoff (2026-05-20, overnight autonomous run)

> Single-page context dump for the morning. Long-form rules + history are
> still in `MDs/skills.md` + `MDs/learnings.md` (both updated in this
> session) and the previous `MDs/SESSION-HANDOFF-2026-05-19.md`.

## What got shipped

**Squad-from-pasted-list mode** — a new derived feature for groups whose
sign-in ritual is "copy the latest numbered list + append my name + send"
(Amir's Thursday shape), where the bot still needs the canonical squad
for MoM voting + post-match rating DMs.

Core insight (yours, last night before bed): *the group is already
labelling the data for the bot — every time someone signs in, the diff
between their list and the previous one IS their own name, attributed
to their own phone*. No fuzzy matching needed; that solves the
`~T → "Tharan"` case that letter-overlap could never bridge.

## Architecture (live now)

| Piece | Path |
|---|---|
| New flag | `Organisation.featureSquadFromList` (default false, auto-set at onboarding when MoM/ratings ON + attendance OFF) |
| New table | `GroupMessage` — raw archive for these orgs |
| Library | `src/lib/squad-from-list.ts` — `runSquadExtraction` (Sonnet, 3-day window) → `attributeDiffs` (deterministic) → `learnAliasesFromAttribution` → `finaliseSquadForMatch` |
| Inbound hook | `/api/whatsapp/analyze` archives messages for these orgs, NO per-batch LLM, NO inline extraction (caused 500s — reverted) |
| Backstop | `/api/cron/generate-teams` (daily) runs `runSquadExtraction` for `featureSquadFromList` orgs with a match in the next 12h. Vercel cron cap = 3, so we piggyback on existing crons rather than adding a 4th. |
| Manual endpoint | `GET /api/cron/extract-squads` (bearer `CRON_SECRET`) — manual trigger for debugging + harness. Removed from `vercel.json` scheduling but the route is still live. |
| Onboarding wire-up | `src/lib/onboarding-conversation.ts` — at end of setup, derive `featureSquadFromList = !attendance && (momVoting || playerRating)` |

## Regression gates (all green against deployed prod)

| Harness | Result |
|---|---|
| `scripts/test-squad-from-list.ts` (NEW) | **53/53** — full Amir-replay, aliases, attendance, reserves, idempotency, Sutton untouched |
| `scripts/test-onboarding-suite.ts` | 9/9 |
| `scripts/test-gating.ts` | all pass (Sutton intact) |
| `scripts/test-amir-lifecycle-remote.ts` | 23/23 |
| `scripts/test-bench-offer.ts` | 15/15 |

## What you can do right now to onboard Amir's group

1. Add the bot to Amir's WhatsApp group.
2. Have someone type `@MatchTime setup` in the group.
3. Walk through the Q&A. Pick MoM + ratings (and any others you want — but NOT attendance).
4. At completion, the bot will set `featureSquadFromList=true` automatically.
5. Messages start archiving the moment the org is provisioned.
6. The next scheduled `generate-teams` cron run (daily 12:00 UTC = 13:00 BST) will run the first extraction. **OR** trigger it manually any time:
   ```bash
   curl -H "authorization: Bearer $CRON_SECRET" https://matchtime.ai/api/cron/extract-squads
   ```
7. Any unresolved names land in `/admin/players` for Amir to fill in phones (same flow Sutton uses for phone-less players).

## What's intentionally NOT in scope

- **Sub-day timing**: extraction is daily-backstop only. For Amir's Mon-Wed list-paste rhythm this is fine; the squad stabilises 8h+ before kickoff. If we later see last-minute Thursday sign-ins missing the MoM DMs, the plan is to add an inline trigger in `/api/whatsapp/analyze` with an explicit `SentNotification` rate-limit (max once per hour per org), NOT unbounded fire-on-every-message — that exact pattern 500'd the analyze route during this session and was reverted.
- **A 4th Vercel cron**: Vercel plan caps at 3 daily crons on this project. Adding a 4th tipped over the limit (commit history shows it). Workaround = consolidate (used the `generate-teams` cron as backstop).

## Commits (newest first)

```
258397e fix(squad-from-list): reserves are always guests, never sender's self
8ec9ea2 debug: forward latestList diagnostic fields through cron response
c383bbe fix(squad-from-list): remove inline trigger from analyze (caused 500s)
d893554 fix(squad-from-list): widen return type for diagnostic fields
6cda1a8 debug: surface latestList names/reserves in extract-squads cron return
e65c8bb fix(squad-from-list): few-shot + deterministic backstop for Reserves block
6394521 fix(squad-from-list): strengthen reserves prompt + tighten guest assertion
2be0f0a fix(squad-from-list): consolidate — call from analyze + generate-teams
a49b507 fix(cron): back off extract-squads to hourly (Vercel plan limit)
769bffb chore: nudge vercel webhook
6394521 feat(squad-from-list): derive squad from pasted lists via diff-attribution
1d70fbb chore(scripts): commit one-off operational + remediation scripts
```

(The iterative-debugging shape — multiple small fixes — was necessary
because the harness exposed real production issues: Vercel cron limit,
analyze-route timeout, LLM-dropping-the-Reserves-block, and the reserves-
attribution bug. Each one needed its own commit + deploy + harness re-run.
The final state is clean and all gates pass.)

## Memory updates

- `MDs/skills.md` — new section "Squad-from-pasted-list mode" (full
  pipeline description + the three-layer Reserves defence).
- `MDs/learnings.md` — five new entries:
  1. The squad-list ritual IS the labelling system
  2. Reserves are always guests, never the sender's self
  3. Vercel cron cap is 3 on the project's current plan
  4. Long synchronous LLM calls inside /api/whatsapp/analyze will time out
  5. Three-layer defence when an LLM is unreliable on a STRUCTURED slot

## Pi sync

The bot on the Pi runs `whatsapp-bot/` only. None of tonight's changes
touch that — pure server-side additions. The Pi git tree is now ~12
commits behind `origin/main`; safe to leave (no functional impact on the
running bot) or sync at leisure:
```bash
ssh davidediz@matchtime-pi.tail1437f5.ts.net 'cd ~/matchtime-bot && git pull --ff-only'
# (no service restart needed — no bot code changed)
```
