/**
 * NO POSTS INTO A GROUP MATCHTIME CANNOT POST IN (2026-10-14).
 *
 * When a group is set to "only admins can send" (or is a community's
 * announcements group) and MatchTime is not an admin there, a post from it
 * reaches nobody. So every GROUP send is checked against the driver's last
 * reading (`groupPostability`, group-postability.ts) and refused, without
 * touching WhatsApp, when that reading says it cannot post.
 *
 * A refusal THROWS `GroupNotPostableError`. Every caller already treats a
 * thrown send as a failed send: the scheduler logs it and does NOT release
 * the claim (at-most-once, scheduler.ts), so nothing is retried and there
 * is no storm; the analyser's reply and the self-add intro are in their own
 * try/catch. Each refusal is counted per group and the count is logged,
 * never the text.
 *
 * DMs and reactions are never gated. A group with no reading (never read,
 * or MatchTime not found in its roster) is never gated: exactly today's
 * behaviour. Sends resume the moment the reading says MatchTime can post
 * again (setting switched off, or MatchTime promoted).
 *
 * A Proxy, like `shadowGuard`: a member added to a driver later still
 * arrives, and only the group send members are intercepted.
 */
import type { WaDriver } from "./driver.js";
import type { PostabilityReason } from "./group-postability.js";

export class GroupNotPostableError extends Error {
  override readonly name = "GroupNotPostableError";
  constructor(
    readonly groupId: string,
    readonly reason: PostabilityReason,
    readonly member: string,
  ) {
    super(
      `[postability] ${member} to ${groupId} not sent: ` +
        (reason === "community-announce"
          ? "it is a community announcements group and MatchTime is not an admin there"
          : "only admins can send messages there and MatchTime is not an admin"),
    );
  }
}

export function isGroupNotPostable(err: unknown): boolean {
  return err instanceof GroupNotPostableError;
}

const isGroup = (chatId: unknown): chatId is string => typeof chatId === "string" && chatId.endsWith("@g.us");

export function postabilityGate<T extends WaDriver>(driver: T, opts: { log?: (line: string) => void } = {}): T {
  const log = opts.log ?? ((l: string) => console.warn(l));
  /** Sends skipped per group since it last could be posted in. */
  const skipped = new Map<string, number>();

  /** Throws when this group send must not go out. */
  function check(chatId: unknown, member: string): void {
    if (!isGroup(chatId)) return;
    let reading;
    try {
      reading = driver.groupPostability?.(chatId);
    } catch {
      reading = undefined;
    }
    if (!reading || reading.canPost) {
      const n = skipped.get(chatId);
      if (n) {
        skipped.delete(chatId);
        log(`[postability] ${chatId}: MatchTime can post again; posting resumed (${n} skipped while it could not)`);
      }
      return;
    }
    const n = (skipped.get(chatId) ?? 0) + 1;
    skipped.set(chatId, n);
    log(`[postability] ${chatId}: ${member} skipped, MatchTime cannot post here (${reading.reason}); ${n} skipped so far`);
    throw new GroupNotPostableError(chatId, reading.reason, member);
  }

  function chatOf(msg: unknown): unknown {
    try {
      return (msg as { from?: unknown } | null | undefined)?.from;
    } catch {
      return undefined;
    }
  }

  const overrides: Record<string, unknown> = {
    sendText: async (chatId: string, text: string) => {
      check(chatId, "sendText");
      return driver.sendText(chatId, text);
    },
    sendTextWithMentions: async (chatId: string, text: string, mentionPhones: string[]) => {
      check(chatId, "sendTextWithMentions");
      return driver.sendTextWithMentions(chatId, text, mentionPhones);
    },
    sendPoll: async (chatId: string, question: string, options: string[], multi: boolean) => {
      check(chatId, "sendPoll");
      return driver.sendPoll(chatId, question, options, multi);
    },
    replyTo: async (msg: Parameters<WaDriver["replyTo"]>[0], text: string) => {
      check(chatOf(msg), "replyTo");
      return driver.replyTo(msg, text);
    },
    sendTextViaChat: async (chatId: string, text: string) => {
      check(chatId, "sendTextViaChat");
      return driver.sendTextViaChat(chatId, text);
    },
  };

  return new Proxy(driver, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in overrides) return overrides[prop];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as T;
}
