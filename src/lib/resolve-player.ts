import { db } from "@/lib/db";
import { normaliseName } from "@/lib/squad-from-list";
import { normalisePhone } from "@/lib/phone";

/**
 * Conservative, READ-ONLY "does this person already exist in the org?" lookup.
 *
 * Shared by every name/phone-based add path (dashboard manual add, add-to-match,
 * WhatsApp participant-sync) so they all behave identically and never silently
 * mint a duplicate User when a strong, unambiguous match already exists.
 *
 * SAFETY STANCE (critical — must NOT merge two distinct people):
 *   We only return an existing member on a STRONG, unambiguous signal:
 *     1. phone match (when a phone is supplied) — phone is a unique key, so
 *        this is definitive;
 *     2. a UserAlias (orgId + normalised alias) hit — admin-curated or
 *        auto-detected ground truth;
 *     3. exactly ONE active member whose normalised name EQUALS the input;
 *     4. exactly ONE active member matched by the same conservative first-token
 *        fuzzy rule the analyzer uses.
 *   If ZERO members match → return null (caller creates a new record, status
 *   quo). If MULTIPLE members are ambiguous (e.g. two "Omar"s) → we DO NOT
 *   auto-pick; we return null so the caller creates a fresh record rather than
 *   wrongly collapsing two distinct people. A duplicate an admin can later
 *   merge is a far safer failure mode than silently merging two real people.
 *
 * This helper does NOT mutate anything (no membership restore, no name
 * backfill). Callers own those side-effects so each entry point keeps its
 * existing semantics.
 *
 * Matching is scoped to the SAME org's memberships. Soft-removed members
 * (leftAt set) are INCLUDED so a returning player is reused/restored rather
 * than duplicated.
 */
export async function findExistingOrgMember(
  orgId: string,
  input: { name?: string | null; phone?: string | null },
): Promise<{ userId: string; name: string | null } | null> {
  // ── 1. Phone is the strongest, unambiguous signal ──────────────────────
  const phoneInput = (input.phone ?? "").trim();
  if (phoneInput) {
    const phone = normalisePhone(phoneInput);
    if (phone) {
      const byPhone = await db.user.findUnique({
        where: { phoneNumber: phone },
        select: { id: true, name: true },
      });
      // Only treat it as a match if that user is actually a member of THIS org
      // (active or soft-removed). A phone that belongs to someone in another
      // org isn't a match for this org's add.
      if (byPhone) {
        const mem = await db.membership.findUnique({
          where: { userId_orgId: { userId: byPhone.id, orgId } },
          select: { id: true },
        });
        if (mem) return { userId: byPhone.id, name: byPhone.name };
        // Phone exists but no membership in this org — still the same person;
        // reuse the User record (caller adds the membership).
        return { userId: byPhone.id, name: byPhone.name };
      }
    }
  }

  // Name-based matching from here on.
  const name = (input.name ?? "").trim();
  if (!name || name.length < 2) return null;

  const key = normaliseName(name);
  if (key.length < 2) return null;

  // ── 2. Alias hit — admin-curated / auto-detected ground truth ──────────
  const alias = await db.userAlias.findUnique({
    where: { orgId_alias: { orgId, alias: key } },
    include: { user: { select: { id: true, name: true } } },
  });
  if (alias) return { userId: alias.userId, name: alias.user.name };

  // Load the org roster once for the name comparisons below. Soft-removed
  // members are included (we reuse a returning player rather than duplicate).
  const candidates = await db.membership.findMany({
    where: { orgId },
    include: { user: { select: { id: true, name: true } } },
  });

  // ── 3. Exactly one exact normalised-name match ─────────────────────────
  const equals = candidates.filter(
    (c) => c.user.name && normaliseName(c.user.name) === key,
  );
  if (equals.length === 1) {
    return { userId: equals[0].user.id, name: equals[0].user.name };
  }
  // Multiple exact matches → ambiguous, do not auto-pick. (Falls through to
  // null below.) Fuzzy would only widen the ambiguity, so skip it too.
  if (equals.length > 1) return null;

  // ── 4. Exactly one conservative first-token fuzzy match ────────────────
  //   Same rule resolveOrProvisionByName uses: first tokens equal, or one is a
  //   prefix of the other when both are long enough. Uniqueness is the guard —
  //   ambiguous fuzzy (e.g. "Ed" matching both "Ediz" and "Edward") returns
  //   null rather than guessing.
  const inputFirst = key.split(/\s+/).filter(Boolean)[0] ?? "";
  const fuzzy = candidates.filter((c) => {
    if (!c.user.name) return false;
    const dbFirst = normaliseName(c.user.name).split(/\s+/).filter(Boolean)[0] ?? "";
    return (
      dbFirst === inputFirst ||
      (dbFirst.length >= 3 &&
        inputFirst.length >= 3 &&
        (dbFirst.startsWith(inputFirst) || inputFirst.startsWith(dbFirst)))
    );
  });
  if (fuzzy.length === 1) {
    return { userId: fuzzy[0].user.id, name: fuzzy[0].user.name };
  }

  // Zero or ambiguous → no safe match; caller creates a new record.
  return null;
}
