/**
 * A FORM NOTE WITH ITS AMOUNT: THE RULES (Kemal, 2026-11-10).
 *
 * "It would be nice if it tells explicitly how much rating adjustment it
 * made (not giving the final rating) so if I don't like it, I can get it
 * amended further."
 *
 * A player tells MatchTime how they will play in the next match ("@Match
 * Time reduce my strength, I'm tired"). The teams extractor's `form`
 * action reads who it is about and the amount, on the one scale the rating
 * adjuster uses (`form-scale.ts`); an amendment ("make it -1", "cancel my
 * adjustment") is the same action with the amount stated. This module
 * decides, from facts only:
 *   - the amount kept: clamped to plus or minus MAX_DELTA;
 *   - who may set a note for whom: a player for themselves, an organiser
 *     for anyone (the sender and the roles, never the words). A player
 *     talking about somebody else is acknowledged and nothing is stored:
 *     the adjuster reads it from the chat when the teams are made, as
 *     before;
 *   - the line MatchTime says: the adjustment, never a rating;
 *   - that a stored note WINS over the adjuster's delta for that player
 *     when the teams are made (it was stated or confirmed explicitly).
 *
 * Pure: no clock, no database. The adapter is `form-note.ts`.
 */
import { MAX_DELTA } from "./form-scale";
import type { RatingAdjustment } from "./rating-adjuster";
import { isSelfRef } from "./pipeline/engine";
import { stripLongDashes } from "./house-style";
import { formNoteCopy } from "./i18n/form-note";
import { joinList } from "./i18n/text";
import { normaliseLang, type Lang } from "./i18n/lang";

/** What the teams extractor read for one player (`TeamFacts.form`). */
export interface FormClaim {
  personRef: string;
  delta: number;
  reason: string;
}

/** Who sent the message, as code knows it. */
export interface FormSender {
  userId: string | null;
  /** OWNER or ADMIN of the club (`Member.isAdmin`), or anyone in HQ. */
  isOrganiser: boolean;
}

export interface PlannedNote {
  userId: string;
  delta: number;
  /** The amount asked for was past the cap. */
  clamped: boolean;
  reason: string;
}

/** A note as stored (`FormNote`). */
export interface StoredFormNote {
  userId: string;
  delta: number;
  reason: string;
}

const REASON_MAX = 80;

/** The amount kept: plus or minus MAX_DELTA, two decimals. Anything that is
 *  not a finite number is no adjustment. */
export function clampFormDelta(raw: number): { delta: number; clamped: boolean } {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { delta: 0, clamped: false };
  const clamped = Math.abs(raw) > MAX_DELTA;
  const bounded = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, raw));
  const delta = Math.round(bounded * 100) / 100;
  return { delta: delta === 0 ? 0 : delta, clamped };
}

/** A player for themselves; an organiser for anyone; an unknown sender for
 *  nobody. */
export function mayStoreFormNote(sender: FormSender, targetUserId: string): boolean {
  if (!sender.userId) return false;
  return sender.isOrganiser || sender.userId === targetUserId;
}

function cleanReason(reason: string): string {
  const one = stripLongDashes(String(reason ?? "").replace(/\s+/g, " ").trim());
  return one.length > REASON_MAX ? one.slice(0, REASON_MAX).trim() : one;
}

/**
 * What is stored from a message's claims. `userIdOf` is who-is-who's sure
 * pick for a quoted name (null: nobody sure). "me" is the sender. A claim
 * that cannot be stored (somebody else's, by a player; a name nobody is
 * sure of) is counted in `others`: it is acknowledged, and the adjuster
 * reads it from the chat. The same person twice: the last claim.
 */
export function planFormNotes(args: {
  claims: ReadonlyArray<FormClaim>;
  sender: FormSender;
  userIdOf: (ref: string) => string | null;
}): { store: PlannedNote[]; others: number } {
  const byUser = new Map<string, PlannedNote>();
  let others = 0;
  for (const c of args.claims) {
    const ref = String(c.personRef ?? "").trim();
    const userId = isSelfRef(ref) || ref === "" ? args.sender.userId : args.userIdOf(ref);
    if (!userId || !mayStoreFormNote(args.sender, userId)) {
      others++;
      continue;
    }
    const { delta, clamped } = clampFormDelta(c.delta);
    byUser.delete(userId);
    byUser.set(userId, { userId, delta, clamped, reason: cleanReason(c.reason) });
  }
  return { store: [...byUser.values()], others };
}

/** "-0.5", "+1", "-0.25"; Turkish "-0,5". Never a rating. */
export function formatFormDelta(delta: number, lang?: Lang | string | null): string {
  const n = Math.round(delta * 100) / 100;
  const s = `${n > 0 ? "+" : ""}${n}`;
  return normaliseLang(lang) === "tr" ? s.replace(".", ",") : s;
}

/** An amount different from the one just stated, for the "make it ..." hint. */
function exampleAmount(delta: number): number {
  if (delta <= -1) return -0.5;
  if (delta < 0) return -1;
  if (delta >= 1) return 0.5;
  return 1;
}

/**
 * The line MatchTime says once the notes are stored: each player's
 * adjustment and why, the game's weekday, whether the teams are already
 * made, and how to change it. Never the player's rating.
 */
export function formNoteSavedReply(args: {
  lang?: Lang | string | null;
  /** The match's weekday in the club's language ("Tuesday", "Salı"). */
  dayName: string;
  teamsMade: boolean;
  saved: ReadonlyArray<{ name: string; delta: number; reason: string; changed: boolean; clamped: boolean }>;
  /** The message also spoke about somebody whose note was not stored. */
  othersToo: boolean;
}): string {
  const c = formNoteCopy(args.lang);
  const parts = args.saved.map((n) =>
    n.delta === 0 ? c.noneFor({ name: n.name }) : c.amountFor({ amount: formatFormDelta(n.delta, args.lang), name: n.name, reason: n.reason }),
  );
  const allChanged = args.saved.length > 0 && args.saved.every((n) => n.changed);
  const head = (allChanged ? c.changed : c.saved)({ parts: joinList(args.lang, parts), day: args.dayName });
  const lines = [head];
  if (args.saved.some((n) => n.clamped)) lines.push(c.capped);
  if (args.teamsMade) lines.push(c.teamsMade);
  if (args.othersToo) lines.push(c.others);
  const firstMoved = args.saved.find((n) => n.delta !== 0);
  if (!allChanged && firstMoved) lines.push(c.amendHint({ example: formatFormDelta(exampleAmount(firstMoved.delta), args.lang) }));
  return lines.join(" ");
}

/** The reason on the `RatingAdjustment` audit row for a player whose
 *  stored note decided their adjustment. */
export function formNoteReason(note: { delta: number; reason: string }): string {
  if (note.delta === 0) return "Form note in the chat: no adjustment";
  return note.reason ? `Form note in the chat: ${note.reason}` : "Form note in the chat";
}

/**
 * A STORED NOTE WINS over the rating adjuster's delta for that player: it
 * was stated or confirmed explicitly. Everyone else keeps the adjuster's.
 * Applied whatever the adjuster did (it may have failed, or the club may be
 * at its AI cap). A note for somebody not playing changes nothing.
 */
export function formNotesWin(
  adjustments: ReadonlyMap<string, RatingAdjustment>,
  notes: ReadonlyArray<StoredFormNote>,
  playerIds: ReadonlyArray<string>,
): Map<string, RatingAdjustment> {
  const out = new Map(adjustments);
  const playing = new Set(playerIds);
  for (const n of notes) {
    if (!playing.has(n.userId)) continue;
    const { delta } = clampFormDelta(n.delta);
    out.set(n.userId, { playerId: n.userId, delta, reason: formNoteReason({ delta, reason: n.reason }), confidence: 1 });
  }
  return out;
}
