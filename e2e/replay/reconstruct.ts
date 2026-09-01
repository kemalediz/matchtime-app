/**
 * Rebuilding the world each production message landed in.
 *
 * PURE. No DB, no model, no Playwright, no filesystem. Every rule here
 * is unit-tested by `reconstruct.test.ts` under `npm run test:unit`.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE CONTRACT
 * ─────────────────────────────────────────────────────────────────────
 * A verdict is meaningless without the squad state, the match, the
 * capacity and the sender's role at that moment. So every field of the
 * replayed world falls into exactly one of three buckets, and the
 * bucket is stated, never implied:
 *
 * 1. PROVEN AT THE INSTANT — recoverable from row timestamps:
 *      · which Attendance rows existed and what status they held
 *      · which Match was next, its kickoff, capacity and deadline
 *      · who was a member (Membership.createdAt / leftAt)
 *      · who sent each message, and whether WhatsApp gave a phone
 *      · the message bodies and the batch they were analysed in
 *      · the chat history the Pi forwarded with the batch
 *
 * 2. ASSUMED STABLE — no audit trail exists, so the value TODAY is used
 *    and the assumption is recorded on every case:
 *      · org feature flags        (`Organisation.feature*`)
 *      · membership ROLE          (`Membership` has no updatedAt column)
 *      · user display names       (`User.name`)
 *      · activity kickoff time and deadline hours
 *    If any of these changed during the window, affected replays are
 *    wrong in a way this harness cannot detect. That is stated in the
 *    report rather than hidden.
 *
 * Anything that falls outside 1–2 is EXCLUDED with a reason. A
 * fabricated world produces a fabricated diff, and a fabricated diff is
 * worse than none because it reads exactly like a real one.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE ONE DELIBERATE IMPOVERISHMENT (tier "wide")
 * ─────────────────────────────────────────────────────────────────────
 * The previous COMPLETED match — what score and stats questions read —
 * is included only when its Match row AND all its attendance rows were
 * already settled at the batch instant. In practice they rarely are:
 * `status` flips to COMPLETED after the whistle, the score is recorded
 * that night, and per-player payment metadata (`paidAt`,
 * `stripeSessionId` — live on Sutton FC since 2026-06-09) keeps bumping
 * `updatedAt` for days. When it is not settled the completed match is
 * LEFT OUT and the case is marked tier "wide" carrying that caveat.
 *
 * Leaving it out is not the same class of error as making it up. Both
 * pipelines see the identical thinner world, so the DIFF still holds;
 * what weakens is the claim that this is exactly what production saw. A
 * disagreement on a case carrying this caveat has to be read with it in
 * view, which is why every triage card prints it.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE CLOCK IS RELATIVE, AND THAT IS A CHOICE
 * ─────────────────────────────────────────────────────────────────────
 * A replay runs NOW, so the world is rebuilt with the same DISTANCE to
 * kickoff the message really had (`upcomingMatchInHours`), not the same
 * calendar date. Everything that gates a decision — deadline passed or
 * not, how close the chase is, whether bench offers are live — is a
 * function of that distance, so the distance is what is preserved.
 *
 * The cost is that the replayed kickoff lands on an arbitrary weekday
 * and time ("Tue 15 Sept 03:02" in one observed run). Copy that names
 * the day is therefore not faithful, and a prompt that reasons about
 * "Tuesday" specifically may behave differently than it did. Both
 * pipelines see the same synthetic clock, so the DIFF still holds; a
 * disagreement that turns on the day of the week does not.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THE BATCH IS THE UNIT
 * ─────────────────────────────────────────────────────────────────────
 * The Pi buffers messages and flushes a WINDOW to /api/whatsapp/analyze
 * (`smart-analysis.ts`), and the route reasons over the whole window at
 * once. Replaying message-by-message would compare a world production
 * never analysed. `AnalyzedMessage` does not carry a batch id, so the
 * batch is recovered from write timing — see BATCH_JOIN_MS.
 */
import { createHash } from "node:crypto";
import type { CorpusCase, CorpusHistoryLine, CorpusMessage, CorpusPlayer } from "../corpus/grade";
import type {
  Exclusion,
  ExclusionReason,
  RawAttendance,
  RawMessage,
  ReplayCase,
  ReplaySource,
  ReplayTier,
  Reconstruction,
  ReconstructionStats,
} from "./types";

/**
 * Rows written this close together came from ONE analyze request. The
 * route persists an AnalyzedMessage per message as it walks the batch,
 * so intra-batch gaps are sub-second: 693 of the 1,022 consecutive gaps
 * in production are under 500 ms.
 */
export const BATCH_JOIN_MS = 2_000;

/**
 * Above this, two rows are certainly different flushes. Between
 * BATCH_JOIN_MS and here (32 gaps in production) a slow single flush and
 * two quick ones are indistinguishable, so BOTH neighbouring batches are
 * excluded rather than guessed.
 */
export const BATCH_AMBIGUOUS_MS = 10_000;

/** The Pi keeps the last 15 inbound messages per group
 *  (`smart-analysis.ts:42 HISTORY_PER_GROUP`). */
export const HISTORY_PER_GROUP = 15;

/**
 * A membership row created within this window of the batch was created
 * BY the batch (the analyzer auto-enrols an unknown sender), so that
 * sender was an outsider at the instant the message landed.
 */
const AUTO_ENROL_SLACK_MS = 120_000;

export const ASSUMPTIONS = {
  stableConfig:
    "org feature flags, membership roles, display names and activity kickoff/deadline are " +
    "assumed unchanged since the batch — none of them has an audit trail",
} as const;

export const CAVEATS = {
  completedMatchOmitted:
    "a previous completed match existed but its state at this instant is unrecoverable " +
    "(score and payment metadata are written after the whistle), so the world was built " +
    "with no match history",
} as const;

// ── Redaction ──────────────────────────────────────────────────────────

/**
 * Never let a routable identifier into an artefact. Names and message
 * bodies stay (the incident corpus already precedents that, and the
 * replay extract is gitignored) — phone numbers and WhatsApp JIDs do
 * not, in bodies or anywhere else.
 */
export function redact(text: string): string {
  return text
    .replace(/\b\d{5,}[-@](?:g\.us|lid|c\.us|s\.whatsapp\.net)\b/gi, "[jid]")
    .replace(/\b[\w.-]*@(?:g\.us|lid|c\.us|s\.whatsapp\.net)\b/gi, "[jid]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]");
}

export function groupRefOf(groupId: string): string {
  return `g-${createHash("sha256").update(groupId).digest("hex").slice(0, 10)}`;
}

/**
 * A WhatsApp message id is a routable identifier, not an opaque key:
 * they look like `false_447525334985-1607872139@g.us_ACD6…` and carry
 * BOTH a phone number and the group JID. Every one that leaves the
 * database is replaced by a one-way hash — stable, so two extracts line
 * up, and useless to anyone who gets hold of the file.
 *
 * Applied in the extractor AND here, so a hand-built source can never
 * smuggle one through either.
 */
export function messageRef(waMessageId: string): string {
  if (/^m-[0-9a-f]{12}$/.test(waMessageId)) return waMessageId;
  return `m-${createHash("sha256").update(waMessageId).digest("hex").slice(0, 12)}`;
}

/** A pushname that IS a phone number must not be replayed verbatim. */
function safeName(name: string): string {
  if (!/\d{7,}/.test(name.replace(/[\s()+-]/g, ""))) return name;
  return `Member ${createHash("sha256").update(name).digest("hex").slice(0, 4)}`;
}

// ── Batching ───────────────────────────────────────────────────────────

interface Batch {
  key: string;
  orgId: string;
  groupId: string;
  messages: RawMessage[];
  /** Set when a neighbouring gap fell in the ambiguous band. */
  boundaryAmbiguous: boolean;
}

export function batchMessages(messages: RawMessage[]): Batch[] {
  const byGroup = new Map<string, RawMessage[]>();
  for (const m of messages) {
    if (!byGroup.has(m.groupId)) byGroup.set(m.groupId, []);
    byGroup.get(m.groupId)!.push(m);
  }

  const out: Batch[] = [];
  for (const [groupId, rows] of byGroup) {
    const sorted = [...rows].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
    let current: Batch | null = null;
    let prev: RawMessage | null = null;

    for (const m of sorted) {
      const gap = prev ? ms(m.createdAt) - ms(prev.createdAt) : Infinity;
      if (current && gap <= BATCH_JOIN_MS) {
        current.messages.push(m);
      } else {
        const ambiguous = gap > BATCH_JOIN_MS && gap < BATCH_AMBIGUOUS_MS;
        if (ambiguous && current) current.boundaryAmbiguous = true;
        current = {
          key: `${groupRefOf(groupId)}:${m.createdAt}`,
          orgId: m.orgId,
          groupId,
          messages: [m],
          boundaryAmbiguous: ambiguous,
        };
        out.push(current);
      }
      prev = m;
    }
  }
  return out.sort((a, b) => ms(a.messages[0].createdAt) - ms(b.messages[0].createdAt));
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

// ── Reconstruction ─────────────────────────────────────────────────────

export function reconstruct(src: ReplaySource): Reconstruction {
  const batches = batchMessages(src.messages);
  const cases: ReplayCase[] = [];
  const excluded: Exclusion[] = [];

  const usersById = new Map(src.users.map((u) => [u.id, u]));
  const orgsById = new Map(src.orgs.map((o) => [o.id, o]));
  const attendanceByMatch = new Map<string, RawAttendance[]>();
  for (const a of src.attendance) {
    if (!attendanceByMatch.has(a.matchId)) attendanceByMatch.set(a.matchId, []);
    attendanceByMatch.get(a.matchId)!.push(a);
  }
  // Chat history is drawn from EVERY message the Pi saw, including the
  // ones this harness cannot replay — the buffer did not skip them.
  const historyByGroup = new Map<string, RawMessage[]>();
  for (const m of src.messages) {
    if (!historyByGroup.has(m.groupId)) historyByGroup.set(m.groupId, []);
    historyByGroup.get(m.groupId)!.push(m);
  }
  for (const rows of historyByGroup.values()) rows.sort((a, b) => ms(a.createdAt) - ms(b.createdAt));

  for (const batch of batches) {
    const at = batch.messages[0].createdAt;
    const t = ms(at);
    const drop = (reason: ExclusionReason, detail: string) =>
      excluded.push({
        batchKey: batch.key,
        orgId: batch.orgId,
        at,
        waMessageIds: batch.messages.map((m) => messageRef(m.waMessageId)),
        reason,
        detail,
      });

    if (batch.boundaryAmbiguous) {
      drop(
        "batch-boundary-ambiguous",
        `a neighbouring write gap fell between ${BATCH_JOIN_MS}ms and ${BATCH_AMBIGUOUS_MS}ms, ` +
          `so this batch's composition cannot be told from a slow single flush`,
      );
      continue;
    }

    const bodyless = batch.messages.filter((m) => !m.body || !m.body.trim());
    if (bodyless.length) {
      drop("no-body", `${bodyless.length} message(s) have no body (media, sticker or deleted)`);
      continue;
    }

    // ── the match ─────────────────────────────────────────────────────
    const upcoming = src.matches
      .filter((m) => m.orgId === batch.orgId && ms(m.date) > t && m.status !== "CANCELLED")
      .sort((a, b) => ms(a.date) - ms(b.date))[0];
    if (!upcoming) {
      drop(
        "no-upcoming-match",
        "no Match row was scheduled after this instant, and a deleted match leaves no trace — " +
          "'there was no match' cannot be distinguished from 'the row was removed later'",
      );
      continue;
    }

    // ── the squad, as it stood ────────────────────────────────────────
    const rows = attendanceByMatch.get(upcoming.id) ?? [];
    const existed = rows.filter((r) => ms(r.createdAt) <= t);
    const unknown = existed.filter((r) => ms(r.updatedAt) > t);
    if (unknown.length) {
      drop(
        "attendance-state-unknown",
        `${unknown.length} attendance row(s) predate the batch and changed after it, so their ` +
          `status at that instant is unrecoverable (no attendance audit log): ` +
          unknown.map((r) => r.userId).join(", "),
      );
      continue;
    }

    // ── the roster ────────────────────────────────────────────────────
    const memberAt = src.memberships.filter(
      (m) => m.orgId === batch.orgId && ms(m.createdAt) <= t && (!m.leftAt || ms(m.leftAt) > t),
    );
    if (!memberAt.length) {
      drop("no-roster", "no membership rows predate this batch, so the roster is unknown");
      continue;
    }
    const rosterIds = new Set(memberAt.map((m) => m.userId));

    // ── the senders ───────────────────────────────────────────────────
    const batchEnd = ms(batch.messages[batch.messages.length - 1].createdAt);
    let senderProblem: string | null = null;
    const unresolvedSenders: string[] = [];
    const senders = batch.messages.map((m) => {
      const raw = m.authorName?.trim();
      const name = raw ? safeName(raw) : null;
      if (m.authorUserId) {
        const membership = src.memberships.find(
          (x) => x.orgId === m.orgId && x.userId === m.authorUserId,
        );
        const user = usersById.get(m.authorUserId);
        if (!membership || !user) {
          senderProblem ??= `sender ${m.authorUserId} has no membership or user row today`;
          return null;
        }
        const display = safeName(user.name ?? "") || name;
        if (rosterIds.has(m.authorUserId)) return { name: display };
        // Not a member at the instant. Either the batch itself enrolled
        // them — faithful, replay as the outsider they were, which is
        // exactly the path that provisions a ghost member — or the row
        // appeared far later, which contradicts production having
        // resolved them at all.
        if (ms(membership.createdAt) <= batchEnd + AUTO_ENROL_SLACK_MS) {
          if (display) unresolvedSenders.push(display);
          return { name: display };
        }
        senderProblem ??=
          `sender ${m.authorUserId} was resolved in production but their membership row ` +
          `was created ${membership.createdAt}, long after the batch`;
        return null;
      }
      if (!name) {
        senderProblem ??= "a message has neither a resolved user nor a pushname";
        return null;
      }
      unresolvedSenders.push(name);
      return { name };
    });
    if (senderProblem) {
      drop("sender-unknown", senderProblem);
      continue;
    }

    // ── the previous completed match ──────────────────────────────────
    const caveats: string[] = [];
    const previous = src.matches
      .filter((m) => m.orgId === batch.orgId && ms(m.date) < t && m.status !== "CANCELLED")
      .sort((a, b) => ms(b.date) - ms(a.date))[0];
    let completedMatch: NonNullable<CorpusCase["world"]["completedMatch"]> | undefined;
    if (previous) {
      const prevRows = attendanceByMatch.get(previous.id) ?? [];
      const settled =
        ms(previous.updatedAt) <= t &&
        prevRows.every((r) => ms(r.createdAt) > t || ms(r.updatedAt) <= t);
      if (settled) {
        completedMatch = {
          hoursAgo: (t - ms(previous.date)) / 3_600_000,
          confirmedKeys: prevRows
            .filter((r) => ms(r.createdAt) <= t && r.status === "CONFIRMED" && rosterIds.has(r.userId))
            .sort((a, b) => a.position - b.position)
            .map((r) => r.userId),
          redScore: previous.redScore,
          yellowScore: previous.yellowScore,
        };
      } else {
        caveats.push(CAVEATS.completedMatchOmitted);
      }
    }

    // ── assemble ──────────────────────────────────────────────────────
    const tier: ReplayTier = caveats.length ? "wide" : "strict";
    const assumptions = [ASSUMPTIONS.stableConfig];

    const players: CorpusPlayer[] = memberAt
      .map((m) => {
        const u = usersById.get(m.userId);
        return {
          key: m.userId,
          name: safeName((u?.name ?? "").trim()) || `Member ${m.userId.slice(-4)}`,
          role: m.role,
          hasPhone: u?.hasPhone ?? false,
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key));

    const attendance = existed
      .slice()
      .sort((a, b) => a.position - b.position || a.userId.localeCompare(b.userId))
      .filter((r) => rosterIds.has(r.userId))
      .map((r) => ({ key: r.userId, status: r.status }));

    const messages: CorpusMessage[] = batch.messages.map((m, i) => ({
      from: { name: senders[i]!.name, phone: "" },
      body: redact(m.body!.trim()),
    }));

    const history: CorpusHistoryLine[] = (historyByGroup.get(batch.groupId) ?? [])
      .filter((m) => ms(m.createdAt) <= batchEnd && m.body && m.body.trim())
      .slice(-HISTORY_PER_GROUP)
      .map((m) => ({
        author: m.authorName?.trim() ? safeName(m.authorName.trim()) : null,
        body: redact(m.body!.trim()),
      }));

    const org = orgsById.get(batch.orgId);
    const hoursToKickoff = (ms(upcoming.date) - t) / 3_600_000;
    const deadlineHours = (ms(upcoming.date) - ms(upcoming.attendanceDeadline)) / 3_600_000;

    const corpusCase: CorpusCase = {
      id: batch.key,
      title: `${batch.messages.length} message(s) from ${at}`,
      // Inert here: sections and category drive the incident corpus's
      // coverage scoreboard, which a replay sweep never builds. Every
      // replay case is a real message the model must interpret, so "A".
      sections: [],
      category: "A",
      provenance: {
        kind: "production",
        date: at,
        note:
          `replayed from AnalyzedMessage; world reconstructed at ${at}; ` +
          `tier=${tier}`,
      },
      world: {
        maxPlayers: upcoming.maxPlayers,
        players,
        attendance,
        ...(org ? { features: org.features } : {}),
        upcomingMatchInHours: hoursToKickoff,
        deadlineHoursBeforeKickoff: deadlineHours,
        ...(completedMatch ? { completedMatch } : {}),
      },
      history,
      messages,
      expect: {},
    };

    const tally = (s: RawAttendance["status"]) => attendance.filter((a) => a.status === s).length;

    cases.push({
      key: batch.key,
      meta: {
        batchKey: batch.key,
        orgId: batch.orgId,
        groupRef: groupRefOf(batch.groupId),
        at,
        tier,
        assumptions,
        caveats,
        hoursToKickoff,
        maxPlayers: upcoming.maxPlayers,
        squadBefore: {
          confirmed: tally("CONFIRMED"),
          bench: tally("BENCH"),
          dropped: tally("DROPPED"),
        },
        prodOutcomes: batch.messages.map((m) => ({
          waMessageId: messageRef(m.waMessageId),
          intent: m.intent,
          action: m.action,
          handledBy: m.handledBy,
        })),
        unresolvedSenders,
      },
      case: corpusCase,
    });
  }

  return { cases, excluded, stats: buildStats(src, batches, cases, excluded) };
}

function buildStats(
  src: ReplaySource,
  batches: Batch[],
  cases: ReplayCase[],
  excluded: Exclusion[],
): ReconstructionStats {
  const byReason = {} as ReconstructionStats["byReason"];
  for (const e of excluded) {
    byReason[e.reason] ??= { batches: 0, messages: 0 };
    byReason[e.reason].batches += 1;
    byReason[e.reason].messages += e.waMessageIds.length;
  }

  const replayableIds = new Set<string>();
  const byKey = new Map(batches.map((b) => [b.key, b]));
  for (const c of cases) for (const m of byKey.get(c.key)?.messages ?? []) replayableIds.add(m.waMessageId);

  const tally = (rows: RawMessage[]) => {
    const out: Record<string, number> = {};
    for (const m of rows) {
      const k = m.intent ?? "(null)";
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };

  const byTier = { strict: 0, wide: 0 } as Record<ReplayTier, number>;
  for (const c of cases) byTier[c.meta.tier] += 1;

  return {
    messagesInSource: src.messages.length,
    messagesReplayable: replayableIds.size,
    messagesExcluded: src.messages.length - replayableIds.size,
    batchesInSource: batches.length,
    batchesReplayable: cases.length,
    batchesExcluded: excluded.length,
    byTier,
    byReason,
    intentDistribution: tally(src.messages.filter((m) => replayableIds.has(m.waMessageId))),
    intentDistributionAll: tally(src.messages),
  };
}
