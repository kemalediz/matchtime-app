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
 *   2. ALIAS  — `UserAlias`, admin-curated (or merge-derived) and unique
 *               per (orgId, alias). This is what already knew about David.
 *   3. ROSTER — `resolvePerson()`, the same ambiguity-bailing matcher the
 *               engine uses on a quoted name. Two candidates = no write
 *               and no substitution, exactly as everywhere else.
 *
 * Nothing else may put a name in the body. An unresolved mention keeps
 * its raw "@<digits>" token, which `identity.ts` refuses as a person
 * ("raw digits are never a name"), so the engine's "I can't identify this
 * person" degradation fires on an HONEST unknown instead of on
 * fabricated text.
 */
import { resolvePerson } from "./identity";
import { normaliseName } from "../name-normalise";
import type { Member } from "./types";

/** A member as this module needs to see them. `phone` is E.164 or null. */
export interface MentionRosterMember {
  userId: string;
  name: string;
  phone?: string | null;
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
  /** Which trust level answered. null when nothing did. */
  via: "phone" | "stored-lid" | "alias" | "roster" | null;
  /** Why nothing did, for the ops log. */
  why?: string;
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
  /** `UserAlias` rows for this org (alias already folded on write). */
  aliases?: Array<{ alias: string; userId: string }>;
  /** LIDs the server has stored against a phone or a member. */
  knownLids?: KnownLid[];
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

  const aliasToUser = new Map(
    (args?.aliases ?? [])
      .filter((a) => a && typeof a.alias === "string" && typeof a.userId === "string")
      .map((a) => [normaliseName(a.alias), a.userId]),
  );

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

    // ── 2 & 3. Otherwise the pushname is a LOOKUP KEY, never text. ────
    if (!outcome.member && candidate) {
      const key = normaliseName(candidate);
      const aliasUser = key.length >= 2 ? aliasToUser.get(key) : undefined;
      if (aliasUser && nameByUserId.has(aliasUser)) {
        outcome.member = { userId: aliasUser, name: nameByUserId.get(aliasUser)! };
        outcome.via = "alias";
      } else {
        const resolved = resolvePerson(candidate, asMembers);
        if (resolved.kind === "resolved") {
          outcome.member = { userId: resolved.member.userId, name: resolved.member.name };
          outcome.via = "roster";
        } else if (resolved.kind === "ambiguous") {
          outcome.why = `"${candidate}" matches ${resolved.candidates.length} members`;
        } else if (resolved.kind === "not-a-person") {
          outcome.why = resolved.why;
        } else {
          outcome.why = `"${candidate}" matches no member`;
        }
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
