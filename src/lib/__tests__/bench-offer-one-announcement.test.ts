/**
 * SEVERAL PLACES OPEN AT ONCE ARE ANNOUNCED ONCE (2026-10-06).
 *
 * A club on "the organisers pick" with "if nobody picks in time: offer it
 * to the waiting list". When the pick time passes, `runFallback`
 * (`organiser-pick.ts`) opens the bench offers, and section 3 of the
 * scheduler announces them. It used to post one group message and one DM
 * per waiting player for EACH open offer: a new club with three places
 * open and two people waiting got the same "A slot just opened" post
 * three times and each waiting player three DMs (sixteen places: sixteen
 * of each, the group posts held to three per five minutes by the
 * repetition guard and so trickling out for half an hour).
 *
 * Driven through the real `computeDuePosts` with Prisma mocked (the proxy
 * pattern of rolling-squad-scheduler.test.ts). No model is called.
 *
 * What is pinned:
 *   1. offers the group has not been told about go out as ONE post and
 *      ONE DM per waiting player, saying how many;
 *   2. once told, nothing more is sent, also after the offer the post was
 *      keyed on has been taken;
 *   3. a single drop reads and is keyed exactly as it always was;
 *   4. a place that opens later is announced on its own;
 *   5. "tonight" only on match day, in English and in Turkish.
 */
import { describe, it, expect, vi } from "vitest";

type Overrides = Record<string, Record<string, (...a: unknown[]) => unknown>>;
const overrides: Overrides = {};

function defaultFor(method: string) {
  if (method === "findMany" || method === "groupBy") return async () => [];
  if (method === "count") return async () => 0;
  if (method === "findFirst" || method === "findUnique") return async () => null;
  return async () => ({});
}

vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy({}, { get: (_t2, method: string) => overrides[model]?.[method] ?? defaultFor(method) }),
    },
  ),
}));

const features: Record<string, unknown> = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: true,
  paymentTracking: false,
  paymentCollection: false,
  squadFromList: false,
  language: "en",
  rollingSquad: false,
  benchPickMode: "organiser",
};
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ ...features }) }));
vi.mock("@/lib/message-analyzer", () => ({ composeChaseText: async () => "MODEL TEXT" }));

import { computeDuePosts } from "@/lib/bot-scheduler";
import { buildBenchOfferContext } from "@/lib/scheduler-copy";
import { buildBenchOfferDm, buildBenchOfferGroupPost } from "@/lib/bench-offer-copy";

const GROUP = "group-new-club@g.us";
const ORG = { id: "org-new-club", whatsappGroupId: GROUP, whatsappBotEnabled: true };
const MATCH_ID = "m-tue-6-oct";

/** Tue 6 Oct 2026, 21:30 London (20:30 UTC, BST). */
const KICKOFF = new Date("2026-10-06T20:30:00.000Z");
/** Sat 3 Oct 2026, 13:33 London: three days before the match. */
const SATURDAY = new Date("2026-10-03T12:33:00.000Z");
/** Tue 6 Oct 2026, 13:00 London: match day. */
const MATCH_DAY = new Date("2026-10-06T12:00:00.000Z");
/** When the fallback opened the offers, a second apart. */
const OPENED = new Date("2026-10-03T12:30:00.000Z");

function player(name: string, i: number, status = "CONFIRMED") {
  return {
    id: `att-${i}`,
    userId: `u${i}`,
    status,
    position: i + 1,
    paidAt: null,
    directPendingAt: null,
    user: { id: `u${i}`, name, phoneNumber: `+4477009000${String(i).padStart(2, "0")}` },
  };
}

interface Offer {
  id: string;
  replacingUserId: string | null;
  createdAt: Date;
}
const offer = (n: number, at = new Date(OPENED.getTime() + n * 1000)): Offer => ({ id: `o${n}`, replacingUserId: null, createdAt: at });

/** Eleven of fourteen in, Ozgur and Wasim waiting. */
function match(offers: Offer[]) {
  return {
    id: MATCH_ID,
    date: KICKOFF,
    status: "UPCOMING",
    maxPlayers: 14,
    isHistorical: false,
    activityId: "tue-7",
    attendanceDeadline: KICKOFF,
    attendances: [
      ...Array.from({ length: 11 }, (_, i) => player(`Player ${i + 1}`, i)),
      player("Ozgur Demir", 20, "BENCH"),
      player("Wasim Wali", 21, "BENCH"),
    ],
    teamAssignments: [] as unknown[],
    benchConfirmations: [] as unknown[],
    benchSlotOffers: offers,
    paymentCredits: [] as unknown[],
    activity: {
      id: "tue-7",
      orgId: ORG.id,
      name: "Tuesday 7-a-side",
      venue: "Goals North Cheam",
      dayOfWeek: 2,
      matchDurationMins: 60,
      sport: { name: "Football 7-a-side", playersPerTeam: 7, teamLabels: null },
      org: { paymentCollectionEnabled: false, paymentHolderId: null, teamLabels: null, language: features.language },
    },
  };
}

/**
 * `sent`: the keys already claimed. `closed`: offers of the match that
 * are no longer open (taken, refilled), which the open list above does
 * not carry.
 */
function setWorld(m: ReturnType<typeof match>, opts: { sent?: string[]; closed?: Offer[] } = {}) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  overrides.organisation = { findFirst: async () => ORG };
  overrides.match = { findMany: async () => [m] };
  overrides.sentNotification = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { kind?: unknown; key?: unknown } }).where ?? {};
      // The sent-keys read has neither a `kind` nor a `key` filter.
      if (where.kind || where.key) return [];
      return (opts.sent ?? []).map((key) => ({ key }));
    },
  };
  overrides.benchSlotOffer = {
    findMany: async () => (opts.closed ?? []).map((o) => ({ id: o.id, createdAt: o.createdAt })),
  };
  overrides.activity = { count: async () => 0 };
}

type Instr = { kind: string; key: string; text: string; phone?: string; targetUser?: string };

async function offerPosts(now: Date): Promise<Instr[]> {
  const res = await computeDuePosts(GROUP, now);
  return ((res?.instructions ?? []) as unknown as Instr[]).filter((i) => i.key.startsWith("offer-"));
}
const shape = (out: Instr[]) => out.map((i) => [i.kind, i.key]);

describe("nobody picked in time: the offers are announced once", () => {
  it("THE REPORTED CASE: three offers and two people waiting is ONE group post and ONE DM each", async () => {
    setWorld(match([offer(1), offer(2), offer(3)]));
    const out = await offerPosts(SATURDAY);
    // Keyed on the newest offer: it is the last one a claim takes (claims
    // go oldest first), so the post stays answerable until they are gone.
    expect(shape(out)).toEqual([
      ["bench-prompt", "offer-o3"],
      ["dm", "offer-o3:dm:u20"],
      ["dm", "offer-o3:dm:u21"],
    ]);
    expect(out[0].text).toBe(
      "🎟 3 slots just opened for *Tuesday 7-a-side* on Tue 6 Oct. *First to claim them play.*\n\n" +
        "@447700900020 @447700900021\n\n" +
        "Just reply *IN* here to take one. No rush and no timeout, the slots go to whoever replies first " +
        "and anyone who misses out stays on the bench. 🙏",
    );
    expect(out[1].text).toBe(
      "👋 Hi Ozgur, 3 slots just opened for Tuesday 7-a-side on Tue 6 Oct and you're on the bench.\n\n" +
        "Want one? Reply *YES* here, or *IN* on the message I tagged you in, in the group. First to claim plays. " +
        "No timeout, and if you're not free no worries, you stay on the bench. 🙏",
    );
  });

  it("sixteen offers are still one post and one DM each", async () => {
    setWorld(match(Array.from({ length: 16 }, (_, i) => offer(i + 1))));
    const out = await offerPosts(SATURDAY);
    expect(out.filter((i) => i.kind === "bench-prompt")).toHaveLength(1);
    expect(out.filter((i) => i.kind === "dm").map((i) => i.targetUser)).toEqual(["u20", "u21"]);
  });

  it("once told, nothing more goes out on later polls", async () => {
    setWorld(match([offer(1), offer(2), offer(3)]), { sent: ["offer-o3", "offer-o3:dm:u20", "offer-o3:dm:u21"] });
    expect(await offerPosts(SATURDAY)).toEqual([]);
  });

  it("the offer the post was keyed on is taken first: the ones still open are not announced again", async () => {
    setWorld(match([offer(1), offer(2)]), {
      sent: ["offer-o3", "offer-o3:dm:u20", "offer-o3:dm:u21"],
      closed: [offer(3)],
    });
    expect(await offerPosts(SATURDAY)).toEqual([]);
  });

  it("a waiting player whose DM did not go out is still sent it, once", async () => {
    setWorld(match([offer(1), offer(2), offer(3)]), { sent: ["offer-o3", "offer-o3:dm:u20"] });
    expect(shape(await offerPosts(SATURDAY))).toEqual([["dm", "offer-o3:dm:u21"]]);
  });

  it("a place that opens AFTER the group was told is announced on its own, as a single slot", async () => {
    const later = offer(4, new Date(OPENED.getTime() + 60 * 60 * 1000));
    setWorld(match([offer(1), offer(2), offer(3), later]), { sent: ["offer-o3", "offer-o3:dm:u20", "offer-o3:dm:u21"] });
    const out = await offerPosts(SATURDAY);
    expect(shape(out)).toEqual([
      ["bench-prompt", "offer-o4"],
      ["dm", "offer-o4:dm:u20"],
      ["dm", "offer-o4:dm:u21"],
    ]);
    expect(out[0].text).toContain("🎟 A slot just opened for *Tuesday 7-a-side* on Tue 6 Oct.");
  });

  it("on match day it says 'tonight'", async () => {
    setWorld(match([offer(1), offer(2)]));
    const out = await offerPosts(MATCH_DAY);
    expect(out[0].text).toContain("🎟 2 slots just opened for *Tuesday 7-a-side* tonight.");
    expect(out[1].text).toContain("2 slots just opened for Tuesday 7-a-side tonight and you're on the bench.");
  });

  it("in Turkish, with no long dashes", async () => {
    features.language = "tr";
    try {
      setWorld(match([offer(1), offer(2), offer(3)]));
      const out = await offerPosts(SATURDAY);
      expect(shape(out)).toEqual([
        ["bench-prompt", "offer-o3"],
        ["dm", "offer-o3:dm:u20"],
        ["dm", "offer-o3:dm:u21"],
      ]);
      expect(out[0].text).toBe(
        "🎟 3 yer açıldı: 6 Ekim Salı günkü *Tuesday 7-a-side* için. *İlk sahiplenenler oynar.*\n\n" +
          "@447700900020 @447700900021\n\n" +
          "Birini almak için buraya *VARIM* yazmanız yeterli. Acele yok, süre sınırı yok; yerler önce yazanların olur, " +
          "yer kalmazsa diğerleri yedekte kalır. 🙏",
      );
      expect(out[1].text).toBe(
        "👋 Ozgur, 3 yer açıldı: 6 Ekim Salı günkü Tuesday 7-a-side için. Yedekte olduğun için sana da yazıyorum.\n\n" +
          "Birini ister misin? Almak için buraya *EVET* yaz ya da gruptaki etiketlediğim mesaja *VARIM* diye cevap ver. " +
          "İlk sahiplenen oynar. Süre sınırı yok, müsait değilsen de sorun değil, yedekte kalırsın. 🙏",
      );
      for (const i of out) expect(i.text).not.toMatch(/[–—]/);
    } finally {
      features.language = "en";
    }
  });
});

describe("an ordinary single drop is untouched", () => {
  it("one offer: the same keys and the same bytes as before", async () => {
    setWorld(match([offer(1)]));
    const out = await offerPosts(SATURDAY);
    const ctx = buildBenchOfferContext({ activityName: "Tuesday 7-a-side", team: null, matchDate: KICKOFF, now: SATURDAY, lang: "en" });
    expect(out).toMatchObject([
      {
        kind: "bench-prompt",
        key: "offer-o1",
        text: buildBenchOfferGroupPost({ context: ctx.group, tagList: "@447700900020 @447700900021", lang: "en" }),
      },
      { kind: "dm", key: "offer-o1:dm:u20", text: buildBenchOfferDm({ firstName: "Ozgur", context: ctx.plain, lang: "en" }) },
      { kind: "dm", key: "offer-o1:dm:u21", text: buildBenchOfferDm({ firstName: "Wasim", context: ctx.plain, lang: "en" }) },
    ]);
    expect(out[0].text).toContain("🎟 A slot just opened for *Tuesday 7-a-side* on Tue 6 Oct. *First to claim it plays.*");
  });

  it("one offer already announced: nothing", async () => {
    setWorld(match([offer(1)]), { sent: ["offer-o1", "offer-o1:dm:u20", "offer-o1:dm:u21"] });
    expect(await offerPosts(SATURDAY)).toEqual([]);
  });

  it("two drops an hour apart, each announced when it happened: two posts, as before", async () => {
    const second = offer(2, new Date(OPENED.getTime() + 60 * 60 * 1000));
    setWorld(match([offer(1), second]), { sent: ["offer-o1", "offer-o1:dm:u20", "offer-o1:dm:u21"] });
    expect(shape(await offerPosts(SATURDAY))).toEqual([
      ["bench-prompt", "offer-o2"],
      ["dm", "offer-o2:dm:u20"],
      ["dm", "offer-o2:dm:u21"],
    ]);
  });
});

/**
 * SUTTON FC'S SHAPE: first come, teams published, and each offer says
 * whose place it is. Two players dropping overnight on match day wait
 * for the 08:00 gate together, so they go out as one post, and that post
 * must still say which team each place is on and who it replaces.
 */
describe("Sutton's shape: first come, teams published, a replaced player", () => {
  /** Tue 6 Oct 2026, 07:59 London: still inside the overnight quiet. */
  const BEFORE_8AM = new Date("2026-10-06T06:59:00.000Z");
  /** Tue 6 Oct 2026, 08:00 London. */
  const AT_8AM = new Date("2026-10-06T07:00:20.000Z");
  /** 00:24 and 03:10 London, the night before the match. */
  const DROP_1 = new Date("2026-10-05T23:24:00.000Z");
  const DROP_2 = new Date("2026-10-06T02:10:00.000Z");
  const TAGS = "@447700900020 @447700900021";

  /** Player 4 (Red) and Player 10 (Yellow) have dropped; teams are out. */
  function sutton(offers: Offer[]) {
    const m = match(offers);
    m.attendances[3].status = "DROPPED";
    m.attendances[9].status = "DROPPED";
    m.teamAssignments = [
      { id: "ta-3", userId: "u3", team: "RED", user: { id: "u3", name: "Player 4" } },
      { id: "ta-9", userId: "u9", team: "YELLOW", user: { id: "u9", name: "Player 10" } },
    ];
    return m;
  }
  const firstCome = async <T>(run: () => Promise<T>): Promise<T> => {
    features.benchPickMode = "first-come";
    try {
      return await run();
    } finally {
      features.benchPickMode = "organiser";
    }
  };

  it("ONE drop: the key and every byte are what main sent", async () => {
    setWorld(sutton([{ id: "o1", replacingUserId: "u3", createdAt: DROP_1 }]));
    const out = await firstCome(() => offerPosts(AT_8AM));
    expect(out.map((i) => [i.kind, i.key, i.text])).toEqual([
      [
        "bench-prompt",
        "offer-o1",
        "🎟 A slot just opened on *Red* (replacing Player 4) for *Tuesday 7-a-side* tonight. *First to claim it plays.*\n\n" +
          `${TAGS}\n\n` +
          "Just reply *IN* here to take it. No rush and no timeout, whoever is free first gets it " +
          "and everyone else stays on the bench. 🙏",
      ],
      [
        "dm",
        "offer-o1:dm:u20",
        "👋 Hi Ozgur, a slot just opened on Red (replacing Player 4) for Tuesday 7-a-side tonight and you're on the bench.\n\n" +
          "Want it? Reply *YES* here, or *IN* on the message I tagged you in, in the group. First to claim plays. " +
          "No timeout, and if you're not free no worries, you stay on the bench. 🙏",
      ],
      [
        "dm",
        "offer-o1:dm:u21",
        "👋 Hi Wasim, a slot just opened on Red (replacing Player 4) for Tuesday 7-a-side tonight and you're on the bench.\n\n" +
          "Want it? Reply *YES* here, or *IN* on the message I tagged you in, in the group. First to claim plays. " +
          "No timeout, and if you're not free no worries, you stay on the bench. 🙏",
      ],
    ]);
  });

  it("TWO drops overnight: nothing before 08:00, then ONE post that still names each team and replaced player", async () => {
    const offers = [
      { id: "o1", replacingUserId: "u3", createdAt: DROP_1 },
      { id: "o2", replacingUserId: "u9", createdAt: DROP_2 },
    ];
    setWorld(sutton(offers));
    expect(await firstCome(() => offerPosts(BEFORE_8AM))).toEqual([]);
    const out = await firstCome(() => offerPosts(AT_8AM));
    expect(shape(out)).toEqual([
      ["bench-prompt", "offer-o2"],
      ["dm", "offer-o2:dm:u20"],
      ["dm", "offer-o2:dm:u21"],
    ]);
    expect(out[0].text).toBe(
      "🎟 2 slots just opened for *Tuesday 7-a-side* tonight. *First to claim them play.*\n" +
        "• on *Red*, replacing Player 4\n" +
        "• on *Yellow*, replacing Player 10\n\n" +
        `${TAGS}\n\n` +
        "Just reply *IN* here to take one. No rush and no timeout, the slots go to whoever replies first " +
        "and anyone who misses out stays on the bench. 🙏",
    );
    expect(out[1].text).toBe(
      "👋 Hi Ozgur, 2 slots just opened for Tuesday 7-a-side tonight and you're on the bench.\n" +
        "• on Red, replacing Player 4\n" +
        "• on Yellow, replacing Player 10\n\n" +
        "Want one? Reply *YES* here, or *IN* on the message I tagged you in, in the group. First to claim plays. " +
        "No timeout, and if you're not free no worries, you stay on the bench. 🙏",
    );
  });

  it("a slot with no team to name adds no line; the others keep theirs", async () => {
    setWorld(
      sutton([
        { id: "o1", replacingUserId: "u3", createdAt: DROP_1 },
        { id: "o2", replacingUserId: null, createdAt: DROP_2 },
      ]),
    );
    const out = await firstCome(() => offerPosts(AT_8AM));
    expect(out[0].text).toContain(
      "🎟 2 slots just opened for *Tuesday 7-a-side* tonight. *First to claim them play.*\n• on *Red*, replacing Player 4\n\n@",
    );
  });

  it("in Turkish", async () => {
    features.language = "tr";
    try {
      setWorld(
        sutton([
          { id: "o1", replacingUserId: "u3", createdAt: DROP_1 },
          { id: "o2", replacingUserId: "u9", createdAt: DROP_2 },
        ]),
      );
      const out = await firstCome(() => offerPosts(AT_8AM));
      expect(out[0].text).toBe(
        "🎟 2 yer açıldı: bu akşamki *Tuesday 7-a-side* için. *İlk sahiplenenler oynar.*\n" +
          "• *Kırmızı* takımında, Player 4 yerine\n" +
          "• *Sarı* takımında, Player 10 yerine\n\n" +
          `${TAGS}\n\n` +
          "Birini almak için buraya *VARIM* yazmanız yeterli. Acele yok, süre sınırı yok; yerler önce yazanların olur, " +
          "yer kalmazsa diğerleri yedekte kalır. 🙏",
      );
      expect(out[1].text).toBe(
        "👋 Ozgur, 2 yer açıldı: bu akşamki Tuesday 7-a-side için. Yedekte olduğun için sana da yazıyorum.\n" +
          "• Kırmızı takımında, Player 4 yerine\n" +
          "• Sarı takımında, Player 10 yerine\n\n" +
          "Birini ister misin? Almak için buraya *EVET* yaz ya da gruptaki etiketlediğim mesaja *VARIM* diye cevap ver. " +
          "İlk sahiplenen oynar. Süre sınırı yok, müsait değilsen de sorun değil, yedekte kalırsın. 🙏",
      );
      for (const i of out) expect(i.text).not.toMatch(/[–—]/);
    } finally {
      features.language = "en";
    }
  });
});
