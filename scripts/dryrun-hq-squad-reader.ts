/**
 * LIVE dry run for the HQ squad reader (2026-10-29; every squad message
 * since 2026-10-30), on the real FNF HQ messages of 29 Oct (from the HQ
 * log), squad lists in English and Turkish, and the changes it now reads
 * too (name lists, one-line changes, a replacement, a change beside a
 * question to MatchTime).
 *
 * The unit and e2e tests stub the model: they prove what code does with a
 * reading. Only the real model can prove it reads MatchTime's own teams
 * sheet pasted back, "Swap / names / With / names" and the bare two blocks
 * as teams, and a real squad list as the squad with the right players left
 * off on purpose. This asks it ONCE per case.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-hq-squad-reader.ts [--first] [--out file.json]
 *
 * `--first` runs the first case only (measure one call before the rest);
 * `--only <text>` the cases whose name contains it.
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it), through the exact
 * production call (`readHqSquadMessage`, `HQ_SQUAD_READER_CALL`, the
 * production prompt and checks). Touches no database and sends nothing.
 * Hard stop at MAX_USD.
 */
import { writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { readHqSquadMessage, type HqSquadReading } from "../src/lib/hq-squad-reader.ts";
import type { HqReaderMember, HqSquadReaderContext, HqSquadReaderInput } from "../src/lib/hq-squad-reader-prompt.ts";

const MAX_USD = 1.0;

// ── FNF, 29 Oct ───────────────────────────────────────────────────────

const NON_BIBS = ["Feroz", "Alamgir", "Rafi", "Hamza", "Mo", "Uncle Najib", "Abdul-Hafeez", "Mojib", "Yaseen"];
const BIBS = ["Yorel", "Maj", "Imz", "Hamzah", "Akram", "Mahir", "Shehryar", "Habib", "Ali"];
const OTHERS = ["Raihan", "AH", "Bilal", "Naim Khan", "Tariq"];
const FNF_NAMES = [...NON_BIBS, ...BIBS, ...OTHERS];
const fnfId = (n: string) => `u-${n.toLowerCase().replace(/[^a-z]/g, "")}`;
const FNF_MEMBERS: HqReaderMember[] = FNF_NAMES.map((name, i) => ({ ref: `p${i + 1}`, userId: fnfId(name), name, aliases: name === "Uncle Najib" ? ["Uncle"] : [] }));
const ref = (n: string) => FNF_MEMBERS.find((m) => m.name === n)!.userId;

// The 18:02 proposal: the same 18 players, the sides as MatchTime had them.
const SIDES_1802 = {
  red: ["Feroz", "Uncle Najib", "Yorel", "Akram", "Alamgir", "Shehryar", "Abdul-Hafeez", "Mojib", "Yaseen"],
  yellow: ["Rafi", "Mo", "Imz", "Maj", "Hamza", "Mahir", "Hamzah", "Habib", "Ali"],
};
const sheet = (red: string[], yellow: string[]) =>
  `📝 *Proposed teams*: 20:30 at Harris Merton\n\n*Non Bibs*:\n${red.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n*Bibs*:\n${yellow.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\nTo change them, just tell me in your own words (for example *swap Feroz and Yorel*, *move Feroz to the other team* or *shuffle them again*).\nReply *YES* when they are final. I won't post them in the players' group.`;

const FNF_CTX: HqSquadReaderContext = {
  orgId: "fnf",
  game: { label: "Fri 30 Oct, 20:30", places: 18 },
  members: FNF_MEMBERS,
  squad: { playing: [...NON_BIBS, ...BIBS].map(ref), bench: [] },
  teams: { state: "proposed", sides: [{ label: "Non Bibs", userIds: SIDES_1802.red.map(ref) }, { label: "Bibs", userIds: SIDES_1802.yellow.map(ref) }] },
};

const PASTED_BACK = `Here’s the teams: \n\n*Non Bibs*:\n${NON_BIBS.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n*Bibs*:\n${BIBS.map((n, i) => `${i + 1}. ${n}`).join("\n")}`;
const SHEET_COPY = sheet(NON_BIBS, BIBS);
const SWAP_LEFT = ["Mo", "Mojib", "Alamgir", "Feroz", "Yaseen", "Rafi", "Abdul-Hafeez", "Hamza", "Uncle"];
const SWAP_RIGHT = ["Hamzah", "Yorel", "Akram", "Shehryar", "Imz", "Maj", "Mahir", "Habib", "Ali"];
const SWAP = `Swap \n${SWAP_LEFT.join("\n")}\n\nWith \n\n${SWAP_RIGHT.join("\n")}`;
const BARE = `${SWAP_LEFT.join("\n")}\n\n${SWAP_RIGHT.join("\n")}`;

// The 18:08 proposal (after the "in" messages): what the teams were at 18:37.
const CTX_1837: HqSquadReaderContext = {
  ...FNF_CTX,
  teams: {
    state: "final",
    sides: [
      { label: "Non Bibs", userIds: ["Feroz", "Uncle Najib", "Alamgir", "Abdul-Hafeez", "Mojib", "Yaseen", "Rafi", "Mo", "Hamza"].map(ref) },
      { label: "Bibs", userIds: ["Yorel", "Akram", "Shehryar", "Imz", "Maj", "Mahir", "Hamzah", "Habib", "Ali"].map(ref) },
    ],
  },
};
const H_1804 = [
  { author: "AH", body: "What are are the final teams? @Match Time" },
  { author: "AH", body: "Omds it changed them" },
  { author: "MatchTime", body: "The list pasted earlier was not applied.\n\n" + sheet(SIDES_1802.red, SIDES_1802.yellow) },
  { author: "AH", body: "Show me the teams" },
  { author: "AH", body: "Bugged out" },
];
const H_1802 = [
  { author: "Raihan", body: "I think the teams are fine" },
  { author: "MatchTime", body: sheet(SIDES_1802.red, SIDES_1802.yellow) },
  { author: "AH", body: "These are the final trams" },
  { author: "AH", body: "What are are the final teams? @Match Time" },
  { author: "AH", body: "Omds it changed them" },
];
const H_1837 = [
  { author: "AH", body: "I messed it up cos I said the word T34MS after Raihan did \n\nAnd then it did them again" },
  { author: "Raihan", body: "@Match Time swap everyone on bibs to non bibs. Switch all 9" },
  { author: "Raihan", body: "Imz got bibs" },
  { author: "Raihan", body: "So just makes sense" },
  { author: "Hamzah", body: "@Match Time move team 1 over to team 2 side" },
];
const H_1838 = [...H_1837.slice(1), { author: "Raihan", body: SWAP }];

// ── A real squad list, English (FNF shape) ─────────────────────────────

// Next week's squad: Habib and Ali left off on purpose, Bilal and Naim in,
// Tariq on the bench.
const NEXT_WEEK = [...NON_BIBS, ...BIBS.filter((n) => n !== "Habib" && n !== "Ali"), "Bilal", "Naim Khan"];
const EN_SQUAD = `FNF Friday 6th Nov\n${NEXT_WEEK.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\nReserves\n1. Tariq`;
const EN_CTX: HqSquadReaderContext = { ...FNF_CTX, game: { label: "Fri 6 Nov, 20:30", places: 18 }, teams: null };
const EN_SQUAD_PLAIN = [...NON_BIBS, ...BIBS.filter((n) => n !== "Akram"), "Bilal"].join("\n");
const EN_SQUAD_NEW = `Squad for Friday:\n${[...NON_BIBS, ...BIBS.filter((n) => n !== "Ali"), "Zubair"].map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\nReply YES to confirm`;
const H_SQUAD = [{ author: "AH", body: "Pasting next week's list, Akram can't make it" }];

// ── Turkish ────────────────────────────────────────────────────────────

const TR_NAMES = ["Erdal Yilmaz", "Burak", "Volkan", "Emre", "Mehmet", "Kemal", "Can", "Deniz", "Serkan", "Okan", "Tolga", "Cem", "Hakan", "Murat"];
const trId = (n: string) => `t-${n.split(" ")[0].toLowerCase()}`;
const TR_MEMBERS: HqReaderMember[] = TR_NAMES.map((name, i) => ({ ref: `p${i + 1}`, userId: trId(name), name, aliases: name === "Erdal Yilmaz" ? ["Erdal abi"] : [] }));
const TR_PLAYING = ["Erdal Yilmaz", "Burak", "Volkan", "Emre", "Mehmet", "Kemal", "Can", "Deniz", "Serkan", "Okan"].map(trId);
const TR_CTX: HqSquadReaderContext = { orgId: "tr", game: { label: "Cum 6 Kas, 21:00", places: 10 }, members: TR_MEMBERS, squad: { playing: TR_PLAYING, bench: [] }, teams: null };
// Okan and Serkan out, Tolga and Cem in, Hakan yedek.
const TR_SQUAD = "Cuma kadrosu\n1. Erdal abi\n2. Burak\n3. Volkan\n4. Emre\n5. Mehmet\n6. Kemal\n7. Can\n8. Deniz\n9. Tolga\n10. Cem\n\nYedekler\n1. Hakan";
const TR_TEAMS_CTX: HqSquadReaderContext = {
  ...TR_CTX,
  teams: { state: "proposed", sides: [{ label: "Kırmızı", userIds: TR_PLAYING.slice(0, 5) }, { label: "Sarı", userIds: TR_PLAYING.slice(5) }] },
};
const TR_TEAMS = "Takımlar:\n\n*Kırmızı*:\n1. Erdal\n2. Burak\n3. Volkan\n4. Emre\n5. Mehmet\n\n*Sarı*:\n1. Kemal\n2. Can\n3. Deniz\n4. Serkan\n5. Okan";
const TR_PAID = "Ödeyenler:\nErdal\nBurak\nVolkan\nEmre";

// ── Checks ─────────────────────────────────────────────────────────────

type Check = (r: HqSquadReading) => string | null;
const kind = (k: HqSquadReading["kind"]): Check => (r) => (r.kind === k ? null : `kind ${r.kind}`);
const squad = (want: { out: string[]; bench?: string[]; lines?: number; newNames?: string[] }): Check => (r) => {
  if (r.kind !== "squad") return `kind ${r.kind}`;
  const out = [...r.out].sort().join(",");
  if (out !== [...want.out].sort().join(",")) return `out [${r.out.join(",")}] want [${want.out.join(",")}]`;
  const bench = r.lines.filter((l) => l.section === "bench").map((l) => l.userId ?? l.name).sort().join(",");
  if (want.bench && bench !== [...want.bench].sort().join(",")) return `bench [${bench}]`;
  if (want.lines !== undefined && r.lines.length !== want.lines) return `${r.lines.length} lines, want ${want.lines}`;
  const news = r.lines.filter((l) => !l.userId).map((l) => l.name).sort().join(",");
  if (want.newNames && news !== [...want.newNames].sort().join(",")) return `new [${news}]`;
  return null;
};

const change = (want: Array<[string, "in" | "out" | "bench"]>, opts: { alsoAsks?: boolean; replaces?: [string, string] } = {}): Check => (r) => {
  if (r.kind !== "change") return `kind ${r.kind}`;
  const got = r.changes.map((c) => `${c.userId ?? `new:${c.name}`}:${c.to}`).sort().join(",");
  const exp = want.map(([who, to]) => `${who}:${to}`).sort().join(",");
  if (got !== exp) return `changes [${got}] want [${exp}]`;
  if (opts.alsoAsks !== undefined && r.alsoAsks !== opts.alsoAsks) return `alsoAsks ${r.alsoAsks}`;
  if (opts.replaces) {
    const c = r.changes.find((x) => x.userId === opts.replaces![0]);
    if (c?.replaces !== opts.replaces[1]) return `replaces "${c?.replaces}"`;
  }
  return null;
};

interface Case {
  name: string;
  input: HqSquadReaderInput;
  ctx: HqSquadReaderContext;
  check: Check;
}
const C = (name: string, body: string, ctx: HqSquadReaderContext, sender: string, now: string, history: HqSquadReaderInput["history"], check: Check): Case => ({
  name,
  input: { body, sender: { userId: ctx.members.find((m) => m.name === sender)?.userId ?? "u-ah", name: sender }, history, reply: null, now: new Date(now) },
  ctx,
  check,
});

const CASES: Case[] = [
  C("29 Oct 18:04 'Here's the teams:' (the incident)", PASTED_BACK, FNF_CTX, "AH", "2026-10-29T18:04:47Z", H_1804, kind("teams")),
  C("29 Oct 18:02 MatchTime's own sheet pasted back", SHEET_COPY, FNF_CTX, "AH", "2026-10-29T18:02:00Z", H_1802, kind("teams")),
  C("29 Oct 18:37 Swap / names / With / names", SWAP, CTX_1837, "Raihan", "2026-10-29T18:37:23Z", H_1837, kind("teams")),
  C("29 Oct 18:38 the bare 18 names", BARE, CTX_1837, "Raihan", "2026-10-29T18:38:01Z", H_1838, kind("teams")),
  C("EN: next week's squad, two left off, a reserve", EN_SQUAD, EN_CTX, "AH", "2026-10-31T10:00:00Z", [], squad({ out: [ref("Habib"), ref("Ali")], bench: [ref("Tariq")] })),
  C("EN: plain names, Akram left off as the chat says", EN_SQUAD_PLAIN, EN_CTX, "AH", "2026-10-31T10:00:00Z", H_SQUAD, squad({ out: [ref("Akram")], lines: 18 })),
  C("EN: a new name nobody has (Zubair) is a person, MatchTime's words are not", EN_SQUAD_NEW, EN_CTX, "AH", "2026-10-31T10:00:00Z", [], squad({ out: [ref("Ali")], newNames: ["Zubair"] })),
  C("EN: a short list of two to add is never 'the rest are out'", "Add these two for Friday\nBilal\nNaim Khan", EN_CTX, "AH", "2026-10-31T10:00:00Z", [], (r) => (r.kind === "squad" ? (r.out.length === 0 ? null : `out [${r.out.join(",")}]`) : r.kind === "change" ? change([[ref("Bilal"), "in"], [ref("Naim Khan"), "in"]])(r) : null)),
  C("TR: Cuma kadrosu with yedekler, Okan and Serkan off", TR_SQUAD, TR_CTX, "Erdal Yilmaz", "2026-11-03T10:00:00Z", [], squad({ out: [trId("Okan"), trId("Serkan")], bench: [trId("Hakan")] })),
  C("TR: takımlar pasted back", TR_TEAMS, TR_TEAMS_CTX, "Erdal Yilmaz", "2026-11-05T18:00:00Z", [], kind("teams")),
  C("TR: ödeyenler is not the squad", TR_PAID, TR_CTX, "Erdal Yilmaz", "2026-11-05T18:00:00Z", [], kind("other")),
  // ── Changes (2026-10-30: one line or many, no code reads them) ──
  C("EN: 17 Oct name list with In", "Imti\nRafi\nAH\n\nIn", { ...EN_CTX, members: [...FNF_MEMBERS, { ref: "p99", userId: "u-imti", name: "Imti", aliases: [] }] }, "Raihan", "2026-10-31T10:00:00Z", [], change([["u-imti", "in"], ["u-rafi", "in"], ["u-ah", "in"]])),
  C("EN: one-line list out", "Yaseen, Mo, Feroz and Ali out", EN_CTX, "Raihan", "2026-10-31T10:00:00Z", [], change([["u-yaseen", "out"], ["u-mo", "out"], ["u-feroz", "out"], ["u-ali", "out"]])),
  C("EN: a stranger out beside a question to MatchTime", "Glazers is out now.\n\n@Match Time what is the list?", EN_CTX, "Raihan", "2026-10-31T10:00:00Z", [], change([["new:Glazers", "out"]], { alsoAsks: true })),
  C("EN: a replacement", "Bilal is replacing Habib", EN_CTX, "Raihan", "2026-10-31T10:00:00Z", [], (r) => {
    if (r.kind !== "change") return `kind ${r.kind}`;
    const b = r.changes.find((c) => c.userId === ref("Bilal"));
    return b?.to === "in" && b.replaces === "Habib" ? null : `changes ${JSON.stringify(r.changes)}`;
  }),
  C("EN: the sender about himself", "I'm out this week lads", EN_CTX, "Raihan", "2026-10-31T10:00:00Z", [], change([["u-raihan", "out"]])),
  C("EN: reassurance about players already in is talk", "Mojib and Habib are in dw", EN_CTX, "Raihan", "2026-10-31T10:00:00Z", [{ author: "AH", body: "Are Mojib and Habib still playing?" }], kind("other")),
  C("TR: Tolga ve Cem var", "Tolga ve Cem var", TR_CTX, "Erdal Yilmaz", "2026-11-03T10:00:00Z", [], change([[trId("Tolga"), "in"], [trId("Cem"), "in"]])),
  C("TR: belki is talk", "Okan belki gelmez haftaya", TR_CTX, "Erdal Yilmaz", "2026-11-03T10:00:00Z", [], kind("other")),
];

// ── The players' group (2026-10-30, `place: "players"`) ────────────────

const SUT_NAMES = ["Kemal Ediz", "Elvin Aliyev", "Sait Demir", "Mustafa Kaya", "Abid Hussain", "Idris Bello", "Faris Nasser", "Shaz Iqbal", "Adam Osman", "Efat Rahman", "Kieran Lee", "Wasim Akhtar"];
const sutId = (n: string) => `s-${n.split(" ")[0].toLowerCase()}`;
const SUT_MEMBERS: HqReaderMember[] = SUT_NAMES.map((name, i) => ({ ref: `p${i + 1}`, userId: sutId(name), name, aliases: [] }));
const SUT_PLAYING = SUT_NAMES.slice(0, 10).map(sutId);
const SUT_CTX: HqSquadReaderContext = { orgId: "sutton", game: { label: "Tue 3 Nov, 21:30", places: 14 }, members: SUT_MEMBERS, squad: { playing: SUT_PLAYING, bench: [] }, teams: null };
const SUT_POST = `⚽ *Tue 3 Nov, 21:30* at Goals Sutton\n\n${SUT_NAMES.slice(0, 10).map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n4 places left`;
const SUT_HISTORY = [{ author: "MatchTime", body: SUT_POST }, { author: "Wasim Akhtar", body: "who's playing tuesday?" }];
const SUT_REPASTE = `Tuesday 21:30 Goals Sutton\n${SUT_NAMES.slice(0, 10).map((n, i) => `${i + 1}. ${n}`).join("\n")}\n11. Kieran`;
const SUT_FRIEND = `Tuesday 21:30 Goals Sutton\n${SUT_NAMES.slice(0, 10).map((n, i) => `${i + 1}. ${n}`).join("\n")}\n11. Wasim\n12. Sam (Wasim's mate)`;
const TRP_CTX: HqSquadReaderContext = { ...TR_CTX, squad: { playing: TR_PLAYING, bench: [] } };
const TRP_REPASTE = `Cuma 21:00 halısaha\n${["Erdal Yilmaz", "Burak", "Volkan", "Emre", "Mehmet", "Kemal", "Can", "Deniz", "Serkan", "Okan"].map((n, i) => `${i + 1}. ${n}`).join("\n")}\n11. Tolga`;
const TRP_SHEET = `⚽ *Takımlar*\n\n*Kırmızı*:\n1. Erdal Yilmaz\n2. Burak\n3. Volkan\n4. Emre\n5. Mehmet\n\n*Sarı*:\n1. Kemal\n2. Can\n3. Deniz\n4. Serkan\n5. Okan`;
const players = (c: Case): Case => ({ ...c, input: { ...c.input, place: "players" } });
/** Every playing member of THE SQUAD is on the list as playing, plus `added`. */
const restates = (squadIds: string[], added: string[]): Check => (r) => {
  if (r.kind !== "squad") return `kind ${r.kind}`;
  const playing = new Set(r.lines.filter((l) => l.section === "playing").map((l) => l.userId ?? l.name));
  const missing = squadIds.filter((id) => !playing.has(id));
  if (missing.length) return `not restated as playing: ${missing.join(",")}`;
  const absent = added.filter((a) => !playing.has(a));
  return absent.length ? `added not on it: ${absent.join(",")}` : null;
};
CASES.push(
  players(C("PLAYERS EN: the list re-pasted with Kieran added, by Kieran", SUT_REPASTE, SUT_CTX, "Kieran Lee", "2026-11-02T18:00:00Z", SUT_HISTORY, restates(SUT_PLAYING, [sutId("Kieran Lee")]))),
  players(C("PLAYERS EN: Wasim adds himself and a mate nobody knows", SUT_FRIEND, SUT_CTX, "Wasim Akhtar", "2026-11-02T18:00:00Z", SUT_HISTORY, restates(SUT_PLAYING, [sutId("Wasim Akhtar"), "Sam"]))),
  players(C("PLAYERS EN: a bare IN is not a list", "IN", SUT_CTX, "Kieran Lee", "2026-11-02T18:00:00Z", SUT_HISTORY, kind("other"))),
  players(C("PLAYERS EN: 'Elvin out' is not a change here (read another way)", "Elvin out", SUT_CTX, "Wasim Akhtar", "2026-11-02T18:00:00Z", SUT_HISTORY, kind("other"))),
  players(C("PLAYERS EN: a drop in a sentence is not a list", "can't make it tuesday lads, sorry", SUT_CTX, "Elvin Aliyev", "2026-11-02T18:00:00Z", SUT_HISTORY, kind("other"))),
  players(C("PLAYERS TR: liste Tolga eklenerek tekrar", TRP_REPASTE, TRP_CTX, "Tolga", "2026-11-05T18:00:00Z", [], restates(TR_PLAYING, [trId("Tolga")]))),
  players(C("PLAYERS TR: MatchTime'ın takımları geri yapıştırıldı", TRP_SHEET, { ...TRP_CTX, teams: TR_TEAMS_CTX.teams }, "Erdal Yilmaz", "2026-11-05T18:00:00Z", [], (r) => (r.kind === "squad" ? "read as a squad" : null))),
);

async function main() {
  const first = process.argv.includes("--first");
  const outIdx = process.argv.indexOf("--out");
  const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
  const inner = anthropicModel({ apiKey: spendDevApiKeyOrExit("dryrun-hq-squad-reader") });
  let calls = 0;
  let usd = 0;
  let lastRaw = "";
  const model: PipelineModel = {
    name: "metered",
    complete: async (req) => {
      if (usd >= MAX_USD) throw new Error(`cost cap $${MAX_USD} reached after ${calls} calls`);
      const r = await inner.complete(req);
      calls++;
      usd += r.costUsd ?? 0.01;
      lastRaw = r.text;
      console.log(`   usage in=${r.usage.inputTokens} out=${r.usage.outputTokens} cache_w=${r.usage.cacheWriteTokens} cache_r=${r.usage.cacheReadTokens} usd=${(r.costUsd ?? 0).toFixed(5)} ms=${r.ms}`);
      return r;
    },
  };
  const results: Array<{ name: string; ok: boolean; why: string | null; raw: string }> = [];
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx > 0 ? process.argv[onlyIdx + 1] : null;
  const fromIdx = process.argv.indexOf("--from");
  const from = fromIdx > 0 ? Number(process.argv[fromIdx + 1]) : 0;
  const chosen = first ? CASES.slice(0, 1) : only ? CASES.filter((c) => c.name.includes(only)) : CASES.slice(from);
  for (const c of chosen) {
    lastRaw = "";
    const got = await readHqSquadMessage(c.input, c.ctx, { model });
    const why = c.check(got);
    results.push({ name: c.name, ok: why === null, why, raw: lastRaw });
    console.log(`${why === null ? "PASS" : "FAIL"} ${c.name}${why ? `: ${why}` : ""}`);
    if (why) console.log(`   raw: ${lastRaw.slice(0, 1500)}`);
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} as expected. ${calls} live calls, cost ≈ $${usd.toFixed(4)}`);
  if (outFile) writeFileSync(outFile, JSON.stringify({ calls, usd, results }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
