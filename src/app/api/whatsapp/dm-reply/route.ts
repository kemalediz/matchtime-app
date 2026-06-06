/**
 * Bot forwards every incoming 1-1 DM here. The server figures out
 * what to do with it. Today: the only DM-reply behaviour that exists
 * is the roster check-in survey. Future expansions (DM-based score
 * entry, DM-based attendance, etc.) live alongside that.
 *
 * Flow for roster surveys:
 *   1. Resolve sender phone → User.
 *   2. Find any open RosterSurvey for any of the user's orgs that
 *      has a matching RosterSurveyDM row (i.e. they actually got
 *      DM'd a check-in question).
 *   3. Classify the reply via Claude (in / maybe / out / unclear).
 *   4. If clear → upsert RosterSurveyResponse + queue a confirmation
 *      DM via BotJob.
 *      If unclear → no response stored; queue a clarification DM
 *      that re-anchors the question on the survey.
 *   5. Return 200 either way (we always ACK so the bot doesn't
 *      retry).
 *
 * If no active survey applies, the DM is silently ignored.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { classifyRosterReply } from "@/lib/roster-survey-classifier";
import { resolveBenchConfirmation } from "@/lib/bench-confirmation";
import { answerScopedQuestion, pickRelevantOrgForUser, looksLikeQuestion } from "@/lib/dm-qa";
import { handleCollectorFeeReply } from "@/lib/payment-flow";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { phone, body: text, waMessageId, authorName } = body as {
    phone?: string;
    body?: string;
    waMessageId?: string;
    authorName?: string;
  };
  if (!text || !waMessageId) {
    return NextResponse.json({ error: "body, waMessageId required" }, { status: 400 });
  }

  // ── Bench-confirmation DM reply ──────────────────────────────────
  //   Added 2026-05-18 (Kemal): when a slot opens we now DM the
  //   bencher as well as tagging them in the group, because benchers
  //   mute/skip the group thinking they're not playing. The DM asks
  //   for a TEXT reply (YES/NO) — handle it here, BEFORE the roster
  //   logic, with its own sender resolution scoped to users who
  //   actually have an open PendingBenchConfirmation. The in-group
  //   👍/👎 reaction path still works in parallel; resolveBenchConfirmation
  //   is idempotent so a double-answer (DM + reaction) is safe.
  {
    // Candidate set = bench players of any match with an OPEN offer.
    const openOffers = await db.benchSlotOffer.findMany({
      where: { resolvedAt: null },
      select: { matchId: true },
    });
    if (openOffers.length > 0) {
      const matchIds = [...new Set(openOffers.map((o) => o.matchId))];
      const benchAtt = await db.attendance.findMany({
        where: { matchId: { in: matchIds }, status: "BENCH" },
        select: {
          matchId: true,
          user: { select: { id: true, name: true, phoneNumber: true } },
        },
      });
      let claimant: { id: string; matchId: string } | null = null;

      // 1. Phone match within the bench set.
      if (!claimant && phone && phone.trim().length > 0) {
        const n = normalisePhone(phone);
        if (n) {
          const hit = benchAtt.find(
            (a) => a.user.phoneNumber && normalisePhone(a.user.phoneNumber) === n,
          );
          if (hit) claimant = { id: hit.user.id, matchId: hit.matchId };
        }
      }
      // 2. @lid pushname, uniquely matched within the bench set.
      if (!claimant && authorName && authorName.trim().length >= 2) {
        const nm = (s: string) =>
          s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
        const pn = nm(authorName);
        const pf = pn.split(/\s+/).filter(Boolean)[0] ?? "";
        const eq = benchAtt.filter((a) => a.user.name && nm(a.user.name) === pn);
        let pick = eq.length === 1 ? eq[0] : null;
        if (!pick) {
          const fz = benchAtt.filter((a) => {
            if (!a.user.name) return false;
            const df = nm(a.user.name).split(/\s+/).filter(Boolean)[0] ?? "";
            return (
              df === pf ||
              (df.length >= 3 && pf.length >= 2 && df.startsWith(pf)) ||
              (pf.length >= 3 && df.length >= 2 && pf.startsWith(df))
            );
          });
          if (fz.length === 1) pick = fz[0];
        }
        if (pick) claimant = { id: pick.user.id, matchId: pick.matchId };
      }

      if (claimant) {
        const t = text.trim().toLowerCase();
        const isYes =
          /^(y|yes+|yep|yeah|ya|sure|ok(ay)?|in|i'?m in|am in|confirm(ed)?|can do|deal|done|grab|i'?ll take|take it|👍|✅|✔️?|🙋)\b/.test(t) ||
          t === "👍" || t === "✅" || t === "🙋";
        const isNo =
          /^(n|no+|nope|nah|can'?t|cannot|cant|pass|sorry|out|not me|next time|unable|👎)\b/.test(t) ||
          t === "👎";

        const matchOrg = await db.match.findUnique({
          where: { id: claimant.matchId },
          select: { activity: { select: { orgId: true } } },
        });
        const orgId = matchOrg?.activity.orgId ?? null;
        const phoneNoPlus = phone ? normalisePhone(phone)?.replace(/^\+/, "") ?? null : null;

        if (!isYes && !isNo) {
          // One gentle clarification (this is a single reply to one
          // inbound DM — NOT a loop; no spam risk).
          if (orgId && phoneNoPlus) {
            await db.botJob.create({
              data: {
                orgId,
                kind: "dm",
                phone: phoneNoPlus,
                text:
                  `Want the open slot for tonight? Reply *YES* to grab it. ` +
                  `If not, no worries — you stay on the bench either way 🙏`,
              },
            });
          }
          return NextResponse.json({ ok: true, handled: "bench-dm-unclear" });
        }

        const result = await resolveBenchConfirmation({
          matchId: claimant.matchId,
          userId: claimant.id,
          decision: isYes,
        });
        // Personal DM ack (group announcement is posted by the lib).
        if (orgId && phoneNoPlus) {
          let ack: string;
          if (!isYes) {
            ack = `👍 No worries — you're still on the bench, nothing changes.`;
          } else if (result.kind === "confirmed") {
            ack = `✅ You got it — you're in for tonight! ⚽`;
          } else if (result.kind === "ignored") {
            ack = `Ah — someone just grabbed that one first. You're still first in line on the bench if another opens 🙏`;
          } else {
            ack = `👍 Got it.`;
          }
          await db.botJob.create({
            data: { orgId, kind: "dm", phone: phoneNoPlus, text: ack },
          });
        }
        return NextResponse.json({
          ok: true,
          handled: "bench-dm",
          decision: isYes ? "yes" : "no",
          result: result.kind,
        });
      }
    }
  }

  // Try phone first (most accurate). Falls through to pushname-based
  // resolution when phone is empty or doesn't match any User —
  // happens when WhatsApp's @lid privacy mode hides the sender's
  // real phone from the chat ID.
  let user: {
    id: string;
    name: string | null;
    memberships: { orgId: string }[];
  } | null = null;

  if (phone && phone.trim().length > 0) {
    const normalised = normalisePhone(phone);
    if (normalised) {
      user = await db.user.findUnique({
        where: { phoneNumber: normalised },
        select: { id: true, name: true, memberships: { select: { orgId: true } } },
      });
    }
  }

  if (!user && authorName && authorName.trim().length >= 2) {
    // Pushname can sometimes be the user's WhatsApp-display phone
    // ("+44 7887 275188") rather than a real name. If it parses as
    // a phone, try the phone path before falling through to name
    // fuzzy-matching.
    const digitsOnly = authorName.replace(/[^\d]/g, "");
    if (digitsOnly.length >= 10) {
      const normalised = normalisePhone(`+${digitsOnly}`);
      if (normalised) {
        const phoneUser = await db.user.findUnique({
          where: { phoneNumber: normalised },
          select: { id: true, name: true, memberships: { select: { orgId: true } } },
        });
        if (phoneUser) user = phoneUser;
      }
    }
  }

  if (!user && authorName && authorName.trim().length >= 2) {
    // Pushname-based fallback. Scope to users who currently have an
    // OPEN RosterSurveyDM so we're not guessing across the whole
    // user base. Three layered strategies, each decisive only when
    // exactly one candidate matches:
    //   1. Exact normalized equality
    //   2. Substring containment in either direction (so "Mehmet Unal
    //      Sutton Football" pushname resolves to DB "Mehmet Unal", and
    //      DB "Aykut Arsoy" resolves to pushname "Aykut Arsoy Sutton
    //      Football"). Requires ≥ 2 tokens on the matching side so
    //      one-word names don't latch onto every pushname.
    //   3. First-name fuzzy with relaxed prefix.
    const norm = (s: string) =>
      s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const pushNorm = norm(authorName);
    const pushFirst = pushNorm.split(/\s+/).filter(Boolean)[0] ?? "";

    const candidates = await db.rosterSurveyDM.findMany({
      where: { survey: { status: "open" } },
      include: { user: { select: { id: true, name: true, memberships: { select: { orgId: true } } } } },
    });

    const equals = candidates.filter(
      (c) => c.user.name && norm(c.user.name) === pushNorm,
    );
    let pick = equals.length === 1 ? equals[0] : null;
    if (!pick) {
      const bySubstring = candidates.filter((c) => {
        if (!c.user.name) return false;
        const dbNorm = norm(c.user.name);
        const dbTokens = dbNorm.split(/\s+/).filter(Boolean).length;
        const pushTokens = pushNorm.split(/\s+/).filter(Boolean).length;
        if (dbTokens >= 2 && pushNorm.includes(dbNorm)) return true;
        if (pushTokens >= 2 && dbNorm.includes(pushNorm)) return true;
        return false;
      });
      if (bySubstring.length === 1) pick = bySubstring[0];
    }
    if (!pick) {
      const byFirst = candidates.filter((c) => {
        if (!c.user.name) return false;
        const dbFirst = norm(c.user.name).split(/\s+/).filter(Boolean)[0] ?? "";
        return (
          dbFirst === pushFirst ||
          (dbFirst.length >= 3 && pushFirst.length >= 2 && dbFirst.startsWith(pushFirst)) ||
          (pushFirst.length >= 3 && dbFirst.length >= 2 && pushFirst.startsWith(dbFirst))
        );
      });
      if (byFirst.length === 1) pick = byFirst[0];
    }
    if (pick) {
      user = pick.user;
    }
  }

  if (!user) {
    return NextResponse.json({ ok: true, ignored: "unknown-sender" });
  }

  // ── Money-collector fee capture (2026-06-04) ────────────────────────
  //   If this sender is a money collector for a payment-collecting org
  //   with a just-played match awaiting its fee, their DM ("£8 each" /
  //   "✅") sets/confirms the fee and releases the per-player pay links.
  //   Takes priority over survey/Q&A so the amount isn't misread as a
  //   check-in answer or a question. Returns null when it's not a fee
  //   interaction → falls through unchanged.
  {
    const feeResult = await handleCollectorFeeReply(user.id, text);
    if (feeResult) {
      const phoneNoPlus = phone ? normalisePhone(phone)?.replace(/^\+/, "") ?? null : null;
      const u = await db.user.findUnique({
        where: { id: user.id },
        select: { phoneNumber: true },
      });
      const replyPhone = phoneNoPlus ?? u?.phoneNumber?.replace(/^\+/, "") ?? null;
      const orgId = await db.organisation.findFirst({
        where: { paymentHolderId: user.id, paymentCollectionEnabled: true },
        select: { id: true },
      });
      if (replyPhone && orgId) {
        await db.botJob.create({
          data: { orgId: orgId.id, kind: "dm", phone: replyPhone, text: feeResult.reply },
        });
      }
      return NextResponse.json({ ok: true, handled: "collector-fee", released: feeResult.released });
    }
  }

  // ── Admin recruit via DM (2026-06-05) ───────────────────────────────
  //   An org admin can DM MatchTime "DM recent players to join the next
  //   match" (instead of posting in the group) and it fires the same
  //   invite blast. Gated to OWNER/ADMIN (or superadmin) of an org with
  //   an upcoming match. Replies privately with the outcome.
  {
    const { looksLikeRecruitRequest } = await import("@/lib/recruit");
    if (looksLikeRecruitRequest(text)) {
      const { isSuperadmin } = await import("@/lib/org");
      const su = await isSuperadmin(user.id);
      const adminMems = await db.membership.findMany({
        where: {
          userId: user.id,
          leftAt: null,
          ...(su ? {} : { role: { in: ["OWNER", "ADMIN"] } }),
        },
        select: { orgId: true },
      });
      if (adminMems.length > 0) {
        const startToday = new Date();
        startToday.setUTCHours(0, 0, 0, 0);
        const cand = await db.match.findFirst({
          where: {
            activity: { orgId: { in: adminMems.map((m) => m.orgId) } },
            isHistorical: false,
            status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
            date: { gte: startToday },
          },
          orderBy: { date: "asc" },
          select: { activity: { select: { orgId: true } } },
        });
        if (cand) {
          const { inviteRecentPlayers } = await import("@/lib/recruit");
          const r = await inviteRecentPlayers(cand.activity.orgId);
          const reply = !r.ok
            ? r.reason ?? "Couldn't do that right now."
            : r.invited && r.invited > 0
              ? `📣 Done — DM'd ${r.invited} recent player${r.invited === 1 ? "" : "s"} who hadn't replied, asking them to fill *${r.matchName}* on ${r.matchWhen}${r.need ? ` (${r.need} spot${r.need === 1 ? "" : "s"} left)` : ""}. I'll add anyone who taps in. 🙏`
              : `Everyone who played recently has already responded to *${r.matchName}* — nobody new to invite. 👍`;
          const phoneNoPlus = phone ? normalisePhone(phone)?.replace(/^\+/, "") ?? null : null;
          const u = await db.user.findUnique({ where: { id: user.id }, select: { phoneNumber: true } });
          const replyPhone = phoneNoPlus ?? u?.phoneNumber?.replace(/^\+/, "") ?? null;
          if (replyPhone) {
            await db.botJob.create({
              data: { orgId: cand.activity.orgId, kind: "dm", phone: replyPhone, text: reply },
            });
          }
          return NextResponse.json({ ok: true, handled: "recruit-dm", invited: r.invited ?? 0 });
        }
      }
      // Not an admin of any org with an upcoming match → fall through.
    }
  }

  // ── Admin rating-progress via DM (2026-06-06) ───────────────────────
  //   "how many have rated / who's left / who hasn't picked MoM?" —
  //   grounded answer for the org's last completed match. Admin-gated.
  {
    const { looksLikeRatingProgressRequest } = await import("@/lib/rating-progress");
    if (looksLikeRatingProgressRequest(text)) {
      const { isSuperadmin } = await import("@/lib/org");
      const su = await isSuperadmin(user.id);
      const adminMems = await db.membership.findMany({
        where: { userId: user.id, leftAt: null, ...(su ? {} : { role: { in: ["OWNER", "ADMIN"] } }) },
        select: { orgId: true },
      });
      if (adminMems.length > 0) {
        // The org whose most-recently-played match is the freshest.
        const cand = await db.match.findFirst({
          where: { activity: { orgId: { in: adminMems.map((m) => m.orgId) } }, isHistorical: false, status: "COMPLETED" },
          orderBy: { date: "desc" },
          select: { activity: { select: { orgId: true } } },
        });
        if (cand) {
          const { loadRatingProgress, formatRatingProgressReply } = await import("@/lib/rating-progress");
          const reply = formatRatingProgressReply(await loadRatingProgress(cand.activity.orgId));
          const phoneNoPlus = phone ? normalisePhone(phone)?.replace(/^\+/, "") ?? null : null;
          const u = await db.user.findUnique({ where: { id: user.id }, select: { phoneNumber: true } });
          const replyPhone = phoneNoPlus ?? u?.phoneNumber?.replace(/^\+/, "") ?? null;
          if (replyPhone) {
            await db.botJob.create({ data: { orgId: cand.activity.orgId, kind: "dm", phone: replyPhone, text: reply } });
          }
          return NextResponse.json({ ok: true, handled: "rating-progress-dm" });
        }
      }
      // Not an admin / no completed match → fall through.
    }
  }

  // Find an active RosterSurveyDM for this user. There SHOULD be at
  // most one open survey per (user, org) at a time. If multiple
  // exist, pick the most recent.
  // Stale-survey guard: a roster check-in only owns DM replies for a
  // bounded window. A survey left "open" for weeks (Kemal 2026-05-19:
  // two surveys from late April were still capturing every DM and
  // spamming clarifications a month later) must NOT keep hijacking
  // DMs. 14 days is well past any real check-in.
  const SURVEY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  const dm = await db.rosterSurveyDM.findFirst({
    where: {
      userId: user.id,
      survey: {
        status: "open",
        createdAt: { gte: new Date(Date.now() - SURVEY_MAX_AGE_MS) },
      },
    },
    include: {
      survey: { include: { org: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!dm) {
    // ── Scoped Q&A (2026-06-01) ──────────────────────────────────────
    //   No open survey to answer → if this resolved member is asking a
    //   question, treat it as a private match Q&A. Strictly scoped to
    //   their group's football (see dm-qa.ts — the LLM only ever sees
    //   safe, group-public data + the asker's own stats, never contact
    //   details or other groups). Reply via a DM BotJob the Pi sends.
    if (looksLikeQuestion(text)) {
      const phoneNoPlus = phone ? normalisePhone(phone)?.replace(/^\+/, "") ?? null : null;
      // Fall back to the user's stored phone for @lid senders.
      const u = await db.user.findUnique({ where: { id: user.id }, select: { phoneNumber: true } });
      const replyPhone = phoneNoPlus ?? u?.phoneNumber?.replace(/^\+/, "") ?? null;
      const orgId = await pickRelevantOrgForUser(user.id);
      if (!orgId || !replyPhone) {
        return NextResponse.json({ ok: true, ignored: "qa-no-org-or-phone" });
      }
      // Per-user abuse/cost cap: max 10 outbound DMs to this phone in the
      // last rolling hour (covers QA + any other DM). Bounds LLM spend
      // and stops a runaway back-and-forth.
      const recentDms = await db.botJob.count({
        where: {
          orgId,
          kind: "dm",
          phone: replyPhone,
          createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
      });
      if (recentDms >= 10) {
        return NextResponse.json({ ok: true, ignored: "qa-rate-limited" });
      }
      const result = await answerScopedQuestion({
        userId: user.id,
        orgId,
        question: text,
        askerName: user.name,
      });
      if (result) {
        await db.botJob.create({
          data: { orgId, kind: "dm", phone: replyPhone, text: result.answer },
        });
        return NextResponse.json({ ok: true, handled: "dm-qa" });
      }
    }
    return NextResponse.json({ ok: true, ignored: "no-open-survey" });
  }

  const classification = await classifyRosterReply(text, {
    playerName: user.name,
    clubName: dm.survey.org.name,
  });

  const firstName = user.name?.split(/\s+/)[0] ?? "mate";
  // Resolve a phone for the outbound confirmation/clarification DM.
  // Prefer the User's stored phoneNumber (canonical) over whatever
  // came in on the request — the request may have been an @lid DM
  // with no phone at all. If the user has no phone on file we just
  // can't DM them back; we still save the response and return.
  const userPhone = await db.user.findUnique({
    where: { id: user.id },
    select: { phoneNumber: true },
  });
  const phoneNoPlus = userPhone?.phoneNumber?.replace(/^\+/, "") ?? null;

  if (classification.category === "unclear") {
    // ONE clarification per person per survey — full stop. The old
    // code re-sent it on EVERY unclear reply with no cap, so an
    // annoyed "are you stupid" / "I already replied" each triggered
    // another identical DM → the spiral Kemal saw 2026-05-19
    // (6+ identical DMs, player threatening the bot). After the first
    // clarification we go silent; admins read raw replies on the
    // dashboard anyway, so nothing is lost.
    const priorClarif = await db.botJob.count({
      where: {
        orgId: dm.survey.org.id,
        phone: phoneNoPlus ?? "__none__",
        text: { startsWith: `Sorry ${firstName} — wasn't sure if that was a reply to the roster check-in` },
      },
    });
    if (priorClarif > 0) {
      // Already clarified once — stay silent. Don't feed the loop.
      return NextResponse.json({
        ok: true,
        action: "clarification-suppressed-already-sent",
        classification,
      });
    }
    const clarification = [
      `Sorry ${firstName} — wasn't sure if that was a reply to the roster check-in for *${dm.survey.org.name}*.`,
      ``,
      `Was your answer:`,
      `• yes / I'm in`,
      `• maybe / sometimes`,
      `• not for now / out`,
      ``,
      `Quick word back is enough — otherwise no worries, an admin will sort it 🙏`,
    ].join("\n");
    if (phoneNoPlus) {
      await db.botJob.create({
        data: {
          orgId: dm.survey.org.id,
          kind: "dm",
          phone: phoneNoPlus,
          text: clarification,
        },
      });
    } else {
      console.warn(
        `[dm-reply] no phone on file for user ${user.id}; clarification not sent`,
      );
    }
    return NextResponse.json({
      ok: true,
      action: "clarification-sent",
      classification,
    });
  }

  // Save (or upsert — latest reply wins, but admin overrides stick).
  // Don't overwrite a response the admin manually set.
  const existing = await db.rosterSurveyResponse.findUnique({
    where: { surveyId_userId: { surveyId: dm.surveyId, userId: user.id } },
  });
  if (existing?.adminOverride) {
    return NextResponse.json({
      ok: true,
      ignored: "admin-override-locked",
      classification,
    });
  }
  // Idempotency gate for the confirmation DM: only queue an outbound
  // DM if this is a NEW response or if the classification CHANGED
  // since last time. Re-replays of an already-recorded reply (e.g.
  // the recovery walk re-forwarding the same message) shouldn't
  // double-DM the player.
  const isNewOrChanged =
    !existing || existing.response !== classification.category;

  await db.rosterSurveyResponse.upsert({
    where: { surveyId_userId: { surveyId: dm.surveyId, userId: user.id } },
    create: {
      surveyId: dm.surveyId,
      userId: user.id,
      response: classification.category,
      rawReply: text,
    },
    update: {
      response: classification.category,
      rawReply: text,
      classifiedAt: new Date(),
    },
  });

  // Confirmation DM. Tone matches what we drafted with Kemal.
  let confirmation: string;
  if (classification.category === "in") {
    confirmation = `Got it ${firstName}, marked you as in 👍 — thanks!`;
  } else if (classification.category === "maybe") {
    confirmation = `Got it ${firstName}, marked you as maybe 👍 — just say *IN* in the group whenever you want to play that week, no need to confirm in advance.`;
  } else {
    // "out"
    confirmation = `No worries ${firstName}, noted you're stepping back. The admins will tidy up the roster at the end of the week. If you change your mind before then, just message back here 🙏`;
  }
  if (!isNewOrChanged) {
    return NextResponse.json({
      ok: true,
      action: "recorded-no-redm",
      category: classification.category,
      confidence: classification.confidence,
    });
  }
  if (phoneNoPlus) {
    await db.botJob.create({
      data: {
        orgId: dm.survey.org.id,
        kind: "dm",
        phone: phoneNoPlus,
        text: confirmation,
      },
    });
  } else {
    console.warn(
      `[dm-reply] no phone on file for user ${user.id}; confirmation not sent (response saved)`,
    );
  }

  return NextResponse.json({
    ok: true,
    action: "recorded",
    category: classification.category,
    confidence: classification.confidence,
  });
}
