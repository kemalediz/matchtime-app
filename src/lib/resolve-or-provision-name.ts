/**
 * NAMING A THIRD PARTY: who a free-text name is in the club, or a new
 * provisional member. Moved out of `api/whatsapp/analyze/route.ts` on
 * 2026-10-14 so the admin group's squad changes (`admin-group-squad-change.ts`,
 * `admin-group-paste.ts`) apply a name with the same code as the players'
 * group.
 *
 * WHO A NAME IS, IS THE MODEL'S (2026-11-09, Kemal: "never use string
 * matching"). This used to compare the name with every membership by
 * spelling (the whole name, a first name, an alias); a first-name prefix
 * here read "David" as the member Davide De Sousa (Vets MNF, 2026-11-09).
 * Now the names go to who-is-who (`pipeline/who-is-who.ts`) in ONE call,
 * with every membership of the club, current and former (a former member
 * named again is brought back rather than added twice), each with the
 * club's aliases. A member it is sure of is that member; nobody is a new
 * provisional member; several possible members, or a failed call, is
 * nobody at all (null), never a guess.
 */
import { db } from "./db";
import { createProvisionalByName, restoreMembership } from "./resolve-sender";
import { personPickerFor } from "./pipeline/identify-batch";
import type { PersonPick, PersonPicker, WhoRosterMember } from "./pipeline/who-is-who";
import { refKey } from "./pipeline/who-is-who";

export interface ResolveOrProvisionOptions {
  /** An admin pasted this name in the admin group, was told "I'll add
   *  them as a new player", and confirmed with YES. The name is
   *  deliberate: a short one ("Mo") is provisioned, and when only
   *  removed members could be meant a new player is added as promised
   *  rather than nothing. */
  adminConfirmed?: boolean;
  /** The message the names came from, for the model to read them in.
   *  Absent: the names alone. */
  context?: string;
  /** Tests inject the picker; absent, `personPickerFor`. */
  identify?: PersonPicker;
}

type Resolved = { userId: string; name: string | null };

/**
 * Every name at once (a pasted list is one call, not one per name). The
 * result maps each trimmed name to its member, its new provisional
 * member, or null (empty, ambiguous, or refused by the provisioning rule).
 */
export async function resolveOrProvisionNames(
  orgId: string,
  rawNames: string[],
  opts: ResolveOrProvisionOptions = {},
): Promise<Map<string, Resolved | null>> {
  const out = new Map<string, Resolved | null>();
  const names = [...new Set(rawNames.map((n) => (n ?? "").trim()))];
  const usable = names.filter((n) => n.length >= 2);
  for (const n of names) if (n.length < 2) out.set(n, null);
  if (usable.length === 0) return out;
  const deliberate = opts.adminConfirmed === true;

  const [memberships, aliases] = await Promise.all([
    db.membership.findMany({ where: { orgId }, include: { user: { select: { id: true, name: true } } } }),
    db.userAlias.findMany({ where: { orgId }, select: { userId: true, alias: true } }),
  ]);
  const byUser = new Map(memberships.filter((m) => m.user?.name).map((m) => [m.user.id, m]));
  const roster: WhoRosterMember[] = [...byUser.values()].map((m) => ({
    userId: m.user.id,
    name: m.user.name as string,
    aliases: (aliases ?? []).filter((a) => a.userId === m.user.id).map((a) => a.alias),
    former: !!m.leftAt,
  }));

  const picker = opts.identify ?? personPickerFor();
  const res = await picker({
    roster,
    where: deliberate ? "HQ, the organisers' admin group" : "the club's WhatsApp group",
    messages: [{ id: "names", body: opts.context ?? usable.join("\n"), author: null, refs: usable }],
  });
  for (const d of res.degradations) console.warn(`[analyze] ${d}`);
  const picks: ReadonlyMap<string, PersonPick> = res.picks.get("names") ?? new Map();

  for (const name of usable) {
    const pick = picks.get(refKey(name));
    if (pick?.kind === "member") {
      const m = byUser.get(pick.userId);
      if (m) {
        if (m.leftAt) await restoreMembership(m.id, m.user.name);
        out.set(name, { userId: m.user.id, name: m.user.name });
        continue;
      }
    }
    // An admin's deliberate name that only REMOVED members could be is a
    // new player (a pasted list's preview promised exactly that). A
    // current member among the candidates is a real ambiguity: nothing is
    // guessed and no duplicate is made.
    const onlyFormer =
      pick?.kind === "ambiguous" && pick.userIds.length > 0 && pick.userIds.every((id) => !!byUser.get(id)?.leftAt);
    if (pick?.kind === "none" || (deliberate && onlyFormer)) {
      const provisioned = await createProvisionalByName(orgId, name, null, { deliberate });
      out.set(name, provisioned ? { userId: provisioned.userId!, name: provisioned.name } : null);
      continue;
    }
    console.warn(
      `[analyze] third-party name in org ${orgId} not placed (${pick ? pick.kind : "no answer"}): nothing registered, nobody provisioned.`,
    );
    out.set(name, null);
  }
  return out;
}

/** One name: `resolveOrProvisionNames` for a list of one. Null only when
 *  the name is empty, ambiguous, or not a person the rule provisions. */
export async function resolveOrProvisionByName(
  orgId: string,
  rawName: string,
  opts: ResolveOrProvisionOptions = {},
): Promise<Resolved | null> {
  const name = (rawName ?? "").trim();
  if (!name || name.length < 2) return null;
  return (await resolveOrProvisionNames(orgId, [name], opts)).get(name) ?? null;
}
