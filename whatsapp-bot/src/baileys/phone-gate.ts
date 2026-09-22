/**
 * The pre-cutover phone gate: does WhatsApp give us a phone for everyone?
 *
 * ── Why this exists ─────────────────────────────────────────────────
 * MatchTime identifies players by phone. Of Sutton FC's 74 members, 69
 * have one on record and ZERO have a LID stored. Baileys speaks LIDs, and
 * the only network path from a LID to a phone is `groupMetadata`'s
 * `phoneNumber` field (plan §2.7, path 2). If that path does not return a
 * usable phone for effectively all 69, every one of them becomes an
 * unmatched sender under Baileys, and the migration stops. Agreed between
 * Kemal and the reviewer, 2026-09-22.
 *
 * ── What it may do ──────────────────────────────────────────────────
 * ONE `groupMetadata` call on the given group, plus reads of Baileys'
 * LOCAL mapping store for any LID that came back without a phone
 * (`getPNForLID`, which has no network path at all). Nothing else: no
 * send, no mapping write, no database, no MatchTime API, no directory
 * lookup. `drivers/baileys.source.test.ts` pins all of that on this file
 * and on `scripts/measure-group-phones.ts`, which is the thin wrapper
 * that connects and calls `runPhoneGate`.
 *
 * ── Output ──────────────────────────────────────────────────────────
 * Fixed human lines (phones masked), then one `RESULT {json}` line for a
 * machine. See `formatPhoneGateReport`.
 */
import { bareUser, isLidJid, lidLookupJid, phoneFromJid } from "./jid.js";
import { legacyIdsOf, participantOf, participantPhone, type GroupMetaLike, type ParticipantLike } from "./groups.js";
import { legacyJid } from "./key.js";

export interface PhoneGateSummary {
  group: string;
  subject: string | null;
  addressingMode: string | null;
  participantsReturned: number;
  selfExcluded: number;
  counted: number;
  /** The id itself is a phone JID. */
  phoneAddressed: number;
  /** The id is a LID and WhatsApp returned `phoneNumber` beside it. */
  lidWithPhone: number;
  /** A LID with no phone from WhatsApp, but one in Baileys' local store. */
  lidOnlyLocal: number;
  /** A LID with no phone anywhere. */
  lidOnly: number;
  /** Neither a phone nor a LID. Should be zero. */
  other: number;
  /** Phones WhatsApp returned in this read (phoneAddressed + lidWithPhone). */
  returnedPhones: number;
  /** Every member we now have a phone for (returned + local store). */
  usable: number;
  knownSupplied: number;
  knownFound: number;
  knownMissing: string[];
  /** Usable phones in the group that are not in the supplied list. */
  groupPhonesNotKnown: number;
  verdict: "PASS" | "REVIEW" | "NONE";
}

/** One phone per line; digits only; blanks, `#` comments and short junk skipped. */
export function parseKnownPhones(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    // First field only, so a CSV of "phone,name" works.
    const digits = t.split(/[,;\t]/)[0].replace(/\D/g, "");
    if (digits.length < 6 || digits.length > 15) continue;
    if (!out.includes(digits)) out.push(digits);
  }
  return out;
}

/** `447700900999` to `4477*****999`. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return "*".repeat(phone.length);
  return `${phone.slice(0, 4)}${"*".repeat(phone.length - 7)}${phone.slice(-3)}`;
}

export function summarisePhoneGate(
  meta: GroupMetaLike,
  opts: { selfJids: string[]; knownPhones: string[]; localPhones: ReadonlyMap<string, string> },
): PhoneGateSummary {
  const self = new Set<string>();
  for (const j of opts.selfJids) {
    const l = legacyJid(j);
    if (l) self.add(l);
  }
  const s: PhoneGateSummary = {
    group: meta.id,
    subject: meta.subject ?? null,
    addressingMode: meta.addressingMode ?? null,
    participantsReturned: (meta.participants ?? []).length,
    selfExcluded: 0,
    counted: 0,
    phoneAddressed: 0,
    lidWithPhone: 0,
    lidOnlyLocal: 0,
    lidOnly: 0,
    other: 0,
    returnedPhones: 0,
    usable: 0,
    knownSupplied: opts.knownPhones.length,
    knownFound: 0,
    knownMissing: [],
    groupPhonesNotKnown: 0,
    verdict: "NONE",
  };
  const usablePhones = new Set<string>();
  for (const raw of meta.participants ?? []) {
    const p: ParticipantLike = participantOf(raw);
    if (legacyIdsOf(p).some((id) => self.has(id))) {
      s.selfExcluded++;
      continue;
    }
    s.counted++;
    if (phoneFromJid(p.id)) {
      s.phoneAddressed++;
      usablePhones.add(participantPhone(p) as string);
    } else if (isLidJid(p.id) && phoneFromJid(p.phoneNumber)) {
      s.lidWithPhone++;
      usablePhones.add(participantPhone(p) as string);
    } else if (isLidJid(p.id)) {
      const local = opts.localPhones.get(bareUser(p.id) ?? "");
      if (local) {
        s.lidOnlyLocal++;
        usablePhones.add(local);
      } else {
        s.lidOnly++;
      }
    } else {
      s.other++;
    }
  }
  s.returnedPhones = s.phoneAddressed + s.lidWithPhone;
  s.usable = s.returnedPhones + s.lidOnlyLocal;
  const known = new Set(opts.knownPhones);
  for (const k of opts.knownPhones) {
    if (usablePhones.has(k)) s.knownFound++;
    else s.knownMissing.push(k);
  }
  for (const p of usablePhones) if (!known.has(p)) s.groupPhonesNotKnown++;
  s.verdict = s.knownSupplied === 0 ? "NONE" : s.knownMissing.length === 0 ? "PASS" : "REVIEW";
  return s;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

function row(label: string, value: string | number, indent = 0): string {
  const l = `${" ".repeat(indent)}${label}:`;
  return `${l.padEnd(34)}${value}`;
}

export function formatPhoneGateReport(s: PhoneGateSummary): string {
  const lines = [
    `MatchTime phone gate: group ${s.group} ${JSON.stringify(s.subject ?? "")} (addressing: ${s.addressingMode ?? "?"})`,
    row("participants returned", s.participantsReturned),
    row("excluded (this bot)", s.selfExcluded, 2),
    row("counted", s.counted, 2),
    row("phone-addressed", s.phoneAddressed, 2),
    row("LID with phoneNumber", s.lidWithPhone, 2),
    row("LID only, phone in local store", s.lidOnlyLocal, 2),
    row("LID only, no phone", s.lidOnly, 2),
    row("neither phone nor LID", s.other, 2),
    row("phones returned by WhatsApp", `${s.returnedPhones} / ${s.counted} (${pct(s.returnedPhones, s.counted)})`),
    row("usable phone", `${s.usable} / ${s.counted} (${pct(s.usable, s.counted)})`),
    row("known org phones supplied", s.knownSupplied),
    row("found in the group", `${s.knownFound} / ${s.knownSupplied} (${pct(s.knownFound, s.knownSupplied)})`, 2),
    row(
      "NOT found",
      s.knownMissing.length === 0 ? "0" : `${s.knownMissing.length}  [${s.knownMissing.map(maskPhone).join(", ")}]`,
      2,
    ),
    row("group phones not in the list", s.groupPhonesNotKnown),
  ];
  // Rows use a fixed label column; the counts the gate is read from are
  // right after it, separated by spaces only.
  const verdict =
    s.verdict === "PASS"
      ? `VERDICT: PASS (all ${s.knownSupplied} known phones found)`
      : s.verdict === "REVIEW"
        ? `VERDICT: REVIEW (${s.knownMissing.length} known phone${s.knownMissing.length === 1 ? "" : "s"} not found)`
        : "VERDICT: NONE (no known phones supplied; pass --known-phones=<file>)";
  lines.push(verdict);
  const { knownMissing, ...rest } = s;
  lines.push(`RESULT ${JSON.stringify({ ...rest, knownMissingCount: knownMissing.length })}`);
  return `${lines.join("\n")}\n`;
}

/** The part of a socket the gate touches. Nothing that sends or writes. */
export interface PhoneGateSocket {
  user?: { id?: string | null; lid?: string | null } | null;
  groupMetadata(jid: string): Promise<GroupMetaLike>;
  signalRepository?: { lidMapping?: { getPNForLID(lid: string): Promise<string | null> } };
}

/**
 * Read the group once and summarise it. A failed read THROWS: a gate that
 * could not read the group must never print a verdict.
 */
export async function runPhoneGate(
  sock: PhoneGateSocket,
  opts: { groupJid: string; knownPhones: string[] },
): Promise<PhoneGateSummary> {
  const meta = await sock.groupMetadata(opts.groupJid);
  const localPhones = new Map<string, string>();
  const store = sock.signalRepository?.lidMapping;
  for (const raw of meta.participants ?? []) {
    const p = participantOf(raw);
    if (!isLidJid(p.id) || phoneFromJid(p.phoneNumber)) continue;
    // The FULL LID JID: Baileys' store skips a bare user part silently.
    const lookup = lidLookupJid(p.id);
    if (!lookup || !store) continue;
    try {
      const phone = phoneFromJid(await store.getPNForLID(lookup));
      if (phone) localPhones.set(lookup, phone);
    } catch {
      /* counted as LID only */
    }
  }
  const selfJids = [sock.user?.id, sock.user?.lid].filter((j): j is string => !!j);
  return summarisePhoneGate(meta, { selfJids, knownPhones: opts.knownPhones, localPhones });
}
