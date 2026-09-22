/**
 * The whatsapp-web.js driver: the only place in the bot that knows a
 * browser is involved.
 *
 * ── What moved here, and from where ──────────────────────────────────
 * Phase 2 of `MDs/baileys-migration-plan-2026-09-21.md`. Nothing in this
 * file is new behaviour. Every method is the call `index.ts`,
 * `scheduler.ts` or `smart-analysis.ts` was making, lifted verbatim:
 *
 *   client construction, the web-version pin and the pairing-code banner
 *                                              ← index.ts main()
 *   selfIds()             ← bot-added.ts resolveSelfIds + readMeIdsInPage
 *   sendReaction()        ← react-with-id.ts reactWithId
 *   fetchRecentGroupMessages()
 *                         ← smart-analysis.ts, bare-Chat-handle trick and all
 *   groupSnapshot()       ← group-snapshot.ts (now wwebjs-group-snapshot.ts)
 *
 * The awkward parts are awkward on purpose and are preserved exactly:
 *
 *   - `selfId()` does NOT guard `client.info`. On a broken build that is a
 *     throwing getter, and three call sites derive their error handling
 *     from the throw. See `driver.ts`.
 *   - `listGroups()` and `groupParticipants()` let the library's error
 *     out, because the throw is what records `group-enumeration` and
 *     `participant-sync` in `degraded.ts`.
 *   - `groupParticipants()` returns the empty array it actually read
 *     rather than falling back to anything, because an empty roster is
 *     the QUIET version of the same failure and the caller treats it as
 *     one.
 *   - `fetchRecentGroupMessages()` keeps the bare `Chat` handle first and
 *     `getChatById` second, with the same warning line in between.
 *   - `sendReaction()` never throws; every failure is a named reason.
 *
 * ── The client type ──────────────────────────────────────────────────
 * `makeWwebjsDriver` takes a structural `WwebjsClientLike` rather than the
 * library's `Client`, so the unit tests can hand it the same booby-trapped
 * fakes they have always used (a client whose every page-backed call
 * throws the minified `r`). It reads NOTHING off the client at
 * construction time, so a fake with throwing getters can still be wrapped.
 */
import pkg from "whatsapp-web.js";
import type { Client, Message } from "whatsapp-web.js";
const { Client: WwebClient, LocalAuth, Poll } = pkg;
import qrcode from "qrcode-terminal";
import type {
  DmChatRef,
  GroupMembershipEvent,
  GroupSnapshot,
  GroupSummary,
  InboundMessage,
  InboundPollVote,
  WaDriver,
} from "../driver.js";
import type { ReactionOutcome } from "../react-with-id.js";
import { readGroupSnapshot } from "./wwebjs-group-snapshot.js";
import { asString, safePath, safeRead } from "../wa-read.js";
import {
  resolveWebVersionOptions,
  describeWebVersionOptions,
  warnIfPinUnreachable,
} from "../web-version.js";
import {
  resolvePairingOptions,
  describePairingOptions,
  formatPairingCodeBanner,
} from "../pair-phone.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The subset of whatsapp-web.js's `Client` this driver uses.
 *
 * Every member is declared required even though a test fake supplies only
 * a few, because that is exactly how the production code behaved before:
 * calling a method the library does not have throws a TypeError, and two
 * call sites (`sendReaction`) depend on noticing that rather than on the
 * type system preventing it.
 */
export interface WwebjsClientLike {
  on(event: string, handler: (...args: any[]) => void): unknown;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  info?: { wid?: { _serialized?: string } };
  pupPage?: unknown;
  getChats(): Promise<any[]>;
  getChatById(chatId: string): Promise<any>;
  getContactById(contactId: string): Promise<any>;
  sendMessage(chatId: string, content: any, options?: any): Promise<any>;
  getMessageById?: (messageId: string) => Promise<unknown>;
  sendReaction?: (messageId: string, reaction: string) => Promise<unknown>;
}

/** whatsapp-web.js addresses a person as `<digits>@c.us`. */
function userJid(phone: string): string {
  return `${phone}@c.us`;
}

export function makeWwebjsDriver(client: WwebjsClientLike): WaDriver {
  /**
   * The bot's own ids, resolved once per process.
   *
   * Lifted from `bot-added.ts`'s `resolveSelfIds`, cache included: groups
   * now address members by `@lid` while `client.info.wid` is the phone
   * JID, so a self-add comparison against the phone form alone would never
   * match and self-setup would never start. Both reads are guarded because
   * on a broken build `client.info` is a throwing getter and the page may
   * be gone.
   */
  let cachedSelfIds: string[] | null = null;

  const driver: WaDriver = {
    name: "wwebjs",

    // ── Lifecycle ────────────────────────────────────────────────────
    async start() {
      await client.initialize();
    },

    async close() {
      // `destroy()` closes the browser. There is no `logout()` here, ever:
      // that unlinks the device and turns every deploy into a re-pair.
      await client.destroy();
    },

    onOpen(handler) {
      client.on("ready", () => {
        void handler();
      });
    },

    onClose(handler) {
      client.on("disconnected", (reason: string) => handler(reason));
    },

    // ── Identity ─────────────────────────────────────────────────────
    selfId() {
      // Deliberately unguarded: see the header and `driver.ts`.
      return client.info?.wid?._serialized;
    },

    selfIdentities() {
      // Lifted from smart-analysis.ts's `enrichInbound`. WhatsApp now
      // encodes @-mentions as opaque "<digits>@lid" JIDs while
      // `client.info.wid` is the phone-based "<digits>@c.us" form, so a
      // plain `mentionedIds.includes(selfId)` is ALWAYS false even when
      // the bot was mentioned. Match against every form the build exposes.
      const info = client.info as any;
      return [
        client.info?.wid?._serialized,
        info?.me?._serialized,
        info?.lid?._serialized,
        info?.wid?.lid,
        info?.lid,
      ];
    },

    async selfIds() {
      if (cachedSelfIds && cachedSelfIds.length > 0) return cachedSelfIds;
      const ids = new Set<string>();
      try {
        const wid = client.info?.wid?._serialized;
        if (typeof wid === "string" && wid) ids.add(wid);
      } catch {
        /* throwing getter on a broken build */
      }
      try {
        const page = (client as any).pupPage as
          | { evaluate: (fn: unknown) => Promise<unknown> }
          | undefined;
        if (page) {
          const res = (await page.evaluate(readMeIdsInPage)) as {
            pn: string | null;
            lid: string | null;
          } | null;
          if (res?.pn) ids.add(res.pn);
          if (res?.lid) ids.add(res.lid);
        }
      } catch {
        /* the phone JID alone is still a valid match on a pn-addressed group */
      }
      cachedSelfIds = [...ids];
      return cachedSelfIds;
    },

    // ── Inbound ──────────────────────────────────────────────────────
    onMessage(handler) {
      client.on("message", (msg: Message) => {
        void handler(msg as unknown as InboundMessage);
      });
    },

    onReaction(handler) {
      client.on("message_reaction", (reaction: unknown) => {
        void handler(reaction);
      });
    },

    onPollVote(handler) {
      // Not in whatsapp-web.js's typed event union, which is why the old
      // registration carried the same cast.
      client.on("vote_update", (vote: InboundPollVote) => {
        void handler(vote);
      });
    },

    onGroupJoin(handler) {
      client.on("group_join", (notification: GroupMembershipEvent) => {
        void handler(notification);
      });
    },

    onGroupLeave(handler) {
      client.on("group_leave", (notification: GroupMembershipEvent) => {
        void handler(notification);
      });
    },

    // ── Outbound ─────────────────────────────────────────────────────
    sendText(chatId, text) {
      return client.sendMessage(chatId, text);
    },

    sendTextWithMentions(chatId, text, mentionPhones) {
      // The no-mentions branch passes NO options object at all, as it
      // always has: `{ mentions: [] }` is not the same request.
      return mentionPhones.length > 0
        ? client.sendMessage(chatId, text, { mentions: mentionPhones.map(userJid) })
        : client.sendMessage(chatId, text);
    },

    sendDirectText(phone, text) {
      return client.sendMessage(userJid(phone), text);
    },

    sendPoll(chatId, question, options, allowMultipleAnswers) {
      // Poll options require a messageSecret per whatsapp-web.js types;
      // it's auto-generated by the lib when omitted, but TS insists. Cast
      // to the looser type the runtime actually accepts.
      const poll = new Poll(question, options, {
        allowMultipleAnswers,
      } as ConstructorParameters<typeof Poll>[2]);
      return client.sendMessage(chatId, poll);
    },

    sendReaction(waMessageId, emoji) {
      return reactThroughLibrary(client, waMessageId, emoji);
    },

    async replyTo(msg, text) {
      await (msg as unknown as Message).reply(text);
    },

    async sendTextViaChat(chatId, text) {
      const chat = await client.getChatById(chatId);
      return await chat.sendMessage(text);
    },

    // ── Groups and roster ────────────────────────────────────────────
    async listGroups() {
      const chats = await client.getChats();
      return chats
        .filter((c: any) => c.isGroup)
        .map((g: any): GroupSummary => ({ id: g.id._serialized, name: g.name }));
    },

    async groupParticipants(groupId) {
      const chat = await client.getChatById(groupId);
      // wweb.js types — GroupChat has participants[]; non-group chats
      // don't. An empty list is returned as an empty list: the caller
      // treats that as the failure it is.
      const participants = (chat as any).participants ?? [];
      if (!Array.isArray(participants)) return [];
      return (participants as Array<{ id: { _serialized: string } }>).map((p) => p.id._serialized);
    },

    groupSnapshot(groupId, selfIds) {
      return readGroupSnapshot(client as unknown as Client, groupId, selfIds);
    },

    getContact(jid) {
      return client.getContactById(jid);
    },

    contactOf(msg) {
      return (msg as unknown as Message).getContact();
    },

    // ── History and recovery ─────────────────────────────────────────
    fetchRecentGroupMessages(groupId, limit) {
      return fetchRecentGroupMessages(client, groupId, limit);
    },

    async listDmChats() {
      const chats = await client.getChats();
      return chats
        .filter((c: any) => !c.isGroup)
        .map(
          (c: any): DmChatRef => ({
            id: asString(safePath(c, "id", "_serialized")) || null,
            name: asString(safeRead(c, "name")) || null,
            lastMessage: safeRead(c, "lastMessage"),
          }),
        );
    },
  };

  return driver;
}

/** Runs in the page. */
function readMeIdsInPage(): { pn: string | null; lid: string | null } {
  try {
    const w = (globalThis as any).window;
    const me = w.require("WAWebUserPrefsMeUser");
    const pn = me.getMaybeMePnUser?.();
    const lid = me.getMaybeMeLidUser?.();
    return { pn: pn?._serialized ?? null, lid: lid?._serialized ?? null };
  } catch {
    return { pn: null, lid: null };
  }
}

/**
 * Place `emoji` on the message with `messageId`, through the library's own
 * `getMessageById` + `sendReaction`, handing OUR id to both.
 *
 * Moved verbatim from `react-with-id.ts`'s `reactWithId`. Deliberately
 * does NOT go through `Message.react()`: that re-reads
 * `this.id._serialized`, the read that went unreadable in August, and its
 * page code then resolves without doing anything. And `sendReaction` is
 * never fired for an id the lookup could not find, because it too resolves
 * silently in that case — the exact fake success this path exists to
 * eliminate. A named failure beats a fake success every time.
 *
 * Never throws.
 */
async function reactThroughLibrary(
  client: WwebjsClientLike,
  messageId: string,
  emoji: string,
): Promise<ReactionOutcome> {
  let page: unknown;
  let lookup: WwebjsClientLike["getMessageById"];
  let send: WwebjsClientLike["sendReaction"];
  try {
    page = client?.pupPage;
    lookup = client?.getMessageById;
    send = client?.sendReaction;
  } catch {
    // A throwing getter on the client must not take the flush down.
    return { ok: false, reason: "no-page", detail: "the client threw while being inspected" };
  }
  if (!page) return { ok: false, reason: "no-page" };
  if (typeof lookup !== "function" || typeof send !== "function") {
    return { ok: false, reason: "library-api-unavailable" };
  }

  let found: unknown;
  try {
    // `.call(client)`: both library methods read `this.pupPage`.
    found = await lookup.call(client, messageId);
  } catch (err) {
    return { ok: false, reason: "lookup-threw", detail: errorText(err) };
  }
  if (!found) return { ok: false, reason: "message-not-found" };

  try {
    await send.call(client, messageId, emoji);
  } catch (err) {
    return { ok: false, reason: "send-threw", detail: errorText(err) };
  }
  return { ok: true };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The group's most recent messages, WITHOUT `client.getChatById`.
 *
 * Moved verbatim from `smart-analysis.ts`. On the live WhatsApp Web build
 * (2026-09-16, whatsapp-web.js 1.34.7) `getChatById` throws the minified
 * `r` from `getChatModel` (group metadata refresh + lid migration), and so
 * does `getChats`. The message read itself, `Chat.fetchMessages`, never
 * calls `getChatModel`: it asks the page for the chat with
 * `getAsModel: false`, the same lookup every successful `sendMessage`
 * makes. The walk only ever failed because the one way it knew to get a
 * `Chat` object was the broken one.
 *
 * `Chat`'s constructor is a plain `_patch(data)`, and `fetchMessages`
 * reads nothing off the instance but `id._serialized` and the client's
 * page, so a handle built from the group id alone is enough. The old path
 * is kept as the fallback, so a build where the bare handle fails behaves
 * exactly as before.
 */
async function fetchRecentGroupMessages(
  client: WwebjsClientLike,
  gid: string,
  limit: number,
): Promise<InboundMessage[]> {
  try {
    // CommonJS module: the structures hang off `default` under ESM import.
    const wweb = (await import("whatsapp-web.js")) as unknown as {
      default?: Record<string, unknown>;
      Chat?: unknown;
    };
    const ChatCtor = (wweb.default?.Chat ?? wweb.Chat) as new (
      c: unknown,
      data: unknown,
    ) => { fetchMessages(o: { limit: number }): Promise<Message[]> };
    if (typeof ChatCtor !== "function") throw new Error("whatsapp-web.js exports no Chat");
    const handle = new ChatCtor(client, { id: { _serialized: gid } });
    return await handle.fetchMessages({ limit });
  } catch (err) {
    console.warn(
      `[recover-group] ${gid}: fetchMessages via a bare chat handle failed ` +
        `(${err instanceof Error ? err.message : String(err)}); falling back to getChatById`,
    );
  }
  const chat = await client.getChatById(gid);
  try {
    return await chat.fetchMessages({ limit });
  } catch {
    // fetchMessages can throw for chats not yet fully loaded in the
    // headless session — fall back to the cached last message so we
    // at least catch the most recent.
    const lm = (chat as any).lastMessage as Message | undefined;
    return lm ? [lm] : [];
  }
}

/**
 * Build the real whatsapp-web.js client and wrap it.
 *
 * This is `index.ts`'s old `main()` prologue, in the same order and with
 * the same log lines: the web-version pin, the unreachable-pin warning,
 * the pairing decision, the client, then the `qr` and `code` handlers.
 * The bot above the seam no longer knows any of it exists.
 */
export function createWwebjsDriver(env: NodeJS.ProcessEnv = process.env): WaDriver {
  // WhatsApp Web version pinning — see src/web-version.ts. Resolves to {}
  // when the WA_WEB_VERSION* env vars are unset, so the client is built
  // exactly as before unless someone opts in on the Pi. This is the escape
  // hatch for the next time WhatsApp ships a frontend change that breaks
  // whatsapp-web.js's injected code: pin a known-good build in
  // ~/matchtime-bot/.env and redeploy, no code change needed.
  const webVersionOptions = resolveWebVersionOptions(env);
  console.log(describeWebVersionOptions(webVersionOptions));
  // Warn-only: a pin to a build the archive doesn't have is ignored SILENTLY
  // by whatsapp-web.js, which would look identical to a working pin.
  // Fire-and-forget so a slow GitHub can't delay startup.
  void warnIfPinUnreachable(webVersionOptions);

  // Mobile-friendly login — see src/pair-phone.ts. Resolves to {} when
  // WA_PAIR_PHONE is unset, so the client is built exactly as before and the
  // QR flow is untouched. When it IS set, whatsapp-web.js asks WhatsApp for
  // an 8-character pairing code instead, which can be typed into the burner
  // phone with no second screen — the QR needed a terminal AND the phone,
  // which repeatedly left the bot logged out and the product dead.
  //
  // Note the library treats QR and pairing code as mutually exclusive
  // (Client.js:161), so no QR is printed while WA_PAIR_PHONE is set. Unset it
  // and redeploy to get the QR route back.
  const pairing = resolvePairingOptions(env);
  if (pairing.criticalLog) console.error(pairing.criticalLog);
  console.log(describePairingOptions(pairing));

  const client = new WwebClient({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath: env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
    ...webVersionOptions,
    ...pairing.clientOptions,
  });

  // Still registered unconditionally: harmless when pairing is on (the
  // library simply never emits 'qr' in that mode) and the sole auth path
  // when it is off.
  client.on("qr", (qr: string) => {
    console.log("\nScan this QR code with WhatsApp on the burner phone:\n");
    qrcode.generate(qr, { small: true });
  });

  // whatsapp-web.js emits 'code' each time a pairing code is generated —
  // once immediately and again on every refresh, so a lapsed code is
  // replaced without anyone touching the Pi.
  client.on("code", (code: string) => {
    console.log(formatPairingCodeBanner(code, pairing.intervalMs));
  });

  return makeWwebjsDriver(client as unknown as WwebjsClientLike);
}
