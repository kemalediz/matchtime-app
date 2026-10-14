/**
 * NAMING A THIRD PARTY: fuzzy-match a free-text name against the club, or
 * provision a new member. Moved verbatim out of
 * `api/whatsapp/analyze/route.ts` on 2026-10-14 so the admin group's squad
 * changes (`admin-group-squad-change.ts`, `admin-group-paste.ts`) apply a
 * name with the same code as the players' group. Behaviour unchanged.
 */
import { db } from "./db";
import { createProvisionalByName, restoreMembership } from "./resolve-sender";

/**
 * Fuzzy-match a free-text name against the org's roster, or create a
 * provisional member if no unique match. Used for:
 *   - the message sender themselves (resolveSender fallback)
 *   - third-party registrations ("my dad Najib is also in" → lookup
 *     "Najib" in org, else provision)
 *
 * Returns null only when the name is empty / obviously not a person.
 */
export async function resolveOrProvisionByName(
  orgId: string,
  rawName: string,
  opts: {
    /** An admin pasted this name in the admin group, was told "I'll add
     *  them as a new player", and confirmed with YES. The name is
     *  deliberate: a short one ("Mo") is provisioned, and when only
     *  removed members make it ambiguous a new player is added as
     *  promised rather than nothing. */
    adminConfirmed?: boolean;
  } = {},
): Promise<{ userId: string; name: string | null } | null> {
  const name = rawName.trim();
  if (!name || name.length < 2) return null;
  const deliberate = opts.adminConfirmed === true;

  // 1. Fuzzy lookup against existing members. Soft-removed members are
  //    INCLUDED in the candidate set so we restore them rather than
  //    creating a duplicate ghost when they get re-mentioned in chat.
  const candidates = await db.membership.findMany({
    where: { orgId },
    include: { user: { select: { id: true, name: true } } },
  });
  const norm = (s: string) =>
    s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const pushTokens = norm(name).split(/\s+/).filter(Boolean);
  const pushFirst = pushTokens[0] ?? "";

  const equalsMatches = candidates.filter(
    (c) => c.user.name && norm(c.user.name) === norm(name),
  );
  if (equalsMatches.length === 1) {
    const m = equalsMatches[0];
    if (m.leftAt) await restoreMembership(m.id, m.user.name);
    return { userId: m.user.id, name: m.user.name };
  }

  const firstNameMatches = candidates.filter((c) => {
    if (!c.user.name) return false;
    const dbTokens = norm(c.user.name).split(/\s+/).filter(Boolean);
    const dbFirst = dbTokens[0] ?? "";
    return (
      dbFirst === pushFirst ||
      (dbFirst.length >= 3 &&
        pushFirst.length >= 3 &&
        (dbFirst.startsWith(pushFirst) || pushFirst.startsWith(dbFirst)))
    );
  });
  if (firstNameMatches.length === 1) {
    const m = firstNameMatches[0];
    if (m.leftAt) await restoreMembership(m.id, m.user.name);
    return { userId: m.user.id, name: m.user.name };
  }
  // Ambiguous: multiple players match the given name ("Ibrahim" when
  // there are two). BEFORE bailing out, try the alias table — admin-
  // curated UserAlias rows are unique per (orgId, alias) so an alias
  // hit disambiguates cleanly regardless of fuzzy ambiguity. Same fix
  // as resolveSender (Kemal flagged Baki/"ba" 2026-05-15).
  if (firstNameMatches.length > 1) {
    const aliasKeyEarly = norm(name);
    if (aliasKeyEarly.length >= 2) {
      const alias = await db.userAlias.findUnique({
        where: { orgId_alias: { orgId, alias: aliasKeyEarly } },
      });
      if (alias) {
        const m = candidates.find((c) => c.userId === alias.userId);
        if (m) {
          if (m.leftAt) await restoreMembership(m.id, m.user.name);
          console.log(
            `[analyze] third-party ambiguous "${name}" resolved via UserAlias → ${m.user.name} (${alias.userId})`,
          );
          return { userId: m.user.id, name: m.user.name };
        }
      }
    }
    // An admin's deliberate name that only REMOVED members share is a new
    // player (a pasted list's preview matches current members only and
    // promised exactly that). Two CURRENT members sharing it is a real
    // ambiguity: nothing is guessed and no duplicate is made.
    if (!deliberate || firstNameMatches.some((c) => !c.leftAt)) {
      console.warn(
        `[analyze] third-party name "${name}" is ambiguous in org ${orgId} (${firstNameMatches.length} candidates, no alias to disambiguate). Skipping registration.`,
      );
      return null;
    }
    console.log(`[analyze] admin-confirmed name in org ${orgId} matches ${firstNameMatches.length} removed members; adding as new`);
  }

  // 1c. Alias lookup — admin-curated nickname → user mapping. Same
  //     reason as resolveSender: covers "Nunu" → Elnur, "Mike" →
  //     Michael Allen, etc. that fuzzy can't bridge.
  const aliasKey = norm(name);
  if (aliasKey.length >= 2) {
    const alias = await db.userAlias.findUnique({
      where: { orgId_alias: { orgId, alias: aliasKey } },
    });
    if (alias) {
      const m = candidates.find((c) => c.userId === alias.userId);
      if (m) {
        if (m.leftAt) await restoreMembership(m.id, m.user.name);
        return { userId: m.user.id, name: m.user.name };
      }
    }
  }

  // 2. No unique match and no ambiguity → provision. No phone known (third party).
  const provisioned = await createProvisionalByName(orgId, name, null, { deliberate });
  if (provisioned) return { userId: provisioned.userId!, name: provisioned.name };
  return null;
}
