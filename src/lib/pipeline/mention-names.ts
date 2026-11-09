/**
 * @-MENTION NAMING — pure, no DB. The server decides who a mention is.
 *
 * ── THE DEFECT (measured against prod, 2026-09-08) ───────────────────
 *
 * The Pi used to resolve every mentioned JID with
 * `client.getContactById()` and paste the contact's pushname into the
 * body the analyzer reads. Two real messages from the live Sutton FC
 * group, as typed versus as stored in `AnalyzedMessage.body`:
 *
 *   "@Shahrokh🐔 Sutton Football Club is out due to unforeseen issue at work"
 *   → "@DÇ  is out due to unforeseen issue at work"          (routed noise)
 *
 *   "@David David 67 and @~Najib out"
 *   → "@割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂ and @Najib out"    (David's drop lost)
 *
 * The owner had reported for weeks that "MatchTime can't understand
 * messages". The analyzer was reading corrupted input.
 *
 * ⚠️ AND YET NOTHING WAS CORRUPT. `"割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂"`
 * appears **13 times** in this org's `AnalyzedMessage.authorName` — it is
 * David's own WhatsApp pushname, reported identically whenever David
 * himself speaks, and an admin had ALREADY curated
 * `UserAlias["割::::.."] → David`. WhatsApp renders a mention to each
 * reader out of the READER's address book; the bot only ever sees the
 * mentioned person's self-chosen profile name. When the two agree the
 * substitution looks perfect ("@Mojib Jalali", "@Najib" — same message,
 * same day, both correct); when they do not, the model gets a name nobody
 * in the club uses.
 *
 * Measured over all 35 distinct pushnames this org has ever produced:
 * 8 need `UserAlias` to reach the right member and 26 more resolve
 * straight off the roster, several of them to a DIFFERENT string than the
 * pushname ("ba" → Baki, "Wasimp" → Wasim, "Kemal Ediz" → Kemal). The
 * pushname is simply not the club's name for the person, and it is a
 * string the mentioned person controls.
 *
 * ── THE ORDER OF TRUST ──────────────────────────────────────────────
 *
 *   1. PHONE  — a "<digits>@c.us" mention IS the person's phone number.
 *               A unique key, needing no contact lookup and nothing the
 *               mentioned person can edit. Always tried first. Since
 *               2026-09-30 a LID mention reaches this rung too, with the
 *               phone the Pi was told for it (group metadata, message
 *               envelopes: WhatsApp's data, not the person's), and then
 *               through the LID-to-phone and LID-to-user pairs the
 *               server stored itself (`knownLids`: participant
 *               snapshots, the connect DM). Under Baileys every mention
 *               is a LID, so without this the rung never fired.
 *   2. THE MODEL'S PICK (2026-11-09; until then an alias lookup and the
 *               roster matcher, by spelling). The pushnames the phone
 *               rung could not name are put to who-is-who in one call
 *               (`nameMentions`): the club's members with their aliases
 *               (`UserAlias`, which is what already knew about David),
 *               and it says which member each is, nobody, or several.
 *               Read by `resolvePerson`: anything but one sure member is
 *               no substitution, exactly as everywhere else.
 *
 * Nothing else may put a name in the body. An unresolved mention keeps
 * its raw "@<digits>" token, which `identity.ts` refuses as a person
 * ("raw digits are never a name"), so the engine's "I can't identify this
 * person" degradation fires on an HONEST unknown instead of on
 * fabricated text.
 */
import { resolvePerson } from "./identity";
import type { Member } from "./types";
import type { PersonPicker, PersonPicks } from "./who-is-who";

/** A member as this module needs to see them. `phone` is E.164 or null. */
export interface MentionRosterMember {
  userId: string;
  name: string;
  phone?: string | null;
  /** The club's aliases for them, shown to who-is-who. */
  aliases?: readonly string[];
}

/**
 * What the Pi reported about a mention. `name` is UNVERIFIED (a lookup
 * key); `phone` is the phone behind a LID mention, digits only, from
 * WhatsApp's own group metadata. Either may be absent.
 */
export interface MentionNameInput {
  jid: string;
  name?: string;
  phone?: string;
}

/** A LID the server has stored against a phone or a member. */
export interface KnownLid {
  /** "<digits>@lid" or bare digits. */
  lid: string;
  phone?: string | null;
  userId?: string | null;
}

export interface MentionOutcome {
  jid: string;
  digits: string;
  /** The member the mention was named from, or null — token left raw. */
  member: { userId: string; name: string } | null;
  /** Which trust level answered. null when nothing did. "roster": the
   *  model's pick (who-is-who). */
  via: "phone" | "stored-lid" | "roster" | null;
  /** Why nothing did, for the ops log. */
  why?: string;
  /** The pushname the phone rung could not name: what who-is-who is
   *  asked about. */
  pushname?: string;
}

/** JID suffixes whose digits are a real phone number. */
const PHONE_JID = /@(c\.us|s\.whatsapp\.net)$/i;
const MIN_MENTION_DIGITS = 5;

function digitsOf(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/@[\s\S]*$/, "").replace(/\D/g, "");
}

function replaceMentionToken(body: string, digits: string, replacement: string): string {
  if (!/^\d+$/.test(digits)) return body;
  // `\b` after the digits so "@447700900321" does not match inside
  // "@4477009003219".
  const re = new RegExp(`@${digits}\\b`, "g");
  // Function replacer — a member called "A$AP" must not be read as a
  // capture-group reference.
  return body.replace(re, () => replacement);
}

/**
 * Rewrite every `@<digits>` token the org roster can vouch for, and leave
 * the rest exactly as they arrived.
 *
 * Idempotent against an OLD Pi: that build already substituted names on
 * its side, so its bodies contain no `@<digits>` tokens and every replace
 * below is a no-op. Nothing here re-reads or re-writes a name that is
 * already text.
 */
export function resolveMentionNames(args: {
  body: string;
  /** Raw mention JIDs, exactly as WhatsApp gave them. */
  mentions?: string[];
  /** Display names the Pi saw, per JID. Absent from older Pi builds. */
  mentionNames?: MentionNameInput[];
  roster: MentionRosterMember[];
  /** `UserAlias` rows for this org: shown to who-is-who with each member
   *  (by `nameMentions`); never matched here. */
  aliases?: Array<{ alias: string; userId: string }>;
  /** LIDs the server has stored against a phone or a member. */
  knownLids?: KnownLid[];
  /** who-is-who's picks for the pushnames (`nameMentions`). Absent: no
   *  pushname names anybody. */
  people?: PersonPicks;
}): { body: string; outcomes: MentionOutcome[] } {
  let body = typeof args?.body === "string" ? args.body : "";
  const jids = Array.isArray(args?.mentions) ? args.mentions : [];
  const outcomes: MentionOutcome[] = [];
  if (jids.length === 0) return { body, outcomes };

  const roster = (Array.isArray(args?.roster) ? args.roster : []).filter(
    (m) => m && typeof m.userId === "string" && typeof m.name === "string" && m.name.trim(),
  );
  const nameByUserId = new Map(roster.map((m) => [m.userId, m.name]));

  // `resolvePerson` reasons over the engine's Member shape. isAdmin /
  // hasPhone play no part in naming, so they are filled, not faked into
  // meaning anything.
  const asMembers: Member[] = roster.map((m) => ({
    userId: m.userId,
    name: m.name,
    isAdmin: false,
    hasPhone: !!m.phone,
  }));

  const byPhone = new Map<string, MentionRosterMember[]>();
  for (const m of roster) {
    const d = typeof m.phone === "string" ? m.phone.replace(/\D/g, "") : "";
    if (d.length < 7) continue;
    byPhone.set(d, [...(byPhone.get(d) ?? []), m]);
  }

  const nameByJid = new Map<string, string>();
  const phoneByJid = new Map<string, string>();
  for (const mn of args?.mentionNames ?? []) {
    if (!mn || typeof mn.jid !== "string") continue;
    if (typeof mn.name === "string" && mn.name.trim()) nameByJid.set(mn.jid, mn.name);
    const d = typeof mn.phone === "string" ? mn.phone.replace(/\D/g, "") : "";
    if (d.length >= 7) phoneByJid.set(mn.jid, d);
  }

  // Stored LID pairs, keyed on the LID's digits. A LID that points at two
  // different people is refused outright rather than guessed.
  const storedByLid = new Map<string, Set<string>>();
  for (const k of args?.knownLids ?? []) {
    if (!k || typeof k.lid !== "string") continue;
    const lidDigits = digitsOf(k.lid);
    if (lidDigits.length < MIN_MENTION_DIGITS) continue;
    let userId: string | null = null;
    if (typeof k.userId === "string" && nameByUserId.has(k.userId)) {
      userId = k.userId;
    } else if (typeof k.phone === "string") {
      const hits = byPhone.get(k.phone.replace(/\D/g, "")) ?? [];
      if (hits.length === 1) userId = hits[0].userId;
    }
    if (!userId) continue;
    storedByLid.set(lidDigits, new Set([...(storedByLid.get(lidDigits) ?? []), userId]));
  }

  for (const jid of jids) {
    const digits = digitsOf(jid);
    if (digits.length < MIN_MENTION_DIGITS) continue;
    const candidate = nameByJid.get(jid) ?? null;
    const outcome: MentionOutcome = { jid, digits, member: null, via: null };

    // ── 1. Phone. The JID itself is the identity; nothing to verify. ──
    //    For a LID, the phone the Pi was told for it.
    const phoneDigits =
      typeof jid === "string" && PHONE_JID.test(jid) ? digits : (phoneByJid.get(jid) ?? null);
    if (phoneDigits) {
      const hits = byPhone.get(phoneDigits) ?? [];
      if (hits.length === 1) {
        outcome.member = { userId: hits[0].userId, name: hits[0].name };
        outcome.via = "phone";
      }
    }

    // ── 1b. A LID the server stored itself. ───────────────────────────
    if (!outcome.member) {
      const users = storedByLid.get(digits);
      if (users && users.size === 1) {
        const userId = [...users][0];
        outcome.member = { userId, name: nameByUserId.get(userId)! };
        outcome.via = "stored-lid";
      }
    }

    // ── 2. Otherwise the pushname is a LOOKUP KEY, never text: the
    //    model's pick for it from the club's members, aliases included
    //    (`who-is-who.ts`, 2026-11-09). No pushname is matched by spelling.
    if (!outcome.member && candidate) {
      outcome.pushname = candidate;
      const resolved = resolvePerson(candidate, asMembers, args.people);
      if (resolved.kind === "resolved") {
        outcome.member = { userId: resolved.member.userId, name: resolved.member.name };
        outcome.via = "roster";
      } else if (resolved.kind === "ambiguous") {
        outcome.why = resolved.why ?? `"${candidate}" could be ${resolved.candidates.length} members`;
      } else if (resolved.kind === "not-a-person") {
        outcome.why = resolved.why;
      } else {
        outcome.why = `"${candidate}" is no member`;
      }
    }
    if (!outcome.member && !outcome.why) {
      outcome.why = candidate ? `"${candidate}" matches no member` : "no name for this mention";
    }

    if (outcome.member) {
      body = replaceMentionToken(body, digits, `@${outcome.member.name}`);
    }
    outcomes.push(outcome);
  }

  return { body, outcomes };
}

/**
 * `resolveMentionNames` with rung 2: the phone and stored-LID rungs first,
 * then ONE who-is-who call for every pushname they left, across all the
 * messages given, then the substitution. No call when every mention was
 * named by phone (the usual case under Baileys), carries no pushname, or
 * no picker is given (the free first pass, before the dedupe). Only a
 * member the model is SURE of is written into the body as "@Name"; a
 * name it could be several people for, or was not sure of, stays the raw
 * "@<digits>" token (`resolvePerson` reads anything else as an
 * ambiguity).
 */
export async function nameMentions(args: {
  messages: Array<{ body: string; mentions?: string[]; mentionNames?: MentionNameInput[] }>;
  roster: MentionRosterMember[];
  aliases?: Array<{ alias: string; userId: string }>;
  knownLids?: KnownLid[];
  picker?: PersonPicker;
  where?: string;
}): Promise<Array<{ body: string; outcomes: MentionOutcome[] }>> {
  const base = { roster: args.roster, aliases: args.aliases, knownLids: args.knownLids };
  const first = args.messages.map((m) => resolveMentionNames({ ...base, ...m }));
  const asks = first
    .map((r, i) => ({ i, refs: [...new Set(r.outcomes.flatMap((o) => (!o.member && o.pushname ? [o.pushname] : [])))] }))
    .filter((x) => x.refs.length > 0);
  if (asks.length === 0 || !args.picker) return first;
  const aliasesOf = new Map<string, string[]>();
  for (const a of args.aliases ?? []) aliasesOf.set(a.userId, [...(aliasesOf.get(a.userId) ?? []), a.alias]);
  const res = await args.picker({
    roster: args.roster.map((m) => ({ userId: m.userId, name: m.name, aliases: m.aliases ?? aliasesOf.get(m.userId) ?? [] })),
    where: `${args.where ?? "the club's WhatsApp group"}. Each name to identify is the WhatsApp profile name of a person @mentioned in the message`,
    messages: asks.map(({ i, refs }) => ({ id: String(i), body: args.messages[i].body, author: null, refs })),
  });
  for (const d of res.degradations) console.warn(`[mentions] ${d}`);
  return args.messages.map((m, i) => {
    const people = res.picks.get(String(i));
    return people ? resolveMentionNames({ ...base, ...m, people }) : first[i];
  });
}

/** One compact ops line per message, or null when there is nothing to say. */
export function describeMentionOutcomes(outcomes: MentionOutcome[]): string | null {
  if (outcomes.length === 0) return null;
  const named = outcomes.filter((o) => o.member);
  const raw = outcomes.filter((o) => !o.member);
  const parts: string[] = [];
  if (named.length > 0) {
    parts.push(named.map((o) => `${o.digits}→${o.member!.name} (${o.via})`).join(", "));
  }
  if (raw.length > 0) {
    parts.push(`LEFT RAW: ${raw.map((o) => `${o.digits} — ${o.why ?? "unresolved"}`).join(", ")}`);
  }
  return parts.join(" | ");
}
