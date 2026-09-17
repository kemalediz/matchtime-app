/**
 * STAGE 4 — COMPOSITION.
 *
 * §6.4: "Every outgoing message is composed from the database AFTER the
 * writes land. `composeSquadStatusPost()` is the model; generalise it.
 * Numbers and names are never model-authored, so they cannot be wrong,
 * so nothing needs to check them afterwards."
 *
 * That last clause was a deletion list, and §10 step 8 SPENT it. Every
 * one of these existed only because the model authored user-visible
 * squad text and got it wrong, and every one had nothing left to do once
 * this file became the only path:
 *
 *   enforceCanonicalRoster        message-analyzer.ts:1482-1623, 140 lines
 *   rewriteOverconfidentPromotion message-analyzer.ts:1639-1710
 *   the promotion strips          route.ts:1318-1350
 *   enforceProximity              message-analyzer.ts:1335-1379
 *   the squad-status collapse     route.ts:1508-1582
 *   the 👍→✅/🪑 last-mile rewrite  route.ts:2151-2161
 *
 * The line references above are to the files AS THEY STOOD BEFORE
 * 2026-09-06 and will not resolve: `analyzeBatch`, the 19,850-token
 * `SYSTEM_PROMPT` and `executeVerdict` are deleted, and every guard
 * whose input was a field on `AnalysisVerdict` went with them. They are
 * kept as written because they are the receipt — §9's "no longer
 * possible: the error class becomes unrepresentable, so the guard has
 * nothing to guard", spent rather than promised. The per-guard proofs
 * are in the commit that deleted them.
 *
 * WHICH MAKES THIS FILE THE ONLY PATH, LITERALLY. There is no second
 * composer to be corrected any more, and nothing downstream re-reads
 * what this produces. A sentence composed wrongly here is sent.
 *
 * THE HONEST-ACK PATTERN, MADE STRUCTURAL. The composer runs on the
 * PROJECTED state — the world as it will be after the proposed writes —
 * so it is impossible to tell a player they are in when no write was
 * proposed for them. `out-of-band-self-attendance.ts` and
 * `attendance-write-outcome.ts` had to enforce that as a rule; here it
 * is a property of the data flow (§6.4, closing cold-audit finding 1.1
 * by construction on the path carrying ~20x the traffic).
 *
 * DRY-RUN: this returns strings. It does not send them anywhere.
 */
import { buildFormatSwitchFacts } from "../format-switch";
import { renderGuestNameAsk } from "../guest-name-ask";
// From `../group-copy`, not from message-analyzer / team-generation:
// both of those import the Prisma client, and this module has to be
// loadable in the Playwright worker (which never loads Prisma) so the
// corpus can judge this pipeline. The functions themselves are the same
// ones, moved and re-exported, not copies.
import { composeSquadStatusPost, formatTeamsPost } from "../group-copy";
// The Prisma-free half of `rating-progress.ts`, split out on 2026-09-11
// precisely so this file can render that answer. See this module's
// header for what a Prisma import here does to the corpus spec.
import { formatRatingProgressReply } from "../rating-progress-answer";
import { resolvePerson } from "./identity";
import { t } from "../i18n/t";
import type { EngineResult, SquadState } from "./types";

export interface Utterance {
  /** The message this answers, or null for the batch-level squad post. */
  messageId: string | null;
  text: string;
}

export interface ComposedOutput {
  utterances: Utterance[];
  reacts: Array<{ messageId: string; emoji: string }>;
  /**
   * Degradations, for the operator. DELIBERATELY not utterances: "degrade
   * loudly" means loud to whoever is on the incident, not chatty in a
   * customer's group. MatchTime's interaction contract is conservative
   * and making it SPEAK where it currently stays quiet is the delicate
   * part (see guest-name-ask.ts's four gates).
   */
  operatorNotes: string[];
}

/** A pushname that is really a phone number is never printed as a name.
 *  Same rule as `isRawDigitName` in the analyze route and `firstName` in
 *  guest-name-ask.ts, applied at the last possible moment so it cannot
 *  be bypassed by a new speech kind. */
const RAW_PHONE = /(?:\+\d[\d\s().-]{8,}\d)|(?:\b0\d{9,10}\b)|(?:\b\d{11,}\b)/;

/** `fallback` is the table's `fallback_player` ("a player"). */
function safeName(name: string, fallback: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return fallback;
  if (RAW_PHONE.test(trimmed) || !/\p{L}/u.test(trimmed)) return fallback;
  return trimmed;
}

function firstName(name: string, fallback: string): string {
  return safeName(name, fallback).split(/\s+/)[0];
}

function namesByStatus(state: SquadState, status: "CONFIRMED" | "BENCH", fallback: string): string[] {
  const byId = new Map(state.roster.map((m) => [m.userId, m.name]));
  return state.rows
    .filter((r) => r.status === status)
    .sort((a, b) => a.position - b.position)
    .map((r) => safeName(byId.get(r.userId) ?? "", fallback));
}

export function compose(result: EngineResult): ComposedOutput {
  const state = result.nextState;
  const utterances: Utterance[] = [];
  const reacts: Array<{ messageId: string; emoji: string }> = [];
  const operatorNotes: string[] = [];
  // THE GROUP'S LANGUAGE, once. Carried on the state by `load-state.ts`
  // from `Organisation.language`; English for every group that has not
  // set one, and the English bytes are pinned by the golden snapshot.
  // Speech kinds that read `s.` speak it; the rest still compose
  // English literals and move in later Phase 2 slices.
  const lang = state.features.language;
  const s = t(lang);
  const name = (raw: string) => safeName(raw, s.fallback_player);
  const first = (raw: string) => firstName(raw, s.fallback_player);

  const confirmed = namesByStatus(state, "CONFIRMED", s.fallback_player);
  const bench = namesByStatus(state, "BENCH", s.fallback_player);

  for (const sp of result.speech) {
    switch (sp.kind) {
      case "squad_status":
        // The composer that already existed and was only ever used as a
        // fallback. Promoted, not rewritten (§13).
        utterances.push({
          messageId: null,
          text: composeSquadStatusPost({ confirmed, bench, maxPlayers: state.maxPlayers, lang }),
        });
        break;

      case "answer_count": {
        const need = Math.max(0, state.maxPlayers - confirmed.length);
        utterances.push({
          messageId: sp.messageId,
          text: s.answer_count({
            stated: sp.statedCount !== null && sp.statedCount !== confirmed.length,
            confirmed: confirmed.length,
            maxPlayers: state.maxPlayers,
            kickoffLabel: state.kickoffLabel,
            need,
          }),
        });
        break;
      }

      case "answer_squad":
        // The SAME composer the batch squad post uses, called directly.
        // "who's playing?" used to reach `answer_count` and come back as
        // "We're 11/14, need 3 more" — a number, to somebody who asked
        // for names — and it only read correctly in production because a
        // regex in `route.ts` swapped the string for this post
        // afterwards. §6.4's claim is that the composer writes the final
        // words, so it writes them.
        utterances.push({
          messageId: sp.messageId,
          text: composeSquadStatusPost({ confirmed, bench, maxPlayers: state.maxPlayers, lang }),
        });
        break;

      case "answer_fixture": {
        // Kickoff and venue, both pre-formatted by `load-state.ts`, and
        // NOTHING ELSE — deliberately no count.
        //
        // A count here would carry an `N/M` beside squad vocabulary,
        // which is rule (c) of `displaysSquadState`, so
        // `composeSquadStateReply` would drop this whole answer and post
        // the roster instead: the person who asked what time kickoff is
        // would get a list of names and no time. The same trap that kept
        // the STATS and OPTIONS answers refused until 2026-09-09, when
        // both were re-shaped to escape it rather than left unanswered.
        // See `answer-batch.ts`'s `ANSWERABLE_TOPICS`.
        utterances.push({
          messageId: sp.messageId,
          text: s.answer_fixture({ kickoffLabel: state.kickoffLabel, venue: state.venue.trim() }),
        });
        break;
      }

      case "answer_score": {
        // THE RESULT OF THE LAST MATCH PLAYED, in three sentences —
        // and the two that are not a scoreline are the point.
        //
        // `state.completedMatch` is the most recent match whose kickoff
        // PLUS duration has passed, in any of three statuses. A match
        // only becomes COMPLETED when somebody records a score, so an
        // ended Tuesday with nobody's report sits at TEAMS_PUBLISHED
        // with both scores null — which was the LIVE state on Sutton FC
        // the day this was written. "0 - 0" would be a fabricated
        // result; "we haven't played" would be false. Neither is said.
        //
        // The kickoff label is printed on every branch that has a match,
        // because this field is "the most recent ended match" and the
        // question is usually "did we win on TUESDAY?". If the two are
        // different nights, the reader can see it. Nothing else in this
        // answer can tell them.
        const m = state.completedMatch;
        if (!m) {
          utterances.push({ messageId: sp.messageId, text: s.answer_score_no_match });
          break;
        }
        if (m.redScore === null || m.yellowScore === null) {
          utterances.push({
            messageId: sp.messageId,
            text: s.answer_score_no_score({ kickoffLabel: m.kickoffLabel }),
          });
          break;
        }
        const [redLabel, yellowLabel] = state.teamLabels;
        utterances.push({
          messageId: sp.messageId,
          text: s.answer_score_result({
            kickoffLabel: m.kickoffLabel,
            redLabel,
            red: m.redScore,
            yellow: m.yellowScore,
            yellowLabel,
            winnerLabel:
              m.redScore === m.yellowScore ? null : m.redScore > m.yellowScore ? redLabel : yellowLabel,
          }),
        });
        break;
      }

      case "answer_payments": {
        // WHO HAS NOT PAID — as a COUNT. There is no branch below that
        // can print a name, because `PaymentSnapshot` has no field a
        // name could come out of (`payment-answer.ts` returns counts on
        // purpose). `buildUnpaidTail` posts the same shape to the same
        // group and says why: "Poll-only format per Sait's suggestion
        // (2026-04-25). No naming, no shaming."
        //
        // The question asked WHO, so the answer says out loud that it is
        // not going to say. A count with no explanation reads as a bot
        // that misunderstood; a count with one reads as a bot with a
        // rule.
        const p = state.payments;
        if (!p) {
          // NOT LOADED. `answer-batch.ts` does the payment load only when
          // a `payments` topic survived ownership, so reaching here means
          // the intent was emitted without it. Saying nothing sends this
          // message to that module's silent-id check, which disowns it —
          // a hand-back with a receipt rather than an empty answer.
          operatorNotes.push(
            `compose: answer_payments for ${sp.messageId} with no payment snapshot loaded; saying nothing`,
          );
          break;
        }
        const text =
          p.kind === "not_tracked"
            ? s.answer_payments_not_tracked
            : p.kind === "no_settled_match"
              ? s.answer_payments_no_settled
              : p.kind === "no_signal"
                ? s.answer_payments_no_signal({ kickoffLabel: p.kickoffLabel })
                : p.unpaid === 0
                  ? s.answer_payments_all_settled({ kickoffLabel: p.kickoffLabel })
                  : s.answer_payments_unpaid({ unpaid: p.unpaid, chargeable: p.chargeable, kickoffLabel: p.kickoffLabel });
        utterances.push({ messageId: sp.messageId, text });
        break;
      }

      case "answer_rating_progress": {
        // HOW MANY HAVE RATED, AND WHO HAS NOT. Rendered by
        // `formatRatingProgressReply`, byte-for-byte the sentence the
        // deleted fast path posted: the copy is not the thing that went
        // wrong, and a rewrite would be an unreviewed change riding
        // along with a fix.
        //
        // THIS ANSWER NAMES NAMES, which `answer_payments` deliberately
        // cannot. That is why the engine gates it on the sender being an
        // admin — see `rating-progress-answer.ts`.
        const p = state.ratingProgress;
        if (!p) {
          // NOT LOADED. `answer-batch.ts` does the rating read only when
          // a `rating_progress` topic survived ownership, so reaching
          // here means the intent was emitted without it. Saying nothing
          // sends this message to that module's silent-id check, which
          // disowns it — a hand-back with a receipt rather than an empty
          // answer.
          operatorNotes.push(
            `compose: answer_rating_progress for ${sp.messageId} with no rating snapshot loaded; saying nothing`,
          );
          break;
        }
        utterances.push({ messageId: sp.messageId, text: formatRatingProgressReply(p, lang) });
        break;
      }

      case "answer_bench":
        utterances.push({
          messageId: sp.messageId,
          text: bench.length === 0 ? s.answer_bench_empty : s.answer_bench_list({ names: bench }),
        });
        break;

      case "answer_person_status": {
        const who = sp.userId
          ? name(state.roster.find((m) => m.userId === sp.userId)?.name ?? sp.personRef)
          : name(sp.personRef);
        const row = sp.userId ? state.rows.find((r) => r.userId === sp.userId) : undefined;
        const p = { who, kickoffLabel: state.kickoffLabel };
        const text =
          !row || row.status === "DROPPED"
            ? s.answer_person_not_down(p)
            : row.status === "BENCH"
              ? s.answer_person_bench(p)
              : s.answer_person_confirmed(p);
        utterances.push({ messageId: sp.messageId, text });
        break;
      }

      case "answer_phones": {
        // SQUAD-SCOPED, like the rule it replaced. `message-analyzer.ts`
        // answered this from "the Confirmed and Bench lists in the Match
        // Context", and the question it was answering is "anyone IN THE
        // SQUAD without a number?". (That prompt is deleted as of §10
        // step 8; the scoping rule is kept because it is right, not
        // because anything still enforces it from the other side.)
        //
        // `state.roster` is EVERY active membership, so an org-scoped
        // answer on a club that has been provisioning named guests for
        // months is a wall of names about people who are not playing —
        // and it is invisible to every net downstream, because a list of
        // names is not squad state and `composeSquadStateReply` never
        // looks at it. Found by an adversarial review of §10 step 7,
        // before the `question` route was ever switched on.
        const byId = new Map(state.roster.map((m) => [m.userId, m]));
        const missing = state.rows
          .filter((r) => r.status === "CONFIRMED" || r.status === "BENCH")
          .sort((a, b) => a.position - b.position)
          .filter((r) => byId.get(r.userId)?.hasPhone === false)
          .map((r) => name(byId.get(r.userId)?.name ?? ""));
        utterances.push({
          messageId: sp.messageId,
          text: missing.length === 0 ? s.answer_phones_none : s.answer_phones_missing({ names: missing }),
        });
        break;
      }

      case "answer_stats": {
        // Deterministic, from appearances. §3.2 S16 is the heaviest
        // section of the prompt at 2,091 tokens and its worst failure
        // ("top 3 most consistent" returning the squad roster) is a
        // composition bug, not a reasoning one.
        //
        // ⚠️ THE ROW FORMAT IS LOAD-BEARING AND IT IS NOT COSMETIC.
        // `route.ts:2480` runs `composeSquadStateReply` over every reply
        // this module produces (they reach `results` with
        // `handledBy: "llm"`, `route.ts:2126`), and anything
        // `displaysSquadState` recognises is REPLACED by the
        // upcoming-squad roster. A numbered run of two or more lines is
        // rule (a). The one thing that exempts it is
        // `isLeaderboardLine`, which wants an em-dash separator, a
        // percentage, the word "wins"/"votes"/"matches", or an "N/M ("
        // pattern.
        //
        // `1. Kemal Ediz (24)` had NONE of them — so the correct answer
        // was composed and then thrown away for the squad list, which is
        // the 2026-05-14 incident, which is why the topic was refused
        // for months rather than fixed. This is the house leaderboard
        // format (`match-history.ts:336`, `  1. Name — 4 wins`) and it
        // carries two of the four markers. Change the punctuation here
        // and the answer silently becomes a roster again;
        // `__tests__/answer-batch.test.ts` section 6 fails first.
        const byId = new Map(state.roster.map((m) => [m.userId, m.name]));
        const ranked = [...state.appearances]
          .filter((a) => byId.has(a.userId))
          .sort((a, b) => b.matches - a.matches)
          .slice(0, 3);
        // NAME THE WINDOW, ALWAYS. `state.appearances` is counted over
        // `load-state.ts`'s 30-day lookback, and the question the group
        // actually asks is "who's been most consistent this SEASON?"
        // (measured live, 2026-09-09). Answering a season question with
        // a month's data and not saying so is a quiet wrong answer —
        // the number is right and the claim is not. `state` carries the
        // window so this sentence cannot drift from what was counted.
        const windowDays = state.appearanceWindowDays;
        if (ranked.length === 0) {
          utterances.push({ messageId: sp.messageId, text: s.answer_stats_empty({ windowDays }) });
          break;
        }
        const rows = ranked.map((a, i) =>
          s.answer_stats_row({ rank: i + 1, name: name(byId.get(a.userId) ?? ""), matches: a.matches }),
        );
        utterances.push({
          messageId: sp.messageId,
          text: `${s.answer_stats_head({ windowDays })}\n${rows.join("\n")}`,
        });
        break;
      }

      case "answer_options": {
        // format-switch.ts computes both the arithmetic and the names.
        // The composer copies. On 2026-08-30 the model computed 8 − 5
        // (players per TEAM) instead of 8 − 10 (the format TOTAL) and
        // named three real people as losing their place when a switch
        // would have benched nobody. `benchedOnFormatSwitch` takes the
        // total and slices by position — the same rule
        // `switchMatchFormat` applies for real — so the wrong names are
        // not reachable from here. Nothing below recomputes anything:
        // `f.proposal` is a finished sentence.
        //
        // ⚠️ THE LEAD SPELLS THE COUNT OUT, AND THAT IS NOT A STYLE
        // CHOICE. It used to read "We're 8/14, need 6 more 🙏". An
        // "N/M" beside squad vocabulary is rule (c) of
        // `displaysSquadState`, and `route.ts:2480` REPLACES anything it
        // recognises with the upcoming-squad roster — so the whole
        // answer, arithmetic included, was dropped rather than appended
        // to. That is why this topic was refused for months. "8 of 14"
        // says the same thing to a human and carries no slash.
        // `__tests__/answer-batch.test.ts` section 6 pins it.
        const need = Math.max(0, state.maxPlayers - confirmed.length);
        const facts = buildFormatSwitchFacts({
          confirmedNames: confirmed,
          currentMaxPlayers: state.maxPlayers,
          alternatives: state.smallerFormats,
          lang,
        });
        const viable = facts.filter((f) => f.proposal !== null);
        const lines = [
          s.answer_options_lead({ confirmed: confirmed.length, maxPlayers: state.maxPlayers, need }),
        ];
        if (viable.length === 0) {
          lines.push(
            state.smallerFormats.length === 0 ? s.answer_options_no_formats : s.answer_options_none_viable,
          );
        } else {
          for (const f of viable) lines.push(f.proposal!);
        }
        utterances.push({ messageId: sp.messageId, text: lines.join(" ") });
        break;
      }

      case "teams_post": {
        const byId = new Map(state.roster.map((m) => [m.userId, m.name]));
        const side = (team: "RED" | "YELLOW") =>
          state.teams
            .filter((t) => t.team === team)
            .map((t) => ({ name: name(byId.get(t.userId) ?? "") }));
        utterances.push({
          messageId: sp.messageId,
          text: formatTeamsPost({
            redLabel: state.teamLabels[0],
            yellowLabel: state.teamLabels[1],
            red: side("RED"),
            yellow: side("YELLOW"),
            kickoff: state.kickoffLabel,
            venue: state.venue,
            lang,
          }),
        });
        break;
      }

      case "teams_not_generated":
        // Byte-identical to the shipped path (`route.ts:3712-3713` and
        // `3731-3732`). Keeping the words the same is the point: this is
        // a like-for-like move, and the group should not be able to tell
        // which code path answered it.
        utterances.push({ messageId: sp.messageId, text: s.teams_not_generated });
        break;

      case "guest_name_ask":
        utterances.push({
          messageId: sp.messageId,
          text: renderGuestNameAsk({ askerName: sp.askerName, body: sp.body, lang }),
        });
        break;

      case "score_ack":
        utterances.push({
          messageId: sp.messageId,
          text: s.score_ack({ redLabel: state.teamLabels[0], red: sp.red, yellow: sp.yellow, yellowLabel: state.teamLabels[1] }),
        });
        break;

      case "payment_ack":
        utterances.push({
          messageId: sp.messageId,
          text: s.payment_ack({ firstName: first(sp.payerName), count: sp.count }),
        });
        break;

      case "reminder_ack":
        // THE RESOLVED TIME, not the words the player used. "I'll give
        // you a nudge on Monday" is not a confirmation anybody can
        // check — it repeats the request back — and the whole point of
        // §3.2 S22 leaving the model is that the time is now a value the
        // server computed. `route.ts:3986-3992` says the resolved label
        // for the same reason. The phrase is only the fallback for a
        // caller that has not resolved one.
        utterances.push({
          messageId: sp.messageId,
          text: sp.whenLabel
            ? s.reminder_ack_resolved({ whenLabel: sp.whenLabel })
            : s.reminder_ack_unresolved({ phrase: sp.phrase }),
        });
        break;

      case "bench_offer_open": {
        // The bench-offer copy is owned by bench-offer-copy.ts and is
        // pinned to a feature flag (inbound reaction forwarding is dead
        // on the Pi, so the 👍 instruction must not be printed). The
        // dry-run only needs to say that an offer WOULD open; the real
        // wording stays where it lives.
        //
        // AND it must not survive the offer. A drop opens an offer and a
        // bench player can claim it LATER IN THE SAME BATCH, at which
        // point announcing it contradicts the squad post that follows —
        // the 2026-06-12 shape S36's single-post rule exists to prevent
        // — and `bench` is empty by then, so the sentence had a dangling
        // comma where the names should be.
        if (bench.length === 0) break;
        utterances.push({
          messageId: sp.messageId,
          text: s.bench_offer_open({ benchNames: bench }),
        });
        break;
      }

      case "slot_opened": {
        // ── A COMPLETE SQUAD IS NOT COMPLETE ANY MORE ───────────────
        //
        // The whole post, in one sentence: who went, where the count
        // stands, and the one thing a reader can do about it. Composed
        // rather than the fourteen-line roster because the roster is
        // what PR #63 was asked to stop sending on every squad change,
        // and because "say *IN* to take it" is the half of this the
        // roster has never carried.
        //
        // ⚠️ "13 OF 14", NEVER "13/14", AND THAT IS NOT A STYLE CHOICE.
        // An "N/M" beside squad vocabulary is rule (c) of
        // `displaysSquadState`, and `route.ts`'s `composeSquadStateReply`
        // pass REPLACES anything it recognises with the composed roster
        // — so the slash would delete this sentence and post the very
        // thing it exists instead of. Same trap that kept the STATS and
        // OPTIONS answers refused for months (`answer_options` above
        // spells out its count for the same reason), and the house style
        // has no slashes in prose anyway.
        //
        // ⚠️ "SLOT", NEVER "SPOT", AND THAT IS NOT A STYLE CHOICE
        // EITHER. `contradictsSquadState` measures
        // `/(one|a|an|two|three|\d+)\s+(?:more\s+)?slots?\s+open/`
        // against the REAL shortfall in the post-write snapshot, and
        // "<Name> is out" against that player's real row. Saying "spot"
        // would slip past the check — which is the wrong kind of clever:
        // both halves of this sentence are claims about the squad, and
        // the point of §6.4 is that such claims are checked against the
        // database rather than trusted. Written this way, a slot that
        // got filled between the projection and the writes landing gets
        // the roster instead of a wrong number.
        //
        // NAMES ONLY THE PLAYERS WHO ARE ACTUALLY OUT. A confirmed
        // player moving to the bench vacates a slot without being out,
        // and the engine keeps the two apart (`vacancies[].wentOut`) so
        // this cannot say otherwise. With nobody out, the sentence just
        // leads with the count.
        const open = Math.max(0, state.maxPlayers - confirmed.length);
        if (open === 0) {
          // The projection says a slot opened and the state in hand says
          // it is full. Unreachable from `decide` (the engine computes
          // both from the same working state), so this is the branch
          // that stops a future caller composing "0 slots open" rather
          // than a live condition. Say nothing; the roster post and the
          // 17:00 block both still describe a full squad correctly.
          operatorNotes.push(
            `compose: slot_opened for ${sp.messageId} with a full squad; saying nothing`,
          );
          break;
        }
        utterances.push({
          messageId: sp.messageId,
          text: s.slot_opened({
            outFirstNames: sp.outNames.map(first),
            confirmed: confirmed.length,
            maxPlayers: state.maxPlayers,
            kickoffLabel: state.kickoffLabel,
            open,
          }),
        });
        break;
      }

      case "needs_tag_for_rest": {
        // WHAT MATCHTIME DID NOT DO, named. The engine has already
        // decided this sentence is allowed (it only emits the intent
        // beside a write, so this rides the squad post rather than
        // speaking on its own), and it has already resolved every name
        // against the roster. All that is left here is the wording.
        //
        // It says the REFUSED half only. The applied half is in the
        // squad post one message later, and repeating it here is the
        // two-rosters-one-line-apart shape S36 exists to prevent.
        const benched = sp.entries.filter((e) => e.action === "BENCH").map((e) => name(e.name));
        const dropped = sp.entries.filter((e) => e.action === "OUT").map((e) => name(e.name));
        if (dropped.length === 0 && benched.length === 0) break;
        utterances.push({ messageId: sp.messageId, text: s.needs_tag_for_rest({ dropped, benched }) });
        break;
      }

      case "bench_claim_too_late": {
        const who = first(state.roster.find((m) => m.userId === sp.userId)?.name ?? "");
        utterances.push({
          messageId: sp.messageId,
          text: s.bench_claim_too_late({ firstName: who, confirmed: confirmed.length, maxPlayers: state.maxPlayers }),
        });
        break;
      }

      case "pending_confirmed_ack": {
        const byId = new Map(state.roster.map((m) => [m.userId, m.name]));
        const down = sp.userIds
          .filter((id) => {
            const row = state.rows.find((r) => r.userId === id);
            return row && row.status !== "DROPPED";
          })
          .map((id) => name(byId.get(id) ?? ""));
        // Composed from the PROJECTED state, so it can only name people
        // who actually have a place. An empty list means the
        // confirmation resolved to nobody, and then we say nothing
        // rather than inventing a cheerful tick.
        if (down.length === 0) break;
        utterances.push({
          messageId: sp.messageId,
          text: s.pending_confirmed_ack({ names: down, kickoffLabel: state.kickoffLabel }),
        });
        break;
      }

      case "degraded":
        operatorNotes.push(sp.reason);
        break;
    }
  }

  for (const o of result.outcomes) {
    if (o.react) reacts.push({ messageId: o.messageId, emoji: o.react });
  }
  for (const d of result.degradations) {
    operatorNotes.push(`[${d.stage}${d.messageId ? ` ${d.messageId}` : ""}] ${d.detail}`);
  }

  return { utterances, reacts, operatorNotes };
}

/** Exposed for the corpus adapter: what MatchTime would SAY, in order. */
export function spokenText(out: ComposedOutput): string[] {
  return out.utterances.map((u) => u.text);
}

/** Only used by the person-status answer; kept here so the composer has
 *  a single import surface. */
export { resolvePerson };
