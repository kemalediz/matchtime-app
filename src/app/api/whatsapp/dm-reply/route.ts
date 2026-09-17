/**
 * Bot forwards every incoming 1-1 DM here. The server figures out
 * what to do with it.
 *
 * HANDLER ORDER IS THE CONTRACT. The most SPECIFIC pending prompt wins,
 * and the general fallback runs last:
 *
 *   1. bench-slot offer reply           (an open BenchSlotOffer)
 *   2. DM subscription command          ("stop messaging me about ratings")
 *   3. tentative-availability follow-up (an open TentativeAvailability)
 *   4. money-collector fee reply        (a match awaiting its fee)
 *   5. admin recruit blast / rating progress  (admin-gated, and
 *      MODEL-classified since 2026-09-11 — the two regexes that
 *      used to select it are deleted; see lib/dm-intent.ts)
 *   6. roster check-in survey           (an open RosterSurveyDM)
 *   7. COLD self-attendance fallback    (2026-08-31 — a player replying
 *      "IN"/"OUT" to a recruit DM with nothing more specific to attribute
 *      it to; registers against the active match)
 *   8. scoped Q&A, else ignore
 *
 * Adding a handler means slotting it by SPECIFICITY, never in front of a
 * prompt that knows which question is being answered.
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
import { setDmSubscriptions } from "@/lib/notification-prefs";
import {
  parseDmSubscriptionCommand,
  dmSubPatchForCommand,
  dmSubAckMessage,
} from "@/lib/dm-subscriptions";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";
import { resolveTentative } from "@/lib/tentative-store";
import { buildTentativeFollowupAck } from "@/lib/tentative-followup";
import { classifyMatchAvailability } from "@/lib/match-availability-classifier";
import { resolveDmSelfAttendance } from "@/lib/dm-self-attendance";
import { findDmRegistrationTarget } from "@/lib/dm-registration-target";
import { announceOutOfBandAttendance } from "@/lib/out-of-band-announce";
import { applyOutOfBandSelfAttendance } from "@/lib/out-of-band-self-attendance";
import { dayCommaTimeLabel } from "@/lib/i18n/dates";
import { LANGS } from "@/lib/i18n/lang";
import { readBenchDmReply, readTentativeFastPath } from "@/lib/dm-reply-words";
import {
  buildAdminRecruitDmReply,
  buildBenchDmAck,
  buildBenchDmUnclear,
  buildRosterSurveyClarification,
  buildRosterSurveyConfirmation,
  buildTentativeReask,
  rosterSurveyClarificationProbe,
} from "@/lib/dm-copy";

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
        // The offered match's org decides the language: of the reply we
        // read (`readBenchDmReply`) and of the DM we send back.
        const matchOrg = await db.match.findUnique({
          where: { id: claimant.matchId },
          select: { activity: { select: { orgId: true, org: { select: { language: true } } } } },
        });
        const orgId = matchOrg?.activity.orgId ?? null;
        const benchLang = matchOrg?.activity.org.language;
        const benchReply = readBenchDmReply(text, benchLang);
        const isYes = benchReply === "yes";
        const isNo = benchReply === "no";
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
                text: buildBenchDmUnclear(benchLang),
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
          const ack = buildBenchDmAck(
            !isYes
              ? "declined"
              : result.kind === "confirmed"
                ? "confirmed"
                : result.kind === "ignored"
                  ? "taken"
                  : "other",
            benchLang,
          );
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

  // REMOVED 2026-08-31 — the @lid "pushname matches a money collector"
  // fallback. It resolved an otherwise-UNKNOWN DM sender to the org's
  // money collector on a first-name pushname match, and pushname is
  // attacker-controlled: anyone who knows the bot's number could set
  // their WhatsApp display name to the collector's first name, DM an
  // amount, confirm it, and blast a pay link at the whole squad for a fee
  // they chose. Sutton's collector is "Kemal" — a single common first
  // name — so the bar was that low.
  //
  // Nothing may promote an unverified sender to fee-setting authority.
  // `Organisation.paymentHolderId` stays the source of truth for WHO the
  // collector is (handleCollectorFeeReply already scopes on it); what was
  // broken was WHO WE THINK IS TEXTING. Identity must come from the
  // phone number, which the bot recovers for @lid DMs via `Contact.number`
  // (whatsapp-bot fix, 2026-06-09). If that ever regresses, collector fee
  // DMs go unanswered — loudly, in the log below — rather than being
  // answerable by a stranger.

  if (!user) {
    if (authorName && authorName.trim().length >= 2) {
      console.warn(
        `[dm-reply] unresolved sender (no phone match) pushname="${authorName}" — ignoring. ` +
          `If this is a real member, the bot failed to forward their number (Contact.number).`,
      );
    }
    return NextResponse.json({ ok: true, ignored: "unknown-sender" });
  }

  // ── DM subscription-preference fast-path (2026-06-11; per-category
  //    2026-07-17) ──────────────────────────────────────────────────────
  //   A player can text the bot to opt out of proactive DMs — either a
  //   single category ("stop messaging me about ratings") or everything
  //   except payment ("do not message me on any topic but payment", "only
  //   payment please"). Payment DMs have NO flag and are never silenced.
  //   Deterministic keyword match (parser in lib/dm-subscriptions.ts), run
  //   BEFORE the collector-fee and Q&A branches so it can't be swallowed:
  //   the Q&A fallthrough only composes prose and writes nothing, which is
  //   exactly the gap that once let a player keep getting DMs after asking
  //   us to stop.
  //
  //   GOLDEN RULE: only ack AFTER the DB write succeeds. If the write
  //   touched 0 rows / threw, we do NOT claim they're unsubscribed — fall
  //   through silently rather than lie.
  {
    // Any active org the player belongs to works as the BotJob owner (the
    // DM is addressed by phone). Its language is the language the command
    // is read in (English words are always read) and the ack is written in.
    const subMem = await db.membership.findFirst({
      where: { userId: user.id, leftAt: null },
      select: { orgId: true, org: { select: { language: true } } },
    });
    const subLang = subMem?.org.language;
    const cmd = parseDmSubscriptionCommand(text ?? "", subLang);
    if (cmd) {
      let written = false;
      try {
        const res = await setDmSubscriptions(user.id, dmSubPatchForCommand(cmd));
        written = res.count > 0;
      } catch (err) {
        console.error("[dm-reply] setDmSubscriptions failed:", err);
      }

      if (written) {
        const phoneNoPlus = phone ? normalisePhone(phone)?.replace(/^\+/, "") ?? null : null;
        const u = await db.user.findUnique({
          where: { id: user.id },
          select: { phoneNumber: true },
        });
        const replyPhone = phoneNoPlus ?? u?.phoneNumber?.replace(/^\+/, "") ?? null;
        if (replyPhone && subMem) {
          await db.botJob.create({
            data: { orgId: subMem.orgId, kind: "dm", phone: replyPhone, text: dmSubAckMessage(cmd, subLang) },
          });
        }
        return NextResponse.json({ ok: true, handled: "dm-subscription", cmd });
      }
      // Write didn't land — don't lie. Fall through to normal handling.
    }
  }

  // ── Tentative-availability follow-up reply (IN/OUT) ─────────────────
  //   The bot DMs a player who was a MAYBE ~24h before kickoff asking for
  //   a firm IN/OUT. Their reply lands here. If they have an OPEN
  //   (unresolved) tentative row, classify IN/OUT, write attendance via
  //   the same lib the group path uses (against the deterministic active
  //   match), and resolve the tentative so no duplicate follow-ups fire.
  //   Runs BEFORE fee/recruit/survey so a firm "IN"/"OUT" isn't misread.
  {
    const openTentatives = await db.tentativeAvailability.findMany({
      where: { userId: user.id, resolvedAt: null },
      include: {
        match: {
          select: {
            id: true,
            date: true,
            status: true,
            activity: { select: { orgId: true, org: { select: { language: true } } } },
          },
        },
      },
    });
    // Only chase-able matches (not completed/cancelled), soonest first.
    const active = openTentatives
      .filter(
        (t) =>
          t.match.status === "UPCOMING" ||
          t.match.status === "TEAMS_GENERATED" ||
          t.match.status === "TEAMS_PUBLISHED",
      )
      .sort((a, b) => a.match.date.getTime() - b.match.date.getTime());

    if (active.length > 0) {
      // The soonest match's org decides the language of the fast path and
      // of every DM below (the follow-up was written in it).
      const tentLang = active[0].match.activity.org.language;
      // Cheap, instant FAST-PATH for the unambiguous replies. Free, so we
      // use it — but it is NOT the decision (2026-08-31). A player who
      // answers "yeah go on then" or "can't tomorrow sorry" is not
      // ambiguous, they just didn't type a keyword; anything this misses
      // now goes to the LLM below instead of triggering a re-ask.
      const fast = readTentativeFastPath(text ?? "", tentLang);
      let isIn = fast === "in";
      let isOut = fast === "out";

      if (!isIn && !isOut) {
        const row0 = active[0];
        const org0 = await db.organisation.findUnique({
          where: { id: row0.match.activity.orgId },
          select: { name: true },
        });
        const verdict = await classifyMatchAvailability(text ?? "", {
          playerName: user.name,
          clubName: org0?.name ?? null,
          matchWhen: dayCommaTimeLabel(tentLang, row0.match.date),
          // The bot DM'd this player asking for a firm IN/OUT, so a bare
          // "yes"/"👍" here genuinely IS an answer.
          wasAskedToPlay: true,
        });
        if (verdict.decision === "in") isIn = true;
        else if (verdict.decision === "out") isOut = true;
      }

      // Genuinely unclear reply → one gentle re-ask, scoped to the soonest match.
      if (!isIn && !isOut) {
        const row = active[0];
        const replyPhone = (await db.user.findUnique({
          where: { id: user.id },
          select: { phoneNumber: true },
        }))?.phoneNumber?.replace(/^\+/, "") ?? null;
        if (replyPhone) {
          await db.botJob.create({
            data: {
              orgId: row.match.activity.orgId,
              kind: "dm",
              phone: replyPhone,
              text: buildTentativeReask(tentLang),
            },
          });
        }
        return NextResponse.json({ ok: true, handled: "tentative-followup-unclear" });
      }

      const row = active[0];
      // Capture the PRIOR state so the group announcement below can tell a
      // real change from an idempotent repeat.
      const priorRow = await db.attendance.findUnique({
        where: { matchId_userId: { matchId: row.match.id, userId: user.id } },
        select: { status: true },
      });
      const priorStatus =
        priorRow?.status === "CONFIRMED" || priorRow?.status === "BENCH" || priorRow?.status === "DROPPED"
          ? priorRow.status
          : null;
      let newStatus: "CONFIRMED" | "BENCH" | "DROPPED" | null = null;
      // The honest-ack rule: a write that THREW must never be acked as if
      // it landed. Only a genuine exception counts: an OUT from a player
      // with no row is a legitimate no-op, not a failure.
      let writeFailed = false;
      try {
        if (isIn) {
          const res = await registerAttendance(user.id, row.match.id, {
            promoteFromBench: true,
            // Answering the tentative follow-up DM. Their own claim,
            // out of band — the group never saw it, which is why
            // announceOutOfBandAttendance runs below.
            event: {
              cause: "self-attendance",
              actorKind: "player",
              actorUserId: user.id,
              sourceRef: "dm:tentative-followup",
            },
          });
          newStatus = res.status === "BENCH" ? "BENCH" : "CONFIRMED";
        } else {
          // Only cancel if they actually have a CONFIRMED/BENCH row —
          // a tentative player usually has none, in which case OUT is a
          // no-op (cancelAttendance throws "Not attending" otherwise).
          if (priorStatus === "CONFIRMED" || priorStatus === "BENCH") {
            await cancelAttendance(user.id, row.match.id, {
              cause: "self-attendance",
              actorKind: "player",
              actorUserId: user.id,
              sourceRef: "dm:tentative-followup",
            });
            newStatus = "DROPPED";
          }
        }
      } catch (err) {
        writeFailed = true;
        console.error("[dm-reply] tentative IN/OUT attendance write failed:", err);
      }
      // Tell the GROUP — this registration happened out of band, so nobody
      // else can see it. No-op repeats and rate-capped bursts are filtered
      // inside the announcer.
      await announceOutOfBandAttendance({
        matchId: row.match.id,
        userId: user.id,
        before: priorStatus,
        after: newStatus,
        source: "dm",
      }).catch((err) => console.error("[dm-reply] tentative group announce failed:", err));
      await resolveTentative({ matchId: row.match.id, userId: user.id }).catch(() => {});

      const replyPhone = (await db.user.findUnique({
        where: { id: user.id },
        select: { phoneNumber: true },
      }))?.phoneNumber?.replace(/^\+/, "") ?? null;
      if (replyPhone) {
        await db.botJob.create({
          data: {
            orgId: row.match.activity.orgId,
            kind: "dm",
            phone: replyPhone,
            text: buildTentativeFollowupAck({
              decision: isIn ? "in" : "out",
              failed: writeFailed,
              lang: tentLang,
            }),
          },
        });
      }
      return NextResponse.json({
        ok: true,
        handled: "tentative-followup",
        decision: isIn ? "in" : "out",
        status: newStatus,
        failed: writeFailed,
      });
    }
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

  // ── ADMIN COMMANDS BY DM — ONE MODEL CALL, TWO ACTIONS ─────────────
  //
  //   ⚰️ WHAT WAS HERE UNTIL 2026-09-11: two regexes, one per handler.
  //
  //     looksLikeRecruitRequest         a recruit verb ADJACENT to a
  //                                     people noun, OR a shortage
  //                                     phrase — with `inviteRecentPlayers`
  //                                     behind it, a mass DM to 13-27
  //                                     real people.
  //     looksLikeRatingProgressRequest  (a rating word) AND (a progress
  //                                     word), anywhere in the body.
  //
  //   The first one's own doc comment said what it was: deprecated for
  //   group messages since 2026-09-01, when it matched the SECOND
  //   sentence of "Najib is out. We need one more player.", the fast
  //   path peeled the whole message off the batch, the third-party OUT
  //   was never analysed, and MatchTime told the owner his squad was
  //   full one line after he said a player was out. It kept ONE caller,
  //   this one, "the next conversion, not this PR's". This is that
  //   conversion, and both regexes are now deleted outright.
  //
  //   On 2026-09-10 the same family — three keyword tests ANDed — read
  //   an owner's reminder to his players as a bulk-DM command and queued
  //   69 personal stats-link DMs. `recruit-lookback.ts` names the stake:
  //   the bot runs on an UNOFFICIAL WhatsApp client, and a mass DM risks
  //   the account, which takes the whole product down.
  //
  //   ── THE REPLACEMENT IS `lib/stats-blast.ts`'s SPLIT ──────────────
  //   The model says only "this looks like the ask". Every gate and the
  //   action stay in code: the admin/superadmin membership lookup, the
  //   upcoming-match and completed-match lookups, the blast itself and
  //   the words describing it. A classifier that fails — no key, an
  //   overload, unparseable output, an intent outside the enum, a
  //   confidence below the floor — yields `other`, which DMs nobody.
  //
  //   ── PLACEMENT IS UNCHANGED, AND THE MODEL CALL IS NOT PAID FOR ON
  //      EVERY DM. Still fifth, behind every handler that knows WHICH
  //      question is being answered (bench offer, subscription command,
  //      tentative follow-up, collector fee) and ahead of the roster
  //      survey, the cold self-attendance fallback and scoped Q&A. And
  //      `adminOrgIds` runs BEFORE the classifier: a club has one or two
  //      admins and dozens of players, so the overwhelming majority of
  //      DMs reach the model never.
  //
  //      WHAT THAT COSTS, STATED: those two indexed reads (the
  //      superadmin flag and the memberships) now run on every DM that
  //      gets this far, where before they ran only behind a regex
  //      match. Two primary-key lookups against a DM volume of a few a
  //      day, in exchange for never testing a mass-DM trigger with a
  //      pattern again. See `lib/dm-intent.ts`.
  {
    const { classifyDmIntent, runDmAdminIntent } = await import("@/lib/dm-intent");
    const phoneNoPlus = phone ? normalisePhone(phone)?.replace(/^\+/, "") ?? null : null;
    const outcome = await runDmAdminIntent({
      adminOrgIds: async () => {
        const { isSuperadmin } = await import("@/lib/org");
        const su = await isSuperadmin(user.id);
        const mems = await db.membership.findMany({
          where: {
            userId: user.id,
            leftAt: null,
            ...(su ? {} : { role: { in: ["OWNER", "ADMIN"] } }),
          },
          select: { orgId: true },
        });
        return mems.map((mem) => mem.orgId);
      },
      classify: async () =>
        (await classifyDmIntent(text, { senderName: authorName ?? null })).intent,
      orgWithUpcomingMatch: async (orgIds) => {
        const startToday = new Date();
        startToday.setUTCHours(0, 0, 0, 0);
        const cand = await db.match.findFirst({
          where: {
            activity: { orgId: { in: orgIds } },
            isHistorical: false,
            status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
            date: { gte: startToday },
          },
          orderBy: { date: "asc" },
          select: { activity: { select: { orgId: true } } },
        });
        return cand?.activity.orgId ?? null;
      },
      // The org whose most-recently-played match is the freshest.
      orgWithCompletedMatch: async (orgIds) => {
        const cand = await db.match.findFirst({
          where: { activity: { orgId: { in: orgIds } }, isHistorical: false, status: "COMPLETED" },
          orderBy: { date: "desc" },
          select: { activity: { select: { orgId: true } } },
        });
        return cand?.activity.orgId ?? null;
      },
      invite: async (orgId) => {
        const { inviteRecentPlayers } = await import("@/lib/recruit");
        const r = await inviteRecentPlayers(orgId);
        // Composed from what ACTUALLY landed, never from what was asked
        // for — the same rule the group blast follows. A `reason` on an
        // ok result means the CAPACITY GUARD stopped the blast (the
        // bench invitation or the "already full" refusal, decided in
        // `recruit.ts`); the group reply and this one are two renderings
        // of ONE RecruitResult and must not disagree about the squad.
        // In the language of the org the blast was for.
        const { getOrgFeatures } = await import("@/lib/org-features");
        const reply = buildAdminRecruitDmReply(r, (await getOrgFeatures(orgId)).language);
        return { reply, invited: r.invited ?? 0 };
      },
      ratingProgress: async (orgId) => {
        const { loadRatingProgress, formatRatingProgressReply } = await import(
          "@/lib/rating-progress"
        );
        return formatRatingProgressReply(await loadRatingProgress(orgId));
      },
      reply: async ({ orgId, text: replyText }) => {
        const u = await db.user.findUnique({
          where: { id: user.id },
          select: { phoneNumber: true },
        });
        const replyPhone = phoneNoPlus ?? u?.phoneNumber?.replace(/^\+/, "") ?? null;
        if (!replyPhone) return;
        await db.botJob.create({
          data: { orgId, kind: "dm", phone: replyPhone, text: replyText },
        });
      },
    });
    if (outcome.handled === "recruit-dm") {
      return NextResponse.json({ ok: true, handled: "recruit-dm", invited: outcome.invited });
    }
    if (outcome.handled === "rating-progress-dm") {
      return NextResponse.json({ ok: true, handled: "rating-progress-dm" });
    }
    // Not an admin, not one of the two asks, or nothing to act on →
    // fall through, exactly as an unmatched regex did.
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
      survey: { include: { org: { select: { id: true, name: true, language: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
  // ── COLD self-attendance fallback (2026-08-31) ──────────────────────
  //   THE GAP THIS CLOSES: the recruit blast DMs a player about the next
  //   match. Plenty of players — especially the older, less technical
  //   half of a club — reply "IN" to the DM and consider themselves
  //   signed up. (The invite now explicitly asks for exactly that; see
  //   buildRecruitInviteDm.) That reply matched none of the
  //   specific pending prompts above, so it was silently dropped: the
  //   player believed they had a spot and NOTHING was recorded. Same
  //   silent-failure class as the duplicate-send incident.
  //
  //   PLACEMENT IS LOAD-BEARING. Every more-specific handler runs FIRST
  //   and still wins outright: bench offer, DM subscription command,
  //   tentative follow-up, collector fee, admin recruit, admin rating
  //   progress, and the roster survey (`dm`, resolved just above and
  //   passed in as `hasPendingPrompt`). Those know WHICH question is
  //   being answered; this fallback does not, so it goes last.
  //
  //   INTERACTION CONTRACT: a DM to MatchTime is inherently directed at
  //   the bot, so no "@Match Time" tag is required. The contract only
  //   gates GROUP messages, and even there a player's OWN self-attendance
  //   is the one tag-free action class (isSelfAttendanceVerdict /
  //   actionRequiresTag in lib/interaction-contract.ts). This handles
  //   exactly that class: the sender's own in/out, never a third party.
  //
  //   DM SUBSCRIPTIONS ARE DELIBERATELY *NOT* CONSULTED HERE. The sub*
  //   flags govern PROACTIVE DMs (the invite blast, bench offers, rating
  //   nudges). This is a REPLY to a message the player just sent us. A
  //   player who muted match invites and then messages "IN" must still be
  //   registered and must still be told it worked — silently ignoring a
  //   human who addressed us directly is precisely the lie the
  //   subscription feature was built to stop (lib/dm-subscriptions.ts).
  {
    // Only worth asking the model when there is actually something to
    // register against: an active match on an attendance-tracking org,
    // chosen by the SAME selector the group path uses.
    const target = !dm ? await findDmRegistrationTarget(user.id) : null;
    if (target) {
      // Did we DM this player about this very match? Unlocks bare
      // affirmatives ("yes", "👍") for the classifier — see rule 5 there.
      const invited = await db.sentNotification.findUnique({
        where: { key: `${target.matchId}:recruit-dm:${user.id}` },
        select: { id: true },
      });
      const resolution = await resolveDmSelfAttendance({
        text,
        hasPendingPrompt: !!dm,
        context: {
          playerName: user.name,
          clubName: target.clubName,
          matchName: target.matchName,
          matchWhen: target.matchWhen,
          wasAskedToPlay: !!invited,
        },
      });

      if (resolution.decision) {
        // The write + personal ack + group announcement all live in
        // lib/out-of-band-self-attendance.ts, shared verbatim with the
        // 👍-on-the-invite reaction path (api/whatsapp/reaction). One
        // implementation, so capacity rules, the honest-ack golden rule
        // and the group line can never drift between the two.
        const replyPhone =
          (phone ? normalisePhone(phone)?.replace(/^\+/, "") ?? null : null) ??
          (
            await db.user.findUnique({
              where: { id: user.id },
              select: { phoneNumber: true },
            })
          )?.phoneNumber?.replace(/^\+/, "") ??
          null;

        const applied = await applyOutOfBandSelfAttendance({
          userId: user.id,
          matchId: target.matchId,
          orgId: target.orgId,
          decision: resolution.decision,
          matchName: target.matchName,
          matchWhen: target.matchWhen,
          // The match's org language, resolved with the target.
          lang: target.lang,
          source: "dm",
          replyPhone,
        });

        return NextResponse.json({
          ok: true,
          handled: "dm-self-attendance",
          decision: resolution.decision,
          via: resolution.via,
          status: applied.status,
          matchId: target.matchId,
        });
      }
    }
  }

  if (!dm) {
    // ── Scoped Q&A (2026-06-01) ──────────────────────────────────────
    //   No open survey to answer → if this resolved member is asking a
    //   question, treat it as a private match Q&A. Strictly scoped to
    //   their group's football (see dm-qa.ts — the LLM only ever sees
    //   safe, group-public data + the asker's own stats, never contact
    //   details or other groups). Reply via a DM BotJob the Pi sends.
    // The org the question is about decides the language the gate reads
    // (a Turkish question has no "?" often enough to matter).
    const qaOrgId = await pickRelevantOrgForUser(user.id);
    const qaLang = qaOrgId
      ? (await db.organisation.findUnique({ where: { id: qaOrgId }, select: { language: true } }))?.language
      : null;
    if (looksLikeQuestion(text, qaLang)) {
      const phoneNoPlus = phone ? normalisePhone(phone)?.replace(/^\+/, "") ?? null : null;
      // Fall back to the user's stored phone for @lid senders.
      const u = await db.user.findUnique({ where: { id: user.id }, select: { phoneNumber: true } });
      const replyPhone = phoneNoPlus ?? u?.phoneNumber?.replace(/^\+/, "") ?? null;
      const orgId = qaOrgId;
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
      // Admin gate for the 📵 phone-presence flags (data-quality
      // question "who has no number on record?"). Only OWNER/ADMIN of
      // the resolved org (or a superadmin) gets the flags in their
      // context; non-admins get the existing flag-free context, so
      // there is literally nothing for them to extract. Mirrors the
      // recruit-DM / rating-progress-DM admin-resolution pattern above.
      const { isSuperadmin } = await import("@/lib/org");
      const su = await isSuperadmin(user.id);
      const includePhoneFlags =
        su ||
        (await db.membership.count({
          where: { userId: user.id, orgId, leftAt: null, role: { in: ["OWNER", "ADMIN"] } },
        })) > 0;
      const result = await answerScopedQuestion({
        userId: user.id,
        orgId,
        question: text,
        askerName: user.name,
        includePhoneFlags,
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
    lang: dm.survey.org.language,
  });

  // The survey's org decides the language of both replies below.
  const surveyLang = dm.survey.org.language;
  // Null when there is no name: each language says its own thing instead.
  const firstName = user.name?.split(/\s+/)[0] ?? null;
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
        // Either language's opening counts: a clarification sent before
        // the org's language changed must still suppress the next one.
        OR: LANGS.map((l) => ({ text: { startsWith: rosterSurveyClarificationProbe(firstName, l) } })),
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
    const clarification = buildRosterSurveyClarification({
      firstName,
      orgName: dm.survey.org.name,
      lang: surveyLang,
    });
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
  const confirmation = buildRosterSurveyConfirmation({
    category: classification.category,
    firstName,
    lang: surveyLang,
  });
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
