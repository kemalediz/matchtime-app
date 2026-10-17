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
import type { AttendanceFacts, Claim, Route } from "./pipeline/types";

/**
 * The router routes acted on in the admin group: attendance about the
 * sender or about another player, and `unsure` (about a place, but the
 * router could not tell who or what; also a failed router call), which
 * `admin-group-understand.ts` hands over only for a message addressed to
 * MatchTime (2026-10-16), as the players' group hands it to the same
 * engine. Every claim still goes through `vetAdminGroupFacts`. Everything
 * else the router can say (questions, teams, scores, admin ops, none) is
 * not a squad change.
 */
export const ADMIN_GROUP_SQUAD_ROUTES: ReadonlySet<Route> = new Set<Route>(["self_att", "other_att", "unsure"]);

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
  const ids = nameCandidates(raw, members);
  if (ids.length === 1) return { kind: "member", userId: ids[0] };
  if (ids.length > 1) {
    const here = ids.filter((id) => onMatch.has(id));
    return here.length === 1 ? { kind: "member", userId: here[0] } : { kind: "ambiguous" };
  }
  return { kind: "new" };
}

/**
 * Who a typed name could be, by the rules above, in order: the whole name,
 * then an alias, then a first name (or a first name one is a prefix of,
 * three letters or more). The first rule that finds anyone decides; the
 * ids come back without repeats, in `members` order. Empty: nobody. Also
 * read by the team commands in the admin group (`team-proposal-rules.ts`),
 * with `members` the players on the teams, so a name there means what it
 * means in a pasted list.
 */
export function nameCandidates(raw: string, members: PasteMember[]): string[] {
  const name = fold(typeof raw === "string" ? raw : "");
  if (!name) return [];
  const uniq = (ids: string[]) => [...new Set(ids)];
  const exact = uniq(members.filter((m) => m.name && fold(m.name) === name).map((m) => m.userId));
  if (exact.length) return exact;
  const alias = uniq(members.filter((m) => m.aliases.some((a) => fold(a) === name)).map((m) => m.userId));
  if (alias.length) return alias;
  const first = name.split(" ")[0];
  return uniq(
    members
      .filter((m) => {
        if (!m.name) return false;
        const mFirst = fold(m.name).split(" ")[0] ?? "";
        return (
          mFirst === first ||
          (mFirst.length >= 3 && first.length >= 3 && (mFirst.startsWith(first) || first.startsWith(mFirst)))
        );
      })
      .map((m) => m.userId),
  );
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
  /** Names nobody in the club has that cannot be a player's name either
   *  ("WhatsApp", a phone number): left out, said before the YES. */
  cannotAdd?: string[];
  /** Playing names in the list, for the "too many names" line. */
  listed: number;
  maxPlayers: number;
}): string {
  const s = t(p.lang);
  const unclear = p.unclear.length > 0 ? s.ag_paste_unclear({ names: p.unclear.join(", ") }) : null;
  const cannotAdd = p.cannotAdd ?? [];
  const refused = cannotAdd.length > 0 ? s.ag_paste_cannot_add({ names: cannotAdd.join(", "), many: cannotAdd.length > 1 }) : null;
  if (p.add.length === 0 && p.remove.length === 0 && p.toBench.length === 0 && p.newNames.length === 0) {
    return [s.ag_paste_same, unclear, refused].filter(Boolean).join(" ");
  }
  const parts: string[] = [];
  if (p.add.length > 0) parts.push(s.ag_paste_adding({ names: p.add.join(", ") }));
  if (p.remove.length > 0) parts.push(s.ag_paste_removing({ names: p.remove.join(", ") }));
  if (p.toBench.length > 0) parts.push(s.ag_paste_to_bench({ names: p.toBench.join(", ") }));
  if (p.newNames.length > 0) parts.push(s.ag_paste_new({ names: p.newNames.join(", "), many: p.newNames.length > 1 }));
  if (unclear) parts.push(unclear);
  if (refused) parts.push(refused);
  if (p.listed > p.maxPlayers) parts.push(s.ag_paste_over({ listed: p.listed, max: p.maxPlayers }));
  parts.push(s.ag_paste_confirm);
  return parts.join(" ");
}

export function buildPasteExpiredReply(lang: string | null | undefined): string {
  return t(lang).ag_paste_expired;
}

/**
 * A squad list pasted when the club has no game to put it on (2026-10-15).
 * `nextRunTime` is the London wall clock ("01:00") of the nightly cron
 * that makes the next game; null when the club has no active weekly game,
 * so the cron would make nothing and the reply says to add one.
 */
export function buildPasteNoMatchReply(p: { lang: string | null | undefined; nextRunTime: string | null }): string {
  const s = t(p.lang);
  return p.nextRunTime === null ? s.ag_paste_no_weekly_game : s.ag_paste_no_game({ time: p.nextRunTime });
}

// ── An organiser's sentence in HQ: instruction or conversation? ───────
//
// WHY (2026-10-15). The live club rehearsal replayed a real organisers'
// group and found ordinary conversation there turned into squad writes and
// false lines: a confirmed player's "might have to pull out" answered
// "Nothing to change: the squad already says that", the same player's next
// message about an injured foot took him out of the squad, and a name in
// passing ("X is back as well", X nobody in the club) answered "Nothing to
// change" too. Traced in code: `admin-group-squad-change.ts` handed every
// claim the extractor read to the attendance engine, which reads a message
// exactly as it would in the players' group (where a player's own injury
// report rightly frees his place), and it replied "Nothing to change"
// whenever the extractor had read ANY claim and nothing moved, whether the
// engine had declined the claim (contingent, availability, past) or the
// squad already said it.
//
// HQ is where the organisers talk. Silence is the default there, and only
// an INSTRUCTION is applied. What follows reads the extractor's facts as
// they are (no prompt changed) plus the shape of the sentence, with no
// model and no database: `admin-group-squad-change.ts` supplies the name
// resolver and the squad as it stands.

/** The engine's own confidence floor (`pipeline/engine.ts`). */
const HQ_CONFIDENCE_FLOOR = 0.7;

/** Why a claim read in HQ is NOT applied. Null: it is an instruction. */
export type AdminClaimHold =
  /** "if", "might", "may have to": tentative or conditional. */
  | "contingent"
  /** past or hypothetical: never a registration. */
  | "not-now"
  /** reports what someone can do ("I'm injured"), not a decision. */
  | "availability"
  /** relays what someone else said. */
  | "reported"
  /** below the engine's confidence floor. */
  | "unsure"
  /** a statement in conversation, not a command. */
  | "not-a-command"
  /** an instruction, but the game's list is not set yet: the rolling
   *  squad is still to be carried over (2026-10-17). */
  | "not-set";

/** Words that carry no instruction and no content either way. Folded. */
const HQ_FILLER = new Set([
  // English
  "please", "pls", "plz", "can", "could", "would", "you", "u", "mt", "matchtime", "match", "time", "also", "too",
  "then", "now", "ok", "okay", "so", "and", "just", "lads", "guys", "is", "are", "s", "he", "she", "they", "for",
  "this", "week", "weekend", "fri", "friday", "tonight", "today", "tomorrow", "the", "a", "an", "game", "sir",
  "bro", "mate", "yeah", "yep", "as", "well", "i", "im", "m", "am", "me", "myself", "has", "have", "been",
  "again", "list", "squad", "t", "ll", "d", "re", "ve",
  // Turkish
  "bu", "hafta", "cuma", "de", "da", "lutfen", "abi", "ve", "ile", "simdi", "ben", "beni", "yi", "i", "u",
  "yu", "e", "a", "ye", "ya",
]);

/** Words a squad instruction is built from. Folded. */
const HQ_COMMAND = new Set([
  // English
  "put", "add", "bring", "get", "move", "take", "drop", "remove", "bench", "swap", "sub", "stick", "pop", "mark",
  "register", "book", "replace", "replacing", "replaces", "instead", "of", "with", "kick", "count", "in", "out",
  "off", "on", "to", "into", "onto", "from", "reserve", "reserves", "waiting", "back", "dropping", "dropped",
  "drops", "pulled", "pulling", "pulls", "cant", "cannot", "can", "make", "it", "not", "isn", "isnt", "coming",
  "playing", "play", "him", "her", "them",
  // future and negative auxiliaries (review of #269): "Mo will play", "Ravi
  // won't be playing", "Ali is going to play", "Kofi is joining us". They
  // carry no direction of their own, so "will be good to see Mo" stays held.
  "will", "won", "wont", "be", "going", "gonna", "us", "join", "joins", "joining",
  // Turkish
  "var", "varim", "yok", "yokum", "yedek", "yedege", "yedekte", "ekle", "cikar", "sil", "al", "kadroya",
  "kadrodan", "listeye", "listeden", "gelmiyor", "gelemiyor", "geliyor", "gelecek", "gelmeyecek", "cikti",
  "girdi", "yerine", "oynamiyor", "oynuyor", "oynayacak", "oynamayacak",
]);

/** The command words that give an instruction its direction. "back" alone
 *  ("X is back as well") is not one: it says where somebody is, not what to do. */
const HQ_ANCHOR = new Set([
  "put", "add", "bring", "move", "take", "drop", "remove", "bench", "swap", "sub", "replace", "replacing",
  "replaces", "kick", "count", "in", "out", "off", "reserve", "reserves", "dropping", "dropped", "drops",
  "pulled", "pulls", "cant", "cannot", "make", "coming", "playing", "play", "register", "book", "mark",
  "join", "joins", "joining",
  "var", "varim", "yok", "yokum", "yedek", "yedege", "yedekte", "ekle", "cikar", "sil", "kadroya", "kadrodan",
  "listeye", "listeden", "gelmiyor", "gelemiyor", "geliyor", "gelecek", "gelmeyecek", "cikti", "girdi",
  "yerine", "oynamiyor", "oynuyor", "oynayacak", "oynamayacak",
]);

/** The sender naming themselves in a command ("put me in"). Folded. */
const SELF_MARKERS = new Set(["i", "im", "me", "myself", "ben", "beni"]);

function hqWords(s: string): string[] {
  return fold(typeof s === "string" ? s : "").split(" ").filter(Boolean);
}

/** The clauses of a message, each as folded words. */
function hqClauses(body: string): string[][] {
  return (typeof body === "string" ? body : "")
    .split(/[,.;:!?\n]+|\s[-&+/]\s/)
    .map(hqWords)
    .filter((w) => w.length > 0);
}

/**
 * Is `clause`, once the names in the message are taken out, made only of
 * filler and command words, with at least one word that gives a direction?
 * "Kai out", "put Kai in", "Kai can't make it", "Kai'yi yedeğe al": yes.
 * "Kai is back as well", "Kai is in the hospital": no.
 */
function isCommandClause(clause: string[], names: ReadonlySet<string>): boolean {
  const rest = clause.filter((w) => !names.has(w) && !HQ_FILLER.has(w));
  return rest.length > 0 && rest.every((w) => HQ_COMMAND.has(w)) && rest.some((w) => HQ_ANCHOR.has(w));
}

/**
 * Why this claim, read from an organiser's message in the admin group, is
 * not applied; null when it is an explicit instruction.
 *
 * Every claim must be definite (not contingent, not past or hypothetical,
 * a decision rather than availability, not relayed, above the engine's
 * confidence floor). Then:
 *
 *   - about the SENDER: a bare IN/OUT (`bareDeclaration`, the router's own
 *     floor), a stated wish for the bench, or a command naming them ("put
 *     me in", "I'm out this week", "<own name> out"). A sentence about
 *     themselves ("won't be around on Friday", "my ankle is wrecked") is held.
 *   - about SOMEONE ELSE: the clause that names them must be a command
 *     ("put X in", "X out", "X can't make it", "X yok"). "X is back as well"
 *     is held.
 */
export function adminClaimHold(p: {
  body: string;
  claim: Claim;
  /** Every claim in the message: their names are not words of a sentence. */
  claims: Claim[];
  senderName: string | null;
  bareDeclaration: boolean;
  /** The names the router's floor read as a list with a bare IN/OUT
   *  ("Imti\nRafi\nAH\n\nIn", `floorAttendanceFacts`): each is the
   *  instruction, as a bare IN/OUT is for the sender. */
  listedNames?: readonly string[];
}): AdminClaimHold | null {
  const c = p.claim;
  const self = c.subject === "sender";
  if (c.contingent) return "contingent";
  if (c.tense === "past" || c.tense === "hypothetical") return "not-now";
  if (self && p.bareDeclaration) return null;
  if (c.basis === "availability") return "availability";
  if (c.reported) return "reported";
  if (c.confidence < HQ_CONFIDENCE_FLOOR) return "unsure";
  if (!self && c.personRef && (p.listedNames ?? []).some((n) => fold(n) === fold(c.personRef))) return null;
  if (self && c.polarity === "bench") return null;

  const names = new Set(p.claims.flatMap((x) => [...hqWords(x.personRef ?? ""), ...hqWords(x.replaces ?? "")]));
  const clauses = hqClauses(p.body);
  if (self) {
    const own = new Set(hqWords(p.senderName ?? ""));
    const mine = new Set([...names, ...own, ...SELF_MARKERS]);
    const ok = clauses.some((cl) => cl.some((w) => own.has(w) || SELF_MARKERS.has(w)) && isCommandClause(cl, mine));
    return ok ? null : "not-a-command";
  }
  const first = hqWords(c.personRef ?? "")[0];
  if (!first) return "not-a-command";
  const ok = clauses.some((cl) => cl.includes(first) && isCommandClause(cl, names));
  return ok ? null : "not-a-command";
}

/** Who a claim is about, as `admin-group-squad-change.ts` resolved it. */
export type AdminClaimRef =
  | { kind: "member"; userId: string; name: string }
  /** a real name nobody in the club has */
  | { kind: "unknown"; name: string }
  /** two or more members could be meant */
  | { kind: "ambiguous"; name: string }
  /** not a person ("my brother", raw digits) */
  | { kind: "none" };

export interface VettedClaim {
  claim: Claim;
  self: boolean;
  /** Null: applied. */
  hold: AdminClaimHold | null;
  ref: AdminClaimRef;
  /** Their status on the match BEFORE the message; null with no row. */
  before: SquadStatus | null;
}

/**
 * The facts the attendance engine may act on in HQ: the explicit claims
 * only, and never a bare affirmation (a "yeah" in HQ points at nothing
 * MatchTime said there). `vetted` keeps every claim, with why it was held
 * and who it is about, for the reply.
 */
export function vetAdminGroupFacts(p: {
  body: string;
  facts: AttendanceFacts;
  senderUserId: string;
  senderName: string | null;
  bareDeclaration: boolean;
  /** The names the floor read as a list with a bare IN/OUT (`adminClaimHold`). */
  listedNames?: readonly string[];
  /** The game's list is not set yet (`rollingSeedPendingAt`): nothing is
   *  applied, and an instruction is held as "not-set". */
  listNotSet?: boolean;
  resolve: (ref: string) => AdminClaimRef;
  statusOf: (userId: string) => SquadStatus | null;
}): { facts: AttendanceFacts; vetted: VettedClaim[] } {
  const vetted: VettedClaim[] = p.facts.claims.map((claim) => {
    const self = claim.subject === "sender";
    const ref: AdminClaimRef = self
      ? { kind: "member", userId: p.senderUserId, name: p.senderName ?? "?" }
      : p.resolve(claim.personRef ?? "");
    const hold = adminClaimHold({
      body: p.body,
      claim,
      claims: p.facts.claims,
      senderName: p.senderName,
      bareDeclaration: p.bareDeclaration,
      listedNames: p.listedNames,
    });
    return {
      claim,
      self,
      hold: hold === null && p.listNotSet ? "not-set" : hold,
      ref,
      before: ref.kind === "member" ? p.statusOf(ref.userId) : null,
    };
  });
  return {
    facts: { ...p.facts, claims: vetted.filter((v) => v.hold === null).map((v) => v.claim), affirmation: null },
    vetted,
  };
}

/** What `admin-group-squad-change.ts` reports as the message's outcome.
 *  "squad-question": nothing written; the line says how to make the change
 *  or asks for a full name. */
export type AdminSquadReplyOutcome = "squad-changed" | "squad-unchanged" | "squad-change-failed" | "squad-question" | "squad-not-set";

function wantedStatus(polarity: Claim["polarity"]): SquadStatus {
  return polarity === "in" ? "CONFIRMED" : polarity === "bench" ? "BENCH" : "DROPPED";
}

/** Does the squad already say what the claim asks? No row counts as out. */
function alreadySo(v: VettedClaim): boolean {
  const want = wantedStatus(v.claim.polarity);
  return want === "DROPPED" ? v.before === null || v.before === "DROPPED" : v.before === want;
}

/**
 * What MatchTime says in HQ after one message, or null for silence.
 *
 *   - Something moved or failed: "Done: ..." as before.
 *   - Only explicit claims, all about members whose status already says
 *     it: "Nothing to change". Never for a held claim, and never for the
 *     sender's own sentence that changed nothing (that is chat).
 *   - An explicit claim about a member that did not move and is not
 *     already so: "I couldn't change X".
 *   - An explicit claim two members could mean: "use the full name".
 *   - The game's list not set yet (`notSet`, the rolling squad still to
 *     carry over): nothing was applied; one line saying so and when, for
 *     an instruction or a message addressed to MatchTime. Chatter: silence.
 *
 * Only when the message was ADDRESSED to MatchTime (an @tag, or a reply to
 * its own message; FNF HQ 2026-10-16, "Imti Rafi AH back" between
 * organisers got "I don't know AH yet"), for a claim that was held:
 *
 *   - A name nobody in the club has, said in passing as coming in: "I
 *     don't know X yet", with the command that adds them.
 *   - The sender saying plainly that they are out (or in), when that would
 *     change the squad: one line with the command that does it. Never a
 *     write, and never a YES question: a YES in HQ answers whatever list or
 *     teams are waiting.
 *
 * Anything else held (tentative, contingent, availability, past, relayed,
 * unsure, or any held claim not addressed to MatchTime): silence.
 */
export function buildAdminSquadReply(p: {
  lang: string | null | undefined;
  changes: Array<{ kind: SquadChangeKind; name: string }>;
  /** Whose rows actually moved (the same people as `changes`). */
  movedUserIds?: string[];
  failed: string[];
  confirmed: number;
  maxPlayers: number;
  vetted: VettedClaim[];
  kickoffLabel: string;
  senderName: string | null;
  /** An @tag, or a reply to MatchTime's own message. Absent: not addressed. */
  addressed?: boolean;
  /** The game's list is not set yet: when the squad carries over, labelled. */
  notSet?: { day: string; time: string } | null;
}): { text: string; outcome: AdminSquadReplyOutcome } | null {
  const s = t(p.lang);
  if (p.notSet) {
    return p.addressed || p.vetted.some((v) => v.hold === "not-set")
      ? { text: s.ag_sq_not_set({ when: p.kickoffLabel, day: p.notSet.day, time: p.notSet.time }), outcome: "squad-not-set" }
      : null;
  }
  const kept = p.vetted.filter((v) => v.hold === null);
  const moved = new Set(p.movedUserIds ?? []);
  const changedNames = new Set(p.changes.map((c) => c.name));
  const parts: string[] = [];

  // Explicit claims about members that neither moved nor already said it.
  const notDone = kept.filter(
    (v) =>
      v.ref.kind === "member" && !v.self && !moved.has(v.ref.userId) && !changedNames.has(v.ref.name) && !alreadySo(v),
  );
  const failed = [...new Set([...p.failed, ...notDone.map((v) => (v.ref as { name: string }).name)])];
  const literalNothing =
    kept.length > 0 &&
    kept.some((v) => !v.self) &&
    kept.every((v) => v.ref.kind === "member" && alreadySo(v));

  if (p.changes.length > 0 || failed.length > 0 || literalNothing) {
    parts.push(buildSquadChangeReply({ lang: p.lang, changes: p.changes, failed, confirmed: p.confirmed, maxPlayers: p.maxPlayers }));
  }

  const unclear = [...new Set(kept.flatMap((v) => (v.ref.kind === "ambiguous" ? [v.ref.name] : [])))];
  if (unclear.length > 0) parts.push(s.ag_paste_unclear({ names: unclear.join(", ") }));

  const strangers = [
    ...new Set(
      p.vetted.flatMap((v) =>
        p.addressed === true &&
        v.hold !== null &&
        v.hold !== "contingent" &&
        v.hold !== "not-now" &&
        !v.self &&
        v.claim.polarity === "in" &&
        v.claim.personNamed &&
        v.ref.kind === "unknown"
          ? [v.ref.name]
          : [],
      ),
    ),
  ];
  for (const name of strangers) parts.push(s.ag_sq_unknown({ name }));

  const ownHeld = p.vetted.find(
    (v) =>
      v.self &&
      v.hold === "not-a-command" &&
      (v.claim.polarity === "in" || v.claim.polarity === "out") &&
      !alreadySo(v),
  );
  if (p.addressed === true && ownHeld && !kept.some((v) => v.self)) {
    const name = ownHeld.ref.kind === "member" ? ownHeld.ref.name : (p.senderName ?? "?");
    parts.push(
      ownHeld.claim.polarity === "out"
        ? s.ag_sq_self_hint_out({ name, when: p.kickoffLabel })
        : s.ag_sq_self_hint_in({ name, when: p.kickoffLabel }),
    );
  }

  if (parts.length === 0) return null;
  const outcome: AdminSquadReplyOutcome =
    failed.length > 0
      ? "squad-change-failed"
      : p.changes.length > 0
        ? "squad-changed"
        : literalNothing
          ? "squad-unchanged"
          : "squad-question";
  return { text: parts.join(" "), outcome };
}
