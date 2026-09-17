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
import type { Client } from "whatsapp-web.js";
import type { GroupSnapshot } from "./group-snapshot.js";

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
 * The bot's own ids: the phone JID from `client.info.wid` and, when the
 * page can say, its LID. Read once per process; both reads are guarded
 * because on a broken build `client.info` can be a throwing getter.
 */
let cachedSelfIds: string[] | null = null;
export async function resolveSelfIds(client: Client): Promise<string[]> {
  if (cachedSelfIds && cachedSelfIds.length > 0) return cachedSelfIds;
  const ids = new Set<string>();
  try {
    const wid = client.info?.wid?._serialized;
    if (typeof wid === "string" && wid) ids.add(wid);
  } catch {
    /* throwing getter on a broken build */
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = (client as any).pupPage as { evaluate: (fn: unknown) => Promise<unknown> } | undefined;
    if (page) {
      const res = (await page.evaluate(readMeIdsInPage)) as { pn: string | null; lid: string | null } | null;
      if (res?.pn) ids.add(res.pn);
      if (res?.lid) ids.add(res.lid);
    }
  } catch {
    /* the phone JID alone is still a valid match on a pn-addressed group */
  }
  cachedSelfIds = [...ids];
  return cachedSelfIds;
}

/** Runs in the page. */
function readMeIdsInPage(): { pn: string | null; lid: string | null } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (globalThis as any).window;
    const me = w.require("WAWebUserPrefsMeUser");
    const pn = me.getMaybeMePnUser?.();
    const lid = me.getMaybeMeLidUser?.();
    return { pn: pn?._serialized ?? null, lid: lid?._serialized ?? null };
  } catch {
    return { pn: null, lid: null };
  }
}

export function _test_resetSelfIds(): void {
  cachedSelfIds = null;
}

// ── The handler ────────────────────────────────────────────────────────

export interface GroupJoinNotification {
  chatId?: string;
  recipientIds?: unknown;
  author?: string;
}

export interface HistoryMessageForServer {
  author: string;
  authorPhone: string | null;
  text: string;
  timestamp: string;
}

export interface BotAddedDeps {
  client: Client;
  isMonitoredGroup: (gid: string) => boolean;
  addMonitoredGroup: (gid: string) => void;
  addOnboardingGroup: (gid: string) => void;
  resolveSelfIds: (client: Client) => Promise<string[]>;
  readGroupSnapshot: (client: Client, gid: string, selfIds: string[]) => Promise<GroupSnapshot>;
  /** Recent messages, oldest first, already shaped for the server; [] on failure. */
  fetchHistory: (client: Client, gid: string, selfIds: string[]) => Promise<HistoryMessageForServer[]>;
  postBotAdded: (params: {
    groupId: string;
    groupSubject?: string | null;
    addedByPhone?: string | null;
    participants?: Array<{ phone?: string | null; lidId?: string | null; pushname?: string | null }>;
    enrichmentHistory?: HistoryMessageForServer[];
  }) => Promise<{ introText?: string | null; ignored?: string; existing?: boolean; language?: string } | null>;
  log?: (line: string) => void;
  error?: (line: string, err?: unknown) => void;
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
  const selfIds = await deps.resolveSelfIds(deps.client);
  // Logged for every join, so the live test can see the comparison even
  // when it fails: the group JID, who was added, and who the bot is.
  log(
    `[group_join] ${gid}: recipients=[${recipients.join(", ")}] self=[${selfIds.join(", ")}] ` +
      `author=${notification.author ?? "?"}`,
  );
  if (!isSelfAdd(recipients, selfIds)) return { kind: "not-self-add" };
  if (deps.isMonitoredGroup(gid)) return { kind: "already-monitored" };

  log(`[bot-added] self-add detected in ${gid} (author=${notification.author ?? "?"})`);

  // Subject + participants, without getChatModel.
  let snapshot: GroupSnapshot = { subject: null, participants: [], source: "none", notes: [] };
  try {
    snapshot = await deps.readGroupSnapshot(deps.client, gid, selfIds);
  } catch (err) {
    snapshot.notes.push(`snapshot threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  log(
    `[bot-added] ${gid} snapshot via ${snapshot.source}: subject=${snapshot.subject ? JSON.stringify(snapshot.subject) : "none"}, ` +
      `participants=${snapshot.participants.length}` +
      (snapshot.notes.length ? ` (${snapshot.notes.join("; ")})` : ""),
  );

  // The adder's JID → phone. @lid adders: try the contact record.
  let addedByPhone: string | undefined;
  const author = notification.author;
  if (author?.endsWith("@c.us")) {
    addedByPhone = author.replace("@c.us", "").replace(/^\+/, "");
  } else if (author?.endsWith("@lid")) {
    try {
      const contact = await deps.client.getContactById(author);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const num = (contact as any)?.number;
      if (typeof num === "string" && num.length > 0) addedByPhone = num.replace(/\D/g, "");
    } catch {
      /* the server falls back to the consent replier */
    }
  }

  // Recent history: the language evidence and the enrichment source.
  let history: HistoryMessageForServer[] = [];
  try {
    history = await deps.fetchHistory(deps.client, gid, selfIds);
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

  if (!res?.introText) {
    const reason = res?.ignored ?? (res?.existing ? "existing-session-mid-flow" : "no-intro");
    log(`[bot-added] server says stay silent for ${gid} (${reason})`);
    return { kind: "silent", reason };
  }

  // Monitored AND onboarding before the send, so a reply that races the
  // intro is still buffered and flushed at once.
  deps.addMonitoredGroup(gid);
  deps.addOnboardingGroup(gid);
  try {
    await deps.client.sendMessage(gid, res.introText);
    log(
      `[bot-added] intro posted in ${gid} ("${snapshot.subject ?? "?"}", language=${res.language ?? "?"}) — now monitoring`,
    );
  } catch (err) {
    error(`[bot-added] ${gid} intro send failed (group stays monitored; the server re-sends on re-add):`, err);
  }
  return { kind: "posted", language: res.language ?? null, snapshot, historyCount: history.length };
}
