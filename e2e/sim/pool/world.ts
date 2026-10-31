/**
 * THE POOL SCENARIO DSL, I/O HALF (2026-10-24, slice L1).
 *
 * A sandboxed WhatsApp world for the local player pool: clubs (built by the
 * group simulator's own `createGroup`, not a copy of it), their admin groups
 * (HQ), their members, and STRANGERS (numbers MatchTime has never seen).
 * A scenario plays one real-life conversation through the real routes and
 * asserts exactly what MatchTime queued, to whom, and what the database
 * holds:
 *
 *   const fnf = await pool.club("fnf", { hq: true });
 *   const ali = await pool.stranger("ali", { name: "Ali Kaya" });
 *
 *   const ex = await ali.dm("Hi MatchTime, sign me up to play. Code K7QP2");
 *   pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-welcome", text: /signed up/ }]);
 *   pool.expectNoLeaks(fnf.secrets(), { to: ["ali"] });
 *   expect(await pool.profileOf(ali)).toMatchObject({ status: "active" });
 *
 *   await fnf.hq.say("owner", "@Match Time ask the pool for 2", { tag: true });
 *
 * Every inbound message and every queued message is written to the world's
 * transcript, which the fixture attaches to a failed scenario, so a failure
 * reads as the conversation that went wrong.
 *
 * Nothing leaves the machine: the server under test is the e2e `next dev`
 * against the embedded Postgres, and "sent" means QUEUED (BotJob,
 * PlatformJob) or returned inline for the Pi to post. `dispatchPlatform()`
 * plays the Pi's poll when a scenario needs to see what would go out now.
 *
 * MODEL: stubbed by default ($0). `pool.live` is true only under
 * MT_SIM_LIVE_LLM=1, when the server reads ANTHROPIC_API_KEY_DEV (the
 * orchestrator refuses a live run without it). `pool.arm(fn)` sets a stub
 * only in a stubbed run. See README.md.
 */
import type { APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";
import { E2E } from "../../helpers/env";
import { piBotMentioned } from "../../helpers/pi-mention";
import type { TestDb } from "../../helpers/test-db";
import { createGroup, nextMsgId, nextSimPhone, type CreateGroupOpts, type SimGroup } from "../group";
import {
  type ExpectedMessage,
  type Registry,
  type SentMessage,
  type TranscriptEvent,
  classifyBotJob,
  classifyPlatformJob,
  findLeaks,
  matchSent,
  phoneVariants,
  renderTranscript,
} from "./transcript";

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };

/** What one action did: the route's JSON and everything queued meanwhile. */
export interface Exchange {
  json: Record<string, unknown>;
  sent: SentMessage[];
  /** The inbound WhatsApp message id, for a DM. */
  messageId?: string;
}

/** What the /play form sends (`POST /api/play/signup`). Every field may be
 *  overridden; the default is a valid football sign-up near SM1. */
export interface SignUpBody {
  name: string;
  area: { kind: "district"; district: string };
  maxMiles: number;
  availability: Array<{ day: number; from: string; to: string }>;
  sports: Array<Record<string, unknown>>;
  language: "en" | "tr";
  adult: boolean;
  consent: boolean;
  source: { c?: string; src?: string; ref?: string };
}

/** The sign-up route's answer. */
export interface SignUpAnswer {
  status: number;
  ok: boolean;
  code?: string;
  prefill?: string;
  waLink?: string;
  earlyList?: boolean;
  reason?: string;
  errors?: Record<string, string>;
  /** Everything queued meanwhile: the form must send nothing to anyone. */
  sent: SentMessage[];
}

const DEFAULT_SIGNUP: SignUpBody = {
  name: "Ali Kaya",
  area: { kind: "district", district: "SM1" },
  maxMiles: 3,
  availability: [{ day: 2, from: "19:00", to: "22:00" }],
  sports: [{ sport: "football", formats: [7] }],
  language: "en",
  adult: true,
  consent: true,
  source: {},
};

export interface StrangerOpts {
  /** WhatsApp display name (pushname). Default: none. */
  name?: string;
  /** E.164. Default: a fresh fictitious number. */
  phone?: string;
}

export interface PoolClubOpts extends CreateGroupOpts {
  /** Link an admin group (HQ) to the club. Default false. */
  hq?: boolean;
  /** The pool's club settings. Every one defaults OFF/NULL, as in production. */
  pool?: Partial<{ featurePlayerPool: boolean; poolAutoAsk: boolean; playStyle: string | null; town: string | null }>;
}

/** Someone with a WhatsApp number: a stranger, or a club member. */
export class PoolPerson {
  constructor(
    private readonly world: PoolWorld,
    readonly key: string,
    readonly phone: string,
    readonly name: string | null,
  ) {}

  /** A 1-1 DM to MatchTime, through the real /api/whatsapp/dm-reply. */
  async dm(
    text: string,
    opts: {
      quote?: { id?: string; text: string; fromMatchTime?: boolean };
      headers?: Record<string, string>;
      /** The same WhatsApp message again (a Pi retry): reuse its id. */
      messageId?: string;
      /** What the Pi put on the envelope, when not just this person's phone:
       *  a LID resolved to his number (`senderLid` plus his phone), or a LID
       *  alone (`phone: ""`). */
      envelope?: { phone?: string; senderLid?: string; senderAltPhone?: string };
    } = {},
  ): Promise<Exchange> {
    this.world.log({ kind: "in", from: this.key, channel: "dm", text });
    const messageId = opts.messageId ?? nextMsgId();
    const res = await this.world.request.post("/api/whatsapp/dm-reply", {
      headers: { ...HEADERS, ...(opts.headers ?? {}) },
      data: {
        phone: opts.envelope?.phone ?? this.phone.replace(/^\+/, ""),
        ...(opts.envelope?.senderLid ? { senderLid: opts.envelope.senderLid } : {}),
        ...(opts.envelope?.senderAltPhone ? { senderAltPhone: opts.envelope.senderAltPhone } : {}),
        body: text,
        waMessageId: messageId,
        ...(this.name ? { authorName: this.name } : {}),
        ...(opts.quote
          ? { quotedMessageId: opts.quote.id ?? nextMsgId(), quotedText: opts.quote.text, quotedFromMatchTime: opts.quote.fromMatchTime ?? true }
          : {}),
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    return { json: (await res.json()) as Record<string, unknown>, sent: await this.world.collect(), messageId };
  }

  /** Every way this person's number could be written, for leak checks. */
  phoneVariants(): string[] {
    return phoneVariants(this.phone);
  }
}

/** How a message is said in HQ. */
export interface HqSayOpts {
  tag?: boolean;
  /** The Pi's real mention flag with the words left as they are (HQ answers
   *  only a real tag, 2026-10-31). Unset: as the Pi sets it from the words. */
  tagged?: boolean;
  /** The server's clock for this message (`x-test-now`, MT_TEST_MODE only). */
  now?: Date;
  /** The pool switch for this message (`x-mt-test-pool-open`); unset: the environment. */
  poolOpen?: boolean;
  /** A WhatsApp swipe-reply to this message. */
  quote?: { text: string; id?: string | null; fromMatchTime?: boolean };
}

/** A club: its players' group (a real SimGroup) and, optionally, its HQ. */
export class PoolClub {
  readonly hq: { groupId: string | null; say: (memberKey: string, text: string, opts?: HqSayOpts) => Promise<Exchange> };

  constructor(
    private readonly world: PoolWorld,
    readonly key: string,
    readonly name: string,
    readonly group: SimGroup,
    hqGroupId: string | null,
  ) {
    this.hq = {
      groupId: hqGroupId,
      say: async (memberKey, text, opts = {}) => {
        if (!hqGroupId) throw new Error(`pool: club "${key}" has no HQ; create it with { hq: true }`);
        const m = this.member(memberKey);
        const body = opts.tag && !/@match\s*time/i.test(text) ? `@Match Time ${text}` : text;
        this.world.log({ kind: "in", from: m.key, channel: "hq", text: body });
        const res = await this.world.request.post("/api/whatsapp/admin-group", {
          headers: {
            ...HEADERS,
            ...(opts.now ? { "x-test-now": opts.now.toISOString() } : {}),
            ...(opts.poolOpen === undefined ? {} : { "x-mt-test-pool-open": opts.poolOpen ? "1" : "0" }),
          },
          data: {
            channel: "admin-group",
            // The Pi's mention flag, as the real Pi sets it with its rewrite.
            botMentioned: opts.tagged ?? piBotMentioned(body, undefined) === true,
            groupId: hqGroupId,
            messageId: nextMsgId(),
            text: body,
            senderPhone: m.phone.replace(/^\+/, ""),
            timestamp: String(Math.floor((opts.now ?? new Date()).getTime() / 1000)),
            ...(opts.quote
              ? { quotedMessageId: opts.quote.id ?? null, quotedText: opts.quote.text, quotedFromMatchTime: opts.quote.fromMatchTime !== false }
              : {}),
          },
        });
        expect(res.status(), await res.text()).toBe(200);
        const json = (await res.json()) as Record<string, unknown>;
        const reply = typeof json.replyText === "string" && json.replyText.trim() ? json.replyText : null;
        return { json, sent: await this.world.collect(reply ? { channel: "hq", to: `${key}.hq`, text: reply, orgId: group.orgId } : undefined) };
      },
    };
  }

  /** A member of this club, by the roster key `createGroup` used ("owner", "pete"). */
  member(memberKey: string): PoolPerson {
    return this.world.person(`${this.key}.${memberKey}`);
  }

  /** A message in the club's players' group, through the real analyze pipeline. */
  async post(memberKey: string, text: string, opts: Parameters<SimGroup["post"]>[2] = {}): Promise<Exchange> {
    this.world.log({ kind: "in", from: `${this.key}.${memberKey}`, channel: "group", text });
    const r = await this.group.post(memberKey, text, opts);
    const reply = r.reply?.trim() ? r.reply : null;
    return {
      json: r.raw as Record<string, unknown>,
      sent: await this.world.collect(reply ? { channel: "group", to: `${this.key}.group`, text: reply, orgId: this.group.orgId } : undefined),
    };
  }

  /**
   * What a pool player must never be told about this club: its members'
   * names and numbers. Feed it to `pool.expectNoLeaks`. (The club's NAME
   * is allowed: offers name the club, decision D-3.)
   */
  secrets(): string[] {
    const out: string[] = [];
    for (const p of this.world.peopleOf(this.key)) {
      if (p.name) out.push(p.name);
      out.push(...p.phoneVariants());
    }
    return out;
  }
}

export class PoolWorld {
  readonly live: boolean;
  request: APIRequestContext;
  readonly db: TestDb;

  private readonly people = new Map<string, PoolPerson>();
  private readonly clubs = new Map<string, PoolClub>();
  private readonly seen = new Set<string>();
  private readonly events: TranscriptEvent[] = [];
  private readonly all: SentMessage[] = [];
  private startedAt = new Date();
  private visitors = Math.floor(Math.random() * 250);

  constructor(request: APIRequestContext, db: TestDb, live: boolean) {
    this.request = request;
    this.db = db;
    this.live = live;
  }

  /** Everything queued before the world existed is not this scenario's. */
  async start(): Promise<void> {
    this.startedAt = new Date(Date.now() - 1000);
    for (const r of await this.db.all<{ id: string }>(`SELECT id FROM "BotJob" UNION ALL SELECT id FROM "PlatformJob"`)) this.seen.add(r.id);
  }

  /** Re-attach the current test's request context (a world shared across serial tests). */
  attach(request: APIRequestContext): this {
    this.request = request;
    return this;
  }

  // ── Cast ─────────────────────────────────────────────────────────────

  /** A club, with its roster's members registered as `<club>.<member>`. */
  async club(key: string, opts: PoolClubOpts = {}): Promise<PoolClub> {
    if (this.clubs.has(key)) throw new Error(`pool: club "${key}" already exists`);
    const { hq, pool, ...groupOpts } = opts;
    const group = await createGroup(this.request, this.db, groupOpts);
    let hqGroupId: string | null = null;
    if (hq) {
      hqGroupId = `sim-hq-${nextMsgId()}@g.us`;
      await this.db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [group.orgId, hqGroupId]);
    }
    if (pool) {
      await this.db.run(
        `UPDATE "Organisation" SET "featurePlayerPool" = $2, "poolAutoAsk" = $3, "playStyle" = $4, town = $5 WHERE id = $1`,
        [group.orgId, pool.featurePlayerPool ?? false, pool.poolAutoAsk ?? false, pool.playStyle ?? null, pool.town ?? null],
      );
    }
    const name = (await this.db.one<{ name: string }>(`SELECT name FROM "Organisation" WHERE id = $1`, [group.orgId]))!.name;
    const c = new PoolClub(this, key, name, group, hqGroupId);
    this.clubs.set(key, c);
    const members = await this.db.all<{ id: string; name: string | null; phoneNumber: string | null }>(
      `SELECT u.id, u.name, u."phoneNumber" FROM "Membership" m JOIN "User" u ON u.id = m."userId" WHERE m."orgId" = $1`,
      [group.orgId],
    );
    for (const m of members) {
      const memberKey = group.keyOf(m.id);
      this.register(new PoolPerson(this, `${key}.${memberKey}`, m.phoneNumber ?? "", m.name), key);
    }
    return c;
  }

  /** Someone MatchTime has never seen: no User, no membership, just a number. */
  async stranger(key: string, opts: StrangerOpts = {}): Promise<PoolPerson> {
    const p = new PoolPerson(this, key, opts.phone ?? nextSimPhone(), opts.name ?? null);
    const known = await this.db.one(`SELECT id FROM "User" WHERE "phoneNumber" = $1`, [p.phone]);
    if (known) throw new Error(`pool: stranger "${key}" has a number MatchTime already knows (${p.phone})`);
    this.register(p, null);
    return p;
  }

  person(key: string): PoolPerson {
    const p = this.people.get(key);
    if (!p) throw new Error(`pool: unknown person "${key}" (known: ${[...this.people.keys()].join(", ")})`);
    return p;
  }

  private readonly clubOfPerson = new Map<string, string | null>();

  private register(p: PoolPerson, clubKey: string | null): void {
    if (this.people.has(p.key)) throw new Error(`pool: person "${p.key}" already exists`);
    this.people.set(p.key, p);
    this.clubOfPerson.set(p.key, clubKey);
  }

  /** The people registered as members of a club. */
  peopleOf(clubKey: string): PoolPerson[] {
    return [...this.people.values()].filter((p) => this.clubOfPerson.get(p.key) === clubKey);
  }

  private registry(): Registry {
    const people = new Map<string, string>();
    for (const p of this.people.values()) if (p.phone) people.set(p.phone.replace(/\D/g, ""), p.key);
    const clubs = new Map<string, string>();
    for (const c of this.clubs.values()) clubs.set(c.group.orgId, c.key);
    return { people, clubs };
  }

  // ── What MatchTime queued ────────────────────────────────────────────

  /** @internal Write an inbound message to the transcript. */
  log(e: TranscriptEvent): void {
    this.events.push(e);
  }

  /** A line of commentary in the transcript ("now the cut-off passes"). */
  note(text: string): void {
    this.events.push({ kind: "note", text });
  }

  /**
   * Everything queued since the last collect, in the order it was queued,
   * plus an inline reply the route returned for the Pi to post.
   */
  async collect(inline?: { channel: "group" | "hq"; to: string; text: string; orgId: string }): Promise<SentMessage[]> {
    const reg = this.registry();
    const bot = await this.db.all<{ id: string; orgId: string; kind: string; phone: string | null; text: string; sendAfter: Date | null; createdAt: Date }>(
      `SELECT id, "orgId", kind, phone, text, "sendAfter", "createdAt" FROM "BotJob" WHERE "createdAt" >= $1`,
      [this.startedAt],
    );
    const plat = await this.db.all<{ id: string; kind: string; phone: string | null; groupId: string | null; text: string | null; purpose: string; sendAfter: Date | null; createdAt: Date }>(
      `SELECT id, kind, phone, "groupId", text, purpose, "sendAfter", "createdAt" FROM "PlatformJob" WHERE "createdAt" >= $1`,
      [this.startedAt],
    );
    const fresh = [
      ...bot.filter((r) => !this.seen.has(r.id)).map((r) => ({ at: r.createdAt.getTime(), m: classifyBotJob(r, reg) })),
      ...plat.filter((r) => !this.seen.has(r.id)).map((r) => ({ at: r.createdAt.getTime(), m: classifyPlatformJob(r, reg) })),
    ]
      .sort((a, b) => a.at - b.at || a.m.id.localeCompare(b.m.id))
      .map((x) => x.m);
    for (const m of fresh) this.seen.add(m.id);
    if (inline) fresh.unshift({ id: `inline-${nextMsgId()}`, ...inline, via: "inline-reply", purpose: null, sendAfter: null });
    for (const m of fresh) this.events.push({ kind: "out", message: m });
    this.all.push(...fresh);
    return fresh;
  }

  /** Everything this world has queued so far. */
  get sent(): readonly SentMessage[] {
    return this.all;
  }

  /**
   * The Pi's platform poll, now: claims every due PlatformJob and returns
   * them as messages. What a quiet-hours or wave scenario asserts "goes out
   * now" against. (No test clock on this endpoint yet: the slice that
   * holds pool DMs adds an `x-test-now` seam there, as due-posts has.)
   */
  async dispatchPlatform(): Promise<SentMessage[]> {
    const res = await this.request.get("/api/whatsapp/platform-jobs", { headers: HEADERS });
    expect(res.status(), await res.text()).toBe(200);
    const { jobs } = (await res.json()) as { jobs: Array<{ id: string; kind: string; phone?: string | null; groupId?: string | null; text?: string | null; purpose?: string }> };
    const reg = this.registry();
    return jobs.map((j) =>
      classifyPlatformJob({ id: j.id, kind: j.kind, phone: j.phone ?? null, groupId: j.groupId ?? null, text: j.text ?? null, purpose: j.purpose ?? "?", sendAfter: null }, reg),
    );
  }

  // ── The /play form ───────────────────────────────────────────────────

  /**
   * Fill in /play and submit it, through the very route the page posts to
   * (`POST /api/play/signup`). Nobody's number is involved: the page never
   * asks for one. `poolOpen` sets the pool's open/closed test seam (the
   * default, like production today, is closed: the early sign-up list).
   */
  async signUp(body: Partial<SignUpBody> = {}, opts: { poolOpen?: boolean; ip?: string } = {}): Promise<SignUpAnswer> {
    const data = { ...DEFAULT_SIGNUP, ...body };
    this.note(`(someone fills in /play: ${data.name}, ${data.language}${opts.poolOpen ? ", pool open" : ""})`);
    // Each visitor has his own address unless the scenario says otherwise
    // (the per-address cap is a scenario of its own).
    const ip = opts.ip ?? `198.51.100.${(this.visitors = (this.visitors % 250) + 1)}`;
    const res = await this.request.post("/api/play/signup", {
      headers: { "x-forwarded-for": ip, ...(opts.poolOpen === undefined ? {} : { "x-mt-test-pool-open": opts.poolOpen ? "1" : "0" }) },
      data,
    });
    const json = (await res.json()) as Omit<SignUpAnswer, "status" | "sent">;
    return { ...json, status: res.status(), sent: await this.collect() };
  }

  /** A waiting sign-up, by its code (plain SQL). */
  pendingByCode(code: string): Promise<Record<string, unknown> | null> {
    return this.db.one(`SELECT * FROM "PoolProfile" WHERE "confirmCode" = $1`, [code]);
  }

  /** How many /play codes from this person's number did not work. */
  failedAttempts(p: PoolPerson): Promise<number> {
    return this.db.count(`SELECT count(*) FROM "PoolAttempt" WHERE kind = 'confirm' AND key = $1`, [p.phone.replace(/^\+/, "")]);
  }

  /** The append-only consent record for a user id, oldest first. */
  consentRecords(userId: string): Promise<Array<{ action: string; channel: string }>> {
    return this.db.all(`SELECT action, channel FROM "PoolConsentRecord" WHERE "userId" = $1 ORDER BY "createdAt", id`, [userId]);
  }

  // ── Assertions ───────────────────────────────────────────────────────

  /** Exactly these messages, in this order (`[]`: nothing at all). */
  expectSent(actual: readonly SentMessage[], expected: readonly ExpectedMessage[]): void {
    const problems = matchSent(actual, expected);
    expect(problems, `\n${problems.join("\n")}\n\n--- transcript ---\n${this.transcript()}\n`).toEqual([]);
  }

  /** No message (to `opts.to`, when given) carries a forbidden term. */
  expectNoLeaks(forbidden: readonly string[], opts: { to?: readonly string[]; in?: readonly SentMessage[] } = {}): void {
    const leaks = findLeaks(opts.in ?? this.all, forbidden, opts);
    expect(leaks, `\n--- transcript ---\n${this.transcript()}\n`).toEqual([]);
  }

  transcript(): string {
    return renderTranscript(this.events);
  }

  // ── Model ────────────────────────────────────────────────────────────

  /** Arm a stub (helpers/stub.ts) for this scenario; skipped in a live run,
   *  where the real model answers instead. */
  arm(fn: () => void): void {
    if (!this.live) fn();
  }

  // ── Database probes (plain SQL; e2e code is outside the src/ guard) ───

  /** The User row a number belongs to, or null. */
  userOf(p: PoolPerson): Promise<{ id: string; name: string | null } | null> {
    return this.db.one(`SELECT id, name FROM "User" WHERE "phoneNumber" = $1`, [p.phone]);
  }

  /** The person's pool profile, or null. */
  async profileOf(p: PoolPerson): Promise<Record<string, unknown> | null> {
    const u = await this.userOf(p);
    return u ? this.db.one(`SELECT * FROM "PoolProfile" WHERE "userId" = $1`, [u.id]) : null;
  }

  /** Rows in the pool's tables, for "nothing was written" checks. */
  async poolRowCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of ["PoolProfile", "PoolAsk", "PoolOffer", "PoolBlock", "GuestPlace", "ClubInvitation", "PoolAttempt", "PoolConsentRecord"]) {
      out[t] = await this.db.count(`SELECT count(*) FROM "${t}"`);
    }
    return out;
  }
}
