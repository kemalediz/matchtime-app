/**
 * "@MATCH TIME DM THESE PEOPLE" (Kemal, Vets MNF, 2026-11-09): THE RULES.
 *
 * Shane posted "@~BH @+44 7747 410069 @Matt Afc Walcountians Vets ... Any
 * of you boys fancy it?" with three places open. The owner wants to answer
 * "@Match Time DM these people", "@Match Time DM the people above", or quote
 * Shane and say "@Match Time DM them", and have MatchTime DM each of them
 * the club's invite for the game, without saying what to send.
 *
 * WHO "THESE PEOPLE" ARE IS NEVER READ FROM THE WORDS. The admin extractor
 * says only that the people TAGGED are meant (`playersFrom: ["named"]`).
 * Who they are comes from WhatsApp's own mention data, which the Pi
 * forwards with every message (`mentions`, `mentionNames`) and MatchTime
 * keeps for the messages it is shown (`MessageMentions`, `group-mentions.ts`):
 *
 *   1. the message itself tags people ("@Match Time DM @Ali and @Sam");
 *   2. else, a WhatsApp reply: the message it quotes, and only that one (a
 *      reply to a message that tagged nobody is NOT read as "the one
 *      above", which could be quite different people);
 *   3. else the latest earlier message in the same group that tagged people.
 *
 * ONLY PEOPLE MATCHTIME ALREADY KNOWS (Kemal's decision). A mention is a
 * person when its phone (the JID's own, or the one WhatsApp gave the Pi for
 * a LID) is one user's number, or its LID is one MatchTime stored itself
 * (`known-lids.ts`). A number MatchTime has no record of is never DM'd:
 * the bot runs on the club's unofficial WhatsApp number, and a DM to a
 * stranger is how that number gets banned (`recruit-lookback.ts`). The
 * reply names them instead ("I can't message numbers I don't know yet").
 *
 * And never more than NAMED_INVITE_CAP in one request; never someone who
 * opted out of invites or is a guest, who already answered for the game,
 * who already had this game's invite (the recruit blast's own key), or the
 * sender himself.
 *
 * Pure: no database, no clock.
 */
import { joinList } from "./i18n/text";
import { namedInviteCopy } from "./i18n/named-invite";
import type { Lang } from "./i18n/lang";
import type { KnownLid } from "./pipeline/mention-names";

/** The most people one request DMs. */
export const NAMED_INVITE_CAP = 10;

/** How far back "the people above" may be: the latest earlier message that
 *  tagged people, within this long. */
export const NAMED_ABOVE_LOOKBACK_MS = 12 * 3600 * 1000;

/**
 * RETENTION: who a message tagged (`MessageMentions`: WhatsApp ids, phones,
 * WhatsApp names) is deleted this many days after the message was sent, by
 * the daily 06:00 cron (`purgeOldMentions`, `group-mentions.ts`). "The
 * people above" looks back 12 hours; a week leaves room for a reply quoting
 * an older message, and nothing else reads these rows.
 */
export const MESSAGE_MENTIONS_RETENTION_DAYS = 7;

/** Rows sent before this instant are deleted. */
export function mentionsPurgeBefore(now: Date): Date {
  return new Date(now.getTime() - MESSAGE_MENTIONS_RETENTION_DAYS * 24 * 3600 * 1000);
}

/** A person a message tagged, as stored. `phone`: digits, when known (the
 *  JID's own for a phone-number tag, else the one WhatsApp gave the Pi for
 *  a LID: never printed). `name`: their own WhatsApp name (UNVERIFIED). */
export interface StoredMention {
  jid: string;
  phone?: string;
  name?: string;
}

/** Who a message tagged: the mentions the Pi could say something about, and
 *  how many more it tagged that the Pi could name in no way (review #1). */
export interface TaggedPeople {
  mentions: StoredMention[];
  unidentified: number;
}

/** A stored message's tags, with who sent it (their name as shown). */
export interface TaggedSource extends TaggedPeople {
  senderName: string | null;
}

export type NamedSource = "message" | "quoted" | "above";

/** A user MatchTime knows, with the number it would DM. `phone`: digits. */
export interface KnownPerson {
  userId: string;
  name: string | null;
  phone: string;
}

/** A known person in a plan: `label` is how the group is told about them
 *  (their name in this club, else their WhatsApp name, else a phone from a
 *  phone-number tag, else null and counted); `member`: in this club. */
export interface PlannedPerson extends KnownPerson {
  label: string | null;
  member: boolean;
}

export interface ResolvedMention {
  mention: StoredMention;
  person: KnownPerson | null;
}

export interface NamedInvitePlan {
  invite: PlannedPerson[];
  alreadyInvited: PlannedPerson[];
  answered: PlannedPerson[];
  optedOut: PlannedPerson[];
  /** Left this club, or removed by its organisers. */
  notHere: PlannedPerson[];
  overCap: PlannedPerson[];
  /** Labels of mentions MatchTime does not know: their WhatsApp name, else
   *  the phone of a phone-number tag. */
  unknown: string[];
  /** Unknown mentions with no label. */
  unknownUnlabelled: number;
  /** Tags the Pi could name in no way. */
  unidentified: number;
}

export type NamedInviteOutcome =
  | { kind: "nobody-tagged" }
  | { kind: "no-match" }
  | { kind: "failed" }
  | { kind: "full"; matchName: string }
  | { kind: "done"; matchName: string; when: string; plan: NamedInvitePlan };

const PHONE_JID = /@(c\.us|s\.whatsapp\.net)$/i;
const MAX_STORED = 50;

const digits = (v: unknown): string => (typeof v === "string" ? v.replace(/@[\s\S]*$/, "").replace(/:\d+$/, "").replace(/\D/g, "") : "");
const phoneDigits = (v: unknown): string | undefined => {
  const d = typeof v === "string" ? v.replace(/\D/g, "") : "";
  return d.length >= 7 ? d : undefined;
};
const cleanName = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim().slice(0, 60) : "";
  return s ? s : undefined;
};
const isPhoneJid = (jid: string): boolean => PHONE_JID.test(jid);

/**
 * The people a message tagged, from the Pi's structured mention data. The
 * Pi never puts the bot in `mentionNames`; a raw mention it could not name
 * is kept only when the message did not tag the bot, because then it might
 * BE the bot (see `taggedPeopleOf` for how those are still counted).
 */
export function storedMentionsOf(m: { mentions?: unknown; mentionNames?: unknown; botMentioned?: unknown }): StoredMention[] {
  const out = new Map<string, StoredMention>();
  const add = (jid: string, extra: { phone?: string; name?: string }) => {
    if (out.has(jid) || out.size >= MAX_STORED || digits(jid).length < 5) return;
    const phone = isPhoneJid(jid) ? phoneDigits(digits(jid)) : extra.phone;
    out.set(jid, { jid, ...(extra.name ? { name: extra.name } : {}), ...(phone ? { phone } : {}) });
  };
  for (const mn of Array.isArray(m?.mentionNames) ? m.mentionNames : []) {
    if (!mn || typeof mn !== "object" || typeof (mn as { jid?: unknown }).jid !== "string") continue;
    const e = mn as { jid: string; name?: unknown; phone?: unknown };
    add(e.jid, { phone: phoneDigits(e.phone), name: cleanName(e.name) });
  }
  if (m?.botMentioned !== true) {
    for (const jid of Array.isArray(m?.mentions) ? m.mentions : []) {
      if (typeof jid === "string") add(jid, {});
    }
  }
  return [...out.values()];
}

/**
 * Who a message tagged, counting the tags the Pi could say nothing about
 * (review #1, 2026-11-09). The Pi drops from `mentionNames` a mention it has
 * no name or phone for, and the bot's own. In a message that tags the bot,
 * every raw mention not in `mentionNames` is the bot's or such a person, so
 * all but one (the bot) are people MatchTime cannot identify. Counting them
 * keeps "@Match Time DM @<someone unnamed>" from reading as "nobody tagged"
 * and falling back to an older message's people.
 */
export function taggedPeopleOf(m: { mentions?: unknown; mentionNames?: unknown; botMentioned?: unknown }): TaggedPeople {
  const mentions = storedMentionsOf(m);
  if (m?.botMentioned !== true) return { mentions, unidentified: 0 };
  const named = new Set(mentions.map((x) => x.jid));
  const unnamed = new Set((Array.isArray(m?.mentions) ? m.mentions : []).filter((j): j is string => typeof j === "string" && digits(j).length >= 5 && !named.has(j)));
  return { mentions, unidentified: Math.max(0, unnamed.size - 1) };
}

/** Did a message tag anyone? */
export function taggedAnyone(t: TaggedPeople | null | undefined): boolean {
  return !!t && (t.mentions.length > 0 || t.unidentified > 0);
}

/** Whose tags are meant. See the header for the order. */
export function pickNamedMentions(input: {
  own: TaggedPeople;
  isReply: boolean;
  quoted: TaggedSource | null;
  above: TaggedSource | null;
}): { from: NamedSource; people: TaggedPeople; senderName: string | null } | null {
  if (taggedAnyone(input.own)) return { from: "message", people: input.own, senderName: null };
  const pick = (from: NamedSource, s: TaggedSource | null) =>
    s && taggedAnyone(s) ? { from, people: { mentions: s.mentions, unidentified: s.unidentified }, senderName: s.senderName } : null;
  return input.isReply ? pick("quoted", input.quoted) : pick("above", input.above);
}

/**
 * "The people above" (review #5): the latest message that tagged people and
 * was sent BEFORE the request, never after it. `stored` is the latest stored
 * row sent strictly before `before`; `batchBefore` are the messages that
 * arrived ahead of the request in its own flush, in arrival order. A tie on
 * the clock goes to the flush, the later arrival winning.
 */
export function pickAbove<S extends TaggedSource & { sentAt: Date }>(input: { stored: S | null; batchBefore: S[]; before: Date }): S | null {
  let best: S | null = input.stored && input.stored.sentAt < input.before && taggedAnyone(input.stored) ? input.stored : null;
  for (const b of input.batchBefore) {
    if (!taggedAnyone(b) || b.sentAt > input.before) continue;
    if (!best || b.sentAt >= best.sentAt) best = b;
  }
  return best;
}

/** Each mention's person, when MatchTime knows exactly one. */
export function resolveNamedMentions(mentions: StoredMention[], known: { users: KnownPerson[]; lids: KnownLid[] }): ResolvedMention[] {
  const byPhone = new Map<string, KnownPerson[]>();
  for (const u of known.users) {
    const d = phoneDigits(u.phone);
    if (d) byPhone.set(d, [...(byPhone.get(d) ?? []).filter((x) => x.userId !== u.userId), u]);
  }
  const byId = new Map(known.users.map((u) => [u.userId, u]));
  const onePhone = (d: string | undefined): KnownPerson | null => {
    const hits = d ? (byPhone.get(d) ?? []) : [];
    return hits.length === 1 ? hits[0] : null;
  };
  // A stored LID that leads to two different people is nobody.
  const lidUsers = new Map<string, Set<string>>();
  for (const k of known.lids) {
    const lid = digits(k?.lid);
    if (lid.length < 5) continue;
    const person = typeof k.userId === "string" ? (byId.get(k.userId) ?? null) : onePhone(phoneDigits(k.phone ?? undefined));
    if (!person) continue;
    lidUsers.set(lid, new Set([...(lidUsers.get(lid) ?? []), person.userId]));
  }
  return mentions.map((mention) => {
    let person = onePhone(mention.phone);
    if (!person && !isPhoneJid(mention.jid)) {
      const ids = lidUsers.get(digits(mention.jid));
      if (ids && ids.size === 1) person = byId.get([...ids][0]) ?? null;
    }
    return { mention, person };
  });
}

/** How a mention may be named in the group: the WhatsApp name tagged, else
 *  the phone of a phone-number tag, else null (review #6: a phone learned
 *  behind a LID is never printed). */
function mentionLabel(m: StoredMention): string | null {
  return m.name ?? (isPhoneJid(m.jid) && m.phone ? `+${m.phone}` : null);
}

/** Who is DM'd, and who is not and why. Order is the order tagged. */
export function planNamedInvites(args: {
  resolved: ResolvedMention[];
  requesterUserId: string | null;
  /** Opted out of invite DMs in ANY club, or a guest of this one. */
  optedOut: ReadonlySet<string>;
  /** Left this club, or removed by its organisers. */
  notHere: ReadonlySet<string>;
  answered: ReadonlySet<string>;
  alreadyInvited: ReadonlySet<string>;
  /** This club's name for each of its current members. */
  clubNames: ReadonlyMap<string, string>;
  unidentified: number;
  cap?: number;
}): NamedInvitePlan {
  const cap = args.cap ?? NAMED_INVITE_CAP;
  const plan: NamedInvitePlan = {
    invite: [],
    alreadyInvited: [],
    answered: [],
    optedOut: [],
    notHere: [],
    overCap: [],
    unknown: [],
    unknownUnlabelled: 0,
    unidentified: Math.max(0, args.unidentified),
  };
  const seen = new Set<string>();
  for (const { mention, person } of args.resolved) {
    if (!person) {
      const label = mentionLabel(mention);
      if (label) {
        if (!plan.unknown.includes(label)) plan.unknown.push(label);
      } else plan.unknownUnlabelled++;
      continue;
    }
    if (seen.has(person.userId) || person.userId === args.requesterUserId) continue;
    seen.add(person.userId);
    const clubName = args.clubNames.get(person.userId)?.trim() || null;
    const p: PlannedPerson = { ...person, label: clubName ?? mentionLabel(mention), member: clubName !== null || args.clubNames.has(person.userId) };
    if (args.optedOut.has(person.userId)) plan.optedOut.push(p);
    else if (args.notHere.has(person.userId)) plan.notHere.push(p);
    else if (args.answered.has(person.userId)) plan.answered.push(p);
    else if (args.alreadyInvited.has(person.userId)) plan.alreadyInvited.push(p);
    else if (plan.invite.length >= cap) plan.overCap.push(p);
    else plan.invite.push(p);
  }
  return plan;
}

/** The one reply to the organiser. `source`: whose tags were used. */
export function namedInviteReply(
  outcome: NamedInviteOutcome,
  lang: Lang | string | null | undefined,
  source: { from: NamedSource; senderName: string | null } | null = null,
): string {
  const c = namedInviteCopy(lang);
  if (outcome.kind === "nobody-tagged") return c.nobodyTagged;
  if (outcome.kind === "no-match") return c.noMatch;
  if (outcome.kind === "failed") return c.failed;
  if (outcome.kind === "full") return c.full({ matchName: outcome.matchName });
  const { plan } = outcome;
  // Named people, then "one more person" for those with no name to show.
  const names = (ps: PlannedPerson[]) => {
    const labelled = ps.map((p) => p.label).filter((l): l is string => !!l);
    const rest = ps.length - labelled.length;
    return joinList(lang, rest > 0 ? [...labelled, c.more({ count: rest, alone: labelled.length === 0 })] : labelled);
  };
  const lines: string[] = [];
  if (source && source.from !== "message") lines.push(c.from({ from: source.from, senderName: source.senderName }));
  if (plan.invite.length > 0) lines.push(c.sent({ names: names(plan.invite), matchName: outcome.matchName, when: outcome.when }));
  if (plan.alreadyInvited.length > 0) lines.push(c.alreadyHad({ names: names(plan.alreadyInvited), count: plan.alreadyInvited.length }));
  if (plan.answered.length > 0) lines.push(c.answered({ names: names(plan.answered), count: plan.answered.length }));
  if (plan.optedOut.length > 0) lines.push(c.optedOut({ names: names(plan.optedOut), count: plan.optedOut.length }));
  if (plan.notHere.length > 0) lines.push(c.notHere({ names: names(plan.notHere), count: plan.notHere.length }));
  if (plan.overCap.length > 0) lines.push(c.overCap({ names: names(plan.overCap), cap: NAMED_INVITE_CAP }));
  if (plan.unknown.length > 0 || plan.unknownUnlabelled > 0) {
    const items = [...plan.unknown];
    if (plan.unknownUnlabelled > 0) items.push(c.more({ count: plan.unknownUnlabelled, alone: plan.unknown.length === 0 }));
    lines.push(c.unknown({ names: joinList(lang, items) }));
  }
  if (plan.unidentified > 0) lines.push(c.unidentified({ count: plan.unidentified }));
  const body = lines.filter((l) => !l.startsWith("📨"));
  return body.length > 0 ? lines.join("\n") : c.nobodyTagged;
}
