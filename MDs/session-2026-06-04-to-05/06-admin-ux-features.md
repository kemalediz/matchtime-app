# Admin UX features born from the recovery

The recovery exposed a bunch of "I shouldn't have to DM Claude to do
this" UX gaps. All of these became real features.

## `54da6e3` — "Add player" button (admin section globally)

Before today there was **no way** to add a player from the portal.
Members only appeared via the invite link or the bot auto-creating from
group activity. Guests who played but weren't in the chat had no path
in.

- New `createPlayer(orgId, name, phone?)` action in `players.ts`.
- Phone-aware **dedup-safe**: if a record with that phone exists
  anywhere, reuse it (add/reactivate membership, backfill name) — same
  principle as group-join. Doesn't create a duplicate.
- Errors returned as data (Next redaction lesson from the alias bug).
- Name-only guests get a synthetic unique placeholder email.
- Button on `/admin/players` opens a name + optional phone form.

This is what unlocked Kemal adding Mo, Trevell, etc.

## `e3cf7ea` — "Add player" on the **match page** (admin-only)

Building on top of `createPlayer`. From any match page's Attendance
section, admins can add a missing player straight to that match's
squad — past or future.

- New `addPlayerToMatch(matchId, input, status)` action.
- Shared helper `ensureOrgPlayer` (used by both create + add-to-match)
  resolves `{userId | name+phone | name only}` → ensures org
  membership → returns userId.
- **Killer feature: late rating-link DM.** When the match has happened,
  the org rates players, and the MoM announcement hasn't fired yet,
  the action auto-DMs the player their rating link. So adding someone
  to a past match also gets them their link with one click.
- "Add to bench" toggle for subs.

### Default seed rating = 6
While at it, Kemal asked for new players to default to seed rating 6
(was null before). Two changes:
- `createPlayer` + `ensureOrgPlayer` now write `seedRating: 6` on new
  user creation.
- Backfilled the **60** existing users with no seed rating to 6.
- Left the **32** hand-tuned values (8, 7, 9, 6.5, …) untouched — those
  were deliberate. Kemal picked this in the AskUserQuestion.

## `002614e` — dropdown picker + remove-from-match

After Kemal accidentally created a second "Trevell" by typing the name
instead of selecting from a list, two related fixes:

### Existing-players dropdown in "Add to match"
The match page now serves the admin the list of org members not already
in the match:

```ts
const inMatchIds = new Set(match.attendances.map((a) => a.userId));
const addablePlayers = isAdmin
  ? (await db.membership.findMany({...}))
      .map((m) => m.user)
      .filter((u) => u.name && !inMatchIds.has(u.id))
      .map((u) => ({ id: u.id, name: u.name, hasPhone: !!u.phoneNumber }))
      .sort((a, b) => a.name.localeCompare(b.name))
  : [];
```

The `AddPlayerToMatch` client component:
- Typeahead search of the existing list as you type.
- Pick → passes `userId` (no retyping, no dup risk).
- Falls back to creating a brand-new player only when nothing matches.
- An exact-name existing match suppresses the "create new" path.

### Remove-from-match (×)
Each squad/bench row gets a small admin × button. New
`removePlayerFromMatch(matchId, userId)` action — deletes just that
attendance row; the player's other records are untouched. Confirms
first.

## `13d6fcb` — Sidebar superadmin fix

Kemal asked *"what happened to admin section?"* after the recovery —
he was working in Sutton Lads (where he's only a PLAYER, not admin) and
the Admin link had vanished from the sidebar.

**Cause:** `src/components/layout/sidebar.tsx:87` gated the Admin link
purely on the current-org role:
```js
setIsAdmin(current?.role === "OWNER" || current?.role === "ADMIN");
```
It didn't account for **superadmin**. The `/admin` pages themselves
honor superadmin (`isOrgAdmin` short-circuits true), so the **link**
hid while the **page** still worked → "section disappeared".

**Fix:**
- `/api/memberships` now returns `isSuperadmin: boolean`.
- Sidebar reveals Admin link whenever that's true, regardless of
  current-org role.
- Keeps link and actual access in sync.

Verified by direct-navigating to `/admin` in Chrome — the full
dashboard rendered fine throughout (so it was never broken, just
hidden).
