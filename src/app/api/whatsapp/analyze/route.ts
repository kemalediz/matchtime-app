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
import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { runShadowAnalysis } from "@/lib/window-analyzer";
import { signMagicLinkToken, MAGIC_LINK_TTL } from "@/lib/magic-link";
import { buildShortMagicLinkUrl } from "@/lib/short-link";
import { answerScopedQuestion } from "@/lib/dm-qa";
import {
  analyzeBatch,
  enforceProximity,
  enforceCanonicalRoster,
  rewriteOverconfidentPromotion,
  composeSquadStatusPost,
  looksLikeSquadStateReply,
  type AnalysisVerdict,
  type BatchInputMessage,
} from "@/lib/message-analyzer";
import { resolveBenchConfirmation } from "@/lib/bench-confirmation";
import { getOrgFeatures, type FeatureKey } from "@/lib/org-features";
import { normaliseName } from "@/lib/squad-from-list";
import { handleOnboardingTurn } from "@/lib/onboarding-conversation";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";
import { isPromoteFromBenchAuthorized } from "@/lib/promote-authorization";
import { computeEloDeltas } from "@/lib/elo";
import { resolveTeamLabels } from "@/lib/team-labels";
import { generateTeamsForMatch } from "@/lib/team-generation";
import { londonDateTimeToUtc, formatLondon } from "@/lib/london-time";

interface InboundMessage {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  timestamp: string;
  /** Raw WhatsApp mention JIDs (e.g. "447700900123@c.us", "…@lid"),
   *  forwarded UNCHANGED for the onboarding admin parser. */
  mentions?: string[];
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

  // ── Skip the LLM entirely when no message-driven feature is on ───
  //   MoM + player-rating are post-match / poll / scheduler driven —
  //   they never need per-message analysis. Only attendance, bench,
  //   team-balancing, reminders and stats-Q&A read chat. If none of
  //   those are enabled for this org there is nothing for the
  //   analyzer to do, so we return BEFORE the (now Sonnet, ~3×)
  //   LLM call. Saves ~£10/mo per such group → ~£0. (Onboarding
  //   already returned above when its session is active, so a
  //   mid-setup group still gets handled.)
  //
  //   ALSO: when this org has `featureSquadFromList` on (paste-list
  //   groups like Amir's Thursday — MoM/ratings only, attendance off),
  //   archive each fresh inbound message into GroupMessage so the
  //   squad-extraction cron has data to read. STILL no per-batch LLM
  //   call. The archive write is idempotent on waMessageId (unique).
  {
    const f = await getOrgFeatures(org.id);
    // Squad-from-list orgs ALWAYS archive inbound messages so the
    // squad-extraction cron has raw data to diff — INDEPENDENT of whether
    // the per-batch analyzer also runs below.
    //
    // Regression fix (2026-06-05): this archive used to live inside the
    // `if (!needsAnalyzer)` block. When featureStatsQa was flipped on for
    // every org (commit 3917f00, 29 May), `needsAnalyzer` became always
    // true, so this block stopped running and squad extraction silently
    // broke for squad-from-list groups (Sutton Lads' 4 Jun match
    // registered 0 players → no rating DMs). Archiving must not depend on
    // the analyzer gate.
    //
    // (No inline LLM extraction here — keeps the analyze response fast and
    // never times out. Extraction runs via the daily generate-teams cron
    // backstop plus manual triggers via /api/cron/extract-squads.)
    if (f.squadFromList) {
      await storeMessagesForSquadFromList(org.id, body.groupId, body.messages);
    }
    const needsAnalyzer =
      f.attendance || f.bench || f.teamBalancing || f.reminders || f.statsQa;
    if (!needsAnalyzer) {
      return NextResponse.json({
        ok: true,
        ignored: "no-message-driven-features",
        results: [],
      });
    }
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

  // ── Fast-path: "my stats" / "wrapped" personal-stats request ────────
  //   Deterministic (NO LLM cost — Kemal is cost-conscious about
  //   per-message LLM use). When a resolved sender asks for THEIR OWN
  //   stats, DM them a 48h magic link straight to /profile/stats and
  //   react 📊. Peeled off the batch so the LLM never sees it. Requires
  //   the possessive ("my stats/season/ratings/form/card") or the word
  //   "wrapped" so it never collides with group-level stats questions
  //   ("who's most consistent?") which the LLM still answers from the
  //   Recent History block.
  const STATS_REQUEST = /\bwrapped\b|\bmy\s+(stats|season|ratings?|performance|form|card)\b/i;
  const statsRequestIds = new Set<string>();
  for (const m of fresh) {
    if (!STATS_REQUEST.test(m.body)) continue;
    const sender = senderById.get(m.waMessageId)!;
    const phone = (sender.phone || m.authorPhone || "").replace(/^\+/, "");
    if (!sender.userId || !phone) continue; // can't DM an unresolved sender
    statsRequestIds.add(m.waMessageId);
    try {
      const token = signMagicLinkToken({
        userId: sender.userId,
        purpose: "sign-in",
        nextPath: "/profile/stats",
        ttlSeconds: MAGIC_LINK_TTL.actionNudge,
      });
      const first = sender.name?.split(" ")[0] ?? "there";
      await db.botJob.create({
        data: {
          orgId: org.id,
          kind: "dm",
          phone,
          text:
            `📊 Hey ${first} — here are your MatchTime stats: ratings over time, your ` +
            `Man-of-the-Match games, how you compare to the squad, your badges, and a ` +
            `shareable season card.\n\n${await buildShortMagicLinkUrl(token)}\n\nLink works for 48h.`,
        },
      });
    } catch (err) {
      console.error("[analyze] my-stats DM queue failed:", err);
    }
    await recordAnalysis({
      orgId: org.id,
      groupId: body.groupId,
      msg: m,
      handledBy: "fast-path",
      intent: "stats_link",
      action: "dm-stats-link",
      confidence: 1,
      reasoning: "personal stats request — DM'd a magic link to /profile/stats",
      authorUserId: sender.userId,
      authorName: m.authorName ?? null,
    });
    results.push({
      waMessageId: m.waMessageId,
      handledBy: "fast-path",
      intent: "stats_link",
      react: "📊",
      reply: null,
    });
  }
  // ── Fast-path: admin "DM stats/ratings to active players" ──────────
  //   An ADMIN asking the bot to push everyone their personal stats
  //   link ("@MatchTime DM ratings of active players", "send everyone
  //   their stats"). Each active member with a phone gets a DM with
  //   their OWN never-expiring magic link to /profile/stats. Gated to
  //   OWNER/ADMIN so randoms can't trigger a DM blast. No LLM cost.
  const blastTrigger = (text: string) =>
    /\b(dm|send|share|message)\b/i.test(text) &&
    /\b(stats|ratings?)\b/i.test(text) &&
    /\b(everyone|all|active|players|squad|the team|the group)\b/i.test(text);
  for (const m of fresh) {
    if (statsRequestIds.has(m.waMessageId)) continue; // already handled as personal
    if (!blastTrigger(m.body)) continue;
    const sender = senderById.get(m.waMessageId)!;
    statsRequestIds.add(m.waMessageId); // peel off the LLM batch regardless
    // Admin gate.
    let isAdmin = false;
    if (sender.userId) {
      const mem = await db.membership.findUnique({
        where: { userId_orgId: { userId: sender.userId, orgId: org.id } },
        select: { role: true },
      });
      isAdmin = mem?.role === "OWNER" || mem?.role === "ADMIN";
    }
    if (!isAdmin) {
      results.push({
        waMessageId: m.waMessageId,
        handledBy: "fast-path",
        intent: "stats_blast_denied",
        react: "🔒",
        reply: null,
      });
      await recordAnalysis({
        orgId: org.id, groupId: body.groupId, msg: m,
        handledBy: "fast-path", intent: "stats_blast_denied", action: null,
        confidence: 1, reasoning: "non-admin asked to DM stats to everyone — ignored",
        authorUserId: sender.userId, authorName: m.authorName ?? null,
      });
      continue;
    }
    // Queue a personal stats DM for every active member with a phone.
    const members = await db.membership.findMany({
      where: { orgId: org.id, leftAt: null, user: { phoneNumber: { not: null } } },
      select: { user: { select: { id: true, name: true, phoneNumber: true } } },
    });
    let queued = 0;
    for (const mem of members) {
      const u = mem.user;
      if (!u.phoneNumber) continue;
      try {
        const token = signMagicLinkToken({
          userId: u.id,
          purpose: "sign-in",
          nextPath: "/profile/stats",
          ttlSeconds: MAGIC_LINK_TTL.permanent,
        });
        const first = u.name?.split(" ")[0] ?? "there";
        await db.botJob.create({
          data: {
            orgId: org.id,
            kind: "dm",
            phone: u.phoneNumber.replace(/^\+/, ""),
            text:
              `📊 Hi ${first} — here are your MatchTime stats: your ratings over time, ` +
              `Man-of-the-Match games, how you stack up against the squad, your badges and a ` +
              `shareable season card.\n\n${await buildShortMagicLinkUrl(token)}\n\nKeep this link — it doesn't expire.`,
          },
        });
        queued++;
      } catch (err) {
        console.error(`[analyze] stats-blast DM failed for ${u.id}:`, err);
      }
    }
    await recordAnalysis({
      orgId: org.id, groupId: body.groupId, msg: m,
      handledBy: "fast-path", intent: "stats_blast", action: `dm-stats-blast:${queued}`,
      confidence: 1, reasoning: `admin stats blast — queued ${queued} personal stats-link DMs`,
      authorUserId: sender.userId, authorName: m.authorName ?? null,
    });
    results.push({
      waMessageId: m.waMessageId,
      handledBy: "fast-path",
      intent: "stats_blast",
      react: "✅",
      reply: `📊 Done — DM'd ${queued} player${queued === 1 ? "" : "s"} their personal stats link. They'll arrive over the next few minutes.`,
    });
  }

  // ── Group → DM: "@MT DM me <question>" ──────────────────────────────
  //   When someone in the group explicitly asks to be DM'd an answer
  //   ("dm me the fixtures", "@Match Time message me when's the next
  //   game"), answer them PRIVATELY via the scoped Q&A engine instead
  //   of cluttering the group. Same no-leak guardrails as direct DMs
  //   (dm-qa.ts: only group-public + the asker's own data). React 📩 in
  //   the group so it's clear it was handled. Personal stats requests
  //   are already handled above (they DM a stats link), so skip those.
  const DM_ME = /\b(dm|pm|message)\s+me\b/i;
  for (const m of fresh) {
    if (statsRequestIds.has(m.waMessageId)) continue;
    if (!DM_ME.test(m.body)) continue;
    const sender = senderById.get(m.waMessageId)!;
    const phone = (sender.phone || m.authorPhone || "").replace(/^\+/, "");
    if (!sender.userId || !phone) continue; // can't DM an unresolved sender
    statsRequestIds.add(m.waMessageId); // peel off the LLM batch + drop set
    try {
      const result = await answerScopedQuestion({
        userId: sender.userId,
        orgId: org.id,
        question: m.body,
        askerName: sender.name,
      });
      if (result) {
        await db.botJob.create({
          data: { orgId: org.id, kind: "dm", phone, text: result.answer },
        });
      }
    } catch (err) {
      console.error("[analyze] group→DM Q&A failed:", err);
    }
    await recordAnalysis({
      orgId: org.id, groupId: body.groupId, msg: m,
      handledBy: "fast-path", intent: "dm-qa", action: "dm-scoped-answer",
      confidence: 1, reasoning: "group request to be DM'd — answered privately via scoped Q&A",
      authorUserId: sender.userId, authorName: m.authorName ?? null,
    });
    results.push({
      waMessageId: m.waMessageId,
      handledBy: "fast-path",
      intent: "dm-qa",
      react: "📩",
      reply: null,
    });
  }

  // ── Fast-path: admin "DM recent players to join the next match" ─────
  //   An ADMIN asking the bot to nudge recent attendees who haven't yet
  //   responded to the upcoming match. REAL action (queues invite DMs) —
  //   exists because the LLM was otherwise *claiming* "I'll DM the recent
  //   players" with nothing behind it (Kemal 2026-06-05). Admin-gated.
  const { looksLikeRecruitRequest } = await import("@/lib/recruit");
  for (const m of fresh) {
    if (statsRequestIds.has(m.waMessageId)) continue;
    if (!looksLikeRecruitRequest(m.body)) continue;
    const sender = senderById.get(m.waMessageId)!;
    statsRequestIds.add(m.waMessageId); // peel off the LLM batch regardless
    let isAdmin = false;
    if (sender.userId) {
      const { isOrgAdmin } = await import("@/lib/org");
      isAdmin = await isOrgAdmin(sender.userId, org.id);
    }
    if (!isAdmin) {
      results.push({ waMessageId: m.waMessageId, handledBy: "fast-path", intent: "recruit_denied", react: "🔒", reply: null });
      await recordAnalysis({
        orgId: org.id, groupId: body.groupId, msg: m,
        handledBy: "fast-path", intent: "recruit_denied", action: null,
        confidence: 1, reasoning: "non-admin asked to DM recent players — ignored",
        authorUserId: sender.userId, authorName: m.authorName ?? null,
      });
      continue;
    }
    const { inviteRecentPlayers } = await import("@/lib/recruit");
    const r = await inviteRecentPlayers(org.id);
    const reply = !r.ok
      ? r.reason ?? "Couldn't do that right now."
      : r.invited && r.invited > 0
        ? `📣 On it — DM'd ${r.invited} recent player${r.invited === 1 ? "" : "s"} who hadn't replied, asking them to fill *${r.matchName}*${r.need ? ` (${r.need} spot${r.need === 1 ? "" : "s"} left)` : ""}. I'll add anyone who taps in. 🙏`
        : r.reason
          ? r.reason // full-squad case: no open spots to recruit for.
          : r.alreadyInvited && r.alreadyInvited > 0
            ? // Branch 3: candidates existed but were ALL already pinged on a
              // previous recruit call — they just haven't replied yet.
              `Already pinged the recent players for *${r.matchName}* — just waiting on their replies. 🙏`
            : // Branch 2: genuinely nobody recent left to ask.
              `No new players to ask for *${r.matchName}* right now. 👍`;
    await recordAnalysis({
      orgId: org.id, groupId: body.groupId, msg: m,
      handledBy: "fast-path", intent: "recruit_recent", action: `recruit:${r.invited ?? 0}`,
      confidence: 1, reasoning: `admin recruit — invited ${r.invited ?? 0} recent players`,
      authorUserId: sender.userId, authorName: m.authorName ?? null,
    });
    results.push({ waMessageId: m.waMessageId, handledBy: "fast-path", intent: "recruit_recent", react: "✅", reply });
  }

  // ── Fast-path: admin "how many have rated / who's left / who hasn't
  //    picked MoM?" ────────────────────────────────────────────────────
  //   Grounded rating-completion answer (the analyzer's normal context
  //   has no rating data, so the LLM would otherwise guess). Admin-gated.
  const { looksLikeRatingProgressRequest } = await import("@/lib/rating-progress");
  for (const m of fresh) {
    if (statsRequestIds.has(m.waMessageId)) continue;
    if (!looksLikeRatingProgressRequest(m.body)) continue;
    const sender = senderById.get(m.waMessageId)!;
    statsRequestIds.add(m.waMessageId); // peel off the LLM batch regardless
    let isAdmin = false;
    if (sender.userId) {
      const { isOrgAdmin } = await import("@/lib/org");
      isAdmin = await isOrgAdmin(sender.userId, org.id);
    }
    if (!isAdmin) {
      // Non-admins shouldn't see who-hasn't-rated; stay silent (no react).
      results.push({ waMessageId: m.waMessageId, handledBy: "fast-path", intent: "rating_progress_denied", react: null, reply: null });
      await recordAnalysis({
        orgId: org.id, groupId: body.groupId, msg: m,
        handledBy: "fast-path", intent: "rating_progress_denied", action: null,
        confidence: 1, reasoning: "non-admin asked rating progress — ignored",
        authorUserId: sender.userId, authorName: m.authorName ?? null,
      });
      continue;
    }
    const { loadRatingProgress, formatRatingProgressReply } = await import("@/lib/rating-progress");
    const reply = formatRatingProgressReply(await loadRatingProgress(org.id));
    await recordAnalysis({
      orgId: org.id, groupId: body.groupId, msg: m,
      handledBy: "fast-path", intent: "rating_progress", action: "rating-progress",
      confidence: 1, reasoning: "admin rating-progress query",
      authorUserId: sender.userId, authorName: m.authorName ?? null,
    });
    results.push({ waMessageId: m.waMessageId, handledBy: "fast-path", intent: "rating_progress", react: "📋", reply });
  }

  // Drop stats-requests + blast triggers from the batch the LLM sees.
  for (let i = fresh.length - 1; i >= 0; i--) {
    if (statsRequestIds.has(fresh[i].waMessageId)) fresh.splice(i, 1);
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

  // ── Partial-response safety net (added 2026-05-25, Ibrahim+Baki incident) ──
  // If Claude omits verdicts for some IDs (token-cap, JSON malformation,
  // or just dropping IDs), `analyzeBatch` substitutes an offline placeholder
  // with reasoning="Claude emitted no verdict for this id". The bot silently
  // no-ops those messages. For obvious noise that's fine; for a player drop
  // it's a disaster (the LLM's verdict + reply never happen, the player
  // thinks the bot is broken). We can't tell which from the placeholder
  // alone, so we DM the org's admins with the dropped message bodies and
  // let a human decide. Idempotent — one DM per admin per 1h window.
  {
    // Detect ALL offline-fallback verdicts, not just the
    // "Claude emitted no verdict for this id" placeholder. The
    // analyzeBatch function falls back via `offlineVerdict` for several
    // reasons (model error, SDK rejection, JSON parse failure, missing
    // API key) — all of those should reach the admin so they can act
    // manually. We were narrowly checking ONE reasoning string and
    // missed the "Streaming is required" SDK rejection 2026-05-26,
    // wiping the analyzer for ~30 min before discovery.
    const OFFLINE_REASON_PREFIXES = [
      "Claude emitted no verdict for this id",
      "Claude API error:",
      "No text in Claude response",
      "ANTHROPIC_API_KEY not set",
      "Unknown group",
    ];
    const dropped = verdicts
      .map((v, i) => ({ v, msg: fresh[i] }))
      .filter(({ v }) =>
        OFFLINE_REASON_PREFIXES.some((p) => (v.reasoning ?? "").startsWith(p)),
      );
    if (dropped.length > 0) {
      try {
        const admins = await db.membership.findMany({
          where: { orgId: org.id, role: { in: ["ADMIN", "OWNER"] }, leftAt: null },
          include: { user: { select: { id: true, phoneNumber: true, name: true } } },
        });
        const since = new Date(Date.now() - 60 * 60 * 1000); // 1h dedupe window
        const summary = dropped
          .map(
            ({ msg }) =>
              `• "${(msg.body || "").slice(0, 80)}${(msg.body || "").length > 80 ? "…" : ""}" by ${msg.authorName ?? "?"}`,
          )
          .join("\n");
        const dmText =
          `⚠️ MatchTime: LLM dropped ${dropped.length} message${dropped.length === 1 ? "" : "s"} from the latest analyzer batch for *${org.name}*:\n\n` +
          summary +
          `\n\nThe bot didn't respond to ${dropped.length === 1 ? "it" : "them"} automatically. Check the group and act manually if any were attendance changes.`;
        for (const m of admins) {
          if (!m.user.phoneNumber) continue;
          const phone = m.user.phoneNumber.replace(/^\+/, "");
          const recentlySent = await db.botJob.findFirst({
            where: {
              orgId: org.id,
              kind: "dm",
              phone,
              text: { contains: "LLM dropped" },
              createdAt: { gte: since },
            },
            select: { id: true },
          });
          if (recentlySent) continue; // already DM'd this admin in the last hour
          await db.botJob.create({
            data: { orgId: org.id, kind: "dm", phone, text: dmText },
          });
          console.warn(
            `[analyze] partial-response — DM'd admin ${m.user.name ?? phone} re ${dropped.length} dropped verdict(s) in org ${org.id}`,
          );
        }
      } catch (err) {
        console.error("[analyze] failed to dispatch partial-response admin DM:", err);
      }
    }
  }

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

  const attendanceOn = (await getOrgFeatures(org.id)).attendance;

  // Sender-registration reacts to audit AFTER the whole batch has been
  // applied (see the reaction ↔ status reconciliation pass below). Only
  // verdicts where the react describes the SENDER's own attendance row
  // qualify — third-party registerFor reacts reflect the target's slot.
  const REGISTRATION_STATUS_REACTS = new Set(["✅", "🪑", "👋"]);
  const senderReactAudit: Array<{ idx: number; userId: string }> = [];

  for (let i = 0; i < fresh.length; i++) {
    const msg = fresh[i];
    let verdict = verdicts[i];
    const sender = senderById.get(msg.waMessageId)!;

    // ── Attendance OFF (MoM/ratings-only org, e.g. Sutton Lads): never
    //    track the squad. Drop attendance-class verdicts so the IN/OUT
    //    backfills below can't force a registration, and the bot stays
    //    silent on squad chatter. Stats/MoM/rating replies fall through
    //    untouched. Pairs with ATTENDANCE_OFF_OVERRIDE in the analyzer
    //    prompt (Kemal 2026-06-08: MT was posting "0/14 — need 14
    //    players" to a group that doesn't track attendance).
    if (
      !attendanceOn &&
      (verdict.intent === "in" ||
        verdict.intent === "out" ||
        verdict.intent === "replacement_request")
    ) {
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: "ignored",
        intent: verdict.intent,
        action: null,
        confidence: 1,
        reasoning: "attendance feature off — squad not tracked",
        authorUserId: sender.userId,
        authorName: msg.authorName ?? null,
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "ignored",
        intent: verdict.intent,
        react: null,
        reply: null,
      });
      continue;
    }

    // ── COLOUR SWAP: "swap/switch/flip the colours", "swap red and
    //    yellow" — flip the team labels, keep the exact same player
    //    groupings. Deterministic so it never hits the generate_teams
    //    path (which would rebalance into different teams). Runs before
    //    the player-swap seatbelt and before any LLM verdict is applied.
    {
      const colourResult = await handleColorSwapIfApplicable(org.id, msg.body);
      if (colourResult) {
        await recordAnalysis({
          orgId: org.id,
          groupId: body.groupId,
          msg,
          handledBy: "llm",
          intent: "team_colour_swap",
          action: "colour-swap",
          confidence: 1,
          reasoning: colourResult.logReason,
          authorUserId: sender.userId,
          authorName: msg.authorName ?? null,
        });
        results.push({
          waMessageId: msg.waMessageId,
          handledBy: "llm",
          intent: "team_colour_swap",
          react: "✅",
          reply: colourResult.reply,
        });
        continue; // never reach the generate_teams path
      }
    }

    // ── SEATBELT: "swap A with B" between two CONFIRMED players is a
    //    TEAM swap, never a drop. The LLM's prompt has a forceful
    //    "swap X with Y = X OUT" rule (built for attendance
    //    replacements) that wrongly dropped Elvin 2026-05-19.
    //    Deterministic guard: if the message is a swap/switch of two
    //    people who are BOTH currently confirmed, we swap their teams
    //    (or note it for when teams are generated) and SKIP the LLM
    //    verdict entirely — it cannot drop anyone. A swap where one
    //    side isn't playing is a genuine replacement → fall through.
    {
      const swapResult = await handleTeamSwapIfApplicable(org.id, msg.body);
      if (swapResult) {
        await recordAnalysis({
          orgId: org.id,
          groupId: body.groupId,
          msg,
          handledBy: "llm",
          intent: "team_swap",
          action: "team-swap",
          confidence: 1,
          reasoning: swapResult.logReason,
          authorUserId: sender.userId,
          authorName: msg.authorName ?? null,
        });
        results.push({
          waMessageId: msg.waMessageId,
          handledBy: "llm",
          intent: "team_swap",
          react: "✅",
          reply: swapResult.reply,
        });
        continue; // never reach executeVerdict — no drop possible
      }
    }

    // ── Conditional-drop HOLD ────────────────────────────────────────
    //    The sender offers to leave ONLY IF a replacement materialises
    //    ("happy to drop if you can find someone"). Never auto-drop them.
    //    Deterministic backstop to the prompt rule — double-gated: only
    //    when the verdict already treats this as a drop AND the text is
    //    clearly conditional, and only on the sender's latest message.
    //    (Kemal 2026-06-09: Erdal dropped on "If u can make happy to drop".)
    if (
      sender.userId &&
      (verdict.registerAttendance === "OUT" ||
        verdict.intent === "out" ||
        verdict.intent === "replacement_request") &&
      looksLikeConditionalDrop(msg.body) &&
      latestIdxByAuthor.get(sender.userId) === i
    ) {
      const first = (sender.name ?? "").split(" ")[0] || "you";
      const reply = `Thanks ${first} — noted 🙏 You're still in; if someone needs the spot I'll take you up on it.`;
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: "llm",
        intent: "conditional_out",
        action: "hold",
        confidence: 1,
        reasoning: "conditional drop — held; no replacement confirmed yet",
        authorUserId: sender.userId,
        authorName: msg.authorName ?? null,
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "llm",
        intent: "conditional_out",
        react: "🤝",
        reply,
      });
      continue; // never reach the drop path
    }

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

    // ── OUT intent safety net ────────────────────────────────────────
    //    Mirror of the IN safety net above, for the Mojib/Habib 2026-05-26
    //    failure: LLM classified "replace me and Habib" as
    //    intent:"replacement_request" with reasoning saying "both are
    //    definite drops" — but only emitted registerFor for Habib and
    //    NO registerAttendance for the sender (Mojib). Result: Habib
    //    dropped, Mojib silently stayed in the squad. Same shape as the
    //    Najib IN-skip from 2026-05-08, opposite direction. When intent is
    //    replacement_request and registerAttendance isn't "OUT" (null or
    //    anything else), force OUT for the sender — UNLESS reasoning
    //    explicitly says they're staying in / just running late (the
    //    "type b" cover-request flavour). Server-side, deterministic,
    //    only on the sender's latest message in the batch. Safe because
    //    cancelAttendance is idempotent.
    if (
      verdict.intent === "replacement_request" &&
      verdict.registerAttendance !== "OUT" &&
      sender.userId
    ) {
      const latestIdx = latestIdxByAuthor.get(sender.userId);
      if (latestIdx === i) {
        const r = (verdict.reasoning ?? "").toLowerCase();
        // OLD rule (Mojib fix 2026-05-26): force OUT unless reasoning
        // hedged with "still in / running late". That fired on Kemal
        // 2026-05-28 — "@all we need more players pls" → LLM correctly
        // emitted null with reasoning "tentative/group-level rather than
        // a personal drop, so registerAttendance stays null" → didn't
        // match my regex → wrongly dropped him.
        //
        // NEW rule: only override when reasoning shows a STRONG signal
        // that the sender themselves is dropping. If reasoning shows
        // ANY "I deliberately left this null" signal (hedging, type-b,
        // "stays null", "tentative", "group-level"), respect it.
        // Mojib's case still fires because "definite drop" matches
        // strongDrop and no hedging matches notDropping. Kemal's case
        // no longer fires because "tentative/group-level" matches
        // notDropping.
        const notDropping =
          /\b(still|may still|might still)\s+(in|play|attend|com)/.test(r) ||
          /\b(running late|just late|will be late|be late)\b/.test(r) ||
          /\bstays?\s+null\b/.test(r) ||
          /\b(register\w*\s+(stays?\s+)?null|no\s+register\w*)\b/.test(r) ||
          /\b(tentative|group[-\s]level|not\s+a\s+personal\s+drop)\b/.test(r) ||
          /\b(just\s+(chasing|asking|nudg)|chase\s+nudge|admin\s+(chase|nudg))\b/.test(r) ||
          /\btype\s*\(?b\)?\b/.test(r);
        const strongDrop =
          /\b(definite|definitely)\s+(drop|out)\b/.test(r) ||
          /\b(cannot|can'?t|won'?t|unable\s+to|will\s+not)\s+(make|play|attend|come|be\s+there|join)/.test(r) ||
          /\b(is|am)\s+(definitely\s+)?(dropping|out)\b/.test(r) ||
          /\bsender\s+(is|are)?\s*(dropping|out|gone|leaving|sick|injured|ill|can'?t\s+make)/.test(r);
        if (strongDrop && !notDropping) {
          console.warn(
            `[analyze] LLM emitted intent:"replacement_request" with registerAttendance:${JSON.stringify(verdict.registerAttendance)} for ${sender.name} (${msg.waMessageId}). ` +
              `Reasoning has strong-drop signal AND no opt-out → forcing OUT. Reasoning: ${verdict.reasoning}`,
          );
          verdict = { ...verdict, registerAttendance: "OUT" };
        }
      }
    }

    // ── BENCH-DEMOTE safety net (2026-06-11, Salman Shelly incident) ──
    //    Admin "move X to the bench" must demote a CONFIRMED player to
    //    BENCH and free their slot. The LLM reasons this correctly but has
    //    been seen to misclassify it as the sender's own intent:"in" and
    //    leave registerFor empty — so the move is announced in the reply
    //    ("Salman has moved to the bench") but never written: the player
    //    stays CONFIRMED and the count reads the contradictory "14/14 with
    //    1 slot open". When the reply asserts a named player moved to the
    //    bench but no registerFor BENCH entry exists for them, synthesise
    //    one from the confirmed roster so the demote actually happens.
    //    Conservative: only fires on assertive "<Name> … moved to/benched"
    //    phrasing AND when the name resolves to exactly one CONFIRMED
    //    player (someone already benched/dropped won't match → no-op).
    if (
      verdict.reply &&
      !(verdict.registerFor ?? []).some((e) => e.action === "BENCH")
    ) {
      const m = verdict.reply.match(
        /\b(\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,2})\s+(?:has\s+|have\s+|is\s+|are\s+|’s\s+|'s\s+)?(?:now\s+)?(?:(?:moved|been\s+moved|dropped\s+to|sat)\s*(?:to\s+|on\s+|down\s+to\s+)?(?:the\s+)?bench|benched)\b/u,
      );
      if (m) {
        const matchForOrg = await findRegistrationMatch(org.id);
        if (matchForOrg) {
          const confirmedNow = await db.attendance.findMany({
            where: { matchId: matchForOrg.id, status: "CONFIRMED" },
            include: { user: { select: { id: true, name: true } } },
          });
          const want = normaliseName(m[1]);
          const hits = confirmedNow.filter((a) => {
            const n = normaliseName(a.user.name ?? "");
            if (!n) return false;
            return (
              n === want ||
              n.startsWith(want + " ") ||
              want.startsWith(n + " ") ||
              n.split(" ")[0] === want
            );
          });
          if (hits.length === 1) {
            console.warn(
              `[analyze] bench-demote safety net: reply claims "${m[1]}" → bench but no registerFor BENCH was emitted. ` +
                `Forcing BENCH for ${hits[0].user.name} (${msg.waMessageId}). Reasoning: ${verdict.reasoning}`,
            );
            verdict = {
              ...verdict,
              registerFor: [
                ...(verdict.registerFor ?? []),
                { name: hits[0].user.name ?? m[1], action: "BENCH" },
              ],
            };
          }
        }
      }
    }

    // ── BANTER-DROP guard (2026-06-12, Zeeshan/Sutton Lads incident) ──
    //    A third-party "X is out" must not drop X when X is right there
    //    in the same batch talking — banter, wind-ups and mock votes
    //    ("Zeeshan is out 😂") were misread as real drops while the
    //    target was still protesting. Deterministic rule: a registerFor
    //    OUT for a player who AUTHORED a message in this very batch is
    //    only honoured when (a) the sender is an org admin (real roster
    //    surgery), or (b) the target's own verdict in the batch
    //    corroborates the drop (they said they're out themselves).
    //    Otherwise strip the OUT entry — the player can speak for
    //    themselves — and silence the reply so the bot never announces
    //    a drop it refused to make.
    if (verdict.registerFor?.some((e) => e.action === "OUT")) {
      let senderIsAdmin = false;
      if (sender.userId) {
        const mem = await db.membership.findUnique({
          where: { userId_orgId: { userId: sender.userId, orgId: org.id } },
          select: { role: true },
        });
        senderIsAdmin = mem?.role === "OWNER" || mem?.role === "ADMIN";
      }
      if (!senderIsAdmin) {
        const sameName = (a: string, b: string): boolean => {
          const na = normaliseName(a);
          const nb = normaliseName(b);
          if (!na || !nb) return false;
          return (
            na === nb ||
            na.startsWith(nb + " ") ||
            nb.startsWith(na + " ") ||
            na.split(" ")[0] === nb.split(" ")[0]
          );
        };
        const kept: NonNullable<AnalysisVerdict["registerFor"]> = [];
        const strippedNames: string[] = [];
        for (const entry of verdict.registerFor) {
          if (entry.action !== "OUT") {
            kept.push(entry);
            continue;
          }
          let targetSpokeInBatch = false;
          let targetCorroboratesOut = false;
          for (let j = 0; j < fresh.length; j++) {
            if (j === i) continue;
            const other = senderById.get(fresh[j].waMessageId);
            const otherName = other?.name ?? fresh[j].authorName ?? "";
            if (!otherName || !sameName(otherName, entry.name)) continue;
            targetSpokeInBatch = true;
            const vj = verdicts[j];
            if (vj && (vj.intent === "out" || vj.registerAttendance === "OUT")) {
              targetCorroboratesOut = true;
            }
          }
          if (targetSpokeInBatch && !targetCorroboratesOut) {
            strippedNames.push(entry.name);
          } else {
            kept.push(entry);
          }
        }
        if (strippedNames.length > 0) {
          console.warn(
            `[analyze] banter-drop guard: stripped registerFor OUT for ${strippedNames.join(", ")} — ` +
              `target is active in this batch, sender isn't admin, no self-drop corroboration (${msg.waMessageId}). ` +
              `Reasoning was: ${verdict.reasoning}`,
          );
          verdict = {
            ...verdict,
            registerFor: kept.length > 0 ? kept : null,
            // The reply almost certainly narrates the drop we just
            // refused — posting it would be a lie. Stay silent; if other
            // squad-state replies exist in the batch the consolidated
            // status post below shows the truth anyway.
            reply: null,
            react: verdict.react === "👋" ? null : verdict.react,
          };
        }
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
          where: {
            matchId: nextMatchForReply.id,
            status: { in: ["CONFIRMED", "BENCH"] },
          },
          include: { user: { select: { name: true } } },
          orderBy: { position: "asc" },
        });
        const freshConfirmed = freshAttendances.filter(
          (a) => a.status === "CONFIRMED",
        );
        const freshBench = freshAttendances.filter((a) => a.status === "BENCH");
        cleanReply = enforceProximity(cleanReply, nextMatchForReply.date);
        if (verdict.intent !== "generate_teams_request") {
          cleanReply = enforceCanonicalRoster(cleanReply, {
            confirmed: freshConfirmed.map((a) => a.user.name ?? "(unnamed)"),
            bench: freshBench.map((a) => a.user.name ?? "(unnamed)"),
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
            confirmedCount: freshConfirmed.length,
            maxPlayers: nextMatchForReply.maxPlayers,
            benchCount: freshBench.length,
          });
        }
        // Offer-independent promotion strip: an admin demote never creates a
        // BenchSlotOffer, so the openOffer gate above misses it. Strip any
        // "<benchPlayer> moves up / comes up / steps in / is promoted from the
        // bench" claim whenever that player is STILL on the bench per the fresh
        // snapshot — regardless of any offer.
        if (cleanReply) {
          const before = cleanReply;
          for (const b of freshBench) {
            const name = b.user.name;
            if (!name) continue;
            const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const firstName = name
              .split(" ")[0]
              .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const nameAlt = firstName === esc ? esc : `(?:${esc}|${firstName})`;
            // verb → bench ("X moves up from the bench")
            const promoVerbFirst = new RegExp(
              `[^.!?\\n]*\\b${nameAlt}\\b[^.!?\\n]*\\b(?:moves?\\s+up|comes?\\s+up|steps?\\s+(?:up|in)|is\\s+promoted|promoted)\\b[^.!?\\n]*\\bbench\\b[^.!?\\n]*[.!?]?`,
              "gi",
            );
            // bench → verb ("off the bench, X steps in")
            const promoBenchFirst = new RegExp(
              `[^.!?\\n]*\\bbench\\b[^.!?\\n]*\\b${nameAlt}\\b[^.!?\\n]*\\b(?:moves?\\s+up|comes?\\s+up|steps?\\s+(?:up|in))\\b[^.!?\\n]*[.!?]?`,
              "gi",
            );
            cleanReply = cleanReply
              .replace(promoVerbFirst, "")
              .replace(promoBenchFirst, "");
          }
          // Only re-collapse whitespace if we actually stripped something,
          // to avoid reformatting otherwise-fine replies.
          if (cleanReply !== before) {
            cleanReply = cleanReply
              .replace(/[ \t]+/g, " ")
              .replace(/\n{3,}/g, "\n\n")
              .replace(/^[ \t]+|[ \t]+$/gm, "");
          }
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
          // Never print a raw numeric id as a name in the group (RC4).
          cleanReply = isRawDigitName(pushname)
            ? `Heads up — I got a message to *${verb}* from a number I don't recognise, ` +
              `so I haven't changed anything yet. Could they reply with the name they're ` +
              `registered under, or an admin can link it on the dashboard? 🙏`
            : `Heads up — I got a message to *${verb}* from *${pushname}*, but that name isn't ` +
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
      // Queue this result for the post-batch reaction ↔ status audit
      // when the react claims something about the SENDER's own row.
      if (
        sender.userId &&
        nextMatchForReply &&
        react !== null &&
        REGISTRATION_STATUS_REACTS.has(react) &&
        !(verdict.registerFor && verdict.registerFor.length > 0) &&
        !verdict.benchConfirmation
      ) {
        senderReactAudit.push({ idx: results.length, userId: sender.userId });
      }
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

  // 3a-i. Reaction ↔ persisted-status reconciliation ──────────────────
  //   (Zeeshan 2026-06-12: MT reacted 🪑 to his message but his row
  //   ended DROPPED.) A registration react (✅/🪑/👋) on a sender's own
  //   attendance message is a public claim about their FINAL status —
  //   derive it from the DB after ALL of the batch's writes have
  //   landed, not from whatever the verdict guessed mid-batch.
  if (nextMatchForReply && senderReactAudit.length > 0) {
    try {
      const auditUserIds = [...new Set(senderReactAudit.map((a) => a.userId))];
      const rowsNow = await db.attendance.findMany({
        where: { matchId: nextMatchForReply.id, userId: { in: auditUserIds } },
        select: { userId: true, status: true },
      });
      const statusByUser = new Map(rowsNow.map((r) => [r.userId, r.status]));
      const reactForStatus = (s: string | undefined): string | null =>
        s === "CONFIRMED" ? "✅" : s === "BENCH" ? "🪑" : s === "DROPPED" ? "👋" : null;
      for (const { idx, userId } of senderReactAudit) {
        const want = reactForStatus(statusByUser.get(userId));
        const r = results[idx];
        if (
          want &&
          r.react &&
          REGISTRATION_STATUS_REACTS.has(r.react) &&
          r.react !== want
        ) {
          console.warn(
            `[analyze] react/status reconciliation: ${r.waMessageId} react ${r.react} → ${want} (final attendance row wins)`,
          );
          r.react = want;
        }
      }
    } catch (err) {
      console.error("[analyze] react/status reconciliation failed:", err);
    }
  }

  // 3a-ii. ONE authoritative squad/bench status per batch ─────────────
  //   Root cause of the Sutton Lads 2026-06-12 incident: four
  //   separately-composed squad replies in one batch, each from a
  //   different point-in-time snapshot, contradicting each other
  //   ("14/14 full squad", "one slot open", "bench is empty").
  //   Mirror of the generate_teams_request dedupe: every squad-STATE
  //   reply in the batch collapses into a single deterministic status
  //   post, computed from a FRESH snapshot taken AFTER all attendance
  //   writes. Non-squad replies (stats answers, acks, score, team
  //   posts, opt-out confirmations) pass through untouched.
  if (nextMatchForReply) {
    try {
      const SQUAD_STATE_INTENTS = new Set([
        "in",
        "out",
        "replacement_request",
        "conditional_in",
        "question",
        "unclear",
      ]);
      const squadReplyIdx: number[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r.reply || r.handledBy !== "llm") continue;
        if (!r.intent || !SQUAD_STATE_INTENTS.has(r.intent)) continue;
        if (looksLikeSquadStateReply(r.reply)) squadReplyIdx.push(i);
      }
      if (squadReplyIdx.length > 0) {
        const finalAtt = await db.attendance.findMany({
          where: {
            matchId: nextMatchForReply.id,
            status: { in: ["CONFIRMED", "BENCH"] },
          },
          include: { user: { select: { name: true } } },
          orderBy: { position: "asc" },
        });
        const confirmedNames = finalAtt
          .filter((a) => a.status === "CONFIRMED")
          .map((a) => a.user.name ?? "(unnamed)");
        const benchNames = finalAtt
          .filter((a) => a.status === "BENCH")
          .map((a) => a.user.name ?? "(unnamed)");
        if (squadReplyIdx.length >= 2) {
          // Multiple squad-state replies → collapse to ONE post on the
          // LAST of them (freshest message), everything else silenced.
          const last = squadReplyIdx[squadReplyIdx.length - 1];
          for (const i of squadReplyIdx) {
            if (i !== last) results[i].reply = null;
          }
          results[last].reply = composeSquadStatusPost({
            confirmed: confirmedNames,
            bench: benchNames,
            maxPlayers: nextMatchForReply.maxPlayers,
          });
          console.log(
            `[analyze] collapsed ${squadReplyIdx.length} squad-state replies into one batch-final status post`,
          );
        } else {
          // A single squad-state reply keeps its voice, but is re-
          // canonicalised against the BATCH-FINAL snapshot — the
          // in-loop pass used the state as of that verdict; later
          // writes in the same batch may have changed it (RC1 of the
          // conflicting-posts bug).
          const i = squadReplyIdx[0];
          results[i].reply = enforceCanonicalRoster(results[i].reply!, {
            confirmed: confirmedNames,
            bench: benchNames,
            maxPlayers: nextMatchForReply.maxPlayers,
          });
        }
      }
    } catch (err) {
      console.error("[analyze] squad-status collapse failed:", err);
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

  // ── Shadow window-analyzer ────────────────────────────────────────
  //   Runs AFTER the response is sent — zero added Pi latency.
  //   Persists a WindowVerdict row with a single-diff verdict for the
  //   whole batch so we can compare against the live per-message
  //   verdicts on /admin/shadow. Never writes to attendance; errors
  //   logged and swallowed. Daily cost-capped via SHADOW_DAILY_USD_CAP
  //   (default $5/day). See src/lib/window-analyzer.ts for context.
  if (fresh.length > 0) {
    const shadowBatch = batchInputs;
    const shadowHistory = history;
    const orgId = org.id;
    const groupId = body.groupId;
    after(() =>
      runShadowAnalysis({
        orgId,
        groupId,
        messages: shadowBatch,
        history: shadowHistory,
        currentVerdictIds: shadowBatch.map((m) => m.waMessageId),
      }),
    );
  }

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

/**
 * True when a "name" is really a raw phone number / numeric @lid id
 * ("447700900123", "123456789012@lid", "+44 7700 900123", "@4477…").
 * Never stamp these as display names or print them in group posts —
 * use a neutral placeholder and let an admin rename. (RC4 of the
 * 2026-06-12 Sutton Lads incident: a bare number showed up as a player
 * name in a group post.)
 */
function isRawDigitName(raw: string): boolean {
  const cleaned = raw
    .trim()
    .replace(/@?lid$/i, "")
    .replace(/[@\s+().-]/g, "");
  return /^\d{5,}$/.test(cleaned);
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
  // Never surface a raw numeric id as a display name — downstream
  // replies address the sender by this field.
  const fallbackName =
    msg.authorName && !isRawDigitName(msg.authorName) ? msg.authorName : null;
  return { userId: null, name: fallbackName, phone: null };
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
  const trimmed = rawName?.trim();
  // Never stamp a raw phone number / @lid numeric id as a display name
  // (RC4, 2026-06-12): provision under a neutral placeholder instead
  // and let the admin rename from the dashboard — the membership is
  // flagged provisional either way, and group posts must never show
  // bare digits as a player.
  const name = trimmed && isRawDigitName(trimmed) ? "New player" : trimmed;
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
            // The sender's OWN "IN" — a benched player claiming a free
            // slot must be promoted (Kemal 2026-05-19: Enayem said IN
            // while 13/14, must move to the squad). Third-party
            // registerFor below does NOT pass this.
            promoteFromBench: verdict.registerAttendance === "IN",
          });
          // Simple semantic react: ✅ if they made the squad, 🪑 if
          // they landed on the bench. We used to react with a slot-
          // number keycap (1️⃣–🔟) showing the player's position, but
          // it confused everyone — people read it as a "2 reactions"
          // counter — and the keycaps went stale every time someone
          // dropped/added. Kemal flagged this on 2026-05-05.
          finalReact = result.status === "CONFIRMED" ? "✅" : "🪑";
          // squad-full announcement is fired inside registerAttendance
          // now (covers every confirm path, with the full line-up).
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
      // Resolve the SENDER's org role once — only an OWNER/ADMIN may
      // promote a bench player into the squad via a third-party IN
      // (mirrors the demote gate). Same membership lookup pattern as the
      // OUT banter-guard above.
      let senderIsAdmin = false;
      if (user?.id) {
        const mem = await db.membership.findUnique({
          where: { userId_orgId: { userId: user.id, orgId } },
          select: { role: true },
        });
        senderIsAdmin = mem?.role === "OWNER" || mem?.role === "ADMIN";
      }
      // Pre-resolve every entry's name to a userId up front so the
      // promote-from-bench gate can see the WHOLE pair before we act on
      // any single entry. This is what lets a SELF-REPLACE work: when a
      // non-admin player drops THEMSELVES (OUT) to bring a bench player
      // up (IN) — "replace me with Aydın" — the IN must promote directly
      // (no 👍 step), exactly like an admin's. The gate below treats the
      // sender being one of the OUT targets as authorisation. An
      // UNRELATED non-admin nominating someone else's drop stays
      // unauthorised (no promotion) — that's the third-party guard.
      const resolved = await Promise.all(
        verdict.registerFor.map(async (entry) => ({
          entry,
          target: await resolveOrProvisionByName(orgId, entry.name),
        })),
      );
      const promoteAuthorized = isPromoteFromBenchAuthorized({
        senderUserId: user?.id ?? null,
        senderIsAdmin,
        entries: resolved.map(({ entry, target }) => ({
          action: entry.action,
          userId: target?.userId ?? null,
        })),
      });
      for (const { entry, target } of resolved) {
        try {
          if (!target) continue;
          // Don't double-register the sender if the LLM mistakenly
          // put them in registerFor with an IN/BENCH for themselves.
          // A SELF-REPLACE OUT for the sender is the one case where the
          // sender's own entry IS the action — let it fall through so
          // they actually get dropped (the IN below then fills the slot).
          if (user && target.userId === user.id && entry.action !== "OUT") {
            continue;
          }
          if (entry.action === "IN") {
            // Promotes a bench player straight into the squad when the
            // sender is authorised — either an ADMIN directing roster
            // surgery, OR a player self-replacing (the sender is one of
            // the OUT targets in this same pair). A non-admin promoting
            // an UNRELATED player cannot promote (no options → default
            // idempotent behaviour preserved).
            const result = await registerAttendance(
              target.userId,
              matchForOrg.id,
              promoteAuthorized ? { promoteFromBench: true } : undefined,
            );
            // Same semantic react rule as for the sender — ✅ for a
            // confirmed slot, 🪑 for bench. No more keycap numbers.
            finalReact = result.status === "CONFIRMED" ? "✅" : "🪑";
            // squad-full announcement fired inside registerAttendance.
          } else if (entry.action === "BENCH") {
            // Admin demote (2026-06-11): "move X to the bench". forceBench
            // downgrades a CONFIRMED player to BENCH, keeps their position
            // and frees their slot (squad N→N-1, slot opens). Unlike a
            // drop it does NOT open a BenchSlotOffer, so the player we just
            // benched isn't immediately re-offered the slot they vacated —
            // it just sits open for the admin to fill. Also handles adding
            // a not-yet-registered player straight to the bench.
            await registerAttendance(target.userId, matchForOrg.id, {
              forceBench: true,
            });
            finalReact = "🪑";
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
 * Archive inbound messages for a `featureSquadFromList` org so the
 * squad-extraction cron has raw data to diff. Skipped entirely for
 * other orgs (Sutton etc. don't write here). Idempotent on
 * waMessageId (unique). Body trimmed to 4 KB to be safe in case of
 * gigantic copy-pastes.
 */
async function storeMessagesForSquadFromList(
  orgId: string,
  groupId: string,
  messages: InboundMessage[],
): Promise<void> {
  if (!messages.length) return;
  // Filter empty bodies + the bot's own messages (no authorPhone +
  // no authorName) at the edge so we don't pollute the archive.
  const rows = messages
    .filter((m) => m.body.trim().length > 0)
    .map((m) => ({
      orgId,
      waChatId: groupId,
      waMessageId: m.waMessageId,
      senderPhone: m.authorPhone || null,
      senderPushname: m.authorName || null,
      body: m.body.slice(0, 4000),
      timestamp: new Date(m.timestamp),
    }));
  if (!rows.length) return;
  try {
    await db.groupMessage.createMany({ data: rows, skipDuplicates: true });
  } catch (err) {
    // Don't break the analyze response on archive failure — the
    // squad-extraction cron will try again next time the same messages
    // re-arrive (we already dedupe on waMessageId).
    console.error("[analyze] storeMessagesForSquadFromList failed:", err);
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
    // "introduced"/"details" are the Phase 1 group-add stages
    // (2026-06-12 design); they only ever exist when the flag-gated
    // /api/whatsapp/bot-added route created them, so this is inert for
    // every group that never went through a bot-add.
    where: {
      whatsappGroupId: groupId,
      stage: { in: ["collecting", "features", "introduced", "admins", "details"] },
    },
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
      // Sender identity — used by the group-add flow to capture the
      // consenting admin (design fix: this used to be dropped, so the
      // flow COULDN'T assign an owner even if it wanted to).
      authorPhone: m.authorPhone ?? null,
      // Raw WhatsApp mention JIDs, forwarded UNCHANGED from the bot. The
      // `admins` stage's parseAdmins() resolves "<digits>@c.us" → phone
      // and treats "<digits>@lid" as a privacy id (no phone).
      mentions: m.mentions,
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

/**
 * SEATBELT (2026-05-19): "swap A with B" / "switch A and B" where
 * BOTH are currently CONFIRMED is a TEAM swap — never a drop. We
 * resolve it deterministically from DB state and bypass the LLM
 * verdict so the "swap = X OUT" prompt rule can't fire.
 *
 * Returns:
 *   { reply, logReason }  → handled (caller skips executeVerdict)
 *   null                  → not a both-confirmed swap; let normal
 *                           flow handle it (a genuine replacement
 *                           where one side isn't playing is still a
 *                           legit attendance swap).
 */
/**
 * Deterministic backstop for conditional drops ("happy to drop if you can
 * find someone", "step aside if Enayem can play"). Returns true only when
 * the text has a drop/step-aside cue AND a conditional clause — an
 * unconditional drop ("I'm out", "can't make it") has no `if` and returns
 * false. Used to HOLD a drop the LLM would otherwise execute, so a player
 * offering to leave only IF replaced is never auto-dropped (Kemal
 * 2026-06-09: Erdal dropped on "If u can make happy to drop"). Pairs with
 * the prompt rule; double-gated in the caller (only fires when the verdict
 * already treats the message as a drop).
 */
function looksLikeConditionalDrop(body: string): boolean {
  const t = (body || "").toLowerCase();
  const dropCue =
    /\b(drop|step aside|stand aside|give (up )?(my )?(spot|place|slot)|make way|pull me|sit (this )?out)\b/.test(t) ||
    /\bhappy to (drop|step|sit|give)/.test(t);
  if (!dropCue) return false;
  return /\bif\b/.test(t); // contingent → not a definite drop
}

async function handleTeamSwapIfApplicable(
  orgId: string,
  rawBody: string,
): Promise<{ reply: string; logReason: string } | null> {
  const body = (rawBody || "").trim();
  // "swap A with B", "swap A and B", "switch A B", "swap A for B",
  // "swap A & B", "swap A, B". Names = letter runs (first names).
  const m = body.match(
    /\b(?:swap|switch)\s+([\p{L}'-]{2,})\s*(?:with|and|for|&|,|<->|>|\/)?\s*([\p{L}'-]{2,})/iu,
  );
  if (!m) return null;
  const n1 = m[1].toLowerCase();
  const n2 = m[2].toLowerCase();
  if (n1 === n2) return null;
  // Ignore obvious non-name tokens.
  const STOP = new Set(["the", "them", "him", "her", "with", "and", "for", "team", "teams", "side", "sides", "please", "pls"]);
  if (STOP.has(n1) || STOP.has(n2)) return null;

  const match = await db.match.findFirst({
    where: {
      activity: { orgId },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    include: {
      activity: {
        include: {
          sport: { select: { teamLabels: true } },
          org: { select: { teamLabels: true } },
        },
      },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { id: true, name: true } } },
      },
      teamAssignments: true,
    },
  });
  if (!match) return null;

  const norm = (s: string) =>
    s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const find = (q: string) => {
    const qq = norm(q);
    const cands = match.attendances.filter((a) => {
      if (!a.user.name) return false;
      const nm = norm(a.user.name);
      const first = nm.split(/\s+/)[0] ?? "";
      return nm === qq || first === qq || nm.startsWith(qq) || first.startsWith(qq);
    });
    return cands.length === 1 ? cands[0] : null;
  };
  const A = find(n1);
  const B = find(n2);
  // Both must resolve uniquely AND both be CONFIRMED for this to be a
  // TEAM swap. Otherwise it's not our case (could be a genuine
  // replacement, or ambiguous) — fall through to normal handling.
  if (!A || !B || A.user.id === B.user.id) return null;

  const labels = resolveTeamLabels(match.activity.org, match.activity.sport);
  const taA = match.teamAssignments.find((t) => t.userId === A.user.id);
  const taB = match.teamAssignments.find((t) => t.userId === B.user.id);

  if (!taA && !taB) {
    // Teams not generated yet — nothing to swap, but make ABSOLUTELY
    // sure nobody is dropped. Acknowledge + defer.
    return {
      reply:
        `Both *${A.user.name}* and *${B.user.name}* are already in — nobody's dropped. ` +
        `Teams aren't generated yet; say *generate teams* and I'll build them (then I can put them on opposite sides).`,
      logReason: `team-swap deferred (no teams yet): ${A.user.name} <-> ${B.user.name}`,
    };
  }

  // Swap their team sides (handle the one-sided edge defensively).
  const teamA = taA?.team ?? (taB?.team === "RED" ? "YELLOW" : "RED");
  const teamB = taB?.team ?? (taA?.team === "RED" ? "YELLOW" : "RED");
  await db.$transaction([
    db.teamAssignment.upsert({
      where: { matchId_userId: { matchId: match.id, userId: A.user.id } },
      create: { matchId: match.id, userId: A.user.id, team: teamB },
      update: { team: teamB },
    }),
    db.teamAssignment.upsert({
      where: { matchId_userId: { matchId: match.id, userId: B.user.id } },
      create: { matchId: match.id, userId: B.user.id, team: teamA },
      update: { team: teamA },
    }),
  ]);

  const fresh = await db.teamAssignment.findMany({
    where: { matchId: match.id },
    include: { user: { select: { name: true } } },
  });
  const red = fresh.filter((t) => t.team === "RED").map((t) => t.user.name);
  const yel = fresh.filter((t) => t.team === "YELLOW").map((t) => t.user.name);
  return {
    reply:
      `🔁 Swapped *${A.user.name}* and *${B.user.name}* — nobody dropped. Updated teams:\n\n` +
      `*${labels[0]}*\n${red.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n` +
      `*${labels[1]}*\n${yel.map((n, i) => `${i + 1}. ${n}`).join("\n")}`,
    logReason: `team-swap applied: ${A.user.name} <-> ${B.user.name}`,
  };
}

/**
 * "swap/switch/flip the colours", "swap colors", "swap red and yellow" —
 * a request to flip the team LABELS while keeping the exact same player
 * groupings. Deterministic guard so it NEVER reaches the LLM's
 * generate_teams_request path, which rebalances into different teams
 * (Kemal 2026-06-09: "swap the colours and keep the same teams" ran a
 * full regen and produced different teams the night of a match). Returns
 * null when it isn't a colour swap or no teams exist yet — caller falls
 * through to normal handling.
 */
async function handleColorSwapIfApplicable(
  orgId: string,
  rawBody: string,
): Promise<{ reply: string; logReason: string } | null> {
  const body = (rawBody || "").trim();

  // Fast path: "swap/flip the colours" or "swap red and yellow" need no DB
  // lookup — the literal colour words / "colours" keyword are enough.
  const hasSwapVerb = /\b(swap|switch|flip|reverse|invert|change)\b/i.test(body);
  let isColourSwap =
    /\b(swap|switch|flip|reverse|invert|change)\b[\s\S]{0,40}\bcolou?rs?\b/i.test(body) ||
    /\bcolou?rs?\b[\s\S]{0,40}\b(swap|switch|flip|reverse|invert|change)\b/i.test(body) ||
    /\bswap\b[\s\S]{0,25}\b(red|yellow|reds|yellows)\b[\s\S]{0,25}\b(red|yellow|reds|yellows)\b/i.test(body);

  // Cheap pre-gate before touching the DB: only orgs with a swap verb in
  // the message can possibly be a "swap <labelA> and <labelB>" — anything
  // without a swap verb can't be a colour swap at all.
  if (!isColourSwap && !hasSwapVerb) return null;

  const match = await db.match.findFirst({
    where: {
      activity: { orgId },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    include: {
      activity: {
        include: {
          sport: { select: { teamLabels: true } },
          org: { select: { teamLabels: true } },
        },
      },
      teamAssignments: { include: { user: { select: { name: true } } } },
    },
  });
  // No teams generated yet → nothing to flip; let normal handling decide.
  if (!match || match.teamAssignments.length === 0) return null;

  // Custom-label aware detection: if not already a literal red/yellow or
  // "colours" swap, recognise "swap <labelA> and <labelB>" using THIS org's
  // configured team labels (resolved from Organisation/Sport.teamLabels).
  // Red/Yellow stay covered by the regexes above as a fallback.
  if (!isColourSwap) {
    const cfgLabels = resolveTeamLabels(match.activity.org, match.activity.sport);
    const labelAlts = cfgLabels
      .map((l) => l.trim())
      .filter((l) => l && !/^(red|yellow)$/i.test(l))
      .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (labelAlts.length === 2) {
      const alt = `(?:${labelAlts.join("|")})`;
      const labelSwap = new RegExp(
        `\\bswap\\b[\\s\\S]{0,25}${alt}[\\s\\S]{0,25}${alt}`,
        "i",
      );
      if (labelSwap.test(body)) isColourSwap = true;
    }
    if (!isColourSwap) return null;
  }

  // Flip every assignment RED<->YELLOW in one transaction — same rosters,
  // labels swapped. No rebalance, no LLM.
  await db.$transaction(
    match.teamAssignments.map((t) =>
      db.teamAssignment.update({
        where: { id: t.id },
        data: { team: t.team === "RED" ? "YELLOW" : "RED" },
      }),
    ),
  );

  const labels = resolveTeamLabels(match.activity.org, match.activity.sport);
  const fresh = await db.teamAssignment.findMany({
    where: { matchId: match.id },
    include: { user: { select: { name: true } } },
  });
  const red = fresh.filter((t) => t.team === "RED").map((t) => t.user.name);
  const yel = fresh.filter((t) => t.team === "YELLOW").map((t) => t.user.name);
  return {
    reply:
      `🎨 Swapped the colours — same teams, sides flipped:\n\n` +
      `*${labels[0]}*\n${red.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n` +
      `*${labels[1]}*\n${yel.map((n, i) => `${i + 1}. ${n}`).join("\n")}`,
    logReason: `colour-swap applied (labels flipped, rosters unchanged)`,
  };
}
