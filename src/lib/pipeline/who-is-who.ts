/**
 * WHO IS WHO: the model picks which member a name in a WhatsApp message
 * means (2026-11-09, Kemal: "never use string matching"; option B).
 *
 * WHY. Vets MNF, 2026-11-09 14:42: the owner posted "David - Kemal's son,
 * is on the bench". The attendance extractor read the claim correctly
 * (personRef "David", a named other person), and then CODE decided who
 * "David" was: a first-name near miss in `identity.ts` matched the member
 * Davide De Sousa, CONFIRMED for that night, and benched him. PR #570
 * removed that guess, and with it the useful ones ("habibi" for Habib,
 * "Moham" for Mohammed, "Davdie" for Davide). Spelling cannot tell those
 * apart; the message can. So code no longer matches names at all: the
 * model is shown the club's members (each with a short ref) and the
 * message, and says for each name the extractor quoted whether it is one
 * member, nobody in the club, or one of several. Code only checks that a
 * ref it gets back is one it showed, and acts on ids.
 *
 * ONE CALL PER BATCH, NOT PER NAME. Every message in a batch that names
 * somebody goes into the same call (a pasted list is one message with
 * many names), and a batch that names nobody makes no call at all: most
 * traffic is "IN" and "out" about the sender, who is known by phone.
 *
 * THE SAFEGUARD. "member" is the model's answer only when it is sure;
 * when it thinks a member is probably meant but the message leaves room
 * for doubt it answers "ambiguous" with that member as the one candidate.
 * Code treats every "ambiguous" as it always treated two members with the
 * same name: nothing is written and the sender is asked who they mean. So
 * a member moves only on a sure pick, never on a likeness of spelling.
 *
 * FAIL CLOSED. A failed call, the daily cap, an unreadable answer, a ref
 * it was not shown, or a name it did not answer for: that name is
 * "unidentified", which resolves nobody and provisions nobody (the
 * engine reads it as an ambiguity).
 *
 * Pure apart from `modelPersonPicker`'s one model call. The prompt,
 * schema, user turn and parser are exported for the unit tests and the
 * paid check (`scripts/live-check-who-is-who.ts`). Old and new side by
 * side: MDs/prompt-change-roster-pick-2026-11-09.md.
 */
import type { Facts, Member } from "./types";
import { extractJson, HAIKU_CALL, type ModelCall, type ModelResponse, type PipelineModel } from "./llm";
import { refKey } from "../person-ref-key";

// ── What a pick is ────────────────────────────────────────────────────

export type PersonPick =
  /** The model is sure the name is this member. */
  | { kind: "member"; userId: string }
  /** Nobody on the roster it was shown. */
  | { kind: "none" }
  /** One of these, or (one candidate) probably this one: never written. */
  | { kind: "ambiguous"; userIds: string[] }
  /** No answer could be had for it (a failed call, an unshown ref). */
  | { kind: "unidentified"; why: string };

/** One message's picks, keyed by `refKey` of the name as quoted. */
export type PersonPicks = ReadonlyMap<string, PersonPick>;

/** The key a quoted name is filed under (`person-ref-key.ts`). */
export { refKey };

/** A member as the picker is shown them. `former`: left the club (shown
 *  only where a former member may be brought back, e.g. a pasted list). */
export interface WhoRosterMember {
  userId: string;
  name: string;
  aliases?: readonly string[];
  former?: boolean;
}

export interface WhoMessage {
  /** The caller's id for the message; picks come back under it. */
  id: string;
  body: string;
  /** The sender's name as the group shows it, or null. */
  author: string | null;
  /** The sender's member id, when known: shown as their ref. */
  senderUserId?: string | null;
  /** The names to identify, as quoted. Repeats are asked once. */
  refs: string[];
}

export interface WhoRequest {
  roster: ReadonlyArray<WhoRosterMember>;
  messages: WhoMessage[];
  /** Where the names come from, in a few words, for the model
   *  ("the players' group", "a squad list pasted in the players' group"). */
  where?: string;
}

export interface WhoResult {
  /** messageId → (refKey → pick). Every asked name has an entry. */
  picks: Map<string, Map<string, PersonPick>>;
  /** Null when no call was made. */
  usage: Pick<ModelResponse, "usage" | "costUsd" | "ms"> | null;
  degradations: string[];
}

export type PersonPicker = (req: WhoRequest) => Promise<WhoResult>;

// ── The prompt ────────────────────────────────────────────────────────

/**
 * TEST-ONLY seam: when "1", `personPickerFor` uses `stubPersonPicker`.
 * Set by the unit-test setup (`e2e/helpers/unit-model-guard.setup.ts`),
 * never in production; a live e2e run refuses to start with it set
 * (`e2e/helpers/live-llm.ts`). The stubbed e2e suite needs nothing: the
 * extractor stub seam implies it.
 */
export const PERSON_PICKER_STUB_ENV = "MT_TEST_PERSON_PICKER_STUB";

export const WHO_IS_WHO_CALL: ModelCall = HAIKU_CALL;
const LABEL = "who-is-who";
/** About 25 names with Haiku's thinking fits well inside this. */
const MAX_TOKENS = 3_072;

export const WHO_IS_WHO_SYSTEM = `You work out who the people named in WhatsApp messages are, for MatchTime, the assistant that runs a football club's games in its WhatsApp groups. Another reader has already picked out the names that matter in each message. Your one job is to say, for each name, which member of the club it is, or that it is nobody in the club.

THE CONTEXT comes first, in the user turn:
- WHERE the messages were sent.
- MEMBERS: everybody in the club, each with a ref (p1, p2 ...), their full name, and any nicknames the club has recorded for them ("also: ..."). A member marked (former) has left the club.
- Then each message: its id (m1, m2 ...), who sent it (with their ref when they are a member), the text, and NAMES TO IDENTIFY, each with an id (n1, n2 ...) and the words exactly as quoted from the message.
Read each name the way a member of the group would, with the whole message in mind. Messages are English or Turkish, often mixed, misspelt, with emoji.

For each name, verdict is one of:
- "member": you are sure it is one particular member. Put their ref in member. A member is named by their full name, first name or surname, a nickname listed for them, an obvious nickname or shortening of their name ("habibi" for Habib, "Moham" for Mohammed), or a plain misspelling of it ("Davdie" for Davide), and the message gives no sign it means somebody else.
- "none": nobody on MEMBERS. That includes a different name that only looks like a member's: David is not Davide, Sami is not Samir, Daniel is not Daniela, unless a nickname listed or the message itself says it is that member. It includes somebody the message describes as an outsider ("David, Kemal's son", "my brother Ali", "a mate from work, Tom") when no member has that name.
- "ambiguous": more than one member could be meant and the message does not say which (two members called David, and it says just "David"), or one member is probably meant but you are not sure. Put every member it could be in candidates.
member is "" unless the verdict is "member"; candidates is [] unless it is "ambiguous". Never use a ref that is not on MEMBERS. Answer every name, once, under its id.

Examples (English | Turkish):
Member:
- "Tom out" | "Tom yok", MEMBERS has Tom Hughes and no other Tom: member, Tom Hughes.
- "habibi is in" | "habibi geliyor", MEMBERS has Habib Karimi: member, Habib Karimi.
- "Moham can't make it" | "Moham gelemiyor", MEMBERS has Mohammed Iqbal: member, Mohammed Iqbal.
- "Davdie is out" | "Davdie yok", MEMBERS has Davide Russo: member, Davide Russo.
- "AH in" | "AH var", MEMBERS has Abdul-Hamid Khan (also: ah): member, Abdul-Hamid Khan.
- "my dad Najib is coming too" | "babam Najib de geliyor", MEMBERS has Najib Sharif: member, Najib Sharif.
- "Ul Haq is out" | "Ul Haq yok", MEMBERS has Imran Ul Haq: member, Imran Ul Haq.
None:
- "David - Kemal's son, is on the bench" | "David, Kemal'in oğlu, yedekte", MEMBERS has Davide Russo and no David: none.
- "my brother Ali is coming" | "kardeşim Ali geliyor", no Ali on MEMBERS: none.
- "Sami is out" | "Sami yok", MEMBERS has Samir Khan and no Sami: none.
Ambiguous:
- "David is in" | "David geliyor", MEMBERS has David Aksoy and David Russo: ambiguous, both refs.
- "Mo's in" | "Mo var", MEMBERS has Mohammed Iqbal and Mojib Rahimi and no nickname Mo: ambiguous, both refs.

Output STRICT JSON only, no markdown, no fences.`;

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    verdict: { type: "string", enum: ["member", "none", "ambiguous"] },
    member: { type: "string" },
    candidates: { type: "array", items: { type: "string" } },
  },
  required: ["id", "verdict", "member", "candidates"],
  additionalProperties: false,
} as const;

/** Structured output. No nullable types ("" and [] mean "not so"). */
export const WHO_IS_WHO_SCHEMA = {
  type: "object",
  properties: { people: { type: "array", items: ANSWER_SCHEMA } },
  required: ["people"],
  additionalProperties: false,
} as const;

// ── The user turn ─────────────────────────────────────────────────────

/** What the model is shown, and how its short ids map back. */
export interface WhoTurn {
  user: string;
  /** p-ref → userId. */
  memberByRef: Map<string, string>;
  /** n-id → { messageId, key }. */
  nameById: Map<string, { messageId: string; key: string }>;
}

function memberLine(ref: string, m: WhoRosterMember): string {
  const own = m.name.toLocaleLowerCase("tr");
  const aka = (m.aliases ?? []).filter((a) => a && a.toLocaleLowerCase("tr") !== own);
  return `  ${ref}: ${m.name}${aka.length > 0 ? ` (also: ${aka.join(", ")})` : ""}${m.former ? " (former)" : ""}`;
}

/** PURE. The roster first (stable refs in roster order), then each
 *  message with its names. Messages that name nobody are left out. */
export function buildWhoIsWhoTurn(req: WhoRequest): WhoTurn {
  const memberByRef = new Map<string, string>();
  const refOf = new Map<string, string>();
  const lines: string[] = [`WHERE: ${req.where ?? "the club's WhatsApp group"}.`, "", "MEMBERS:"];
  for (const m of req.roster) {
    if (!m.name?.trim() || refOf.has(m.userId)) continue;
    const ref = `p${memberByRef.size + 1}`;
    memberByRef.set(ref, m.userId);
    refOf.set(m.userId, ref);
    lines.push(memberLine(ref, m));
  }
  if (memberByRef.size === 0) lines.push("  (nobody yet)");
  lines.push("");
  const nameById = new Map<string, { messageId: string; key: string }>();
  let mi = 0;
  for (const msg of req.messages) {
    const keys = [...new Set(msg.refs.map(refKey).filter(Boolean))];
    if (keys.length === 0) continue;
    mi++;
    const senderRef = msg.senderUserId ? refOf.get(msg.senderUserId) : undefined;
    const from = senderRef
      ? `${msg.author ?? "a member"} (${senderRef})`
      : `${msg.author ?? "somebody"} (not on MEMBERS)`;
    lines.push(`MESSAGE m${mi}, from ${from}:`, msg.body.trim(), "NAMES TO IDENTIFY:");
    for (const key of keys) {
      const id = `n${nameById.size + 1}`;
      nameById.set(id, { messageId: msg.id, key });
      lines.push(`  ${id}: "${key}"`);
    }
    lines.push("");
  }
  return { user: lines.join("\n").trimEnd(), memberByRef, nameById };
}

// ── The answer, checked ───────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * PURE. The model's JSON, checked against what it was shown. Never
 * throws. A ref it was not shown is no member; a name it did not answer
 * for (or answered twice, differently) is unidentified.
 */
export function parseWhoIsWho(raw: unknown, turn: WhoTurn): Map<string, Map<string, PersonPick>> {
  const out = new Map<string, Map<string, PersonPick>>();
  const seen = new Map<string, PersonPick>();
  const conflicted = new Set<string>();
  const people = raw && typeof raw === "object" && Array.isArray((raw as { people?: unknown }).people)
    ? ((raw as { people: unknown[] }).people)
    : [];
  for (const p of people) {
    if (!p || typeof p !== "object") continue;
    const x = p as Record<string, unknown>;
    const id = str(x.id);
    if (!turn.nameById.has(id)) continue;
    let pick: PersonPick;
    if (x.verdict === "member") {
      const userId = turn.memberByRef.get(str(x.member));
      pick = userId ? { kind: "member", userId } : { kind: "unidentified", why: `answered with a ref it was not shown ("${str(x.member)}")` };
    } else if (x.verdict === "none") {
      pick = { kind: "none" };
    } else if (x.verdict === "ambiguous") {
      const ids = (Array.isArray(x.candidates) ? x.candidates : [])
        .map((c) => turn.memberByRef.get(str(c)))
        .filter((u): u is string => !!u);
      pick = { kind: "ambiguous", userIds: [...new Set(ids)] };
    } else {
      pick = { kind: "unidentified", why: "no valid verdict" };
    }
    const prev = seen.get(id);
    if (prev && JSON.stringify(prev) !== JSON.stringify(pick)) conflicted.add(id);
    seen.set(id, pick);
  }
  for (const [id, { messageId, key }] of turn.nameById) {
    const pick: PersonPick = conflicted.has(id)
      ? { kind: "unidentified", why: "answered twice, differently" }
      : (seen.get(id) ?? { kind: "unidentified", why: "not answered" });
    if (!out.has(messageId)) out.set(messageId, new Map());
    out.get(messageId)!.set(key, pick);
  }
  return out;
}

/** Every asked name, unidentified for one reason (a failed call). */
function allUnidentified(turn: WhoTurn, why: string): Map<string, Map<string, PersonPick>> {
  const out = new Map<string, Map<string, PersonPick>>();
  for (const { messageId, key } of turn.nameById.values()) {
    if (!out.has(messageId)) out.set(messageId, new Map());
    out.get(messageId)!.set(key, { kind: "unidentified", why });
  }
  return out;
}

// ── The pickers ───────────────────────────────────────────────────────

/** THE production picker: one model call for the whole request, none
 *  when it names nobody. */
export function modelPersonPicker(model: PipelineModel): PersonPicker {
  return async (req) => {
    const turn = buildWhoIsWhoTurn(req);
    if (turn.nameById.size === 0) return { picks: new Map(), usage: null, degradations: [] };
    try {
      const resp = await model.complete({
        ...WHO_IS_WHO_CALL,
        system: WHO_IS_WHO_SYSTEM,
        user: turn.user,
        maxTokens: MAX_TOKENS,
        schema: WHO_IS_WHO_SCHEMA as unknown as Record<string, unknown>,
        label: LABEL,
      });
      let raw: unknown;
      try {
        raw = extractJson(resp.text);
      } catch (err) {
        return {
          picks: allUnidentified(turn, "the answer could not be parsed"),
          usage: resp,
          degradations: [`who-is-who: the answer could not be parsed (${(err as Error).message})`],
        };
      }
      const picks = parseWhoIsWho(raw, turn);
      const degradations: string[] = [];
      for (const [mid, m] of picks) {
        for (const [key, p] of m) if (p.kind === "unidentified") degradations.push(`who-is-who ${mid}: "${key}" ${p.why}`);
      }
      return { picks, usage: resp, degradations };
    } catch (err) {
      return {
        picks: allUnidentified(turn, "the call failed"),
        usage: null,
        degradations: [`who-is-who: the call failed (${(err as Error).message ?? String(err)})`],
      };
    }
  };
}

/**
 * TEST AND STUBBED-SIM ONLY: a stand-in for the model on the cases a
 * test means plainly, so a stubbed suite can drive a third-party claim
 * without spending money. A name that is a member's whole name, an alias
 * of theirs, or their first name, for exactly one member, is that
 * member; two such members are ambiguous; anything else is nobody.
 * Never reached in production: `personPickerFor` picks it only when the
 * extractor stub seam is set, and a test passes it explicitly.
 */
export function stubPersonPicker(): PersonPicker {
  return async (req) => ({ picks: stubPicks(req), usage: null, degradations: [] });
}

/** Synchronous core of `stubPersonPicker`, for the engine tests. */
export function stubPicks(req: WhoRequest): Map<string, Map<string, PersonPick>> {
  const fold = (s: string) =>
    s.toLocaleLowerCase("tr").replace(/ı/g, "i").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
  const out = new Map<string, Map<string, PersonPick>>();
  for (const msg of req.messages) {
    for (const key of new Set(msg.refs.map(refKey).filter(Boolean))) {
      const k = fold(key);
      const whole = req.roster.filter((m) => fold(m.name) === k || (m.aliases ?? []).some((a) => fold(a) === k));
      const hits = whole.length > 0 ? whole : req.roster.filter((m) => fold(m.name).split(" ")[0] === k.split(" ")[0]);
      const pick: PersonPick =
        hits.length === 1
          ? { kind: "member", userId: hits[0].userId }
          : hits.length > 1
            ? { kind: "ambiguous", userIds: hits.map((h) => h.userId) }
            : { kind: "none" };
      if (!out.has(msg.id)) out.set(msg.id, new Map());
      out.get(msg.id)!.set(key, pick);
    }
  }
  return out;
}

// ── What the extractors quoted ────────────────────────────────────────

/**
 * EVERY NAME A MESSAGE'S FACTS QUOTE THAT CODE WILL LOOK UP, read from
 * the structured facts (never from the text): third-party attendance
 * claims and who they replace, the person a question is about, the
 * teams' includes, pins, pairings and moves, a payment's payer and who
 * it covers, and a score's Man of the Match. A claim the extractor read
 * as a relation, a group or a placeholder is never looked up, so it is
 * not asked about. First-person words ("me", "ben") are the sender, which
 * code already knows, and are passed over by the caller's `isSelf`.
 */
export function personRefsIn(facts: Facts, isSelf: (ref: string) => boolean = () => false): string[] {
  const refs: string[] = [];
  const add = (r: string | null | undefined) => {
    const k = refKey(r ?? "");
    if (k && !isSelf(k)) refs.push(k);
  };
  switch (facts.kind) {
    case "attendance":
      for (const c of facts.claims) {
        if (c.subject !== "sender") {
          const kind = c.personKind ?? (c.personNamed ? "named" : "placeholder");
          if (kind === "named") add(c.personRef);
        }
        add(c.replaces);
      }
      break;
    case "question":
      add(facts.personRef);
      break;
    case "teams":
      for (const r of facts.includeRefs ?? []) add(r);
      for (const s of facts.swaps ?? []) add(s.personRef);
      for (const g of facts.pairings ?? []) for (const r of g) add(r);
      for (const r of facts.moves ?? []) add(r);
      break;
    case "score":
      add(facts.momRef);
      break;
    case "admin":
      add(facts.payerRef);
      for (const r of facts.coveredRefs ?? []) add(r);
      break;
    default:
      break;
  }
  return [...new Set(refs)];
}

/** A `Member` roster as the picker is shown it. */
export function whoRosterOf(roster: ReadonlyArray<Member>): WhoRosterMember[] {
  return roster.map((m) => ({ userId: m.userId, name: m.name, aliases: m.aliases ?? [] }));
}
