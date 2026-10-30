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
 *   - placing a name the HQ squad reader read on a club member
 *     (`matchPastedName`), the fact gates on a pasted list
 *     (`gateSquadPaste`) and diffing it against the squad
 *     (`diffPastedSquad`). The list itself is read by a model
 *     (`hq-squad-reader.ts`), never by code;
 *   - every sentence MatchTime says back, in the club's language.
 *
 * The impure halves: `admin-group-squad-change.ts` (one change, through the
 * router and the attendance engine) and `admin-group-paste.ts` (a pasted
 * list, a proposal, applied on YES).
 */
import { normaliseName } from "./name-normalise";
import { t } from "./i18n/t";
import { buildBenchPickHint, buildSquadCountLine } from "./squad-count-line";
import type { AttendanceFacts, Claim, Route } from "./pipeline/types";
import type { HqSquadChange } from "./hq-squad-reader-prompt";

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

/**
 * At most this many confirmed players come OUT of the squad by one pasted
 * list (2026-10-29). A weekly club's list changes by one to three from one
 * week to the next (a drop-out, a late withdrawal); FNF's 29 Oct incident
 * took out nine, half the squad, from a teams sheet pasted back. Taking a
 * player out is the expensive mistake (his place goes to the bench and he
 * is told), so more than this is never proposed from a paste: MatchTime
 * says who is not on the list and asks to be told by name.
 */
export const PASTE_MAX_REMOVALS = 3;

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

/** Why confirmed players a pasted list leaves off were NOT taken out. */
export type PasteHeldReason =
  /** The reading did not say every one of them is out on purpose. */
  | "unaccounted"
  /** More than `PASTE_MAX_REMOVALS` of them. */
  | "too-many";

export type SquadPasteGate =
  /** The list's players are exactly the teams' players: a copy of the
   *  teams, never a squad change. */
  | { verdict: "teams" }
  | {
      verdict: "squad";
      diff: SquadDiff;
      /** Confirmed players the list leaves off who stay in, in squad order. */
      held: string[];
      heldReason: PasteHeldReason | null;
    };

/**
 * THE FACT GATES on a list the HQ squad reader read as the squad
 * (2026-10-29). Whatever the model said:
 *
 *   - a list whose players are exactly the match's team players (every
 *     slot, or every slot still playing) is the teams, not the squad;
 *   - a confirmed player left off comes out only when the reading says so
 *     for EVERY confirmed player left off (`out`, the model's "left off on
 *     purpose"), and never more than `PASTE_MAX_REMOVALS` of them;
 *     otherwise nobody comes out, and `held` names who stays in.
 */
export function gateSquadPaste(input: {
  playing: SquadRef[];
  reserves: SquadRef[];
  /** Confirmed players the reader says the list leaves off on purpose. */
  out: string[];
  current: Array<{ userId: string; status: SquadStatus }>;
  /** Everyone on the match's team sheet; empty with no teams. */
  teamUserIds: string[];
  /** Of those, the ones still in the squad. Omitted: `teamUserIds`. */
  teamPlayingUserIds?: string[];
}): SquadPasteGate {
  const listed = [...input.playing, ...input.reserves];
  const listedIds = new Set(listed.flatMap((r) => ("userId" in r ? [r.userId] : [])));
  const sameSet = (team: string[]) =>
    team.length > 0 && listed.every((r) => "userId" in r) && listedIds.size === new Set(team).size && team.every((id) => listedIds.has(id));
  if (sameSet(input.teamUserIds) || sameSet(input.teamPlayingUserIds ?? [])) return { verdict: "teams" };

  const full = diffPastedSquad({ playing: input.playing, reserves: input.reserves, current: input.current });
  const leftOff = full.remove.map((r) => r.userId);
  const out = new Set(input.out);
  const heldReason: PasteHeldReason | null =
    leftOff.length === 0 ? null : !leftOff.every((id) => out.has(id)) ? "unaccounted" : leftOff.length > PASTE_MAX_REMOVALS ? "too-many" : null;
  if (heldReason === null) return { verdict: "squad", diff: full, held: [], heldReason: null };
  const diff: SquadDiff = { ...full, remove: [], same: full.add.length === 0 && full.toBench.length === 0 };
  return { verdict: "squad", diff, held: leftOff, heldReason };
}

// ── What MatchTime says ───────────────────────────────────────────────

export type SquadChangeKind = "in" | "out" | "bench" | "maybe";

/**
 * "Done: Akram out. 17 of 18, 1 on the bench (Uncle Najib)." The count
 * says the bench whenever anyone is on it (FNF HQ 2026-10-18: "17 of 18"
 * read as if nobody was waiting), and in an organiser-pick club with a
 * place free it ends with the command that brings someone in
 * (`squad-count-line.ts`).
 */
export function buildSquadChangeReply(p: {
  lang: string | null | undefined;
  changes: Array<{ kind: SquadChangeKind; name: string }>;
  failed: string[];
  confirmed: number;
  maxPlayers: number;
  /** Who is on the bench after the change, in bench order. */
  bench: readonly string[];
  /** `Organisation.benchPickMode`. */
  benchPickMode: string | null | undefined;
}): string {
  const s = t(p.lang);
  const squad = { lang: p.lang, confirmed: p.confirmed, maxPlayers: p.maxPlayers, bench: p.bench };
  const hint = buildBenchPickHint({ ...squad, benchPickMode: p.benchPickMode });
  const count = hint ? `${buildSquadCountLine(squad)} ${hint}` : buildSquadCountLine(squad);
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
  /** Confirmed players the list leaves off who were NOT taken out
   *  (`gateSquadPaste`): said, and nothing done about them. */
  kept?: string[];
}): string {
  const s = t(p.lang);
  const unclear = p.unclear.length > 0 ? s.ag_paste_unclear({ names: p.unclear.join(", ") }) : null;
  const cannotAdd = p.cannotAdd ?? [];
  const refused = cannotAdd.length > 0 ? s.ag_paste_cannot_add({ names: cannotAdd.join(", "), many: cannotAdd.length > 1 }) : null;
  const keptNames = p.kept ?? [];
  const kept = keptNames.length > 0 ? s.ag_paste_kept({ names: keptNames.join(", "), count: keptNames.length }) : null;
  if (p.add.length === 0 && p.remove.length === 0 && p.toBench.length === 0 && p.newNames.length === 0) {
    return [kept ?? s.ag_paste_same, unclear, refused].filter(Boolean).join(" ");
  }
  const parts: string[] = [];
  if (p.add.length > 0) parts.push(s.ag_paste_adding({ names: p.add.join(", ") }));
  if (p.remove.length > 0) parts.push(s.ag_paste_removing({ names: p.remove.join(", ") }));
  if (p.toBench.length > 0) parts.push(s.ag_paste_to_bench({ names: p.toBench.join(", ") }));
  if (p.newNames.length > 0) parts.push(s.ag_paste_new({ names: p.newNames.join(", "), many: p.newNames.length > 1 }));
  if (kept) parts.push(kept);
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

// ── A change read in HQ ───────────────────────────────────────────────
//
// HQ is where the organisers talk, so only an INSTRUCTION is applied there
// (2026-10-15: the live club rehearsal found "might have to pull out" and a
// player's injured foot turned into squad writes). Which sentences are
// instructions is the HQ squad reader's to say, a model reading the
// message with the group's recent messages, the squad and the teams
// (`hq-squad-reader-prompt.ts`, 2026-10-30): its "change" lists only what
// the message tells MatchTime to change, and the organisers' own talk is
// "other", which never reaches here. Until 2026-10-30 code decided it from
// the sentence's words (filler and command word lists, EN and TR); that is
// gone (Kemal: "I don't want any string parsing at all"). One hold stays,
// on a fact: the game's list is not set yet.

/**
 * The HQ squad reader's change as the facts the shared attendance engine
 * decides from (its `presetFacts`: no extractor is asked). Each person is
 * named, present, definite and the sender's own word: the reader lists
 * only instructions. A member is named by their roster name, so the
 * engine's resolver finds exactly them; a new person by the name written.
 * The sender's own place is theirs (`subject: "sender"`).
 */
export function hqChangeFacts(changes: readonly HqSquadChange[], senderUserId: string): AttendanceFacts {
  const claims: Claim[] = changes.map((c) => ({
    subject: c.userId !== null && c.userId === senderUserId ? "sender" : "other",
    personRef: c.name,
    personNamed: true,
    polarity: c.to,
    contingent: false,
    conditionOn: "none",
    tense: "present",
    reported: false,
    confidence: 1,
    replaces: c.replaces,
  }));
  return { kind: "attendance", claims, affirmation: null, sideRequests: [] };
}

/** Why a claim read in HQ is NOT applied. Null: it is applied. */
export type AdminClaimHold =
  /** an instruction, but the game's list is not set yet: the rolling
   *  squad is still to be carried over (2026-10-17). */
  "not-set";

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
 * The facts the attendance engine may act on in HQ: the reader's changes
 * (`hqChangeFacts`), none while the game's list is not set, and never a
 * bare affirmation (a "yeah" in HQ points at nothing MatchTime said
 * there). `vetted` keeps every claim, with who it is about and where they
 * stood, for the reply.
 */
export function vetAdminGroupFacts(p: {
  facts: AttendanceFacts;
  senderUserId: string;
  senderName: string | null;
  /** The game's list is not set yet (`rollingSeedPendingAt`): nothing is
   *  applied, and every claim is held as "not-set". */
  listNotSet?: boolean;
  resolve: (ref: string) => AdminClaimRef;
  statusOf: (userId: string) => SquadStatus | null;
}): { facts: AttendanceFacts; vetted: VettedClaim[] } {
  const vetted: VettedClaim[] = p.facts.claims.map((claim) => {
    const self = claim.subject === "sender";
    const ref: AdminClaimRef = self
      ? { kind: "member", userId: p.senderUserId, name: p.senderName ?? "?" }
      : p.resolve(claim.personRef ?? "");
    return {
      claim,
      self,
      hold: p.listNotSet ? "not-set" : null,
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
 *  "squad-question": nothing written; the line asks for a full name. */
export type AdminSquadReplyOutcome =
  | "squad-changed"
  | "squad-unchanged"
  | "squad-change-failed"
  | "squad-question"
  | "squad-not-set"
  /** An OUT for a name nobody in the club has: nothing written, one line
   *  saying they are not on the list (FNF HQ 2026-10-24). */
  | "squad-not-on-list";

function wantedStatus(polarity: Claim["polarity"]): SquadStatus {
  return polarity === "in" ? "CONFIRMED" : polarity === "bench" ? "BENCH" : "DROPPED";
}

/** Does the squad already say what the claim asks? No row counts as out. */
function alreadySo(v: VettedClaim): boolean {
  const want = wantedStatus(v.claim.polarity);
  return want === "DROPPED" ? v.before === null || v.before === "DROPPED" : v.before === want;
}

/**
 * What MatchTime says in HQ after one change, or null for silence. Every
 * claim here is one the HQ squad reader read as an instruction
 * (`hq-squad-reader-prompt.ts`); the organisers' own talk never gets here.
 *
 *   - Something moved or failed: "Done: ..." as before.
 *   - Only claims about other members whose status already says it:
 *     "Nothing to change". Never for the sender's own claim that changed
 *     nothing.
 *   - A claim about a member that did not move and is not already so: "I
 *     couldn't change X".
 *   - A name two members could mean: "use the full name".
 *   - An OUT for a name nobody in the club has (FNF HQ 2026-10-24,
 *     "Glazers is out now. @Match Time what is the list?", Glazers removed
 *     from the club and dropped minutes before, so on no roster): nothing
 *     to take out, and one line saying so, when asked of MatchTime or given
 *     by an organiser; a member's untagged one stays silent.
 *   - The game's list not set yet (`notSet`, the rolling squad still to
 *     carry over): nothing was applied; one line saying so and when.
 */
export function buildAdminSquadReply(p: {
  lang: string | null | undefined;
  changes: Array<{ kind: SquadChangeKind; name: string }>;
  /** Whose rows actually moved (the same people as `changes`). */
  movedUserIds?: string[];
  failed: string[];
  confirmed: number;
  maxPlayers: number;
  /** Who is on the bench after the message, in bench order. */
  bench: readonly string[];
  benchPickMode: string | null | undefined;
  vetted: VettedClaim[];
  kickoffLabel: string;
  /** An @tag, or a reply to MatchTime's own message. Absent: not addressed. */
  addressed?: boolean;
  /** The sender is an owner or admin of the club. Absent: not. */
  organiser?: boolean;
  /** The game's list is not set yet: when the squad carries over, labelled. */
  notSet?: { day: string; time: string } | null;
}): { text: string; outcome: AdminSquadReplyOutcome } | null {
  const s = t(p.lang);
  if (p.notSet) {
    return p.vetted.length > 0 || p.addressed
      ? { text: s.ag_sq_not_set({ when: p.kickoffLabel, day: p.notSet.day, time: p.notSet.time }), outcome: "squad-not-set" }
      : null;
  }
  const kept = p.vetted.filter((v) => v.hold === null);
  const moved = new Set(p.movedUserIds ?? []);
  const changedNames = new Set(p.changes.map((c) => c.name));
  const parts: string[] = [];

  // Claims about members that neither moved nor already said it.
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
    parts.push(
      buildSquadChangeReply({
        lang: p.lang,
        changes: p.changes,
        failed,
        confirmed: p.confirmed,
        maxPlayers: p.maxPlayers,
        bench: p.bench,
        benchPickMode: p.benchPickMode,
      }),
    );
  }

  const unclear = [...new Set(kept.flatMap((v) => (v.ref.kind === "ambiguous" ? [v.ref.name] : [])))];
  if (unclear.length > 0) parts.push(s.ag_paste_unclear({ names: unclear.join(", ") }));

  const notOnList = [
    ...new Set(
      kept.flatMap((v) =>
        !v.self && v.claim.polarity === "out" && v.ref.kind === "unknown" && (p.addressed === true || p.organiser === true) ? [v.ref.name] : [],
      ),
    ),
  ];
  if (notOnList.length > 0) parts.push(s.ag_sq_not_on_list({ names: notOnList.join(", "), when: p.kickoffLabel }));

  if (parts.length === 0) return null;
  const outcome: AdminSquadReplyOutcome =
    failed.length > 0
      ? "squad-change-failed"
      : p.changes.length > 0
        ? "squad-changed"
        : literalNothing
          ? "squad-unchanged"
          : notOnList.length > 0
            ? "squad-not-on-list"
            : "squad-question";
  return { text: parts.join(" "), outcome };
}
