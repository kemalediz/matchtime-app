/**
 * ONE SQUAD CHANGE TYPED IN A CLUB'S ADMIN GROUP (2026-10-14).
 *
 * "Shehryar out", "put Bilal in", "Abdul-Hafeez dropping out", "Tom to the
 * bench", from an owner or admin of the club, in the club's linked admin
 * group. The caller (`admin-group.ts`) has already proven the sender is an
 * owner or admin, claimed the message id, and ruled out a pick reply, a
 * YES and a pasted list. This module is the ONLY part of the admin-group
 * path that can reach a model, and `admin-group-no-model.source.test.ts`
 * pins that.
 *
 * It applies the message through the SAME code a message in the players'
 * group goes through, and through nothing else:
 *
 *   router (`gateBatch`, unchanged prompt)
 *     -> only `self_att` and `other_att` go on; anything else is silence
 *   attendance engine (`runAttendanceEngineBatch`, unchanged extractor
 *     prompt, the real `registerAttendance` / `cancelAttendance`, the
 *     same name resolver, the same team-slot move)
 *
 * so names resolve, the waiting list fills, organiser pick behaves and
 * every follow-on flow (bench prompts, pick rounds, late-drop notices)
 * runs exactly as it does for the same words in the players' group. The
 * message is sent as TAGGED and from an admin: in the admin group every
 * message is addressed to MatchTime by where it is written.
 *
 * WHAT IS NOT DONE, on purpose: nothing the engine composed for the
 * players' group is posted there (its reply, its squad post, a new team
 * sheet). An admin-group change is the admins' business; the only words
 * are one line back in the admin group. The follow-on flows above still
 * post what they always post.
 *
 * Logs carry ids and counts only: never text, names or phone numbers.
 */
import { db } from "./db";
import { cancelAttendance, registerAttendance } from "./attendance";
import { runAttendanceEngineBatch } from "./attendance-engine-batch";
import { getAiBudgetStatus, withOrgAiBudget } from "./ai-budget";
import { gateBatch } from "./pipeline/gate";
import { resolveMentionNames } from "./pipeline/mention-names";
import { buildClaimGuestNameAsk } from "./owner-deps";
import { moveNamedSlot } from "./team-slot-fill";
import { recordTentative, resolveTentative } from "./tentative-store";
import { resolveOrProvisionByName } from "./resolve-or-provision-name";
import { adminGroupSourceRef } from "./admin-added";
import { floorAttendanceFacts } from "./pipeline/router";
import { resolvePerson } from "./pipeline/identity";
import type { SquadState } from "./pipeline/types";
import {
  ADMIN_GROUP_SQUAD_ROUTES,
  buildAdminSquadReply,
  vetAdminGroupFacts,
  type AdminClaimRef,
  type SquadChangeKind,
  type VettedClaim,
} from "./admin-group-squad-rules";

export interface AdminSquadChangeInput {
  orgId: string;
  lang: string | null | undefined;
  messageId: string;
  text: string;
  mentionNames?: Array<{ jid: string; name?: string; phone?: string }>;
  senderUserId: string;
  senderName: string | null;
  sentAt: Date | null;
  now: Date;
}

export type AdminSquadChangeResult =
  | { handled: false; why: "not-a-squad-change" | "no-match" }
  | {
      handled: true;
      /** "squad-question": nothing written, one line saying how to make the
       *  change (an unknown name, the sender's own plain IN/OUT in chat). */
      outcome: "squad-changed" | "squad-unchanged" | "squad-change-failed" | "squad-question";
      replyText: string;
    };

type Status = "CONFIRMED" | "BENCH" | "DROPPED";

/** Who a claim names, on the squad state the engine is about to decide
 *  against: the engine's own resolver (`pipeline/identity.ts`). */
function refOn(state: SquadState, personRef: string): AdminClaimRef {
  const r = resolvePerson(personRef, state.roster);
  if (r.kind === "resolved") return { kind: "member", userId: r.member.userId, name: r.member.name };
  if (r.kind === "unknown") return { kind: "unknown", name: r.name };
  if (r.kind === "ambiguous") return { kind: "ambiguous", name: personRef.trim().replace(/^@/, "") };
  return { kind: "none" };
}

/** "@447700900123 out": name the tag from the club's roster, as the
 *  players' group does. Only read when the text carries a raw tag. */
async function nameMentions(orgId: string, text: string, mentionNames: AdminSquadChangeInput["mentionNames"]): Promise<string> {
  if (!mentionNames?.length || !/@\d{5,}/.test(text)) return text;
  const [members, aliases] = await Promise.all([
    db.membership.findMany({ where: { orgId }, select: { user: { select: { id: true, name: true, phoneNumber: true } } } }),
    db.userAlias.findMany({ where: { orgId }, select: { alias: true, userId: true } }),
  ]);
  const roster = members
    .map((m) => m.user)
    .filter((u) => !!u?.name)
    .map((u) => ({ userId: u.id, name: u.name as string, phone: u.phoneNumber }));
  return resolveMentionNames({ body: text, mentions: mentionNames.map((m) => m.jid), mentionNames, roster, aliases }).body;
}

export async function handleAdminSquadChange(input: AdminSquadChangeInput): Promise<AdminSquadChangeResult> {
  const { orgId, messageId } = input;
  return withOrgAiBudget(orgId, async () => {
    const body = await nameMentions(orgId, input.text, input.mentionNames);
    // The club's daily AI cap, as in the players' group: at the cap the
    // router is not asked, and a bare IN/OUT is read by the floor.
    const capped = (await getAiBudgetStatus(orgId).catch(() => null))?.capped ?? false;

    const gate = await gateBatch([{ waMessageId: messageId, body, authorName: input.senderName }], { capped });
    const route = gate.routes.find((r) => r.messageId === messageId)?.route;
    if (!route || !ADMIN_GROUP_SQUAD_ROUTES.has(route) || gate.skipped.includes(messageId)) {
      console.log(`[admin-group] ${messageId}: routed ${route ?? "nowhere"}, not a squad change`);
      return { handled: false, why: "not-a-squad-change" };
    }

    // What actually moved, read off the real writers as they run: the
    // status before and after, so a write that changed nothing says
    // nothing.
    const moved: Array<{ userId: string; to: Status }> = [];
    const statusOf = async (matchId: string, userId: string): Promise<Status | null> =>
      ((await db.attendance.findUnique({ where: { matchId_userId: { matchId, userId } }, select: { status: true } }))
        ?.status as Status | undefined) ?? null;

    // HQ IS WHERE THE ORGANISERS TALK (2026-10-15). Only an explicit
    // instruction reaches `decide()`; every claim the extractor read is
    // kept here with why it was held, who it is about and where they stood,
    // for the one line back. See `admin-group-squad-rules.ts`.
    let vetted: VettedClaim[] = [];
    let kickoffLabel = "";
    const vetFacts: NonNullable<Parameters<typeof runAttendanceEngineBatch>[0]["deps"]["vetFacts"]> = ({ message, facts, state }) => {
      if (message.waMessageId !== messageId) return facts;
      kickoffLabel = state.kickoffLabel;
      const out = vetAdminGroupFacts({
        body: message.body,
        facts,
        senderUserId: input.senderUserId,
        senderName: input.senderName,
        bareDeclaration: floorAttendanceFacts(message.body) !== null,
        resolve: (ref) => refOn(state, ref),
        statusOf: (userId) => state.rows.find((r) => r.userId === userId)?.status ?? null,
      });
      vetted = out.vetted;
      const held = vetted.filter((v) => v.hold !== null);
      if (held.length > 0) {
        console.log(`[admin-group] ${messageId}: ${held.length} of ${vetted.length} claim(s) held (${held.map((v) => v.hold).join(", ")})`);
      }
      return out.facts;
    };

    const batch = await runAttendanceEngineBatch({
      orgId,
      now: input.now,
      expectedMatchId: null,
      enabled: true,
      history: [],
      messages: [
        {
          waMessageId: messageId,
          body,
          authorName: input.senderName,
          senderUserId: input.senderUserId,
          senderName: input.senderName,
          senderIsAdmin: true,
          ...(input.sentAt ? { sentAt: input.sentAt } : {}),
          tagged: true,
          route,
          gated: false,
        },
      ],
      deps: {
        aiCapped: capped,
        vetFacts,
        // Every write is stamped as the admin group's (sourceRef
        // "admin-group:<id>"): the rolling squad carries a phoneless
        // player an admin added HERE, and not a guest an admin named in
        // the players' group (admin-added.ts).
        registerAttendance: async (userId, matchId, options) => {
          const before = await statusOf(matchId, userId);
          const res = await registerAttendance(
            userId,
            matchId,
            options?.event ? { ...options, event: { ...options.event, sourceRef: adminGroupSourceRef(options.event.sourceRef) } } : options,
          );
          if (res.status !== before) moved.push({ userId, to: res.status as Status });
          return res;
        },
        cancelAttendance: async (userId, matchId, event, options) => {
          const before = await statusOf(matchId, userId);
          const res = await cancelAttendance(userId, matchId, { ...event, sourceRef: adminGroupSourceRef(event.sourceRef) }, options);
          if (before !== "DROPPED") moved.push({ userId, to: "DROPPED" });
          return res;
        },
        // An admin typed this name in HQ on purpose ("put Mo in"): a
        // short real name is added, as in a pasted list.
        resolveOrProvision: (name) => resolveOrProvisionByName(orgId, name, { adminConfirmed: true }),
        moveTeamSlot: async (matchId, fromUserId, toUserId) => {
          const res = await db.$transaction((tx) => moveNamedSlot(tx, matchId, fromUserId, toUserId));
          if (res.kind === "refused") throw new Error(`slot move refused (${res.reason})`);
        },
        openBenchPromptUserIds: async (matchId) =>
          (
            await db.pendingBenchConfirmation.findMany({ where: { matchId, resolvedAt: null }, select: { userId: true } })
          ).map((p) => p.userId),
        claimGuestNameAsk: buildClaimGuestNameAsk(),
      },
    });

    const outcome = batch.outcomes.get(messageId);
    const matchId = batch.matchId;
    if (!outcome || !matchId) {
      console.log(`[admin-group] ${messageId}: the attendance engine owned nothing (${batch.degradations.length} degradation(s))`);
      return { handled: false, why: "no-match" };
    }

    const match = await db.match.findUnique({ where: { id: matchId }, select: { date: true, maxPlayers: true } });
    const maybeIds = outcome.recordTentativeForUserIds.filter((id) => !moved.some((m) => m.userId === id));
    if (match) {
      for (const userId of maybeIds) {
        await recordTentative({ matchId, userId, kickoff: match.date }).catch((err) =>
          console.error(`[admin-group] ${messageId}: recordTentative failed:`, err instanceof Error ? err.message : "unknown"),
        );
      }
    }
    for (const m of moved) {
      await resolveTentative({ matchId, userId: m.userId }).catch(() => {});
    }

    if (moved.length === 0 && maybeIds.length === 0 && outcome.failures.length === 0 && outcome.claimCount === 0 && vetted.length === 0) {
      console.log(`[admin-group] ${messageId}: routed ${route}, no claim read`);
      return { handled: false, why: "not-a-squad-change" };
    }

    const ids = [...new Set([...moved.map((m) => m.userId), ...maybeIds])];
    const users = ids.length
      ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name ?? "?"]));
    const kindOf = (to: Status): SquadChangeKind => (to === "CONFIRMED" ? "in" : to === "BENCH" ? "bench" : "out");
    // The last move per player is what stands.
    const last = new Map<string, Status>();
    for (const m of moved) last.set(m.userId, m.to);
    const changes = [
      ...[...last.entries()].map(([userId, to]) => ({ kind: kindOf(to), name: nameOf.get(userId) ?? "?" })),
      ...maybeIds.map((userId) => ({ kind: "maybe" as const, name: nameOf.get(userId) ?? "?" })),
    ];
    const failed = [...new Set(outcome.failures.map((f) => f.who ?? input.senderName ?? "?"))];
    const confirmed = await db.attendance.count({ where: { matchId, status: "CONFIRMED" } });
    const reply = buildAdminSquadReply({
      lang: input.lang,
      changes,
      movedUserIds: [...last.keys()],
      failed,
      confirmed,
      maxPlayers: match?.maxPlayers ?? confirmed,
      vetted,
      kickoffLabel,
      senderName: input.senderName,
    });
    if (reply === null) {
      console.log(`[admin-group] ${messageId}: routed ${route}, nothing to apply or say (${vetted.length} claim(s) read)`);
      return { handled: false, why: "not-a-squad-change" };
    }
    console.log(
      `[admin-group] ${messageId}: ${route} on match ${matchId}: ${changes.length} change(s), ${failed.length} failure(s), ${confirmed} confirmed, ${reply.outcome}`,
    );
    return { handled: true, outcome: reply.outcome, replyText: reply.text };
  });
}
