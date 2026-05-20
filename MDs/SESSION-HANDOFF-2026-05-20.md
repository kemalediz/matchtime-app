# MatchTime — Session Handoff (2026-05-20, overnight autonomous run)

> Single-page context dump for the morning. Long-form rules + history are
> in `MDs/skills.md` + `MDs/learnings.md` (both updated this session).
> Full feature design doc: `MDs/squad-from-list.md`. Previous handoff:
> `MDs/SESSION-HANDOFF-2026-05-19.md`.

---

## Morning report — squad-from-list shipped ☕

**Direction:** your insight from before bed — *the group's copy-paste ritual is itself the labelling mechanism, the diff = ground truth for that sender's name* — is now the spine of the feature. `~T → "Tharan"` resolved with zero fuzzy guessing in production.

### What's live on matchtime.ai

**Pipeline** (no regex on user-typed in/out anywhere):

1. **`/api/whatsapp/analyze`** — for orgs with new `featureSquadFromList=true`, archives inbound messages to a new `GroupMessage` table. No per-batch LLM call. Cost stays ~£0.
2. **`/api/cron/generate-teams`** (daily backstop) — runs `runSquadExtraction` for these orgs over the last 3 days of stored messages: one Sonnet call → identifies squad-list messages + parses names/reserves.
3. **`attributeDiffs`** (deterministic) — diffs consecutive lists, attributes each added name to its message's sender. The single-addition-with-no-overlap fallback is what bridges nicknames like `~T → "Tharan"`. **Reserves are always guests** (you don't put your own name in your own Reserves section).
4. **`learnAliasesFromAttribution`** — writes `UserAlias` rows (`source="auto-detect"`) for every sender's self-addition. Provisions the User+phone if it didn't exist yet.
5. **`finaliseSquadForMatch`** — takes the latest list, resolves each name (alias → exact → fuzzy → provision-with-no-phone), writes 14 CONFIRMED + reserves as BENCH. Unresolved/guests appear in `/admin/players` for Amir to enter phones — same flow Sutton uses.

### Regression gates — all green against deployed prod

| Harness | Result |
|---|---|
| `test-squad-from-list.ts` (NEW, 53 assertions) | **✅** — replays your exact 12 messages from 17 May |
| `test-onboarding-suite.ts` | 9/9 |
| `test-gating.ts` | all pass (Sutton intact) |
| `test-amir-lifecycle-remote.ts` | 23/23 |
| `test-bench-offer.ts` | 15/15 |

### Two real issues hit and how they were resolved

1. **Vercel cron cap = 3** on this project's plan. A new `/api/cron/extract-squads` cron was rejected at deploy time (link → `cron-jobs/usage-and-pricing`). Workaround: consolidated into the existing `generate-teams` cron as a daily backstop. The `/api/cron/extract-squads` route still exists as a manual trigger.
2. **Reserves attribution bug.** The "single-addition fallback" wrongly aliased `Reserves: 1. Martin` (added by Amir) as Amir's self → `resolveOrProvisionSquadName("Martin")` then routed Martin back to Amir's user → no BENCH row. Fixed: self-detection now restricted to **playing-squad additions** only; reserves are unconditionally guests.

### What to do when you want to onboard Amir's group

1. Add the bot to the WhatsApp group.
2. Someone types `@MatchTime setup`.
3. Walk the Q&A. Pick **MoM + ratings** (and any others you want, **not** attendance).
4. At completion, `featureSquadFromList` auto-sets to true.
5. Messages start archiving immediately. The daily cron at 13:00 BST does the first extraction. You can also trigger it manually any time:
   ```
   curl -H "authorization: Bearer $CRON_SECRET" https://matchtime.ai/api/cron/extract-squads
   ```
6. Any names without phones appear in `/admin/players`.

### Open items / things to note

- **Sub-day timing** is daily-only. For Amir's Mon-Wed list-paste rhythm this should be plenty (squad stabilises 8h+ before kickoff). If we ever miss last-minute Thursday sign-ins for MoM DMs, the plan is in `MDs/learnings.md` — add a rate-limited inline trigger, **not** unbounded fire-on-every-message (that timed out + 500'd the analyze route during this session; reverted).
- **Pi git tree** is ~12 commits behind `origin/main`. No functional impact (none of the changes touch `whatsapp-bot/`) but feel free to `git pull --ff-only` on the Pi when you're up — no service restart needed.
- **Memory updated**: `MDs/skills.md` (full pipeline), `MDs/learnings.md` (5 new entries incl. the Vercel cron cap and the reserves-are-always-guests bug), `MDs/squad-from-list.md` (dedicated design doc).

---

## Architecture (the new pieces, live now)

| Piece | Path |
|---|---|
| New flag | `Organisation.featureSquadFromList` (default false, auto-set at onboarding when MoM/ratings ON + attendance OFF) |
| New table | `GroupMessage` — raw archive for these orgs |
| Library | `src/lib/squad-from-list.ts` — `runSquadExtraction` (Sonnet, 3-day window) → `attributeDiffs` (deterministic) → `learnAliasesFromAttribution` → `finaliseSquadForMatch` |
| Inbound hook | `/api/whatsapp/analyze` archives messages for these orgs, NO per-batch LLM, NO inline extraction (caused 500s — reverted) |
| Backstop | `/api/cron/generate-teams` (daily) runs `runSquadExtraction` for `featureSquadFromList` orgs with a match in the next 12h. Vercel cron cap = 3, so we piggyback on existing crons rather than adding a 4th. |
| Manual endpoint | `GET /api/cron/extract-squads` (bearer `CRON_SECRET`) — manual trigger for debugging + harness. Removed from `vercel.json` scheduling but the route is still live. |
| Onboarding wire-up | `src/lib/onboarding-conversation.ts` — at end of setup, derive `featureSquadFromList = !attendance && (momVoting || playerRating)` |

## Commits (newest first)

```
e5407a2 docs(memory): squad-from-list — skills, learnings, session handoff
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
