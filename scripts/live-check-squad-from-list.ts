/**
 * THE SQUAD-LIST READING: THE PAID CHECK (2026-10-21).
 *
 * The only harness this reading had (`scripts/test-squad-from-list.ts`)
 * drives DEPLOYED PROD through the cron and a real database. This one
 * drives the shipped `readSquadLists` against the real model on fixture
 * windows of group messages, with no database and no writes: the lists
 * are printed and judged, never stored.
 *
 * Each window is one call. Every message has an expected answer: not a
 * list, or a list with its playing names and reserves in order. Names
 * are compared after `normaliseName` (case, accents and invisible
 * spacing folded), so "NABEEL" against "Nabeel" is a pass and a dropped,
 * added or reordered name is a fail.
 *
 *   ARM=sonnet|haiku TAG=old|new OUT=/path/result.json \
 *     DATABASE_URL=postgresql://none@127.0.0.1:1/none \
 *     node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-squad-from-list.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Each window once.
 */
import fs from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { ARMS, armModel, latency } from "../e2e/helpers/arm-model.ts";
import { readSquadLists, type SourceMessage } from "../src/lib/squad-from-list.ts";
import { normaliseName } from "../src/lib/name-normalise.ts";

spendDevApiKeyOrExit("the squad-list live check");
const ARM = process.env.ARM ?? "haiku";
const TAG = process.env.TAG ?? "new";
const arm = ARMS[ARM];
if (!arm) throw new Error(`ARM must be one of ${Object.keys(ARMS).join(", ")}`);
const { model, calls, usd } = armModel(arm, Number(process.env.MAX_USD ?? 0.6));

interface Expect {
  names: string[];
  reserves?: string[];
}
interface Msg {
  from: string;
  body: string;
  /** null: not a squad list. */
  want: Expect | null;
}
interface Window {
  name: string;
  messages: Msg[];
}

/** WhatsApp's pasted numbering: "1." then word-joiner, space, word-joiner. */
const WJ = "⁠";
const wa = (i: number, name: string) => `${String(i).padStart(2, " ")}.${WJ} ${WJ}${name}`;
const numbered = (names: string[], fmt: (i: number, n: string) => string = wa) => names.map((n, i) => fmt(i + 1, n)).join("\n");

// ── Window 1: Amir's Thursday group, the real 2026-05-17 shape ─────────
const AMIR_HEAD = "In sha Allah 9pm Thursday 21 May Wimbledon Goals 7 a side football:";
const AMIR_ORDER = ["Ehtisham", "Amir", "Atul", "Adam", "Trevell", "NABEEL", "Zeeshan", "Tharan", "Raahil", "Bilal", "youssef", "Shaz", "Faris", "Usama"];
const amirAt = (n: number) => AMIR_ORDER.slice(0, n);
const amirPost = (n: number, reserves: string[] = []) =>
  `${AMIR_HEAD}\n\n${numbered(amirAt(n))}` + (reserves.length ? `\n\nReserves:\n${numbered(reserves)}` : "");
const AMIR: Window = {
  name: "EN Amir's Thursday re-paste ritual",
  messages: [
    { from: "Amir", body: amirPost(2), want: { names: amirAt(2) } },
    { from: "Atul", body: amirPost(3), want: { names: amirAt(3) } },
    { from: "Adam", body: amirPost(5), want: { names: amirAt(5) } },
    { from: "Dan", body: "anyone got a spare pump?", want: null },
    { from: "Nabeel", body: amirPost(6), want: { names: amirAt(6) } },
    { from: "Zeeshan", body: amirPost(7), want: { names: amirAt(7) } },
    { from: "T", body: amirPost(8), want: { names: amirAt(8) } },
    { from: "Raahil", body: amirPost(9), want: { names: amirAt(9) } },
    { from: "Bilal", body: amirPost(10), want: { names: amirAt(10) } },
    { from: "youssef", body: amirPost(11), want: { names: amirAt(11) } },
    { from: "Shaz", body: amirPost(14), want: { names: amirAt(14) } },
    { from: "Amir", body: amirPost(14, ["Martin"]), want: { names: amirAt(14), reserves: ["Martin"] } },
  ],
};

// ── Window 2: the shapes that are not a list, and one that is ──────────
const NOT_LISTS: Window = {
  name: "EN lookalikes that are not a squad",
  messages: [
    { from: "MatchTime", body: "MoM leaderboard:\n1. Pete 4 votes (40%)\n2. Dan 3 votes (30%)\n3. Felix 2 votes (20%)", want: null },
    { from: "Sam", body: "Teams for tonight\nReds:\n1. Pete\n2. Dan\n3. Felix\nYellows:\n1. Greg\n2. Ollie\n3. Raj", want: null },
    { from: "Ollie", body: "Two questions for the group:\n1. same pitch?\n2. bibs or no bibs?", want: null },
    { from: "Raj", body: "1. yes\n2. no", want: null },
    { from: "Greg", body: "I scored 3 last week lol, 7-2 in the end", want: null },
    {
      from: "Pete",
      body: "Tuesday 8pm Powerleague\n1. Pete\n2. Dan\n3. Felix\n4. Greg\n5. Ollie\n6. Raj",
      want: { names: ["Pete", "Dan", "Felix", "Greg", "Ollie", "Raj"] },
    },
  ],
};

// ── Window 3: messy lines (emoji digits, notes, guests, gaps, repeats) ──
const EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣"];
const MESSY: Window = {
  name: "EN messy lines: emoji digits, notes, guests, an empty slot",
  messages: [
    {
      from: "Kev",
      body: `⚽ SUNDAY 10AM HACKNEY MARSHES ⚽\n${["Kev", "Jono", "Big Mike", "Sully"].map((n, i) => `${EMOJI[i]} ${n}`).join("\n")}`,
      want: { names: ["Kev", "Jono", "Big Mike", "Sully"] },
    },
    {
      from: "Rob",
      body: "Sunday 10am\n1) Kev\n2) Jono\n3) Big Mike\n4) Sully\n5) Rob (GK)\n6) Dev - might be 10 mins late\n7) Ash ✅\n8)",
      want: { names: ["Kev", "Jono", "Big Mike", "Sully", "Rob", "Dev", "Ash"] },
    },
    {
      from: "Liam",
      body: "Sunday 10am\n1) Kev\n2) Jono\n3) Big Mike\n4) Sully\n5) Rob (GK)\n6) Dev - might be 10 mins late\n7) Ash ✅\n8) Liam\n9) Liam's mate Craig\n\nSubs:\n1) Tommo\n2) Paddy",
      want: { names: ["Kev", "Jono", "Big Mike", "Sully", "Rob", "Dev", "Ash", "Liam", "Liam's mate Craig"], reserves: ["Tommo", "Paddy"] },
    },
    { from: "Kev", body: "Liam that's 9, we only need 8, can Craig go on subs?", want: null },
  ],
};

// ── Window 4: Turkish group, "Yedekler" block, Turkish letters ─────────
const TR_HEAD = "Cuma 21:00 Halısaha Arena 🏟️ 7'ye 7";
const TR_ORDER = ["Erdal", "Mehmet", "Çağlar", "İlker", "Oğuz", "Şükrü", "Burak", "Emre", "Serkan", "Hakan", "Gökhan", "Tolga", "Ümit", "Kerem"];
const trPost = (n: number, yedek: string[] = []) =>
  `${TR_HEAD}\n${numbered(TR_ORDER.slice(0, n), (i, x) => `${i}. ${x}`)}` + (yedek.length ? `\n\nYedekler:\n${numbered(yedek, (i, x) => `${i}. ${x}`)}` : "");
const TURKISH: Window = {
  name: "TR Friday list with Yedekler",
  messages: [
    { from: "Erdal", body: trPost(4), want: { names: TR_ORDER.slice(0, 4) } },
    { from: "Oğuz", body: trPost(5), want: { names: TR_ORDER.slice(0, 5) } },
    { from: "Mehmet", body: "Bu hafta kim kaleye geçiyor?", want: null },
    { from: "Burak", body: trPost(9), want: { names: TR_ORDER.slice(0, 9) } },
    { from: "Kerem", body: trPost(14, ["Volkan", "Cem"]), want: { names: TR_ORDER, reserves: ["Volkan", "Cem"] } },
    { from: "Erdal", body: "Takımlar:\nBeyaz: Erdal, Mehmet, Çağlar, İlker, Oğuz, Şükrü, Burak\nSiyah: Emre, Serkan, Hakan, Gökhan, Tolga, Ümit, Kerem", want: null },
  ],
};

// ── Window 5: a long fortnight of re-pastes (the output-size case) ─────
const BIG_ORDER = [
  "Ali Kaya", "Dan Moore", "Sam Price", "Joe Hart", "Tom Reed", "Ben Cole", "Luke Shaw", "Matt Fox",
  "Ryan Gray", "Nick Webb", "Owen Fry", "Leo Hunt", "Jack Lane", "Harry Dean", "Max Ford", "Zak Ahmed",
];
const bigPost = (n: number, reserves: string[] = []) =>
  `Wednesday 8pm Goals Wimbledon 8-a-side\n\n${numbered(BIG_ORDER.slice(0, n), (i, x) => `${i}. ${x}`)}` +
  (reserves.length ? `\n\nStandby:\n${numbered(reserves, (i, x) => `${i}. ${x}`)}` : "");
const BIG: Window = {
  name: "EN long window: 20 re-pastes up to 16 + standby",
  messages: [
    ...Array.from({ length: 15 }, (_, k) => {
      const n = k + 2;
      return { from: BIG_ORDER[n - 1].split(" ")[0], body: bigPost(n), want: { names: BIG_ORDER.slice(0, n) } } as Msg;
    }),
    { from: "Dan", body: "full! nice one lads", want: null },
    { from: "Kai", body: bigPost(16, ["Kai Lee"]), want: { names: BIG_ORDER, reserves: ["Kai Lee"] } },
    { from: "Rio", body: bigPost(16, ["Kai Lee", "Rio Bell"]), want: { names: BIG_ORDER, reserves: ["Kai Lee", "Rio Bell"] } },
    { from: "Ali", body: "see you all wednesday", want: null },
    { from: "Ash", body: bigPost(16, ["Kai Lee", "Rio Bell", "Ash Khan"]), want: { names: BIG_ORDER, reserves: ["Kai Lee", "Rio Bell", "Ash Khan"] } },
  ],
};

const WINDOWS: Window[] = [AMIR, NOT_LISTS, MESSY, TURKISH, BIG];

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => normaliseName(x) === normaliseName(b[i]));

async function main() {
  const windows: Array<Record<string, unknown>> = [];
  let correct = 0;
  let total = 0;
  const t0 = Date.parse("2026-10-12T08:00:00Z");
  // ONLY=<index>: one window, for measuring a call before a full pass.
  const only = process.env.ONLY;
  for (const [wi, w] of WINDOWS.entries()) {
    if (only && wi !== Number(only)) continue;
    const src: SourceMessage[] = w.messages.map((m, i) => ({
      waMessageId: `3EB0${String(wi).padStart(2, "0")}${String(i).padStart(4, "0")}C1F2A9D4E7B6`,
      body: m.body,
      senderPhone: `4479000${String(wi).padStart(2, "0")}${String(i).padStart(3, "0")}`,
      senderPushname: m.from,
      timestamp: new Date(t0 + i * 37 * 60_000),
    }));
    const before = calls.length;
    const lists = await readSquadLists(src, { model });
    const call = calls[before];
    const byId = new Map(lists.map((l) => [l.waMessageId, l]));
    const rows = w.messages.map((m, i) => {
      const got = byId.get(src[i].waMessageId) ?? null;
      let ok: boolean;
      if (!m.want) ok = got === null;
      else ok = !!got && same(got.names, m.want.names) && same(got.reserves, m.want.reserves ?? []);
      total++;
      if (ok) correct++;
      return {
        i: i + 1,
        from: m.from,
        ok,
        want: m.want ? `${m.want.names.length}+${(m.want.reserves ?? []).length}` : "none",
        got: got ? `${got.names.length}+${got.reserves.length}` : "none",
        names: got?.names ?? null,
        reserves: got?.reserves ?? null,
      };
    });
    windows.push({ window: w.name, ms: call?.ms, in: call?.inputTokens, out: call?.outputTokens, usd: call?.usd, stop: call?.stopReason, error: call?.error, rows, raw: call?.raw });
    console.log(`\n== ${w.name}  ${call?.ms}ms in=${call?.inputTokens} out=${call?.outputTokens} $${call?.usd?.toFixed(5)}${call?.error ? `  ERROR ${call.error}` : ""}`);
    for (const r of rows) {
      console.log(`  ${r.ok ? "PASS" : "FAIL"} #${String(r.i).padStart(2)} ${r.from.padEnd(9)} want ${r.want.padEnd(5)} got ${r.got.padEnd(5)}${r.ok ? "" : `  ${JSON.stringify(r.names)} res ${JSON.stringify(r.reserves)}`}`);
    }
  }
  const lat = latency(calls);
  const summary = {
    name: "squad-from-list",
    arm: ARM,
    model: arm.model,
    prompt: TAG,
    result: `${correct}/${total} messages`,
    calls: calls.length,
    cost: Number(usd().toFixed(6)),
    p50ms: lat.p50,
    p90ms: lat.p90,
    empty: calls.filter((c) => c.empty).length,
    windows,
  };
  console.log(`\n${summary.result} on ${arm.model} (${TAG} prompt), ${calls.length} calls, $${summary.cost}, p50 ${lat.p50}ms p90 ${lat.p90}ms, empty ${summary.empty}`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
