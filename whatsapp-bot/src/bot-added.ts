/**
 * "The bot itself was just ADDED to a group": detection and the one
 * server call that starts a self-setup.
 *
 * whatsapp-web.js 1.34.7 emits `group_join` from the page's Msg 'add'
 * listener for every `gp2` message whose subtype is add / invite /
 * linked_group_join (src/Client.js:593-602), including the "you were
 * added" message the bot receives about itself. That part has not
 * changed. What HAS changed is identity: groups now address members by
 * `@lid` (`groupMetadata.isLidAddressingMode`), so the recipient the
 * notification names for the bot can be the bot's LID while
 * `client.info.wid` is its phone-number JID (`getMaybeMePnUser() ||
 * getMaybeMeLidUser()`, Client.js:349-364). A comparison against the
 * phone JID alone would then never match and self-setup would never
 * start. So the bot resolves BOTH of its ids once (`resolveSelfIds`)
 * and matches either; and every recipient is read as a string or an
 * object with `_serialized`, since the page's serialised model can
 * carry either.
 *
 * Everything the handler touches on the WhatsApp side is injected, so
 * the flow is unit-tested against a fake client whose page calls throw
 * the way the live build does.
 */
import type { GroupSnapshot, GroupSummary, WaDriver } from "./driver.js";

/** Recipient ids as strings, whatever shape the page handed over. */
export function normaliseRecipientIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r === "string" && r.length > 0) out.push(r);
    else if (r && typeof r === "object") {
      const s = (r as { _serialized?: unknown })._serialized;
      if (typeof s === "string" && s.length > 0) out.push(s);
    }
  }
  return out;
}

/** Was the bot among the recipients, by any of its ids? */
export function isSelfAdd(recipientIds: string[], selfIds: string[]): boolean {
  if (selfIds.length === 0) return false;
  const self = new Set(selfIds);
  return recipientIds.some((r) => self.has(r));
}

/**
 * `resolveSelfIds` and its page function MOVED to `src/drivers/wwebjs.ts`
 * in Phase 2 of the Baileys migration
 * (`MDs/baileys-migration-plan-2026-09-21.md`), where they are the
 * driver's `selfIds()`. They were pure whatsapp-web.js: `client.info.wid`
 * and a `pupPage.evaluate` of `WAWebUserPrefsMeUser`. The RULE they serve,
 * which is to match the bot by ANY of its ids because groups are
 * `@lid`-addressed now, is `isSelfAdd` above: it stayed here, where it is
 * tested.
 */

// ── The handler ────────────────────────────────────────────────────────

export interface GroupJoinNotification {
  chatId?: string;
  recipientIds?: unknown;
  author?: string;
  /** Bare LID digits the author was addressed by (Baileys only). */
  authorLid?: string;
}

export interface HistoryMessageForServer {
  author: string;
  authorPhone: string | null;
  text: string;
  timestamp: string;
}

export interface BotAddedDeps {
  driver: WaDriver;
  isMonitoredGroup: (gid: string) => boolean;
  addMonitoredGroup: (gid: string) => void;
  addOnboardingGroup: (gid: string) => void;
  /** Self-join slice 1: a silent group never gets a post from here, even
   *  if a server hands back an intro. Optional so an older wiring still
   *  compiles; absent means nothing is silent. */
  isSilentGroup?: (gid: string) => boolean;
  /** Self-join slice 6: the server answered `silent: true` (a club waiting
   *  for approval, a group nobody asked MatchTime into). Treat the group as
   *  silent now, not at the next /orgs refresh. */
  addSilentGroup?: (gid: string) => void;
  /**
   * F2 (2026-10-05): the bot was added to a group it MONITORS. Re-read the
   * server's /orgs once (rate-limited, `requestStaleGroupRecheck` in
   * org-refresh.ts) so a club deleted or unlinked since the last refresh
   * is no longer treated as a club. The handler re-reads
   * `isMonitoredGroup` afterwards. Optional: absent, a monitored group is
   * left alone exactly as before.
   */
  recheckMonitoredGroup?: (gid: string) => Promise<unknown>;
  resolveSelfIds: () => Promise<string[]>;
  readGroupSnapshot: (gid: string, selfIds: string[]) => Promise<GroupSnapshot>;
  /** Recent messages, oldest first, already shaped for the server; [] on failure. */
  fetchHistory: (gid: string, selfIds: string[]) => Promise<HistoryMessageForServer[]>;
  postBotAdded: (params: {
    groupId: string;
    groupSubject?: string | null;
    addedByPhone?: string | null;
    /** Self-join slice 6: bare LID digits of the adder. */
    addedByLid?: string | null;
    participants?: Array<{ phone?: string | null; lidId?: string | null; pushname?: string | null }>;
    enrichmentHistory?: HistoryMessageForServer[];
    /** Self-join slice 6: found by the reconnect sweep, not by an add event. */
    discovered?: boolean;
  }) => Promise<BotAddedResponse | null>;
  log?: (line: string) => void;
  error?: (line: string, err?: unknown) => void;
}

/** What the server answers. `silent` and `selfJoin` come from a server
 *  with self-join on; an older server never sends them. */
export interface BotAddedResponse {
  introText?: string | null;
  ignored?: string;
  existing?: boolean;
  language?: string;
  silent?: boolean;
  selfJoin?: string;
}

export type BotAddedOutcome =
  | { kind: "not-self-add" }
  | { kind: "already-monitored" }
  | { kind: "posted"; language: string | null; snapshot: GroupSnapshot; historyCount: number }
  | { kind: "silent"; reason: string };

/**
 * Handle one `group_join`. Returns what happened so index.ts can log it
 * in one line; never throws (a failure here must not take the
 * human-join path down with it).
 */
export async function handleGroupJoinForSelfAdd(
  deps: BotAddedDeps,
  notification: GroupJoinNotification,
): Promise<BotAddedOutcome> {
  const log = deps.log ?? ((l) => console.log(l));
  const error = deps.error ?? ((l, e) => console.error(l, e));
  const gid = notification.chatId;
  if (!gid) return { kind: "not-self-add" };

  const recipients = normaliseRecipientIds(notification.recipientIds);
  const selfIds = await deps.resolveSelfIds();
  // Logged for every join, so the live test can see the comparison even
  // when it fails: the group JID, who was added, and who the bot is.
  log(
    `[group_join] ${gid}: recipients=[${recipients.join(", ")}] self=[${selfIds.join(", ")}] ` +
      `author=${notification.author ?? "?"}`,
  );
  if (!isSelfAdd(recipients, selfIds)) return { kind: "not-self-add" };
  if (deps.isMonitoredGroup(gid)) {
    // F2: the monitored set is only as fresh as the last /orgs refresh, so
    // a club deleted or unlinked a minute ago is still "a club" here. Ask
    // the server once before deciding. A live club (Sutton FC) is still
    // listed afterwards and stops here as before; a failed or skipped
    // refresh changes no set, so it stops here as before too.
    if (!deps.recheckMonitoredGroup) return { kind: "already-monitored" };
    log(`[bot-added] ${gid}: re-added to a group listed as a club; re-checking the club list with the server`);
    let recheck: unknown;
    try {
      recheck = await deps.recheckMonitoredGroup(gid);
    } catch (err) {
      recheck = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (deps.isMonitoredGroup(gid)) {
      log(`[bot-added] ${gid}: still a club after the re-check (${String(recheck ?? "done")}); nothing to do`);
      return { kind: "already-monitored" };
    }
    log(`[bot-added] ${gid}: no longer a club after the re-check; handling it as a new add`);
  }

  log(`[bot-added] self-add detected in ${gid} (author=${notification.author ?? "?"})`);

  // Subject + participants, without getChatModel.
  let snapshot: GroupSnapshot = { subject: null, participants: [], source: "none", notes: [] };
  try {
    snapshot = await deps.readGroupSnapshot(gid, selfIds);
  } catch (err) {
    snapshot.notes.push(`snapshot threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  log(
    `[bot-added] ${gid} snapshot via ${snapshot.source}: subject=${snapshot.subject ? JSON.stringify(snapshot.subject) : "none"}, ` +
      `participants=${snapshot.participants.length}` +
      (snapshot.notes.length ? ` (${snapshot.notes.join("; ")})` : ""),
  );

  // The adder: phone and LID. Resolved AFTER the snapshot on purpose: its
  // groupMetadata read seeds every participant's LID-to-phone pair, so a
  // LID author the event could not map may map now (plan 2.3).
  const adder = await resolveAdder(deps.driver, notification);
  const { addedByPhone, addedByLid } = adder;
  log(
    `[bot-added] ${gid} adder: phone=${addedByPhone ?? "-"} lid=${addedByLid ?? "-"} via=${adder.via} ` +
      `(event author=${notification.author ?? "?"})`,
  );

  // Recent history: the language evidence and the enrichment source.
  let history: HistoryMessageForServer[] = [];
  try {
    history = await deps.fetchHistory(gid, selfIds);
  } catch (err) {
    error(`[bot-added] ${gid} history capture failed:`, err);
  }
  log(`[bot-added] ${gid} history: ${history.length} message(s) captured`);

  let res: Awaited<ReturnType<BotAddedDeps["postBotAdded"]>> = null;
  try {
    res = await deps.postBotAdded({
      groupId: gid,
      groupSubject: snapshot.subject,
      addedByPhone,
      addedByLid,
      participants: snapshot.participants.map((p) => ({
        phone: p.phone ?? null,
        lidId: p.lidId ?? null,
        pushname: p.pushname ?? null,
      })),
      enrichmentHistory: history.length > 0 ? history : undefined,
    });
  } catch (err) {
    error(`[bot-added] ${gid} server call failed:`, err);
    return { kind: "silent", reason: "server-call-failed" };
  }

  if (res?.silent) deps.addSilentGroup?.(gid);

  if (!res?.introText) {
    const reason = res?.ignored ?? (res?.existing ? "existing-session-mid-flow" : "no-intro");
    log(`[bot-added] server says stay silent for ${gid} (${reason})`);
    return { kind: "silent", reason };
  }

  // The server already refuses a silent group; this is the Pi's own lock
  // on the same door, for a server that got it wrong.
  if (deps.isSilentGroup?.(gid)) {
    log(`[bot-added] ${gid} is a silent group; not posting the intro the server returned`);
    return { kind: "silent", reason: "silent-group" };
  }

  // Monitored AND onboarding before the send, so a reply that races the
  // intro is still buffered and flushed at once.
  deps.addMonitoredGroup(gid);
  deps.addOnboardingGroup(gid);
  try {
    await deps.driver.sendText(gid, res.introText);
    log(
      `[bot-added] intro posted in ${gid} ("${snapshot.subject ?? "?"}", language=${res.language ?? "?"}) — now monitoring`,
    );
  } catch (err) {
    error(`[bot-added] ${gid} intro send failed (group stays monitored; the server re-sends on re-add):`, err);
  }
  return { kind: "posted", language: res.language ?? null, snapshot, historyCount: history.length };
}

// ── Self-join slice 6: who added MatchTime ────────────────────────────

/**
 * The adder's phone and LID, from the event and, for a LID the event could
 * not map, from the driver's LOCAL knowledge (`getContact`, which on
 * Baileys reads the harvested directory and Baileys' own store, never the
 * network). Call it after the group snapshot, which seeds that store.
 * Total: never throws.
 */
export async function resolveAdder(
  driver: WaDriver,
  notification: Pick<GroupJoinNotification, "author" | "authorLid">,
): Promise<{ addedByPhone?: string; addedByLid?: string; via: "event" | "re-resolve" | "none" }> {
  const author = notification.author;
  let lid: string | undefined =
    typeof notification.authorLid === "string" && /^\d{6,20}$/.test(notification.authorLid)
      ? notification.authorLid
      : undefined;
  if (!lid && author?.endsWith("@lid")) {
    const m = /^(\d{6,20})(?::\d+)?@lid$/.exec(author);
    if (m) lid = m[1];
  }
  const withLid = <T extends object>(o: T) => (lid ? { ...o, addedByLid: lid } : o);

  if (author?.endsWith("@c.us")) {
    const phone = author.replace("@c.us", "").replace(/^\+/, "");
    if (/^\d{8,15}$/.test(phone)) return withLid({ addedByPhone: phone, via: "event" as const });
  }
  if (lid) {
    try {
      const contact = await driver.getContact(`${lid}@lid`);
      const num = (contact as { number?: unknown } | null)?.number;
      const phone = typeof num === "string" ? num.replace(/\D/g, "") : "";
      if (/^\d{8,15}$/.test(phone)) return withLid({ addedByPhone: phone, via: "re-resolve" as const });
    } catch {
      /* unknown adder: the server labels it so for the owner */
    }
  }
  return withLid({ via: "none" as const });
}

// ── Self-join slice 6: MatchTime removed from a silent group ──────────

export interface SelfRemovalDeps {
  isSilentGroup: (gid: string) => boolean;
  resolveSelfIds: () => Promise<string[]>;
  /** Only awaited here: what the server answered does not matter for a
   *  silent or admin group. */
  postBotRemoved: (params: { groupId: string }) => Promise<unknown>;
  log?: (line: string) => void;
}

/**
 * A `group_leave` in a SILENT group that removed MatchTime itself: tell
 * the server (a pending club goes back to draft, an unsolicited group is
 * marked left). Anything else returns without a call, so a live club's
 * group never reaches here. Never throws.
 */
export async function handleGroupLeaveForSelfRemoval(
  deps: SelfRemovalDeps,
  notification: GroupJoinNotification,
): Promise<"not-silent" | "not-self" | "forwarded" | "failed"> {
  const log = deps.log ?? ((l) => console.log(l));
  const gid = notification.chatId;
  if (!gid || !deps.isSilentGroup(gid)) return "not-silent";
  try {
    const selfIds = await deps.resolveSelfIds();
    if (!isSelfAdd(normaliseRecipientIds(notification.recipientIds), selfIds)) return "not-self";
    await deps.postBotRemoved({ groupId: gid });
    log(`[bot-removed] MatchTime removed from silent group ${gid}; server told`);
    return "forwarded";
  } catch (err) {
    log(`[bot-removed] ${gid}: could not tell the server: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

// ── Club fee billing, slice B5: MatchTime removed from a LIVE group ───

/** What /api/whatsapp/bot-removed answers about a live club's group. A
 *  server built before B5 sends no `billing`. */
export interface BotRemovedResponse {
  ok?: boolean;
  /** "paused" | "already-paused": the club is paused for the club fee.
   *  Anything else ("exempt", "flag-off", "not-billed", "paused-other"):
   *  only logged, nothing changed. */
  billing?: string;
  orgId?: string;
}

export interface MonitoredSelfRemovalDeps {
  isMonitoredGroup: (gid: string) => boolean;
  resolveSelfIds: () => Promise<string[]>;
  /** The server's answer, or null when the post failed. */
  postBotRemoved: (params: { groupId: string }) => Promise<BotRemovedResponse | null>;
  /** The server paused the club: stop monitoring the group locally. */
  stopMonitoringGroup: (gid: string) => void;
  log?: (line: string) => void;
}

export type MonitoredSelfRemovalOutcome = "not-monitored" | "not-self" | "own-leave" | "forwarded" | "paused" | "failed";

/** Did MatchTime leave by itself (a leave job), rather than get removed?
 *  WhatsApp names the leaver as the author of their own leave. */
function isOwnLeave(notification: GroupJoinNotification, selfIds: string[]): boolean {
  const self = new Set(selfIds);
  if (notification.author && self.has(notification.author)) return true;
  if (notification.authorLid && self.has(`${notification.authorLid}@lid`)) return true;
  return false;
}

/**
 * A `group_leave` in a MONITORED group (a live club's, Sutton FC's
 * included) that removed MatchTime ITSELF: tell the server, which pauses
 * a club paying the club fee and only logs anything else (plan 4.2, slice
 * B5). The leave event is Baileys' `group-participants.update` with
 * `action: "remove"`, mapped by `membershipEvent` (baileys/groups.ts):
 * `recipientIds` are the REMOVED participants, in phone form when known,
 * else their LID; `author` is whoever removed them.
 *
 * Safety: forwarded ONLY when one of the removed participants is the bot
 * by one of its own ids (`isSelfAdd`, the same check as a self-add; with
 * no ids known nothing matches), and NOT when the bot itself is the
 * author (MatchTime leaving by its own leave job is not a removal). A
 * player leaving or being removed never gets here as a removal. Never
 * throws.
 */
export async function handleMonitoredGroupSelfRemoval(
  deps: MonitoredSelfRemovalDeps,
  notification: GroupJoinNotification,
): Promise<MonitoredSelfRemovalOutcome> {
  const log = deps.log ?? ((l) => console.log(l));
  const gid = notification.chatId;
  if (!gid || !deps.isMonitoredGroup(gid)) return "not-monitored";
  try {
    const selfIds = await deps.resolveSelfIds();
    if (!isSelfAdd(normaliseRecipientIds(notification.recipientIds), selfIds)) return "not-self";
    if (isOwnLeave(notification, selfIds)) {
      log(`[bot-removed] MatchTime left live group ${gid} by itself; not a removal, server not told`);
      return "own-leave";
    }
    const res = await deps.postBotRemoved({ groupId: gid });
    if (!res) {
      log(`[bot-removed] ${gid}: could not tell the server MatchTime was removed from a live group`);
      return "failed";
    }
    if (res.billing === "paused" || res.billing === "already-paused") {
      deps.stopMonitoringGroup(gid);
      log(`[bot-removed] MatchTime removed from live group ${gid} (author=${notification.author ?? "?"}); club fee paused (${res.billing}), no longer monitored`);
      return "paused";
    }
    log(`[bot-removed] MatchTime removed from live group ${gid} (author=${notification.author ?? "?"}); server logged it (${res.billing ?? "no billing answer"})`);
    return "forwarded";
  } catch (err) {
    log(`[bot-removed] ${gid}: could not tell the server: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

// ── Self-join slice 6: the reconnect sweep (plan 8) ───────────────────

/** Groups read per reconnect, at most: each costs one groupMetadata call. */
export const SWEEP_MAX_GROUPS = 10;

export interface SweepDeps {
  listGroups: () => Promise<GroupSummary[]>;
  /** From /orgs `selfJoinSweep.knownGroups`: never read. */
  knownGroups: ReadonlySet<string>;
  isMonitoredGroup: (gid: string) => boolean;
  isSilentGroup: (gid: string) => boolean;
  addSilentGroup: (gid: string) => void;
  resolveSelfIds: () => Promise<string[]>;
  readGroupSnapshot: (gid: string, selfIds: string[]) => Promise<GroupSnapshot>;
  postBotAdded: BotAddedDeps["postBotAdded"];
  /** This process's memory of groups already settled by a sweep. */
  alreadySwept: Set<string>;
  limit?: number;
  log?: (line: string) => void;
  error?: (line: string, err?: unknown) => void;
}

/**
 * After a reconnect, while some organiser is waiting for their add: post
 * every group this account is in that the server does not know to
 * bot-added with `discovered: true`, so an add made while the Pi was
 * offline is still linked. NEVER sends anything to a group, whatever the
 * server answers. Never throws.
 */
export async function sweepForMissedSelfAdds(deps: SweepDeps): Promise<{ checked: number; linked: number }> {
  const log = deps.log ?? ((l) => console.log(l));
  const error = deps.error ?? ((l, e) => console.error(l, e));
  let groups: GroupSummary[];
  try {
    groups = await deps.listGroups();
  } catch (err) {
    error("[self-join-sweep] could not list groups; no sweep this time:", err);
    return { checked: 0, linked: 0 };
  }
  const unknown = groups.filter(
    (g) =>
      !deps.knownGroups.has(g.id) &&
      !deps.isMonitoredGroup(g.id) &&
      !deps.isSilentGroup(g.id) &&
      !deps.alreadySwept.has(g.id),
  );
  const todo = unknown.slice(0, deps.limit ?? SWEEP_MAX_GROUPS);
  let checked = 0;
  let linked = 0;
  if (todo.length === 0) return { checked, linked };
  const selfIds = await deps.resolveSelfIds().catch(() => [] as string[]);
  for (const g of todo) {
    let snapshot: GroupSnapshot;
    try {
      snapshot = await deps.readGroupSnapshot(g.id, selfIds);
    } catch (err) {
      error(`[self-join-sweep] ${g.id} snapshot failed:`, err);
      continue;
    }
    let res: BotAddedResponse | null = null;
    try {
      res = await deps.postBotAdded({
        groupId: g.id,
        groupSubject: snapshot.subject ?? (g.name || null),
        participants: snapshot.participants.map((p) => ({
          phone: p.phone ?? null,
          lidId: p.lidId ?? null,
          pushname: p.pushname ?? null,
        })),
        discovered: true,
      });
    } catch (err) {
      error(`[self-join-sweep] ${g.id} server call failed:`, err);
      continue;
    }
    checked++;
    if (!res) continue;
    if (res.silent) deps.addSilentGroup(g.id);
    if (res.selfJoin === "linked") linked++;
    // A group that matched nothing is looked at again next time: the
    // organiser it belongs to may not have sent their DM yet.
    if (res.ignored !== "discovered-no-match") deps.alreadySwept.add(g.id);
    log(`[self-join-sweep] ${g.id} ("${snapshot.subject ?? g.name}"): ${res.selfJoin ?? res.ignored ?? "?"}`);
  }
  log(`[self-join-sweep] ${unknown.length} unknown group(s), ${checked} checked, ${linked} linked`);
  return { checked, linked };
}
