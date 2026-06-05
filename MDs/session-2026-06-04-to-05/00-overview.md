# Session 2026-06-04 → 2026-06-05 — overview

Two intense days. Started by finishing the Stripe per-match payment build end-to-end (chat fee-capture → confirm → release → checkout → webhook), did the live e2e in sandbox, then a Sutton Lads match exposed an archive regression and triggered a cascade of recovery work + small UX bugs that became their own features.

## Files in this folder

| File | What it covers |
|---|---|
| [01-stripe-payments-build.md](01-stripe-payments-build.md) | Chat fee-capture, method-aware chaser, collector page; emoji-confirm bug found & fixed during e2e |
| [02-payments-e2e-test.md](02-payments-e2e-test.md) | The isolated test-org fixture, Stripe sandbox onboarding (driven via Chrome), card checkout success + webhook proof |
| [03-landing-page-stats-showcase.md](03-landing-page-stats-showcase.md) | 3-phone-mockup stats showcase + faithful Wrapped card on matchtime.ai (fictional data) |
| [04-sutton-lads-match-recovery.md](04-sutton-lads-match-recovery.md) | The big one: 4 Jun match registered 0 players. Root cause was a regression from the "statsQa-on-for-all-orgs" commit. Fixed the archive, recovered the squad, sent rating DMs. |
| [05-data-fixes.md](05-data-fixes.md) | Duplicate-record cleanup (Trevell, Adam-wrong-phone, the two Nabeels, Omar/Omar Yusuf merge); merge-loses-aliases bug fix |
| [06-admin-ux-features.md](06-admin-ux-features.md) | "Add player" globally, "Add to match" with auto rating-DM, dropdown picker, remove-from-match, sidebar superadmin fix, alias-error UX, default seed rating = 6 |
| [07-stats-improvements.md](07-stats-improvements.md) | Cross-club "All clubs" overview; MoM count = wins (not votes); attendance % since joining; leaderboard shows everyone, marks 1-game players |
| [08-parked-followups.md](08-parked-followups.md) | Shorten magic-link DMs (short-code redirect); tear down mt-test-payments org after Stripe trial |

## Commits on `main` this session (chronological)

```
d6cd874  feat(payments): chat fee-capture, method-aware chaser, collector page
dfec963  fix(payments): recognise emoji confirmations in collector fee-capture
35b4b5b  feat(landing): rich season-stats showcase with phone mockups
af127e4  fix(analyze): always archive messages for squad-from-list orgs
206a497  fix(players): return alias validation errors as data, not thrown
7414605  fix(merge): stop deleting the dropped player's aliases on merge
54da6e3  feat(players): manual "Add player" button in admin
a31c96f  feat(stats): "Across all your clubs" overview for multi-club players
e3cf7ea  feat(matches): admin "Add player" on the match page + default seed 6
002614e  feat(matches): pick existing players from a dropdown + remove from squad
13d6fcb  fix(sidebar): show Admin link for superadmins in non-admin orgs
f18d62f  fix(stats): MoM = wins not votes; attendance % since player joined
54e5a4d  feat(stats): leaderboard shows everyone rated, marks 1-game players
```

All Ready on prod (matchtime.ai); Pi pulled + restarted after each.

## Bugs caught this session that almost shipped silent

1. **Squad-list archive disabled** by the 29 May `featureStatsQa`-on-for-all-orgs commit — Sutton Lads 4 Jun match registered 0 players, no rating DMs went out. Caught because Kemal noticed an empty attendance.
2. **`✅` (and `👍`) didn't confirm a fee** — the regex ended in `\b`, which never matches after a lone emoji. Caught during e2e in the test org.
3. **Merge silently deleted the dropped player's aliases** — `findUnique(orgId_alias)` returned the very row being migrated, the code saw `userId != keep`, called it a collision and deleted. Caught when Kemal noticed `yusuf.i`/`yusuf i` vanished after merging Omar → Omar Yusuf.
4. **Sidebar Admin link gated only on current-org role** — superadmins lost the link on org-switch even though `/admin` pages still worked. Caught when Kemal asked "what happened to admin section?"
5. **Magic-link tokens are long** (~250 chars). Diagnosed; backward-compatible short-code redirect designed; parked for later.
6. **All-clubs MoM count was raw vote rows, not wins.** Caught because Kemal saw "9 MoM" on his stats page.
7. **Attendance % denominator was all-matches-since-launch.** David got 14% for playing his only available match. Fixed to count-since-joining.
8. **Leaderboard `minGames: 2` hid newcomers** — half the Sutton Lads squad invisible. Lowered to 1 with a "1 game" provisional tag.

## Key memory updates (in `~/.claude/projects/.../memory/`)

- `project_payments_stripe.md` — payment system + Stripe state.
- `project_parked_followups.md` — short-links + test-org teardown.
- `MEMORY.md` index updated.
