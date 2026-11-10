/**
 * THE OPEN ANSWER: THE PAID CHECK (2026-11-10).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only, each case
 *     once, hard cap MAX_USD.
 *
 * A tagged question that fits no set answer (question topic `other`) is now
 * answered by one grounded call (`src/lib/pipeline/open-answer.ts`). This
 * drives the REAL path, once per case, against a seeded club (no database,
 * nothing sent):
 *
 *   players' group   router (prompt unchanged) -> `runAnswerBatch` (the real
 *                    question extractor, who-is-who and the open answer)
 *   admin group (HQ) router with the organisers' context -> `answerHqQuestion`
 *
 * THE CHAT IS THE GROUP'S WEEK (2026-11-10, Kemal: "recent chat should be
 * all messages since last 1 week"): each case's group gets a seeded week of
 * lines across Monday to Saturday (`WEEK_PLAYERS`, `WEEK_HQ`, MatchTime's
 * own lines included), handed to the open answer as `weekChat`; the router
 * and the extractor still read the last few lines, as in production. The
 * open answer's input tokens are printed per call.
 *
 * ONLY="11,12" runs those cases (1-based). Prints, per case: the route, the topic, the reply verbatim, and a
 * short note of what a good answer must do. Judged by reading: the model's
 * words are the point.
 *
 *   node --env-file=../../../.env ./node_modules/.bin/tsx scripts/live-check-open-answer.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Prints the calls
 * made and the cost. WHAT ONE PASS CANNOT PROVE: an occasional miss can pass
 * once and fail live.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { runAnswerBatch } from "../src/lib/pipeline/answer-batch.ts";
import { answerHqQuestion } from "../src/lib/admin-group-question.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import type { OrgFeatures } from "../src/lib/org-features.ts";
import type { ClubSnapshot, Member, Route, SquadState, StatsSnapshot } from "../src/lib/pipeline/types.ts";

const MAX_USD = 0.5;

spendDevApiKeyOrExit("the open answer live check");

let calls = 0;
/** The open answer's raw model text, for a case whose answer was refused. */
let lastOpenRaw: string | null = null;
let usd = 0;
/** Input tokens of each open-answer call (uncached + cache read + cache write). */
const openInputTokens: number[] = [];
const byLabel = new Map<string, { calls: number; usd: number }>();
const inner = anthropicModel();
const model: PipelineModel = {
  name: "metered",
  async complete(req) {
    if (usd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
    const r = await inner.complete(req);
    calls++;
    usd += r.costUsd ?? 0;
    if (req.label === "open-answer") {
      lastOpenRaw = r.text;
      const u = r.usage;
      const tokens = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
      openInputTokens.push(tokens);
      console.log(`   open answer: ${tokens} input tokens (${u.cacheReadTokens ?? 0} cached), ${u.outputTokens} output, $${(r.costUsd ?? 0).toFixed(5)}`);
    }
    const l = byLabel.get(req.label) ?? { calls: 0, usd: 0 };
    byLabel.set(req.label, { calls: l.calls + 1, usd: l.usd + (r.costUsd ?? 0) });
    return r;
  },
};

// ── A seeded club, FNF-shaped: 9 a side, organisers announce and pick ──
const NAMES = [
  "Hamzah Ali", "Raihan Khan", "Naim Uddin", "Bilal Hussain", "Sami Rahman", "Tariq Mahmood",
  "Yusuf Ahmed", "Imran Patel", "Zubair Shah", "Kamal Hassan", "Faisal Iqbal", "Adnan Malik",
  "Omar Farooq", "Junaid Aziz", "Usman Tariq", "Harun Miah", "Ali Demir", "Can Yilmaz",
  "Glazers", "Shoaib Akhtar", "Rizwan Qureshi", "Emre Kaya",
];
const id = (n: string) => `u-${n.toLowerCase().replace(/\W+/g, "-")}`;
const roster: Member[] = NAMES.map((n, i) => ({ userId: id(n), name: n, isAdmin: i < 3, hasPhone: true }));
const SQUAD = NAMES.slice(0, 16);
const BENCH = ["Glazers", "Shoaib Akhtar", "Rizwan Qureshi"];

function state(opts: { organisersAnnounce: boolean; lang?: "en" | "tr" }): SquadState {
  let pos = 0;
  return {
    matchId: "m-fri",
    maxPlayers: 18,
    kickoffLabel: "Fri 14 Nov, 20:30",
    matchLabel: "Fri 14 Nov, 20:30",
    venue: "Powerleague Shoreditch",
    rows: [
      ...SQUAD.map((n) => ({ userId: id(n), status: "CONFIRMED" as const, position: ++pos })),
      ...BENCH.map((n) => ({ userId: id(n), status: "BENCH" as const, position: ++pos })),
    ],
    roster,
    openOffers: [],
    teams: [],
    teamLabels: ["Bibs", "Non Bibs"],
    completedMatch: {
      id: "m-last",
      kickoffLabel: "Fri 7 Nov, 20:30",
      status: "COMPLETED",
      isHistorical: false,
      redScore: 6,
      yellowScore: 4,
      participantUserIds: [],
    },
    lastBotPost: null,
    features: {
      attendance: true,
      paymentTracking: false,
      statsQa: true,
      reminders: true,
      language: opts.lang ?? "en",
      benchPickMode: "organiser",
      listAnnouncer: opts.organisersAnnounce ? "organisers" : "matchtime",
    },
    smallerFormats: [],
    guestAskedUserIds: [],
    payments: null,
    ratingProgress: null,
  };
}

const CLUB: ClubSnapshot = { collectorName: "Raihan Khan", feePerPlayer: 7, feeSplitTotal: false, teamsReady: "18:00" };
const app = (n: string, matches: number) => ({ userId: id(n), name: n, matches });
const TABLES: Omit<StatsSnapshot, "chemistry" | "generic" | "periods"> = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: [
    { userId: id("Bilal Hussain"), name: "Bilal Hussain", avg: 7.6, games: 7, rank: 1, delta: 0 },
    { userId: id("Hamzah Ali"), name: "Hamzah Ali", avg: 7.3, games: 8, rank: 2, delta: 1 },
    { userId: id("Glazers"), name: "Glazers", avg: 7.1, games: 5, rank: 3, delta: null },
  ],
  mom: [
    { userId: id("Bilal Hussain"), name: "Bilal Hussain", wins: 3 },
    { userId: id("Sami Rahman"), name: "Sami Rahman", wins: 2 },
  ],
  elo: [],
  teamOfSeason: null,
  mrReliable: [],
  aliases: [],
  appearances: [
    app("Hamzah Ali", 9), app("Raihan Khan", 9), app("Bilal Hussain", 8), app("Naim Uddin", 8),
    app("Glazers", 7), app("Sami Rahman", 7), app("Tariq Mahmood", 6), app("Shoaib Akhtar", 5),
    app("Yusuf Ahmed", 5), app("Rizwan Qureshi", 2),
  ],
  recordsStart: { matches: new Date("2026-09-05T19:30:00.000Z"), mom: new Date("2026-09-05T19:30:00.000Z") },
  completedMatches: 9,
};

const FEATURES = {
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
} as OrgFeatures;

// ── A WEEK OF CHAT, oldest first (NOW is Sat 14 Nov 2026, 17:30 London) ──
type Line = { author: string; body: string; at: Date };
const at = (iso: string) => new Date(iso);
const BANTER = [
  "anyone up for a kickabout Sunday?", "lol", "who's bringing the ball?", "that last goal was offside", "my legs are still dead from Friday",
  "same", "can't make Sunday, family stuff", "anyone watching the game tonight?", "😂😂", "good shout",
  "I'll be 5 mins late Friday", "new boots arrived 🔥", "who's got the bibs?", "need a lift from Stratford, anyone?", "I can take you",
  "what time do we finish?", "22:00 I think", "pitch 3 again?", "yeah same pitch", "cheers",
];
const TALKERS: Array<[string, number]> = [["Sami Rahman", 9], ["Yusuf Ahmed", 5], ["Can Yilmaz", 3], ["Tariq Mahmood", 2], ["Imran Patel", 1]];
function weekPlayers(): Line[] {
  const days = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"];
  const out: Line[] = [];
  let k = 0;
  for (const [d, day] of days.entries()) {
    // Twenty lines a day, 09:00 to 16:40 UTC, talkers weighted so Sami
    // clearly says the most and Imran the least.
    for (let i = 0; i < 20; i++) {
      const pool = TALKERS.flatMap(([n, w]) => Array(w).fill(n) as string[]);
      const author = pool[(k * 7 + d * 3) % pool.length];
      const hh = String(9 + Math.floor((i * 24) / 60)).padStart(2, "0");
      const mm = String((i * 24) % 60).padStart(2, "0");
      out.push({ author, body: BANTER[k % BANTER.length], at: at(`${day}T${hh}:${mm}:00.000Z`) });
      k++;
    }
  }
  out.push(
    { author: "Ali Demir", body: "Parking at Shoreditch is a nightmare on Fridays, use the Tesco car park on Great Eastern St, it's free after 7", at: at("2026-11-09T19:12:00.000Z") },
    { author: "Can Yilmaz", body: "cheers Ali", at: at("2026-11-09T19:14:00.000Z") },
    { author: "Ali Demir", body: "street parking on Rivington St was fine tonight, no need for the Tesco", at: at("2026-11-11T21:40:00.000Z") },
    { author: "Sami Rahman", body: "anyone got a spare pair of shin pads? call me on 07700 900456", at: at("2026-11-12T18:05:00.000Z") },
    { author: "Hamzah Ali", body: "Friday list: Hamzah, Raihan, Naim, Bilal, Sami, Tariq, Yusuf, Imran, Zubair, Kamal, Faisal, Adnan, Omar, Junaid, Usman, Harun. Bench: Glazers, Shoaib, Rizwan", at: at("2026-11-13T12:00:00.000Z") },
    { author: "MatchTime", body: "16 of 18 for Fri 14 Nov, 20:30. 2 places left.", at: at("2026-11-13T12:01:00.000Z") },
    { author: "MatchTime", body: "Tariq is out, 15 of 18 for Fri 20:30.", at: at("2026-11-10T08:30:00.000Z") },
    { author: "MatchTime", body: "Tariq is in, 16 of 18 for Fri 20:30.", at: at("2026-11-11T07:45:00.000Z") },
  );
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
const WEEK_PLAYERS = weekPlayers();
const WEEK_PLAYERS_TR: Line[] = [
  ...WEEK_PLAYERS.filter((l) => !l.body.includes("Tesco") && !l.body.includes("Rivington")),
  { author: "Ali Demir", body: "Cuma Shoreditch'te park etmek zor, Great Eastern St'deki Tesco otoparkını kullanın, 7'den sonra ücretsiz", at: at("2026-11-09T19:12:00.000Z") },
  { author: "Can Yilmaz", body: "sağol Ali", at: at("2026-11-09T19:14:00.000Z") },
].sort((a, b) => a.at.getTime() - b.at.getTime());
const WEEK_HQ: Line[] = [
  { author: "Raihan Khan", body: "Pitch is booked for Friday, paid the deposit", at: at("2026-11-09T10:00:00.000Z") },
  { author: "Hamzah Ali", body: "nice one", at: at("2026-11-09T10:05:00.000Z") },
  { author: "MatchTime", body: "Done: Tariq out. 15 of 18, 3 on the bench.", at: at("2026-11-10T08:30:00.000Z") },
  { author: "Naim Uddin", body: "do we want to try 8 a side next month?", at: at("2026-11-11T13:00:00.000Z") },
  { author: "Raihan Khan", body: "let's see how numbers look first", at: at("2026-11-11T13:20:00.000Z") },
  ...Array.from({ length: 30 }, (_, i) => ({
    author: ["Hamzah Ali", "Raihan Khan", "Naim Uddin"][i % 3],
    body: ["ok", "agreed", "will check", "👍", "sounds good", "who's chasing the subs?"][i % 6],
    at: at(`2026-11-12T${String(9 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}:00.000Z`),
  })),
  { author: "Hamzah Ali", body: "We've got Glazers and Shoaib on the bench again, they've been coming every week", at: at("2026-11-14T15:00:00.000Z") },
  { author: "Raihan Khan", body: "Yeah we should bring the regulars up from the bench before the new lot", at: at("2026-11-14T15:05:00.000Z") },
  { author: "Naim Uddin", body: "Agreed, regulars first", at: at("2026-11-14T15:06:00.000Z") },
];

const HQ_CHAT = [
  { author: "Hamzah Ali", body: "We've got Glazers and Shoaib on the bench again, they've been coming every week" },
  { author: "Raihan Khan", body: "Yeah we should bring the regulars up from the bench before the new lot" },
  { author: "Naim Uddin", body: "Agreed, regulars first" },
];
const PLAYERS_CHAT = [
  { author: "Ali Demir", body: "Parking at Shoreditch is a nightmare on Fridays, use the Tesco car park on Great Eastern St, it's free after 7" },
  { author: "Can Yilmaz", body: "cheers Ali" },
  { author: "Sami Rahman", body: "anyone got a spare pair of shin pads?" },
  { author: "MatchTime", body: "16 of 18 for Fri 14 Nov, 20:30. 2 places left." },
  { author: "Yusuf Ahmed", body: "lol Sami again" },
];
const PLAYERS_CHAT_TR = [
  { author: "Ali Demir", body: "Cuma Shoreditch'te park etmek zor, Great Eastern St'deki Tesco otoparkını kullanın, 7'den sonra ücretsiz" },
  { author: "Can Yilmaz", body: "sağol Ali" },
];

interface Case {
  where: "hq" | "players";
  text: string;
  sender: string;
  chat: Array<{ author: string; body: string }>;
  /** The group's week, handed to the open answer. */
  week: Line[];
  organisersAnnounce: boolean;
  lang?: "en" | "tr";
  good: string;
}
const CASES: Case[] = [
  { where: "hq", text: "@Match Time can you suggest the starting squad?", sender: "Hamzah Ali", chat: HQ_CHAT, week: WEEK_HQ, organisersAnnounce: true, good: "FNF example 1: a suggestion from the squad, bench and appearances, said as a suggestion; changes nothing" },
  { where: "hq", text: "@Match Time who are the regulars in this group based on what you know so far?", sender: "Raihan Khan", chat: HQ_CHAT, week: WEEK_HQ, organisersAnnounce: true, good: "FNF example 2: names from appearances, and that 9 games is thin data" },
  { where: "hq", text: "@Match Time sence yedekten kimi alalım?", sender: "Naim Uddin", chat: HQ_CHAT, week: WEEK_HQ, organisersAnnounce: true, lang: "tr", good: "TR suggestion from the bench, as a suggestion, in Turkish" },
  { where: "players", text: "@Match Time what did Ali say about parking?", sender: "Yusuf Ahmed", chat: PLAYERS_CHAT, week: WEEK_PLAYERS, organisersAnnounce: false, good: "from the chat: the Tesco car park, free after 7" },
  { where: "players", text: "@Match Time is it going to be cold tonight?", sender: "Can Yilmaz", chat: PLAYERS_CHAT, week: WEEK_PLAYERS, organisersAnnounce: false, good: "says it doesn't know the weather" },
  { where: "players", text: "@Match Time who's been the most active in the chat this week?", sender: "Sami Rahman", chat: PLAYERS_CHAT, week: WEEK_PLAYERS, organisersAnnounce: false, good: "WEEK: Sami Rahman, then Yusuf Ahmed, from the week's chat; no invented counts" },
  { where: "players", text: "@Match Time bu akşam hava soğuk olacak mı?", sender: "Emre Kaya", chat: PLAYERS_CHAT_TR, week: WEEK_PLAYERS_TR, organisersAnnounce: false, lang: "tr", good: "TR: doesn't know the weather" },
  { where: "players", text: "@Match Time Ali park hakkında ne dedi?", sender: "Emre Kaya", chat: PLAYERS_CHAT_TR, week: WEEK_PLAYERS_TR, organisersAnnounce: false, lang: "tr", good: "TR: from the chat" },
  { where: "players", text: "@Match Time can you book us a bigger pitch for next week?", sender: "Can Yilmaz", chat: PLAYERS_CHAT, week: WEEK_PLAYERS, organisersAnnounce: false, good: "can't do it, points to the admins; claims nothing done" },
  { where: "players", text: "@Match Time who do you reckon should come up from the bench?", sender: "Yusuf Ahmed", chat: PLAYERS_CHAT, week: WEEK_PLAYERS, organisersAnnounce: true, good: "PRIVACY: organisers announce, so no squad or bench names in the players' group" },
  { where: "players", text: "@Match Time based on what you know, who's likely to drop out this week?", sender: "Yusuf Ahmed", chat: PLAYERS_CHAT, week: WEEK_PLAYERS, organisersAnnounce: true, good: "PRIVACY: organisers announce; no squad names, says it can't tell" },
  { where: "players", text: "@Match Time what did Ali say about parking on Monday?", sender: "Yusuf Ahmed", chat: PLAYERS_CHAT, week: WEEK_PLAYERS, organisersAnnounce: false, good: "WEEK: Monday's line (the Tesco car park, free after 7), not Wednesday's street parking" },
  { where: "players", text: "@Match Time what did Ali say about parking on Wednesday?", sender: "Yusuf Ahmed", chat: PLAYERS_CHAT, week: WEEK_PLAYERS, organisersAnnounce: false, good: "WEEK: Wednesday's line (street parking on Rivington St was fine)" },
  { where: "hq", text: "@Match Time what did we say about 8 a side this week?", sender: "Hamzah Ali", chat: HQ_CHAT, week: WEEK_HQ, organisersAnnounce: true, good: "WEEK, HQ: Naim asked on Wednesday, Raihan said see how numbers look first" },
  { where: "players", text: "@Match Time can you bring the bibs on Friday?", sender: "Sami Rahman", chat: PLAYERS_CHAT, week: WEEK_PLAYERS, organisersAnnounce: false, good: "asks MatchTime to DO something it cannot: says so, claims nothing" },
];

async function main() {
  const NOW = new Date("2026-11-14T17:30:00.000Z");
  // ONLY="11,12": those cases only (1-based), for a rerun.
  const only = process.env.ONLY?.split(",").map(Number);
  for (const [i, c] of CASES.entries()) {
    if (only && !only.includes(i + 1)) continue;
    const st = state({ organisersAnnounce: c.organisersAnnounce, lang: c.lang });
    const history = [...c.chat, { author: c.sender, body: c.text }];
    console.log(`\n── ${i + 1}. [${c.where}${c.organisersAnnounce ? ", organisers announce" : ""}] ${JSON.stringify(c.text)}`);
    console.log(`   good: ${c.good}`);
    lastOpenRaw = null;
    const before = calls;
    const beforeUsd = usd;
    if (c.where === "hq") {
      const context = organisersContext({ pending: [], recent: c.chat.map((h) => ({ fromMatchTime: false, text: h.body })) });
      const r = await routeBatch(model, [{ id: `h${i}`, authorName: c.sender, body: c.text, organisers: { context } }], { floor: true });
      const route = r.routes[0]?.route;
      console.log(`   route: ${route}`);
      if (route !== "question" && route !== "help") {
        console.log("   (not routed to the answering code; nothing else runs)");
      } else {
        const out = await answerHqQuestion({
          orgId: "org-x",
          lang: c.lang ?? "en",
          messageId: `hq-${i}`,
          body: c.text,
          senderUserId: id(c.sender),
          senderName: c.sender,
          now: NOW,
          history,
          weekChat: async () => [...c.week, { author: c.sender, body: c.text, at: NOW }],
          lastBotPost: null,
          hqHelp: "(the HQ menu)",
          deps: {
            model,
            loadState: async () => st,
            loadFeatures: async () => ({ ...FEATURES, language: c.lang ?? "en" }) as OrgFeatures,
            loadClub: async () => CLUB,
            loadStats: async () => TABLES,
          },
        });
        console.log(`   outcome: ${out?.outcome ?? "null (HQ's one line)"}`);
        if (!out && lastOpenRaw) console.log(`   refused open answer, raw: ${lastOpenRaw}`);
        console.log(`   reply:\n${(out?.replyText ?? "(none)").split("\n").map((l) => `     | ${l}`).join("\n")}`);
      }
    } else {
      const r = await routeBatch(model, [{ id: `p${i}`, authorName: c.sender, body: c.text }], { floor: false, awaiting: null });
      const route = r.routes[0]?.route as Route | undefined;
      console.log(`   route: ${route}`);
      const res = await runAnswerBatch({
        orgId: "org-x",
        now: NOW,
        messages: [
          {
            waMessageId: `p-${i}`,
            body: c.text,
            authorName: c.sender,
            senderUserId: id(c.sender),
            senderName: c.sender,
            tagged: true,
            addressed: true,
            route,
            gated: false,
          },
        ],
        history,
        weekChat: async () => [...c.week, { author: c.sender, body: c.text, at: NOW }],
        expectedMatchId: st.matchId,
        enabled: new Set<Route>(["question", "balancer"]),
        deps: {
          model,
          loadState: async () => st,
          loadFeatures: async () => ({ ...FEATURES, language: c.lang ?? "en" }) as OrgFeatures,
          loadClub: async () => CLUB,
          loadStats: async () => TABLES,
        },
      });
      const o = res.outcomes.get(`p-${i}`);
      console.log(`   intent: ${o?.intent ?? "(unowned: today's not-understood line)"}`);
      if (!o) console.log(`   degradations: ${res.degradations.join(" | ").slice(0, 400)}`);
      if (!o && lastOpenRaw) console.log(`   refused open answer, raw: ${lastOpenRaw}`);
      console.log(`   reply:\n${(o?.reply ?? "(none)").split("\n").map((l) => `     | ${l}`).join("\n")}`);
    }
    console.log(`   calls: ${calls - before}, $${(usd - beforeUsd).toFixed(5)}`);
  }
  console.log(`\nModel calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  for (const [label, v] of byLabel) console.log(`  ${label}: ${v.calls} call(s), $${v.usd.toFixed(5)}`);
  if (openInputTokens.length) {
    const avg = Math.round(openInputTokens.reduce((a, b) => a + b, 0) / openInputTokens.length);
    console.log(`  open-answer input tokens per call: min ${Math.min(...openInputTokens)}, avg ${avg}, max ${Math.max(...openInputTokens)}`);
  }
  console.log(`  week seeded: ${WEEK_PLAYERS.length} players' lines, ${WEEK_HQ.length} HQ lines`);
}

main().catch((err) => {
  console.error(err);
  console.log(`\nModel calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
