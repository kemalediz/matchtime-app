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
