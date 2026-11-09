/**
 * A NEW PERSON, BY NAME: the provisional member for somebody the model
 * already placed on nobody in the club.
 *
 * WHO A NAME IS, IS DECIDED ONCE (2026-11-09, review of #574). Every
 * caller reaches here only after who-is-who (`pipeline/who-is-who.ts`),
 * reading the name in its message, said "none": the engine's provisional
 * target, an organiser's "put Mo in" in HQ, a pasted list's new line. This
 * module used to look the name up AGAIN, first by spelling (a first-name
 * prefix read "David" as the member Davide De Sousa, Vets MNF), then by a
 * second model call with no message, which could overrule the first ("Mo,
 * Ali's cousin, is in" read as the member Mohammed). It does neither now:
 * the first answer is the answer, and "none" is a new person.
 *
 * FORMER MEMBERS. On the engine's attendance path (the players' group, and
 * any name in HQ the squad reader did not already place) who-is-who is shown the club's former members too,
 * and one it is sure of in an ORGANISER's IN or bench claim is brought
 * back, never reaching here (a player naming him gets the friend link, as
 * before, and he joins by his own phone) (`identifyFacts`, `attendance-engine-batch.ts`). THE GAP
 * LEFT, said plainly: where the roster shown is the current members only
 * (HQ's squad reader and pasted lists, `club-who-roster.ts`), a former
 * member named again is a new person here. Nothing flags that pair today:
 * /admin/players pairs a placeholder only with a CURRENT member who has a
 * phone (`findDuplicateSuggestions`). A follow-up on the PR.
 */
import { createProvisionalByName } from "./resolve-sender";

/**
 * Create the provisional member for a name who-is-who placed on nobody.
 * Null when the name is empty, or not a person the provisioning rule
 * accepts (`createProvisionalByName`).
 */
export async function provisionNewPerson(
  orgId: string,
  rawName: string,
  opts: {
    /** An admin typed or pasted this name in HQ on purpose and confirmed
     *  it: a short real name ("Mo") is provisioned (`createProvisionalByName`). */
    adminConfirmed?: boolean;
  } = {},
): Promise<{ userId: string; name: string | null } | null> {
  const name = (rawName ?? "").trim();
  if (!name || name.length < 2) return null;
  const provisioned = await createProvisionalByName(orgId, name, null, { deliberate: opts.adminConfirmed === true });
  return provisioned?.userId ? { userId: provisioned.userId, name: provisioned.name } : null;
}
