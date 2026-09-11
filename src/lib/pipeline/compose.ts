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

function safeName(name: string): string {
  const t = (name ?? "").trim();
  if (!t) return "a player";
  if (RAW_PHONE.test(t) || !/\p{L}/u.test(t)) return "a player";
  return t;
}

function firstName(name: string): string {
  return safeName(name).split(/\s+/)[0];
}

function namesByStatus(state: SquadState, status: "CONFIRMED" | "BENCH"): string[] {
  const byId = new Map(state.roster.map((m) => [m.userId, m.name]));
  return state.rows
    .filter((r) => r.status === status)
    .sort((a, b) => a.position - b.position)
    .map((r) => safeName(byId.get(r.userId) ?? ""));
}

function joinList(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function compose(result: EngineResult): ComposedOutput {
  const state = result.nextState;
  const utterances: Utterance[] = [];
  const reacts: Array<{ messageId: string; emoji: string }> = [];
  const operatorNotes: string[] = [];

  const confirmed = namesByStatus(state, "CONFIRMED");
  const bench = namesByStatus(state, "BENCH");

  for (const s of result.speech) {
    switch (s.kind) {
      case "squad_status":
        // The composer that already existed and was only ever used as a
        // fallback. Promoted, not rewritten (§13).
        utterances.push({
          messageId: null,
          text: composeSquadStatusPost({ confirmed, bench, maxPlayers: state.maxPlayers }),
        });
        break;

      case "answer_count": {
        const need = Math.max(0, state.maxPlayers - confirmed.length);
        const head =
          s.statedCount !== null && s.statedCount !== confirmed.length
            ? `Not quite, we're ${confirmed.length}/${state.maxPlayers} for ${state.kickoffLabel}`
            : `We're ${confirmed.length}/${state.maxPlayers} for ${state.kickoffLabel}`;
        const tail = need > 0 ? `, need ${need} more 🙏` : " ✅ full squad.";
        utterances.push({ messageId: s.messageId, text: `${head}${tail}` });
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
          messageId: s.messageId,
          text: composeSquadStatusPost({ confirmed, bench, maxPlayers: state.maxPlayers }),
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
        const where = state.venue.trim();
        utterances.push({
          messageId: s.messageId,
          text: where
            ? `⚽ ${state.kickoffLabel} at ${where}.`
            : `⚽ ${state.kickoffLabel}.`,
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
          utterances.push({
            messageId: s.messageId,
            text: "I haven't got a played match on record for this group yet.",
          });
          break;
        }
        if (m.redScore === null || m.yellowScore === null) {
          utterances.push({
            messageId: s.messageId,
            text: `No score reported for ${m.kickoffLabel} yet — tell me the result and I'll record it.`,
          });
          break;
        }
        const [redLabel, yellowLabel] = state.teamLabels;
        const line = `${redLabel} ${m.redScore} - ${m.yellowScore} ${yellowLabel}`;
        const verdict =
          m.redScore === m.yellowScore
            ? "A draw."
            : `${m.redScore > m.yellowScore ? redLabel : yellowLabel} won.`;
        utterances.push({
          messageId: s.messageId,
          text: `⚽ ${m.kickoffLabel}: ${line}. ${verdict}`,
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
            `compose: answer_payments for ${s.messageId} with no payment snapshot loaded; saying nothing`,
          );
          break;
        }
        const text =
          p.kind === "not_tracked"
            ? "I don't track payments for this group, so I can't say who's settled up."
            : p.kind === "no_settled_match"
              ? "There's no settled match for me to check payments against yet."
              : p.kind === "no_signal"
                ? `No payments have reached me for ${p.kickoffLabel} — that could mean nobody's paid, or that I'm just not seeing them, so I'd rather not put a number on it.`
                : p.unpaid === 0
                  ? `💳 All settled for ${p.kickoffLabel} 🙌`
                  : `💳 ${p.unpaid} of ${p.chargeable} still to pay for ${p.kickoffLabel}. I don't put names to that in the group.`;
        utterances.push({ messageId: s.messageId, text });
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
            `compose: answer_rating_progress for ${s.messageId} with no rating snapshot loaded; saying nothing`,
          );
          break;
        }
        utterances.push({ messageId: s.messageId, text: formatRatingProgressReply(p) });
        break;
      }

      case "answer_bench":
        utterances.push({
          messageId: s.messageId,
          text:
            bench.length === 0
              ? "Nobody's on the bench right now."
              : `On the bench: ${joinList(bench)}.`,
        });
        break;

      case "answer_person_status": {
        const who = s.userId
          ? safeName(state.roster.find((m) => m.userId === s.userId)?.name ?? s.personRef)
          : safeName(s.personRef);
        const row = s.userId ? state.rows.find((r) => r.userId === s.userId) : undefined;
        const text =
          !row || row.status === "DROPPED"
            ? `${who} isn't down for ${state.kickoffLabel} yet.`
            : row.status === "BENCH"
              ? `${who} is on the bench for ${state.kickoffLabel}.`
              : `Yes, ${who} has a slot for ${state.kickoffLabel}.`;
        utterances.push({ messageId: s.messageId, text });
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
          .map((r) => safeName(byId.get(r.userId)?.name ?? ""));
        utterances.push({
          messageId: s.messageId,
          text:
            missing.length === 0
              ? "Everyone in the squad has a number on record."
              : `No number on record for ${joinList(missing)}.`,
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
        const window = `last ${state.appearanceWindowDays} days`;
        if (ranked.length === 0) {
          utterances.push({
            messageId: s.messageId,
            text: `I don't have any completed matches in the ${window} to go on, so I can't call anyone the most consistent.`,
          });
          break;
        }
        const rows = ranked.map(
          (a, i) =>
            `${i + 1}. ${safeName(byId.get(a.userId) ?? "")} — ${a.matches} ${
              a.matches === 1 ? "match" : "matches"
            }`,
        );
        utterances.push({
          messageId: s.messageId,
          text: `Most appearances in the ${window}:\n${rows.join("\n")}`,
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
        });
        const viable = facts.filter((f) => f.proposal !== null);
        const lines = [
          need > 0
            ? `We're ${confirmed.length} of ${state.maxPlayers}, need ${need} more 🙏`
            : `We're ${confirmed.length} of ${state.maxPlayers} ✅ full squad.`,
        ];
        if (viable.length === 0) {
          lines.push(
            state.smallerFormats.length === 0
              ? "There's no smaller format set up for this group, so it's more players or nothing."
              : "No smaller format would be filled by the squad we have, so it's more players.",
          );
        } else {
          for (const f of viable) lines.push(f.proposal!);
        }
        utterances.push({ messageId: s.messageId, text: lines.join(" ") });
        break;
      }

      case "teams_post": {
        const byId = new Map(state.roster.map((m) => [m.userId, m.name]));
        const side = (team: "RED" | "YELLOW") =>
          state.teams
            .filter((t) => t.team === team)
            .map((t) => ({ name: safeName(byId.get(t.userId) ?? "") }));
        utterances.push({
          messageId: s.messageId,
          text: formatTeamsPost({
            redLabel: state.teamLabels[0],
            yellowLabel: state.teamLabels[1],
            red: side("RED"),
            yellow: side("YELLOW"),
            kickoff: state.kickoffLabel,
            venue: state.venue,
          }),
        });
        break;
      }

      case "teams_not_generated":
        // Byte-identical to the shipped path (`route.ts:3712-3713` and
        // `3731-3732`). Keeping the words the same is the point: this is
        // a like-for-like move, and the group should not be able to tell
        // which code path answered it.
        utterances.push({
          messageId: s.messageId,
          text: "No teams generated yet — say 'generate the teams' and I'll sort them.",
        });
        break;

      case "guest_name_ask":
        utterances.push({
          messageId: s.messageId,
          text: renderGuestNameAsk({ askerName: s.askerName, body: s.body }),
        });
        break;

      case "score_ack":
        utterances.push({
          messageId: s.messageId,
          text: `Got it 👍 ${state.teamLabels[0]} ${s.red} - ${s.yellow} ${state.teamLabels[1]}, recorded.`,
        });
        break;

      case "payment_ack":
        utterances.push({
          messageId: s.messageId,
          text: `Noted 🙌 ${firstName(s.payerName)} covered ${s.count} ${s.count === 1 ? "player" : "players"}.`,
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
          messageId: s.messageId,
          text: s.whenLabel
            ? `👍 Got it — I'll DM you ${s.whenLabel}.`
            : `Will do 👍 I'll give you a nudge ${s.phrase}.`,
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
          messageId: s.messageId,
          text: `A slot just opened 🎟 ${joinList(bench)}, first to say IN takes it. Nobody gets dropped.`,
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
        const benched = s.entries.filter((e) => e.action === "BENCH").map((e) => safeName(e.name));
        const dropped = s.entries.filter((e) => e.action === "OUT").map((e) => safeName(e.name));
        const parts: string[] = [];
        if (dropped.length > 0) parts.push(`taken ${joinList(dropped)} out`);
        if (benched.length > 0) parts.push(`moved ${joinList(benched)} to the bench`);
        if (parts.length === 0) break;
        utterances.push({
          messageId: s.messageId,
          text:
            `One thing I've left alone: I've not ${parts.join(" or ")}. ` +
            `That bit needs an @Match Time tag, so tag me and I'll sort it 👍`,
        });
        break;
      }

      case "bench_claim_too_late": {
        const who = firstName(
          state.roster.find((m) => m.userId === s.userId)?.name ?? "",
        );
        utterances.push({
          messageId: s.messageId,
          text:
            `Thanks ${who} 🙏 someone got there first, so the squad is back to ` +
            `${confirmed.length}/${state.maxPlayers}. You're still on the bench and ` +
            `first in line if another slot opens.`,
        });
        break;
      }

      case "pending_confirmed_ack": {
        const byId = new Map(state.roster.map((m) => [m.userId, m.name]));
        const down = s.userIds
          .filter((id) => {
            const row = state.rows.find((r) => r.userId === id);
            return row && row.status !== "DROPPED";
          })
          .map((id) => safeName(byId.get(id) ?? ""));
        // Composed from the PROJECTED state, so it can only name people
        // who actually have a place. An empty list means the
        // confirmation resolved to nobody, and then we say nothing
        // rather than inventing a cheerful tick.
        if (down.length === 0) break;
        utterances.push({
          messageId: s.messageId,
          text: `Got it 🙌 ${joinList(down)} ${down.length === 1 ? "is" : "are"} down for ${state.kickoffLabel}.`,
        });
        break;
      }

      case "degraded":
        operatorNotes.push(s.reason);
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
