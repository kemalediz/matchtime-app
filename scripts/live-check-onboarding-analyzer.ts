/**
 * THE ONBOARDING READING: THE PAID CHECK (2026-10-21).
 *
 * The only live check this reading had (`e2e/sim/onboarding-enrichment-
 * live.spec.ts`) asserts the SHAPE of the answer and nothing it says.
 * This drives the shipped `analyzeForOnboarding` against the real model
 * on fixture chats, with no database: the answer is printed and judged.
 *
 * Each chat is one call, and has expected values for:
 *   - the schedule (day, kickoff, venue), or null where the chat has no
 *     regular game;
 *   - the payment holder, or null;
 *   - each player's position (a position, or null for no signal) and the
 *     direction of their rating: "up" (7 or more), "down" (5 or less) or
 *     "none". "none" accepts null, or a 6 (the old prompt's neutral
 *     default), so the old and new prompts are judged on the same facts.
 *
 *   ARM=sonnet|haiku TAG=old|new OUT=/path/result.json \
 *     DATABASE_URL=postgresql://none@127.0.0.1:1/none \
 *     node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-onboarding-analyzer.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Each chat once.
 */
import fs from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { ARMS, armModel, latency } from "../e2e/helpers/arm-model.ts";
import { analyzeForOnboarding } from "../src/lib/onboarding-analyzer.ts";
import { buildParsedChatFromHistory } from "../src/lib/onboarding-enrichment-reconcile.ts";

spendDevApiKeyOrExit("the onboarding reading live check");
const ARM = process.env.ARM ?? "haiku";
const TAG = process.env.TAG ?? "new";
const arm = ARMS[ARM];
if (!arm) throw new Error(`ARM must be one of ${Object.keys(ARMS).join(", ")}`);
const { model, calls, usd } = armModel(arm, Number(process.env.MAX_USD ?? 0.6));

type Dir = "up" | "down" | "none";
interface Chat {
  name: string;
  sport?: string;
  positions?: string[];
  /** [name, position (null: no signal; a list: any of these), rating direction] */
  players: Array<[string, string | null | Array<string | null>, Dir]>;
  schedule: { day: number | null; time: string | null; venue: string | null };
  payer: string | null;
  /** [ISO time, author, text] */
  chat: Array<[string, string, string]>;
}

const FOOTBALL = ["GK", "DEF", "MID", "FWD"];

const CHATS: Chat[] = [
  {
    name: "EN Thursday 7-a-side",
    players: [
      ["Najib", "GK", "up"],
      ["Talha", "FWD", "up"],
      ["Amir", "MID", "up"],
      ["Khalid", "DEF", "up"],
      ["Sami", ["MID", "FWD", null], "none"],
      ["Bilal", null, "none"],
      ["Omar", null, "none"],
      ["Elvin", null, "none"],
    ],
    schedule: { day: 4, time: "20:00", venue: "goals sutton" },
    payer: "Elvin",
    chat: [
      ["2026-06-01T20:10:00Z", "Najib", "Good game last week lads"],
      ["2026-06-02T09:30:00Z", "Talha", "Same time this week? Thursday 8pm Goals Sutton yeah"],
      ["2026-06-02T09:45:00Z", "Khalid", "Yeah Thursday works for me, count me in"],
      ["2026-06-02T10:00:00Z", "Elvin", "£7 each as usual lads, send to me, Monzo link in the description"],
      ["2026-06-03T08:00:00Z", "Sami", "sent you the £7 Elvin"],
      ["2026-06-05T22:05:00Z", "Omar", "Najib saved us again last night, unreal in goal"],
      ["2026-06-05T22:10:00Z", "Sami", "Talha hat-trick! 3 goals Thursday, absolute machine up front"],
      ["2026-06-08T18:20:00Z", "Bilal", "Amir bossing midfield as always, ran the game"],
      ["2026-06-09T08:15:00Z", "Talha", "Khalid solid at the back again, nothing got past him"],
      ["2026-06-09T09:00:00Z", "Omar", "paid Elvin 👍"],
      ["2026-06-11T19:00:00Z", "Omar", "Thursday 8pm again at Goals Sutton, usual spot"],
      ["2026-06-11T19:10:00Z", "Sami", "I'll play wherever, happy in midfield or up top"],
      ["2026-06-12T20:55:00Z", "Bilal", "in"],
      ["2026-06-12T21:00:00Z", "Najib", "See everyone Thursday, 8pm sharp"],
    ],
  },
  {
    name: "TR Friday halısaha",
    players: [
      ["Kerem", "GK", "up"],
      ["Burak", "FWD", "up"],
      ["Emre", "DEF", "up"],
      ["Ali", null, "down"],
      ["Mert", null, "none"],
      ["Can", null, "none"],
      ["Serkan", null, "none"],
    ],
    schedule: { day: 5, time: "21:00", venue: "halısaha arena" },
    payer: "Mert",
    chat: [
      ["2026-09-01T18:00:00Z", "Mert", "Arkadaşlar bu cuma da 21:00 Halısaha Arena, kişi başı 150 TL"],
      ["2026-09-01T18:05:00Z", "Mert", "Parayı IBAN'ıma atın: TR12 0006 4000 0011 2345 6789 01"],
      ["2026-09-02T09:00:00Z", "Can", "Mert gönderdim 👍"],
      ["2026-09-05T21:30:00Z", "Serkan", "Kerem yine kalede devleşti, penaltı bile kurtardı"],
      ["2026-09-05T21:35:00Z", "Can", "Burak 3 gol attı, forvette durdurulamazdı"],
      ["2026-09-05T21:40:00Z", "Mert", "Ali bugün de sürekli top kaybetti, biraz toparlanalım"],
      ["2026-09-06T10:00:00Z", "Serkan", "Emre defansta duvar gibiydi, kimse geçemedi"],
      ["2026-09-08T12:00:00Z", "Ali", "cuma varım"],
      ["2026-09-09T12:00:00Z", "Mert", "Cuma 21:00 Halısaha Arena, her zamanki saha. Ücreti bana atmayı unutmayın"],
      ["2026-09-10T08:00:00Z", "Serkan", "Mert parayı attım"],
      ["2026-09-12T20:00:00Z", "Kerem", "görüşürüz cuma"],
    ],
  },
  {
    name: "EN no pattern, no signal",
    players: [
      ["Pete", null, "none"],
      ["Dan", null, "none"],
      ["Felix", null, "none"],
      ["Greg", null, "none"],
      ["Raj", null, "none"],
    ],
    schedule: { day: null, time: null, venue: null },
    payer: null,
    chat: [
      ["2026-07-01T12:00:00Z", "Pete", "anyone fancy a kickabout at some point?"],
      ["2026-07-01T12:10:00Z", "Dan", "maybe, depends on work"],
      ["2026-07-04T17:00:00Z", "Felix", "did anyone watch the match last night"],
      ["2026-07-04T17:05:00Z", "Greg", "yeah what a game, Saka was unreal"],
      ["2026-07-09T08:00:00Z", "Raj", "I might be around Saturday or Sunday, not sure"],
      ["2026-07-15T19:00:00Z", "Pete", "we should sort something out properly"],
      ["2026-07-15T19:20:00Z", "Dan", "in"],
    ],
  },
  {
    name: "EN Tuesday 5-a-side, bigger squad",
    players: [
      ["Ali Kaya", "GK", "none"],
      ["Dan Moore", "FWD", "up"],
      ["Sam Price", null, "down"],
      ["Joe Hart", "DEF", "none"],
      ["Tom Reed", null, "none"],
      ["Ben Cole", null, "none"],
      ["Luke Shaw", null, "none"],
      ["Matt Fox", "MID", "up"],
      ["Ryan Gray", null, "none"],
      ["Nick Webb", null, "none"],
      ["Owen Fry", null, "none"],
      ["Leo Hunt", null, "none"],
    ],
    schedule: { day: 2, time: "19:00", venue: "powerleague" },
    payer: null,
    chat: [
      ["2026-08-04T10:00:00Z", "Tom Reed", "Tuesday 7pm Powerleague, 10 needed"],
      ["2026-08-04T10:05:00Z", "Ben Cole", "in"],
      ["2026-08-04T10:06:00Z", "Ryan Gray", "in"],
      ["2026-08-04T10:30:00Z", "Ali Kaya", "I'll go in goal again, don't mind"],
      ["2026-08-05T21:00:00Z", "Luke Shaw", "Dan Moore scored 4 tonight, ridiculous finishing"],
      ["2026-08-05T21:02:00Z", "Nick Webb", "Matt Fox ran the midfield, man of the match for me"],
      ["2026-08-05T21:05:00Z", "Owen Fry", "Sam missed three open goals 😂 sorry mate"],
      ["2026-08-06T09:00:00Z", "Joe Hart", "I'll play at the back again next week"],
      ["2026-08-11T10:00:00Z", "Tom Reed", "Tuesday 7pm Powerleague again lads"],
      ["2026-08-11T10:10:00Z", "Leo Hunt", "in"],
      ["2026-08-11T11:00:00Z", "Sam Price", "in, will try to score this time"],
      ["2026-08-12T21:10:00Z", "Ben Cole", "Dan Moore another hat-trick, best player in the group by miles"],
      ["2026-08-12T21:12:00Z", "Ryan Gray", "Matt Fox MOTM again"],
      ["2026-08-12T21:20:00Z", "Ali Kaya", "anyone see my water bottle"],
      ["2026-08-18T10:00:00Z", "Tom Reed", "Same again Tuesday 7pm Powerleague"],
    ],
  },
];

const dirOf = (r: number | null): Dir => (r == null || r === 6 ? "none" : r >= 7 ? "up" : r <= 5 ? "down" : "none");

async function main() {
  const out: Array<Record<string, unknown>> = [];
  let correct = 0;
  let total = 0;
  // ONLY=<index>: one case, for measuring a call before a full pass.
  const only = process.env.ONLY;
  for (const c of only ? [CHATS[Number(only)]] : CHATS) {
    const parsed = buildParsedChatFromHistory(c.chat.map(([t, author, text]) => ({ author, text, timestamp: new Date(t) })));
    const before = calls.length;
    const res = await analyzeForOnboarding(
      { parsed, sportName: c.sport ?? "Football 7-a-side", validPositions: c.positions ?? FOOTBALL, candidateNames: c.players.map((p) => p[0]) },
      { model },
    );
    const call = calls[before];
    const checks: Array<{ what: string; ok: boolean; want: unknown; got: unknown }> = [];
    const check = (what: string, ok: boolean, want: unknown, got: unknown) => {
      checks.push({ what, ok, want, got });
      total++;
      if (ok) correct++;
    };
    const s = res?.schedule;
    check("schedule.day", (s?.dayOfWeek ?? null) === c.schedule.day, c.schedule.day, s?.dayOfWeek ?? null);
    check("schedule.time", (s?.time ?? null) === c.schedule.time, c.schedule.time, s?.time ?? null);
    const venue = s?.venue ?? null;
    check(
      "schedule.venue",
      c.schedule.venue === null ? venue === null : !!venue && venue.toLocaleLowerCase("tr").includes(c.schedule.venue),
      c.schedule.venue,
      venue,
    );
    check("paymentHolder", (res?.paymentHolder.name ?? null) === c.payer, c.payer, res?.paymentHolder.name ?? null);
    for (const [name, pos, dir] of c.players) {
      const p = res?.players.find((x) => x.name === name);
      const okPos = Array.isArray(pos) ? pos.includes(p?.position ?? null) : (p?.position ?? null) === pos;
      check(`${name}.position`, okPos, pos, p?.position ?? null);
      check(`${name}.rating`, dirOf(p?.seedRating ?? null) === dir, dir, p?.seedRating ?? null);
    }
    const dashes = /[–—]/.test(JSON.stringify(res ?? {}));
    out.push({ chat: c.name, ms: call?.ms, in: call?.inputTokens, out: call?.outputTokens, usd: call?.usd, stop: call?.stopReason, error: call?.error, dashes, checks, raw: call?.raw });
    console.log(`\n== ${c.name}  ${call?.ms}ms in=${call?.inputTokens} out=${call?.outputTokens} $${call?.usd?.toFixed(5)}${call?.error ? `  ERROR ${call.error}` : ""}${res ? "" : "  NULL"}`);
    for (const k of checks) console.log(`  ${k.ok ? "PASS" : "FAIL"} ${k.what.padEnd(20)} want ${JSON.stringify(k.want).padEnd(18)} got ${JSON.stringify(k.got)}`);
  }
  const lat = latency(calls);
  const summary = {
    name: "onboarding-analyzer",
    arm: ARM,
    model: arm.model,
    prompt: TAG,
    result: `${correct}/${total} checks`,
    calls: calls.length,
    cost: Number(usd().toFixed(6)),
    p50ms: lat.p50,
    p90ms: lat.p90,
    empty: calls.filter((c) => c.empty).length,
    chats: out,
  };
  console.log(`\n${summary.result} on ${arm.model} (${TAG} prompt), ${calls.length} calls, $${summary.cost}, p50 ${lat.p50}ms p90 ${lat.p90}ms, empty ${summary.empty}`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
