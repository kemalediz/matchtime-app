/**
 * The seam between MatchTime's bot and whatever library is holding the
 * WhatsApp line.
 *
 * ── Why this file exists ─────────────────────────────────────────────
 * `MDs/baileys-migration-plan-2026-09-21.md` Phase 2. Four outages in two
 * months, all the same shape: WhatsApp changes a frontend we do not
 * control and whatsapp-web.js's injected page code stops matching it. The
 * plan is to move to Baileys, which speaks the wire protocol instead of
 * driving a browser. The swap is only safe if it is a one-line decision
 * and the rollback is one revert, which means everything above the socket
 * has to stop knowing which library is underneath.
 *
 * So: `index.ts`, `scheduler.ts` and `smart-analysis.ts` talk to a
 * `WaDriver` and nothing else. `src/drivers/wwebjs.ts` is the
 * whatsapp-web.js implementation and is the only place in the bot (outside
 * `src/baileys/`) allowed to import the library. `driver-seam.test.ts`
 * enforces that with a grep, because an architecture rule nobody can run
 * is a comment.
 *
 * ── What this interface is, and is not ───────────────────────────────
 * It is the set of calls the bot ACTUALLY makes, read out of the source,
 * not a tidy WhatsApp abstraction. Several members are shaped by
 * whatsapp-web.js history rather than by what a WhatsApp client ought to
 * offer: `sendTextViaChat` exists only because the group reply has a
 * second attempt through a `Chat` handle, and `listDmChats` exists only
 * for a one-shot env-gated recovery tool. They are named here honestly
 * rather than smoothed away, because the point of Phase 2 is that nothing
 * changes behaviour. Phase 3 and Phase 4 can collapse them once there is
 * a second implementation to measure against.
 *
 * Errors are part of the contract. Several call sites derive a
 * `DegradedCapability` from a call THROWING (`degraded.ts`), so a driver
 * method that swallowed a failure and returned a neutral value would
 * silently switch off the bot's only off-Pi health signal. Each member
 * below says whether it may throw.
 */
import type { ReactionOutcome } from "./react-with-id.js";

/**
 * One inbound message, opaque above the driver.
 *
 * Everything the bot reads off a message goes through the total helpers in
 * `wa-read.ts` and `message-id.ts`, which take `unknown` and never throw,
 * so the real type stays the driver's business. The three fields named
 * here are the only ones read structurally above the seam, and both
 * drivers can supply them:
 *
 *   - `timestamp`: `recoverGroupMessages` sorts on it and compares it
 *     against the lookback cutoff, with `?? 0`, NOT with the "fall back to
 *     now" rule the analyzer timestamp uses. The two are different on
 *     purpose; do not merge them.
 *   - `fromMe`: the catch-up walk skips the bot's own messages.
 *   - `mentionedIds`: read in two places as a possibly-throwing getter,
 *     which on the broken whatsapp-web.js build is exactly what it is.
 *     Both readers are already wrapped; keep it that way.
 */
export interface InboundMessage {
  /** WhatsApp's own timestamp, in SECONDS. */
  timestamp?: number;
  /** Did this account send it? */
  fromMe?: boolean;
  /** Raw mention JIDs, e.g. "447700900123@c.us" or "<digits>@lid". */
  mentionedIds?: string[];
}

/** A group this account is a member of. */
export interface GroupSummary {
  /** The group JID, e.g. "447525334985-1607872139@g.us". */
  id: string;
  /** The group's subject, as the library reports it. */
  name: string;
}

/**
 * A one-to-one chat, for the `BOT_RECOVER_DM_REPLIES=1` one-shot only.
 *
 * `lastMessage` stays RAW: the replay reads six fields off it, three of
 * them through `_data`, and every read is already defensive. Normalising
 * it here would move that logic into the driver for the sake of a tool
 * that has no Baileys equivalent (plan §1.4 item 43).
 */
export interface DmChatRef {
  id: string | null;
  name: string | null;
  lastMessage: unknown;
}

/** A poll vote, in the shape `index.ts` has always read. */
export interface InboundPollVote {
  parentMessage?: { id?: { _serialized?: string } };
  voter?: string;
  selectedOptions?: Array<{ name?: string; localId?: number }>;
}

/** A `group_join` / `group_leave` notification. */
export interface GroupMembershipEvent {
  chatId?: string;
  recipientIds?: string[];
  author?: string;
}

/** One member of a group, as the snapshot reads them. */
export interface SnapshotParticipant {
  /** E.164 digits without "+", when the id (or its lid → pn mapping) is a phone. */
  phone?: string;
  /** The `@lid` privacy id, when that is all the driver has. */
  lidId?: string;
  pushname?: string;
  isAdmin?: boolean;
}

/** A group's subject and members, with a note per thing that degraded. */
export interface GroupSnapshot {
  subject: string | null;
  participants: SnapshotParticipant[];
  /**
   * Which path produced the result. `page` and `getChatById` are
   * whatsapp-web.js's; `groupMetadata` is the Baileys driver's one read.
   * Logged, never sent to the server.
   */
  source: "page" | "getChatById" | "groupMetadata" | "none";
  /** Human-readable reasons for anything that degraded, for the log. */
  notes: string[];
}

export interface WaDriver {
  /** Which library is underneath. Logged at startup; never branched on. */
  readonly name: string;

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Open the line. Resolves once the library has been told to connect,
   * NOT once it is connected: `onOpen` is how you learn that.
   */
  start(): Promise<void>;

  /** Close the line on SIGINT/SIGTERM. Must never unlink the device. */
  close(): Promise<void>;

  /**
   * The line is up and usable.
   *
   * Fires MORE THAN ONCE in one process: whatsapp-web.js re-injects after
   * a page navigation and emits `ready` again (two `ready` lines under one
   * PID on 2026-09-16), and a reconnecting Baileys socket will do the
   * same. Every handler above this seam is idempotent for that reason.
   */
  onOpen(handler: () => void | Promise<void>): void;

  /** The line is down. The reason is logged, not branched on. */
  onClose(handler: (reason: string) => void): void;

  // ── Identity ───────────────────────────────────────────────────────

  /**
   * The bot's own phone-form JID, synchronously, or undefined.
   *
   * MAY THROW, deliberately. On a broken whatsapp-web.js build the
   * underlying `client.info` is a throwing getter, and three call sites
   * depend on the throw: the participant sweep reports `participant-sync`
   * degraded for that org, and the two membership handlers abort with
   * their own log line. A total version would quietly change all three.
   * The one call site that must survive it (the setup-trigger check in
   * `index.ts`) has its own try/catch and keeps it.
   */
  selfId(): string | undefined;

  /**
   * EVERY form of the bot's own id the library exposes right now, read
   * live, in the order the mention check has always read them.
   *
   * Separate from `selfIds()` on purpose. `selfIds()` is the cached,
   * page-assisted pair used for self-add detection; this is the live,
   * unguarded list the @-mention check compares against, and it includes
   * forms `selfIds()` never had (`info.me`, `info.wid.lid`). Swapping one
   * for the other would change which messages count as tagging the bot,
   * which is the gate the whole interaction contract hangs off. `selfId()`
   * is this list's first entry.
   *
   * MAY THROW, for the same reason `selfId()` does. Its one caller runs
   * inside `enrichOrDegrade`, which turns the throw into a degraded
   * enrichment rather than a lost message.
   */
  selfIdentities(): Array<string | null | undefined>;

  /**
   * Every id this account answers to: the phone JID and, when the library
   * can say, the `@lid` one. Cached after the first successful read.
   *
   * Groups now address members by `@lid`, so a self-add comparison against
   * the phone JID alone never matches and self-setup never starts. Total:
   * returns what it could find, including [].
   */
  selfIds(): Promise<string[]>;

  // ── Inbound ────────────────────────────────────────────────────────

  /** Every inbound message, group and DM, including our own. */
  onMessage(handler: (msg: InboundMessage) => void | Promise<void>): void;

  /**
   * A reaction was added or removed on some message.
   *
   * The payload stays RAW because every field on it is read through
   * `safePath` / `safeRead`: on the broken build `msgId` is a throwing
   * getter rather than merely absent, and the handler's job is to notice
   * that and record `reaction-forwarding` degraded.
   */
  onReaction(handler: (reaction: unknown) => void | Promise<void>): void;

  /** Somebody voted in a poll. */
  onPollVote(handler: (vote: InboundPollVote) => void | Promise<void>): void;

  /**
   * Somebody (possibly the bot) was added to a group.
   *
   * Deliberately NOT merged with `onGroupLeave` into one
   * `onParticipantsUpdate`, which is what the plan's sketch named. The two
   * are separate events with different payload handling here: the join
   * path runs self-add detection, a group snapshot and a history capture
   * before it ever looks at the human joiners. Collapsing them would mean
   * inventing an `action` discriminator in the whatsapp-web.js driver and
   * immediately re-splitting it at the call site, which is a real change
   * dressed as a rename. Baileys' single `group-participants.update` maps
   * onto these two in Phase 4 instead.
   */
  onGroupJoin(handler: (notification: GroupMembershipEvent) => void | Promise<void>): void;

  /** Somebody was removed from, or left, a group. */
  onGroupLeave(handler: (notification: GroupMembershipEvent) => void | Promise<void>): void;

  // ── Outbound ───────────────────────────────────────────────────────

  /**
   * Post text in a chat. Resolves to the library's send result, which
   * `send-result.ts` reads a message id out of and which CAN be undefined
   * on a broken build. The scheduler acks anyway; at-most-once is a
   * deliberate product decision, not a workaround.
   */
  sendText(chatId: string, text: string): Promise<unknown>;

  /**
   * Post text with real @-mentions. `mentionPhones` are bare digits, no
   * "+" and no server suffix: turning a phone into a sendable mention id
   * is the driver's job, because the suffix changes with the library
   * (`@c.us` today, `@s.whatsapp.net` under Baileys).
   */
  sendTextWithMentions(chatId: string, text: string, mentionPhones: string[]): Promise<unknown>;

  /** DM a bare phone number. Same suffix argument as above. */
  sendDirectText(phone: string, text: string): Promise<unknown>;

  /** Post a poll. */
  sendPoll(
    chatId: string,
    question: string,
    options: string[],
    allowMultipleAnswers: boolean,
  ): Promise<unknown>;

  /**
   * Place `emoji` on the message with `waMessageId`, from the id alone.
   *
   * Never throws: every failure is a named `ReactionOutcome` reason, which
   * is the whole point of the module this came from. A reaction is a
   * player's confirmation; the attendance write already happened and must
   * never be endangered by the cosmetics.
   */
  sendReaction(waMessageId: string, emoji: string): Promise<ReactionOutcome>;

  /** Reply to one inbound message, in its own chat. */
  replyTo(msg: InboundMessage, text: string): Promise<void>;

  /**
   * Post text through a chat handle rather than the client's own send.
   *
   * The second half of the group reply's two-attempt path. It exists
   * because on 2026-08-28 `getChatById` was the call that threw while
   * sends still worked, so the fallback is deliberately the OTHER one, and
   * the comment at the call site says to keep it "so nothing regresses if
   * sendMessage is the one that breaks next time". Under Baileys there is
   * one send path and this collapses into `sendText`.
   */
  sendTextViaChat(chatId: string, text: string): Promise<unknown>;

  // ── Groups and roster ──────────────────────────────────────────────

  /**
   * Every group this account is in.
   *
   * MAY THROW, and the throw is load-bearing: this is the canary for the
   * whole injected layer and its failure is what records
   * `group-enumeration` degraded.
   */
  listGroups(): Promise<GroupSummary[]>;

  /**
   * The JIDs of a group's members.
   *
   * MAY THROW (records `participant-sync`). An EMPTY array is the quiet
   * version of the same failure and the caller treats it as one, so a
   * driver must return what it actually read rather than inventing a
   * roster.
   */
  groupParticipants(groupId: string): Promise<string[]>;

  /**
   * A group's subject and members for the self-setup POST, by whatever
   * path still works. Total: it reports what it could not do in `notes`.
   */
  groupSnapshot(groupId: string, selfIds: string[]): Promise<GroupSnapshot>;

  /**
   * The contact record for a JID, RAW.
   *
   * Raw on purpose. Six call sites read different fields off it
   * (`number`, `pushname`, `name`, `verifiedName`, `shortName`, `isMe`),
   * each with its own precedence and its own fallback, and on a broken
   * build each of those is a throwing getter. Normalising here would
   * flatten six deliberate orderings into one.
   *
   * MAY THROW; every caller already catches.
   */
  getContact(jid: string): Promise<unknown>;

  /** The contact record for an inbound message's sender, RAW. May throw. */
  contactOf(msg: InboundMessage): Promise<unknown>;

  // ── History and recovery ───────────────────────────────────────────

  /**
   * The group's most recent messages, newest-first or oldest-first: the
   * callers sort. Used by the restart catch-up and by the self-setup
   * history capture.
   */
  fetchRecentGroupMessages(groupId: string, limit: number): Promise<InboundMessage[]>;

  /**
   * Every one-to-one chat, for `BOT_RECOVER_DM_REPLIES=1` only.
   *
   * Plan §1.6 lists this as one of three things Baileys cannot do, and as
   * acceptable to drop. It is on the interface because the code still
   * calls it, not because a second driver will implement it.
   */
  listDmChats(): Promise<DmChatRef[]>;
}
