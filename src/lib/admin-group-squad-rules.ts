/**
 * SQUAD CHANGES TYPED IN A CLUB'S ADMIN GROUP (2026-10-14): the pure half.
 *
 * Why: FNF (Friday Night Football, 18 players) runs its list in its admin
 * group. Admins write "Shehryar out", "put Bilal in", and paste the whole
 * numbered list of 18 there. Until this change MatchTime read none of it.
 *
 * This module holds what needs no database and no model:
 *
 *   - which router routes the admin group acts on (`ADMIN_GROUP_SQUAD_ROUTES`);
 *   - reading a pasted squad list (`readSquadPaste`), placing each name on a
 *     club member (`matchPastedName`) and diffing it against the squad
 *     (`diffPastedSquad`);
 *   - every sentence MatchTime says back, in the club's language.
 *
 * The impure halves: `admin-group-squad-change.ts` (one change, through the
 * router and the attendance engine) and `admin-group-paste.ts` (a pasted
 * list, a proposal, applied on YES).
 */
import { cleanName, parsePastedRoster, readListLine } from "./pasted-roster";
import { normaliseName } from "./name-normalise";
import { t } from "./i18n/t";
import type { Route } from "./pipeline/types";

/**
 * The router routes acted on in the admin group: attendance about the
 * sender or about another player. Everything else the router can say
 * (questions, teams, scores, admin ops, unsure, none) is left alone with
 * no reply, as the admin group always was.
 */
export const ADMIN_GROUP_SQUAD_ROUTES: ReadonlySet<Route> = new Set<Route>(["self_att", "other_att"]);

/** How long a pasted list waits for YES. The same 30 minutes as the
 *  organiser-pick "bring them in anyway? YES" question. */
export const PASTE_PROPOSAL_TTL_MS = 30 * 60 * 1000;

/** A pasted list with fewer playing names than this share of the places
 *  is not the squad (a list of who has not paid, say), and is ignored. */
const MIN_SHARE_OF_PLACES = 0.5;

// ── Reading a pasted list ─────────────────────────────────────────────

export interface SquadPaste {
  playing: string[];
  reserves: string[];
}

const RESERVE_HEADER = /^\s*(reserves?|subs?|substitutes?|standby|stand-by|yedekler?)\b\s*:?\s*$/i;
/** Words that make a line a change ("Bilal in"), never a name. */
const CHANGE_WORDS = new Set(["in", "out", "bench", "maybe", "yes", "no", "var", "yok", "yedek", "belki", "evet", "hayir", "gelemiyor", "geliyor"]);

function nameLikeLine(line: string): string | null {
  const name = cleanName(line);
  if (!name || name.length > 32 || /\d/.test(name) || /[?!;]/.test(line)) return null;
  const words = name.split(/\s+/);
  if (words.length > 4) return null;
  if (words.some((w) => CHANGE_WORDS.has(normaliseName(w).replace(/ı/g, "i")))) return null;
  return /\p{L}/u.test(name) ? name : null;
}

/**
 * One name per line, unnumbered: every non-blank line is a name, except
 * an optional title on the first line and a "Reserves:" header.
 */
function readPlainList(body: string): SquadPaste | null {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => readListLine(l))) return null;
  const playing: string[] = [];
  const reserves: string[] = [];
  let section: "playing" | "reserves" = "playing";
  for (let i = 0; i < lines.length; i++) {
    if (RESERVE_HEADER.test(lines[i])) {
      section = "reserves";
      continue;
    }
    const name = nameLikeLine(lines[i]);
    if (!name) {
      if (i === 0) continue; // a title
      return null;
    }
    (section === "playing" ? playing : reserves).push(name);
  }
  return { playing, reserves };
}

/**
 * Is this message the whole squad, pasted? Numbered or bulleted (the
 * shape `parsePastedRoster` reads everywhere else), or one name per line.
 * Null when it is not a list, or when the list is too short to be the
 * squad (fewer names than half the places).
 */
export function readSquadPaste(body: string, maxPlayers: number): SquadPaste | null {
  if (typeof body !== "string" || !body.includes("\n")) return null;
  const roster = parsePastedRoster(body);
  const paste: SquadPaste | null = roster
    ? {
        playing: roster.entries.filter((e) => e.name && e.nameLike).map((e) => e.name),
        reserves: roster.reserves.filter((e) => e.name && e.nameLike).map((e) => e.name),
      }
    : readPlainList(body);
  if (!paste) return null;
  const need = Math.max(4, Math.ceil(Math.max(1, maxPlayers) * MIN_SHARE_OF_PLACES));
  return paste.playing.length >= need ? paste : null;
}

// ── Placing a name on a member ────────────────────────────────────────

export interface PasteMember {
  userId: string;
  name: string | null;
  /** `UserAlias.alias` rows for this member (stored folded). */
  aliases: string[];
}

export type NameMatch = { kind: "member"; userId: string } | { kind: "new" } | { kind: "ambiguous" };

function fold(s: string): string {
  return normaliseName(s).replace(/ı/g, "i").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Which member a pasted name means, by the same rules the group's
 * third-party resolver uses (`resolveOrProvisionByName`): the whole name,
 * then an alias, then a unique first name (or a first name one is a prefix
 * of, three letters or more). Two candidates and none of them on this
 * match: ambiguous, and the list leaves that line out rather than guess.
 * `onMatch` is everyone with a row on the match: when only one candidate
 * is already there, that is who the list means.
 */
export function matchPastedName(raw: string, members: PasteMember[], onMatch: ReadonlySet<string> = new Set()): NameMatch {
  const name = fold(raw);
  if (!name) return { kind: "new" };
  const pick = (ids: string[]): NameMatch | null => {
    const unique = [...new Set(ids)];
    if (unique.length === 1) return { kind: "member", userId: unique[0] };
    if (unique.length > 1) {
      const here = unique.filter((id) => onMatch.has(id));
      return here.length === 1 ? { kind: "member", userId: here[0] } : { kind: "ambiguous" };
    }
    return null;
  };
  const exact = pick(members.filter((m) => m.name && fold(m.name) === name).map((m) => m.userId));
  if (exact) return exact;
  const alias = pick(members.filter((m) => m.aliases.some((a) => fold(a) === name)).map((m) => m.userId));
  if (alias) return alias;
  const first = name.split(" ")[0];
  const byFirst = members.filter((m) => {
    if (!m.name) return false;
    const mFirst = fold(m.name).split(" ")[0] ?? "";
    return (
      mFirst === first ||
      (mFirst.length >= 3 && first.length >= 3 && (mFirst.startsWith(first) || first.startsWith(mFirst)))
    );
  });
  return pick(byFirst.map((m) => m.userId)) ?? { kind: "new" };
}

// ── The diff ──────────────────────────────────────────────────────────

export type SquadRef = { userId: string } | { newName: string };
export type SquadStatus = "CONFIRMED" | "BENCH" | "DROPPED";

export interface SquadDiff {
  /** Into the squad. */
  add: SquadRef[];
  /** In the squad now, not in the list: out. */
  remove: Array<{ userId: string }>;
  /** Under the list's reserves header and not on the waiting list yet. */
  toBench: SquadRef[];
  same: boolean;
}

function keyOf(r: SquadRef): string {
  return "userId" in r ? `u:${r.userId}` : `n:${fold(r.newName)}`;
}

function dedupe(refs: SquadRef[]): SquadRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = keyOf(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The changes that turn the current squad into the pasted one. A player on
 * the waiting list whom the list does not mention is left where they are:
 * the list is the squad, and says nothing about the waiting list unless it
 * has a reserves block.
 */
export function diffPastedSquad(input: {
  playing: SquadRef[];
  reserves: SquadRef[];
  current: Array<{ userId: string; status: SquadStatus }>;
}): SquadDiff {
  const playing = dedupe(input.playing);
  const playingKeys = new Set(playing.map(keyOf));
  const reserves = dedupe(input.reserves).filter((r) => !playingKeys.has(keyOf(r)));
  const statusOf = new Map(input.current.map((c) => [c.userId, c.status]));
  const listed = new Set([...playing, ...reserves].map(keyOf));

  const add = playing.filter((r) => !("userId" in r) || statusOf.get(r.userId) !== "CONFIRMED");
  const toBench = reserves.filter((r) => !("userId" in r) || statusOf.get(r.userId) !== "BENCH");
  const remove = input.current
    .filter((c) => c.status === "CONFIRMED" && !listed.has(`u:${c.userId}`))
    .map((c) => ({ userId: c.userId }));
  return { add, remove, toBench, same: add.length === 0 && remove.length === 0 && toBench.length === 0 };
}

// ── YES ───────────────────────────────────────────────────────────────

/** A whole-message YES (or EVET), the same words the pick round reads. */
export function isAdminGroupYes(text: string): boolean {
  if (typeof text !== "string") return false;
  const folded = text.toLocaleLowerCase("tr").replace(/[.!\s]+$/g, "").trim();
  return folded === "yes" || folded === "evet";
}

// ── What MatchTime says ───────────────────────────────────────────────

export type SquadChangeKind = "in" | "out" | "bench" | "maybe";

export function buildSquadChangeReply(p: {
  lang: string | null | undefined;
  changes: Array<{ kind: SquadChangeKind; name: string }>;
  failed: string[];
  confirmed: number;
  maxPlayers: number;
}): string {
  const s = t(p.lang);
  const count = s.ag_sq_count({ confirmed: p.confirmed, max: p.maxPlayers });
  const parts: string[] = [];
  if (p.changes.length > 0) {
    const items = p.changes.map((c) =>
      c.kind === "in"
        ? s.ag_sq_item_in({ name: c.name })
        : c.kind === "out"
          ? s.ag_sq_item_out({ name: c.name })
          : c.kind === "bench"
            ? s.ag_sq_item_bench({ name: c.name })
            : s.ag_sq_item_maybe({ name: c.name }),
    );
    parts.push(s.ag_sq_done({ items: items.join(", ") }));
  }
  if (p.failed.length > 0) parts.push(s.ag_sq_failed({ names: p.failed.join(", ") }));
  if (parts.length === 0) parts.push(s.ag_sq_nothing);
  return `${parts.join(" ")} ${count}`;
}

export function buildPasteProposalReply(p: {
  lang: string | null | undefined;
  /** Known players coming into the squad. */
  add: string[];
  remove: string[];
  /** Everyone going to the waiting list, known or new. */
  toBench: string[];
  /** Names that are nobody in the club yet: added as new players. */
  newNames: string[];
  /** Names two players could be: left out. */
  unclear: string[];
  /** Playing names in the list, for the "too many names" line. */
  listed: number;
  maxPlayers: number;
}): string {
  const s = t(p.lang);
  const unclear = p.unclear.length > 0 ? s.ag_paste_unclear({ names: p.unclear.join(", ") }) : null;
  if (p.add.length === 0 && p.remove.length === 0 && p.toBench.length === 0 && p.newNames.length === 0) {
    return [s.ag_paste_same, unclear].filter(Boolean).join(" ");
  }
  const parts: string[] = [];
  if (p.add.length > 0) parts.push(s.ag_paste_adding({ names: p.add.join(", ") }));
  if (p.remove.length > 0) parts.push(s.ag_paste_removing({ names: p.remove.join(", ") }));
  if (p.toBench.length > 0) parts.push(s.ag_paste_to_bench({ names: p.toBench.join(", ") }));
  if (p.newNames.length > 0) parts.push(s.ag_paste_new({ names: p.newNames.join(", "), many: p.newNames.length > 1 }));
  if (unclear) parts.push(unclear);
  if (p.listed > p.maxPlayers) parts.push(s.ag_paste_over({ listed: p.listed, max: p.maxPlayers }));
  parts.push(s.ag_paste_confirm);
  return parts.join(" ");
}

export function buildPasteExpiredReply(lang: string | null | undefined): string {
  return t(lang).ag_paste_expired;
}
