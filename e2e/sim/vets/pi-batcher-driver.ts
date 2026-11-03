/**
 * THE PI'S BATCHER, DRIVEN FOR REAL AGAINST THE SERVER UNDER TEST (Vets
 * sandbox, 2026-11-03). Run by `vets-sandbox-live.spec.ts` under tsx:
 *
 *   npx tsx e2e/sim/vets/pi-batcher-driver.ts <in.json> <out.json>
 *
 * It loads the real `whatsapp-bot/src/smart-analysis.ts` (the buffer, the
 * one-flush-per-group guard, the tag's immediate flush and the re-flush
 * when a running flush ends) with a fake WhatsApp client, pointed at the
 * local e2e server by MATCHTIME_API_URL and WHATSAPP_API_KEY. Nothing
 * reaches WhatsApp: the fake client records what the Pi would have sent.
 *
 * The incident shape: a tick's flush of the first messages is running when
 * the rest arrive, a tagged question among them. The driver starts that
 * flush, buffers the rest while it runs, then waits until every flush has
 * ended and reports each flush's bodies and everything "sent".
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The Pi's modules, loaded by computed path: the root type check excludes
 * whatsapp-bot (it builds under its own tsconfig), and a literal import
 * would pull it back in.
 */
const BOT_SRC = path.resolve(__dirname, "../../../whatsapp-bot/src");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bot = (file: string): Promise<any> => import(pathToFileURL(path.join(BOT_SRC, file)).href);

interface DriverIn {
  apiUrl: string;
  apiKey: string;
  groupId: string;
  botPhone: string;
  /** The tick's flush. */
  first: Array<{ phone: string; pushname: string | null; body: string; tagged?: boolean }>;
  /** Arrive while the first flush is still running. */
  during: Array<{ phone: string; pushname: string | null; body: string; tagged?: boolean }>;
}

async function main(): Promise<void> {
  const [inFile, outFile] = process.argv.slice(2);
  const input = JSON.parse(readFileSync(inFile, "utf8")) as DriverIn;
  process.env.MATCHTIME_API_URL = input.apiUrl;
  process.env.WHATSAPP_API_KEY = input.apiKey;

  const flushes: Array<{ startedAt: number; endedAt: number | null; bodies: string[]; results: unknown[] }> = [];
  // Every call the Pi makes to /analyze, observed (not replaced): the real
  // request goes to the server and its real answer comes back.
  const smart = await bot("smart-analysis.ts");
  const { makeWwebjsDriver } = await bot("drivers/wwebjs.ts");

  const BOT_WID = `${input.botPhone}@c.us`;
  const runTag = Date.now().toString(36);
  const sent: Array<{ kind: string; to: string; text?: string; emoji?: string; messageId?: string }> = [];
  const client = {
    info: { wid: { _serialized: BOT_WID } },
    getContactById: async (jid: string) => (jid === BOT_WID ? { pushname: "Match Time", isMe: true } : { pushname: "", isMe: false }),
    getChatById: async () => ({ sendMessage: async (text: string) => (sent.push({ kind: "chat-text", to: input.groupId, text }), { id: { _serialized: `sent-${sent.length}` } }) }),
    sendMessage: async (to: string, text: string) => (sent.push({ kind: "text", to, text }), { id: { _serialized: `sent-${sent.length}` } }),
  };
  const driver = makeWwebjsDriver(client as never) as unknown as Record<string, unknown>;
  driver.sendText = async (to: string, text: string) => (sent.push({ kind: "text", to, text }), { id: { _serialized: `sent-${sent.length}` } });
  driver.sendTextViaChat = driver.sendText;
  driver.sendReaction = async (messageId: string, emoji: string) => (sent.push({ kind: "react", to: input.groupId, emoji, messageId }), { ok: true });

  // Watch the network the Pi uses: every analyze POST is a flush.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.endsWith("/api/whatsapp/analyze")) return realFetch(url as never, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ body: string }> };
    const f: (typeof flushes)[number] = { startedAt: Date.now(), endedAt: null, bodies: body.messages.map((m) => m.body), results: [] };
    flushes.push(f);
    const res = await realFetch(url as never, init);
    const text = await res.text();
    f.endedAt = Date.now();
    try {
      f.results = (JSON.parse(text) as { results?: unknown[] }).results ?? [];
    } catch {
      f.results = [{ error: text.slice(0, 500) }];
    }
    return new Response(text, { status: res.status, headers: res.headers });
  }) as typeof fetch;

  let seq = 0;
  const ids: string[] = [];
  const message = (m: DriverIn["first"][number]) => {
    seq += 1;
    ids.push(`false_${input.groupId}_VETS${runTag}${seq}_${m.phone}@c.us`);
    const body = m.tagged ? `@${input.botPhone} ${m.body.replace(/^@Match Time\s*/i, "")}` : m.body;
    return {
      from: input.groupId,
      author: `${m.phone}@c.us`,
      body,
      timestamp: Math.floor(Date.now() / 1000) + seq,
      id: { _serialized: ids[ids.length - 1] },
      mentionedIds: m.tagged ? [BOT_WID] : [],
      _data: { body, notifyName: m.pushname ?? undefined },
      getContact: async () => ({ pushname: m.pushname ?? "", isMe: false }),
    };
  };

  for (const m of input.first) await smart.enqueueForAnalysis(driver as never, message(m) as never);
  const tick = smart._test_flushNow(input.groupId); // the ten-minute tick
  // Wait until the tick's POST is on the wire, then the rest arrive.
  for (let i = 0; i < 200 && flushes.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  const duringStartedWhileFirstRunning = flushes.length === 1 && flushes[0].endedAt === null;
  for (const m of input.during) await smart.enqueueForAnalysis(driver as never, message(m) as never);
  const flushesWhenAllBuffered = flushes.length;
  await tick;
  // The re-flush is fired-and-forgotten when the tick's flush ends: wait for it.
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const open = flushes.some((f) => f.endedAt === null);
    if (flushes.length >= 2 && !open) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Let its reply/ack calls settle.
  await new Promise((r) => setTimeout(r, 1500));
  writeFileSync(outFile, JSON.stringify({ duringStartedWhileFirstRunning, flushesWhenAllBuffered, flushes, sent, ids: { first: ids.slice(0, input.first.length), during: ids.slice(input.first.length) } }, null, 2));
  smart.stopBatchFlushTimer();
  process.exit(0);
}

main().catch((err) => {
  console.error("[pi-batcher-driver] failed:", err);
  process.exit(1);
});
