/**
 * The bot-added flow's history capture: the group's recent messages,
 * shaped for the server's `enrichmentHistory`.
 *
 * Two sources, in order:
 *
 *  1. The history WhatsApp SHARES with a member who has just been added
 *     (the adder's "send recent messages" switch). Only the Baileys driver
 *     can read it (`driver.joinHistory`). The driver does the waiting: up
 *     to about 25 seconds when a shared-history notice or bundle was seen,
 *     about 8 seconds when there was no sign of one.
 *  2. What the socket delivered live, from the driver's buffer
 *     (`fetchRecentGroupMessages`). This is what the capture has always
 *     read (2026-09-17), and in practice it holds nothing for a group the
 *     bot joined seconds ago.
 *
 * With a driver that has no `joinHistory` (whatsapp-web.js) the second
 * source is polled three times, four seconds apart, exactly as before.
 * With one that has it, the waiting is already done, so it is read once:
 * the switch being off costs no more than it used to.
 *
 * Best-effort throughout: any failure returns [] and the intro still goes
 * out. Moved out of `index.ts` so it can be tested.
 */
import type { HistoryMessageForServer } from "./bot-added.js";
import type { InboundMessage, WaDriver } from "./driver.js";
import { asString, readMessageBody, readNotifyName, safeRead } from "./wa-read.js";

export const HISTORY_LIMIT = 600;
const LIVE_ATTEMPTS = 3;
const LIVE_RETRY_MS = 4000;
/** Fewer than this in the live buffer: assume nothing has arrived yet. */
const MIN_USEFUL = 5;

export interface HistoryCollectorDeps {
  driver: WaDriver;
  log?(line: string): void;
  warn?(line: string): void;
  sleep?(ms: number): Promise<void>;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createHistoryCollector(
  deps: HistoryCollectorDeps,
): (groupId: string, selfIds: string[]) => Promise<HistoryMessageForServer[]> {
  const { driver } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const warn = deps.warn ?? ((l: string) => console.warn(l));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return async function collectHistoryForServer(groupId, selfIds) {
    const self = new Set(selfIds);

    // 1. Shared join history. A driver without it skips straight to 2.
    let attempts = LIVE_ATTEMPTS;
    if (typeof driver.joinHistory === "function") {
      attempts = 1;
      try {
        const shared = await driver.joinHistory(groupId, selfIds);
        const messages = Array.isArray(shared?.messages) ? shared.messages : [];
        log(`[bot-added] shared join history for ${groupId}: ${shared?.outcome ?? "?"}, ${messages.length} message(s)`);
        if (messages.length > 0) return messages.slice(Math.max(0, messages.length - HISTORY_LIMIT));
      } catch (err) {
        warn(`[bot-added] shared join history read failed: ${describe(err)}`);
      }
    }

    // 2. The live buffer.
    let raw: InboundMessage[] = [];
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        raw = await driver.fetchRecentGroupMessages(groupId, HISTORY_LIMIT);
      } catch (err) {
        raw = [];
        warn(`[bot-added] history fetch attempt ${attempt} failed: ${describe(err)}`);
      }
      log(`[bot-added] history fetch attempt ${attempt}: got ${raw.length} msgs`);
      if (raw.length >= MIN_USEFUL) break;
      if (attempt < attempts) await sleep(LIVE_RETRY_MS);
    }
    if (raw.length === 0) return [];

    // Oldest → newest; never rely on the page's order.
    const dated = raw.map((m) => ({ m, t: Number(safeRead(m, "timestamp") ?? 0) || 0 }));
    dated.sort((a, b) => a.t - b.t);

    const out: HistoryMessageForServer[] = [];
    for (const { m, t } of dated) {
      try {
        if (safeRead(m, "fromMe") === true) continue;
        const author = asString(safeRead(m, "author")) ?? asString(safeRead(m, "from")) ?? "";
        if (self.has(author)) continue;
        const text = readMessageBody(m);
        if (!text.trim()) continue;
        // The pushname is on the serialised message (no page call), which
        // is what survives a broken build. Nameless rows are dropped by the
        // server anyway.
        const name = readNotifyName(m);
        if (!name) continue;
        let authorPhone: string | null = null;
        if (author.endsWith("@c.us")) authorPhone = author.replace("@c.us", "").replace(/\D/g, "") || null;
        out.push({
          author: name,
          authorPhone,
          text,
          timestamp: new Date((t || Date.now() / 1000) * 1000).toISOString(),
        });
      } catch {
        /* skip this message; never abort the whole capture */
      }
    }
    log(`[bot-added] history fetched ${raw.length} msgs (mapped ${out.length} after filtering) for ${groupId}`);
    return out;
  };
}
