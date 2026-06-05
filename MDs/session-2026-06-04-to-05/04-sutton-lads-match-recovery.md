# Sutton Lads 4 Jun match recovery (`af127e4`)

The big one. Kemal: *"we had a match yesterday Sutton Lads — Thursday
4th of June. Now I noticed nobody received any rating link. I just
checked the attendance of the match. It shows 0 attendance."*

## Diagnosis

Sutton Lads runs in **squad-from-list mode**:
- `featureAttendance: false`
- `featureSquadFromList: true`
- `featureMomVoting: true`, `featurePlayerRating: true`

In this mode the bot doesn't read IN/OUT messages — it reads the pasted
squad list, registers attendance from it, and DMs rating links at
match-end. Match-end DMs only go to CONFIRMED players, so 0 confirmed →
0 DMs.

### What I found

Reading the data:
- The 4 Jun match had **1 attendance row** — "Omar", status DROPPED,
  from 29 May (a week earlier). Effectively 0 confirmed.
- **`GroupMessage` rows since 2 Jun: 0** despite 15 `WindowVerdict`
  rows (shadow analyzer) on those same days, *including 14:58 and 20:01
  on match day*.
- The 14:58 verdict literally contained: *"Squad is now full (14/14)
  with Eman on bench"* with state changes adding Ehtisham #1, Amir #2,
  Martin #3, Nabeel #4, ... all 14 + Eman on bench.

So the analyzer **saw** the squad correctly; it just never got written
to attendance.

### Root cause

In `src/app/api/whatsapp/analyze/route.ts`:

```js
const f = await getOrgFeatures(org.id);
const needsAnalyzer =
  f.attendance || f.bench || f.teamBalancing || f.reminders || f.statsQa;
if (!needsAnalyzer) {
  if (f.squadFromList) {
    await storeMessagesForSquadFromList(org.id, body.groupId, body.messages);
  }
  return NextResponse.json({ ok: true, ignored: "no-message-driven-features" });
}
// ... rest of analyzer
```

The `storeMessagesForSquadFromList` archive (the only thing that saves
squad-list messages so the extraction cron can find them) was INSIDE
the `if (!needsAnalyzer)` block.

**Commit `3917f00` (29 May) — "keep featureStatsQa unconditionally on
for all orgs"** flipped `featureStatsQa` to true everywhere. That made
`needsAnalyzer` always true → the `if (!needsAnalyzer)` block stopped
running → archive stopped → cron had nothing to read →
no attendance registered → no rating DMs.

Confirmed temporally: last archived `GroupMessage` was **28 May 22:08**.
Nothing after that. The cutoff lines up exactly with the commit date.

## Fix

Moved the archive **out of the gate** — it now always runs for
squad-from-list orgs, independent of whether the analyzer also runs:

```js
if (f.squadFromList) {
  await storeMessagesForSquadFromList(org.id, body.groupId, body.messages);
}
const needsAnalyzer = f.attendance || f.bench || ...;
if (!needsAnalyzer) {
  return NextResponse.json({ ok: true, ignored: "no-message-driven-features" });
}
```

Future matches register the squad automatically. Verified by the next
Thursday's cycle (out-of-scope for this writeup).

## The recovery (a long thread of its own — see also `05-data-fixes.md`)

Used the shadow analyzer's 14:58 verdict as ground truth (it had the
full squad list). Steps:

1. **Dry-run name matching** — wrote a script comparing the 15 squad
   names against active Sutton Lads memberships. Matched 10/14
   confirmed + Eman on bench. Flagged unresolved: **Adz, Trevell,
   Yusuf.i, Mo, Zeeshan (no phone), Nabeel (duplicate records)**.
2. **Registered the 10 confirmed + Eman** via attendance upserts.
3. **Queued rating-link DMs** to those with phones (replicated the
   scheduler's exact DM template + idempotency-key writes).
4. **One bug surfaced during the recovery:** my matcher only compared
   display names, ignoring the **alias table**. Yusuf.i actually
   resolved to "Omar" via the `yusuf.i` alias — but I'd already asked
   Kemal who Yusuf.i was. Apologies and corrected. The fix going
   forward is "always check aliases first."
5. Kemal then merged Omar → Omar Yusuf (which triggered the
   merge-loses-aliases bug — see `05-data-fixes.md`).
6. Eventually got all 14 confirmed + Eman bench, all 14 sent rating
   DMs.

## Verifying delivery

Late in the day Kemal asked "can you check if all players received the
DMs". Found **two phantom-sent breadcrumbs**:
- **Ehtisham** — breadcrumb was set at 08:22 but no actual rate-dm
  BotJob had been queued. My first recovery run had skipped him as
  "already sent" based on a stale marker.
- **Zeeshan** — no DM ever to his phone. Breadcrumb set without a send
  (he had no number when the recovery first ran).

Both were artifacts of **manual** recovery setting breadcrumbs at
queue-time rather than delivery-time. In the normal scheduler flow this
can't happen — the SentNotification breadcrumb is written by the Pi's
ACK on actual delivery, not by the scheduler when it queues.

Queued links for both → delivered. Final state: **14/14 received their
rating + MoM link.**

## Then: Adam's wrong number

Kemal: *"Adam says I haven't gotten a message yet."* Phone he gave:
`+44 7956 651717`. DB had `+44 7952 130037` on the "Adam" record.

So the rating DM went to a stranger's number, not Adam. Fixed:
- Corrected Adam's phone to the real one.
- Merged the empty duplicate "Adam" record (no phone, no attendance).
- Re-queued rating link to the correct number — delivered.

Confirmed no rating data was lost or split: it's the SAME Adam record
throughout; only the phone field changed. 6 ratings received this
match, 40 all-time — all visible to Adam when he opens his link. And
0 ratings/MoM cast by Adam (the wrong-number person hadn't used the
link to vote as Adam).

## What the recovery taught us

- The match-page-level **"Add player to match"** feature (see
  `06-admin-ux-features.md`) was born here so Kemal can handle this
  class of issue without DMing me.
- The cross-club aggregator + leaderboard improvements (see
  `07-stats-improvements.md`) all came from Kemal noticing issues on
  his stats page while doing the recovery.
