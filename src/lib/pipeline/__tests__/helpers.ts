/**
 * Test-only builders for the decision engine.
 *
 * The engine is a pure function of (facts, state, now), so a test world
 * is a plain object — no DB, no fixtures, no Playwright. That is the
 * whole point of extracting it (§12.3): "does an admin demote work?"
 * stops being a question you can only answer with a live model and
 * becomes a unit test running in a millisecond.
 */
import type {
  AttendanceFacts,
  Claim,
  EngineMessage,
  Facts,
  Member,
  Route,
  SquadState,
} from "../types";

export const SUTTON = [
  "kemal",
  "elvin",
  "sait",
  "mustafa",
  "abid",
  "idris",
  "faris",
  "shaz",
  "adam",
  "efat",
  "usama",
  "karahan",
  "zair",
  "wasim",
  "habib",
  "najib",
  "ehtisham",
  "mojib",
  "erdal",
  "enayem",
  "amir",
  "zeeshan",
  "ayoub",
] as const;

const FULL_NAMES: Record<string, string> = {
  kemal: "Kemal Ediz",
  elvin: "Elvin Aliyev",
  sait: "Sait Demir",
  mustafa: "Mustafa Kaya",
  abid: "Abid Hussain",
  idris: "Idris Bello",
  faris: "Faris Nasser",
  shaz: "Shaz Iqbal",
  adam: "Adam Osman",
  efat: "Efat Rahman",
  usama: "Usama Tariq",
  karahan: "Karahan Yildiz",
  zair: "Zair Malik",
  wasim: "Wasim Akhtar",
  habib: "Habib Rahman",
  najib: "Najib Ahmadi",
  ehtisham: "Ehtisham Ul Haq",
  mojib: "Mojib Sadat",
  erdal: "Erdal Ozkan",
  enayem: "Enayem Rashid",
  amir: "Amir Ahmadi",
  zeeshan: "Zeeshan Khan",
  // One name, no surname — which is how he appears in the live group
  // ("Shahrokh🐔 Sutton Football Club") and how the 2026-09-07 incident
  // message refers to him.
  shahrokh: "Shahrokh",
  ayoub: "Ayoub Benali",
  // One name, no surname, exactly as he appears in the live group.
  david: "David",
  salman: "Salman Shelly",
  talha: "Talha Younis",
  aydin: "Aydin Celik",
  izzet: "Izzet Erdogan",
  elnur: "Elnur Mammadov",
  rashad: "Rashad Ali",
  nabeel: "Nabeel Ahmed",
  omar: "Omar Farooq",
  hasan: "Hasan Yilmaz",
};

export function fullName(key: string): string {
  return FULL_NAMES[key] ?? key;
}

export function member(key: string, opts: Partial<Member> = {}): Member {
  return {
    userId: `u-${key}`,
    name: fullName(key),
    isAdmin: key === "kemal" || key === "elvin",
    hasPhone: true,
    ...opts,
  };
}

export interface WorldOpts {
  maxPlayers?: number;
  /** Roster keys. Defaults to the Sutton squad. */
  players?: string[];
  confirmed?: string[];
  bench?: string[];
  dropped?: string[];
  openOffers?: SquadState["openOffers"];
  lastBotPost?: string | null;
  noMatch?: boolean;
  teams?: Record<string, "RED" | "YELLOW">;
  /** The last match actually played. `status` and `isHistorical` default
   *  to a real COMPLETED match; a test that cares (the score route
   *  accepts three statuses, a payment credit accepts one) says so. */
  completedMatch?: Partial<NonNullable<SquadState["completedMatch"]>> & { id: string };
  appearances?: SquadState["appearances"];
  appearanceWindowDays?: number;
  features?: Partial<SquadState["features"]>;
  smallerFormats?: SquadState["smallerFormats"];
  guestAskedUserIds?: string[];
  payments?: SquadState["payments"];
  ratingProgress?: SquadState["ratingProgress"];
  noPhone?: string[];
  admins?: string[];
}

export function world(opts: WorldOpts = {}): SquadState {
  const keys = opts.players ?? [...SUTTON];
  const admins = opts.admins ?? ["kemal", "elvin"];
  const roster = keys.map((k) =>
    member(k, { isAdmin: admins.includes(k), hasPhone: !(opts.noPhone ?? []).includes(k) }),
  );
  const rows: SquadState["rows"] = [];
  let pos = 0;
  for (const k of opts.confirmed ?? []) rows.push({ userId: `u-${k}`, status: "CONFIRMED", position: ++pos });
  for (const k of opts.bench ?? []) rows.push({ userId: `u-${k}`, status: "BENCH", position: ++pos });
  for (const k of opts.dropped ?? []) rows.push({ userId: `u-${k}`, status: "DROPPED", position: ++pos });
  return {
    matchId: opts.noMatch ? null : "match-1",
    maxPlayers: opts.maxPlayers ?? 14,
    kickoffLabel: "Tue 21:30",
    venue: "Goals North Cheam",
    rows,
    roster,
    openOffers: opts.openOffers ?? [],
    teams: Object.entries(opts.teams ?? {}).map(([k, team]) => ({ userId: `u-${k}`, team })),
    teamLabels: ["Red", "Yellow"],
    completedMatch: opts.completedMatch
      ? {
          kickoffLabel: "Tue 21:30",
          status: "COMPLETED",
          isHistorical: false,
          redScore: null,
          yellowScore: null,
          participantUserIds: [],
          ...opts.completedMatch,
        }
      : null,
    appearances: opts.appearances ?? [],
    appearanceWindowDays: opts.appearanceWindowDays ?? 30,
    lastBotPost: opts.lastBotPost ?? null,
    features: {
      attendance: true,
      paymentTracking: false,
      statsQa: true,
      reminders: true,
      ...(opts.features ?? {}),
    },
    smallerFormats: opts.smallerFormats ?? [],
    guestAskedUserIds: opts.guestAskedUserIds ?? [],
    payments: opts.payments ?? null,
    ratingProgress: opts.ratingProgress ?? null,
  };
}

export function claim(partial: Partial<Claim> = {}): Claim {
  return {
    subject: "sender",
    personRef: "",
    personNamed: false,
    polarity: "in",
    contingent: false,
    conditionOn: "none",
    tense: "present",
    basis: "decision",
    reported: false,
    confidence: 0.95,
    ...partial,
  };
}

export function attendanceFacts(
  claims: Claim[],
  extra: Partial<Omit<AttendanceFacts, "kind" | "claims">> = {},
): AttendanceFacts {
  return { kind: "attendance", claims, affirmation: null, sideRequests: [], ...extra };
}

export interface MsgOpts {
  id?: string;
  from: string | null;
  body?: string;
  tagged?: boolean;
  route: Route;
  facts: Facts;
  degraded?: string | null;
}

let seq = 0;
export function msg(o: MsgOpts): EngineMessage {
  return {
    id: o.id ?? `wa-${++seq}`,
    body: o.body ?? "",
    senderUserId: o.from ? `u-${o.from}` : null,
    senderName: o.from ? fullName(o.from) : null,
    tagged: o.tagged ?? false,
    route: o.route,
    facts: o.facts,
    degraded: o.degraded ?? null,
  };
}

/** Status of a roster key in a projected state. */
export function statusOf(state: SquadState, key: string): string {
  return state.rows.find((r) => r.userId === `u-${key}`)?.status ?? "ABSENT";
}

export function confirmedCount(state: SquadState): number {
  return state.rows.filter((r) => r.status === "CONFIRMED").length;
}

export function benchCount(state: SquadState): number {
  return state.rows.filter((r) => r.status === "BENCH").length;
}

export const NOW = new Date("2026-09-01T18:00:00.000Z");
