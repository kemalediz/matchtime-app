/**
 * STAGE 3 — THE DECISION ENGINE.
 *
 * `(facts, squad state, actor, org features) → decisions`. Pure: no I/O,
 * no model, no clock (the caller injects `now`). This is where the 36%
 * of the 18,315-token prompt that §3.2 categorises as **B** — "a
 * decision that should be deterministic code" — goes to live, and it is
 * exhaustively unit tested in `__tests__/engine.test.ts`, one describe
 * block per incident.
 *
 * WHAT IT MUST NEVER DO
 * ---------------------
 *   • trust a fact. §11.3: structured output guarantees SHAPE, never
 *     SEMANTICS. Every field is treated as untrusted and the engine
 *     asserts its own invariants (capacity, authorisation, identity,
 *     ordering) on top.
 *   • lose a message. Exactly one `MessageOutcome` per input id, always
 *     — §3.2 S1's incident (Ibrahim and Baki silently omitted) as a
 *     post-condition rather than a 272-token prompt banner.
 *   • fail quietly. Anything that cannot be decided produces a
 *     `Degradation`, because four seatbelts were found dead on
 *     2026-08-31, all silent, all with comments claiming they worked.
 *   • write copy. It emits `SpeechIntent`s; the composer renders them
 *     from the PROJECTED state, so no number the bot says can be wrong.
 *
 * WHAT IT REUSES RATHER THAN REIMPLEMENTS (§13 "what must not change")
 * -------------------------------------------------------------------
 *   interaction-contract.ts   the tag gate, unchanged in meaning
 *   promote-authorization.ts  admin-or-self-replace for bench promotion
 *   guest-name-ask.ts         placeholder names + the four ask gates
 *   format-switch.ts          the arithmetic the model got wrong
 * The engine is built OUT of the pure core, not beside it.
 */
import {
  actionRequiresTag,
  type GateRegisterForEntry,
  type GateVerdict,
} from "../interaction-contract";
import {
  isPromoteFromBenchAuthorized,
  type PromoteRegisterEntry,
} from "../promote-authorization";
import { shouldAskForGuestName } from "../guest-name-ask";
import { resolvePerson } from "./identity";
import type {
  AttendanceFacts,
  AttendanceRow,
  Claim,
  Degradation,
  EngineInput,
  EngineMessage,
  EngineResult,
  Member,
  MessageOutcome,
  ProposedWrite,
  SpeechIntent,
  SquadState,
} from "./types";

/** §3.2 S37. Applied PER FACT now, not as a blanket verdict-level gate. */
const CONFIDENCE_FLOOR = 0.7;

/** Scores are clamped, never trusted (§9 "value clamps" — survives). */
const MAX_SCORE = 99;

interface Working {
  rows: Map<string, AttendanceRow>;
  roster: Member[];
  offers: SquadState["openOffers"];
  teams: SquadState["teams"];
  completed: SquadState["completedMatch"];
  nextPosition: number;
}

function cloneWorking(state: SquadState): Working {
  const rows = new Map<string, AttendanceRow>();
  for (const r of state.rows) rows.set(r.userId, { ...r });
  return {
    rows,
    roster: state.roster.map((m) => ({ ...m })),
    offers: state.openOffers.map((o) => ({ ...o })),
    teams: state.teams.map((t) => ({ ...t })),
    completed: state.completedMatch ? { ...state.completedMatch } : null,
    nextPosition: state.rows.reduce((max, r) => Math.max(max, r.position), 0) + 1,
  };
}

function confirmedCount(w: Working): number {
  let n = 0;
  for (const r of w.rows.values()) if (r.status === "CONFIRMED") n++;
  return n;
}

function benchUserIds(w: Working): string[] {
  return [...w.rows.entries()]
    .filter(([, r]) => r.status === "BENCH")
    .sort((a, b) => a[1].position - b[1].position)
    .map(([id]) => id);
}

function nameOf(w: Working, userId: string): string {
  return w.roster.find((m) => m.userId === userId)?.name ?? "(unknown)";
}

/** A resolved claim: the fact plus who it is actually about. */
interface Target {
  claim: Claim;
  userId: string | null;
  name: string;
  /** True when the person had to be created to satisfy this claim. */
  provisional: boolean;
}

export function decide(input: EngineInput): EngineResult {
  const { state, messages } = input;
  const w = cloneWorking(state);
  const outcomes: MessageOutcome[] = [];
  const writes: ProposedWrite[] = [];
  const speech: SpeechIntent[] = [];
  const degradations: Degradation[] = [];
  /** Did anything change the squad? Drives the single status post. */
  let squadChanged = false;
  /** Question speech that the squad post would subsume (§3.2 S36). */
  const deferredSquadQuestions: SpeechIntent[] = [];

  // ── S35 · state collapse ─────────────────────────────────────────────
  // Only an author's LATEST self-attendance message writes. Computed up
  // front so the superseded message still gets an outcome (it must never
  // simply disappear) with a reason saying why it did nothing.
  //
  // "LATEST" MEANS LATEST THAT WOULD ACTUALLY WRITE. The first cut
  // recorded the last message CONTAINING a self claim, so any later
  // claim the engine then declines — contingent, past, hypothetical,
  // below the confidence floor — silently killed the earlier real one.
  // "out" followed by "in if I finish work early" left the player
  // CONFIRMED and said nothing: a phantom player in a paid squad, and
  // "message understood, action silently not taken" (§9).
  const lastSelfIndexByAuthor = new Map<string, number>();
  messages.forEach((m, i) => {
    if (!m.senderUserId) return;
    if (m.facts.kind !== "attendance") return;
    if (!m.facts.claims.some((c) => c.subject === "sender" && wouldWrite(c))) return;
    lastSelfIndexByAuthor.set(m.senderUserId, i);
  });

  messages.forEach((m, index) => {
    const out: MessageOutcome = {
      messageId: m.id,
      route: m.route,
      disposition: "noop",
      reasons: [],
      writes: [],
      react: null,
    };
    outcomes.push(out);

    const degrade = (detail: string, stage: Degradation["stage"] = "engine") => {
      degradations.push({ stage, messageId: m.id, detail });
      out.disposition = "degraded";
      out.reasons.push(`degraded: ${detail}`);
    };

    const emit = (write: ProposedWrite) => {
      writes.push(write);
      out.writes.push(write);
      out.disposition = "acted";
    };

    // A stage above already failed for this message. Say so; never let
    // it look like a decision was taken.
    if (m.degraded) {
      degrade(m.degraded, "extractor");
      return;
    }

    // ── Route `none` ───────────────────────────────────────────────────
    if (m.route === "none") {
      if (m.facts.kind === "attendance" && m.facts.claims.length > 0) {
        // §11.2 two-stage disagreement: the router said banter and the
        // extractor found a claim. Fail closed, but LOUDLY — this is the
        // regression detector the current architecture never had.
        degrade(
          `two-stage disagreement: routed \`none\` but the extractor returned ` +
            `${m.facts.claims.length} claim(s)`,
        );
        return;
      }
      out.reasons.push("route=none (banter)");
      return;
    }

    switch (m.facts.kind) {
      case "attendance":
        handleAttendance(m, m.facts, index);
        break;
      case "question":
        handleQuestion(m);
        break;
      case "teams":
        handleTeams(m);
        break;
      case "score":
        handleScore(m);
        break;
      case "admin":
        handleAdmin(m);
        break;
      case "none":
        out.reasons.push(`route=${m.route} but no facts were extracted`);
        break;
    }

    // ── the handlers ───────────────────────────────────────────────────

    function handleAttendance(msg: EngineMessage, facts: AttendanceFacts, i: number) {
      if (!state.features.attendance) {
        out.reasons.push("org does not track attendance");
        return;
      }

      // A bare "Confirmed" answering MatchTime's own pending list. The
      // bot's last post is a KNOWN OBJECT, so this is a lookup, not an
      // inference (§3.2 S25, 2026-04-24 Amir, 7453daa).
      let claims = facts.claims;
      let fromAffirmation = false;
      if (claims.length === 0 && facts.affirmation === "yes") {
        const pending = parsePendingSet(state.lastBotPost);
        if (pending.length === 0) {
          out.reasons.push("short confirmation with no pending set in the bot's last post");
          return;
        }
        claims = pending.map((name) => ({
          subject: "other" as const,
          personRef: name,
          personNamed: true,
          polarity: "in" as const,
          contingent: false,
          conditionOn: "none" as const,
          tense: "present" as const,
          reported: true,
          confidence: 0.95,
        }));
        fromAffirmation = true;
        out.reasons.push(`short confirmation resolved to ${pending.length} pending name(s)`);
      }

      // Side requests are facts in their own right and must survive
      // alongside the claims. Today's incident was a fast path claiming
      // a two-intent message and throwing half of it away.
      for (const sr of facts.sideRequests) out.reasons.push(`side-request:${sr}`);

      if (claims.length === 0) {
        if (facts.sideRequests.includes("chase")) {
          // §3.2 S30 + the 2026-05-28 Kemal incident: "@all we need more
          // players pls" is a nudge. It must never drop the asker, which
          // is exactly what the `strongDrop` regex over the model's
          // prose did two days after it shipped.
          out.reasons.push("chase nudge: no attendance change");
          return;
        }
        out.reasons.push("no claims extracted");
        return;
      }

      // ── The interaction contract, unchanged in meaning (§13) ─────────
      const gate = toGateVerdict(claims, facts);
      if (actionRequiresTag(gate) && !msg.tagged) {
        out.reasons.push("requires an @Match Time tag (interaction contract)");
        return;
      }

      if (!state.matchId) {
        degrade("no active registration match (blocked or none upcoming)", "state");
        return;
      }

      // ── Resolve every claim to a person BEFORE deciding anything ─────
      //
      // ORDER MATTERS, and it is a DECISION, so the engine owns it: a
      // replacement frees the slot before it fills it. Found by the
      // first live corpus sweep — "@Izzet is replacing @Elnur" against a
      // 14/14 squad put Izzet on the BENCH (processed first, no room)
      // and then dropped Elnur, leaving 13 confirmed and a bench beside
      // an empty slot. OUT first, always.
      //
      // …but ONLY across distinct people. Applied to two claims about the
      // same person it reversed a self-correction: "I'm in tonight.
      // Actually no, scrap that, I'm out" sorted to [out, in] and
      // registered someone who had just said they were out. So each
      // person is collapsed to their LAST claim first (textual order is
      // the correction), and only then are the survivors ordered
      // OUT-first. That also guarantees at most one attendance write per
      // person per message.
      const byTarget = new Map<string, Claim>();
      for (const c of claims) {
        const key = c.subject === "sender" ? "@self" : c.personRef.trim().toLowerCase();
        byTarget.set(key, c);
      }
      const ordered = [...byTarget.values()].sort(
        (a, b) => (a.polarity === "out" ? 0 : 1) - (b.polarity === "out" ? 0 : 1),
      );
      const targets: Target[] = [];
      const guestAsks: Claim[] = [];
      for (const c of ordered) {
        if (c.confidence < CONFIDENCE_FLOOR) {
          out.reasons.push(
            `claim about "${c.personRef || "sender"}" below the confidence floor ` +
              `(${c.confidence} < ${CONFIDENCE_FLOOR})`,
          );
          continue;
        }
        if (c.tense === "past" || c.tense === "hypothetical") {
          out.reasons.push(`claim is ${c.tense}, never a registration`);
          continue;
        }

        if (c.subject === "sender") {
          if (!msg.senderUserId) {
            // §9 "unresolved-sender nudge" — SURVIVES. "Message
            // understood, action silently not taken" is this product's
            // signature failure.
            degrade("sender could not be resolved to a member; no write attempted");
            continue;
          }
          // Superseded only by a LATER message that would itself write,
          // and only for a claim that would otherwise have written. A
          // claim the engine is going to decline anyway keeps its own
          // honest reason ("contingent", "past") rather than being
          // reported as superseded by something that did nothing.
          const lastIdx = lastSelfIndexByAuthor.get(msg.senderUserId);
          if (wouldWrite(c) && lastIdx !== undefined && lastIdx !== i) {
            out.reasons.push("superseded by a later message from the same author");
            continue;
          }
          targets.push({
            claim: c,
            userId: msg.senderUserId,
            name: msg.senderName ?? nameOf(w, msg.senderUserId),
            provisional: false,
          });
          continue;
        }

        // Third party. A relationship is not a name — and the engine
        // says so itself rather than trusting `personNamed` (§11.3).
        const resolution = resolvePerson(c.personRef, w.roster);

        // …and the same distrust runs the OTHER way. `personNamed` is
        // the model's reading of the TEXT; whether a reference
        // identifies a SQUAD MEMBER is the roster's business, and only
        // code has the roster. The first live corpus sweep had the
        // extractor call "habibi" an endearment rather than a name 3
        // times out of 3, which blocked a drop the message plainly
        // makes. A reference that uniquely resolves to a member has
        // named someone, whatever the model thinks — and it can only get
        // here after identity.ts has already refused relationships,
        // quantities, indefinites and raw digits.
        let personNamed = c.personNamed;
        if (!personNamed && resolution.kind === "resolved") {
          personNamed = true;
          out.reasons.push(
            `"${c.personRef}" was reported unnamed but resolves to a squad member ` +
              `(${resolution.member.name}); treating it as named`,
          );
        }

        if (!personNamed || resolution.kind === "not-a-person") {
          if (c.polarity === "in") {
            guestAsks.push(c);
            out.reasons.push(`unnamed third party ("${c.personRef}") cannot register anyone`);
          } else {
            out.reasons.push(
              `unnamed third party ("${c.personRef}") cannot be dropped or benched`,
            );
          }
          if (resolution.kind === "not-a-person" && personNamed) {
            degrade(`extractor said personNamed but ${resolution.why}`);
          }
          continue;
        }
        if (resolution.kind === "ambiguous") {
          degrade(
            `ambiguous name "${c.personRef}": ${resolution.candidates
              .map((m2) => m2.name)
              .join(", ")}`,
          );
          continue;
        }
        if (resolution.kind === "unknown") {
          if (c.polarity !== "in") {
            out.reasons.push(`"${c.personRef}" is not a member; nothing to drop or bench`);
            continue;
          }
          if (!msg.senderUserId) {
            degrade(`unknown guest "${c.personRef}" offered by an unresolved sender`);
            continue;
          }
          targets.push({
            claim: c,
            userId: null,
            name: resolution.name,
            provisional: true,
          });
          continue;
        }
        targets.push({
          claim: c,
          userId: resolution.member.userId,
          name: resolution.member.name,
          provisional: false,
        });
      }

      // ── The guest name ask (a QUESTION, never a write) ───────────────
      if (guestAsks.length > 0) {
        const decision = shouldAskForGuestName({
          body: msg.body,
          tagged: msg.tagged,
          senderKnown: !!msg.senderUserId,
          attendanceOn: state.features.attendance,
          hasActiveMatch: !!state.matchId,
          confirmedCount: confirmedCount(w),
          maxPlayers: state.maxPlayers,
          alreadyAsked: !!msg.senderUserId && state.guestAskedUserIds.includes(msg.senderUserId),
        });
        out.reasons.push(`guest-name-ask: ${decision.reason}`);
        if (decision.ask) {
          speech.push({
            kind: "guest_name_ask",
            messageId: msg.id,
            askerName: msg.senderName,
            body: msg.body,
          });
          out.disposition = out.disposition === "degraded" ? "degraded" : "acted";
        }
      }

      if (targets.length === 0) return;

      // ── Authorisation for the privileged moves ──────────────────────
      const senderIsAdmin =
        !!msg.senderUserId && !!w.roster.find((m2) => m2.userId === msg.senderUserId)?.isAdmin;
      const promoteEntries: PromoteRegisterEntry[] = targets.map((t) => ({
        userId: t.userId,
        action: polarityToAction(t.claim.polarity),
      }));
      const promoteAuthorized = isPromoteFromBenchAuthorized({
        senderUserId: msg.senderUserId,
        senderIsAdmin,
        entries: promoteEntries,
      });

      for (const t of targets) {
        const c = t.claim;
        const self = c.subject === "sender";

        // ── Contingency (§3.2 S11, S12, S15) ──────────────────────────
        if (c.contingent) {
          if (c.polarity === "out") {
            // 2026-06-09, Erdal: "If u can make happy to drop" dropped
            // him immediately, the replacement never confirmed, and the
            // squad sat at 13 for a paid match. A contingent OUT HOLDS.
            // No literal "if" is required to reach this branch, which is
            // what route.ts:3095 got wrong.
            out.reasons.push(`contingent drop for ${t.name}: holding, no write`);
            continue;
          }
          if (c.conditionOn === "self") {
            // Personal uncertainty ("in if my back holds up"). Record
            // nothing; the tentative follow-up path chases later.
            out.reasons.push(`tentative (personal uncertainty) for ${t.name}: no write`);
            continue;
          }
          // conditionOn "squad" or "none": a standing offer. §3.2 S15(a)
          // is the rule behind incident A5 and its outcome is the
          // OPPOSITE of (b): the person is registered now, and capacity
          // below decides whether that is a slot or the bench.
          out.reasons.push(`standing offer for ${t.name}: registering`);
        }

        // ── Third-party drops and demotes ─────────────────────────────
        if (!self && (c.polarity === "out" || c.polarity === "bench")) {
          if (c.polarity === "bench" && !senderIsAdmin) {
            // §3.2 S8 frames the demote as an ADMIN op, and taking a
            // confirmed slot off someone who never consented is roster
            // surgery. A tag alone is not enough.
            out.reasons.push(`only an admin may bench ${t.name}`);
            continue;
          }
          const refusal = banterRefusal(msg, t, messages, senderIsAdmin);
          if (refusal) {
            out.reasons.push(refusal);
            continue;
          }
        }

        // ── Bench-slot offers (§3.2 S13, and NOBODY is ever dropped) ──
        const existing = t.userId ? w.rows.get(t.userId) : undefined;
        // An offer's audience is the bench AS IT WAS when the offer
        // opened, and an EMPTY audience is offered to nobody rather than
        // to everyone. An offer can outlive its bench (everyone on it
        // gets confirmed), and the everyone-reading meant the next
        // person to say IN silently consumed a slot that was never
        // theirs — the first bencher to answer would then find the offer
        // gone. Fail closed.
        const openOffer =
          t.userId !== null
            ? w.offers.find((o) => o.offeredToUserIds.includes(t.userId as string))
            : undefined;
        // `existing` is a live reference into the working state and
        // applyClaim mutates it, so the BEFORE status has to be read
        // now. (Caught by the S13b unit test the moment the claim rule
        // started depending on it.)
        const statusBefore = existing?.status;
        if (
          existing?.status === "BENCH" &&
          c.polarity === "in" &&
          openOffer &&
          !self &&
          !promoteAuthorized
        ) {
          // A third party nominating a bench player does not claim the
          // slot for them. The offer stays open, first-claim-wins.
          out.reasons.push(
            `${t.name} was nominated by someone else; a bench slot is claimed by its holder`,
          );
          continue;
        }

        const write = applyClaim({
          w,
          state,
          target: t,
          self,
          promoteAuthorized,
          messageId: msg.id,
        });
        if (!write) {
          // A bench player answering an open offer when the slot has
          // already gone gets an ANSWER, not silence. That is the
          // 2026-05-19 Karahan shape: the bencher does what they were
          // asked and machinery ignores them.
          if (statusBefore === "BENCH" && c.polarity === "in" && openOffer && self) {
            speech.push({ kind: "bench_claim_too_late", messageId: msg.id, userId: t.userId! });
            out.disposition = out.disposition === "degraded" ? "degraded" : "acted";
          }
          out.reasons.push(`no change for ${t.name}`);
          continue;
        }
        emit(write);
        squadChanged = true;
        out.react = out.react ?? reactFor(write.status, self);

        // A player who was DROPPED and is back closes the offer that
        // was opened for THEIR slot: it isn't vacant any more, so asking
        // the bench to step into it makes no sense. `attendance.ts`
        // auto-resolves exactly this (Sutton 2026-05-26: Baki was
        // re-confirmed and the stale offer kept firing bench prompts on
        // top of the squad-locked message).
        if (statusBefore === "DROPPED" && t.userId && write.status !== "DROPPED") {
          const stale = w.offers.filter((o) => o.replacingUserId === t.userId);
          w.offers = w.offers.filter((o) => o.replacingUserId !== t.userId);
          for (const o of stale) {
            emit({
              kind: "resolve_bench_offer",
              offerId: o.id,
              claimedByUserId: t.userId,
              sourceMessageId: msg.id,
              reason: `${t.name} is back, so the slot they vacated is no longer open`,
            });
          }
        }

        // Claiming an open offer resolves it — but only when the
        // claimant actually came off the bench for it. A brand-new
        // registration is an ordinary IN, not a claim.
        if (write.status === "CONFIRMED" && openOffer && t.userId && statusBefore === "BENCH") {
          w.offers = w.offers.filter((o) => o.id !== openOffer.id);
          emit({
            kind: "resolve_bench_offer",
            offerId: openOffer.id,
            claimedByUserId: t.userId,
            sourceMessageId: msg.id,
            reason: `${t.name} took the open slot`,
          });
        }

        // A drop with a bench behind it opens ONE offer to the WHOLE
        // bench. Nobody is dropped; first claim wins; daytime gating and
        // the copy live in bench-offer-copy.ts (§13 "preserve exactly").
        if (write.status === "DROPPED" && t.userId) {
          const bench = benchUserIds(w);
          const alreadyOpen = w.offers.some((o) => o.replacingUserId === t.userId);
          if (bench.length > 0 && !alreadyOpen) {
            const offer = {
              id: `proposed-offer-${t.userId}`,
              replacingUserId: t.userId,
              offeredToUserIds: bench,
            };
            w.offers.push(offer);
            emit({
              kind: "open_bench_offer",
              replacingUserId: t.userId,
              offeredToUserIds: bench,
              sourceMessageId: msg.id,
              reason: `${t.name} dropped out with ${bench.length} on the bench`,
            });
            speech.push({
              kind: "bench_offer_open",
              messageId: msg.id,
              replacingName: t.name,
            });
          }
        }
      }

      // A resolved confirmation is a conversational turn and deserves an
      // answer even when every write turned out to be idempotent. Found
      // by the first live corpus sweep: "Confirmed" resolved the pending
      // set correctly, both names were ALREADY down, so nothing changed
      // and the bot said nothing at all. "Message understood, action
      // silently not taken" is this product's signature failure (§9) and
      // it applies just as much to an action that was already true.
      if (fromAffirmation && out.writes.length === 0 && targets.length > 0) {
        speech.push({
          kind: "pending_confirmed_ack",
          messageId: msg.id,
          userIds: targets.map((t) => t.userId).filter((id): id is string => !!id),
        });
        out.disposition = out.disposition === "degraded" ? "degraded" : "acted";
      }

      // A recruit request alongside a drop opens the same offer path; if
      // no bench exists there is nothing to open, and the chase is the
      // scheduler's job. Either way it is RECORDED, never swallowed.
      if (facts.sideRequests.includes("recruit") && out.writes.length === 0) {
        out.reasons.push("recruit request with no accompanying attendance change");
      }
    }

    function handleQuestion(msg: EngineMessage) {
      const facts = msg.facts;
      if (facts.kind !== "question") return;
      if (actionRequiresTag({ intent: "question", registerAttendance: null, registerFor: null }) && !msg.tagged) {
        out.reasons.push("question requires an @Match Time tag (interaction contract)");
        return;
      }
      out.disposition = "acted";
      switch (facts.topic) {
        case "squad":
        case "count":
          // §3.2 S24: the engine compares the stated number to the DB.
          // Deferred so it collapses into the single squad post when the
          // batch also changed the squad (S36).
          deferredSquadQuestions.push({
            kind: "answer_count",
            messageId: msg.id,
            statedCount: facts.statedCount,
          });
          out.reasons.push(
            facts.statedCount === null
              ? "squad-state question answered from the database"
              : `stated ${facts.statedCount}, database says ${confirmedCount(w)}`,
          );
          break;
        case "bench":
          speech.push({ kind: "answer_bench", messageId: msg.id });
          break;
        case "person_status": {
          const ref = facts.personRef ?? "";
          const r = resolvePerson(ref, w.roster);
          speech.push({
            kind: "answer_person_status",
            messageId: msg.id,
            personRef: ref,
            userId: r.kind === "resolved" ? r.member.userId : null,
          });
          if (r.kind !== "resolved") out.reasons.push(`asked about "${ref}", who is not a member`);
          break;
        }
        case "phones":
          speech.push({ kind: "answer_phones", messageId: msg.id });
          break;
        case "stats":
          if (!state.features.statsQa) {
            out.reasons.push("stats Q&A is off for this org");
            out.disposition = "noop";
            break;
          }
          speech.push({ kind: "answer_stats", messageId: msg.id });
          break;
        case "options":
          speech.push({ kind: "answer_options", messageId: msg.id });
          break;
        default:
          // The `question` route is the least designed part of the
          // proposal (§14.3) and this is where that shows. Saying so is
          // the point: a silent shrug is the failure mode this design
          // exists to remove.
          degrade(`no deterministic answer for question topic "${facts.topic}"`);
      }
    }

    function handleTeams(msg: EngineMessage) {
      const facts = msg.facts;
      if (facts.kind !== "teams") return;
      if (!msg.tagged) {
        out.reasons.push("team ops require an @Match Time tag (interaction contract)");
        return;
      }
      if (facts.action === "show") {
        // 2026-06-18 (c408649): "show the teams again" re-ran the
        // balancer and destroyed an admin's manual swap. Showing is a
        // READ. There is no branch here that can write.
        speech.push({ kind: "teams_post", messageId: msg.id });
        out.disposition = "acted";
        out.reasons.push("re-posting the existing teams; the balancer is not re-run");
        return;
      }
      degrade(
        `team action "${facts.action}" is not implemented in the dry-run pipeline; ` +
          `the existing balancer still owns it`,
      );
    }

    function handleScore(msg: EngineMessage) {
      const facts = msg.facts;
      if (facts.kind !== "score") return;
      const completed = w.completed;
      if (!completed) {
        out.reasons.push("no completed match to record a score against");
        return;
      }
      const senderIsAdmin =
        !!msg.senderUserId && !!w.roster.find((m2) => m2.userId === msg.senderUserId)?.isAdmin;
      const played = !!msg.senderUserId && completed.participantUserIds.includes(msg.senderUserId);
      if (!senderIsAdmin && !played) {
        // §9 authorisation — survives untouched. Nothing about the
        // model's competence changes who may report a result.
        out.reasons.push("score reported by someone who neither played nor is an admin");
        return;
      }
      if (completed.redScore !== null || completed.yellowScore !== null) {
        // The shipped path only ever looks for an UNSCORED completed
        // match (`route.ts` filters on redScore/yellowScore null). Without
        // that, any later message the router calls `score` rewrites a
        // settled result — and in step 6 it would re-run the Elo deltas.
        out.reasons.push(
          `the last completed match already recorded ` +
            `${completed.redScore}-${completed.yellowScore}; not overwriting it`,
        );
        return;
      }
      const red = clampScore(facts.first);
      const yellow = clampScore(facts.second);
      if (red === null || yellow === null) {
        degrade(`score out of range: ${facts.first}-${facts.second}`);
        return;
      }
      completed.redScore = red;
      completed.yellowScore = yellow;
      emit({
        kind: "score",
        matchId: completed.id,
        red,
        yellow,
        sourceMessageId: msg.id,
        reason: "final result reported by a participant or admin",
      });
      speech.push({ kind: "score_ack", messageId: msg.id, red, yellow });
      out.react = "👍";
    }

    function handleAdmin(msg: EngineMessage) {
      const facts = msg.facts;
      if (facts.kind !== "admin") return;
      const senderIsAdmin =
        !!msg.senderUserId && !!w.roster.find((m2) => m2.userId === msg.senderUserId)?.isAdmin;

      if (facts.action === "bulk_payment") {
        if (!msg.tagged) {
          out.reasons.push("payment credit requires an @Match Time tag");
          return;
        }
        if (!state.features.paymentTracking) {
          out.reasons.push("payment tracking is off for this org");
          return;
        }
        if (!senderIsAdmin) {
          // Real money, live on Sutton FC. The chase math must not be
          // corruptible by any member who can type.
          out.reasons.push("only an admin may credit a payment");
          return;
        }
        const payer = resolvePerson(facts.payerRef ?? "", w.roster);
        if (payer.kind !== "resolved") {
          degrade(`payment credit names "${facts.payerRef}", who does not resolve to a member`);
          return;
        }
        const count = Math.floor(facts.count ?? 0);
        if (count <= 0) {
          degrade("payment credit with no usable player count");
          return;
        }
        // Real money on a real club. §6.4's claim is that numbers are
        // never model-authored so they cannot be wrong; THIS one is
        // model-authored, so a figure that cannot be true is refused and
        // said out loud rather than quietly clamped and then announced.
        if (count > state.maxPlayers) {
          degrade(
            `payment credit for ${count} players exceeds the format's ${state.maxPlayers}; refusing`,
          );
          return;
        }
        const covered: string[] = [];
        for (const ref of facts.coveredRefs ?? []) {
          const r = resolvePerson(ref, w.roster);
          if (r.kind === "resolved") covered.push(r.member.userId);
          else out.reasons.push(`covered name "${ref}" did not resolve`);
        }
        emit({
          kind: "payment_credit",
          payerUserId: payer.member.userId,
          payerName: payer.member.name,
          count,
          coveredUserIds: covered,
          sourceMessageId: msg.id,
          reason: "admin-credited bulk payment",
        });
        speech.push({
          kind: "payment_ack",
          messageId: msg.id,
          payerName: payer.member.name,
          count,
        });
        return;
      }

      if (facts.action === "reminder") {
        if (!msg.tagged) {
          out.reasons.push("reminder request requires an @Match Time tag");
          return;
        }
        if (!msg.senderUserId) {
          degrade("reminder requested by an unresolved sender; nowhere to send it");
          return;
        }
        const phrase = (facts.phrase ?? "").trim();
        if (!phrase) {
          degrade("reminder request with no time phrase");
          return;
        }
        // §3.2 S22: the extractor returns the PHRASE; `date-fns-tz`
        // resolves it at the apply site. The engine does no calendar
        // arithmetic and neither does the model.
        emit({
          kind: "reminder",
          userId: msg.senderUserId,
          phrase,
          sourceMessageId: msg.id,
          reason: "reminder requested",
        });
        speech.push({ kind: "reminder_ack", messageId: msg.id, phrase });
        return;
      }

      degrade(`admin action "${facts.action}" has no deterministic handler`);
    }
  });

  // ── Speech assembly (§3.2 S36 · one authoritative post per batch) ────
  if (squadChanged) {
    speech.push({ kind: "squad_status", messageId: null });
    for (const q of deferredSquadQuestions) {
      // The count question is answered BY that post. Four contradictory
      // posts in one batch is the 2026-06-12 Sutton Lads incident.
      void q;
    }
  } else {
    speech.push(...deferredSquadQuestions);
  }

  assertCoverage(messages, outcomes);

  return {
    outcomes,
    writes,
    nextState: {
      ...state,
      rows: [...w.rows.values()].sort((a, b) => a.position - b.position),
      roster: w.roster,
      openOffers: w.offers,
      teams: w.teams,
      completedMatch: w.completed,
    },
    speech,
    degradations,
  };
}

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Would this claim, on its own, ever produce a write?
 *
 * Only the vetoes that need no state: the confidence floor, tense, and
 * the two contingency holds. Used by the state collapse so a claim the
 * engine is going to decline cannot supersede an earlier one it would
 * have acted on. Kept beside the rules it mirrors — if one moves, this
 * has to move with it, and the collapse tests are what say so.
 */
function wouldWrite(c: Claim): boolean {
  if (c.confidence < CONFIDENCE_FLOOR) return false;
  if (c.tense === "past" || c.tense === "hypothetical") return false;
  if (c.contingent && c.polarity === "out") return false;
  if (c.contingent && c.conditionOn === "self") return false;
  return true;
}

function polarityToAction(p: Claim["polarity"]): "IN" | "OUT" | "BENCH" {
  return p === "in" ? "IN" : p === "out" ? "OUT" : "BENCH";
}

/**
 * Build the shape `interaction-contract.ts` already understands, so the
 * tag gate is REUSED rather than reimplemented. §13: "The interaction
 * contract … moves into the engine unchanged in meaning."
 */
export function toGateVerdict(claims: Claim[], facts: AttendanceFacts): GateVerdict {
  const selfClaim = claims.find((c) => c.subject === "sender");
  const others: GateRegisterForEntry[] = claims
    .filter((c) => c.subject === "other")
    .map((c) => ({ name: c.personRef, action: polarityToAction(c.polarity) }));

  let intent: string;
  if (selfClaim) {
    if (selfClaim.contingent) intent = "conditional_in";
    else if (selfClaim.polarity === "out")
      intent = facts.sideRequests.includes("recruit") ? "replacement_request" : "out";
    else intent = "in";
  } else {
    intent = "in";
  }

  return {
    intent,
    registerAttendance: selfClaim ? polarityToAction(selfClaim.polarity) : null,
    registerFor: others.length > 0 ? others : null,
  };
}

/**
 * §3.2 S25 — MatchTime's own last post is a known object, so the names
 * it listed as pending can be read back out of it deterministically.
 * Anchored on the literal copy the bot composes; anything else returns
 * nothing rather than guessing.
 */
export function parsePendingSet(lastBotPost: string | null): string[] {
  if (!lastBotPost) return [];
  const m = /waiting for confirmation:\s*([^.\n]+)/i.exec(lastBotPost);
  if (!m) return [];
  return m[1]
    .split(/,| and /i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/**
 * §9 "the banter-drop guard — SURVIVES". The prototype in §6.2 proves it
 * is needed: the extractor CORRECTLY reports that "Zeeshan is out 😂😂"
 * contains an OUT claim, because the text does. Deciding it is banter
 * needs corroboration the extractor cannot see, and the engine can.
 *
 * Two refusals, both narrow:
 *   1. the target is speaking in this same window and says the opposite;
 *   2. a non-admin drops someone else amid laughing emoji.
 * An admin's uncontested instruction is always honoured — that is the
 * control case, and losing it would be its own incident.
 */
function banterRefusal(
  msg: EngineMessage,
  target: Target,
  batch: EngineMessage[],
  senderIsAdmin: boolean,
): string | null {
  if (!target.userId) return null;
  const contradicts = batch.some(
    (other) =>
      other.id !== msg.id &&
      other.senderUserId === target.userId &&
      other.facts.kind === "attendance" &&
      other.facts.claims.some((c) => c.subject === "sender" && c.polarity === "in"),
  );
  if (contradicts) {
    return `${target.name} contradicts this in the same window; refusing the drop (corroboration)`;
  }
  if (!senderIsAdmin && /😂|🤣|lol\b/i.test(msg.body)) {
    return `banter markers in a non-admin drop of ${target.name}; refusing without corroboration`;
  }
  return null;
}

function clampScore(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n);
  if (v < 0 || v > MAX_SCORE) return null;
  return v;
}

function reactFor(status: AttendanceRow["status"], self: boolean): string {
  if (!self) return "👍";
  if (status === "CONFIRMED") return "✅";
  if (status === "BENCH") return "🪑";
  return "👋";
}

/**
 * CAPACITY AND THE BENCH INVARIANT — the arithmetic the model got
 * catastrophically wrong, done here instead.
 *
 * A BENCH row means exactly one of two things (PR #27, 2026-08-31):
 * the squad is FULL, or a human EXPLICITLY asked for the bench. It must
 * never mean "a classifier inferred it", because a bench alongside four
 * empty slots is not a state the product can render honestly.
 */
function applyClaim(args: {
  w: Working;
  state: SquadState;
  target: Target;
  self: boolean;
  promoteAuthorized: boolean;
  messageId: string;
}): (ProposedWrite & { kind: "attendance" }) | null {
  const { w, state, target, self, promoteAuthorized, messageId } = args;
  const polarity = target.claim.polarity;

  // Provision a named guest the org has never seen. Only ever for an
  // ADD, only ever for something that survived the identity checks.
  let userId = target.userId;
  if (userId === null) {
    if (polarity !== "in") return null;
    userId = `new:${target.name}`;
    w.roster.push({ userId, name: target.name, isAdmin: false, hasPhone: false });
  }

  const existing = w.rows.get(userId);

  if (polarity === "out") {
    if (!existing || existing.status === "DROPPED") return null; // nothing to drop
    existing.status = "DROPPED";
    return {
      kind: "attendance",
      userId,
      name: target.name,
      status: "DROPPED",
      explicitBench: false,
      promote: false,
      sourceMessageId: messageId,
      reason: self ? "player dropped themselves" : "dropped by an authorised instruction",
    };
  }

  // A model-supplied `bench` is only EXPLICIT when nobody attached a
  // condition to it. `route.ts:2412-2417` makes exactly this
  // distinction on the shipped path: a conditional_in's BENCH is
  // "inferred", because nobody said the word "bench" — the classifier
  // decided a standing offer was functionally one, and that is only
  // sound when the squad is full. Treating it as explicit regenerates
  // the 2026-08-31 incident: a bench row rendered beside four empty
  // slots.
  const explicitBench = polarity === "bench" && !target.claim.contingent;
  const confirmed = confirmedCount(w);
  const squadHasRoom = confirmed < state.maxPlayers;

  if (existing && (existing.status === "CONFIRMED" || existing.status === "BENCH")) {
    const wantsDowngrade = explicitBench && existing.status === "CONFIRMED";
    const wantsPromotion =
      existing.status === "BENCH" && !explicitBench && squadHasRoom && (self || promoteAuthorized);
    if (!wantsDowngrade && !wantsPromotion) return null; // idempotent
    existing.status = wantsDowngrade ? "BENCH" : "CONFIRMED";
    return {
      kind: "attendance",
      userId,
      name: target.name,
      status: existing.status,
      explicitBench: wantsDowngrade,
      promote: wantsPromotion,
      sourceMessageId: messageId,
      reason: wantsDowngrade
        ? "explicit bench request"
        : "promoted from the bench into an open slot",
    };
  }

  const status = explicitBench || !squadHasRoom ? "BENCH" : "CONFIRMED";
  const position = existing ? existing.position : w.nextPosition++;
  w.rows.set(userId, { userId, status, position });
  return {
    kind: "attendance",
    userId,
    name: target.name,
    status,
    explicitBench,
    promote: false,
    sourceMessageId: messageId,
    reason: explicitBench
      ? "explicit bench request"
      : status === "BENCH"
        ? `squad full at ${confirmed}/${state.maxPlayers}`
        : `slot ${confirmed + 1} of ${state.maxPlayers}`,
  };
}

/**
 * §3.2 S1's incident as a post-condition. On 2026-05-25 two clear drop
 * messages were omitted from the verdict array entirely and the bot
 * silently no-op'd both; the prompt grew a 272-token VERDICT COVERAGE
 * banner. Here it is an assertion, and it throws rather than warns —
 * a coverage hole is a bug in this file, not a bad model day.
 */
export function assertCoverage(messages: EngineMessage[], outcomes: MessageOutcome[]): void {
  if (messages.length !== outcomes.length) {
    throw new Error(
      `pipeline coverage violation: ${messages.length} messages produced ` +
        `${outcomes.length} outcomes`,
    );
  }
  for (const m of messages) {
    if (!outcomes.some((o) => o.messageId === m.id)) {
      throw new Error(`pipeline coverage violation: no outcome for message ${m.id}`);
    }
  }
}
