# Session handoff for the move to CRESSOFTSERVER (25 Nov 2026)

## Recreate these scheduled jobs in the new session
They lived only in the old session's memory. Full prompts are in the old transcript; the essentials:
1. **Nightly shortage check, 19:07 daily.**
   - Read-only prod query of the next 8 days.
   - Post only for short Sutton FC matches, per MDs/backups/fb-posting-ledger.md (on branch wip/2026-11-25-ops-scripts-and-notes until merged): FB groups by their day rules, Nextdoor on Wednesday and Sunday evenings (src=nd).
   - Never Friday MT Community (its matches were removed 25 Nov, activity off), never FNF, Vets report only.
   - Report to CressoftPA.
2. **Daily group expansion, 10:13.** About 8 FB joins a day, rules read first, honest answers. Post in newly approved groups per their rules.
3. **Supabase Disk IO mail watch, every 3 hours.** Gmail search `supabase "Disk IO" newer_than:1d`; tell PA about any new warning.
4. **Disk IO overnight measurement (one-off, morning after the move).**
   - Read pg_stat_archiver.archived_count. Baselines:
     - 30 segment switches an hour before #633;
     - 18 an hour after #633;
     - an estimate of about 7 to 8 an hour after #634.
   - Send the before and after numbers to PA.

## Posting schedule already promised (see the ledger)
- Fri 27: Epsom Surbiton Chessington group, Mitcham groups. Admin chases allowed again.
- Sat 28 or Sun 29: South Of The Borough (weekend adverts only).
- Mon 30: Wimbledon Local Group (Mondays, full postcode SM3 9BY).
- Tue 1 Dec: Surbiton Neighbourhood (business posts on the 1st only).
- Coulsdon Community Hub: Wednesdays, only inside the admins' designated post.

## Rules carried over
- Prod DB read-only (`BEGIN READ ONLY ... ROLLBACK`, never SET).
- No phone numbers in posts. Sign-up only via matchtime.ai/play?src=<code>. "First game free" covers Sutton (no price unless the match fee is set).
- Pi deploys only via scripts/deploy-pi.sh (bash plus ssh over Tailscale).
