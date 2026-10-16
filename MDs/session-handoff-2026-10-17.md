# Session handoff, 2026-10-17

Restart point after the FNF onboarding session (2026-10-15 to 2026-10-17). The full story and findings are in `MDs/fnf-onboarding-2026-10-16.md`. The previous handoff is `MDs/session-handoff-2026-10-05.md`. No em or en dashes, per Kemal's rule.

## What is live

- **FNF (Friday Night Football)** is approved and running: main chat "Friday Night Football", admin group "FNF HQ", inside a WhatsApp Community. Friday 20:30 to 22:00, Harris Merton, 9-a-side, £5, collector Raihan, admins Hamzah and Raihan. Full settings in the FNF doc.
- FNF's `Organisation.whatsappGroupId` and `ClubConnect` were repointed by hand (it had been linked to the Community parent group before #276).
- Merged and deployed: #274, #276, #281, #283, #285, #286, #288, #291, #295, #296, #297, #298, #299, #300, #304, #305, #306.
- **HQ uses the shared pipeline** for changes, questions and the score (#283, #296, #297, #305).
- **Cross-club player ask** (#295) is merged but not switched on for any club.
- **`CLUB_LIMIT_EXEMPT_ORG_IDS`** (#304) holds FNF: exempt from the new-club DM cap and from HQ posting hours. Temporary.
- In progress on the night of 2026-10-16: HQ acts on squad only for clear instructions, silent when unsure, ticks only when something was done. Check its branch and PR state before anything else.

## Queued for the morning of 2026-10-17 (this exact order)

For each PR: re-run the gates (`tsc`, unit tests, Playwright web suite, build), apply the migration first where noted, merge, then verify the Vercel deploy (`vercel ls`, then `vercel inspect <newest url>`).

1. **#301 free places.** Apply migration `20261016200000_fee_waiver` (includes `AdminFeeProposal`) to prod first. Then gates, merge, verify deploy.
2. **#302 pay message lists only available methods.** Gates, merge, verify deploy.
3. **#307 weekly payment instructions** (built on #302, so rebase or retarget after #302 merges). Gates, merge, verify deploy.
4. **#303 replies first, and replies exempt from the new-club cap.** Migration `20261016230000_botjob_priority` is ALREADY APPLIED. Gates, merge, then set `DM_REPLY_PRIORITY_ENABLED=1` in Vercel production and redeploy. Verify.
5. **#308 quiet hours as a club setting.** Apply migration `20261016230000_quiet_hours_setting`. Then set FNF quiet hours OFF with `scripts/set-quiet-hours.ts` BEFORE deploying, because #308 removes the env hours exemption. Sutton stays on the default. Then gates, merge, verify deploy.

Migrations go in with `psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f <migration.sql>`. Never run a session-level SET on the prod pooler.

## Later

- Once #307 is live, Kemal sends Hamzah the payment-instructions tip.
- Build "MoM plays the next game free" if FNF agrees (proposed in HQ).
- Trace why Kieran's DM "Tell Raihan I'm retiring" was handled the way it was. Not checked yet; do not guess the cause.

## Open decisions

- FNF's answer on "MoM plays the next game free".
- When to drop FNF from `CLUB_LIMIT_EXEMPT_ORG_IDS` (the DM cap part stays after #308).
- Whether and when to switch on cross-club player ask (#295) for any club.
- Why WhatsApp refused the direct add of MatchTime is not confirmed (privacy was `groupadd=all`).

## Gotchas

- Worktree branches drift. The main checkout was once left on a feature branch: always run `git branch --show-current` before pulling.
- The billing-months web test fails only around midnight. Hypothesis (not confirmed): a date boundary in the test.
- Tailscale SSH to the Pi sometimes needs Kemal's browser approval. Deploy the Pi only with `scripts/deploy-pi.sh`.
- GitHub mergeability can read UNKNOWN for a minute after a push. Wait and re-check rather than treating it as a conflict.
- Live-LLM suites still need Kemal's approval each time.
