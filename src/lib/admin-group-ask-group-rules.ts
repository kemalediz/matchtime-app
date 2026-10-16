/**
 * "ASK THE GROUP IF ANYONE CAN PLAY", FROM HQ: THE PURE HALF (2026-10-16).
 *
 * The database half is `admin-group-ask-group.ts`; this holds the decision
 * and the words, so both are tested from plain values.
 *
 * ONE ASK PER OPENING. An opening is the next match with a given set of
 * confirmed players (`openingFingerprint`): a drop, or a place filled,
 * is a new opening and is asked about afresh. For the same opening:
 *
 *   never asked                    post (round 1)
 *   asked                          do not post again; tell the organiser
 *                                  when it was asked ("Ask me again and
 *                                  I'll post it again")
 *   told, and asked once more      that is the explicit "ask again": post
 *                                  (round 2), and so on
 *
 * So two organisers asking at once, or one asking twice by mistake, never
 * puts the same ask in the players' group twice, and an organiser who
 * really wants it posted again only has to say so after being told.
 *
 * THE WORDS. A first-come club gets the players' group's existing
 * place-open post (`slot_opened`, unchanged: an IN takes the place). An
 * organiser-pick club gets a post that is true for it: an IN goes on the
 * bench, the organisers pick, the picked player gets a DM
 * (`organiser-pick.ts` `announcePick`).
 */
import { createHash } from "node:crypto";
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";
import type { BenchPickMode } from "./squad-capacity";

export interface GroupAskStep {
  step: "post" | "told";
  round: number;
  at: Date;
}

export type GroupAskDecision =
  | { kind: "full" }
  | { kind: "post"; open: number; round: number }
  | { kind: "already"; open: number; round: number; askedAt: Date };

export function decideGroupAsk(p: { confirmed: number; maxPlayers: number; history: GroupAskStep[] }): GroupAskDecision {
  const open = Math.max(0, p.maxPlayers - p.confirmed);
  if (open === 0) return { kind: "full" };
  const latest = [...p.history].sort((a, b) => b.round - a.round || (a.step === b.step ? 0 : a.step === "told" ? -1 : 1))[0];
  if (!latest) return { kind: "post", open, round: 1 };
  if (latest.step === "told") return { kind: "post", open, round: latest.round + 1 };
  return { kind: "already", open, round: latest.round, askedAt: latest.at };
}

/** The confirmed players, in any order, as one short id. */
export function openingFingerprint(confirmedUserIds: string[]): string {
  return createHash("sha256").update([...confirmedUserIds].sort().join(",")).digest("hex").slice(0, 16);
}

/** The players' group post, true for the club's pick mode. */
export function buildGroupAskPost(p: {
  lang: Lang | string | null | undefined;
  pickMode: BenchPickMode | string | null | undefined;
  kickoffLabel: string;
  confirmed: number;
  maxPlayers: number;
  open: number;
}): string {
  const s = t(p.lang);
  if (p.pickMode === "organiser") return s.group_ask_organiser({ open: p.open, kickoffLabel: p.kickoffLabel });
  return s.slot_opened({ outFirstNames: [], confirmed: p.confirmed, maxPlayers: p.maxPlayers, kickoffLabel: p.kickoffLabel, open: p.open });
}
