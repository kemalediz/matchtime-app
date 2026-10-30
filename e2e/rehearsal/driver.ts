/**
 * THE REHEARSAL DRIVER: plays the WhatsApp side (the Pi, the people in the
 * groups, the MatchTime owner) against the REAL server routes, tick by
 * tick, with the server's clock moved to each tick (clock-shim.cjs).
 *
 * What it does is what the Pi does, through the same routes:
 *   players' group   buffered, sent to /api/whatsapp/analyze in batches with
 *                    the last 15 messages as history; reactions and replies
 *                    from the answer are recorded (a reply goes through the
 *                    postability gate first, as on the Pi)
 *   admin group      each message at once to /api/whatsapp/admin-group (or
 *                    /admin-group-link for the link command)
 *   due posts        /api/whatsapp/due-posts with the admin-group capability,
 *                    every instruction recorded and acked with a made-up
 *                    WhatsApp id; list posters and team sheets are fetched
 *                    from their signed URL and saved as image files
 *   platform jobs    /api/whatsapp/platform-jobs (sign-up and approval DMs)
 *   crons            /api/cron/* on their vercel.json schedule
 *
 * What it does NOT do, and says so in the transcript: the organiser's web
 * pages. The website sign-up, the settings page and the admin-group link
 * button are stood in for by direct database writes, each labelled.
 *
 * Every timestamp it writes itself is the SIMULATED time, never the
 * database's now(): the database clock is real, only the server's moved.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";
import { E2E, REHEARSAL_CLOCK_FILE } from "../helpers/env";
import { setDmIntentStub, setExtractorStub, setPaymentClaimStub, setRouterStub } from "../helpers/stub";
import type { Tick } from "./clock";
import { formatLocal, type Scenario, type ScenarioMember, type Step } from "./scenario";
import { stubRouting } from "./stub-routes";
import { diffSnapshots, type Channel, type RehearsalEvent } from "./transcript";

const MIN = 60_000;
const bare = (phone: string) => phone.replace(/^\+/, "");

/** What the Pi sends to the link route (whatsapp-bot/src/admin-group.ts,
 *  2026-10-30): a REAL tag and a six-character token of the code alphabet.
 *  No phrase is read. */
const CODE_TOKEN = /(?<![\p{L}\p{N}])[ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz]{6}(?![\p{L}\p{N}])/u;

interface Buffered {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  timestamp: string;
  botMentioned?: boolean;
  eventIndex: number;
  stub: { route: string; facts?: Record<string, unknown> };
}

interface OutPoll {
  waMessageId: string;
  question: string;
  options: string[];
  group: string;
}

export interface DriverResult {
  events: RehearsalEvent[];
  orgId: string | null;
  aiCallsMeasured: number;
  routerRequests: number;
  teamBuilds: number;
  dmClassifierCandidates: number;
  forwardedPlayerMessages: number;
  graphics: string[];
}

export class RehearsalDriver {
  readonly events: RehearsalEvent[] = [];
  readonly graphics: string[] = [];
  orgId: string | null = null;

  private readonly nonce = Date.now().toString(36);
  private readonly jid = new Map<string, string>();
  private readonly keyOfJid = new Map<string, string>();
  private readonly byKey = new Map<string, ScenarioMember>();
  private readonly byPhone = new Map<string, ScenarioMember>();
  private readonly buffered = new Map<number, Buffered>();
  private readonly history: Array<{ authorName: string | null; body: string; timestamp: string }> = [];
  private readonly msgEvent = new Map<string, number>();
  private readonly polls: OutPoll[] = [];
  private readonly outMsgIds: Array<{ waMessageId: string; text: string; eventIndex: number }> = [];
  private snapshot: Record<string, string> = {};
  private now: Date;
  private seq = 0;
  private connectCode: string | null = null;
  private clubSettingsApplied = false;
  private templateApplied = false;
  private aiCalls = 0;
  private routerRequests = 0;
  private teamBuilds = 0;
  private dmClassifierCandidates = 0;
  private forwardedPlayerMessages = 0;
  private orgs: { monitored: Set<string>; admin: Set<string> } = { monitored: new Set(), admin: new Set() };

  constructor(
    private readonly request: APIRequestContext,
    private readonly db: TestDb,
    private readonly scenario: Scenario,
    private readonly opts: {
      outDir: string;
      scenarioDir: string;
      live: boolean;
      /** Open a rating link as that person and submit the page. */
      rate?: (linkPath: string, mom: string | undefined) => Promise<string>;
    },
  ) {
    this.now = scenario.start;
    scenario.groups.forEach((g, i) => {
      // A WhatsApp-shaped group id, unique per run.
      const id = `120363${(Number.parseInt(this.nonce, 36) % 1e9).toString().padStart(9, "0")}${String(i).padStart(3, "0")}@g.us`;
      this.jid.set(g.key, id);
      this.keyOfJid.set(id, g.key);
    });
    for (const m of scenario.members) {
      this.byKey.set(m.key, m);
      this.byPhone.set(bare(m.phone), m);
    }
    // Only the images of THIS run: a previous run's would sit beside them.
    rmSync(path.join(opts.outDir, "graphics"), { recursive: true, force: true });
    mkdirSync(path.join(opts.outDir, "graphics"), { recursive: true });
  }

  // ── Clock ───────────────────────────────────────────────────────────

  /** Move the server's clock to `at` (and keep it moving from there). */
  private async setClock(at: Date): Promise<void> {
    this.now = at;
    writeFileSync(REHEARSAL_CLOCK_FILE, JSON.stringify({ offsetMs: at.getTime() - Date.now(), at: at.toISOString() }));
    await new Promise((r) => setTimeout(r, 40));
  }

  /** Put the server's clock back to real time. */
  restoreClock(): void {
    writeFileSync(REHEARSAL_CLOCK_FILE, JSON.stringify({ offsetMs: 0 }));
  }

  /** The simulated "now", a moment after the tick (for timestamps we write). */
  private simIso(extraMs = 0): string {
    return new Date(this.now.getTime() + extraMs).toISOString();
  }

  // ── Events ──────────────────────────────────────────────────────────

  private push(e: Omit<RehearsalEvent, "at"> & { at?: Date }): number {
    this.events.push({ at: e.at ?? this.now, ...e });
    return this.events.length - 1;
  }

  private info(text: string, channel: Channel = { system: true }): void {
    this.push({ channel, kind: "info", from: "runner", text });
  }

  private error(text: string): void {
    this.push({ channel: { system: true }, kind: "error", text });
  }

  private nextId(prefix: string): string {
    return `${prefix}-${this.nonce}-${++this.seq}`;
  }

  // ── HTTP ────────────────────────────────────────────────────────────

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const f = this.scenario.flags;
    return {
      "x-api-key": E2E.WHATSAPP_API_KEY,
      "x-mt-test-self-join": f.selfJoin ? "1" : "0",
      "x-mt-test-setup-hold": f.setupHold ? "1" : "0",
      "x-mt-test-picture-reading": f.pictureReading ? "1" : "0",
      "x-mt-test-setup-learning": f.setupLearning ? "1" : "0",
      "x-test-now": this.now.toISOString(),
      ...extra,
    };
  }

  private async post(url: string, data: unknown, extra: Record<string, string> = {}): Promise<Record<string, unknown> | null> {
    const res = await this.request.post(url, { headers: this.headers(extra), data, timeout: 120_000 });
    const text = await res.text();
    if (!res.ok()) {
      this.error(`POST ${url} → ${res.status()} ${text.slice(0, 300)}`);
      return null;
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async get(url: string, extra: Record<string, string> = {}, quiet404 = false): Promise<Record<string, unknown> | null> {
    const res = await this.request.get(url, { headers: this.headers(extra), timeout: 120_000 });
    const text = await res.text();
    if (!res.ok()) {
      if (!(quiet404 && res.status() === 404)) this.error(`GET ${url} → ${res.status()} ${text.slice(0, 300)}`);
      return null;
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async aiCallTotal(): Promise<number> {
    if (!this.orgId) return 0;
    return this.db.count(`SELECT COALESCE(SUM(calls), 0) FROM "OrgAiUsage" WHERE "orgId" = $1`, [this.orgId]);
  }

  /** Run `fn`, and attribute the model calls the budget ledger saw to it. */
  private async metered<T>(fn: () => Promise<T>): Promise<{ result: T; calls: number }> {
    const before = await this.aiCallTotal();
    const result = await fn();
    const calls = (await this.aiCallTotal()) - before;
    this.aiCalls += calls;
    return { result, calls };
  }

  // ── The Pi's view of the groups ─────────────────────────────────────

  private async refreshOrgs(): Promise<void> {
    const json = await this.get("/api/whatsapp/orgs");
    if (!json) return;
    const orgs = (json.orgs as Array<{ whatsappGroupId: string | null }> | undefined) ?? [];
    const admin = (json.adminGroups as Array<{ groupId: string }> | undefined) ?? [];
    this.orgs = {
      monitored: new Set(orgs.map((o) => o.whatsappGroupId).filter((g): g is string => !!g)),
      admin: new Set(admin.map((a) => a.groupId)),
    };
  }

  private canPost(groupKey: string): boolean {
    const g = this.scenario.groups.find((x) => x.key === groupKey);
    return !!g && g.matchtime && !g.onlyAdminsCanSend;
  }

  /** MatchTime posts in a group, through the Pi's postability gate. */
  private postInGroup(groupKey: string, text: string, meta: Record<string, unknown> = {}, replyTo?: number, image?: string): string | null {
    if (!this.canPost(groupKey)) {
      this.push({ channel: { group: groupKey }, kind: "blocked", from: "matchtime", text, meta });
      return null;
    }
    const waMessageId = this.nextId("mt");
    const idx = this.push({
      channel: { group: groupKey },
      kind: image ? "graphic" : "out",
      from: "matchtime",
      text,
      meta,
      ...(replyTo !== undefined ? { replyTo } : {}),
      ...(image ? { image } : {}),
    });
    this.outMsgIds.push({ waMessageId, text, eventIndex: idx });
    this.msgEvent.set(waMessageId, idx);
    return waMessageId;
  }

  private dmChannel(phone: string): Channel {
    return { dm: bare(phone) };
  }

  // ── The run ─────────────────────────────────────────────────────────

  async run(ticks: Tick[]): Promise<DriverResult> {
    try {
      for (const tick of ticks) {
        await this.setClock(tick.at);
        try {
          if (tick.kind === "step") await this.step(tick.step);
          else if (tick.kind === "flush") await this.flush(tick.stepSeqs);
          else if (tick.kind === "poll") await this.poll();
          else if (tick.kind === "cron") await this.cron(tick.path);
        } catch (err) {
          this.error(`${tick.kind}${tick.kind === "step" ? ` ${tick.step.do}` : ""}: ${(err as Error).stack ?? String(err)}`);
        }
        if (tick.kind !== "cron") await this.recordDbChanges();
      }
    } finally {
      this.restoreClock();
    }
    return {
      events: this.events,
      orgId: this.orgId,
      aiCallsMeasured: this.aiCalls,
      routerRequests: this.routerRequests,
      teamBuilds: this.teamBuilds,
      dmClassifierCandidates: this.dmClassifierCandidates,
      forwardedPlayerMessages: this.forwardedPlayerMessages,
      graphics: this.graphics,
    };
  }

  private async step(step: Step): Promise<void> {
    switch (step.do) {
      case "note":
        this.push({ channel: { system: true }, kind: "note", text: step.text });
        return;
      case "message":
        return this.message(step);
      case "dm":
        return this.dm(step);
      case "vote":
        return this.vote(step);
      case "react":
        return this.react(step);
      case "rate":
        return this.rate(step);
      case "club-signup":
        return this.clubSignup();
      case "bot-added":
        return this.botAdded(step.group, step.by);
      case "approve":
        return this.approve();
      case "settings":
        return this.settings(step.values);
      case "link-admin-group":
        return this.linkAdminGroup(step.group, step.by);
      case "go-live":
        return this.goLive(step.from);
      case "pi-poll":
        return this.poll();
      case "cron":
        return this.cron(step.path);
    }
  }

  // ── Messages ────────────────────────────────────────────────────────

  private async message(step: Extract<Step, { do: "message" }>): Promise<void> {
    const g = this.scenario.groups.find((x) => x.key === step.group)!;
    const m = this.byKey.get(step.from)!;
    const idx = this.push({
      channel: { group: g.key },
      kind: "in",
      from: m.key,
      text: step.body,
      ...(step.media ? { media: step.media } : {}),
      meta: { source: step.source ?? "script", ...(step.note ? { note: step.note } : {}) },
    });
    const meta = this.events[idx].meta!;
    if (!g.matchtime) {
      Object.assign(meta, { seen: false, why: "MatchTime is not in this group" });
      return;
    }
    const jid = this.jid.get(g.key)!;
    await this.refreshOrgs();
    const waMessageId = this.nextId("wa");
    this.msgEvent.set(waMessageId, idx);
    const stub = stubRouting(step, this.scenario.club.sport.teamLabels);

    if (this.orgs.admin.has(jid)) {
      if (!step.body.trim()) {
        Object.assign(meta, { seen: false, why: "no text (an attachment): nothing to read" });
        return;
      }
      if (!this.opts.live) {
        setRouterStub({ floor: false, routes: { [waMessageId]: stub.route } });
        setExtractorStub({ bodies: stub.facts ? { [step.body.trim()]: stub.facts } : {} });
        meta.route = stub.route;
      }
      const { result, calls } = await this.metered(() =>
        this.post("/api/whatsapp/admin-group", {
          channel: "admin-group",
          groupId: jid,
          messageId: waMessageId,
          text: step.body,
          senderPhone: bare(m.phone),
          timestamp: String(Math.floor(this.now.getTime() / 1000)),
        }),
      );
      if (calls > 0) this.routerRequests += 1;
      meta.handledBy = `admin-group: ${String(result?.outcome ?? result?.ignored ?? "no answer")}${calls ? `, ${calls} model call(s)` : ""}`;
      // "teams" with none built yet, and "reshuffle", build through the
      // shared generator, whose rating adjuster is a model call live.
      if (result?.outcome === "teams-built") this.teamBuilds += 1;
      const reply = typeof result?.replyText === "string" ? result.replyText.trim() : "";
      if (reply) this.postInGroup(g.key, reply, { via: "admin-group reply" }, idx);
      return;
    }

    if (this.orgs.monitored.has(jid)) {
      if (!step.body.trim()) {
        Object.assign(meta, { seen: false, why: "no text (an attachment); picture reading is off" });
        return;
      }
      if (!this.opts.live) meta.route = stub.route;
      this.buffered.set(step.seq, {
        waMessageId,
        body: step.body,
        authorPhone: bare(m.phone),
        authorName: m.pushname,
        timestamp: this.now.toISOString(),
        ...(step.tag ? { botMentioned: true } : {}),
        eventIndex: idx,
        stub,
      });
      return;
    }

    if (step.tag === true && CODE_TOKEN.test(step.body)) {
      const res = await this.post("/api/whatsapp/admin-group-link", {
        groupId: jid,
        text: step.body,
        senderPhone: bare(m.phone),
        botMentioned: step.tag === true,
        messageId: waMessageId,
        timestamp: this.now.toISOString(),
      });
      meta.handledBy = `admin-group-link: ${String(res?.outcome ?? "no answer")}`;
      const reply = typeof res?.replyText === "string" ? res.replyText.trim() : "";
      if (reply) this.postInGroup(g.key, reply, { via: "admin-group-link reply" }, idx);
      return;
    }
    Object.assign(meta, { seen: false, why: "MatchTime is in the group but does not read it (not live, not linked)" });
  }

  private async flush(seqs: number[]): Promise<void> {
    const batch = seqs.map((s) => this.buffered.get(s)).filter((b): b is Buffered => !!b);
    for (const s of seqs) this.buffered.delete(s);
    if (batch.length === 0) return;
    const players = this.scenario.groups.find((g) => g.role === "players")!;
    const jid = this.jid.get(players.key)!;
    if (!this.opts.live) {
      const routes: Record<string, string> = {};
      const bodies: Record<string, Record<string, unknown>> = {};
      for (const b of batch) {
        routes[b.waMessageId] = b.stub.route;
        if (b.stub.facts) bodies[b.body.trim()] = b.stub.facts;
      }
      setRouterStub({ floor: false, routes });
      setExtractorStub({ bodies });
    }
    const history = this.history.slice(-15);
    this.forwardedPlayerMessages += batch.length;
    const { result, calls } = await this.metered(() =>
      this.post("/api/whatsapp/analyze", {
        groupId: jid,
        messages: batch.map((b) => ({
          waMessageId: b.waMessageId,
          body: b.body,
          authorPhone: b.authorPhone,
          authorName: b.authorName,
          timestamp: b.timestamp,
          ...(b.botMentioned ? { botMentioned: true } : {}),
        })),
        ...(history.length ? { history } : {}),
      }),
    );
    if (calls > 0) this.routerRequests += 1;
    for (const b of batch) this.history.push({ authorName: b.authorName, body: b.body, timestamp: b.timestamp });
    const results = (result?.results as Array<{ waMessageId: string; handledBy: string; intent: string | null; react: string | null; reply: string | null }>) ?? [];
    this.info(`The Pi sent ${batch.length} message(s) to analyze in one batch; ${calls} model call(s) under the stubs.`, { group: players.key });
    for (const b of batch) {
      const r = results.find((x) => x.waMessageId === b.waMessageId);
      const ev = this.events[b.eventIndex];
      ev.meta = { ...(ev.meta ?? {}), handledBy: r ? `${r.handledBy}${r.intent ? ` / ${r.intent}` : ""}` : "no result" };
      if (r?.react) this.push({ channel: { group: players.key }, kind: "react", from: "matchtime", text: r.react, replyTo: b.eventIndex });
      if (r?.reply) this.postInGroup(players.key, r.reply, { via: "analyze reply" }, b.eventIndex);
    }
  }

  private async dm(step: Extract<Step, { do: "dm" }>): Promise<void> {
    const m = this.byKey.get(step.from)!;
    const waMessageId = this.nextId("dm");
    const idx = this.push({ channel: this.dmChannel(m.phone), kind: "in", from: m.key, text: step.body });
    this.msgEvent.set(waMessageId, idx);
    if (!this.opts.live) {
      setDmIntentStub({ bodies: step.intent ? { [step.body.trim()]: step.intent } : {} });
      setPaymentClaimStub({ bodies: step.paymentClaim ? { [step.body.trim()]: step.paymentClaim } : {} });
    }
    this.dmClassifierCandidates += 1;
    const res = await this.post("/api/whatsapp/dm-reply", { phone: bare(m.phone), body: step.body, waMessageId, authorName: m.pushname });
    this.events[idx].meta = { handledBy: `dm-reply: ${String(res?.handled ?? res?.outcome ?? res?.ok ?? "?")}` };
    await this.poll();
  }

  private async vote(step: Extract<Step, { do: "vote" }>): Promise<void> {
    const m = this.byKey.get(step.from)!;
    const re = new RegExp(step.poll, "i");
    const poll = [...this.polls].reverse().find((p) => re.test(p.question));
    if (!poll) {
      this.error(`vote by ${m.key}: no poll matching /${step.poll}/ has been posted`);
      return;
    }
    const option = step.option === null ? null : poll.options.find((o) => new RegExp(step.option!, "i").test(o));
    if (step.option !== null && !option) {
      this.error(`vote by ${m.key}: no option matching /${step.option}/ in "${poll.question}" (${poll.options.join(" | ")})`);
      return;
    }
    const idx = this.push({
      channel: { group: poll.group },
      kind: "in",
      from: m.key,
      text: option === null ? "(takes their vote back)" : `(votes: ${option})`,
      replyTo: this.msgEvent.get(poll.waMessageId),
    });
    const res = await this.post("/api/whatsapp/poll-vote", {
      waMessageId: poll.waMessageId,
      voterPhone: bare(m.phone),
      voterName: m.pushname,
      optionName: option ?? null,
    });
    this.events[idx].meta = { handledBy: `poll-vote: ${JSON.stringify(res ?? {}).slice(0, 160)}` };
  }

  private async react(step: Extract<Step, { do: "react" }>): Promise<void> {
    const m = this.byKey.get(step.from)!;
    const re = new RegExp(step.target, "i");
    const target = [...this.outMsgIds].reverse().find((o) => re.test(o.text));
    if (!target) {
      this.error(`react by ${m.key}: no MatchTime message matching /${step.target}/`);
      return;
    }
    const ch = this.events[target.eventIndex].channel;
    const idx = this.push({ channel: ch, kind: "in", from: m.key, text: `(reacts ${step.emoji})`, replyTo: target.eventIndex });
    const res = await this.post("/api/whatsapp/reaction", {
      waMessageId: target.waMessageId,
      emoji: step.emoji,
      fromPhone: bare(m.phone),
      fromAuthorName: m.pushname,
    });
    this.events[idx].meta = { handledBy: `reaction: ${JSON.stringify(res ?? {}).slice(0, 160)}` };
  }

  /** The person opens the rating link MatchTime DM'd them, and submits. */
  private async rate(step: Extract<Step, { do: "rate" }>): Promise<void> {
    const m = this.byKey.get(step.from)!;
    const dm = [...this.events]
      .reverse()
      .find((e) => e.kind === "out" && "dm" in e.channel && e.channel.dm === bare(m.phone) && /\/r\/[A-Za-z0-9_-]+/.test(e.text ?? "") && /rate|man of the match/i.test(e.text ?? ""));
    const link = dm ? /https?:\/\/[^\s/]+(\/r\/[A-Za-z0-9_-]+)/.exec(dm.text ?? "")?.[1] : undefined;
    if (!link || !this.opts.rate) {
      this.error(`rate by ${m.key}: ${link ? "no browser to open the link with" : "MatchTime never DM'd them a rating link"}`);
      return;
    }
    const idx = this.push({
      channel: this.dmChannel(m.phone),
      kind: "in",
      from: m.key,
      text: `(opens the rating link and submits${step.mom ? `, Man of the Match: /${step.mom}/` : ""})`,
      ...(dm ? { replyTo: this.events.indexOf(dm) } : {}),
    });
    const outcome = await this.opts.rate(link, step.mom);
    this.events[idx].meta = { handledBy: `rating page: ${outcome}` };
    if (/^failed/.test(outcome)) this.error(`rate by ${m.key}: ${outcome}`);
  }

  // ── Setup (the web pages are stood in for by labelled DB writes) ────

  private ownerMember(): ScenarioMember {
    return this.byKey.get(this.scenario.club.owner)!;
  }

  private async ensureUser(m: ScenarioMember): Promise<string> {
    const existing = await this.db.one<{ id: string }>(`SELECT id FROM "User" WHERE "phoneNumber" = $1`, [m.phone]);
    if (existing) return existing.id;
    const id = `reh-u-${this.nonce}-${m.key}`;
    await this.db.run(
      `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, true, true, $5, $5)`,
      [id, m.name, `reh-${m.key}-${this.nonce}@e2e-test.invalid`, m.phone, this.simIso()],
    );
    return id;
  }

  private async ensureMembership(userId: string, role: "OWNER" | "ADMIN" | "PLAYER"): Promise<void> {
    const row = await this.db.one<{ id: string }>(`SELECT id FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`, [userId, this.orgId]);
    if (row) await this.db.run(`UPDATE "Membership" SET role = $2 WHERE id = $1`, [row.id, role]);
    else
      await this.db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, $4)`, [
        `reh-mem-${this.nonce}-${userId}`,
        userId,
        this.orgId,
        role,
      ]);
  }

  private async clubSignup(): Promise<void> {
    const c = this.scenario.club;
    const owner = this.ownerMember();
    this.orgId = `reh-org-${this.nonce}`;
    const ownerId = await this.ensureUser(owner);
    await this.db.run(
      `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "approvalStatus", language, "createdAt", "updatedAt")
       VALUES ($1, $2, $1, $3, 'draft', $4, $5, $5)`,
      [this.orgId, c.name, `${this.orgId}-invite`, c.language, this.simIso()],
    );
    await this.ensureMembership(ownerId, "OWNER");
    const sportId = `reh-sport-${this.nonce}`;
    await this.db.run(
      `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, ARRAY['GK','DEF','MID','FWD'], $5, $6, $6)`,
      [sportId, this.orgId, c.sport.name, c.sport.playersPerTeam, c.sport.teamLabels, this.simIso()],
    );
    await this.db.run(
      `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "matchDurationMins", "deadlineHours", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $9)`,
      [`reh-act-${this.nonce}`, this.orgId, sportId, c.name, c.activity.dayOfWeek, c.activity.time, c.activity.venue, c.activity.durationMinutes, this.simIso()],
    );
    this.connectCode = (Number.parseInt(this.nonce, 36) % 46656).toString(36).toUpperCase().padStart(3, "X") + "Q";
    await this.db.run(
      `INSERT INTO "ClubConnect" (id, "orgId", "userId", phone, code, status, "issuedAt", "expiresAt", "dmAt", "dmPhone", "dmLid", "dmPhoneMatched", "addWindowEndsAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'dm_verified', $6, $7, $8, $4, NULL, true, $9, $8)`,
      [
        `reh-cc-${this.nonce}`,
        this.orgId,
        ownerId,
        bare(owner.phone),
        this.connectCode,
        this.simIso(-10 * MIN),
        this.simIso(50 * MIN),
        this.simIso(-5 * MIN),
        this.simIso(23 * 60 * MIN),
      ],
    );
    this.info(
      `STAND-IN (website): ${owner.name} registers "${c.name}" on the website (schedule ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][c.activity.dayOfWeek]} ${c.activity.time}, ${c.activity.venue}, ${c.sport.name}) and sends the connect DM. Written to the database directly.`,
    );
    this.push({ channel: this.dmChannel(owner.phone), kind: "in", from: owner.key, text: `(connect DM with code ${this.connectCode}, stood in for)` });
  }

  private participants(groupKey: string): Array<{ phone: string; pushname: string | null }> {
    return this.scenario.members
      .filter((m) => m.groups.includes(groupKey))
      .map((m) => ({ phone: bare(m.phone), pushname: m.pushname }));
  }

  private async botAdded(groupKey: string, by: string): Promise<void> {
    const g = this.scenario.groups.find((x) => x.key === groupKey)!;
    const m = this.byKey.get(by)!;
    const jid = this.jid.get(groupKey)!;
    this.push({ channel: { group: groupKey }, kind: "info", from: "runner", text: `${m.name} adds MatchTime to "${g.subject}".` });
    const res = await this.post("/api/whatsapp/bot-added", {
      groupId: jid,
      groupSubject: g.subject,
      addedByPhone: bare(m.phone),
      participants: this.participants(groupKey),
      postability: { announce: g.onlyAdminsCanSend, communityAnnounce: false, botIsAdmin: false },
    });
    this.info(`bot-added answered: ${JSON.stringify(res ?? {}).slice(0, 400)}`, { group: groupKey });
    const intro = typeof res?.introText === "string" ? res.introText.trim() : "";
    if (intro && res?.silent !== true) this.postInGroup(groupKey, intro, { via: "bot-added intro" });
    await this.poll();
  }

  private async approve(): Promise<void> {
    await this.poll();
    const job = await this.db.one<{ text: string }>(
      `SELECT text FROM "PlatformJob" WHERE phone = $1 AND text ~* 'APPROVE' ORDER BY "createdAt" DESC LIMIT 1`,
      [E2E.APPROVER_PHONE],
    );
    const ref = job ? /APPROVE\s+([A-Z0-9]+)/i.exec(job.text)?.[1] : null;
    if (!ref) {
      this.error("approve: no approval request DM found for the MatchTime owner");
      return;
    }
    const body = `APPROVE ${ref}`;
    if (!this.opts.live) setDmIntentStub({ bodies: { [body]: `approve_club:${ref.toUpperCase()}` } });
    const idx = this.push({ channel: { dm: E2E.APPROVER_PHONE }, kind: "in", from: "approver", text: body });
    const res = await this.post("/api/whatsapp/dm-reply", { phone: E2E.APPROVER_PHONE, body, waMessageId: this.nextId("dm"), authorName: null });
    this.events[idx].meta = { handledBy: `dm-reply: ${JSON.stringify(res ?? {}).slice(0, 200)}` };
    await this.poll();
  }

  private async settings(values: Record<string, string | number | boolean | null>): Promise<void> {
    if (!this.orgId) throw new Error("settings before club-signup");
    const all = { ...(this.clubSettingsApplied ? {} : this.scenario.club.settings), ...values };
    this.clubSettingsApplied = true;
    const lines: string[] = [];
    for (const [k, v] of Object.entries(all)) {
      await this.db.run(`UPDATE "Organisation" SET "${k}" = $2 WHERE id = $1`, [this.orgId, v]);
      lines.push(`${k} = ${JSON.stringify(v)}`);
    }
    // Admins and the money collector, added on the website by phone.
    for (const m of this.scenario.members) {
      if (m.role !== "ADMIN" && m.role !== "OWNER") continue;
      await this.ensureMembership(await this.ensureUser(m), m.role);
      lines.push(`${m.name} is ${m.role === "OWNER" ? "an owner" : "an admin"}`);
    }
    const holder = this.scenario.club.paymentHolder;
    if (holder) {
      const uid = await this.ensureUser(this.byKey.get(holder)!);
      await this.ensureMembership(uid, this.byKey.get(holder)!.role === "PLAYER" ? "PLAYER" : (this.byKey.get(holder)!.role as "ADMIN" | "OWNER"));
      await this.db.run(`UPDATE "Organisation" SET "paymentHolderId" = $2 WHERE id = $1`, [this.orgId, uid]);
      lines.push(`money collector = ${this.byKey.get(holder)!.name}`);
    }
    await this.db.run(`UPDATE "Activity" SET "matchDurationMins" = $2 WHERE "orgId" = $1`, [this.orgId, this.scenario.club.activity.durationMinutes]);
    const t = this.scenario.club.graphicsTemplate;
    if (t && !this.templateApplied) {
      const image = readFileSync(path.resolve(this.opts.scenarioDir, t.image));
      const layout = readFileSync(path.resolve(this.opts.scenarioDir, t.layout), "utf8");
      const mime = /\.png$/i.test(t.image) ? "image/png" : "image/jpeg";
      await this.db.run(
        `INSERT INTO "ClubGraphicsTemplate" ("orgId", image, "mimeType", layout, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4::jsonb, $5, $5)
         ON CONFLICT ("orgId") DO UPDATE SET image = $2, "mimeType" = $3, layout = $4::jsonb`,
        [this.orgId, image, mime, layout, this.simIso()],
      );
      this.templateApplied = true;
      lines.push(`the club's own poster template uploaded (${path.basename(t.image)})`);
    }
    this.info(`STAND-IN (settings page): ${this.ownerMember().name} saves:\n${lines.join("\n")}`);
  }

  private async linkAdminGroup(groupKey: string, by: string): Promise<void> {
    if (!this.orgId) throw new Error("link-admin-group before club-signup");
    const who = this.byKey.get(by)!;
    // The setup DM sends the organiser a ready-made link message; use it
    // when MatchTime sent one, as the organiser would (forward it).
    const fromDm = [...this.events]
      .reverse()
      .find((e) => e.kind === "out" && "dm" in e.channel && e.channel.dm === bare(who.phone) && /admin\s*group\s+[A-Z0-9]{4,8}\b/i.test(e.text ?? ""));
    let code = fromDm ? /admin\s*group\s+([A-Z0-9]{4,8})\b/i.exec(fromDm.text ?? "")![1] : null;
    if (code) {
      this.info(`${who.name} forwards the link message MatchTime DM'd them into "${this.scenario.groups.find((g) => g.key === groupKey)!.subject}".`);
    } else {
      code = `L${this.nonce.slice(-5).toUpperCase()}`;
      await this.db.run(
        `UPDATE "Organisation" SET "adminGroupLinkCode" = $2, "adminGroupLinkCodeExpiresAt" = $3 WHERE id = $1`,
        [this.orgId, code, this.simIso(60 * MIN)],
      );
      this.info(`STAND-IN (settings page): ${who.name} presses "Link admin group" and gets code ${code}.`);
    }
    await this.message({
      at: this.now,
      seq: -1,
      do: "message",
      group: groupKey,
      from: by,
      body: `@Match Time ${code}`,
      tag: true,
      source: "script",
    });
    await this.refreshOrgs();
  }

  private async goLive(from: string): Promise<void> {
    const m = this.byKey.get(from)!;
    await this.dm({ at: this.now, seq: -1, do: "dm", from, body: "GO" });
    await this.refreshOrgs();
    const players = this.scenario.groups.find((g) => g.role === "players")!;
    const jid = this.jid.get(players.key)!;
    if (!this.orgs.monitored.has(jid)) {
      this.error(`go-live: after ${m.name}'s GO the players' group is still not live`);
      return;
    }
    // The Pi's next org refresh reads the group's members and sends them.
    const res = await this.post("/api/whatsapp/sync-participants", {
      groupId: jid,
      participants: this.participants(players.key).filter((p) => this.byPhone.get(p.phone)?.role !== "NONE"),
    });
    this.info(`The Pi reads the players' group members: ${JSON.stringify(res ?? {}).slice(0, 300)}`, { group: players.key });
  }

  // ── Polls and crons ─────────────────────────────────────────────────

  private async poll(): Promise<void> {
    await this.platformJobs();
    const players = this.scenario.groups.find((g) => g.role === "players")!;
    const jid = this.jid.get(players.key)!;
    if (!this.orgId) return;
    const json = await this.get(
      `/api/whatsapp/due-posts?groupId=${encodeURIComponent(jid)}`,
      { "x-mt-pi-caps": "admin-group", "x-mt-platform-jobs": "1" },
      true,
    );
    const instructions = (json?.instructions as Array<Record<string, unknown>> | undefined) ?? [];
    for (const ins of instructions) await this.instruction(ins, players.key);
  }

  private async ack(ins: Record<string, unknown>, waMessageId?: string | null): Promise<void> {
    await this.post("/api/whatsapp/ack", {
      key: ins.key,
      kind: ins.kind,
      ...(ins.matchId ? { matchId: ins.matchId } : {}),
      ...(ins.targetUser ? { targetUser: ins.targetUser } : {}),
      ...(ins.userId ? { benchUserId: ins.userId } : {}),
      ...(waMessageId ? { waMessageId } : {}),
    });
  }

  private async instruction(ins: Record<string, unknown>, playersKey: string): Promise<void> {
    const kind = String(ins.kind);
    const text = typeof ins.text === "string" ? ins.text : "";
    const meta = { instruction: kind, key: ins.key };
    switch (kind) {
      case "group-message":
      case "bench-prompt": {
        const id = this.postInGroup(playersKey, text, meta);
        await this.ack(ins, id);
        return;
      }
      case "group-poll": {
        const question = String(ins.question ?? "");
        const options = (ins.options as string[]) ?? [];
        const id = this.postInGroup(playersKey, `📊 ${question}\n${options.map((o) => `○ ${o}`).join("\n")}`, meta);
        if (id) this.polls.push({ waMessageId: id, question, options, group: playersKey });
        await this.ack(ins, id);
        return;
      }
      case "dm": {
        const phone = String(ins.phone ?? "");
        const waMessageId = this.nextId("mtdm");
        this.push({ channel: this.dmChannel(phone), kind: "out", from: "matchtime", text, meta });
        await this.ack(ins, waMessageId);
        return;
      }
      case "update-reaction": {
        const idx = this.msgEvent.get(String(ins.waMessageId));
        const ev = idx !== undefined ? this.events[idx] : undefined;
        this.push({
          channel: ev?.channel ?? { group: playersKey },
          kind: "react",
          from: "matchtime",
          text: `${String(ins.emoji)} (changed)`,
          ...(idx !== undefined ? { replyTo: idx } : {}),
          meta,
        });
        await this.ack(ins);
        return;
      }
      case "admin-group-message": {
        const groupKey = this.keyOfJid.get(String(ins.groupId)) ?? "?";
        if (typeof ins.imageUrl === "string" && ins.imageUrl) {
          const file = await this.saveGraphic(ins.imageUrl, String(ins.key));
          const id = this.postInGroup(groupKey, text, meta, undefined, file ?? undefined);
          await this.ack(ins, id);
          return;
        }
        // The 10:00 proposal is a build through the shared generator.
        if (/Proposed teams/.test(text)) this.teamBuilds += 1;
        const id = this.postInGroup(groupKey, text, meta);
        await this.ack(ins, id);
        return;
      }
      default:
        this.info(`instruction of kind "${kind}" (not posted by this runner): ${text.slice(0, 200)}`);
        await this.ack(ins);
    }
  }

  private async saveGraphic(imageUrl: string, key: string): Promise<string | null> {
    const url = new URL(imageUrl, "http://localhost");
    const res = await this.request.get(`${url.pathname}${url.search}`, { headers: this.headers() });
    if (!res.ok()) {
      this.error(`graphic ${url.pathname} → ${res.status()}`);
      return null;
    }
    const type = res.headers()["content-type"] ?? "";
    const ext = type.includes("png") ? "png" : type.includes("jpeg") ? "jpg" : "bin";
    const name = `graphics/${String(this.graphics.length + 1).padStart(2, "0")}-${formatLocal(this.now, this.scenario.timezone).replace(/[^0-9]/g, "")}-${key.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.${ext}`;
    writeFileSync(path.join(this.opts.outDir, name), await res.body());
    this.graphics.push(name);
    return name;
  }

  private async platformJobs(): Promise<void> {
    const json = await this.get("/api/whatsapp/platform-jobs", { "x-mt-platform-jobs": "1" }, true);
    const jobs = (json?.jobs as Array<Record<string, unknown>> | undefined) ?? [];
    for (const job of jobs) {
      if (job.kind === "dm") {
        this.push({ channel: this.dmChannel(String(job.phone)), kind: "out", from: "platform", text: String(job.text ?? ""), meta: { purpose: job.purpose } });
      } else {
        this.info(`platform job ${String(job.kind)}: ${JSON.stringify(job).slice(0, 200)}`);
      }
      await this.post("/api/whatsapp/platform-jobs", { id: job.id, outcome: "sent", waMessageId: this.nextId("pj") });
    }
  }

  private async cron(p: string): Promise<void> {
    const res = await this.request.get(p, {
      headers: { authorization: `Bearer ${E2E.CRON_SECRET}`, "x-test-now": this.now.toISOString() },
      timeout: 120_000,
    });
    if (!res.ok()) this.error(`cron ${p} → ${res.status()} ${(await res.text()).slice(0, 200)}`);
    else if (p.includes("generate-teams")) this.info(`cron ${p}: ${(await res.text()).slice(0, 200)}`);
  }

  // ── Database state ──────────────────────────────────────────────────

  async readState(): Promise<Record<string, string>> {
    if (!this.orgId) return {};
    const out: Record<string, string> = {};
    const org = await this.db.one<Record<string, unknown>>(
      `SELECT "approvalStatus", "setupStage", "whatsappBotEnabled", "adminGroupSubject", "listAnnouncer", "rollingSquadEnabled", "teamsReadyTime"
       FROM "Organisation" WHERE id = $1`,
      [this.orgId],
    );
    if (org) {
      out["club: approval"] = String(org.approvalStatus);
      out["club: stage"] = `${String(org.setupStage)}${org.whatsappBotEnabled ? ", bot on" : ", bot off"}`;
      if (org.adminGroupSubject) out["club: admin group"] = String(org.adminGroupSubject);
    }
    const members = await this.db.all<{ name: string | null; phone: string | null; role: string }>(
      `SELECT u.name, u."phoneNumber" AS phone, m.role FROM "Membership" m JOIN "User" u ON u.id = m."userId" WHERE m."orgId" = $1 AND m."leftAt" IS NULL`,
      [this.orgId],
    );
    out["club: members"] = String(members.length);
    for (const m of members) {
      const known = m.phone ? this.byPhone.get(bare(m.phone)) : undefined;
      // Several members can have no name (WhatsApp showed only a number):
      // key those by the end of the number so they do not collapse into one.
      out[`member ${m.name ?? `(no name, …${(m.phone ?? "").slice(-4)})`}`] =`${m.role}${known ? "" : m.phone ? " (phone not in the scenario)" : " (no phone: made by MatchTime from a name)"}`;
    }
    const matches = await this.db.all<{ id: string; date: string; status: string; red: number | null; yellow: number | null }>(
      `SELECT m.id, to_char(m.date, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS date, m.status::text AS status, m."redScore" AS red, m."yellowScore" AS yellow
       FROM "Match" m JOIN "Activity" a ON a.id = m."activityId" WHERE a."orgId" = $1 ORDER BY m.date`,
      [this.orgId],
    );
    for (const mt of matches) {
      const label = `match ${formatLocal(new Date(mt.date), this.scenario.timezone)}`;
      out[`${label}: status`] = mt.status;
      if (mt.red !== null || mt.yellow !== null) out[`${label}: score`] = `${mt.red ?? "?"}-${mt.yellow ?? "?"}`;
      const att = await this.db.all<{ name: string | null; status: string; paid: boolean }>(
        `SELECT u.name, a.status::text AS status, (a."paidAt" IS NOT NULL) AS paid FROM "Attendance" a JOIN "User" u ON u.id = a."userId" WHERE a."matchId" = $1`,
        [mt.id],
      );
      for (const a of att) out[`${label}: ${a.name ?? "?"}`] = `${a.status}${a.paid ? ", paid" : ""}`;
      const teams = await this.db.all<{ name: string | null; team: string }>(
        `SELECT u.name, t.team::text AS team FROM "TeamAssignment" t JOIN "User" u ON u.id = t."userId" WHERE t."matchId" = $1`,
        [mt.id],
      );
      for (const t of teams) out[`${label}: team ${t.name ?? "?"}`] = t.team;
      const mom = await this.db.count(`SELECT count(*) FROM "MoMVote" WHERE "matchId" = $1`, [mt.id]);
      if (mom) out[`${label}: MoM votes`] = String(mom);
      const ratings = await this.db.count(`SELECT count(*) FROM "Rating" WHERE "matchId" = $1`, [mt.id]);
      if (ratings) out[`${label}: ratings`] = String(ratings);
    }
    return out;
  }

  private async recordDbChanges(): Promise<void> {
    const next = await this.readState();
    const lines = diffSnapshots(this.snapshot, next);
    this.snapshot = next;
    if (lines.length) this.push({ channel: { system: true }, kind: "db", text: lines.join("\n") });
  }

  jidOf(groupKey: string): string {
    return this.jid.get(groupKey)!;
  }
}
