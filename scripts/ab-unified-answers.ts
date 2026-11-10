/**
 * THE UNIFIED_ANSWERS A/B (Kemal, 2026-11-10). PAID: dev key only.
 *
 * ⚠️  THIS READS PRODUCTION (read only) AND CALLS THE REAL MODEL.
 *     Spends ANTHROPIC_API_KEY_DEV only (refuses without it), hard stop at
 *     MAX_USD. Nothing is written to any database and nothing is sent: the
 *     database client refuses every write (`ab-readonly-db.ts`), and the
 *     answers are only returned and saved to a local file.
 *
 * Every case is answered TWICE against today's data:
 *   OLD  the pipeline as live (UNIFIED_ANSWERS off): the question extractor,
 *        who-is-who, the set answers, the generic stats and open answers;
 *   NEW  the unified path (on): the small extractor, then one unified answer.
 * Players' group cases go through `runAnswerBatch`, HQ through
 * `answerHqQuestion`, DMs through the DM answer (old) and the unified DM.
 *
 * The data each loader returns is read once per club and handed to both
 * paths as a copy, so OLD and NEW see the same snapshot.
 *
 *   node --env-file=../../../.env ./node_modules/.bin/tsx scripts/ab-unified-answers.ts <questions.json> <out.json>
 *
 * LIMIT=n runs the first n cases (LIMIT=1: the one-call measurement).
 * Prints calls, tokens and dollars, per path.
 */
import "./ab-readonly-db.ts";
import { assertReadOnly, refusedWrites } from "./ab-readonly-db.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { db } from "../src/lib/db.ts";
import { anthropicModel, type ModelRequest, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { runAnswerBatch } from "../src/lib/pipeline/answer-batch.ts";
import { enabledStepSevenRoutes } from "../src/lib/pipeline/route-flags.ts";
import { answerHqQuestion } from "../src/lib/admin-group-question.ts";
import { hqHelpGates } from "../src/lib/admin-group-help.ts";
import { getOrgFeatures } from "../src/lib/org-features.ts";
import { loadClubSnapshot, loadPaymentSnapshot, loadRatingProgressSnapshot, loadSquadState } from "../src/lib/pipeline/load-state.ts";
import { loadStatsChemistry, loadStatsPeriod, loadStatsTables } from "../src/lib/pipeline/load-stats.ts";
import { loadRecentResults } from "../src/lib/pipeline/load-results.ts";
import { loadHelpClubFacts } from "../src/lib/help-club-facts.ts";
import { asChatLines, loadWeekChat, WEEK_CHAT_MS } from "../src/lib/week-chat.ts";
import { monthNotStartedFor } from "../src/lib/month-not-started.ts";
import { organisersGroupReply, passesOrganisersNet } from "../src/lib/organisers-list-copy.ts";
import { buildScopedContext, composeScopedAnswer, DM_QA_CALL, DM_QA_MAX_TOKENS } from "../src/lib/dm-qa.ts";
import { loadUnifiedDmInput } from "../src/lib/unified-dm.ts";
import { answerUnified } from "../src/lib/pipeline/unified-answer.ts";
import { noReplyContext } from "../src/lib/reply-context.ts";
import { buildDmQaApology } from "../src/lib/dm-copy.ts";
import { normaliseLang } from "../src/lib/i18n/lang.ts";
import type { Route, SquadState } from "../src/lib/pipeline/types.ts";

const MAX_USD = 10;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 5);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const [, , QUESTIONS = "questions.json", OUT = "ab-results.json"] = process.argv;

spendDevApiKeyOrExit("the unified answers A/B");

const CLUBS = {
  sutton: "cmnnwhdx30000zfr85q18lyy9",
  fnf: "cmv9nmp81000006l2iau88fig",
  vets: "cmvzlm8km000707iihou1ut9h",
} as const;

interface Question {
  id: string;
  org: string;
  place: "group" | "hq";
  userId: string | null;
  author: string | null;
  body: string;
  source: string;
}

interface CallRec {
  label: string;
  inTok: number;
  outTok: number;
  usd: number;
  ms: number;
  text?: string;
}

interface PathResult {
  answer: string;
  kind: "answer" | "silent" | "dm-link";
  intent: string | null;
  topic: string | null;
  calls: CallRec[];
  usd: number;
  ms: number;
  rejected: string | null;
  notes: string[];
}

let totalUsd = 0;
let totalCalls = 0;
const inner = anthropicModel();

function metered(rec: CallRec[]): PipelineModel {
  return {
    name: "anthropic",
    async complete(req: ModelRequest) {
      if (totalUsd >= MAX_USD) throw new Error(`BUDGET STOP at $${MAX_USD}`);
      const r = await inner.complete(req);
      totalUsd += r.costUsd ?? 0;
      totalCalls++;
      rec.push({
        label: req.label,
        inTok: r.usage.inputTokens + (r.usage.cacheReadTokens ?? 0) + (r.usage.cacheWriteTokens ?? 0),
        outTok: r.usage.outputTokens,
        usd: r.costUsd ?? 0,
        ms: r.ms,
        ...(req.label.startsWith("extractor:question") ? { text: r.text } : {}),
      });
      return r;
    },
  };
}

// ── The snapshot: each read once per club, a copy to each path ──────────
const memo = new Map<string, Promise<unknown>>();
function once<T>(key: string, read: () => Promise<T>): () => Promise<T> {
  return async () => {
    if (!memo.has(key)) memo.set(key, read());
    return structuredClone(await (memo.get(key) as Promise<T>));
  };
}

const NOW = new Date();

function snapshot(orgId: string) {
  return {
    state: once(`state:${orgId}`, () => loadSquadState(orgId, NOW)),
    features: once(`features:${orgId}`, () => getOrgFeatures(orgId)),
    club: (matchId: string | null) => once(`club:${orgId}:${matchId}`, () => loadClubSnapshot(orgId, matchId))(),
    stats: once(`stats:${orgId}`, () => loadStatsTables(orgId, NOW)),
    period: (since: Date) => once(`period:${orgId}:${since.toISOString()}`, () => loadStatsPeriod(orgId, since))(),
    chemistry: (userId: string) => once(`chem:${orgId}:${userId}`, () => loadStatsChemistry(orgId, userId))(),
    results: (since: Date | null, lang: string) => once(`results:${orgId}:${since?.toISOString()}`, () => loadRecentResults(orgId, since, NOW, lang))(),
    payments: (cm: SquadState["completedMatch"]) => once(`pay:${orgId}`, () => loadPaymentSnapshot(orgId, cm))(),
    rating: (lang?: string) => once(`rating:${orgId}`, () => loadRatingProgressSnapshot(orgId, lang))(),
    clubFacts: once(`facts:${orgId}`, () => loadHelpClubFacts(orgId, {})),
    week: once(`week:${orgId}`, async () =>
      asChatLines(await loadWeekChat({ orgId, channel: "group", since: new Date(NOW.getTime() - WEEK_CHAT_MS), includeMatchTime: true })),
    ),
    hqWeek: once(`hqweek:${orgId}`, async () =>
      asChatLines(await loadWeekChat({ orgId, channel: "hq", since: new Date(NOW.getTime() - WEEK_CHAT_MS), includeMatchTime: true })),
    ),
    org: once(`org:${orgId}`, () =>
      db.organisation.findUniqueOrThrow({
        where: { id: orgId },
        select: { name: true, language: true, squadMode: true, benchPickMode: true, paymentCollectionEnabled: true, paymentTrackingEnabled: true, featurePlayerPool: true },
      }),
    ),
    monthNotStarted: once(`month:${orgId}`, async () => {
      const st = await loadSquadState(orgId, NOW);
      return st.matchId ? monthNotStartedFor(st.matchId) : false;
    }),
    // A regular non-admin member: the asker of a question replayed here.
    regular: once(`regular:${orgId}`, async () => {
      const st = await loadSquadState(orgId, NOW);
      const t = await loadStatsTables(orgId, NOW);
      const admins = new Set(st.roster.filter((m) => m.isAdmin).map((m) => m.userId));
      const top = t.appearances.find((a) => !admins.has(a.userId) && st.roster.some((m) => m.userId === a.userId));
      const m = st.roster.find((x) => x.userId === top?.userId) ?? st.roster.find((x) => !x.isAdmin) ?? st.roster[0];
      return { userId: m.userId, name: m.name };
    }),
    admin: once(`admin:${orgId}`, async () => {
      const st = await loadSquadState(orgId, NOW);
      const m = st.roster.find((x) => x.isAdmin) ?? st.roster[0];
      return { userId: m.userId, name: m.name };
    }),
  };
}
const snaps = new Map<string, ReturnType<typeof snapshot>>();
const snap = (orgId: string) => snaps.get(orgId) ?? (snaps.set(orgId, snapshot(orgId)), snaps.get(orgId)!);

function deps(orgId: string, model: PipelineModel) {
  const s = snap(orgId);
  return {
    model,
    loadState: async () => s.state(),
    loadFeatures: async () => s.features(),
    loadClub: async (_o: string, matchId: string | null) => s.club(matchId),
    loadStats: async () => s.stats(),
    loadStatsPeriod: async (_o: string, since: Date) => s.period(since),
    loadChemistry: async (_o: string, u: string) => s.chemistry(u),
    loadResults: async (_o: string, since: Date | null, _n: Date, lang: string) => s.results(since, lang),
    loadPayments: async (_o: string, cm: SquadState["completedMatch"]) => s.payments(cm),
    loadRatingProgress: async (_o: string, lang?: string) => s.rating(lang),
    loadClubFacts: async () => s.clubFacts(),
  };
}

function topicOf(calls: CallRec[]): string | null {
  const x = calls.find((c) => c.label.startsWith("extractor:question"));
  if (!x?.text) return null;
  try {
    const j = JSON.parse(x.text) as { topic?: string; kind?: string; feature?: string; table?: string };
    return [j.kind ?? j.topic, j.table && j.table !== "none" ? j.table : null, j.feature && j.feature !== "none" ? j.feature : null].filter(Boolean).join(" ");
  } catch {
    return null;
  }
}

async function askGroup(c: Case, unified: boolean): Promise<PathResult> {
  const calls: CallRec[] = [];
  const model = metered(calls);
  const s = snap(c.orgId);
  const state = await s.state();
  const week = await s.week();
  const t0 = Date.now();
  const id = `ab-${c.key}-${unified ? "new" : "old"}`;
  const res = await runAnswerBatch({
    orgId: c.orgId,
    now: NOW,
    messages: [
      {
        waMessageId: id,
        body: c.body,
        authorName: c.askerName,
        senderUserId: c.askerUserId,
        senderName: c.askerName,
        tagged: true,
        addressed: true,
        route: "question" as Route,
        gated: false,
      },
    ],
    // The extractors' few recent lines, as the Pi forwards them.
    history: week.slice(-8).map((l) => ({ author: l.author, body: l.body })),
    weekChat: async () => week,
    expectedMatchId: state.matchId,
    enabled: enabledStepSevenRoutes({}),
    monthNotStarted: await s.monthNotStarted(),
    poolEnv: async () => ({}),
    unified,
    deps: deps(c.orgId, model),
  });
  const o = res.outcomes.get(id);
  const notes = res.degradations.filter((d) => /not used|grounding|failed|unanswered|nobody answers/.test(d)).map((d) => d.replace(id, "msg"));
  const rejected = notes.find((n) => /not used/.test(n)) ?? null;
  let answer: string;
  let kind: PathResult["kind"] = "answer";
  if (!o) {
    answer = "[no answer: the players' group gets today's not-understood line]";
    kind = "silent";
  } else if (o.statsLinkRequest) {
    answer = "[sends the asker their own stats link by DM; the group hears that it was sent]";
    kind = "dm-link";
  } else {
    // The analyze route's organisers-mode net, as live.
    const organisersMode = state.features.listAnnouncer === "organisers";
    let reply = o.reply ?? "";
    if (organisersMode && !passesOrganisersNet(o.intent)) reply = organisersGroupReply(reply, state.features.language) ?? "";
    answer = reply || "[no answer]";
    if (!reply) kind = "silent";
  }
  return { answer, kind, intent: o?.intent ?? null, topic: topicOf(calls), calls, usd: sum(calls, "usd"), ms: Date.now() - t0, rejected, notes };
}

async function askHq(c: Case, unified: boolean): Promise<PathResult> {
  const calls: CallRec[] = [];
  const model = metered(calls);
  const s = snap(c.orgId);
  const org = await s.org();
  const week = await s.hqWeek();
  const t0 = Date.now();
  const id = `ab-${c.key}-${unified ? "new" : "old"}`;
  const st = await s.state();
  const d = deps(c.orgId, model);
  const r = await answerHqQuestion({
    orgId: c.orgId,
    lang: org.language,
    messageId: id,
    body: c.body,
    senderUserId: c.askerUserId,
    senderName: c.askerName,
    now: NOW,
    history: week.slice(-8).map((l) => ({ author: l.author, body: l.body })),
    weekChat: async () => week,
    lastBotPost: [...week].reverse().find((l) => l.author === "MatchTime")?.body ?? null,
    gates: hqHelpGates(org, {}),
    poolEnv: {},
    unified,
    deps: { ...d, loadState: async () => st },
  });
  return {
    answer: r?.replyText ?? "[no answer: HQ's one line]",
    kind: r ? "answer" : "silent",
    intent: r?.outcome ?? null,
    topic: topicOf(calls),
    calls,
    usd: sum(calls, "usd"),
    ms: Date.now() - t0,
    rejected: null,
    notes: [],
  };
}

async function askDm(c: Case, unified: boolean): Promise<PathResult> {
  const calls: CallRec[] = [];
  const model = metered(calls);
  const s = snap(c.orgId);
  const org = await s.org();
  const lang = normaliseLang(org.language);
  const t0 = Date.now();
  const st = await s.state();
  const isAdmin = st.roster.some((m) => m.userId === c.askerUserId && m.isAdmin);
  if (!unified) {
    const context = await buildScopedContext(c.orgId, c.askerUserId!, isAdmin, lang);
    const out = await composeScopedAnswer({
      context,
      question: c.body,
      askerName: c.askerName,
      orgName: org.name,
      lang,
      replyContext: noReplyContext(),
      call: async (system, user) => {
        const r = await model.complete({ ...DM_QA_CALL, system, user, maxTokens: DM_QA_MAX_TOKENS, label: "dm-qa" });
        return { text: r.text || null, truncated: false };
      },
    });
    return { answer: out.answer, kind: "answer", intent: "dm-qa", topic: null, calls, usd: sum(calls, "usd"), ms: Date.now() - t0, rejected: null, notes: [] };
  }
  const input = await loadUnifiedDmInput({
    orgId: c.orgId,
    userId: c.askerUserId!,
    askerName: c.askerName,
    askerIsAdmin: isAdmin,
    question: c.body,
    lang,
    replyContext: noReplyContext(),
    now: NOW,
  });
  const g = await answerUnified({ ...input, model });
  const rejected = "rejected" in g.result ? g.result.rejected : null;
  return {
    answer: "text" in g.result ? g.result.text : buildDmQaApology(lang),
    kind: "answer",
    intent: "dm-unified",
    topic: null,
    calls,
    usd: sum(calls, "usd"),
    ms: Date.now() - t0,
    rejected,
    notes: rejected ? [rejected] : [],
  };
}

const sum = (calls: CallRec[], k: "usd") => calls.reduce((a, c) => a + c[k], 0);

interface Case {
  key: string;
  qIndex: number;
  orgId: string;
  place: "group" | "hq" | "dm";
  origin: "original" | "replayed";
  body: string;
  source: string;
  askerUserId: string | null;
  askerName: string | null;
}

async function buildCases(qs: Question[]): Promise<Case[]> {
  const cases: Case[] = [];
  const asker = async (orgId: string, q: Question, admin: boolean) => {
    const st = await snap(orgId).state();
    const m = q.userId ? st.roster.find((x) => x.userId === q.userId) : undefined;
    if (m && (!admin || m.isAdmin)) return { userId: m.userId, name: m.name };
    return admin ? snap(orgId).admin() : snap(orgId).regular();
  };
  for (const [i, q] of qs.entries()) {
    for (const [name, orgId] of Object.entries(CLUBS)) {
      const a = await asker(orgId, q, false);
      cases.push({
        key: `${i}-${name}-group`,
        qIndex: i,
        orgId,
        place: "group",
        origin: q.place === "group" && q.org === orgId ? "original" : "replayed",
        body: q.body,
        source: q.source,
        askerUserId: a.userId,
        askerName: a.name,
      });
    }
    const a = await asker(CLUBS.fnf, q, true);
    cases.push({
      key: `${i}-fnf-hq`,
      qIndex: i,
      orgId: CLUBS.fnf,
      place: "hq",
      origin: q.place === "hq" ? "original" : "replayed",
      body: q.body,
      source: q.source,
      askerUserId: a.userId,
      askerName: a.name,
    });
  }
  // DMs: none are stored, so every fourth question is replayed as a DM from
  // a Sutton regular.
  for (const [i, q] of qs.entries()) {
    if (i % 4 !== 0) continue;
    const a = await asker(CLUBS.sutton, q, false);
    cases.push({ key: `${i}-sutton-dm`, qIndex: i, orgId: CLUBS.sutton, place: "dm", origin: "replayed", body: q.body, source: q.source, askerUserId: a.userId, askerName: a.name });
  }
  return cases;
}

async function main() {
  await assertReadOnly();
  console.log("read-only guard: a delete was refused before reaching the database");
  const qs = JSON.parse(readFileSync(QUESTIONS, "utf8")) as Question[];
  const all = await buildCases(qs);
  const cases = all.slice(0, Number.isFinite(LIMIT) ? LIMIT : all.length);
  console.log(`${qs.length} questions, ${all.length} cases, running ${cases.length}`);
  const results: Array<Case & { old?: PathResult; new?: PathResult; error?: string }> = [];
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const c = cases[next++];
      const run = c.place === "group" ? askGroup : c.place === "hq" ? askHq : askDm;
      try {
        const old = await run(c, false);
        const neu = await run(c, true);
        results.push({ ...c, old, new: neu });
        const done = results.length;
        if (done % 10 === 0 || cases.length <= 3) {
          console.log(`  ${done}/${cases.length}  $${totalUsd.toFixed(3)}  ${totalCalls} calls`);
        }
      } catch (err) {
        console.error(`  case ${c.key} failed: ${(err as Error).message}`);
        results.push({ ...c, error: (err as Error).message });
        if (/BUDGET STOP/.test((err as Error).message)) break;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  results.sort((a, b) => a.qIndex - b.qIndex || a.key.localeCompare(b.key));
  writeFileSync(OUT, JSON.stringify({ at: NOW.toISOString(), totalUsd, totalCalls, refusedWrites, results }, null, 1));

  const per = (p: "old" | "new") => {
    const rs = results.filter((r) => r[p]);
    const calls = rs.flatMap((r) => r[p]!.calls);
    return {
      calls: calls.length,
      usd: calls.reduce((a, c) => a + c.usd, 0),
      inTok: calls.reduce((a, c) => a + c.inTok, 0),
      outTok: calls.reduce((a, c) => a + c.outTok, 0),
      byLabel: Object.entries(
        calls.reduce<Record<string, { n: number; usd: number; inTok: number }>>((m, c) => {
          const x = (m[c.label] ??= { n: 0, usd: 0, inTok: 0 });
          x.n++;
          x.usd += c.usd;
          x.inTok += c.inTok;
          return m;
        }, {}),
      ).map(([l, x]) => `${l}: ${x.n} calls, ${Math.round(x.inTok / x.n)} input tokens each, $${x.usd.toFixed(4)}`),
    };
  };
  console.log("OLD", JSON.stringify(per("old"), null, 1));
  console.log("NEW", JSON.stringify(per("new"), null, 1));
  console.log(`TOTAL: ${totalCalls} model calls, $${totalUsd.toFixed(4)} (dev key). Writes refused: ${refusedWrites.length} (${[...new Set(refusedWrites)].join(", ") || "none"})`);
  if (cases.length < all.length) {
    const avg = totalUsd / cases.length;
    console.log(`ESTIMATE for all ${all.length} cases: about $${(avg * all.length).toFixed(2)} at $${avg.toFixed(4)} a case`);
  }
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
