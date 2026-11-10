/**
 * A FORM NOTE IS FOR THE BALANCER, NOT A SETTING, AND IT SAYS ITS AMOUNT:
 * THE PAID CHECK (2026-11-10).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only.
 *
 * Sutton FC, Tue 10 Nov 2026 12:14: "@Match Time reduce my strength for this
 * match as I am quite tired." routed admin_ops (router, Haiku 5.5), the admin
 * extractor read it as "other", and the admin fallback sent the club's
 * settings page. It belongs to the balancer route, whose teams extractor has
 * a "form" action (#584). Later the same day (Kemal): say the amount so it
 * can be changed. The teams extractor's `form` now carries who and how much,
 * on the one scale the rating adjuster uses, and "make it -1" or "cancel my
 * adjustment" change it, so those route to balancer too.
 *
 * Three parts, each case ONCE:
 *   1. the router on the incident, form notes EN and TR, changes and cancels
 *      of the amount (a reply to MatchTime's line, and tagged), and the
 *      boundaries that must not move (a real setting, "make it 8 aside", a
 *      stats question, attendance, untagged chat);
 *   2. the teams extractor on every case the router should send to balancer:
 *      the action, and for a form note who it is about and the amount;
 *   3. the incident end to end: the live router, then the live teams
 *      extractor inside `runTeamOpsBatch` (club state stubbed, the note kept
 *      in memory, no database), printing the reply the group would get.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-form-note.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database, sends
 * nothing. Stops at MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import { runTeamOpsBatch } from "../src/lib/team-ops-engine-batch.ts";
import { world } from "../src/lib/pipeline/__tests__/helpers.ts";
import type { ContextMessage } from "../src/lib/reply-context.ts";
import type { Route } from "../src/lib/pipeline/types.ts";

const MAX_USD = 0.5;

spendDevApiKeyOrExit("the form note live check");

let calls = 0;
let usd = 0;
const inner = anthropicModel();
const model: PipelineModel = {
  name: inner.name,
  async complete(req) {
    if (usd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
    const r = await inner.complete(req);
    calls++;
    usd += r.costUsd ?? 0;
    return r;
  },
};

const INCIDENT = "@Match Time reduce my strength for this match as I am quite tired.";
const NOW = new Date("2026-11-10T12:20:00Z");
const MT_LINE_EN = "Noted: -0.5 for Kemal Ediz (tired) in Tuesday's game. Want a different amount? Tag me, e.g. make it -1.";
const MT_LINE_TR = 'Not aldım: Salı maçında Kemal Ediz için -0,5 (yorgun). Farklı bir miktar mı istersiniz? Beni etiketleyip yazın, örneğin "-1 yap".';
const replyTo = (text: string): ContextMessage => ({ at: new Date("2026-11-10T12:15:00Z"), text, topic: null, match: null, author: null });

/** What the extractor should read for a form note: who, and the amount's range. */
interface WantForm {
  ref: RegExp;
  min: number;
  max: number;
}

interface Case {
  text: string;
  want: Route[];
  hq?: boolean;
  reply?: ContextMessage;
  /** For a balancer case: the extractor's action, and for "form" the entry. */
  action?: string;
  form?: WantForm;
  why: string;
}

const ME = /^(me|Kemal( Ediz)?)$/i;

const CASES: Case[] = [
  { text: INCIDENT, want: ["balancer"], action: "form", form: { ref: ME, min: -0.75, max: -0.25 }, why: "the incident" },
  { text: "@Match Time bit hungover today, go easy on my rating tonight", want: ["balancer"], action: "form", form: { ref: ME, min: -0.75, max: -0.25 }, why: "hungover" },
  { text: "@Match Time bugün çok yorgunum, bu maç için puanımı düşür", want: ["balancer"], action: "form", form: { ref: ME, min: -0.75, max: -0.25 }, why: "tired, TR" },
  { text: "@Match Time I've hurt my knee, take it into account when you make the teams", want: ["balancer"], action: "form", form: { ref: ME, min: -1, max: -0.75 }, why: "injured knee" },
  { text: "@Match Time dizimden sakatlandım, takımlarda göz önünde bulundur", want: ["balancer"], action: "form", form: { ref: ME, min: -1, max: -0.75 }, why: "injured knee, TR" },
  { text: "@Match Time I'm feeling great today, rate me up", want: ["balancer"], action: "form", form: { ref: ME, min: 0.25, max: 1 }, why: "in form" },
  { text: "@Match Time Tom pulled his hamstring on Sunday, keep it in mind for the teams", want: ["balancer"], action: "form", form: { ref: /^Tom$/, min: -1, max: -0.75 }, why: "another player injured" },
  { text: "@Match Time lower my strength for this match, I'm shattered", hq: true, want: ["balancer"], action: "form", form: { ref: ME, min: -0.75, max: -0.25 }, why: "HQ, tired" },
  // NEW (the amount said): changes and cancels, EN and TR, in reply and not.
  { text: "make it -1", reply: replyTo(MT_LINE_EN), want: ["balancer"], action: "form", form: { ref: ME, min: -1, max: -1 }, why: "change, a reply to MatchTime's line" },
  { text: "-1 yap", reply: replyTo(MT_LINE_TR), want: ["balancer"], action: "form", form: { ref: ME, min: -1, max: -1 }, why: "change, TR, a reply" },
  { text: "@Match Time just -0.25 for me", want: ["balancer"], action: "form", form: { ref: ME, min: -0.25, max: -0.25 }, why: "change, tagged, not a reply" },
  { text: "@Match Time benim için sadece -0,25 olsun", want: ["balancer"], action: "form", form: { ref: ME, min: -0.25, max: -0.25 }, why: "change, TR, tagged" },
  { text: "@Match Time cancel my adjustment", want: ["balancer"], action: "form", form: { ref: ME, min: 0, max: 0 }, why: "cancel" },
  { text: "@Match Time puan ayarımı iptal et", want: ["balancer"], action: "form", form: { ref: ME, min: 0, max: 0 }, why: "cancel, TR" },
  { text: "@Match Time make it -3", reply: replyTo(MT_LINE_EN), want: ["balancer"], action: "form", form: { ref: ME, min: -3, max: -1 }, why: "past the cap (code clamps)" },
  { text: "@Match Time Tom has a bad knee, -1 for him", hq: true, want: ["balancer"], action: "form", form: { ref: /^Tom$/, min: -1, max: -1 }, why: "HQ, an organiser sets another's" },
  // Boundaries that must not move.
  { text: "@Match Time change the kickoff to 8", want: ["admin_ops"], why: "a real setting" },
  { text: "@Match Time set the fee to 10", want: ["admin_ops"], why: "a real setting" },
  { text: "@Match Time make it 8 aside", want: ["admin_ops"], why: "a game's size, not an amount" },
  { text: "@Match Time what is Kemal's strength?", want: ["question"], why: "a stats question" },
  { text: "@Match Time Kemal'in gücü ne?", want: ["question"], why: "a stats question, TR" },
  { text: "Knackered after work but I'm in", want: ["self_att"], why: "tired AND a place: the place wins" },
  { text: "so tired today lads", want: ["none"], why: "untagged chat" },
];

async function routeOnce(c: Case, i: number): Promise<Route | undefined> {
  const context = organisersContext({ pending: [], recent: [] });
  const r = await routeBatch(
    model,
    [
      {
        id: `c${i}`,
        authorName: c.hq ? "Hamzah" : "Kemal Ediz",
        body: c.text,
        ...(c.reply ? { reply: c.reply } : {}),
        ...(c.hq ? { organisers: { context, senderIsOrganiser: true } } : {}),
      },
    ],
    { floor: false, awaiting: null },
  );
  return r.routes[0]?.route;
}

async function main() {
  console.log(`\n== 1. Router: ${CASES.length} cases x 1 ==\n`);
  let ok = 0;
  for (const [i, c] of CASES.entries()) {
    const got = (await routeOnce(c, i)) ?? "missing";
    const pass = c.want.includes(got as Route);
    if (pass) ok++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)} -> ${got}   (${c.why}; want ${c.want.join("|")})`);
  }
  console.log(`-- router: ${ok}/${CASES.length}`);

  const toBalancer = CASES.filter((c) => c.action);
  const extra: Case[] = [{ text: "@Match Time generate the teams, Tom's knee is bad so go easy on him", want: ["balancer"], action: "generate", why: "a build that mentions form" }];
  const all = [...toBalancer, ...extra];
  console.log(`\n== 2. Teams extractor: ${all.length} cases x 1 ==\n`);
  let eok = 0;
  for (const [i, c] of all.entries()) {
    const ex = await extractForRoute(model, "balancer", {
      id: `t${i}`,
      body: c.text,
      authorName: c.hq ? "Hamzah" : "Kemal Ediz",
      tagged: true,
      history: [],
      lastBotPost: c.reply?.text ?? null,
      reply: c.reply ?? null,
      now: NOW,
    });
    const f = ex.facts.kind === "teams" ? ex.facts : null;
    const a = f ? f.action : `(${ex.facts.kind})`;
    let pass = a === c.action;
    let detail = "";
    if (pass && c.form) {
      const entries = f?.form ?? [];
      const e = entries[0];
      pass = entries.length === 1 && !!e && c.form.ref.test(e.personRef) && e.delta >= c.form.min && e.delta <= c.form.max;
      detail = ` form ${JSON.stringify(entries)}`;
    }
    if (pass) eok++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)} -> ${a}${detail}   (${c.why}; want ${c.action}${c.form ? ` ${c.form.ref} ${c.form.min}..${c.form.max}` : ""})`);
  }
  console.log(`-- teams extractor: ${eok}/${all.length}`);

  console.log(`\n== 3. The incident end to end (live router, live extractor, club state stubbed, note in memory) ==\n`);
  const route = await routeOnce(CASES[0]!, 99);
  console.log(`router: ${route}`);
  if (route === "balancer") {
    const stored: unknown[] = [];
    const res = await runTeamOpsBatch({
      orgId: "org-sutton",
      now: NOW,
      messages: [
        {
          waMessageId: "wa-incident",
          body: INCIDENT,
          authorName: "Kemal Ediz",
          senderUserId: "u-kemal",
          senderName: "Kemal Ediz",
          tagged: true,
          taggedExplicitly: true,
          route: "balancer",
          gated: false,
        },
      ],
      history: [],
      enabled: new Set<Route>(["balancer"]),
      deps: {
        model,
        loadState: async () => ({ ...world({ confirmed: ["kemal", "elvin"] }), matchDayName: "Tuesday" }),
        loadFeatures: async () =>
          ({ botEnabled: true, attendance: true, bench: true, teamBalancing: true, momVoting: true, playerRating: true, reminders: true, statsQa: true, paymentTracking: false, paymentCollection: false, squadFromList: false, language: "en", rollingSquad: false, benchPickMode: "first-come", badgeAnnouncements: true, squadMode: "weekly" }) as never,
        selectTeamsMatch: async () => ({ id: "match-1", date: new Date("2026-11-10T20:30:00Z") }),
        forceConfirm: async () => {
          throw new Error("must not confirm anyone");
        },
        generateTeams: async () => {
          throw new Error("must not build teams");
        },
        formNotes: {
          async save(n) {
            stored.push(n);
            return { existed: false, reason: n.reason };
          },
        },
      },
    });
    const o = res.outcomes.get("wa-incident");
    console.log(`intent: ${o?.intent}\naction: ${o?.action}\nreply: ${JSON.stringify(o?.reply)}\nstored: ${JSON.stringify(stored)}`);
  }

  console.log(`\nModel calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
}

main().catch((err) => {
  console.error(err);
  console.log(`\nModel calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
