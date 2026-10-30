/**
 * THE PICK READER'S PROMPT, SCHEMA AND ANSWER CHECK (2026-10-30). Pure: no
 * database and no model, so the unit tests and the live dry run
 * (scripts/dryrun-organiser-pick-reader.ts) import exactly what production
 * sends.
 *
 * WHY. An organiser answers MatchTime's numbered bench list ("2 3", "1-3",
 * "all", "none", "Wasim and Sam", an @tag, YES to "bring them in anyway?").
 * Until 2026-10-30 code read that answer with word lists, a numbers regex
 * and name folding (`parsePickReply`). Kemal, 2026-10-30: "I don't want any
 * string parsing at all." Now the model reads the reply the way an
 * organiser would, with the list MatchTime sent (each row with a ref), the
 * squad, the club's other members, who each real @tag is, whether a YES
 * question is pending and, in HQ, the recent messages.
 *
 * Code only checks the ANSWER against facts: a list number must exist, a
 * ref must be one it was shown, YES counts only while a question is
 * pending, an ambiguous name must be in the message and fit two or more
 * people it was shown. Anything it cannot trust is "unclear" (P6 in a DM,
 * silence in HQ) or not a pick at all.
 */

/** The header the message sits under in the user turn. */
export const PICK_READER_MESSAGE_HEADER = "THE MESSAGE:";
/** How many recent HQ messages are shown. */
export const PICK_READER_RECENT_LINES = 6;

export interface PickReaderPerson {
  /** The short ref the model is shown ("p1"). Never a database id. */
  ref: string;
  userId: string;
  name: string;
}

export interface PickReaderContext {
  orgId: string;
  door: "dm" | "admin-group";
  /** The round's list as sent, in order: row n is `list[n - 1]`. */
  list: PickReaderPerson[];
  /** The match's confirmed players (a pick of one is E2). */
  confirmed: PickReaderPerson[];
  /** The club's other active members (a pick of one is E1). */
  others: PickReaderPerson[];
  /** MatchTime's instruction line under the list, in the club's language. */
  asked: string;
  /** The person an E1 "bring them in anyway? YES" question is about, while
   *  it is still answerable; null when no question is pending. */
  pending: PickReaderPerson | null;
  /** The real WhatsApp @tags in the message, as the server resolved them
   *  (structured mention data, never the text). */
  tags: Array<{ digits: string; ref: string | null; whatsappName: string | null }>;
}

export interface PickReaderInput {
  body: string;
  senderName: string | null;
  /** HQ only: the recent messages there, oldest first, the message itself
   *  excluded. MatchTime's own have the author "MatchTime". */
  history: Array<{ author: string | null; body: string }>;
}

/** What a reply means once checked (`handlePickReply` acts on it). */
export type PickReply =
  /** List rows (1-based) and people by ref, both checked. */
  | { kind: "pick"; positions: number[]; userIds: string[] }
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "yes" }
  /** E4: a real @tag MatchTime cannot identify. */
  | { kind: "unresolved-tag" }
  /** E5: a name that fits several candidates. */
  | { kind: "ambiguous"; first: string; names: string[] }
  /** P6 (a DM only): meant as a pick, but it does not work out. */
  | { kind: "not-understood" }
  /** Chat, or anything else: not ours. */
  | { kind: "not-a-pick" };

// ── The prompt ────────────────────────────────────────────────────────

export const PICK_READER_SYSTEM = `You read one message sent to MatchTime, a football club's WhatsApp bot. A place is open in the next game, and MatchTime sent the organisers a numbered list of the players on the bench, asking who should come in. Say whether THE MESSAGE answers that, and how.

THE CONTEXT comes first: THE LIST as MatchTime sent it (number, ref, name) and what it asked; THE SQUAD (players already in); OTHER MEMBERS of the club; who each @tag in the message is (a real WhatsApp tag shows in the message as @ and digits); whether MatchTime is waiting for a YES; in the admin group, the recent messages. Then THE MESSAGE. Messages are English or Turkish, often short, misspelt or mixed, sometimes with "@Match Time" in front.

kind:
- "pick": it says who comes in: list numbers ("2", "2 3", "1-3"), names or first names, tags, or a mix.
- "all": everyone on the list.
- "none": nobody, leave the place open.
- "yes": yes to MatchTime's waiting question. Only when one is waiting.
- "ambiguous": a pick by a name that fits two or more people shown, with nothing to tell them apart. A name that fits one person on THE LIST is that person.
- "unknown-tag": a pick that tags somebody the tags say is nobody in the club.
- "unclear": meant as a pick, but it does not work out: a number not on THE LIST, a name that is nobody shown.
- "other": anything else: talk about a player, a question, a reply to someone else, a yes when nothing is waiting.

positions: for "pick", the list numbers picked, a range written out; [] otherwise.
people: for "pick", the refs of people picked by name or tag (on THE LIST, in THE SQUAD or OTHER MEMBERS); [] otherwise. A number is always a position.
name: for "ambiguous", the name as written in the message; "" otherwise.
candidates: for "ambiguous", the refs it could be; [] otherwise.

Examples (English | Turkish):
- "2" | "2": pick, positions [2]. "2 and 3", "1-3" | "2 ve 3", "1-3": pick, positions [2, 3] and [1, 2, 3].
- "Wasim" | "Wasim gelsin": pick, people [Wasim's ref]. A tag of Wasim: the same.
- "all" | "hepsi": all. "none", "nobody", "leave it" | "hiçbiri", "kimse": none.
- "yes" | "evet", while MatchTime waits for a YES: yes. With nothing waiting: other.
- "Ali", with Ali Khan and Ali Demir both shown and neither alone on THE LIST | "Ali": ambiguous, name "Ali", candidates both refs.
- "9" with four on THE LIST, or "Wasim and Bob" with no Bob anywhere | "9", "Wasim ve Bob": unclear.
- "Wasim played well last week", "who's free on Friday?" | "Wasim geçen hafta iyi oynadı", "cuma kim boş?": other.

Output STRICT JSON only, no markdown, no fences.`;

/** Structured output. No nullable types: "", [] mean "not so". */
export const PICK_READER_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["pick", "all", "none", "yes", "ambiguous", "unknown-tag", "unclear", "other"] },
    positions: { type: "array", items: { type: "integer" } },
    people: { type: "array", items: { type: "string" } },
    name: { type: "string" },
    candidates: { type: "array", items: { type: "string" } },
  },
  required: ["kind", "positions", "people", "name", "candidates"],
  additionalProperties: false,
} as const;

// ── The user turn ─────────────────────────────────────────────────────

const row = (p: PickReaderPerson) => `${p.ref} ${p.name}`;
const people = (list: PickReaderPerson[]) => (list.length > 0 ? list.map(row).join(", ") : "nobody");

/** PURE. The context first, then the message. */
export function buildPickReaderUserTurn(input: PickReaderInput, ctx: PickReaderContext): string {
  const everyone = [...ctx.list, ...ctx.confirmed, ...ctx.others];
  const lines: string[] = [
    ctx.door === "admin-group" ? "WHERE: the club's admin group (HQ)." : "WHERE: a private message from an organiser.",
    "",
    "THE LIST MatchTime sent:",
    ...ctx.list.map((p, i) => `  ${i + 1}. ${row(p)}`),
    `MatchTime asked: ${ctx.asked}`,
    ctx.pending
      ? `WAITING FOR YES: MatchTime asked whether to bring in ${row(ctx.pending)}, who is not on THE LIST, anyway.`
      : "WAITING FOR YES: nothing.",
    "",
    `THE SQUAD: ${people(ctx.confirmed)}`,
    `OTHER MEMBERS: ${people(ctx.others)}`,
  ];
  if (ctx.tags.length > 0) {
    lines.push("", "TAGS IN THE MESSAGE:");
    for (const tg of ctx.tags) {
      const who = tg.ref ? everyone.find((p) => p.ref === tg.ref) : undefined;
      lines.push(
        who
          ? `  @${tg.digits} is ${row(who)}`
          : `  @${tg.digits} is nobody in the club${tg.whatsappName ? ` (their own WhatsApp name: ${tg.whatsappName})` : ""}`,
      );
    }
  }
  const recent = input.history.slice(-PICK_READER_RECENT_LINES);
  if (recent.length > 0) {
    lines.push("", "RECENT MESSAGES HERE (context only):");
    for (const h of recent) lines.push(`  ${h.author ?? "(unknown)"}: ${h.body}`);
  }
  lines.push("", `From ${input.senderName ?? "an organiser"}.`, PICK_READER_MESSAGE_HEADER, input.body.trim());
  return lines.join("\n");
}

// ── The answer, checked ───────────────────────────────────────────────

const NOT_A_PICK: PickReply = { kind: "not-a-pick" };
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** For "is this name in the message?": case and width only. */
const fold = (s: string): string => s.normalize("NFKC").toLocaleLowerCase("tr");

/**
 * PURE. The model's JSON, checked against the context it was given. Never
 * throws. "unclear", or a pick that does not check out, is P6 in a DM and
 * not a pick in HQ (its admins talk to each other).
 */
export function parsePickReading(raw: unknown, input: PickReaderInput, ctx: PickReaderContext): PickReply {
  const unclear: PickReply = ctx.door === "dm" ? { kind: "not-understood" } : NOT_A_PICK;
  if (!raw || typeof raw !== "object") return NOT_A_PICK;
  const o = raw as Record<string, unknown>;
  const byRef = new Map([...ctx.list, ...ctx.confirmed, ...ctx.others].map((p) => [p.ref, p]));
  switch (o.kind) {
    case "all":
      return ctx.list.length > 0 ? { kind: "all" } : unclear;
    case "none":
      return { kind: "none" };
    case "yes":
      return ctx.pending ? { kind: "yes" } : NOT_A_PICK;
    case "unknown-tag":
      return { kind: "unresolved-tag" };
    case "unclear":
      return unclear;
    case "ambiguous": {
      const said = str(o.name).slice(0, 40);
      const names = [...new Set(arr(o.candidates).map((r) => byRef.get(str(r))?.name).filter((n): n is string => !!n))];
      if (!said || names.length < 2 || !fold(input.body).includes(fold(said))) return unclear;
      return { kind: "ambiguous", first: said, names };
    }
    case "pick": {
      const rawPositions = arr(o.positions);
      const rawPeople = arr(o.people);
      const onList = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= ctx.list.length;
      // A number off the list or a ref it was not shown: the pick does not
      // check out, so nothing of it is applied.
      if (!rawPositions.every(onList) || !rawPeople.every((r) => byRef.has(str(r)))) return unclear;
      const positions = [...new Set(rawPositions.filter(onList))];
      const userIds = [...new Set(rawPeople.map((r) => byRef.get(str(r))!.userId))];
      if (positions.length === 0 && userIds.length === 0) return unclear;
      return { kind: "pick", positions, userIds };
    }
    default:
      return NOT_A_PICK;
  }
}
