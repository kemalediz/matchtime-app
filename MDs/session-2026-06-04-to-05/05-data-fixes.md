# Data fixes & the merge-loses-aliases bug

## Commit `206a497` — alias-error UX (server-action error redaction)

Kemal tried to add `yusuf.i` as an alias to "Omar Yusuf" and got the
generic *"An error occurred in the Server Components render…"* digest
error.

**Cause:** the alias was already on a different record (named just
"Omar"), so `addPlayerAlias` correctly **threw** *"Alias already
assigned to another player"*. But **Next.js redacts thrown
Server-Action errors in production** — they reach the client as that
generic digest, the real message stripped.

**Fix:** changed `addPlayerAlias` to return a **discriminated union**
instead of throwing for expected validation outcomes:

```ts
export type AddAliasResult =
  | { ok: true; alias: string; alreadyExisted: boolean }
  | { ok: false; error: string; conflictUserId?: string };
```

The handler also names the conflicting player ("…is already an alias of
**Omar**. Merge the two records or remove it there first.").

Auth errors (not signed in, not admin) still throw — those shouldn't
reach the UI as a toast.

**General lesson for this codebase:** Server-Action validation errors
must be **returned as data**, not thrown, to survive Next's production
redaction.

---

## Commit `7414605` — merge-loses-aliases (a real data-loss bug)

Kemal merged Omar (had `yusuf.i` + `yusuf i` aliases) into Omar Yusuf
expecting both aliases to follow — but post-merge, Omar Yusuf only had
`omar`.

### Cause (in `src/lib/merge-players-core.ts` step 8d)

```js
const dropAliases = await tx.userAlias.findMany({ where: { userId: dropUserId } });
for (const a of dropAliases) {
  const exists = await tx.userAlias.findUnique({
    where: { orgId_alias: { orgId: a.orgId, alias: a.alias } },
  });
  if (exists && exists.userId !== keepUserId) await tx.userAlias.delete({ where: { id: a.id } });
  // ...
}
```

`(orgId, alias)` is a **UNIQUE** constraint, so `findUnique` by that
pair returned the very row being migrated. Its `userId` was the drop
user's id → `!== keepUserId` → code concluded "phantom collision" →
**deleted the alias**. The re-point branch never executed.

Every merge in the codebase had been silently throwing away the dropped
player's learned nicknames since this code was written. Only the *name*
of the dropped player survived (it's saved separately in step 8e via
`saveAliasInOrgIds`).

### Fix

Since `(orgId, alias)` is unique, re-pointing only `userId` can never
violate the constraint, and the keeper can't independently hold the same
pair as a separate row. So the entire "collision handling" was wrong
*and* unnecessary. Replaced with a plain re-point:

```js
const dropAliases = await tx.userAlias.findMany({ where: { userId: dropUserId } });
for (const a of dropAliases) {
  await tx.userAlias.update({ where: { id: a.id }, data: { userId: keepUserId } });
}
```

### Scope of the fix

Verified this is the **single shared merge path** — all 3 merge callers
go through `mergePlayersCore`:
- `mergePlayers` (manual merge button)
- `updatePlayerPhone` → auto-merge on phone collision (two paths)

So the fix applies globally to every merge, every org. No other code
deletes aliases (only the legitimate `removePlayerAlias` button does).

### Caveat
Forward-looking only. Merges done **before** this fix already lost
their nicknames; that data isn't automatically recoverable. The
2026-06-05 Omar→Omar Yusuf merge was repaired by hand
(`scripts/_tmp-restore` upserted `yusuf.i` + `yusuf i` onto Omar Yusuf).

---

## One-off data cleanups during the day

### Omar / Omar Yusuf
- "Omar" (no phone, `yusuf.i` alias) — created 2026-05-25 from squad
  list import.
- "Omar Yusuf" (+44 7722 474387) — created 2026-06-02 from group-join.
- Same person, two records. Kemal merged Omar → Omar Yusuf (the one
  with the phone). Surfaced the merge bug; restored aliases by hand.
- Omar Yusuf's stale 4 Jun DROPPED attendance (inherited from old
  "Omar") flipped to CONFIRMED.

### Two Nabeels
- One with a phone (+44 7508 635052), one no-phone with `nabeel` alias.
- Same person. Merged after the merge-bug fix shipped (so the alias
  survived this time).

### Adam wrong phone
- Adam record had `+44 7952 130037` — wrong person.
- Adam's real number is `+44 7956 651717`.
- Corrected the phone (no merge needed — real number wasn't in the DB).
- Merged an empty duplicate "Adam" (no phone, no attendance).
- Re-queued rating link to correct number → delivered.

### Two Trevells
- Kemal added Trevell via the new "Add player" button with phone.
- Then *also* typed "Trevell" in the match's add form (no phone) →
  **created a second record** because the dropdown didn't exist yet.
  Plus an older orphan from 20 May.
- 3 Trevells total. Merged both no-phone records into the phone'd one.
- This experience drove commit `002614e` — the existing-player
  dropdown picker (see `06-admin-ux-features.md`) so it can't happen
  again.

### Mo
- Phone `07952130028`. Not in the system. Kemal added him via the new
  "Add player" button (the *first* legitimate use of it!). Mo got his
  rating link.

### Stale Sutton Lads "Omar" DROPPED row (29 May)
- Pre-existing leftover, not from this session. Left as-is — it has no
  impact on the leaderboard or rating window.

## Final 4 Jun Sutton Lads squad

14 confirmed + 1 bench. All 14 received their rating link
(`14/14` after the Ehtisham/Zeeshan phantom-breadcrumb + Adam wrong-phone
fixes).
