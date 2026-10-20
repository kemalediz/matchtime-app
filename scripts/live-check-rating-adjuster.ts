/**
 * THE RATING ADJUSTER: THE PAID CHECK (2026-10-20).
 *
 * The adjuster had no live check at all (teams-live runs it and asserts
 * nothing about it). This drives the shipped `adjustRatings` against the
 * real model on fixture weeks of chat, with no database and no writes:
 * the adjustments are printed and judged, never stored.
 *
 * Each week has the players of one match and what each one's delta
 * should be, by sign: down for a player who says they are ill, injured
 * or rusty for THIS match, up for a hot streak, zero for no signal, for
 * a long-term opinion, and for a problem that has cleared up. One week is
 * Turkish, one says nothing at all, and one is a Saturday-morning match
 * where "tonight" in the chat is the night before.
 *
 *   ARM=sonnet|haiku TAG=new OUT=/path/result.json \
 *     DATABASE_URL=postgresql://none@127.0.0.1:1/none \
 *     node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-rating-adjuster.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Each week once.
 */
import fs from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { ARMS, armModel, latency } from "../e2e/helpers/arm-model.ts";
import { adjustRatings, type AdjusterInput } from "../src/lib/rating-adjuster.ts";

spendDevApiKeyOrExit("the rating adjuster live check");
const ARM = process.env.ARM ?? "sonnet";
const TAG = process.env.TAG ?? "new";
const arm = ARMS[ARM];
if (!arm) throw new Error(`ARM must be one of ${Object.keys(ARMS).join(", ")}`);
const { model, calls, usd } = armModel(arm, 1);

type Sign = "-" | "0" | "+";
interface Week {
  name: string;
  input: AdjusterInput;
  /** Allowed signs per player name. */
  want: Record<string, Sign[]>;
}

const H = 60 * 60 * 1000;
function week(args: {
  name: string;
  sport?: string;
  kickoff: string;
  players: Array<[string, number, Sign[]]>;
  /** [hours before kickoff, author, text] */
  chat: Array<[number, string, string]>;
}): Week {
  const kickoff = new Date(args.kickoff);
  return {
    name: args.name,
    input: {
      sportName: args.sport ?? "Football",
      matchDate: kickoff,
      players: args.players.map(([name, baseRating]) => ({ id: `p-${name.split(" ")[0].toLowerCase()}`, name, baseRating })),
      messages: args.chat.map(([h, authorName, body]) => ({ authorName, body, timestamp: new Date(kickoff.getTime() - h * H) })),
    },
    want: Object.fromEntries(args.players.map(([name, , signs]) => [name, signs])),
  };
}

const Z: Sign[] = ["0"];
const DOWN: Sign[] = ["-"];
const UP: Sign[] = ["+"];

const WEEKS: Week[] = [
  week({
    name: "EN Tuesday evening",
    kickoff: "2026-10-13T20:00:00.000Z", // Tue 21:00 London
    players: [
      ["Ali Kaya", 7.2, DOWN],
      ["Dan Moore", 6.8, Z],
      ["Sam Price", 6.5, DOWN],
      ["Joe Hart", 7.0, ["0", "+"]],
      ["Tom Reed", 5.9, Z],
      ["Ben Cole", 6.1, Z],
      ["Luke Shaw", 6.6, DOWN],
      ["Matt Fox", 7.4, UP],
      ["Ryan Gray", 6.0, Z],
      ["Nick Webb", 6.3, Z],
    ],
    chat: [
      [166, "Matt Fox", "what a game last night lads"],
      [165, "Dan Moore", "Matt you were on fire, hat-trick 🔥"],
      [164, "Joe Hart", "Matt was unplayable honestly"],
      [140, "Tom Reed", "IN for next week"],
      [80, "Luke Shaw", "pulled my hamstring at parkrun, gutted"],
      [56, "Luke Shaw", "hamstring still sore but I'll play Tuesday, might be slow"],
      [30, "Sam Price", "first game back in 2 months for me, expect rust 😂"],
      [28, "Ben Cole", "Ali is way better than Ryan anyway, always has been"],
      [12, "Ali Kaya", "got a heavy cold, still coming but don't expect much from me"],
      [10, "Nick Webb", "In"],
      [9, "Ryan Gray", "in, I'll bring the bibs"],
      [3, "Joe Hart", "feeling sharp, ready for tonight"],
    ],
  }),
  week({
    name: "TR Friday evening",
    kickoff: "2026-10-16T20:00:00.000Z", // Fri 21:00 London
    players: [
      ["Erdal Özkan", 7.0, Z],
      ["Mehmet Yılmaz", 6.6, Z],
      ["Ali Çelik", 6.2, Z],
      ["Can Şahin", 6.9, Z],
      ["Emre Doğan", 7.1, DOWN],
      ["Burak Aydın", 7.3, UP],
      ["Oğuz Kaya", 6.4, DOWN],
      ["İlker Demir", 6.8, Z],
      ["Serkan Arslan", 6.5, DOWN],
      ["Hakan Koç", 6.0, Z],
    ],
    chat: [
      [166, "Mehmet Yılmaz", "dün akşam Burak 3 gol attı, inanılmazdı"],
      [165, "Can Şahin", "Burak bomba gibiydi valla"],
      [110, "Emre Doğan", "dizim ağrıyor ama cuma oynarım, biraz yavaş olabilirim"],
      [60, "Oğuz Kaya", "3 aydır top oynamadım, paslandım herhalde 😅"],
      [30, "Serkan Arslan", "grip oldum, ateşim var ama gelirim"],
      [28, "Hakan Koç", "İlker Ali'den çok daha iyi oyuncu, herkes biliyor"],
      [8, "Erdal Özkan", "geliyorum"],
      [7, "İlker Demir", "ben de varım"],
    ],
  }),
  week({
    name: "EN no signal",
    kickoff: "2026-10-14T19:00:00.000Z", // Wed 20:00 London
    players: [
      ["Ali Kaya", 7.2, Z],
      ["Dan Moore", 6.8, Z],
      ["Sam Price", 6.5, Z],
      ["Joe Hart", 7.0, Z],
      ["Tom Reed", 5.9, Z],
      ["Ben Cole", 6.1, Z],
      ["Luke Shaw", 6.6, Z],
      ["Matt Fox", 7.4, Z],
    ],
    chat: [
      [150, "Dan Moore", "who's in for Wednesday?"],
      [149, "Ali Kaya", "in"],
      [148, "Sam Price", "in"],
      [100, "Joe Hart", "can someone bring a pump, the ball was flat"],
      [90, "Tom Reed", "I'll bring it"],
      [50, "Ben Cole", "can't make it the week after, away for half term"],
      [20, "Luke Shaw", "pitch 3 again?"],
      [19, "Matt Fox", "yes pitch 3"],
      [4, "Dan Moore", "see you all at 8"],
    ],
  }),
  week({
    name: "EN Saturday morning, 'tonight' is the night before",
    kickoff: "2026-10-17T09:00:00.000Z", // Sat 10:00 London
    players: [
      ["Pete Hall", 6.9, DOWN],
      ["Mark Long", 6.4, DOWN],
      ["Kev Bright", 6.7, ["0", "+"]],
      ["Rob Lane", 6.2, Z],
      ["Gary Wood", 7.1, ["0", "+"]],
      ["Lee Stone", 6.0, Z],
      ["Jay Park", 6.5, Z],
      ["Tim Bell", 5.8, Z],
      ["Phil Ward", 6.3, Z],
    ],
    chat: [
      [155, "Kev Bright", "really ill, in bed all weekend"],
      [140, "Gary Wood", "scored 2 in the Sunday league this morning"],
      [100, "Rob Lane", "twisted my ankle at work"],
      [80, "Mark Long", "not played since July, will be rusty Saturday"],
      [70, "Rob Lane", "ankle is fine now, no swelling"],
      [40, "Kev Bright", "fully recovered now, feeling great"],
      [30, "Lee Stone", "Zack's broken his wrist, he's out for a month"],
      [11, "Pete Hall", "on a stag do tonight, I'll be rough in the morning but I'm coming"],
      [10, "Jay Park", "haha good luck Pete"],
      [2, "Tim Bell", "on my way"],
    ],
  }),
  week({
    name: "EN traps: someone else's illness, idioms, banter, old injuries",
    kickoff: "2026-10-15T19:30:00.000Z", // Thu 20:30 London
    players: [
      ["Dan Moore", 6.8, ["-", "0"]],
      ["Chris Ball", 6.4, ["-", "0"]],
      ["Owen Fry", 6.1, ["-", "0"]],
      ["Kyle Dunn", 7.2, ["+", "0"]],
      ["Adam Neal", 5.9, Z],
      ["Leo Hunt", 6.6, Z],
      ["Max Ford", 6.3, Z],
      ["Ian Pope", 6.0, Z],
      ["Theo Grant", 7.0, ["+", "0"]],
    ],
    chat: [
      [160, "Sam Price", "sick goal from Theo last week 🔥"],
      [150, "Kyle Dunn", "MOTM three weeks running, just saying 😎"],
      [120, "Ian Pope", "I'm sick of losing every week, put me with Kyle"],
      [100, "Adam Neal", "lol"],
      [99, "Kyle Dunn", "Adam you're rubbish mate 😂"],
      [80, "Max Ford", "broke my toe last month but it's all healed, can't wait"],
      [50, "Sam Price", "Dan's done his back lifting at work, he said he'll still play Thursday"],
      [40, "Chris Ball", "back from 6 weeks in Australia, who's in?"],
      [20, "Leo Hunt", "my wife's ill so I might be 10 mins late"],
      [6, "Owen Fry", "long shift today, might be a bit tired but I'm in"],
    ],
  }),
];

const sign =(d: number): Sign => (d > 0 ? "+" : d < 0 ? "-" : "0");
const DASH = /[\u2013\u2014]/;

async function main() {
  const weeks: Array<Record<string, unknown>> = [];
  let correct = 0;
  let total = 0;
  let signalsFound = 0;
  let signals = 0;
  let falsePositives = 0;
  for (const w of WEEKS) {
    const before = calls.length;
    const out = await adjustRatings(w.input, { model });
    const call = calls[before];
    const rows = w.input.players.map((p) => {
      const a = out.get(p.id);
      const delta = a?.delta ?? 0;
      const allowed = w.want[p.name];
      const ok = allowed.includes(sign(delta)) && !(a && DASH.test(a.reason));
      total++;
      if (ok) correct++;
      if (!allowed.includes("0")) {
        signals++;
        if (ok) signalsFound++;
      }
      if (allowed.length === 1 && allowed[0] === "0" && delta !== 0) falsePositives++;
      return { name: p.name, delta, want: allowed.join("|"), ok, reason: a?.reason ?? null, confidence: a?.confidence ?? null };
    });
    const extraIds = [...out.keys()].filter((id) => !w.input.players.some((p) => p.id === id));
    weeks.push({ week: w.name, ms: call?.ms, out: call?.outputTokens, in: call?.inputTokens, usd: call?.usd, empty: call?.empty, error: call?.error, extraIds, rows, raw: call?.raw });
    console.log(`\n== ${w.name}  ${call?.ms}ms in=${call?.inputTokens} out=${call?.outputTokens}${call?.empty ? `  EMPTY (${call.stopReason ?? call.error})` : ""}`);
    for (const r of rows) console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name.padEnd(14)} ${String(r.delta).padStart(4)} want ${r.want.padEnd(4)} ${r.reason ?? ""}`);
  }
  const lat = latency(calls);
  const summary = {
    name: "rating-adjuster",
    arm: ARM,
    model: arm.model,
    prompt: TAG,
    result: `${correct}/${total} players`,
    signals: `${signalsFound}/${signals}`,
    falsePositives,
    calls: calls.length,
    cost: Number(usd().toFixed(6)),
    costPerCall: Number((usd() / Math.max(1, calls.length)).toFixed(6)),
    p50ms: lat.p50,
    p90ms: lat.p90,
    empty: calls.filter((c) => c.empty).length,
    weeks,
  };
  console.log(
    `\n${summary.result}, signals ${summary.signals}, false positives ${falsePositives}, on ${arm.model} (${TAG} prompt), ` +
      `${calls.length} calls, $${summary.cost}, p50 ${lat.p50}ms p90 ${lat.p90}ms, empty ${summary.empty}`,
  );
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
