/**
 * STAGE 4 — COMPOSITION.
 *
 * §6.4: "Every outgoing message is composed from the database AFTER the
 * writes land. `composeSquadStatusPost()` is the model; generalise it.
 * Numbers and names are never model-authored, so they cannot be wrong,
 * so nothing needs to check them afterwards."
 *
 * That last clause is a deletion list. Every one of these exists only
 * because the model authors user-visible squad text and gets it wrong,
 * and every one has nothing left to do once this file is the only path:
 *
 *   enforceCanonicalRoster        message-analyzer.ts:1482-1623, 140 lines
 *   rewriteOverconfidentPromotion message-analyzer.ts:1639-1710
 *   the promotion strips          route.ts:1318-1350
 *   enforceProximity              message-analyzer.ts:1335-1379
 *   the squad-status collapse     route.ts:1508-1582
 *   the 👍→✅/🪑 last-mile rewrite  route.ts:2151-2161
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
        const missing = state.roster.filter((m) => !m.hasPhone).map((m) => safeName(m.name));
        utterances.push({
          messageId: s.messageId,
          text:
            missing.length === 0
              ? "Everyone on the roster has a number on record."
              : `No number on record for ${joinList(missing)}.`,
        });
        break;
      }

      case "answer_stats": {
        // Deterministic, from appearances. §3.2 S16 is the heaviest
        // section of the prompt at 2,091 tokens and its worst failure
        // ("top 3 most consistent" returning the squad roster) is a
        // composition bug, not a reasoning one.
        const byId = new Map(state.roster.map((m) => [m.userId, m.name]));
        const ranked = [...state.appearances]
          .filter((a) => byId.has(a.userId))
          .sort((a, b) => b.matches - a.matches)
          .slice(0, 3);
        if (ranked.length === 0) {
          utterances.push({
            messageId: s.messageId,
            text: "I don't have enough completed matches yet to call anyone the most consistent.",
          });
          break;
        }
        const rows = ranked.map(
          (a, i) => `${i + 1}. ${safeName(byId.get(a.userId) ?? "")} (${a.matches})`,
        );
        utterances.push({
          messageId: s.messageId,
          text: `Most consistent by appearances:\n${rows.join("\n")}`,
        });
        break;
      }

      case "answer_options": {
        // format-switch.ts computes both the arithmetic and the names.
        // The composer copies. On 2026-08-30 the model computed 8 − 5
        // instead of 8 − 10 and named three real people as losing their
        // place when a switch would have benched nobody.
        const need = Math.max(0, state.maxPlayers - confirmed.length);
        const facts = buildFormatSwitchFacts({
          confirmedNames: confirmed,
          currentMaxPlayers: state.maxPlayers,
          alternatives: state.smallerFormats,
        });
        const viable = facts.filter((f) => f.proposal !== null);
        const lines = [`We're ${confirmed.length}/${state.maxPlayers}, need ${need} more 🙏`];
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
        utterances.push({
          messageId: s.messageId,
          text: `Will do 👍 I'll give you a nudge ${s.phrase}.`,
        });
        break;

      case "bench_offer_open":
        // The bench-offer copy is owned by bench-offer-copy.ts and is
        // pinned to a feature flag (inbound reaction forwarding is dead
        // on the Pi, so the 👍 instruction must not be printed). The
        // dry-run only needs to say that an offer WOULD open; the real
        // wording stays where it lives.
        utterances.push({
          messageId: s.messageId,
          text: `A slot just opened 🎟 ${joinList(bench)}, first to say IN takes it. Nobody gets dropped.`,
        });
        break;

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
