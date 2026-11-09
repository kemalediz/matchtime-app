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

/** A person a message tagged, as stored. `phone`: digits, when known. `name`:
 *  their own WhatsApp name (UNVERIFIED), used only to name an unknown. */
export interface StoredMention {
  jid: string;
  phone?: string;
  name?: string;
}

export type NamedSource = "message" | "quoted" | "above";

/** A user MatchTime knows, with the number it would DM. `phone`: digits. */
export interface KnownPerson {
  userId: string;
  name: string | null;
  phone: string;
}

export interface ResolvedMention {
  mention: StoredMention;
  person: KnownPerson | null;
}

export interface NamedInvitePlan {
  invite: KnownPerson[];
  alreadyInvited: KnownPerson[];
  answered: KnownPerson[];
  optedOut: KnownPerson[];
  overCap: KnownPerson[];
  /** Labels of mentions MatchTime does not know: "+<phone>", else their
   *  WhatsApp name. */
  unknown: string[];
  /** Unknown mentions with neither. */
  unknownUnlabelled: number;
}

export type NamedInviteOutcome =
  | { kind: "nobody-tagged" }
  | { kind: "no-match" }
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

/**
 * The people a message tagged, from the Pi's structured mention data. The
 * Pi never puts the bot in `mentionNames`; a raw mention it could not name
 * is kept only when the message did not tag the bot, because then it might
 * BE the bot.
 */
export function storedMentionsOf(m: { mentions?: unknown; mentionNames?: unknown; botMentioned?: unknown }): StoredMention[] {
  const out = new Map<string, StoredMention>();
  const add = (jid: string, extra: { phone?: string; name?: string }) => {
    if (out.has(jid) || out.size >= MAX_STORED || digits(jid).length < 5) return;
    const phone = PHONE_JID.test(jid) ? phoneDigits(digits(jid)) : extra.phone;
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

/** Whose tags are meant. See the header for the order. */
export function pickNamedMentions(input: {
  own: StoredMention[];
  isReply: boolean;
  quoted: StoredMention[] | null;
  above: StoredMention[] | null;
}): { from: NamedSource; mentions: StoredMention[] } | null {
  if (input.own.length > 0) return { from: "message", mentions: input.own };
  if (input.isReply) return input.quoted && input.quoted.length > 0 ? { from: "quoted", mentions: input.quoted } : null;
  return input.above && input.above.length > 0 ? { from: "above", mentions: input.above } : null;
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
    if (!person && !PHONE_JID.test(mention.jid)) {
      const ids = lidUsers.get(digits(mention.jid));
      if (ids && ids.size === 1) person = byId.get([...ids][0]) ?? null;
    }
    return { mention, person };
  });
}

/** Who is DM'd, and who is not and why. Order is the order tagged. */
export function planNamedInvites(args: {
  resolved: ResolvedMention[];
  requesterUserId: string | null;
  optedOut: ReadonlySet<string>;
  answered: ReadonlySet<string>;
  alreadyInvited: ReadonlySet<string>;
  cap?: number;
}): NamedInvitePlan {
  const cap = args.cap ?? NAMED_INVITE_CAP;
  const plan: NamedInvitePlan = { invite: [], alreadyInvited: [], answered: [], optedOut: [], overCap: [], unknown: [], unknownUnlabelled: 0 };
  const seen = new Set<string>();
  for (const { mention, person } of args.resolved) {
    if (!person) {
      const label = mention.phone ? `+${mention.phone}` : (mention.name ?? null);
      if (label) {
        if (!plan.unknown.includes(label)) plan.unknown.push(label);
      } else plan.unknownUnlabelled++;
      continue;
    }
    if (seen.has(person.userId) || person.userId === args.requesterUserId) continue;
    seen.add(person.userId);
    if (args.optedOut.has(person.userId)) plan.optedOut.push(person);
    else if (args.answered.has(person.userId)) plan.answered.push(person);
    else if (args.alreadyInvited.has(person.userId)) plan.alreadyInvited.push(person);
    else if (plan.invite.length >= cap) plan.overCap.push(person);
    else plan.invite.push(person);
  }
  return plan;
}

/** How a known person is named in the group. */
export function personLabel(p: KnownPerson): string {
  return p.name?.trim() || `+${p.phone}`;
}

/** The one reply to the organiser. */
export function namedInviteReply(outcome: NamedInviteOutcome, lang: Lang | string | null | undefined): string {
  const c = namedInviteCopy(lang);
  if (outcome.kind === "nobody-tagged") return c.nobodyTagged;
  if (outcome.kind === "no-match") return c.noMatch;
  if (outcome.kind === "full") return c.full({ matchName: outcome.matchName });
  const { plan } = outcome;
  const names = (ps: KnownPerson[]) => joinList(lang, ps.map(personLabel));
  const lines: string[] = [];
  if (plan.invite.length > 0) lines.push(c.sent({ names: names(plan.invite), matchName: outcome.matchName, when: outcome.when }));
  if (plan.alreadyInvited.length > 0) lines.push(c.alreadyHad({ names: names(plan.alreadyInvited), count: plan.alreadyInvited.length }));
  if (plan.answered.length > 0) lines.push(c.answered({ names: names(plan.answered), count: plan.answered.length }));
  if (plan.optedOut.length > 0) lines.push(c.optedOut({ names: names(plan.optedOut), count: plan.optedOut.length }));
  if (plan.overCap.length > 0) lines.push(c.overCap({ names: names(plan.overCap), cap: NAMED_INVITE_CAP }));
  if (plan.unknown.length > 0 || plan.unknownUnlabelled > 0) {
    const items = [...plan.unknown];
    if (plan.unknownUnlabelled > 0) items.push(c.more({ count: plan.unknownUnlabelled, alone: plan.unknown.length === 0 }));
    lines.push(c.unknown({ names: joinList(lang, items) }));
  }
  return lines.length > 0 ? lines.join("\n") : c.nobodyTagged;
}
