/**
 * Diffing two pipelines over one replayed batch.
 *
 * PURE. No DB, no model, no Playwright, no filesystem. Unit-tested by
 * `diff.test.ts` under `npm run test:unit`.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT COUNTS AS A DISAGREEMENT
 * ─────────────────────────────────────────────────────────────────────
 * Decisions and writes — `registerAttendance`, `registerFor`, whether a
 * reply was sent at all. NOT wording. "Gina, you're in 👍" and "Added
 * Gina — 3 confirmed." are the same decision, and a harness that called
 * them different would drown the real signal in copy tweaks.
 *
 * Reply text is compared only as PROPERTIES, exactly the three the
 * corpus already uses: does it name a player, does it claim a move, does
 * it leak a raw phone number.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE OLD PIPELINE IS NOT GROUND TRUTH
 * ─────────────────────────────────────────────────────────────────────
 * §10 step 3's criteria are worded "would write and the old CORRECTLY
 * did not" and "miss a write the old one CORRECTLY made". The word
 * doing the work is *correctly*, and no machine can supply it. On
 * 2026-08-30 the incumbent told a real customer group that three named
 * players would be benched when nobody would be, and today it produced
 * a message that swallowed half a sentence.
 *
 * So this module separates two things that are usually conflated:
 *
 *  · the CLASS  — structural, computed: who wrote what.
 *  · the VERDICT — `Adjudication`, supplied by a human: who was right.
 *
 * Until a disagreement is adjudicated it counts towards NOTHING except
 * the "unadjudicated" tally, and `passesStep3` stays `null`. A sweep
 * with unread disagreements can never read as a pass.
 */
import type { AttStatus, CorpusObservation } from "../corpus/grade";
import { claimedMoves, containsRawPhone } from "../corpus/grade";

export type Status = AttStatus | "ABSENT";

export interface AttendanceDelta {
  name: string;
  from: Status;
  to: Status;
}

export interface WriteSet {
  attendance: AttendanceDelta[];
  newMembers: string[];
  benchOffersDelta: number;
  score: { red: number | null; yellow: number | null } | null;
  teams: Array<{ name: string; from: string; to: string }>;
}

export interface SpeechProfile {
  spoke: boolean;
  posts: number;
  dms: number;
  reacted: boolean;
  /** Which of the world's own players the outbound text names. Scoped
   *  to the roster on purpose: comparing every capitalised token would
   *  make "Added Gina" differ from "Gina, you're in" and drown the
   *  signal in copy. */
  namesMentioned: string[];
  /** The text claims a move the database did NOT make — S7, the Erdal
   *  incident. The PROPERTY is the mismatch, not the phrasing: a reply
   *  that claims a move it really made is not a defect. */
  claimsMismatch: Array<{ name: string; claimed: AttStatus; actual: Status }>;
  rawPhone: boolean;
}

export type RunOutcome =
  | { ok: true; observation: CorpusObservation }
  | { ok: false; error: string };

export type DisagreementClass =
  /** One or both replays threw. Not a measurement of anything. */
  | "error"
  /** NEW wrote where OLD did not. §10 target: ZERO. */
  | "spurious_write"
  /** Both wrote, but not the same thing. */
  | "divergent_write"
  /** OLD wrote where NEW did not. §10 target: ≤2%. */
  | "missed_write"
  /** Identical writes, different speech. */
  | "speech_only";

/** Worst first — a spurious write is the one that can put a player at a
 *  pitch with no slot. */
const SEVERITY: DisagreementClass[] = [
  "error",
  "spurious_write",
  "divergent_write",
  "missed_write",
  "speech_only",
];

/** A human's answer to "which one was RIGHT?". */
export type AdjudicationVerdict =
  /** The incumbent was right; the candidate regressed. */
  | "old_right"
  /** The candidate was right; the incumbent was wrong. "New pipeline
   *  better" in the brief's wording. */
  | "new_right"
  /** Neither did the right thing. */
  | "both_wrong"
  /** Both acceptable — different route to the same defensible outcome. */
  | "both_right";

export interface Adjudication {
  key: string;
  verdict: AdjudicationVerdict;
  note: string;
  by?: string;
  at?: string;
}

export interface CaseDiff {
  key: string;
  agree: boolean;
  classes: DisagreementClass[];
  primary: DisagreementClass | null;
  writesOld: WriteSet;
  writesNew: WriteSet;
  onlyOld: AttendanceDelta[];
  onlyNew: AttendanceDelta[];
  conflicting: Array<{ name: string; from: Status; old: Status; new: Status }>;
  speechOld: SpeechProfile;
  speechNew: SpeechProfile;
  spokenOld: string[];
  spokenNew: string[];
  errors: { old?: string; new?: string };
}

// ── Reading a run ──────────────────────────────────────────────────────

const EMPTY_WRITES: WriteSet = {
  attendance: [],
  newMembers: [],
  benchOffersDelta: 0,
  score: null,
  teams: [],
};

const EMPTY_SPEECH: SpeechProfile = {
  spoke: false,
  posts: 0,
  dms: 0,
  reacted: false,
  namesMentioned: [],
  claimsMismatch: [],
  rawPhone: false,
};

function statusMap(rows: Array<{ name: string; status: AttStatus }>): Map<string, AttStatus> {
  return new Map(rows.map((r) => [r.name, r.status]));
}

export function writeSetOf(o: CorpusObservation): WriteSet {
  const before = statusMap(o.attendanceBefore);
  const after = statusMap(o.attendanceAfter);
  const names = new Set([...before.keys(), ...after.keys()]);

  const attendance: AttendanceDelta[] = [];
  for (const name of names) {
    const from: Status = before.get(name) ?? "ABSENT";
    const to: Status = after.get(name) ?? "ABSENT";
    if (from !== to) attendance.push({ name, from, to });
  }
  attendance.sort((a, b) => a.name.localeCompare(b.name));

  const teamsBefore = new Map((o.teamsBefore ?? []).map((t) => [t.name, t.team]));
  const teamsAfter = new Map((o.teamsAfter ?? []).map((t) => [t.name, t.team]));
  const teams: WriteSet["teams"] = [];
  for (const name of new Set([...teamsBefore.keys(), ...teamsAfter.keys()])) {
    const from = teamsBefore.get(name) ?? "NONE";
    const to = teamsAfter.get(name) ?? "NONE";
    if (from !== to) teams.push({ name, from, to });
  }
  teams.sort((a, b) => a.name.localeCompare(b.name));

  return {
    attendance,
    newMembers: o.memberNamesAfter.filter((n) => !o.memberNamesBefore.includes(n)).sort(),
    benchOffersDelta: o.benchOffersOpen,
    score: o.scoreAfter ?? null,
    teams,
  };
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

/** Which of the roster the text names — first name or full name, the
 *  same rule `mustMention` uses in the corpus grader. */
function mentionedNames(text: string, roster: string[]): string[] {
  const lower = text.toLowerCase();
  const hits = new Set<string>();
  for (const full of roster) {
    const first = firstName(full).toLowerCase();
    if (lower.includes(full.toLowerCase()) || (first.length > 2 && lower.includes(first))) {
      hits.add(firstName(full));
    }
  }
  return [...hits].sort();
}

export function speechOf(o: CorpusObservation, roster: string[] = []): SpeechProfile {
  const posts = o.spoken.filter((s) => s.trim().length > 0);
  const dms = o.dms.filter((d) => d.text.trim().length > 0);
  const all = [...posts, ...dms.map((d) => d.text)];
  const joined = all.join("\n");
  const after = new Map(o.attendanceAfter.map((r) => [r.name, r.status as Status]));

  const claimsMismatch: SpeechProfile["claimsMismatch"] = [];
  for (const claim of claimedMoves(joined)) {
    const known = roster.find(
      (full) => firstName(full).toLowerCase() === claim.name.toLowerCase() ||
        full.toLowerCase() === claim.name.toLowerCase(),
    );
    if (!known) continue;
    const actual = after.get(known) ?? "ABSENT";
    if (actual !== claim.status) {
      claimsMismatch.push({ name: firstName(known), claimed: claim.status, actual });
    }
  }
  claimsMismatch.sort((a, b) => a.name.localeCompare(b.name));

  return {
    spoke: posts.length > 0,
    posts: posts.length,
    dms: dms.length,
    reacted: o.reacts.some((r) => r != null && r !== ""),
    namesMentioned: mentionedNames(joined, roster),
    claimsMismatch,
    rawPhone: all.some((t) => containsRawPhone(t)),
  };
}

// ── The diff ───────────────────────────────────────────────────────────

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * @param roster the display names the replayed world contains, so
 *   "names a player" is scoped to real players rather than to every
 *   capitalised word.
 */
export function diffRun(
  key: string,
  oldRun: RunOutcome,
  newRun: RunOutcome,
  roster: string[] = [],
): CaseDiff {
  const classes = new Set<DisagreementClass>();
  const errors: CaseDiff["errors"] = {};
  if (!oldRun.ok) errors.old = oldRun.error;
  if (!newRun.ok) errors.new = newRun.error;

  if (!oldRun.ok || !newRun.ok) {
    classes.add("error");
    return {
      key,
      agree: false,
      classes: [...classes],
      primary: "error",
      writesOld: EMPTY_WRITES,
      writesNew: EMPTY_WRITES,
      onlyOld: [],
      onlyNew: [],
      conflicting: [],
      speechOld: EMPTY_SPEECH,
      speechNew: EMPTY_SPEECH,
      spokenOld: oldRun.ok ? oldRun.observation.spoken : [],
      spokenNew: newRun.ok ? newRun.observation.spoken : [],
      errors,
    };
  }

  const writesOld = writeSetOf(oldRun.observation);
  const writesNew = writeSetOf(newRun.observation);

  const oldByName = new Map(writesOld.attendance.map((d) => [d.name, d]));
  const newByName = new Map(writesNew.attendance.map((d) => [d.name, d]));

  const onlyOld: AttendanceDelta[] = [];
  const onlyNew: AttendanceDelta[] = [];
  const conflicting: CaseDiff["conflicting"] = [];

  for (const [name, d] of oldByName) {
    const other = newByName.get(name);
    if (!other) onlyOld.push(d);
    else if (other.to !== d.to) {
      conflicting.push({ name, from: d.from, old: d.to, new: other.to });
    }
  }
  for (const [name, d] of newByName) if (!oldByName.has(name)) onlyNew.push(d);

  // Provisioning a User is a write too — the ghost "Amir's brother" was
  // never an attendance row, it was a member row in a paid squad.
  const membersOnlyNew = writesNew.newMembers.filter((n) => !writesOld.newMembers.includes(n));
  const membersOnlyOld = writesOld.newMembers.filter((n) => !writesNew.newMembers.includes(n));

  if (onlyNew.length || membersOnlyNew.length || writesNew.benchOffersDelta > writesOld.benchOffersDelta) {
    classes.add("spurious_write");
  }
  if (onlyOld.length || membersOnlyOld.length || writesOld.benchOffersDelta > writesNew.benchOffersDelta) {
    classes.add("missed_write");
  }
  if (conflicting.length) classes.add("divergent_write");

  const scoreOld = JSON.stringify(writesOld.score);
  const scoreNew = JSON.stringify(writesNew.score);
  if (scoreOld !== scoreNew) classes.add("divergent_write");
  if (JSON.stringify(writesOld.teams) !== JSON.stringify(writesNew.teams)) {
    classes.add("divergent_write");
  }

  const speechOld = speechOf(oldRun.observation, roster);
  const speechNew = speechOf(newRun.observation, roster);
  const speechDiffers =
    speechOld.spoke !== speechNew.spoke ||
    speechOld.posts !== speechNew.posts ||
    speechOld.dms !== speechNew.dms ||
    speechOld.reacted !== speechNew.reacted ||
    speechOld.rawPhone !== speechNew.rawPhone ||
    !sameSet(speechOld.namesMentioned, speechNew.namesMentioned) ||
    JSON.stringify(speechOld.claimsMismatch) !== JSON.stringify(speechNew.claimsMismatch);
  if (speechDiffers) classes.add("speech_only");

  const ordered = SEVERITY.filter((c) => classes.has(c));
  return {
    key,
    agree: ordered.length === 0,
    classes: ordered,
    primary: ordered[0] ?? null,
    writesOld,
    writesNew,
    onlyOld,
    onlyNew,
    conflicting,
    speechOld,
    speechNew,
    spokenOld: oldRun.observation.spoken,
    spokenNew: newRun.observation.spoken,
    errors,
  };
}

// ── §10 step 3 ─────────────────────────────────────────────────────────

export interface Criteria {
  /** Replays that produced a measurement (errors excluded). */
  runs: number;
  errors: number;
  disagreements: number;
  /** Adjudicated: the new pipeline wrote and the old CORRECTLY did not. */
  spuriousWriteRuns: number;
  /** Structurally spurious, nobody has said who was right yet. */
  spuriousWriteUnadjudicated: number;
  /** Adjudicated: the new pipeline missed a write the old CORRECTLY made. */
  missedWriteRuns: number;
  missedWriteUnadjudicated: number;
  missedWriteRate: number;
  /** If every unadjudicated missed write turned out to be the old
   *  pipeline's point, this is where the rate would land. */
  missedWriteRateCeiling: number;
  divergentWriteRuns: number;
  speechOnlyRuns: number;
  /** Adjudications that went the candidate's way. */
  newPipelineBetter: number;
  bothWrong: number;
  bothRight: number;
  /** null = undecided, because disagreements remain unadjudicated. A
   *  sweep nobody has read must never render as a pass. */
  passesStep3: boolean | null;
}

export const SPURIOUS_WRITE_TARGET = 0;
export const MISSED_WRITE_RATE_TARGET = 0.02;

export function rollUpCriteria(diffs: CaseDiff[], adjudications: Adjudication[]): Criteria {
  const verdicts = new Map(adjudications.map((a) => [a.key, a.verdict]));

  let runs = 0;
  let errors = 0;
  let disagreements = 0;
  let spuriousWriteRuns = 0;
  let spuriousWriteUnadjudicated = 0;
  let missedWriteRuns = 0;
  let missedWriteUnadjudicated = 0;
  let divergentWriteRuns = 0;
  let speechOnlyRuns = 0;
  let newPipelineBetter = 0;
  let bothWrong = 0;
  let bothRight = 0;

  for (const d of diffs) {
    if (d.primary === "error") {
      errors += 1;
      continue;
    }
    runs += 1;
    if (d.agree) continue;
    disagreements += 1;

    const verdict = verdicts.get(d.key);
    if (verdict === "new_right") newPipelineBetter += 1;
    if (verdict === "both_wrong") bothWrong += 1;
    if (verdict === "both_right") bothRight += 1;

    if (d.classes.includes("spurious_write")) {
      if (verdict === "old_right") spuriousWriteRuns += 1;
      else if (verdict === undefined) spuriousWriteUnadjudicated += 1;
    }
    if (d.classes.includes("missed_write")) {
      if (verdict === "old_right") missedWriteRuns += 1;
      else if (verdict === undefined) missedWriteUnadjudicated += 1;
    }
    if (d.classes.includes("divergent_write")) divergentWriteRuns += 1;
    if (d.primary === "speech_only") speechOnlyRuns += 1;
  }

  const rate = runs ? missedWriteRuns / runs : 0;
  const ceiling = runs ? (missedWriteRuns + missedWriteUnadjudicated) / runs : 0;
  const unresolved = spuriousWriteUnadjudicated + missedWriteUnadjudicated;

  return {
    runs,
    errors,
    disagreements,
    spuriousWriteRuns,
    spuriousWriteUnadjudicated,
    missedWriteRuns,
    missedWriteUnadjudicated,
    missedWriteRate: rate,
    missedWriteRateCeiling: ceiling,
    divergentWriteRuns,
    speechOnlyRuns,
    newPipelineBetter,
    bothWrong,
    bothRight,
    passesStep3:
      unresolved > 0
        ? null
        : spuriousWriteRuns <= SPURIOUS_WRITE_TARGET && rate <= MISSED_WRITE_RATE_TARGET,
  };
}
