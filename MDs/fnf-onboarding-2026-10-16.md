# FNF onboarding, 2026-10-15 to 2026-10-17

Friday Night Football (FNF) is the first club to join MatchTime through self-join while running inside a WhatsApp Community, with its own admin group. This doc records the setup, the decisions, every incident whose cause was proven, what shipped, and what is still open. Causes are only called proven where the logs or data showed them.

People: Kemal (owner). Hamzah and Raihan are FNF's organisers and admins. Raihan is the money collector.

## The club as set up

- Friday 20:30 to 22:00 at Harris Merton, 9-a-side.
- Organisers announce (`listAnnouncer` organisers) and organisers pick (`benchPickMode` organiser, fallback leave-empty).
- Rolling squad on. Drop-out deadline Thursday 20:30 (24 hours before kickoff).
- Kit reminder off. Teams ready at 10:00.
- Fee £5. Collect match fees on, with card; Pay by Bank off (Stripe is not connected). Pay directly on. Money collector Raihan.
- Admins: Hamzah and Raihan only (Hamzah's choice).
- Main chat "Friday Night Football", admin group "FNF HQ", both inside a WhatsApp Community.

## Decisions (Kemal unless noted)

- **One architecture for every group.** The players' group, the admin group (HQ) and DMs share the analysis pipeline. No parallel code paths and no rules the owner did not ask for. Now a rule in `CLAUDE.md`.
- **No exact phrases or regex for understanding people.** Use the pipeline, or make the step automatic. Now a rule in `CLAUDE.md`.
- **Keep the word "bench" everywhere, the same for every club.** Players asked "Bench?"; the answer is to let them ask MatchTime, not to rename it per club (#284 closed). Replies quoting MatchTime now count as a tag (#285), so MatchTime can explain.
- **MoM free for the same game is unmanageable.** MoM is decided about 5 days later through the 120 hour rating window. MatchTime proposed in HQ "MoM plays the next game free". FNF's answer is pending.
- **Payment instructions must work for weekly clubs**, not only monthly ones (#307, queued).
- **Quiet hours become a club setting** (#308, queued). FNF off, Sutton keeps the default.
- **Payment tracking (the old WhatsApp poll) is hidden from settings** (#300). Only FNF had it on.
- **Badges post in the players' group for organiser-run clubs too** (#298).

## Incidents and their causes

### 1. WhatsApp refused a stranger's direct add of MatchTime

WhatsApp answered "Can't add... invite them privately" when an FNF organiser added MatchTime directly. MatchTime's group privacy was "Everyone" on WhatsApp's server (verified at bot start: `groupadd=all`). **WhatsApp's reason is NOT confirmed.**

Fix (#274): MatchTime accepts "Invite to group" and pasted group links from a verified organiser.

### 2. FNF was linked to the Community's parent group (PROVEN)

Joining a group inside a Community also adds MatchTime to the Community's parent group and its announcements group. The parent group's add reached the server first, so FNF was linked to the parent group. Proven from the logs.

Fix (#276): Community groups are never linked; the organiser's own add beats a weaker link; late history is stored. FNF was approved before the fix, so the manager repointed `Organisation.whatsappGroupId` and `ClubConnect` by hand.

### 3. No game existed until the nightly cron (PROVEN)

The first match was only created by the nightly 00:00 UTC cron. A list pasted at go-live got no reply because there was no game to attach it to.

Fix (#281): games are made at go-live; a paste with no game gets a reply; no deadline summary is posted for a game created after its deadline; the summary names the deadline and the kickoff separately.

### 4. HQ had its own deterministic route with exact-phrase readers (PROVEN)

HQ ran a separate route, "never analysed, never a model call", reading exact phrases. That was a rule we invented, not one Kemal asked for. Natural requests ("update the graphic please", "Make teams", "replace X with Y") failed silently, and "who are the admins?" got the help menu. Proven in the logs.

Fixes:
- #283: HQ goes through the shared pipeline, with a safe YES (a quoted reply, or the next message within 15 minutes).
- #286: ask the players' group from HQ. The router prompt was rewritten whole, and is shorter.
- #291: a tagged message MatchTime is unsure about is never met with silence; ✅ ticks in HQ; the team sheet is redrawn automatically after changes.
- #296: HQ questions go through the shared question path.
- #297: anyone in HQ can ask questions; changes stay organiser-only.
- #305: HQ records the score through the shared score handling, and the score question moves to HQ.

### 5. Premature "you're in" DM to a benched player (PROVEN)

A player who was only benched got a "you're in" DM. The tentative follow-up DM reply was built from the player's answer, not from the saved status.

Fix (#288): the reply is built from what was saved.

### 6. New-club DM cap held payment messages (PROVEN)

On payments night, pay links were released only after the collector answered the fee question (not at match end). The new-club DM cap (20 a day for the first 28 days) then held acknowledgements and collector notices. DM pacing is one per minute in queue order, so replies waited behind other DMs. Both proven.

Fixes:
- #299: free places stopgap (skip players marked paid before release).
- #304: temporary env exemption `CLUB_LIMIT_EXEMPT_ORG_IDS` for FNF, covering the DM cap and HQ posting hours.
- #306: ✅ on players' "paid" DMs, plus a backfill script.
- #303 (queued): replies go first and are exempt from the new-club cap.

### 7. Pay-link DM listed methods FNF does not offer

The pay-link DM claimed bank, card, Apple Pay and Google Pay, though only paying directly was available. Fix #302 (queued) lists only the available methods.

### 8. HQ chat noise got a false ✅ and an unwanted reply

Organisers chatting in HQ ("Imti Rafi AH back") got a ✅ and a reply they did not want. No write happened (verified). Fix in progress on the night of 2026-10-16: HQ acts on the squad only for clear instructions, stays silent when unsure, and ticks only when something was done.

## Shipped changes

| PR | What |
|---|---|
| #274 | Accept "Invite to group" and pasted group links from a verified organiser |
| #276 | Community groups never linked; organiser's add beats a weaker link; late history stored |
| #281 | Games made at go-live; no-game paste reply; no summary for a game made after its deadline; summary names deadline vs kickoff |
| #283 | HQ through the shared pipeline with safe YES |
| #285 | Replies quoting MatchTime count as a tag |
| #286 | Ask the players' group from HQ; router prompt rewritten whole |
| #288 | Tentative follow-up reply built from the saved status |
| #291 | Tagged unsure never silent; ✅ in HQ; team sheet auto-redrawn |
| #295 | Cross-club "ask a partner club for a player" (built and merged, not on for any club) |
| #296 | HQ questions via the shared question path |
| #297 | Anyone in HQ can ask; changes organiser-only |
| #298 | Badges in the players' group for organiser-run clubs |
| #299 | Free places stopgap |
| #300 | Payment tracking poll hidden from settings |
| #304 | `CLUB_LIMIT_EXEMPT_ORG_IDS` exemption for FNF |
| #305 | HQ records the score; score question moves to HQ |
| #306 | ✅ on "paid" DMs plus backfill |

#284 (rename "bench") was closed without merging.

Cross-club ask (#295): plan in `MDs/cross-club-player-ask-plan-2026-10-16.md`. An adversarial review found 4 high and 7 medium bugs, all fixed before merge.

## Open items

- Queued for the morning of 2026-10-17: #301, #302, #307, #303, #308, in that order. Steps in `MDs/session-handoff-2026-10-17.md`.
- HQ noise fix (incident 8) in progress.
- FNF's answer on "MoM plays the next game free"; build it if they agree.
- Kemal sends Hamzah the payment-instructions tip once #307 is live.
- Trace why Kieran's DM "Tell Raihan I'm retiring" was handled the way it was (not checked yet).
- Why WhatsApp refused the direct add (incident 1) is not confirmed.
- When to drop FNF from `CLUB_LIMIT_EXEMPT_ORG_IDS`. The exemption is temporary; #308 removes its posting-hours part, the DM cap part stays until decided.
