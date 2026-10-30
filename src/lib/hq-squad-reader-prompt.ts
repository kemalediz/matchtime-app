/**
 * THE HQ SQUAD READER'S PROMPT, SCHEMA AND ANSWER CHECK (2026-10-29). Pure:
 * no database and no model, so the unit tests and the live dry run
 * (scripts/dryrun-hq-squad-reader.ts) import exactly what production sends.
 *
 * WHY. FNF HQ, 29 Oct 18:04: an organiser pasted a copy of MatchTime's own
 * "Proposed teams" sheet (Non Bibs 1 to 9, Bibs 1 to 9). The deterministic
 * reader that stood here read the restarted numbering as the end of the
 * squad, took the 9 Non Bibs as the whole squad and proposed "Removing" the
 * 9 Bibs; the organiser's YES 8 seconds later dropped 9 confirmed players.
 * At 18:37 "Swap / 9 names / With / 9 names" was proposed as a squad with
 * two new players called "Swap" and "With". People never keep to a format,
 * so NOTHING here reads the text with code (Kemal, 2026-10-29, as for the
 * monthly reader): the model reads the message the way an organiser in the
 * group would, with the group's recent messages (MatchTime's own posts
 * among them), the squad and the teams as context, and says what it is.
 * Code only maps the refs it was shown back to ids, checks them, and gates
 * on facts (`gateSquadPaste` in `admin-group-squad-rules.ts`).
 *
 * Every answer is checked here: a ref it was not shown is no member, an
 * "out" must be a playing member who is not on the list, a name nobody has
 * must be a person's name that is in the message, and anything unreadable
 * is "other", which changes nothing.
 */
import { nowLine, quotedLines, type ContextMessage } from "./reply-context";

/** The header the message sits under in the user turn. */
export const HQ_SQUAD_READER_MESSAGE_HEADER = "THE MESSAGE:";
/** How many of the recent HQ messages are shown. */
export const HQ_SQUAD_READER_RECENT_LINES = 8;

export interface HqReaderMember {
  /** The short ref the model is shown ("p1"). Never a database id. */
  ref: string;
  userId: string;
  name: string;
  aliases: string[];
}

/** The club's context for one message (`loadHqSquadReaderContext`). */
export interface HqSquadReaderContext {
  orgId: string;
  /** The game a squad list would be for. Null: the club has none yet. */
  game: { label: string; places: number } | null;
  members: HqReaderMember[];
  /** User ids, in squad order. */
  squad: { playing: string[]; bench: string[] };
  /** The match's team sheet, when teams have been made. */
  teams: { state: "proposed" | "final"; sides: Array<{ label: string; userIds: string[] }> } | null;
}

export interface HqSquadReaderInput {
  body: string;
  sender: { userId: string | null; name: string | null };
  /** The recent HQ messages, oldest first, the message itself excluded.
   *  MatchTime's own lines have the author "MatchTime". */
  history: Array<{ author: string | null; body: string }>;
  /** The message this one replies to, when it is a reply. */
  reply: ContextMessage | null;
  now: Date;
}

export interface HqSquadLine {
  /** The name as the reader read it. */
  name: string;
  /** The member it is; null for a person nobody in the club is. */
  userId: string | null;
  section: "playing" | "bench";
}

export type HqSquadReading =
  | { kind: "other"; why: string }
  | { kind: "teams" }
  | {
      kind: "squad";
      lines: HqSquadLine[];
      /** Playing members the list leaves off on purpose (the reader's word). */
      out: string[];
    };

// ── The prompt ────────────────────────────────────────────────────────

export const HQ_SQUAD_READER_SYSTEM = `You read one message sent in a football club's admin group (the organisers' WhatsApp group, called HQ) for MatchTime, the club's bot. The message has several lines. Say what it is, and when it is the squad, who it lists.

THE CONTEXT comes first, and it does most of the work:
- NOW, the date and time at the club.
- THE NEXT GAME: its date and how many places it has.
- MEMBERS: everybody in the club, each with a ref (p1, p2 ...) and any nicknames.
- THE SQUAD AS MATCHTIME HAS IT: who is playing the next game and who is on the bench.
- THE TEAMS AS MATCHTIME HAS THEM, when teams have been made: each side and its players.
- RECENT HQ MESSAGES, oldest first, MatchTime's own posts among them, and the message replied to, if any.
Then THE MESSAGE and who sent it. Read it the way an organiser in the group would, with all of that in mind. Messages are English or Turkish, often mixed, misspelt, with emoji.

kind: what THE MESSAGE is.
- "squad": the list of who plays the next game, sent so that the squad becomes this list. One name per line, numbered or not, maybe with a bench part.
- "teams": anything about the teams or sides. A copy of a team sheet: two groups of names, often under the side names ("Bibs" and "Non Bibs", "Red" and "Yellow"), the numbering starting again for the second group, or MatchTime's own proposed teams pasted back. A swap or a move ("Swap" then names then "With" then names; these names to the other side). Names sent while the group is talking about the teams. When the names are the players of THE TEAMS, it is teams, whatever words are around them.
- "other": anything else: who has paid, kit, a vote, a conversation, a question.

FOR A SQUAD LIST (otherwise lines [] and out []):
- lines: every name on the list, in order. For each:
  name: the person's name as written, without numbers, notes or emoji.
  member: the ref of the member it is: their name, first name, nickname, or an obvious spelling of one. "" when it is nobody on MEMBERS, or when two members could be meant.
  section: "playing" for the main list; "bench" under a part such as "Bench", "Reserves", "Subs", "Yedekler".
  person: true when the line is somebody's name; false for anything else (a title, a time, a place, a word such as "Swap", "With" or "Bench").
- out: the refs of players PLAYING in THE SQUAD whom the list leaves off on purpose, because the list is the whole squad and they are no longer in it. Leave a player out of "out" when the list is not the whole squad, or when you cannot tell. Never a player who is on the list.

Examples (English | Turkish):
- "Friday 8pm\\n1. Bilal\\n2. Ali\\n3. Tom\\n4. Sam\\n5. Naim", with Shehryar and Clarence also playing in THE SQUAD and no Naim among MEMBERS | "Cuma 20:00\\n1. Bilal\\n2. Ali\\n3. Tom\\n4. Sam\\n5. Naim": squad; Naim member "", person true; out the refs of Shehryar and Clarence.
- "1. Ali\\n2. Burak\\n3. Can\\n\\nBench\\n4. Deniz" | "1. Ali\\n2. Burak\\n3. Can\\n\\nYedekler\\n4. Deniz": squad, Deniz section bench.
- "Here's the teams:\\n*Non Bibs*:\\n1. Feroz\\n2. Alamgir ...\\n*Bibs*:\\n1. Yorel\\n2. Maj ..." | "Takımlar:\\n*Kırmızı*:\\n1. Ali ...\\n*Sarı*:\\n1. Can ...": teams.
- "Swap\\nMo\\nMojib\\nAlamgir\\n\\nWith\\nHamzah\\nYorel\\nAkram" | "Değiştir\\nMo\\nMojib\\n\\nile\\nHamzah\\nYorel": teams.
- Eighteen names in two blocks, just after MatchTime posted the proposed teams or someone said "swap them over", the same players as THE TEAMS | the same in Turkish ("takımları değiştir"): teams.
- "Paid:\\nAli\\nBurak\\nCan" | "Ödeyenler:\\nAli\\nBurak\\nCan": other.

Output STRICT JSON only, no markdown, no fences.`;

const LINE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    member: { type: "string" },
    section: { type: "string", enum: ["playing", "bench"] },
    person: { type: "boolean" },
  },
  required: ["name", "member", "section", "person"],
  additionalProperties: false,
} as const;

/** Structured output. No nullable types: the API rejects them, so "", []
 *  and false mean "not so" (the extractors' convention). */
export const HQ_SQUAD_READER_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["squad", "teams", "other"] },
    lines: { type: "array", items: LINE_SCHEMA },
    out: { type: "array", items: { type: "string" } },
  },
  required: ["kind", "lines", "out"],
  additionalProperties: false,
} as const;

// ── The user turn ─────────────────────────────────────────────────────

function memberLine(m: HqReaderMember): string {
  const own = m.name.toLocaleLowerCase("tr");
  const aka = m.aliases.filter((a) => a && a.toLocaleLowerCase("tr") !== own);
  return `  ${m.ref}: ${m.name}${aka.length > 0 ? ` (also: ${aka.join(", ")})` : ""}`;
}

/** PURE. The context first, then the message. */
export function buildHqSquadReaderUserTurn(input: HqSquadReaderInput, ctx: HqSquadReaderContext): string {
  const byId = new Map(ctx.members.map((m) => [m.userId, m]));
  const who = (id: string) => {
    const m = byId.get(id);
    return m ? `${m.ref} ${m.name}` : "(not a member)";
  };
  const names = (list: string[]) => (list.length > 0 ? list.map(who).join(", ") : "nobody");
  const lines: string[] = [nowLine(input.now), ""];
  lines.push(ctx.game ? `THE NEXT GAME: ${ctx.game.label}, ${ctx.game.places} places.` : "THE NEXT GAME: none yet.", "");
  lines.push("MEMBERS:", ...ctx.members.map(memberLine), "");
  if (ctx.game) {
    lines.push(
      "THE SQUAD AS MATCHTIME HAS IT:",
      `  Playing (${ctx.squad.playing.length}): ${names(ctx.squad.playing)}`,
      `  Bench (${ctx.squad.bench.length}): ${names(ctx.squad.bench)}`,
      "",
    );
  }
  if (ctx.teams) {
    lines.push(`THE TEAMS AS MATCHTIME HAS THEM (${ctx.teams.state === "final" ? "final" : "proposed, still waiting for YES"}):`);
    for (const side of ctx.teams.sides) lines.push(`  ${side.label}: ${names(side.userIds)}`);
    lines.push("");
  }
  const recent = input.history.filter((h) => h.body !== input.body).slice(-HQ_SQUAD_READER_RECENT_LINES);
  if (recent.length > 0) {
    lines.push("RECENT HQ MESSAGES (context only):");
    for (const h of recent) lines.push(`  ${h.author ?? "(unknown)"}: ${h.body}`);
    lines.push("");
  }
  if (input.reply) lines.push(...quotedLines(input.reply), "");
  const sender = input.sender.userId ? byId.get(input.sender.userId) : undefined;
  lines.push(
    `From ${sender ? `${sender.name} (${sender.ref})` : `${input.sender.name ?? "somebody"} (not on the MEMBERS list)`}.`,
    HQ_SQUAD_READER_MESSAGE_HEADER,
    input.body.trim(),
  );
  return lines.join("\n");
}

// ── The answer, checked ───────────────────────────────────────────────

const OTHER = (why: string): HqSquadReading => ({ kind: "other", why });
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
/** For "is this name in the message?": case and width only. */
const fold = (s: string): string => s.normalize("NFKC").toLocaleLowerCase("tr");

/**
 * PURE. The model's JSON, checked against the context it was given. Never
 * throws: anything it cannot trust is left out, and an unreadable answer
 * is "other".
 */
export function parseHqSquadReading(raw: unknown, input: HqSquadReaderInput, ctx: HqSquadReaderContext): HqSquadReading {
  if (!raw || typeof raw !== "object") return OTHER("not an object");
  const o = raw as Record<string, unknown>;
  if (o.kind === "teams") return { kind: "teams" };
  if (o.kind !== "squad") return OTHER(o.kind === "other" ? "other" : "no valid kind");

  const byRef = new Map(ctx.members.map((m) => [m.ref, m.userId]));
  const body = fold(input.body);
  const lines: HqSquadLine[] = [];
  for (const l of Array.isArray(o.lines) ? o.lines : []) {
    if (!l || typeof l !== "object") continue;
    const x = l as Record<string, unknown>;
    const name = str(x.name).slice(0, 60);
    if (!name) continue;
    const section = x.section === "bench" ? "bench" : "playing";
    const ref = str(x.member);
    const userId = ref ? (byRef.get(ref) ?? null) : null;
    if (userId) {
      lines.push({ name, userId, section });
      continue;
    }
    // A ref it was not shown is nobody it can name; a name nobody has must
    // be a person's (the reader's word) and written in the message itself.
    if (ref || x.person !== true || !body.includes(fold(name))) continue;
    lines.push({ name, userId: null, section });
  }
  if (lines.length === 0) return OTHER("a squad with no lines");

  const listed = new Set(lines.flatMap((l) => (l.userId ? [l.userId] : [])));
  const playing = new Set(ctx.squad.playing);
  const out = [
    ...new Set(
      (Array.isArray(o.out) ? o.out : [])
        .map((r) => byRef.get(str(r)))
        .filter((id): id is string => !!id && playing.has(id) && !listed.has(id)),
    ),
  ];
  return { kind: "squad", lines, out };
}
