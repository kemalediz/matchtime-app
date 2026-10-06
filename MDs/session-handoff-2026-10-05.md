# Session handoff, 2026-10-05

Written at the end of a long session (2026-09-28 to 2026-10-05) so the next session can pick up without the transcript. Everything below was checked at the time of writing. No em or en dashes, per Kemal's rule.

## How this session worked

- The main session acted as engineering manager: Opus subagents built and reviewed, the main session re-ran gates, merged, deployed, and reported.
- Money work (billing) always got an adversarial review round (often 2 or 3) before merge. Keep doing that.
- Database migrations were applied to prod BEFORE merging, because new code selects the new columns unconditionally. Use `psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f <migration.sql>`; migrations carry `SET LOCAL lock_timeout = '5s'`.
- Never run a session-level SET on the prod pooler. Read-only checks are plain SELECTs.
- The Pi is deployed only with `scripts/deploy-pi.sh` over ssh to `davidediz@matchtime-pi.tail1437f5.ts.net`. Tailscale often asks for a browser check: Kemal signs in himself (Claude never types credentials).
- Kemal delegated approvals to Claude ("act on my behalf"), except: never type passwords, codes, card or bank details or live secret keys; announce live-money steps in one line. Permanent deletions in dashboards are refused by the auto-mode classifier: leave those to Kemal.
- Live-LLM suites need Kemal's explicit approval each time.

## What shipped (all merged to main and deployed)

### Club fee billing (LIVE since 2026-10-05)
Plan and runbook: `MDs/club-fee-billing-plan-2026-10-01.md` (section 16 is the go-live runbook).
- Model: free first month from approval, then charged after each club month for the games PLAYED: fee = £9.99 x played / scheduled, VAT included, card on file, one Stripe invoice per month, no subscription. Under 30p not charged. Custom price is a monthly maximum. No back-charging for months on Free, suspended, or with billing off. Suspend waives the open month. Stop paying ends at month end.
- The money collector owns the card (owner if none). Sutton and every club with `approvedAt` null are always exempt.
- PRs: B1-B5 #179 #180 #181 #182 #183, then the games-played model P1 #187, P2 #188, P3 #189, P4 #191, test-mode fixes #192, public website copy #193.
- `BILLING_ENABLED=1` in Vercel production. No billed club exists yet (all 3 clubs exempt). The first charge comes about day 61 after the first self-join approval.
- Live Stripe (account `acct_1TeMnhGWf71DV2cF`, named MatchTime, legal entity Cressoft Consultancy Limited). **HomeTenant also takes engineer payments through this account** (its webhook `we_1Tl7kOGWf71DV2cFOox2Zudc`), so account-wide settings affect it.
  - Product `prod_VNvZlwjTBelulZ` "MatchTime club", statement descriptor MATCHTIME CLUB.
  - Tax rate `txr_1UN9h5GWf71DV2cFX9NSCEGa`: VAT, United Kingdom, 20%, inclusive.
  - Default invoice tax ID: GB VAT GB112454354.
  - Invoice retries: Smart Retries up to 4 times within 1 week; invoice left overdue after.
  - Billing webhook `we_1UN9nQGWf71DV2cFBfVbCI4T` "MatchTime club fee (billing)", Your account, 7 events (checkout.session.completed, invoice.paid, invoice.payment_failed, invoice.payment_action_required, invoice.voided, invoice.marked_uncollectible, payment_method.detached), URL https://matchtime.ai/api/stripe/billing-webhook. Secret in Vercel `STRIPE_BILLING_WEBHOOK_SECRET` (set by Kemal).
  - Match-fee webhook unchanged: `we_1TgYEOGWf71DV2cFhK8jA4ct` (Connected accounts). The old platform-scoped `we_1TgQL6...` was deleted by Kemal.
  - Customer receipt/refund emails deliberately left OFF (would send HomeTenant payers "MatchTime" receipts). Our copy points to the billing page for receipts.
- Vercel prod env: `BILLING_ENABLED=1`, `STRIPE_CLUB_PRODUCT_ID`, `STRIPE_CLUB_TAX_RATE_ID`, `BILLING_STRIPE_RETRIES=1`, `STRIPE_BILLING_WEBHOOK_SECRET`. `BILLING_CRON_RETRIES` unset (off).
- Stripe CLI on this Mac is logged in to the account in TEST mode until 2027-01-02. Test objects: product `prod_VNjhVVajrxYiNU`, inclusive rate `txr_1UMyEAGWf71DV2cF5eI9QujI`.
- Read-only report of would-be monthly fees: `node --env-file=.env --import tsx scripts/club-billing-month-report.ts --months 4 --current --games`.

### AI caps (#178, live)
$2/day for the first 30 days after approval, $1.50/day after (Sutton override 1.5), $0 unapproved. Admins get one DM a day at the cap via the admin channel. `AI_DAILY_CAP_DISABLED` removed from prod.

### Other features shipped this session
- Price on the website: up to £9.99 a month per group, only the weeks you play (#169, #193).
- Unpaid reminder for weekly-deadline clubs + admin unpaid list (#170).
- Badge share cards (#171), help badges topic (#172), group badge announcements 2 days after each match at 18:00 (#173; ledger backfilled from 22 Sept; first post went out 2026-10-01).
- Self-join copy: "until your club is approved", full group hello, organiser checklist DM (#174).
- Bench offer: one announcement per opened slot and "tonight" only on match day (#186).
- F1 info buttons on every organiser page, EN and TR (#195).
- F2: the Pi re-checks the club list once before ignoring a re-add; bad /orgs responses no longer empty the list (#194). Pi deployed with it (commit cd7bfb2).
- F3 learned setup from the group chat (#196): MERGED BUT OFF (`SETUP_LEARNING_ENABLED` unset). Migration applied.

## Open items, in order

1. **F3 live check:** needs Kemal's "yes, run it". Script `scripts/live-check-setup-learning.ts --approved` (dev key, 6 fixtures once each, about $0.04, hard stop $0.25). Then show Kemal the Turkish DM (`copy.tr.snap`), then set `SETUP_LEARNING_ENABLED=1` in Vercel prod.
2. **Monthly squad mode (Vets MNF group):** plan in docs PR #197 (`MDs/monthly-squad-plan-2026-10-05.md`, branch `docs/monthly-squad-plan`, worktree `../matchtime-monthly-plan`). Waiting on Kemal's answers to D1-D6 (recommended: organiser sets price with suggestion; every missed game earns credit; "(paid)" shown on claim, collector confirms; pasted lists may change others' lines with an undo DM; bank transfer first; mode switched on in Settings, F3 only suggests). The plan was written before F3 merged, so update its F3 section. Seven slices, no AI; to start in November, slices 1-4 by about 24 Oct. Slice 1 also fixes a bug for every club: names under "Paid but can't play" style headers are read as players (`src/lib/pasted-roster.ts` RESERVE_HEADER only knows Reserves/Subs/Standby).
   - The Vets chat export is only in the session scratchpad (real names, phones, bank details): never commit it. F3's fixture is an anonymised copy.
3. **Left to Kemal:** first real charge (watch /admin/clubs and /admin/health when the first self-join club is approved), Hamzah's group (he signs up and adds MatchTime, Kemal approves, then switch on his Friday settings).
4. Low items from billing reviews, not blocking: a club already on Free when MatchTime is removed gets no "removed" marker; same-second card sessions are handled by advisory lock and id tie-break.

## Where to look
- Billing plan + runbook: `MDs/club-fee-billing-plan-2026-10-01.md`
- Friday features plan: `MDs/friday-group-features-plan-2026-09-30.md`
- Self-join plan: `MDs/self-join-and-approval-plan-2026-09-28.md`
- Findings backlog: `MDs/findings.md` (F3 entry can be removed once F3 is switched on)
- Memory index: `~/.claude/projects/-Users-kemal-Projects-Cressoft-Sports-matchtime/memory/MEMORY.md`

## Update, 2026-10-06

- **Monthly squad mode is complete and live** (off unless a club switches to monthly): slices 1 #199, 2 #200, 5 #201, 3 #202, 4 #203, 6 #205. Plan with "as built" and "Changed after review" blocks: `MDs/monthly-squad-plan-2026-10-05.md`. Each money slice took 2 to 4 adversarial review rounds; every round found real bugs. Only optional slice 7 (card payment for the month) is not built. After any `prisma db push`, re-run `prisma/sql/monthly-squad-check.sql` (it restores the partial unique index and CHECKs).
- **Vets MNF go-live needs:** Davide or Shane to sign up on matchtime.ai and add MatchTime to the group, Kemal's approval, then Settings > Monthly squad > Monthly, and paste the October list on the Months page.
- **F3 learned setup:** first live check (2026-10-05, $0.044) failed 3 of 6; prompt rewritten and two-quote guard added in #198 (merged, flag still off). A second approved run is needed before switching on (`scripts/live-check-setup-learning.ts --approved`, about $0.05).
- **Double squad post fixed** (#204): timed posts skip the roster if the same squad was posted in the last 3 hours; the morning chase is skipped after a recent recruit ack.
- **Open question for Kemal:** remove the remaining em dashes from about 84 fixed group strings and from the composer's English output (applyHouseStyle), code-only.
- **Known gaps:** a bare "IN" replying to the month list needs a Pi change (quotedBody); Tailscale on this Mac could not see the Pi on 2026-10-06 (reconnect before the next Pi deploy).

## Update, 2026-10-06 (afternoon)

- **F3 learned setup is ON** (`SETUP_LEARNING_ENABLED=1` in Vercel production, set 2026-10-06 after Kemal approved the Turkish DM wording). Second live check passed 5 of 6; #206 then made "organisers pick" a suggestion only, and all six pass in the offline replay.
- **Long dashes removed** from everything MatchTime says (#207), Pi deployed at `b36de13` on 2026-10-06 13:19. One string still has a dash: `dm_fee_confirm_prompt`, which is part of the AI's instructions and needs an approved paid check to change.
- Tailscale on this Mac sees the Pi again.
