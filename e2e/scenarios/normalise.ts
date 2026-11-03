/**
 * A CLUB SCENARIO'S TRANSCRIPT, NORMALISED. Pure: no I/O.
 *
 * The rehearsal driver collects events (every message in, everything
 * MatchTime sent, every database change). This turns them into the JSON
 * that is committed and compared between two branches: one entry per
 * scenario step, holding everything that happened from that step until the
 * next, in terms that are the same from one run to the next.
 *
 *   ids        a known id becomes its label (a member's key, a game's local
 *              kickoff, "<club>", "<month 2026-11>"); any other database id
 *              becomes "<id>"
 *   links      host and kind kept, the token masked ("/r/<tok>")
 *   times      local "YYYY-MM-DD HH:mm" in the club's zone; ISO instants
 *              lose their seconds
 *   people     a member's key ("@cal"), never a phone number
 */
import { normaliseVolatileText } from "./cassette";
import type { Step } from "../rehearsal/scenario";
import { formatLocal } from "../rehearsal/scenario";
import type { Channel, RehearsalEvent } from "../rehearsal/transcript";

export interface OutMessage {
  at: string;
  /** "group <key>", "dm @member", "dm +phone" (someone not in the scenario). */
  to: string;
  kind: "out" | "graphic" | "react" | "blocked";
  text: string;
  /** Which scheduler instruction (due-posts) or route reply it came from. */
  instruction?: string;
  via?: string;
  key?: string;
  mentions?: string[];
  image?: string;
  /** The message it answers or reacts to. */
  replyTo?: string;
}

export interface TranscriptStep {
  seq: number;
  /** One line: when, where, who, what. */
  step: string;
  out: OutMessage[];
  /** How MatchTime handled each message that came in under this step. */
  handled: string[];
  db: string[];
  errors: string[];
}

export interface ClubTranscript {
  version: 1;
  club: string;
  title: string;
  mode: string;
  steps: TranscriptStep[];
  /** The final normalised database snapshot. */
  final: Record<string, string>;
}

/** Ids to labels, longest first so an id that contains another never half-matches. */
export function relabelText(text: string, labels: Map<string, string>): string {
  let t = text;
  const ids = [...labels.keys()].filter((id) => id.length >= 8).sort((a, b) => b.length - a.length);
  for (const id of ids) if (t.includes(id)) t = t.split(id).join(labels.get(id)!);
  // A squad fingerprint hashes the members' user ids (roster-shown.ts), which
  // are new every run: the squad itself is in the snapshot, the hash is noise.
  t = t.replace(/(:(?:roster-shown|month-list):)[0-9a-f]{16}\b/g, "$1<squad>");
  // An epoch-milliseconds stamp in a key (2020 to 2033) is the server's
  // clock, which runs on within a step: kept to the minute.
  t = t.replace(/(?<!\d)1[6-9]\d{11}(?!\d)/g, (ms) => String(Math.floor(Number(ms) / 60_000) * 60_000));
  return normaliseVolatileText(t);
}

function channelName(c: Channel, members: Record<string, string>): string {
  if ("group" in c) return `group ${c.group}`;
  if ("dm" in c) return members[c.dm] ? `dm @${members[c.dm]}` : `dm +${c.dm}`;
  return "system";
}

function describeStep(s: Step, tz: string): string {
  const when = formatLocal(s.at, tz);
  switch (s.do) {
    case "message":
      return `${when} ${s.group} @${s.from}${s.tag ? " [tag]" : ""}${s.media ? ` [${s.media}]` : ""}: ${JSON.stringify(s.body)}`;
    case "dm":
      return `${when} dm @${s.from}: ${JSON.stringify(s.body)}`;
    case "note":
      return `${when} note: ${s.text}`;
    case "vote":
      return `${when} vote @${s.from}: /${s.poll}/ → ${s.option === null ? "(clear)" : `/${s.option}/`}`;
    case "react":
      return `${when} react @${s.from} ${s.emoji} on /${s.target}/`;
    case "rate":
      return `${when} rate @${s.from}${s.mom ? ` MoM /${s.mom}/` : ""}`;
    case "settings":
      return `${when} settings ${JSON.stringify(s.values)}`;
    case "match":
      return `${when} match ${JSON.stringify(s.values)}`;
    case "club-live":
      return `${when} club-live (${s.liveDaysAgo} days)`;
    case "cron":
      return `${when} cron ${s.path}`;
    default:
      return `${when} ${s.do}`;
  }
}

export function buildTranscript(input: {
  club: string;
  title: string;
  mode: string;
  timezone: string;
  steps: Step[];
  events: RehearsalEvent[];
  labels: Map<string, string>;
  /** Bare phone → member key. */
  members: Record<string, string>;
  final: Record<string, string>;
}): ClubTranscript {
  const { events, labels, members, timezone: tz } = input;
  const norm = (s: string | undefined) => relabelText(s ?? "", labels);
  const who = (from: string | undefined) =>
    !from ? "?" : from === "matchtime" || from === "platform" || from === "runner" || from === "approver" ? from : `@${from}`;

  const frames = new Map<number, TranscriptStep>();
  frames.set(-1, { seq: -1, step: "before the first step", out: [], handled: [], db: [], errors: [] });
  for (const s of input.steps) frames.set(s.seq, { seq: s.seq, step: describeStep(s, tz), out: [], handled: [], db: [], errors: [] });

  events.forEach((e) => {
    const f = frames.get(e.frame ?? -1) ?? frames.get(-1)!;
    const at = formatLocal(e.at, tz);
    if (e.kind === "out" || e.kind === "graphic" || e.kind === "react" || e.kind === "blocked") {
      const meta = e.meta ?? {};
      const target = e.replyTo !== undefined ? events[e.replyTo] : undefined;
      const msg: OutMessage = { at, to: channelName(e.channel, members), kind: e.kind, text: norm(e.text) };
      if (typeof meta.instruction === "string") msg.instruction = meta.instruction;
      if (typeof meta.via === "string") msg.via = meta.via;
      if (meta.key !== undefined && meta.key !== null) msg.key = norm(String(meta.key));
      if (Array.isArray(meta.mentions) && meta.mentions.length) msg.mentions = (meta.mentions as unknown[]).map(String);
      if (e.image) msg.image = norm(e.image);
      if (target) msg.replyTo = `${who(target.from)}: ${norm(target.text).replace(/\s+/g, " ").slice(0, 60)}`;
      f.out.push(msg);
    } else if (e.kind === "in") {
      const meta = e.meta ?? {};
      const handled =
        typeof meta.handledBy === "string" ? meta.handledBy : meta.seen === false ? `not seen (${String(meta.why ?? "")})` : null;
      if (handled !== null)
        f.handled.push(`${who(e.from)} in ${channelName(e.channel, members).replace(/^group /, "")}: ${JSON.stringify(norm(e.text))} → ${norm(handled)}`);
    } else if (e.kind === "db") {
      f.db.push(...norm(e.text).split("\n"));
    } else if (e.kind === "error") {
      f.errors.push(norm(e.text).split("\n")[0]);
    }
  });

  const final: Record<string, string> = {};
  for (const k of Object.keys(input.final).sort()) final[norm(k)] = norm(input.final[k]);

  return {
    version: 1,
    club: input.club,
    title: input.title,
    mode: input.mode,
    steps: [...frames.values()].sort((a, b) => a.seq - b.seq),
    final,
  };
}
