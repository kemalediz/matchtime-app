/**
 * Smart-analysis entry point. Called by the bot once per flush cycle
 * (every ~10 min, or immediately on urgency). Accepts a batch of group
 * messages that the regex fast-path didn't handle, runs Claude Haiku
 * ONCE on the batch, executes verdicts, and returns per-message
 * actions for the bot to perform on the WhatsApp side.
 *
 * Flow:
 *   1. Dedupe: skip any waMessageId already in AnalyzedMessage
 *      (covers bot restarts + retries).
 *   2. Hand the batch + cached context to `analyzeBatch()` (one Claude call).
 *   3. For each verdict:
 *        a. Resolve author → User (phone, then fallback by pushname).
 *        b. If verdict says register IN/OUT and we have a User, update
 *           attendance via lib/attendance.ts.
 *        c. Record the outcome in AnalyzedMessage (intent, confidence,
 *           action, reasoning).
 *   4. Return the bot the per-message actions (react, reply) + the
 *      next-kickoff timestamp it needs to decide urgency.
 *
 * Request:
 *   {
 *     groupId: "xxx@g.us",
 *     history: [{authorName, body, timestamp}],
 *     messages: [{waMessageId, body, authorPhone, authorName, timestamp}]
 *   }
 *
 * Response:
 *   {
 *     ok: true,
 *     orgId: "...",
 *     nextKickoffMs: number | null,   // ms since epoch of the next match,
 *                                     // so the bot knows when to urgency-
 *                                     // flush without an extra round trip
 *     results: [
 *       { waMessageId, handledBy, intent, react, reply, reasoning? }
 *     ]
 *   }
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import {
  analyzeBatch,
  enforceProximity,
  enforceCanonicalRoster,
  rewriteOverconfidentPromotion,
  type AnalysisVerdict,
  type BatchInputMessage,
} from "@/lib/message-analyzer";
import { resolveBenchConfirmation } from "@/lib/bench-confirmation";
import { getOrgFeatures, type FeatureKey } from "@/lib/org-features";
import { handleOnboardingTurn } from "@/lib/onboarding-conversation";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";
import { computeEloDeltas } from "@/lib/elo";
import { generateTeamsForMatch } from "@/lib/team-generation";
import { londonDateTimeToUtc, formatLondon } from "@/lib/london-time";

interface InboundMessage {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  timestamp: string;
}

interface InboundHistory {
  authorName: string | null;
  body: string;
  timestamp: string;
}

interface InboundBody {
  groupId: string;
  history?: InboundHistory[];
  messages: InboundMessage[];
}

type ActionForBot = {
  waMessageId: string;
  handledBy: "fast-path" | "llm" | "ignored" | "error" | "deduped";
  intent: string | null;
  react: string | null;
  reply: string | null;
  reasoning?: string;
};

type ResolvedSender = {
  userId: string | null;
  name: string | null;
  phone: string | null;
};

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as InboundBody | null;
  if (!body?.groupId || !Array.isArray(body?.messages)) {
    return NextResponse.json({ error: "groupId and messages[] required" }, { status: 400 });
  }

  // ── Phase 2: autonomous onboarding ───────────────────────────────
  //   Runs BEFORE the bot-enabled-org gate. A group with no org is
  //   normally ignored; here it can bootstrap itself via an explicit
  //   "@MatchTime setup" trigger, then a multi-turn in-group Q&A.
  //   While a session is active every batch routes here (not the
  //   normal analyzer) until it completes/abandons.
  {
    const onb = await handleOnboardingIfApplicable(body);
    if (onb) return NextResponse.json(onb);
  }

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: body.groupId, whatsappBotEnabled: true },
    select: { id: true, name: true },
  });
  if (!org) {
    return NextResponse.json({ ok: true, ignored: "unknown-or-disabled-group", results: [] });
  }

  // 1. Dedupe.
  const all = body.messages;
  const ids = all.map((m) => m.waMessageId);
  const seen = await db.analyzedMessage.findMany({
    where: { waMessageId: { in: ids } },
    select: { waMessageId: true, intent: true, handledBy: true },
  });
  const seenMap = new Map(seen.map((s) => [s.waMessageId, s]));

  const fresh: InboundMessage[] = [];
  const results: ActionForBot[] = [];

  for (const msg of all) {
    const prior = seenMap.get(msg.waMessageId);
    if (prior) {
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "deduped",
        intent: prior.intent,
        react: null,
        reply: null,
      });
      continue;
    }
    const trimmed = msg.body.trim();
    if (trimmed.length === 0) {
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: "ignored",
        intent: "noise",
        action: null,
        confidence: 1,
        reasoning: "empty body",
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "ignored",
        intent: "noise",
        react: null,
        reply: null,
      });
      continue;
    }
    fresh.push(msg);
  }

  // 2. Resolve senders + hand the whole fresh batch to Claude in one call.
  const senderById = new Map<string, ResolvedSender>();
  for (const m of fresh) {
    senderById.set(m.waMessageId, await resolveSender(org.id, m));
  }

  // Pre-load the next upcoming match so we can post-process LLM replies
  // through enforceProximity — guards against "20:30 vs 21:30" style
  // BST/UTC mistakes the LLM occasionally makes when it tries to
  // helpfully convert times.
  const nextMatchForReply = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      attendanceDeadline: { gt: new Date() },
    },
    orderBy: { date: "asc" },
    include: {
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { name: true } } },
        orderBy: { position: "asc" },
      },
    },
  });

  const history = (body.history ?? []).map((h) => ({
    authorName: h.authorName,
    body: h.body,
    timestamp: new Date(h.timestamp),
  }));

  const batchInputs: BatchInputMessage[] = fresh.map((m) => {
    const s = senderById.get(m.waMessageId)!;
    return {
      waMessageId: m.waMessageId,
      body: m.body,
      authorPhone: m.authorPhone,
      authorName: m.authorName,
      authorUserId: s.userId,
      timestamp: new Date(m.timestamp),
    };
  });

  const verdicts = fresh.length
    ? await analyzeBatch({ groupId: body.groupId, history, messages: batchInputs })
    : [];

  // 3. Execute verdicts sequentially (attendance writes are cheap and
  //    order matters for state-collapse correctness).
  // Dedupe `generate_teams_request` within a batch — only the LAST one
  // actually fires. If two players in the same batch both ask to
  // generate teams, running both would emit two team posts that each
  // ignore the other's pin requests. Better to honour the most recent
  // request (which has fresher context) and silently drop the
  // earlier ones to "noise" so they don't fire a second post.
  let lastTeamsRequestIdx = -1;
  for (let i = 0; i < verdicts.length; i++) {
    if (verdicts[i].intent === "generate_teams_request") lastTeamsRequestIdx = i;
  }

  // Pre-compute "latest message index per author" for state-collapse-safe
  // IN backfill below. When the LLM emits intent:"in" but registerAttendance:null
  // (a known failure mode — see Najib 2026-05-08), we force registerAttendance
  // back to "IN" UNLESS the same author has a later message in the batch that
  // legitimately supersedes this one. Without this safety net the player is
  // silently dropped: the bot reacts 👍 but no attendance row is written.
  const latestIdxByAuthor = new Map<string, number>();
  for (let i = 0; i < fresh.length; i++) {
    const uid = senderById.get(fresh[i].waMessageId)?.userId;
    if (uid) latestIdxByAuthor.set(uid, i);
  }

  for (let i = 0; i < fresh.length; i++) {
    const msg = fresh[i];
    let verdict = verdicts[i];
    const sender = senderById.get(msg.waMessageId)!;

    // ── IN intent safety net ─────────────────────────────────────────
    //    If the LLM classified this as "in" but emitted
    //    registerAttendance:null with no state-collapse reason (i.e.
    //    this IS the author's latest IN-shaped message in the batch),
    //    force registerAttendance back to "IN". The prompt forbids
    //    this combination but Haiku has been observed to skip it when
    //    it finds the match state "odd" (e.g. squad full + bench
    //    empty). Server is the source of truth — registerAttendance
    //    is idempotent and capacity-aware, so this is always safe.
    if (
      verdict.intent === "in" &&
      verdict.registerAttendance === null &&
      sender.userId
    ) {
      const latestIdx = latestIdxByAuthor.get(sender.userId);
      if (latestIdx === i) {
        console.warn(
          `[analyze] LLM emitted intent:"in" with registerAttendance:null for ${sender.name} (${msg.waMessageId}). ` +
            `Forcing registerAttendance to "IN" — reasoning was: ${verdict.reasoning}`,
        );
        verdict = { ...verdict, registerAttendance: "IN" };
      }
    }

    if (
      verdict.intent === "generate_teams_request" &&
      i !== lastTeamsRequestIdx
    ) {
      // Earlier duplicate generate-teams request — react ⚽ but don't
      // fire a second post. The last one in the batch handles team
      // generation for everyone.
      verdict = {
        ...verdict,
        intent: "noise",
        reply: null,
        react: "⚽",
        teamOverrides: null,
        includeNames: null,
      };
    }
    try {
      const { react, reply } = await executeVerdict({
        verdict,
        user: sender.userId ? { id: sender.userId, name: sender.name } : null,
        orgId: org.id,
      });
      // Apply the same proximity post-processor the chase composer uses
      // so reactive replies also rewrite "tonight" → "Tue 28 Apr" and
      // any 20:30/21:30-style UTC-vs-BST mistakes. Also enforce the
      // canonical roster — the LLM has been observed to reorder/omit
      // players (especially provisional ones), so any numbered roster
      // in the reply gets overwritten with the truth from the DB.
      // EXCEPT for generate_teams_request: that reply intentionally
      // contains TWO numbered team lists (Red + Yellow) which would
      // be wrecked by the canonical-roster overwrite. Skip it.
      // Re-fetch the match state HERE (not before the loop) so any
      // attendance change just made by the prior verdicts in this
      // batch is reflected — otherwise canonical-roster patches the
      // count back to the stale pre-loop value.
      let cleanReply = reply;
      if (cleanReply && nextMatchForReply) {
        const freshAttendances = await db.attendance.findMany({
          where: { matchId: nextMatchForReply.id, status: "CONFIRMED" },
          include: { user: { select: { name: true } } },
          orderBy: { position: "asc" },
        });
        cleanReply = enforceProximity(cleanReply, nextMatchForReply.date);
        if (verdict.intent !== "generate_teams_request") {
          cleanReply = enforceCanonicalRoster(cleanReply, {
            confirmed: freshAttendances.map((a) => a.user.name ?? "(unnamed)"),
            maxPlayers: nextMatchForReply.maxPlayers,
          });
        }
        // Safety net: if the LLM claimed a bench player has been
        // promoted ("X moves up", "we're still 14/14") but a
        // BenchSlotOffer is still OPEN for this match (slot not yet
        // claimed), the squad is genuinely short — strip the
        // hallucinated promotion and state the slot is still open to
        // the bench. The roster block was already canonicalised above.
        const openOffer = await db.benchSlotOffer.findFirst({
          where: { matchId: nextMatchForReply.id, resolvedAt: null },
          orderBy: { createdAt: "desc" },
        });
        if (openOffer) {
          cleanReply = rewriteOverconfidentPromotion(cleanReply, {
            benchName: "the bench",
            confirmedCount: freshAttendances.length,
            maxPlayers: nextMatchForReply.maxPlayers,
          });
        }
      }
      // ── #1: never silently drop an unresolved attendance message ──
      //   The whole Najib/Erdal/Baki failure class is "message
      //   understood, action silently not taken". The worst variant:
      //   the SENDER themselves couldn't be resolved (ambiguous short
      //   pushname like "ba" → Baki AND Başar), so an IN / OUT / drop
      //   vanished with zero signal for 13 days. When that happens we
      //   now (a) leave a breadcrumb the admin queue surfaces
      //   (authorName is persisted by recordAnalysis), and (b) post a
      //   single, deduped, plain-English clarification to the group so
      //   it's caught in minutes, not when someone eventually notices.
      const attendanceRelevant =
        verdict.registerAttendance === "IN" ||
        verdict.registerAttendance === "OUT" ||
        verdict.registerAttendance === "BENCH" ||
        verdict.intent === "replacement_request";
      if (
        !sender.userId &&
        attendanceRelevant &&
        nextMatchForReply &&
        (msg.authorName ?? "").trim().length >= 1
      ) {
        const pushname = (msg.authorName ?? "").trim();
        const normKey = pushname
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "");
        const dedupeKey = `unresolved-sender:${nextMatchForReply.id}:${normKey}`;
        const already = await db.sentNotification.findUnique({
          where: { key: dedupeKey },
        });
        if (!already) {
          // Plain English — describe what to DO next, no "resolver"/
          // "@lid"/"pushname" jargon (per the product copy rule).
          const verb =
            verdict.registerAttendance === "OUT" ||
            verdict.intent === "replacement_request"
              ? "drop out"
              : "join";
          cleanReply =
            `Heads up — I got a message to *${verb}* from *${pushname}*, but that name isn't ` +
            `matching anyone on the squad list, so I haven't changed anything yet. ` +
            `Could *${pushname}* reply with the name they're registered under, or an admin can link it on the dashboard? 🙏`;
          // Record the dedupe row immediately. Tiny risk: if the bot
          // fails to post we under-notify — acceptable, the admin
          // queue is the backstop, and re-nudging every batch would
          // spam the group (the failure Kemal hates most).
          await db.sentNotification.create({
            data: {
              key: dedupeKey,
              kind: "unresolved-sender-nudge",
              matchId: nextMatchForReply.id,
            },
          });
        } else {
          // Already nudged for this pushname+match — stay silent,
          // don't repeat. The admin queue still lists it.
          cleanReply = null;
        }
      }

      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: "llm",
        intent: verdict.intent,
        action:
          verdict.registerAttendance ??
          (react || cleanReply ? (react ? "react" : "reply") : "none"),
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
        authorUserId: sender.userId,
        authorName: msg.authorName ?? null,
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "llm",
        intent: verdict.intent,
        react,
        reply: cleanReply,
        reasoning: verdict.reasoning,
      });
    } catch (err) {
      console.error("[analyze] verdict execution failed:", err, "for", msg.waMessageId);
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: "error",
        intent: verdict.intent,
        action: null,
        confidence: verdict.confidence,
        reasoning: err instanceof Error ? err.message : String(err),
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "error",
        intent: verdict.intent,
        react: null,
        reply: null,
      });
    }
  }

  // 3b. Backfill the registration-react on earlier duplicate IN messages
  //     from same author. State-collapse: when a player sends "count me
  //     in" then "IN" 30s later, the LLM only registers the latest
  //     (correct — no double-registration). But the earlier message
  //     gets a plain 👍 which looks like "not registered" and confuses
  //     people into retyping. If a later verdict for the same author
  //     registered them as IN (✅ or 🪑), propagate it back to the
  //     earlier IN verdicts so the chat reads cleanly.
  const registrationReacts = new Set(["✅", "🪑"]);
  const latestInReactByUser = new Map<string, string>();
  for (const r of results) {
    const uid = senderById.get(r.waMessageId)?.userId;
    if (!uid || r.intent !== "in" || !r.react) continue;
    if (registrationReacts.has(r.react)) latestInReactByUser.set(uid, r.react);
  }
  for (const r of results) {
    const uid = senderById.get(r.waMessageId)?.userId;
    if (!uid || r.intent !== "in" || !r.react) continue;
    if (registrationReacts.has(r.react)) continue;
    const fill = latestInReactByUser.get(uid);
    if (fill) r.react = fill;
  }

  // 4. Return + include next-kickoff so the bot can urgency-flush.
  const nextMatch = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    select: { date: true },
  });

  return NextResponse.json({
    ok: true,
    orgId: org.id,
    nextKickoffMs: nextMatch?.date.getTime() ?? null,
    results,
  });
}

/**
 * Clear `leftAt` on a soft-removed membership when the player has
 * resurfaced in the chat. Preserves history (rating, attendance) and
 * silently re-activates them in the roster.
 */
async function restoreMembership(membershipId: string, name: string | null) {
  await db.membership.update({
    where: { id: membershipId },
    data: { leftAt: null, provisionallyAddedAt: null },
  });
  console.log(`[analyze] restored soft-removed membership ${membershipId} (${name ?? "unknown"})`);
}

async function resolveSender(orgId: string, msg: InboundMessage): Promise<ResolvedSender> {
  // Phone first (most accurate). Accept raw digits — prepend '+' if the
  // bot didn't. @lid senders arrive with empty phone: that's the signal
  // to try a name-based fallback.
  if (msg.authorPhone) {
    const raw = msg.authorPhone.startsWith("+") ? msg.authorPhone : `+${msg.authorPhone}`;
    const norm = normalisePhone(raw);
    if (norm) {
      const user = await db.user.findUnique({
        where: { phoneNumber: norm },
        select: { id: true, name: true },
      });
      if (user) return { userId: user.id, name: user.name, phone: norm };
    }
  }
  if (msg.authorName && msg.authorName.trim().length >= 2) {
    // Fuzzy name match — the sender's WhatsApp display name ("Kemal
    // Ediz") often doesn't exactly match the DB record ("Kemal"), so
    // we:
    //   1. First try exact case-insensitive equals (the historic rule)
    //   2. Fall back to first-token match on either side — DB first
    //      name vs pushname first name, either direction
    // Both variants still require a UNIQUE match in the org to avoid
    // guessing between two players with the same first name.
    const pushname = msg.authorName.trim();
    // Include soft-removed memberships in the candidate set: someone
    // posting in the group is clearly back, so a unique match against a
    // soft-removed member should restore them rather than provision a
    // new ghost user. We track leftAt status per-candidate to apply the
    // restore on the chosen match.
    const candidates = await db.membership.findMany({
      where: { orgId },
      include: { user: { select: { id: true, name: true } } },
    });
    const norm = (s: string) =>
      s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const pushTokens = norm(pushname).split(/\s+/).filter(Boolean);
    const pushFirst = pushTokens[0] ?? "";

    const equalsMatches = candidates.filter(
      (c) => c.user.name && norm(c.user.name) === norm(pushname),
    );
    if (equalsMatches.length === 1) {
      const m = equalsMatches[0];
      if (m.leftAt) await restoreMembership(m.id, m.user.name);
      return { userId: m.user.id, name: m.user.name, phone: null };
    }

    const firstNameMatches = candidates.filter((c) => {
      if (!c.user.name) return false;
      const dbTokens = norm(c.user.name).split(/\s+/).filter(Boolean);
      const dbFirst = dbTokens[0] ?? "";
      return (
        dbFirst === pushFirst ||
        // Relaxed prefix match: as long as one side is ≥3 chars and the
        // other is ≥2, accept a startsWith. Handles short pushnames like
        // "ba" → "Baki" and nicknames like "Kara" → "Karahan". The
        // uniqueness check above still blocks ambiguous cases ("Ed" when
        // both "Ediz" and "Edward" are in the org).
        ((dbFirst.length >= 3 && pushFirst.length >= 2 && dbFirst.startsWith(pushFirst)) ||
          (pushFirst.length >= 3 && dbFirst.length >= 2 && pushFirst.startsWith(dbFirst)))
      );
    });
    if (firstNameMatches.length === 1) {
      const m = firstNameMatches[0];
      if (m.leftAt) await restoreMembership(m.id, m.user.name);
      return { userId: m.user.id, name: m.user.name, phone: null };
    }
    // Multiple first-name matches (e.g. two Ibrahims) — try the alias
    // table FIRST before giving up. UserAlias is admin-curated
    // (populated by mergePlayers) and unique per (orgId, alias), so an
    // alias hit disambiguates cleanly regardless of how many fuzzy
    // candidates also match. Kemal flagged 2026-05-15: Baki's "ba"
    // pushname matches both Baki and Başar by fuzzy, so the resolver
    // returned null — but UserAlias["ba"] → Baki was already present
    // from an earlier merge, and it should have taken precedence.
    if (firstNameMatches.length > 1) {
      const aliasKeyEarly = norm(pushname);
      if (aliasKeyEarly.length >= 2) {
        const alias = await db.userAlias.findUnique({
          where: { orgId_alias: { orgId, alias: aliasKeyEarly } },
        });
        if (alias) {
          const m = candidates.find((c) => c.userId === alias.userId);
          if (m) {
            if (m.leftAt) await restoreMembership(m.id, m.user.name);
            console.log(
              `[analyze] ambiguous fuzzy "${pushname}" resolved via UserAlias → ${m.user.name} (${alias.userId})`,
            );
            return { userId: m.user.id, name: m.user.name, phone: null };
          }
        }
      }
      console.warn(
        `[analyze] ambiguous fuzzy match for "${pushname}" in org ${orgId} — ${firstNameMatches.length} candidates: ${firstNameMatches
          .map((m) => m.user.name)
          .join(", ")} (no alias to disambiguate)`,
      );
      return { userId: null, name: pushname, phone: null };
    }

    // Alias lookup. Admin merges populate UserAlias rows (Nunu →
    // Elnur Mammadov, etc.) so the next time the same pushname
    // arrives we resolve to the real user instead of creating
    // another ghost. Letter-overlap-based fuzzy could never bridge
    // "Nunu" → "Elnur" — admin curation is the right tool for
    // nicknames + privacy-mode pushnames.
    const aliasKey = norm(pushname);
    if (aliasKey.length >= 2) {
      const alias = await db.userAlias.findUnique({
        where: { orgId_alias: { orgId, alias: aliasKey } },
      });
      if (alias) {
        const m = candidates.find((c) => c.userId === alias.userId);
        if (m) {
          if (m.leftAt) await restoreMembership(m.id, m.user.name);
          return { userId: m.user.id, name: m.user.name, phone: null };
        }
      }
    }
  }
  // Auto-create a provisional member when we couldn't match.
  //   Rationale: the message came from the org's monitored WhatsApp
  //   group, so by construction the sender is in the roster. Silently
  //   dropping their IN/OUT is a worse failure mode than occasionally
  //   creating a duplicate that an admin has to merge. Admin dashboard
  //   surfaces provisional members (via Membership.provisionallyAddedAt)
  //   so they can set phone/position/rating or remove them.
  const provisional = await createProvisionalMember(orgId, msg);
  if (provisional) return provisional;
  return { userId: null, name: msg.authorName, phone: null };
}

async function createProvisionalMember(
  orgId: string,
  msg: InboundMessage,
): Promise<ResolvedSender | null> {
  return createProvisionalByName(orgId, msg.authorName?.trim() ?? null, msg.authorPhone);
}

/**
 * Fuzzy-match a free-text name against the org's roster, or create a
 * provisional member if no unique match. Used for:
 *   - the message sender themselves (resolveSender fallback)
 *   - third-party registrations ("my dad Najib is also in" → lookup
 *     "Najib" in org, else provision)
 *
 * Returns null only when the name is empty / obviously not a person.
 */
async function resolveOrProvisionByName(
  orgId: string,
  rawName: string,
): Promise<{ userId: string; name: string | null } | null> {
  const name = rawName.trim();
  if (!name || name.length < 2) return null;

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
    console.warn(
      `[analyze] third-party name "${name}" is ambiguous in org ${orgId} (${firstNameMatches.length} candidates, no alias to disambiguate). Skipping registration.`,
    );
    return null;
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
  const provisioned = await createProvisionalByName(orgId, name, null);
  if (provisioned) return { userId: provisioned.userId!, name: provisioned.name };
  return null;
}

async function createProvisionalByName(
  orgId: string,
  rawName: string | null,
  rawPhone: string | null,
): Promise<ResolvedSender | null> {
  const name = rawName?.trim();
  // Require ≥3 chars: 2-char pushnames like "ba" are almost always
  // truncations of a real name we already have (e.g. "Baki Sutton") and
  // provisioning them creates duplicate ghost users. The relaxed fuzzy
  // matcher (see firstNameMatches) now resolves short pushnames to
  // existing members; provisioning is reserved for genuinely new names.
  if (!name || name.length < 3) return null;
  // Skip obvious non-player authors (bot itself, group admin system messages).
  const blocked = /^(match time|matchtime|whatsapp|system)$/i;
  if (blocked.test(name)) return null;

  const normPhone = rawPhone
    ? normalisePhone(rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`)
    : null;

  // Synthetic email keeps the User.email unique constraint happy — users
  // can claim their account later via a real email address when they
  // log in (onboarding flow overwrites this placeholder).
  const emailSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "player";
  const syntheticEmail = `provisional+${emailSlug}-${Date.now().toString(36)}@matchtime.local`;

  try {
    // Phone is unique globally, so if a user with that phone already
    // exists (from another org), reuse them rather than failing.
    let user = normPhone
      ? await db.user.findUnique({ where: { phoneNumber: normPhone } })
      : null;
    if (!user) {
      user = await db.user.create({
        data: {
          name,
          email: syntheticEmail,
          phoneNumber: normPhone,
          onboarded: false,
          isActive: true,
        },
      });
    }

    // Upsert membership: if user already exists in this org (e.g. re-joined),
    // just clear leftAt and mark as provisional again.
    await db.membership.upsert({
      where: { userId_orgId: { userId: user.id, orgId } },
      create: {
        userId: user.id,
        orgId,
        role: "PLAYER",
        provisionallyAddedAt: new Date(),
      },
      update: {
        leftAt: null,
        provisionallyAddedAt: new Date(),
      },
    });
    console.log(`[analyze] auto-created provisional member ${user.id} (${name}) in org ${orgId}`);
    return { userId: user.id, name: user.name, phone: normPhone };
  } catch (err) {
    console.error("[analyze] provisional member creation failed:", err);
    return null;
  }
}

/**
 * Slot → emoji map for the bot's attendance reactions. Confirmed slots
 * 1-10 get the corresponding keycap. 11+ get ✅ — Unicode doesn't have
 * single-grapheme keycaps for 11+ and "1️⃣3️⃣" is two emojis (WhatsApp
 * reactions are one grapheme), so ⚽ used to be the fallback but it
 * camouflaged with player-emoji reactions. ✅ reads as "you're in" without
 * looking like a generic football react. Bench slots get 🪑. OUT gets 👋.
 */
const KEYCAP: Record<number, string> = {
  1: "1️⃣",
  2: "2️⃣",
  3: "3️⃣",
  4: "4️⃣",
  5: "5️⃣",
  6: "6️⃣",
  7: "7️⃣",
  8: "8️⃣",
  9: "9️⃣",
  10: "🔟",
};

/**
 * Fire a one-off group announcement when the squad JUST reached its
 * maximum confirmed count. Called after any attendance write in this
 * route. Idempotent via SentNotification with key
 * `<matchId>:squad-locked`; the bot picks up the BotJob on its next
 * due-posts poll and sends it to the group.
 */
async function announceSquadFullIfJustFilled(args: {
  orgId: string;
  matchId: string;
  maxPlayers: number;
  activityName: string;
  confirmedCount: number;
  kickoffLondon: string;
}) {
  if (args.confirmedCount < args.maxPlayers) return;
  const key = `${args.matchId}:squad-locked`;
  const already = await db.sentNotification.findFirst({ where: { key } });
  if (already) return;

  // Record intent to send — the bot's next due-posts cycle will emit
  // the group message. Using BotJob + SentNotification mirror pattern
  // so the admin-panel view + idempotency both work.
  await db.botJob.create({
    data: {
      orgId: args.orgId,
      kind: "group",
      text:
        `✅ *Squad locked!* We're full at *${args.maxPlayers}/${args.maxPlayers}* for *${args.activityName}* on ${args.kickoffLondon}.\n\n` +
        `See you all there 🙌⚽`,
    },
  });
  await db.sentNotification.create({
    data: {
      matchId: args.matchId,
      kind: "group-message",
      key,
    },
  });
}

/** Thin wrapper that loads match + activity + confirmed count before
 *  delegating to announceSquadFullIfJustFilled. Gated by a dedupe row
 *  so if multiple people get registered in the same batch and push the
 *  count to max, only one announcement fires. */
async function announceSquadFullIfJustFilledFor(orgId: string, matchId: string) {
  const m = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: { select: { name: true } },
      attendances: { where: { status: "CONFIRMED" }, select: { id: true } },
    },
  });
  if (!m) return;
  const kickoffLondon = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(m.date)
    .replace(/,/g, "");
  await announceSquadFullIfJustFilled({
    orgId,
    matchId: m.id,
    maxPlayers: m.maxPlayers,
    activityName: m.activity.name,
    confirmedCount: m.attendances.length,
    kickoffLondon,
  });
}

/**
 * Pick the right match for an attendance/bench mutation.
 *
 * Two evolutions of this rule:
 * - 2026-05-06: dropped the `attendanceDeadline > now` filter (was
 *   causing post-deadline cascade to NEXT WEEK silently). Now we
 *   only consider matches with date >= startOfToday.
 * - 2026-05-06 (later): block registrations while the most recent
 *   scheduled match hasn't been COMPLETED yet. Use case: yesterday's
 *   match has ended (~22:30) but the cron hasn't flipped its status
 *   to COMPLETED yet (~01:00 the next morning). During that window
 *   a player saying "in" should NOT silently register for next
 *   week's match — they're almost certainly still talking about
 *   yesterday's match. Registration only opens once the current
 *   match is COMPLETED.
 *
 * Rule:
 *   1. If any non-COMPLETED non-CANCELLED match has date < today,
 *      return null. The current scheduled match is in flight.
 *   2. Otherwise return the soonest non-completed match where
 *      date >= today.
 */
async function findRegistrationMatch(orgId: string) {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const inFlight = await db.match.findFirst({
    where: {
      activity: { orgId },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      date: { lt: todayStart },
    },
    orderBy: { date: "desc" },
    select: { id: true, date: true, status: true },
  });
  if (inFlight) return null;
  return db.match.findFirst({
    where: {
      activity: { orgId },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      date: { gte: todayStart },
    },
    orderBy: { date: "asc" },
  });
}

async function executeVerdict(args: {
  verdict: AnalysisVerdict;
  user: { id: string; name: string | null } | null;
  orgId: string;
}): Promise<{ react: string | null; reply: string | null }> {
  const { verdict, user, orgId } = args;
  let finalReact = verdict.react;
  let finalReply = verdict.reply;

  // ── Per-org feature gate ─────────────────────────────────────────
  //   Map the verdict to the module it would exercise; if that module
  //   is OFF for this org, do nothing (no react, no reply) — the bot
  //   stays completely silent on that capability. This is how Amir's
  //   Thursday group runs MoM + ratings only: attendance / bench /
  //   team-balancing / reminders verdicts are no-ops there. Score
  //   stays ungated — it's infrastructure that feeds MoM + ratings,
  //   not a user-facing toggle.
  {
    const f = await getOrgFeatures(orgId);
    const needs: FeatureKey | null = verdict.benchConfirmation
      ? "bench"
      : verdict.intent === "generate_teams_request"
        ? "teamBalancing"
        : verdict.intent === "reminder_request"
          ? "reminders"
          : verdict.registerAttendance ||
              (verdict.registerFor && verdict.registerFor.length > 0) ||
              verdict.intent === "in" ||
              verdict.intent === "out" ||
              verdict.intent === "replacement_request" ||
              verdict.intent === "conditional_in"
            ? "attendance"
            : null;
    if (needs && !f[needs]) {
      return { react: null, reply: null };
    }
  }

  // ── Last-mile react rewrite for IN intent ────────────────────────
  //    When a player says IN but they're already CONFIRMED/BENCH for
  //    the match, the LLM correctly leaves registerAttendance null
  //    (idempotent, no double-register). Without this block, the
  //    LLM's literal 👍 would slip through and the player would see
  //    a thumbs-up instead of the ✅/🪑 we use for registration. Run
  //    BEFORE the registerAttendance/registerFor branches so they can
  //    overwrite finalReact with their own (slot-aware) value.
  if (verdict.intent === "in" && user && finalReact === "👍") {
    const matchForOrg = await findRegistrationMatch(orgId);
    if (matchForOrg) {
      const att = await db.attendance.findUnique({
        where: { matchId_userId: { matchId: matchForOrg.id, userId: user.id } },
        select: { status: true },
      });
      if (att?.status === "CONFIRMED") finalReact = "✅";
      else if (att?.status === "BENCH") finalReact = "🪑";
    }
  }

  // ── Bench-confirmation reply ─────────────────────────────────────
  //    When the LLM detects an answer to an open bench-prompt (the
  //    bench user replied 👍/yes/no in the GROUP instead of reacting
  //    to the DM), route to the same flow the reaction handler uses.
  //    This supersedes any registerAttendance the LLM may have also
  //    set — bench-confirmation outranks generic IN/OUT for users on
  //    the open-prompt list.
  if (verdict.benchConfirmation && user) {
    const matchForOrg = await findRegistrationMatch(orgId);
    if (matchForOrg) {
      const result = await resolveBenchConfirmation({
        matchId: matchForOrg.id,
        userId: user.id,
        decision: verdict.benchConfirmation === "yes",
      });
      // Server posts its own group announcement; suppress the LLM's
      // reply for this verdict so we don't double-post. Simple
      // semantic react: ✅ when confirmed, 👋 when declined.
      if (result.kind === "confirmed") {
        finalReact = "✅";
        finalReply = null;
      } else if (result.kind === "declined") {
        finalReact = "👋";
        finalReply = null;
      }
      // "ignored" (no open PBC found at execution time — race) falls
      // through; nothing to do.
      return { react: finalReact, reply: finalReply };
    }
  }

  // ── Attendance IN/OUT ────────────────────────────────────────────
  //    When the verdict says to register, update attendance and then
  //    compute the real slot emoji so the bot reacts with the correct
  //    1️⃣–🔟 / 🪑 / 👋 instead of the generic 👍/👋 Claude emits.
  if (verdict.registerAttendance && user) {
    const matchForOrg = await findRegistrationMatch(orgId);
    if (matchForOrg) {
      // Pre-check OUT requests: if the sender doesn't actually have a
      // CONFIRMED/BENCH attendance row for this match, there's nothing
      // to drop — but Claude's reply (composed before this server-side
      // check) typically reads "Squad is now (N-1)/M — we need one
      // more". Posting that text when no drop actually happened is
      // misleading, AND when paired with enforceCanonicalRoster's
      // count-patcher (which rewrites the count to the true DB value)
      // produces nonsense like "14/14 — we need one more". Suppress
      // the reply + react and let the bot stay silent on these.
      if (verdict.registerAttendance === "OUT") {
        const existingAtt = await db.attendance.findFirst({
          where: {
            userId: user.id,
            matchId: matchForOrg.id,
            status: { in: ["CONFIRMED", "BENCH"] },
          },
          select: { id: true },
        });
        if (!existingAtt) {
          finalReact = null;
          finalReply = null;
          return { react: finalReact, reply: finalReply };
        }
      }
      try {
        if (
          verdict.registerAttendance === "IN" ||
          verdict.registerAttendance === "BENCH"
        ) {
          const result = await registerAttendance(user.id, matchForOrg.id, {
            forceBench: verdict.registerAttendance === "BENCH",
          });
          // Simple semantic react: ✅ if they made the squad, 🪑 if
          // they landed on the bench. We used to react with a slot-
          // number keycap (1️⃣–🔟) showing the player's position, but
          // it confused everyone — people read it as a "2 reactions"
          // counter — and the keycaps went stale every time someone
          // dropped/added. Kemal flagged this on 2026-05-05.
          finalReact = result.status === "CONFIRMED" ? "✅" : "🪑";
          await announceSquadFullIfJustFilledFor(orgId, matchForOrg.id);
        } else {
          await cancelAttendance(user.id, matchForOrg.id);
          finalReact = "👋";
        }
      } catch (err) {
        console.error("[analyze] attendance update failed:", err);
      }
    }
  }

  // ── Third-party attendance registrations ────────────────────────
  //    "my dad Najib is in" / "Ibrahim can't make it" — the message
  //    signs up/drops someone OTHER than the sender. Fuzzy-match the
  //    named person against the org's roster; create a provisional
  //    member if no match. The react on the SENDER's message reflects
  //    the slot of the last newly-added player, so the group can see
  //    the registration landed.
  if (verdict.registerFor && verdict.registerFor.length > 0) {
    const matchForOrg = await findRegistrationMatch(orgId);
    if (matchForOrg) {
      for (const entry of verdict.registerFor) {
        try {
          const target = await resolveOrProvisionByName(orgId, entry.name);
          if (!target) continue;
          // Don't double-register the sender if the LLM mistakenly
          // put them in registerFor as well.
          if (user && target.userId === user.id) continue;
          if (entry.action === "IN") {
            const result = await registerAttendance(target.userId, matchForOrg.id);
            // Same semantic react rule as for the sender — ✅ for a
            // confirmed slot, 🪑 for bench. No more keycap numbers.
            finalReact = result.status === "CONFIRMED" ? "✅" : "🪑";
            await announceSquadFullIfJustFilledFor(orgId, matchForOrg.id);
          } else {
            await cancelAttendance(target.userId, matchForOrg.id);
            finalReact = "👋";
          }
        } catch (err) {
          console.error(`[analyze] third-party registration failed for "${entry.name}":`, err);
        }
      }
    }
  }

  // ── Score submission ─────────────────────────────────────────────
  //    LLM extracted scoreRed / scoreYellow. We record the score as
  //    long as we can identify an unscored match that has actually
  //    ended. If we can resolve the sender to a known org admin or
  //    confirmed participant → write the score. If we CAN'T resolve
  //    them (e.g. WhatsApp hid the phone via @lid and the pushname
  //    didn't match any player) → still write the score, because the
  //    message came from the monitored org's group chat and losing
  //    the score entirely is a worse failure mode than occasionally
  //    trusting a wrong number. Admin can correct via the dashboard.
  if (
    verdict.intent === "score" &&
    typeof verdict.scoreRed === "number" &&
    typeof verdict.scoreYellow === "number"
  ) {
    try {
      const now = new Date();
      const candidates = await db.match.findMany({
        where: {
          activity: { orgId },
          redScore: null,
          yellowScore: null,
          status: { in: ["TEAMS_PUBLISHED", "COMPLETED", "TEAMS_GENERATED"] },
        },
        include: {
          activity: true,
          teamAssignments: {
            include: { user: { select: { matchRating: true } } },
          },
        },
        orderBy: { date: "desc" },
        take: 10,
      });
      const target = candidates.find((m) => {
        const endedAt = new Date(m.date.getTime() + m.activity.matchDurationMins * 60 * 1000);
        return endedAt <= now;
      });
      if (target) {
        // Authorisation check only blocks if we resolved a user AND they
        // are neither admin nor confirmed. If user is null (unresolvable
        // @lid), we permit.
        let allowed = true;
        if (user) {
          const attendance = await db.attendance.findUnique({
            where: { matchId_userId: { matchId: target.id, userId: user.id } },
          });
          const membership = await db.membership.findUnique({
            where: { userId_orgId: { userId: user.id, orgId } },
          });
          const isAdmin =
            membership && (membership.role === "OWNER" || membership.role === "ADMIN");
          const wasPlaying = attendance?.status === "CONFIRMED";
          allowed = !!(isAdmin || wasPlaying);
        }
        if (allowed) {
          await db.match.update({
            where: { id: target.id },
            data: {
              redScore: verdict.scoreRed,
              yellowScore: verdict.scoreYellow,
              status: "COMPLETED",
            },
          });
          try {
            const eloInputs = target.teamAssignments.map((t) => ({
              userId: t.userId,
              team: t.team,
              matchRating: t.user.matchRating,
            }));
            const deltas = computeEloDeltas(eloInputs, verdict.scoreRed, verdict.scoreYellow);
            await db.$transaction(
              deltas.map((d) =>
                db.user.update({ where: { id: d.userId }, data: { matchRating: d.after } }),
              ),
            );
          } catch (err) {
            console.error("[analyze] Elo update after LLM score failed:", err);
          }
          finalReact = finalReact ?? "👍";
        } else {
          // Resolved sender who is neither admin nor confirmed tried to
          // record — silent. Don't even react.
          finalReact = null;
        }
      }
    } catch (err) {
      console.error("[analyze] score processing failed:", err);
    }
  }

  // ── Generate-teams request ───────────────────────────────────────
  //    Someone asked the bot to balance + post the teams. Optionally
  //    with "consider Ibrahim + Ehtisham as IN" overrides, which we
  //    honour by flipping those players from DROPPED/BENCH to
  //    CONFIRMED before calling the balancer. Server generates the
  //    reply text from the actual balancer output — Claude's `reply`
  //    field (if any) is overridden.
  if (verdict.intent === "generate_teams_request") {
    try {
      const match = await db.match.findFirst({
        where: {
          activity: { orgId },
          status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
          attendanceDeadline: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        orderBy: { date: "asc" },
      });
      if (!match) {
        finalReply = "No match lined up to build teams for.";
        finalReact = "🤔";
      } else {
        // Force-include players named in the message.
        const includedLog: string[] = [];
        const unmatchedLog: string[] = [];
        if (verdict.includeNames && verdict.includeNames.length > 0) {
          const roster = await db.attendance.findMany({
            where: { matchId: match.id },
            include: { user: { select: { id: true, name: true } } },
          });
          const norm = (s: string) =>
            s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          for (const rawName of verdict.includeNames) {
            const target = roster.find((a) => {
              if (!a.user.name) return false;
              const u = norm(a.user.name);
              const q = norm(rawName);
              return u === q || u.startsWith(`${q} `) || u.split(" ")[0] === q;
            });
            if (!target) {
              unmatchedLog.push(rawName);
              continue;
            }
            if (target.status !== "CONFIRMED") {
              await db.attendance.update({
                where: { id: target.id },
                data: { status: "CONFIRMED" },
              });
            }
            includedLog.push(target.user.name ?? rawName);
          }
        }

        // Resolve per-team pin requests ("put me on Red"). Fuzzy-match
        // each name against the (now possibly updated) roster; ignore
        // unmatched. The author refers to themselves as "me/myself/I"
        // — Claude is supposed to substitute their first name in the
        // verdict, but if any literal "me"-style placeholder slips
        // through we rebind it here using the resolved sender.
        const pinnedToTeam: Record<string, "RED" | "YELLOW"> = {};
        const pinnedLog: string[] = [];
        const pinnedUnmatched: string[] = [];
        if (verdict.teamOverrides && verdict.teamOverrides.length > 0) {
          const roster = await db.attendance.findMany({
            where: { matchId: match.id, status: "CONFIRMED" },
            include: { user: { select: { id: true, name: true } } },
          });
          const norm = (s: string) =>
            s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          const SELF = new Set(["me", "myself", "i"]);
          const senderFirst =
            user?.name?.trim().split(/\s+/)[0]?.toLowerCase() ?? null;
          for (const o of verdict.teamOverrides) {
            const cleaned = o.name.trim();
            const lookup = SELF.has(cleaned.toLowerCase()) && senderFirst
              ? senderFirst
              : cleaned;
            const target = roster.find((a) => {
              if (!a.user.name) return false;
              const u = norm(a.user.name);
              const q = norm(lookup);
              return u === q || u.startsWith(`${q} `) || u.split(" ")[0] === q;
            });
            if (!target) {
              pinnedUnmatched.push(cleaned);
              continue;
            }
            pinnedToTeam[target.user.id] = o.team;
            pinnedLog.push(`${target.user.name ?? cleaned} → ${o.team}`);
          }
        }

        const result = await generateTeamsForMatch(match.id, {
          pinnedToTeam:
            Object.keys(pinnedToTeam).length > 0 ? pinnedToTeam : undefined,
        });
        if (result.ok) {
          let text = result.groupPost;
          if (includedLog.length > 0) {
            text = `_Including ${includedLog.join(", ")} as CONFIRMED per the request._\n\n${text}`;
          }
          if (pinnedLog.length > 0) {
            text = `_Pinned per the request: ${pinnedLog.join(", ")}._\n\n${text}`;
          }
          if (unmatchedLog.length > 0) {
            text += `\n\n_(couldn't find ${unmatchedLog.join(", ")} in the roster — ignored)_`;
          }
          if (pinnedUnmatched.length > 0) {
            text += `\n\n_(couldn't find ${pinnedUnmatched.join(", ")} for team pinning — ignored)_`;
          }
          finalReply = text;
          finalReact = "⚽";
        } else {
          finalReply = `Can't build teams right now — ${result.reason}.`;
          finalReact = "🤔";
        }
      }
    } catch (err) {
      console.error("[analyze] generate_teams_request failed:", err);
      finalReply = null;
    }
  }

  // ── Bulk payment credit ─────────────────────────────────────────
  //    Admin-only feature: when an OWNER/ADMIN of the org says
  //    "Amir paid for 4 players" or "Amir paid for Faris and Adam",
  //    credit the payment(s) against the most recent completed
  //    match's unpaid count. Random group members triggering this
  //    intent are silently ignored — saves the chase math from
  //    being broken by a stray message.
  //
  //    Two paths depending on what the LLM extracted:
  //      (a) coveredNames[] given → resolve each to an Attendance
  //          row, mark paidAt + paidViaUserId per row. No
  //          PaymentCredit row (avoids double-count).
  //      (b) just count given → create a single PaymentCredit row
  //          with the count.
  if (verdict.intent === "bulk_payment_credit" && verdict.bulkPayment) {
    try {
      // Org-level kill switch: when payment tracking is off for this
      // org, silently ignore the credit attempt. Bot stays silent —
      // the admin's message gets a noise-classification trail in
      // AnalyzedMessage and that's it.
      const orgFlag = await db.organisation.findUnique({
        where: { id: orgId },
        select: { paymentTrackingEnabled: true },
      });
      if (!orgFlag?.paymentTrackingEnabled) {
        finalReply = null;
        finalReact = null;
      } else {
      // Authorise: only OWNER/ADMIN of THIS org.
      const role = user
        ? (
            await db.membership.findUnique({
              where: { userId_orgId: { userId: user.id, orgId } },
              select: { role: true, leftAt: true },
            })
          )
        : null;
      const isAdmin = role && role.leftAt === null && (role.role === "OWNER" || role.role === "ADMIN");
      if (!isAdmin) {
        // Silent — random group members can't credit payments.
        finalReply = null;
        finalReact = null;
      } else {
        const target = await db.match.findFirst({
          where: { activity: { orgId }, status: "COMPLETED", isHistorical: false },
          orderBy: { date: "desc" },
          include: {
            activity: { select: { name: true } },
            attendances: {
              where: { status: "CONFIRMED" },
              include: { user: { select: { id: true, name: true } } },
            },
          },
        });
        if (!target) {
          finalReply = "No recent completed match to credit payments against.";
          finalReact = "🤔";
        } else {
          const norm = (s: string) =>
            s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          // Resolve payer to a member of the org. Match by name.
          const orgMembers = await db.membership.findMany({
            where: { orgId, leftAt: null },
            include: { user: { select: { id: true, name: true } } },
          });
          const payerKey = norm(verdict.bulkPayment.payerName);
          const payerCandidates = orgMembers.filter((m) => {
            if (!m.user.name) return false;
            const u = norm(m.user.name);
            return (
              u === payerKey ||
              u.split(" ")[0] === payerKey.split(" ")[0] ||
              u.startsWith(payerKey + " ") ||
              payerKey.startsWith(u + " ")
            );
          });
          if (payerCandidates.length !== 1) {
            finalReply = `Couldn't tell who *${verdict.bulkPayment.payerName}* is for the payment credit. Try again with a clearer name.`;
            finalReact = "🤔";
          } else {
            const payer = payerCandidates[0].user;

            const coveredNames = verdict.bulkPayment.coveredNames ?? [];
            const matchedNames: string[] = [];
            const unmatchedNames: string[] = [];
            if (coveredNames.length > 0) {
              for (const rawName of coveredNames) {
                const key = norm(rawName);
                const SELF = new Set(["me", "myself", "i"]);
                const lookupKey =
                  SELF.has(key) && user?.name
                    ? norm(user.name).split(" ")[0]
                    : key;
                const att = target.attendances.find((a) => {
                  if (!a.user.name) return false;
                  const u = norm(a.user.name);
                  return (
                    u === lookupKey ||
                    u.split(" ")[0] === lookupKey ||
                    u.startsWith(lookupKey + " ")
                  );
                });
                if (!att) {
                  unmatchedNames.push(rawName);
                  continue;
                }
                if (!att.paidAt) {
                  await db.attendance.update({
                    where: { id: att.id },
                    data: { paidAt: new Date(), paidViaUserId: payer.id },
                  });
                }
                matchedNames.push(att.user.name ?? rawName);
              }
            } else {
              // Aggregate credit, no specific names.
              await db.paymentCredit.create({
                data: {
                  matchId: target.id,
                  payerUserId: payer.id,
                  count: verdict.bulkPayment.count,
                  recordedById: user!.id,
                  note: `Recorded via WhatsApp by ${user?.name ?? "admin"}`,
                },
              });
            }

            // Recompute unpaid for the confirmation reply.
            const refreshed = await db.match.findUnique({
              where: { id: target.id },
              include: {
                attendances: { where: { status: "CONFIRMED" } },
                paymentCredits: true,
              },
            });
            const confirmedCount = refreshed?.attendances.length ?? 0;
            const pollPaid =
              refreshed?.attendances.filter((a) => a.paidAt != null).length ?? 0;
            const creditCount =
              refreshed?.paymentCredits.reduce((s, c) => s + c.count, 0) ?? 0;
            const unpaid = Math.max(0, confirmedCount - pollPaid - creditCount);

            const creditedDescription =
              matchedNames.length > 0
                ? `${matchedNames.join(", ")}`
                : `${verdict.bulkPayment.count} payment${verdict.bulkPayment.count === 1 ? "" : "s"}`;
            const tail = unmatchedNames.length > 0
              ? `\n\n_(couldn't find ${unmatchedNames.join(", ")} on the squad — those names ignored)_`
              : "";
            finalReply =
              `💳 Got it — credited *${payer.name ?? verdict.bulkPayment.payerName}* with ${creditedDescription} for *${target.activity.name}*. ` +
              `Unpaid: ${unpaid}/${confirmedCount}.${tail}`;
            finalReact = "👍";
          }
        }
      }
      } // end paymentTrackingEnabled gate
    } catch (err) {
      console.error("[analyze] bulk_payment_credit failed:", err);
      finalReply = null;
    }
  }

  // ── Personal reminder request ────────────────────────────────────
  //    "@MatchTime remind me on Monday" — queue a future-dated kind="dm"
  //    BotJob. The analyzer resolved the natural-language time to an
  //    explicit London date(+time); we convert London→UTC, clamp to a
  //    sane window, look up the sender's phone, and enqueue. The
  //    scheduler's BotJob block only emits rows whose sendAfter has
  //    passed, so this naturally fires on the right day. We compose the
  //    confirmation reply here (the analyzer can't reliably format the
  //    resolved time) and override Claude's react/reply.
  if (verdict.intent === "reminder_request" && verdict.reminder && user) {
    try {
      const { date, time, note } = verdict.reminder;
      const when = londonDateTimeToUtc(date, time ?? "09:00");
      const now = Date.now();
      const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
      // Must be in the future (with a 60s grace so "remind me in a
      // minute" edge cases don't get silently dropped) and within 60
      // days — anything outside that is almost certainly a parse error,
      // not a real request. Stay silent rather than fire a wrong-day DM.
      if (when.getTime() <= now - 60_000 || when.getTime() > now + SIXTY_DAYS_MS) {
        console.warn(
          `[analyze] reminder out of window for ${user.name}: ${when.toISOString()} (note: ${note})`,
        );
        finalReact = null;
        finalReply = null;
      } else {
        const dbUser = await db.user.findUnique({
          where: { id: user.id },
          select: { phoneNumber: true },
        });
        const phone = dbUser?.phoneNumber?.replace(/^\+/, "") ?? null;
        if (!phone) {
          // No phone on file → can't DM. Tell them in-group rather than
          // silently swallow the request.
          finalReact = "🤔";
          finalReply =
            "I'd love to remind you but I don't have your number on file yet — drop the bot a quick DM first and I'll be able to.";
        } else {
          const first = (user.name ?? "").split(/\s+/)[0] || "there";
          const reminderText =
            `⏰ Reminder, ${first} — you asked me to nudge you:\n\n` +
            `_${note}_\n\n` +
            `(reply in the group when you're ready 👍)`;
          await db.botJob.create({
            data: {
              orgId,
              kind: "dm",
              phone,
              text: reminderText,
              sendAfter: when,
            },
          });
          const whenLabel = formatLondon(
            when,
            time ? "EEE d MMM 'at' HH:mm" : "EEE d MMM",
          );
          finalReact = "⏰";
          finalReply = `👍 Got it ${first} — I'll DM you ${whenLabel}.`;
        }
      }
    } catch (err) {
      console.error("[analyze] reminder_request failed:", err);
      // Bad date/time from the LLM, or DB error — stay silent rather
      // than post a misleading confirmation.
      finalReact = null;
      finalReply = null;
    }
  }

  return { react: finalReact, reply: finalReply };
}

async function recordAnalysis(args: {
  orgId: string;
  groupId: string;
  msg: InboundMessage;
  handledBy: string;
  intent: string | null;
  action: string | null;
  confidence: number | null;
  reasoning: string;
  authorUserId?: string | null;
  /** WhatsApp pushname. Persisted so the admin "unresolved messages"
   *  queue can show WHO ("ba") to link to a player when authorUserId
   *  is null. */
  authorName?: string | null;
}) {
  try {
    await db.analyzedMessage.create({
      data: {
        waMessageId: args.msg.waMessageId,
        orgId: args.orgId,
        groupId: args.groupId,
        authorPhone: args.msg.authorPhone || null,
        authorUserId: args.authorUserId ?? null,
        authorName: args.authorName ?? args.msg.authorName ?? null,
        body: args.msg.body.slice(0, 2000),
        handledBy: args.handledBy,
        intent: args.intent,
        action: args.action,
        confidence: args.confidence,
        reasoning: args.reasoning.slice(0, 2000),
      },
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (!/unique/i.test(m)) {
      console.error("[analyze] recordAnalysis failed:", err);
    }
  }
}

/**
 * Phase 2 onboarding router. Returns a bot response object when this
 * batch belongs to an onboarding flow (active session, or a fresh
 * "@MatchTime setup" trigger in a group with no bot-enabled org), or
 * null to fall through to normal analysis.
 *
 * Trigger is intentionally tight so it can't fire by accident in a
 * live group: must address MatchTime AND say set up / get started.
 */
const SETUP_TRIGGER =
  /(?:@?\s*match\s*time\b[\s\S]{0,40}\b(?:set\s*up|get\s*started|onboard)\b)|(?:\b(?:set\s*up|onboard)\s+match\s*time\b)/i;

async function handleOnboardingIfApplicable(
  body: InboundBody,
): Promise<{ ok: true; results: ActionForBot[] } | null> {
  const groupId = body.groupId;

  let session = await db.onboardingSession.findFirst({
    where: { whatsappGroupId: groupId, stage: { in: ["collecting", "features"] } },
    orderBy: { createdAt: "desc" },
  });

  if (!session) {
    // No active session — only start one on an explicit trigger AND
    // only if this group isn't already a live org (don't hijack a
    // configured group).
    const triggered = body.messages.some((m) => SETUP_TRIGGER.test(m.body || ""));
    if (!triggered) return null;
    const liveOrg = await db.organisation.findFirst({
      where: { whatsappGroupId: groupId, whatsappBotEnabled: true },
      select: { id: true },
    });
    if (liveOrg) return null; // already set up — ignore the trigger
    session = await db.onboardingSession.create({
      data: { whatsappGroupId: groupId, stage: "collecting" },
    });
  }

  // Dedupe: if the last message we already handled is the tail of
  // this batch, a flush re-sent it — stay silent.
  const lastWaId = body.messages[body.messages.length - 1]?.waMessageId ?? null;
  if (lastWaId && session.lastHandledWaId === lastWaId) {
    return { ok: true, results: [] };
  }

  const result = await handleOnboardingTurn({
    session,
    messages: body.messages.map((m) => ({
      waMessageId: m.waMessageId,
      authorName: m.authorName,
      body: m.body,
    })),
  });

  const results: ActionForBot[] = [];
  if (result.reply && lastWaId) {
    results.push({
      waMessageId: lastWaId,
      handledBy: "llm",
      intent: "onboarding",
      react: null,
      reply: result.reply,
    });
  }
  return { ok: true, results };
}
