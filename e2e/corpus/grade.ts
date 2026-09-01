/**
 * The incident corpus — types, grader and scoreboard.
 *
 * PURE. No database, no model, no Playwright, no filesystem. Everything
 * in here is unit-tested by `grade.test.ts` under `npm run test:unit`.
 *
 * WHY THIS EXISTS
 * ---------------
 * MDs/analyzer-redesign-2026-08-31.md §10 step 1: "The 26 incidents in
 * §3.2 are the spec: each has a concrete message, a named player and a
 * known-correct outcome. Today they live inlined in bespoke specs, or
 * nowhere. One replayable JSONL corpus, run against any candidate
 * pipeline. This is the artefact that unblocks every later step and it
 * does not exist."
 *
 * TWO RULES THE FORMAT ENFORCES
 * -----------------------------
 * 1. An expectation is about WRITES and DECISIONS, never wording. The
 *    only string assertions available are PROPERTIES — "names Najib",
 *    "does not name Mojib", "does not claim a move the database did not
 *    make", "never prints a phone number". There is deliberately no
 *    golden-reply field, because a corpus that pins copy rots on the
 *    next copy tweak and then nobody trusts it.
 * 2. The grader consumes a `CorpusObservation`, which is pipeline-
 *    agnostic: rows, member names, what the bot said, what it DM'd,
 *    what it reacted. `AnalysisVerdict` does not appear anywhere in this
 *    file, so step 2's router+extractor+engine can be graded by exactly
 *    the same cases as today's mega-prompt.
 */

// ── §3.2 taxonomy ──────────────────────────────────────────────────────

/** §3.1: A extraction the model needs · B should be deterministic code ·
 *  C should be a template · D scar tissue · E dead/duplicated/wrong. */
export type Category = "A" | "B" | "C" | "D" | "E";

/** The 39 sections the redesign doc inventories (S0–S38). Kept here so
 *  the scoreboard can report which parts of the prompt have NO case —
 *  the coverage gap is a deliverable in its own right. */
export const ALL_PROMPT_SECTIONS: readonly string[] = Array.from(
  { length: 39 },
  (_, i) => `S${i}`,
);

export type AttStatus = "CONFIRMED" | "BENCH" | "DROPPED";
/** ABSENT = there must be no attendance row at all for this person. */
export type ExpectedStatus = AttStatus | "ABSENT";

// ── A case ─────────────────────────────────────────────────────────────

export interface CorpusPlayer {
  /** Handle the case uses to refer to this person. */
  key: string;
  name: string;
  role?: "OWNER" | "ADMIN" | "PLAYER";
  /** false → no phone on record (guest shape). */
  hasPhone?: boolean;
  /** true → sends @lid-style: no phone on the wire, pushname only. */
  lid?: boolean;
}

export interface CorpusWorld {
  /** Format total (7-a-side → 14). Default 14. */
  maxPlayers?: number;
  players: CorpusPlayer[];
  /** Attendance already on the upcoming match when the messages land. */
  attendance?: Array<{ key: string; status: AttStatus }>;
  /** Per-org feature flags; omitted keys take the harness defaults. */
  features?: Partial<Record<string, boolean>>;
  /** Days until kickoff, or null for "no upcoming match at all". */
  upcomingMatchInDays?: number | null;
  /**
   * HOURS until kickoff — takes precedence over `upcomingMatchInDays`.
   * Added for the history replay harness (`e2e/replay/`): a message two
   * hours before kickoff and one two days before land in different
   * worlds (deadline passed, chase running, bench offers open), and a
   * whole-day granularity would quietly erase that. Hand-written corpus
   * cases keep using days.
   */
  upcomingMatchInHours?: number;
  /**
   * Gap between kickoff and `attendanceDeadline`, in hours. Default 5
   * (the sim's historical value). Sutton FC runs `deadlineHours: 0`, so
   * a replay that assumed 5 would put messages the wrong side of the
   * deadline.
   */
  deadlineHoursBeforeKickoff?: number;
  /** A SECOND empty upcoming match further out. The 2026-06-18 rollover
   *  incident needs one: with this week full, casual "In"s must still
   *  land on THIS week's match, never silently on next week's. */
  alsoMatchInDays?: number;
  /** Pre-existing team assignments, for the show-vs-generate case. */
  teams?: Record<string, "RED" | "YELLOW">;
  /** A completed match, for history/stats cases. */
  completedMatch?: {
    daysAgo?: number;
    /** Hours since that kickoff — takes precedence over `daysAgo`. */
    hoursAgo?: number;
    confirmedKeys: string[];
    redScore?: number | null;
    yellowScore?: number | null;
  };
  /** Open a real BenchSlotOffer by dropping this confirmed player first
   *  (the only way to get the "OPEN BENCH SLOT" context block). */
  openBenchSlotByDropping?: string;
}

/** What the model emitted — used ONLY in stubbed mode. See `stubKind`. */
export interface CorpusStubVerdict {
  intent?: string;
  confidence?: number;
  react?: string | null;
  reply?: string | null;
  registerAttendance?: "IN" | "OUT" | "BENCH" | null;
  benchConfirmation?: "yes" | "no" | null;
  registerFor?: Array<{ name: string; action: "IN" | "OUT" | "BENCH" }> | null;
  /** The message asks for MORE PLAYERS. A flag, not an intent — it
   *  coexists with the attendance the same message carries. */
  recruitRequest?: boolean;
  scoreRed?: number | null;
  scoreYellow?: number | null;
  includeNames?: string[] | null;
  teamOverrides?: Array<{ name: string; team: "RED" | "YELLOW" }> | null;
  teamNames?: [string, string] | null;
  bulkPayment?: { payerName: string; count: number; coveredNames?: string[] } | null;
  reminder?: { date: string; time?: string; note: string } | null;
  reasoning?: string;
}

export interface CorpusMessage {
  /** A roster key, or an outsider the org has never seen. */
  from: string | { name: string | null; phone: string };
  body: string;
  /** The message @-mentioned the bot (the interaction-contract signal). */
  tag?: boolean;
  /** Which analyze batch this message belongs to (default 0). Messages
   *  sharing a turn are flushed together, exactly as the Pi's 10-minute
   *  buffer does; turns run in ascending order and each turn sees the
   *  previous turns (and MatchTime's own replies) as chat history. */
  turn?: number;
  /** Stubbed-mode verdict. See `CorpusCase.stubKind`. */
  stub?: CorpusStubVerdict;
}

/** One line of the Pi's last-15 buffer, forwarded on every analyze call.
 *  NOT optional decoration: PR #26 found the sim was omitting it, so
 *  every live test before it ran against a prompt production never uses,
 *  and Amir's bug reproduced only 2/5 WITH history. */
export interface CorpusHistoryLine {
  author: string | null;
  body: string;
}

export interface CorpusExpectation {
  /** Per-person end state. `player` is a roster key, or a literal name
   *  for someone the case expects to be created (a named guest). */
  attendance?: Array<{ player: string; status: ExpectedStatus }>;
  /** The whole attendance set is byte-identical to before. */
  unchanged?: boolean;
  counts?: { confirmed?: number; bench?: number; dropped?: number };
  /** How many BenchSlotOffers should be open afterwards. */
  benchOffersOpen?: number;
  /** The score recorded on the completed match (S17). */
  score?: { red: number | null; yellow: number | null };
  /** Default false: creating a User is a WRITE and needs declaring. */
  allowNewMembers?: boolean;
  /** silent = not a word, not a DM, not a reaction. required = at least
   *  one of reply/group post. any = don't care (property checks still
   *  apply). Default "any". */
  speaks?: "silent" | "required" | "any";
  /** Cap on how many distinct things the bot may say in the group. One
   *  authoritative post per batch is the rule S36 encodes; the Sutton
   *  Lads incident (2026-06-12) produced four contradictory ones. */
  speaksAtMost?: number;
  /** No TeamAssignment row may move (S19: "show the teams again" must
   *  not re-run the balancer over an admin's manual swap). */
  teamsUnchanged?: boolean;
  react?: "none" | "any" | string[];
  /** Properties, not golden strings. Matched against first names too. */
  mustMention?: string[];
  mustNotMention?: string[];
  /** Escape hatches for the rare case where a phrase IS the outcome
   *  (e.g. the guest name-ask). Regex sources, case-insensitive. */
  mustMatch?: string[];
  mustNotMatch?: string[];
  /** Default true: the bot may not announce a move the DB did not make. */
  claimsMatchWrites?: boolean;
  /** Default true: never print a raw phone number. */
  noRawPhone?: boolean;
}

export interface CorpusProvenance {
  /** commit = reconstructed from git · pr = from a merged PR body ·
   *  doc = the redesign doc is the only source (say so, never pretend) ·
   *  production = machine-generated by the history replay harness from a
   *  real `AnalyzedMessage` row (`e2e/replay/`), never hand-written. */
  kind: "commit" | "pr" | "doc" | "production";
  ref?: string;
  date?: string;
  player?: string;
  note: string;
}

export interface CorpusCase {
  id: string;
  title: string;
  /** §3.2 ids this case exercises. */
  sections: string[];
  category: Category;
  provenance: CorpusProvenance;
  world: CorpusWorld;
  history?: CorpusHistoryLine[];
  messages: CorpusMessage[];
  expect: CorpusExpectation;
  /**
   * How to read the `stub` verdicts on this case's messages.
   *  - "historical": the verdict the model ACTUALLY emitted during the
   *    incident. A stubbed run then asks "does today's SERVER catch it?"
   *    Cases whose fix was prompt-only are expected to fail in stubbed
   *    mode — that is a finding, recorded in the baseline, not a bug.
   *  - "corrected": what a correct model emits. A stubbed run asks
   *    "does the server execute a correct verdict correctly?"
   * Absent → the case is LIVE-ONLY (nothing to stub).
   */
  stubKind?: "historical" | "corrected";
  /**
   * True when the case carries an `@Match Time` tag the ORIGINAL
   * production message did not have. The interaction contract (19f43e3,
   * 2026-06-18) made a tag mandatory for every directed op, so incidents
   * from before that date cannot replay untagged and still reach the
   * behaviour they exist to pin. §3.2's provenance column describes
   * historical behaviour, not necessarily current behaviour.
   */
  contractTagAdded?: boolean;
  /**
   * Set on a case that carries NO stub verdict and therefore never runs
   * in CI. It must say what a stub would destroy — usually that the
   * assertion IS the model's classification, or that the asserted text
   * is model-authored so a stub would contain the answer. Enforced by
   * the loader so the count of CI-covered cases can never quietly drift
   * away from the count of corpus cases.
   */
  liveOnlyReason?: string;
  /** Free-form labels, e.g. "banter", "paid-match", "lid". */
  tags?: string[];
  notes?: string;
}

// ── What a pipeline hands back ─────────────────────────────────────────

/**
 * The adapter boundary. Deliberately free of `AnalysisVerdict`, intents,
 * reasoning and every other artefact of today's design — a step-2
 * router+extractor+engine can fill this in from proposed writes without
 * ever producing a verdict.
 */
export interface CorpusObservation {
  attendanceBefore: Array<{ name: string; status: AttStatus }>;
  attendanceAfter: Array<{ name: string; status: AttStatus }>;
  memberNamesBefore: string[];
  memberNamesAfter: string[];
  /** Everything the bot said in the group: per-message replies AND
   *  queued group posts. */
  spoken: string[];
  dms: Array<{ to: string | null; text: string }>;
  /** One entry per input message; null = no reaction. */
  reacts: Array<string | null>;
  benchOffersOpen: number;
  /** The completed match's score, when the case cares about it. */
  scoreAfter?: { red: number | null; yellow: number | null };
  /** TeamAssignment rows, when the case cares about them. */
  teamsBefore?: Array<{ name: string; team: string }>;
  teamsAfter?: Array<{ name: string; team: string }>;
  /** Pipeline-specific diagnostics. NEVER asserted — for triage only. */
  notes?: Record<string, unknown>;
}

// ── Grading ────────────────────────────────────────────────────────────

export type Classification =
  /** The case could not be replayed at all — the harness threw. Worst of
   *  the lot, because it is not a measurement of anything. */
  | "error"
  | "spurious_write"
  | "wrong_write"
  | "missed_write"
  | "speech";

/** Worst-first. §10 step 3 cares most about writes that should not be. */
const SEVERITY: Classification[] = [
  "error",
  "spurious_write",
  "wrong_write",
  "missed_write",
  "speech",
];

export interface CaseGrade {
  passed: boolean;
  failures: string[];
  classification: Classification | null;
}

/** Relationship words and quantities that are never a person's name.
 *  §4.1: the analyzer provisioned a User called "Amir's brother" into a
 *  paid squad 6 times out of 6. */
const PLACEHOLDER_MEMBER = /\b(brother|sister|cousin|mate|friend|dad|mum|someone|somebody|guy|guys|player|players|another|a friend)\b/i;

/** A phone number in any outbound text. Matches +44…, 07…, 44…. */
const RAW_PHONE = /(?:\+\d[\d\s().-]{8,}\d)|(?:\b0\d{9,10}\b)|(?:\b\d{11,}\b)/;

/** "X goes on the bench", "X is in", "adding X", "marking X as out" —
 *  the shapes S7 (Erdal, 2026-05-15) was written to stop. */
export function claimedMoves(text: string): Array<{ name: string; status: AttStatus }> {
  const out: Array<{ name: string; status: AttStatus }> = [];
  const name = "([A-Z][\\p{L}'-]+)";
  const toBench = "(?:on|onto|to)?\\s*(?:the\\s+)?bench";
  const patterns: Array<[RegExp, AttStatus]> = [
    [new RegExp(`${name}\\s+(?:goes|go|is going|will go|moves)\\s+${toBench}`, "gu"), "BENCH"],
    [new RegExp(`${name}\\s+is\\s+(?:now\\s+)?on\\s+the\\s+bench`, "gu"), "BENCH"],
    [new RegExp(`(?:moving|putting|benching)\\s+${name}\\s+${toBench}`, "gu"), "BENCH"],
    [new RegExp(`${name}\\s+is\\s+(?:now\\s+)?(?:in|confirmed|playing)\\b`, "gu"), "CONFIRMED"],
    [new RegExp(`(?:adding|added|registering|registered)\\s+${name}\\b`, "gu"), "CONFIRMED"],
    [new RegExp(`${name}\\s+is\\s+(?:now\\s+)?out\\b`, "gu"), "DROPPED"],
    [new RegExp(`(?:dropping|dropped|marking)\\s+${name}\\s+(?:as\\s+)?out\\b`, "gu"), "DROPPED"],
  ];
  for (const [re, status] of patterns) {
    for (const m of text.matchAll(re)) {
      if (m[1]) out.push({ name: m[1], status });
    }
  }
  return out;
}

/** Does this outbound text contain a phone number? Exported so the
 *  history replay harness (`e2e/replay/`) judges the same property the
 *  same way instead of writing a second regex. */
export function containsRawPhone(text: string): boolean {
  return RAW_PHONE.test(text);
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

function mentions(haystack: string, who: string): boolean {
  const lower = haystack.toLowerCase();
  return lower.includes(who.toLowerCase()) || lower.includes(firstName(who).toLowerCase());
}

/** Resolve a case-level `player` reference (roster key OR literal name)
 *  to the display name a pipeline would write. */
function resolvePlayer(c: CorpusCase, ref: string): string {
  return c.world.players.find((p) => p.key === ref)?.name ?? ref;
}

function statusOf(
  rows: Array<{ name: string; status: AttStatus }>,
  name: string,
): AttStatus | "ABSENT" {
  const hit = rows.find(
    (r) => r.name.toLowerCase() === name.toLowerCase() || mentions(r.name, name),
  );
  return hit ? hit.status : "ABSENT";
}

function sortedRows(rows: Array<{ name: string; status: AttStatus }>): string {
  return rows
    .map((r) => `${r.name}=${r.status}`)
    .sort()
    .join(",");
}

export function gradeCase(c: CorpusCase, o: CorpusObservation): CaseGrade {
  const failures: string[] = [];
  const seen: Classification[] = [];
  const fail = (kind: Classification, msg: string) => {
    failures.push(msg);
    seen.push(kind);
  };

  const e = c.expect;
  const allText = [...o.spoken, ...o.dms.map((d) => d.text)];
  const joined = allText.join("\n");

  // ── writes ──────────────────────────────────────────────────────────
  for (const want of e.attendance ?? []) {
    const name = resolvePlayer(c, want.player);
    const got = statusOf(o.attendanceAfter, name);
    if (got === want.status) continue;
    if (want.status === "ABSENT") {
      fail("spurious_write", `${name}: expected NO attendance row, got ${got}`);
    } else if (got === "ABSENT") {
      fail("missed_write", `${name}: expected ${want.status}, got no attendance row`);
    } else {
      fail("wrong_write", `${name}: expected ${want.status}, got ${got}`);
    }
  }

  if (e.unchanged) {
    const before = sortedRows(o.attendanceBefore);
    const after = sortedRows(o.attendanceAfter);
    if (before !== after) {
      const kind: Classification =
        o.attendanceAfter.length >= o.attendanceBefore.length ? "spurious_write" : "missed_write";
      fail(kind, `attendance must be unchanged: [${before}] → [${after}]`);
    }
  }

  if (e.counts) {
    const tally = (s: AttStatus) => o.attendanceAfter.filter((r) => r.status === s).length;
    const checks: Array<[keyof NonNullable<typeof e.counts>, AttStatus]> = [
      ["confirmed", "CONFIRMED"],
      ["bench", "BENCH"],
      ["dropped", "DROPPED"],
    ];
    for (const [key, status] of checks) {
      const want = e.counts[key];
      if (want === undefined) continue;
      const got = tally(status);
      if (got !== want) {
        fail(got > want ? "spurious_write" : "missed_write", `${key}: expected ${want}, got ${got}`);
      }
    }
  }

  if (e.score) {
    const got = o.scoreAfter ?? { red: null, yellow: null };
    if (got.red !== e.score.red || got.yellow !== e.score.yellow) {
      const nothing = got.red == null && got.yellow == null;
      fail(
        nothing ? "missed_write" : "wrong_write",
        `score: expected ${e.score.red}-${e.score.yellow}, got ${got.red}-${got.yellow}`,
      );
    }
  }

  if (e.teamsUnchanged) {
    const key = (rows: Array<{ name: string; team: string }> | undefined) =>
      (rows ?? [])
        .map((r) => `${r.name}=${r.team}`)
        .sort()
        .join(",");
    const before = key(o.teamsBefore);
    const after = key(o.teamsAfter);
    if (before !== after) {
      fail("wrong_write", `team assignments must be unchanged: [${before}] → [${after}]`);
    }
  }

  if (e.benchOffersOpen !== undefined && o.benchOffersOpen !== e.benchOffersOpen) {
    fail(
      o.benchOffersOpen > e.benchOffersOpen ? "spurious_write" : "missed_write",
      `open bench offers: expected ${e.benchOffersOpen}, got ${o.benchOffersOpen}`,
    );
  }

  // New members are a write. Undeclared ones fail; placeholder names
  // ("Amir's brother") fail even when the case allows new members.
  const fresh = o.memberNamesAfter.filter((n) => !o.memberNamesBefore.includes(n));
  for (const n of fresh) {
    if (PLACEHOLDER_MEMBER.test(n)) {
      fail("spurious_write", `ghost member provisioned from a relationship word: "${n}"`);
    } else if (!e.allowNewMembers) {
      fail("spurious_write", `unexpected new member created: "${n}"`);
    }
  }

  // ── speech, by property ─────────────────────────────────────────────
  const speaks = e.speaks ?? "any";
  const saidSomething = o.spoken.some((s) => s.trim().length > 0);
  const dmdSomething = o.dms.some((d) => d.text.trim().length > 0);
  const reacted = o.reacts.some((r) => r != null && r !== "");

  if (speaks === "silent") {
    if (saidSomething) fail("speech", `expected silence, said: ${JSON.stringify(o.spoken[0])}`);
    if (dmdSomething) fail("speech", `expected silence, DM'd: ${JSON.stringify(o.dms[0]?.text)}`);
    if (reacted) fail("speech", `expected silence, reacted ${o.reacts.filter(Boolean).join(",")}`);
  } else if (speaks === "required" && !saidSomething) {
    fail("speech", "expected MatchTime to say something; it was silent");
  }

  if (e.speaksAtMost !== undefined) {
    const said = o.spoken.filter((s) => s.trim().length > 0);
    if (said.length > e.speaksAtMost) {
      fail(
        "speech",
        `expected at most ${e.speaksAtMost} group post(s), got ${said.length}: ` +
          said.map((s) => JSON.stringify(s.slice(0, 40))).join(", "),
      );
    }
  }

  if (e.react === "none" && reacted) {
    fail("speech", `expected no reaction, got ${o.reacts.filter(Boolean).join(",")}`);
  } else if (e.react === "any" && !reacted) {
    fail("speech", "expected a reaction, got none");
  } else if (Array.isArray(e.react)) {
    const got = o.reacts.filter((r): r is string => !!r);
    const ok = got.length > 0 && got.every((r) => e.react!.includes(r));
    if (!ok) fail("speech", `expected a reaction in [${e.react.join(",")}], got [${got.join(",")}]`);
  }

  for (const who of e.mustMention ?? []) {
    if (!mentions(joined, who)) fail("speech", `expected the reply to name ${who}`);
  }
  for (const who of e.mustNotMention ?? []) {
    if (mentions(joined, who)) fail("speech", `the reply must NOT name ${who}`);
  }
  for (const src of e.mustMatch ?? []) {
    if (!new RegExp(src, "i").test(joined)) fail("speech", `expected the reply to match /${src}/i`);
  }
  for (const src of e.mustNotMatch ?? []) {
    if (new RegExp(src, "i").test(joined)) fail("speech", `the reply must NOT match /${src}/i`);
  }

  if (e.noRawPhone !== false) {
    for (const t of allText) {
      if (RAW_PHONE.test(t)) fail("speech", `a raw phone number leaked into "${t.slice(0, 60)}"`);
    }
  }

  // Words must match action (S7, Erdal 2026-05-15).
  if (e.claimsMatchWrites !== false) {
    for (const claim of claimedMoves(joined)) {
      // Only judge claims about people this world knows about.
      const known = c.world.players.find((p) => mentions(p.name, claim.name));
      if (!known) continue;
      const got = statusOf(o.attendanceAfter, known.name);
      if (got !== claim.status) {
        fail(
          "speech",
          `claimed "${known.name} → ${claim.status}" but the database says ${got}`,
        );
      }
    }
  }

  const classification = SEVERITY.find((s) => seen.includes(s)) ?? null;
  return { passed: failures.length === 0, failures, classification };
}

// ── Scoreboard ─────────────────────────────────────────────────────────

export interface CaseRunSummary {
  caseId: string;
  sections: string[];
  category: Category;
  /** How many times the case was replayed (live cases repeat). */
  runs: number;
  passes: number;
  /** One entry per FAILED run. */
  classifications: Classification[];
  failures?: string[];
  skipped?: boolean;
}

export interface Bucket {
  cases: number;
  casesFullyPassed: number;
  runs: number;
  runsPassed: number;
}

export interface Scoreboard {
  /** `cases` counts only cases that RAN. `casesInCorpus` is the whole
   *  corpus and `casesNotRun` the difference — a case that never
   *  executed is never countable as a pass, in either mode. */
  totals: Bucket & {
    runPassRate: number;
    casePassRate: number;
    casesInCorpus: number;
    casesNotRun: number;
  };
  byCategory: Record<Category, Bucket>;
  bySection: Record<string, Bucket>;
  byClassification: Record<Classification, number>;
  /** §3.2 sections the CORPUS covers, whether or not they ran here. */
  sectionsWithACase: string[];
  /** §3.2 sections with no case at all. A deliverable in its own right. */
  coverageGaps: string[];
  /** §10 step 3's go/no-go numbers. */
  criteria: {
    spuriousWriteRuns: number;
    missedWriteRuns: number;
    missedWriteRate: number;
    spuriousWriteRate: number;
  };
  cases: CaseRunSummary[];
}

const emptyBucket = (): Bucket => ({ cases: 0, casesFullyPassed: 0, runs: 0, runsPassed: 0 });

export function buildScoreboard(
  results: CaseRunSummary[],
  opts: { sections?: readonly string[] } = {},
): Scoreboard {
  const sections = opts.sections ?? ALL_PROMPT_SECTIONS;
  const scored = results.filter((r) => !r.skipped);

  const totals = emptyBucket();
  const byCategory: Record<Category, Bucket> = {
    A: emptyBucket(),
    B: emptyBucket(),
    C: emptyBucket(),
    D: emptyBucket(),
    E: emptyBucket(),
  };
  const bySection: Record<string, Bucket> = {};
  for (const s of sections) bySection[s] = emptyBucket();
  const byClassification: Record<Classification, number> = {
    error: 0,
    spurious_write: 0,
    wrong_write: 0,
    missed_write: 0,
    speech: 0,
  };

  const add = (b: Bucket, r: CaseRunSummary) => {
    b.cases += 1;
    b.runs += r.runs;
    b.runsPassed += r.passes;
    if (r.runs > 0 && r.passes === r.runs) b.casesFullyPassed += 1;
  };

  for (const r of scored) {
    add(totals, r);
    add(byCategory[r.category], r);
    for (const s of r.sections) {
      bySection[s] ??= emptyBucket();
      add(bySection[s], r);
    }
    for (const k of r.classifications) byClassification[k] += 1;
  }

  // Coverage is a property of the CORPUS, not of one run: a case skipped
  // for want of a stub verdict still covers its section. Counting only
  // the cases that ran would have reported 26 phantom gaps in the
  // stubbed baseline, which is exactly the kind of number that gets
  // repeated in a funding document.
  const covered = new Set<string>();
  for (const r of results) for (const s of r.sections) covered.add(s);
  const sectionsWithACase = sections.filter((s) => covered.has(s));
  const coverageGaps = sections.filter((s) => !covered.has(s));

  return {
    totals: {
      ...totals,
      runPassRate: totals.runs ? totals.runsPassed / totals.runs : 0,
      casePassRate: totals.cases ? totals.casesFullyPassed / totals.cases : 0,
      casesInCorpus: results.length,
      casesNotRun: results.length - scored.length,
    },
    byCategory,
    bySection,
    byClassification,
    sectionsWithACase,
    coverageGaps,
    criteria: {
      spuriousWriteRuns: byClassification.spurious_write,
      missedWriteRuns: byClassification.missed_write,
      missedWriteRate: totals.runs ? byClassification.missed_write / totals.runs : 0,
      spuriousWriteRate: totals.runs ? byClassification.spurious_write / totals.runs : 0,
    },
    cases: results,
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function renderScoreboard(sb: Scoreboard): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("══ INCIDENT CORPUS SCOREBOARD ═══════════════════════════════════");
  lines.push(
    `${sb.totals.casesFullyPassed} of ${sb.totals.cases} cases ran green ` +
      `(${pct(sb.totals.casePassRate)})   ` +
      `RUNS ${sb.totals.runsPassed}/${sb.totals.runs} (${pct(sb.totals.runPassRate)})`,
  );
  if (sb.totals.casesNotRun > 0) {
    lines.push(
      `⚠️  ${sb.totals.casesNotRun} of ${sb.totals.casesInCorpus} corpus cases DID NOT RUN in ` +
        `this mode and are NOT covered by the numbers above.`,
    );
    lines.push(
      `    A case with no stub verdict cannot be replayed deterministically — its outcome ` +
        `depends on the real model. Run \`npm run test:corpus:live\` for those.`,
    );
  }

  lines.push("");
  lines.push("by category (§3.1)");
  for (const cat of ["A", "B", "C", "D", "E"] as Category[]) {
    const b = sb.byCategory[cat];
    if (!b.cases) continue;
    lines.push(
      `  ${cat}  cases ${b.casesFullyPassed}/${b.cases}   runs ${b.runsPassed}/${b.runs}`,
    );
  }

  lines.push("");
  lines.push("failures by class (§10 step 3 criteria)");
  for (const k of SEVERITY) lines.push(`  ${k.padEnd(15)} ${sb.byClassification[k]}`);
  lines.push(
    `  → spurious-write runs ${sb.criteria.spuriousWriteRuns} (target 0), ` +
      `missed-write rate ${pct(sb.criteria.missedWriteRate)} (target ≤2%)`,
  );

  lines.push("");
  lines.push("per case");
  for (const c of sb.cases) {
    const mark = c.skipped ? "skip" : c.passes === c.runs ? " ok " : "FAIL";
    lines.push(
      `  [${mark}] ${c.caseId.padEnd(38)} ${c.passes}/${c.runs}  ${c.category} ${c.sections.join("+")}` +
        (c.failures?.length ? `\n           ↳ ${c.failures.slice(0, 3).join(" | ")}` : ""),
    );
  }

  lines.push("");
  lines.push(
    `coverage gap — §3.2 sections with NO case (${sb.coverageGaps.length}/${
      Object.keys(sb.bySection).length
    }): ${sb.coverageGaps.join(", ") || "none"}`,
  );
  lines.push("═════════════════════════════════════════════════════════════════");
  return lines.join("\n");
}
