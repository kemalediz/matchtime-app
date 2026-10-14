/**
 * CLUB REHEARSAL SCENARIO FILE (format v1): what a club looks like and
 * what happens to it, minute by minute. Pure: no I/O, no database.
 *
 * A scenario is plain JSON. It names the club and its settings, the
 * WhatsApp groups, the people in them, and a timeline of steps. The
 * runner (`rehearsal.spec.ts` + `driver.ts`) replays the timeline against
 * the real server with a moving clock and writes a transcript of
 * everything MatchTime did.
 *
 * Times are wall-clock times in the scenario's zone ("2026-10-23 20:30")
 * or ISO instants with a zone ("2026-10-23T19:30:00Z").
 *
 * Steps (the `do` field):
 *   message           someone writes in a group. Optional `route` and
 *                     `facts` are what the stubbed router and extractor
 *                     answer (ignored in live mode); `tag` = @MatchTime;
 *                     `media` = an attachment ("image", "gif", ...).
 *   dm                someone writes to MatchTime directly.
 *   vote              someone votes in the latest poll MatchTime posted
 *                     whose question matches `poll` (a regex), for the
 *                     option matching `option` (a regex), or null to clear.
 *   react             someone reacts to MatchTime's latest message
 *                     matching `target` (a regex).
 *   rate              someone opens the rating link MatchTime DM'd them and
 *                     submits the page (default scores), picking `mom`
 *                     (a regex on the player's name) as Man of the Match.
 *   club-signup       the organiser registers the club on the website and
 *                     sends the connect DM (stands in for the web flow).
 *   bot-added         MatchTime is added to `group` by `by`.
 *   approve           the MatchTime owner approves the club by DM.
 *   settings          the organiser saves settings (stands in for the
 *                     /admin/settings page; `values` uses SETTINGS keys).
 *   link-admin-group  `by` gets a link code and posts it in `group`.
 *   go-live           `from` DMs "GO".
 *   pi-poll           an extra poll of due posts at this instant.
 *   cron              fire one cron route at this instant.
 *   note              a heading in the transcript.
 */

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

// ── Time ──────────────────────────────────────────────────────────────

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONED_RE = /(Z|[+-]\d{2}:?\d{2})$/;

/** The zone's offset from UTC, in ms, at a given instant. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** A wall-clock time in `timeZone` (or a zoned ISO instant) as a Date. */
export function localToUtc(text: string, timeZone: string): Date {
  const t = text.trim();
  if (ZONED_RE.test(t) && /^\d{4}-\d{2}-\d{2}T/.test(t)) {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) throw new ScenarioError(`not a time: "${text}"`);
    return d;
  }
  const m = LOCAL_RE.exec(t);
  if (!m) throw new ScenarioError(`not a time: "${text}" (use "YYYY-MM-DD HH:mm" or an ISO instant with a zone)`);
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes settle the offset either side of a clock change.
  let guess = naive - zoneOffsetMs(naive, timeZone);
  guess = naive - zoneOffsetMs(guess, timeZone);
  return new Date(guess);
}

/** An instant as "YYYY-MM-DD HH:mm" in `timeZone`. */
export function formatLocal(d: Date, timeZone: string, withSeconds = false): string {
  const local = new Date(d.getTime() + zoneOffsetMs(d.getTime(), timeZone));
  const iso = local.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, withSeconds ? 19 : 16)}`;
}

// ── Shapes ────────────────────────────────────────────────────────────

export type MemberRole = "OWNER" | "ADMIN" | "PLAYER" | "NONE";
export type GroupRole = "players" | "admin" | "other";

export interface ScenarioGroup {
  key: string;
  subject: string;
  role: GroupRole;
  /** Is MatchTime a member of this group at all? */
  matchtime: boolean;
  /** "Only admins can send" (or a community announcements group). */
  onlyAdminsCanSend: boolean;
}

export interface ScenarioMember {
  key: string;
  name: string;
  /** The WhatsApp display name, when it differs from `name`; null when
   *  WhatsApp shows MatchTime no name for them, only the number. */
  pushname: string | null;
  /** E.164, with the + ("+447700900001"). */
  phone: string;
  /** NONE: in the groups but not a member of the club in MatchTime. */
  role: MemberRole;
  groups: string[];
}

/** Organisation columns a scenario may set, with the type each takes. */
export const SETTINGS: Record<string, "string" | "boolean" | "int" | "string|null" | "int|null"> = {
  listAnnouncer: "string",
  rollingSquadEnabled: "boolean",
  teamsReadyTime: "string|null",
  paymentTrackingEnabled: "boolean",
  paymentCollectionEnabled: "boolean",
  adminChannelMode: "string",
  language: "string",
  featureAttendance: "boolean",
  featureBench: "boolean",
  featureTeamBalancing: "boolean",
  featureMomVoting: "boolean",
  featurePlayerRating: "boolean",
  featureReminders: "boolean",
  featureStatsQa: "boolean",
  featureSquadFromList: "boolean",
  featureBadgeAnnouncements: "boolean",
  dropOutDeadlineDay: "int|null",
  dropOutDeadlineTime: "string|null",
  listPublishDay: "int|null",
  listPublishTime: "string|null",
  benchPickMode: "string",
  benchPickFallback: "string",
  squadMode: "string",
  paymentInstructions: "string|null",
};

export interface ScenarioClub {
  name: string;
  language: string;
  owner: string;
  paymentHolder: string | null;
  maxPlayers: number;
  sport: { name: string; playersPerTeam: number; teamLabels: [string, string] };
  activity: { dayOfWeek: number; time: string; durationMinutes: number; venue: string };
  settings: Record<string, string | number | boolean | null>;
  /** Template image + layout JSON for the club's own graphics, as file
   *  paths relative to the scenario file. Optional. */
  graphicsTemplate: { image: string; layout: string } | null;
}

interface StepBase {
  at: Date;
  /** Position in the file, for stable ordering and error messages. */
  seq: number;
  note?: string;
}

export type Step = StepBase &
  (
    | {
        do: "message";
        group: string;
        from: string;
        body: string;
        route?: string;
        facts?: Record<string, unknown>;
        tag?: boolean;
        media?: string;
        source?: "replay" | "script";
        /** Shorthand for route + facts (stub-routes.ts). */
        stub?: string;
      }
    | { do: "dm"; from: string; body: string; intent?: string; paymentClaim?: string }
    | { do: "vote"; from: string; poll: string; option: string | null }
    | { do: "react"; from: string; target: string; emoji: string }
    | { do: "rate"; from: string; mom?: string }
    | { do: "club-signup" }
    | { do: "bot-added"; group: string; by: string }
    | { do: "approve" }
    | { do: "settings"; values: Record<string, string | number | boolean | null> }
    | { do: "link-admin-group"; group: string; by: string }
    | { do: "go-live"; from: string }
    | { do: "pi-poll" }
    | { do: "cron"; path: string }
    | { do: "note"; text: string }
  );

export interface Scenario {
  version: 1;
  title: string;
  timezone: string;
  start: Date;
  end: Date;
  /** How often the emulated Pi polls due posts between steps. */
  pollEveryMinutes: number;
  /** The Pi's analyze batch window for the players' group. */
  batchMinutes: number;
  /** Crons to fire on their schedule; "vercel" = vercel.json's. */
  crons: "vercel" | Array<{ path: string; schedule: string }>;
  skipCrons: string[];
  /** Server feature flags, sent as the test-mode headers on every request
   *  (mirror production): self-join and the setup hold on, picture
   *  reading and the learned setup off, unless the scenario says. */
  flags: { selfJoin: boolean; setupHold: boolean; pictureReading: boolean; setupLearning: boolean };
  club: ScenarioClub;
  groups: ScenarioGroup[];
  members: ScenarioMember[];
  steps: Step[];
}

// ── Parsing ───────────────────────────────────────────────────────────

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const STEP_KINDS = new Set([
  "message",
  "dm",
  "vote",
  "react",
  "rate",
  "club-signup",
  "bot-added",
  "approve",
  "settings",
  "link-admin-group",
  "go-live",
  "pi-poll",
  "cron",
  "note",
]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(o: Obj, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== "string" || !v.trim()) throw new ScenarioError(`${where}: "${k}" must be a non-empty string`);
  return v;
}
function optStr(o: Obj, k: string, where: string): string | undefined {
  if (o[k] === undefined || o[k] === null) return undefined;
  return str(o, k, where);
}
function num(o: Obj, k: string, where: string, dflt?: number): number {
  const v = o[k] ?? dflt;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ScenarioError(`${where}: "${k}" must be a number`);
  return v;
}

function parseSettings(raw: unknown, where: string): Record<string, string | number | boolean | null> {
  if (raw === undefined) return {};
  if (!isObj(raw)) throw new ScenarioError(`${where}: settings must be an object`);
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    const type = SETTINGS[k];
    if (!type) throw new ScenarioError(`${where}: unknown setting "${k}" (known: ${Object.keys(SETTINGS).join(", ")})`);
    const ok =
      (v === null && type.endsWith("|null")) ||
      (typeof v === "string" && type.startsWith("string")) ||
      (typeof v === "boolean" && type === "boolean") ||
      (typeof v === "number" && Number.isInteger(v) && type.startsWith("int"));
    if (!ok) throw new ScenarioError(`${where}: setting "${k}" must be ${type}`);
    out[k] = v as string | number | boolean | null;
  }
  return out;
}

function parseDay(v: unknown, where: string): number {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 6) return v;
  if (typeof v === "string" && DAYS.includes(v.toLowerCase())) return DAYS.indexOf(v.toLowerCase());
  throw new ScenarioError(`${where}: day must be 0-6 or a day name`);
}

export function parseScenario(raw: unknown): Scenario {
  if (!isObj(raw)) throw new ScenarioError("scenario: not an object");
  if (raw.version !== 1) throw new ScenarioError(`scenario: unsupported version ${String(raw.version)} (expected 1)`);
  const timezone = (raw.timezone as string | undefined) ?? "Europe/London";
  const at = (v: unknown, where: string): Date => {
    if (typeof v !== "string") throw new ScenarioError(`${where}: "at" must be a time string`);
    try {
      return localToUtc(v, timezone);
    } catch (err) {
      throw new ScenarioError(`${where}: ${(err as Error).message}`);
    }
  };

  // Groups
  if (!Array.isArray(raw.groups) || raw.groups.length === 0) throw new ScenarioError("scenario: groups must be a non-empty list");
  const groups: ScenarioGroup[] = raw.groups.map((g, i) => {
    const where = `group ${i}`;
    if (!isObj(g)) throw new ScenarioError(`${where}: not an object`);
    const role = str(g, "role", where);
    if (!["players", "admin", "other"].includes(role)) throw new ScenarioError(`${where}: role must be players, admin or other`);
    return {
      key: str(g, "key", where),
      subject: str(g, "subject", where),
      role: role as GroupRole,
      matchtime: g.matchtime !== false,
      onlyAdminsCanSend: g.onlyAdminsCanSend === true,
    };
  });
  const groupKeys = new Set<string>();
  for (const g of groups) {
    if (groupKeys.has(g.key)) throw new ScenarioError(`duplicate group key "${g.key}"`);
    groupKeys.add(g.key);
  }
  if (groups.filter((g) => g.role === "players").length !== 1)
    throw new ScenarioError(`scenario: needs exactly one group with role "players"`);
  if (groups.filter((g) => g.role === "admin").length > 1)
    throw new ScenarioError(`scenario: at most one group with role "admin"`);

  // Members
  if (!Array.isArray(raw.members) || raw.members.length === 0) throw new ScenarioError("scenario: members must be a non-empty list");
  const members: ScenarioMember[] = raw.members.map((m, i) => {
    const where = `member ${i}`;
    if (!isObj(m)) throw new ScenarioError(`${where}: not an object`);
    const phone = str(m, "phone", where);
    if (!/^\+\d{8,15}$/.test(phone)) throw new ScenarioError(`${where}: phone must be E.164 with a + ("${phone}")`);
    const role = (optStr(m, "role", where) ?? "PLAYER").toUpperCase();
    if (!["OWNER", "ADMIN", "PLAYER", "NONE"].includes(role)) throw new ScenarioError(`${where}: unknown role "${role}"`);
    const gs = Array.isArray(m.groups) ? (m.groups as unknown[]).map(String) : [];
    for (const g of gs) if (!groupKeys.has(g)) throw new ScenarioError(`${where}: unknown group "${g}"`);
    const name = str(m, "name", where);
    return { key: str(m, "key", where), name, pushname: m.pushname === null ? null : (optStr(m, "pushname", where) ?? name), phone, role: role as MemberRole, groups: gs };
  });
  const memberKeys = new Map<string, ScenarioMember>();
  const phones = new Set<string>();
  for (const m of members) {
    if (memberKeys.has(m.key)) throw new ScenarioError(`duplicate member key "${m.key}"`);
    if (phones.has(m.phone)) throw new ScenarioError(`two members have the same phone (${m.key})`);
    memberKeys.set(m.key, m);
    phones.add(m.phone);
  }
  const member = (k: unknown, where: string): string => {
    if (typeof k !== "string" || !memberKeys.has(k)) throw new ScenarioError(`${where}: unknown member "${String(k)}"`);
    return k;
  };
  const group = (k: unknown, where: string): string => {
    if (typeof k !== "string" || !groupKeys.has(k)) throw new ScenarioError(`${where}: unknown group "${String(k)}"`);
    return k;
  };

  // Club
  if (!isObj(raw.club)) throw new ScenarioError("scenario: club must be an object");
  const c = raw.club;
  if (!isObj(c.sport)) throw new ScenarioError("club: sport must be an object");
  if (!isObj(c.activity)) throw new ScenarioError("club: activity must be an object");
  const labels = Array.isArray(c.sport.teamLabels) ? (c.sport.teamLabels as string[]) : ["Red", "Yellow"];
  const tmpl = c.graphicsTemplate;
  const club: ScenarioClub = {
    name: str(c, "name", "club"),
    language: (c.language as string | undefined) ?? "en",
    owner: member(c.owner, "club.owner"),
    paymentHolder: c.paymentHolder ? member(c.paymentHolder, "club.paymentHolder") : null,
    maxPlayers: num(c, "maxPlayers", "club"),
    sport: {
      name: str(c.sport, "name", "club.sport"),
      playersPerTeam: num(c.sport, "playersPerTeam", "club.sport"),
      teamLabels: [labels[0] ?? "Red", labels[1] ?? "Yellow"],
    },
    activity: {
      dayOfWeek: parseDay(c.activity.day, "club.activity"),
      time: str(c.activity, "time", "club.activity"),
      durationMinutes: num(c.activity, "durationMinutes", "club.activity", 90),
      venue: optStr(c.activity, "venue", "club.activity") ?? "TBC",
    },
    settings: parseSettings(c.settings, "club"),
    graphicsTemplate:
      isObj(tmpl) && typeof tmpl.image === "string" && typeof tmpl.layout === "string"
        ? { image: tmpl.image, layout: tmpl.layout }
        : null,
  };

  const start = at(raw.start, "scenario.start");
  const end = at(raw.end, "scenario.end");
  if (end <= start) throw new ScenarioError("scenario: end must be after start");

  // Steps
  if (!Array.isArray(raw.steps)) throw new ScenarioError("scenario: steps must be a list");
  const inGroup = (who: string, g: string, where: string) => {
    if (!memberKeys.get(who)!.groups.includes(g)) throw new ScenarioError(`${where}: "${who}" is not in group "${g}"`);
  };
  const steps: Step[] = raw.steps.map((s, seq) => {
    const where = `step ${seq}`;
    if (!isObj(s)) throw new ScenarioError(`${where}: not an object`);
    const kind = s.do;
    if (typeof kind !== "string" || !STEP_KINDS.has(kind)) throw new ScenarioError(`${where}: unknown step "${String(kind)}"`);
    const when = at(s.at, where);
    if (when < start) throw new ScenarioError(`${where}: before the scenario's start`);
    if (when > end) throw new ScenarioError(`${where}: after the scenario's end`);
    const b = { at: when, seq, ...(typeof s.note === "string" ? { note: s.note } : {}) };
    switch (kind) {
      case "message": {
        const g = group(s.group, where);
        const from = member(s.from, where);
        inGroup(from, g, where);
        return {
          ...b,
          do: "message",
          group: g,
          from,
          body: typeof s.body === "string" ? s.body : "",
          ...(typeof s.route === "string" ? { route: s.route } : {}),
          ...(isObj(s.facts) ? { facts: s.facts } : {}),
          ...(s.tag === true ? { tag: true } : {}),
          ...(typeof s.media === "string" ? { media: s.media } : {}),
          ...(s.source === "replay" || s.source === "script" ? { source: s.source } : {}),
          ...(typeof s.stub === "string" ? { stub: s.stub } : {}),
        };
      }
      case "dm":
        return {
          ...b,
          do: "dm",
          from: member(s.from, where),
          body: str(s, "body", where),
          ...(typeof s.intent === "string" ? { intent: s.intent } : {}),
          ...(typeof s.paymentClaim === "string" ? { paymentClaim: s.paymentClaim } : {}),
        };
      case "vote":
        return {
          ...b,
          do: "vote",
          from: member(s.from, where),
          poll: str(s, "poll", where),
          option: s.option === null ? null : str(s, "option", where),
        };
      case "react":
        return { ...b, do: "react", from: member(s.from, where), target: str(s, "target", where), emoji: str(s, "emoji", where) };
      case "rate":
        return { ...b, do: "rate", from: member(s.from, where), ...(typeof s.mom === "string" ? { mom: s.mom } : {}) };
      case "club-signup":
      case "approve":
      case "pi-poll":
        return { ...b, do: kind };
      case "bot-added":
      case "link-admin-group": {
        const g = group(s.group, where);
        return { ...b, do: kind, group: g, by: member(s.by, where) };
      }
      case "settings":
        return { ...b, do: "settings", values: parseSettings(s.values, where) };
      case "go-live":
        return { ...b, do: "go-live", from: member(s.from, where) };
      case "cron":
        return { ...b, do: "cron", path: str(s, "path", where) };
      case "note":
        return { ...b, do: "note", text: str(s, "text", where) };
    }
    throw new ScenarioError(`${where}: unknown step "${kind}"`);
  });
  steps.sort((a, b) => a.at.getTime() - b.at.getTime() || a.seq - b.seq);

  let crons: Scenario["crons"] = "vercel";
  if (Array.isArray(raw.crons)) {
    crons = raw.crons.map((c2, i) => {
      if (!isObj(c2)) throw new ScenarioError(`cron ${i}: not an object`);
      return { path: str(c2, "path", `cron ${i}`), schedule: str(c2, "schedule", `cron ${i}`) };
    });
  }

  return {
    version: 1,
    title: str(raw, "title", "scenario"),
    timezone,
    start,
    end,
    pollEveryMinutes: num(raw, "pollEveryMinutes", "scenario", 60),
    batchMinutes: num(raw, "batchMinutes", "scenario", 10),
    crons,
    flags: {
      selfJoin: !(isObj(raw.flags) && raw.flags.selfJoin === false),
      setupHold: !(isObj(raw.flags) && raw.flags.setupHold === false),
      pictureReading: isObj(raw.flags) && raw.flags.pictureReading === true,
      setupLearning: isObj(raw.flags) && raw.flags.setupLearning === true,
    },
    skipCrons: Array.isArray(raw.skipCrons) ? (raw.skipCrons as unknown[]).map(String) : ["/api/cron/none-bucket-shadow"],
    club,
    groups,
    members,
    steps,
  };
}
