/**
 * ONE-OFF CORRECTION: move a self-join request linked on weak evidence to
 * the organiser's own group (2026-10-15, the FNF incident).
 *
 * The CLI is `scripts/relink-self-join.ts`. It moves the request with the
 * SAME function the live add path uses (`relinkToOrganiserGroup`, group-add.ts),
 * after the SAME rule (`decideWeakLinkUpgrade`, group-add-rules.ts), and
 * queues the owner's DM the same way (`queueOwnerDmForLink`). No hand-written
 * SQL. Dry run unless asked to apply.
 *
 * It refuses unless, besides the rule:
 *   - MatchTime is KNOWN to be in the target group since the request was
 *     issued: the Pi reported a postability reading for it
 *     (`GroupPostState.observedAt`, written for every group it reads), or
 *     an add of it was recorded as unsolicited (`UnsolicitedGroup.addedAt`);
 *   - no club owns the target group, and no other request is linked to it.
 *
 * The plan is pure (`planRelinkSelfJoin`), so it is unit-tested; the reads
 * and the write are `runRelinkSelfJoin`.
 */
import { db } from "./db";
import { decideWeakLinkUpgrade, phoneDigitsOf, type AddEvidence, type UpgradeDecision } from "./group-add-rules";
import { lidDigits } from "./connect-dm-rules";
import { queueOwnerDmForLink, relinkToOrganiserGroup, type GroupAddOutcome } from "./group-add";

export interface RelinkArgs {
  connectId: string;
  groupId: string;
  subject: string | null;
  memberCount: number;
  /** The organiser's phone as the add named them (digits). */
  adderPhone: string | null;
  /** The organiser's LID as the add named them (digits). */
  adderLid: string | null;
  /** Let a weak link older than the upgrade window be moved. */
  allowLate: boolean;
}

export interface RelinkFacts {
  now: Date;
  request: {
    id: string;
    code: string;
    status: string;
    groupId: string | null;
    groupSubject: string | null;
    memberCount: number | null;
    adderMatch: string | null;
    botRemovedAt: Date | null;
    phone: string;
    dmLid: string | null;
    issuedAt: Date;
    linkedAt: Date | null;
    org: { name: string; approvalStatus: string };
  } | null;
  /** When the Pi last reported a reading for the target group, if ever. */
  postStateObservedAt: Date | null;
  /** When an add of the target group was recorded as unsolicited, newest first. */
  unsolicitedAddedAt: Date | null;
  /** A club that owns the target group (any status), if any. */
  owningClub: string | null;
  /** Another request linked to the target group and waiting, if any. */
  otherLinkedRequest: string | null;
}

export type RelinkPlan =
  | {
      ok: true;
      from: { groupId: string; subject: string | null; memberCount: number | null; adderMatch: string | null };
      to: { groupId: string; subject: string | null; memberCount: number; adderMatch: "phone" | "lid" };
      club: string;
      code: string;
      evidence: string;
      ev: AddEvidence;
    }
  | { ok: false; refusal: string };

export function planRelinkSelfJoin(args: RelinkArgs, f: RelinkFacts): RelinkPlan {
  const r = f.request;
  if (!r) return { ok: false, refusal: `no connect request ${args.connectId}` };
  if (!r.groupId || r.status !== "group_linked") {
    return { ok: false, refusal: `request ${r.id} is ${r.status}, not linked to a group` };
  }
  if (r.groupId === args.groupId) return { ok: false, refusal: `request ${r.id} is already linked to ${args.groupId}` };
  if (r.org.approvalStatus !== "pending") {
    return { ok: false, refusal: `club "${r.org.name}" is ${r.org.approvalStatus}, not pending: only a waiting club is moved` };
  }
  if (f.owningClub) return { ok: false, refusal: `${args.groupId} already belongs to club "${f.owningClub}"` };
  if (f.otherLinkedRequest) return { ok: false, refusal: `${args.groupId} is already linked to request ${f.otherLinkedRequest}` };

  const since = r.issuedAt.getTime();
  const evidence =
    f.postStateObservedAt && f.postStateObservedAt.getTime() >= since
      ? `the Pi reported a postability reading for it at ${f.postStateObservedAt.toISOString()}`
      : f.unsolicitedAddedAt && f.unsolicitedAddedAt.getTime() >= since
        ? `an add of it was recorded (unsolicited) at ${f.unsolicitedAddedAt.toISOString()}`
        : null;
  if (!evidence) {
    return {
      ok: false,
      refusal:
        `nothing shows MatchTime is in ${args.groupId} since the request was issued ` +
        `(${r.issuedAt.toISOString()}): no postability reading and no recorded add`,
    };
  }

  const ev: AddEvidence = {
    addedByPhone: phoneDigitsOf(args.adderPhone ?? undefined),
    addedByLid: lidDigits(args.adderLid),
    participants: [],
    discovered: false,
  };
  // The live rule, with the request as it stands. `--allow-late` evaluates
  // it as of the weak link, so only the window is waived.
  const asOf = args.allowLate && r.linkedAt ? r.linkedAt : f.now;
  const decision: UpgradeDecision = decideWeakLinkUpgrade(
    ev,
    args.groupId,
    [
      {
        id: r.id,
        groupId: r.groupId,
        status: r.status,
        botRemovedAt: r.botRemovedAt,
        adderMatch: r.adderMatch,
        phone: r.phone,
        dmLid: r.dmLid,
        orgApprovalStatus: r.org.approvalStatus,
        linkedAt: r.linkedAt,
      },
    ],
    asOf,
  );
  if (!decision.upgrade) {
    const why: Record<typeof decision.reason, string> = {
      "no-weak-link": `request ${r.id} was linked by the organiser (${r.adderMatch ?? "?"}), or MatchTime was removed: never moved`,
      "club-not-pending": `club "${r.org.name}" is not pending`,
      "outside-window": "the weak link is older than the upgrade window (pass --allow-late to move it anyway)",
      "adder-not-organiser": "the adder given is not this request's organiser (by phone or connect-DM LID)",
    };
    return { ok: false, refusal: why[decision.reason] };
  }
  return {
    ok: true,
    from: { groupId: r.groupId, subject: r.groupSubject, memberCount: r.memberCount, adderMatch: r.adderMatch },
    to: { groupId: args.groupId, subject: args.subject, memberCount: args.memberCount, adderMatch: decision.adderMatch },
    club: r.org.name,
    code: r.code,
    evidence,
    ev,
  };
}

/** Read the facts the plan needs. Reads only. */
export async function loadRelinkFacts(args: RelinkArgs, now: Date = new Date()): Promise<RelinkFacts> {
  const [request, postState, unsolicited, owner, other] = await Promise.all([
    db.clubConnect.findUnique({
      where: { id: args.connectId },
      select: {
        id: true,
        code: true,
        status: true,
        groupId: true,
        groupSubject: true,
        memberCount: true,
        adderMatch: true,
        botRemovedAt: true,
        phone: true,
        dmLid: true,
        issuedAt: true,
        linkedAt: true,
        org: { select: { name: true, approvalStatus: true } },
      },
    }),
    db.groupPostState.findUnique({ where: { groupId: args.groupId }, select: { observedAt: true } }),
    db.unsolicitedGroup.findFirst({
      where: { groupId: args.groupId },
      orderBy: { addedAt: "desc" },
      select: { addedAt: true },
    }),
    db.organisation.findFirst({
      where: { OR: [{ whatsappGroupId: args.groupId }, { adminGroupId: args.groupId }] },
      select: { name: true },
    }),
    db.clubConnect.findFirst({
      where: { groupId: args.groupId, status: "group_linked", botRemovedAt: null, id: { not: args.connectId } },
      select: { id: true },
    }),
  ]);
  return {
    now,
    request,
    postStateObservedAt: postState?.observedAt ?? null,
    unsolicitedAddedAt: unsolicited?.addedAt ?? null,
    owningClub: owner?.name ?? null,
    otherLinkedRequest: other?.id ?? null,
  };
}

/** Describe a plan for the operator, one fact per line. No message text, no codes beyond the club ref. */
export function describeRelinkPlan(plan: RelinkPlan, apply: boolean): string[] {
  if (!plan.ok) return [`REFUSED: ${plan.refusal}`, "Nothing was written."];
  const label = (s: string | null, n: number | null) => `"${s ?? "(no name)"}", ${n ?? "?"} member(s)`;
  return [
    `${apply ? "APPLYING" : "DRY RUN (pass --apply to write)"}: club "${plan.club}" (ref ${plan.code})`,
    `  from: ${plan.from.groupId} ${label(plan.from.subject, plan.from.memberCount)}, adderMatch=${plan.from.adderMatch ?? "?"}`,
    `  to:   ${plan.to.groupId} ${label(plan.to.subject, plan.to.memberCount)}, adderMatch=${plan.to.adderMatch}`,
    `  MatchTime is in the target group: ${plan.evidence}`,
    "  will write: ClubConnect groupId, groupSubject, memberCount, addedByPhone/Lid, adderMatch, detectedLang, linkedAt;",
    "              participants set to NULL (no roster for the target group is known: approval imports none);",
    "              the captured chat and description of the old group deleted;",
    "              any open unsolicited row for the target group closed.",
    "  will queue: the organiser's \"I'm in\" ack (once ever), and the owner's DM: the approval DM if he was never asked,",
    "              otherwise one correction naming the group now linked and the one it replaces.",
    "  the old group is not left, not recorded, nobody is told about it.",
  ];
}

export async function runRelinkSelfJoin(
  args: RelinkArgs,
  opts: { apply: boolean; now?: Date; print?: (line: string) => void },
): Promise<{ plan: RelinkPlan; outcome?: GroupAddOutcome; ownerDm?: string }> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const now = opts.now ?? new Date();
  const plan = planRelinkSelfJoin(args, await loadRelinkFacts(args, now));
  for (const l of describeRelinkPlan(plan, opts.apply)) print(l);
  if (!plan.ok || !opts.apply) return { plan };
  const outcome = await relinkToOrganiserGroup({
    connectId: args.connectId,
    fromGroupId: plan.from.groupId,
    toGroupId: plan.to.groupId,
    subject: plan.to.subject,
    snapshot: [],
    memberCount: plan.to.memberCount,
    ev: plan.ev,
    adderMatch: plan.to.adderMatch,
    history: [],
    description: null,
    now,
  });
  print(`  result: ${outcome.kind}`);
  if (outcome.kind !== "linked") return { plan, outcome };
  const ownerDm = await queueOwnerDmForLink(plan.to.groupId, outcome);
  print(`  owner DM: ${ownerDm}; organiser ack ${outcome.organiserAckQueued ? "queued" : "not queued (already sent or refused)"}`);
  return { plan, outcome, ownerDm };
}
