/**
 * WHICH PLAYERS'-GROUP MESSAGES ARE A PASTED SQUAD LIST (2026-10-30).
 *
 * A fact from the ROUTER, never from the words: P1 of the "no string
 * parsing" sweep adds a signal to the router's answer for "this message is
 * a pasted squad list". Only a message so flagged is read by the squad
 * reader (`hq-squad-reader.ts`, `place: "players"`), so the reader is not
 * called on every message.
 *
 * The router's field is `RoutedMessage.pastedList` (#476). The e2e suite
 * flags messages through a stub file (`MT_TEST_PASTED_LIST_STUB_FILE`),
 * by id or by the trimmed body, as every other model seam does.
 */
import { readFileSync } from "node:fs";

export const PASTED_LIST_STUB_FILE_ENV = "MT_TEST_PASTED_LIST_STUB_FILE";

/** One routed message, as the gate returns it. Structural: the router's
 *  own type is P1's, and its new field is read by name here only. */
export interface RoutedForListSignal {
  messageId: string;
  [field: string]: unknown;
}

/**
 * PURE. Does the router say this message is a pasted squad list? Its
 * `pasted_list` answer, `RoutedMessage.pastedList` (#476).
 */
export function routerSaysPastedList(r: RoutedForListSignal | undefined): boolean {
  return r?.pastedList === true;
}

interface ListSignalStub {
  ids?: string[];
  bodies?: string[];
}

function stubFromEnv(env: Record<string, string | undefined> = process.env): ListSignalStub | null {
  const file = env[PASTED_LIST_STUB_FILE_ENV];
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ListSignalStub;
  } catch {
    return {};
  }
}

/**
 * The ids of the batch's messages the router flagged as a pasted list (or
 * the e2e stub did).
 */
export function pastedListIds(
  messages: Array<{ waMessageId: string; body: string }>,
  routes: RoutedForListSignal[],
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const byId = new Map(routes.map((r) => [r.messageId, r]));
  const stub = stubFromEnv(env);
  const out = new Set<string>();
  for (const m of messages) {
    const stubbed = !!stub && ((stub.ids ?? []).includes(m.waMessageId) || (stub.bodies ?? []).includes(m.body.trim()));
    if (stubbed || routerSaysPastedList(byId.get(m.waMessageId))) out.add(m.waMessageId);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// THE ONE THING A PASTED LIST MAY ALSO SAY: THE SENDER IS OUT
// ══════════════════════════════════════════════════════════════════════
//
// Moved here on 2026-10-30 from `pasted-roster-registration.ts`, which is
// deleted with `pasted-roster.ts`: which message IS a list is now a fact
// (the router's flag above, with the squad reader's answer), never the
// `parsePastedRoster` shape test on the words. The rule is unchanged.
//
// WHY THE SENDER'S OUT, AND ONLY IT (2026-09-07, PR #55): a message that
// is both a list and its sender's own drop ("can't make it lads, someone
// take my spot" above the list) must still drop him, or the squad reads
// full and the club turns up short. Everything else the attendance
// extractor reads off a list is discarded: a third party's claim is the
// write PR #39 exists to stop (PR #35: the same paste, the same world,
// `Nabeel` one run and `Adam, Amir, Ehtisham, Martin` the next), and the
// sender's own IN is the same hazard. Who a list registers is the squad
// reader's answer, checked against the database in the analyze route.

import type { Facts } from "./pipeline/types";

export interface ListFactsClamp {
  /** The facts the attendance engine may act on. `{kind:"none"}` when
   *  the message said nothing a pasted list is allowed to say. */
  facts: Facts;
  /** How many claims were removed, for the log line. */
  dropped: number;
}

/**
 * PURE. Clamp what the attendance engine may act on from a message the
 * router flagged as a pasted list: the sender's own OUT claims, nothing
 * else (no affirmation, no side request). Facts of any other kind become
 * nothing.
 */
export function clampPastedListFacts(facts: Facts): ListFactsClamp {
  if (facts.kind !== "attendance") {
    return { facts: facts.kind === "none" ? facts : { kind: "none" }, dropped: 0 };
  }
  const kept = facts.claims.filter((c) => c.subject === "sender" && c.polarity === "out");
  const dropped = facts.claims.length - kept.length;
  if (kept.length === 0) return { facts: { kind: "none" }, dropped };
  if (dropped === 0 && facts.affirmation === null && facts.sideRequests.length === 0) return { facts, dropped };
  return { facts: { kind: "attendance", claims: kept, affirmation: null, sideRequests: [] }, dropped };
}
