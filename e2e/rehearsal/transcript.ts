/**
 * THE REHEARSAL TRANSCRIPT: every message in and everything MatchTime did,
 * in time order, as HTML (WhatsApp-like, one panel per group and per DM)
 * and Markdown. Pure: the runner collects events, this renders them.
 */
import type { ScenarioGroup } from "./scenario";
import { formatLocal } from "./scenario";

export type Channel = { group: string } | { dm: string } | { system: true };

export type EventKind =
  | "in" //       someone wrote (meta.seen === false: MatchTime never saw it)
  | "out" //      MatchTime posted text
  | "react" //    MatchTime reacted to a message (a tick)
  | "graphic" //  MatchTime posted an image
  | "blocked" //  MatchTime tried to post but the Pi's postability gate refused
  | "db" //       the database changed
  | "note" //     a heading from the scenario
  | "error" //    a request failed
  | "info"; //    something the runner did or saw (a cron, a setup action)

export interface RehearsalEvent {
  at: Date;
  channel: Channel;
  kind: EventKind;
  /** Member key, "matchtime", "platform" (MatchTime's sign-up number) or "runner". */
  from?: string;
  text?: string;
  /** Path of a saved image, relative to the transcript. */
  image?: string;
  /** An attachment the message had ("image", "gif", ...). */
  media?: string;
  /** Index (in the event list) of the message this answers or reacts to. */
  replyTo?: number;
  meta?: Record<string, unknown>;
}

export interface SummaryContext {
  groups: ScenarioGroup[];
  /** Member key or phone -> display name. */
  names: Record<string, string>;
  organisersAnnounce: boolean;
}

export interface Summary {
  perGroup: Record<string, { posts: number; reactions: number; graphics: number; blocked: number }>;
  dmsByRecipient: Record<string, number>;
  mainChatViolations: RehearsalEvent[];
  errors: RehearsalEvent[];
}

const isGroup = (c: Channel): c is { group: string } => "group" in c;
const isDm = (c: Channel): c is { dm: string } => "dm" in c;

// ── DB state ──────────────────────────────────────────────────────────

/** "key: before → after" for every key whose value changed, sorted. */
export function diffSnapshots(prev: Record<string, string>, next: Record<string, string>): string[] {
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort();
  const out: string[] = [];
  for (const k of keys) {
    const a = prev[k];
    const b = next[k];
    if (a === b) continue;
    out.push(`${k}: ${a === undefined ? "(new)" : a}${a === undefined ? " " : " → "}${b === undefined ? "(gone)" : b}`);
  }
  return out;
}

// ── Summary ───────────────────────────────────────────────────────────

/**
 * In organisers mode nothing but ticks is expected in the players' group.
 * A post that LISTS the squad or the teams is the thing the setting exists
 * to stop; any other post is still reported, separately.
 */
export function classifyPlayersGroupPost(text: string): "squad-or-teams" | "other" {
  const numbered = (text.match(/^\s*\d+\.\s+\S/gm) ?? []).length;
  if (numbered >= 3) return "squad-or-teams";
  if (/(proposed|final)\s+teams|squad for|teams for|team sheet|line-?up/i.test(text)) return "squad-or-teams";
  return "other";
}

export function summarise(events: RehearsalEvent[], ctx: SummaryContext): Summary {
  const perGroup: Summary["perGroup"] = {};
  for (const g of ctx.groups) perGroup[g.key] = { posts: 0, reactions: 0, graphics: 0, blocked: 0 };
  const dmsByRecipient: Record<string, number> = {};
  const players = ctx.groups.find((g) => g.role === "players")?.key;
  const mainChatViolations: RehearsalEvent[] = [];
  const errors: RehearsalEvent[] = [];
  for (const e of events) {
    if (e.kind === "error") errors.push(e);
    if (e.from !== "matchtime" && e.from !== "platform") continue;
    if (isGroup(e.channel)) {
      const g = (perGroup[e.channel.group] ??= { posts: 0, reactions: 0, graphics: 0, blocked: 0 });
      if (e.kind === "out") g.posts += 1;
      else if (e.kind === "react") g.reactions += 1;
      else if (e.kind === "graphic") g.graphics += 1;
      else if (e.kind === "blocked") g.blocked += 1;
      if (ctx.organisersAnnounce && e.channel.group === players && (e.kind === "out" || e.kind === "graphic")) {
        e.meta = { ...(e.meta ?? {}), category: classifyPlayersGroupPost(e.text ?? "") };
        mainChatViolations.push(e);
      }
    } else if (isDm(e.channel) && e.kind === "out") {
      dmsByRecipient[e.channel.dm] = (dmsByRecipient[e.channel.dm] ?? 0) + 1;
    }
  }
  return { perGroup, dmsByRecipient, mainChatViolations, errors };
}

// ── Rendering ─────────────────────────────────────────────────────────

export interface RenderFacts extends SummaryContext {
  title: string;
  mode: "stubbed" | "live";
  timezone: string;
  /** Extra summary sections (final squad, teams, ratings, call estimate...). */
  sections: Array<{ heading: string; lines: string[] }>;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** WhatsApp's *bold* and _italic_, after escaping. */
const waFormat = (s: string) =>
  esc(s)
    .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, "$1<i>$2</i>");

function who(e: RehearsalEvent, names: Record<string, string>): string {
  if (e.from === "matchtime") return "MatchTime";
  if (e.from === "platform") return "MatchTime (sign-up number)";
  if (e.from === "runner") return "rehearsal";
  return e.from ? (names[e.from] ?? e.from) : "";
}

function channelLabel(c: Channel, groups: ScenarioGroup[], names: Record<string, string>): string {
  if (isGroup(c)) return groups.find((g) => g.key === c.group)?.subject ?? c.group;
  if (isDm(c)) return `DM ${names[c.dm] ?? c.dm}`;
  return "System";
}

function modeBanner(mode: "stubbed" | "live"): { title: string; body: string } {
  return mode === "stubbed"
    ? {
        title: "STUBBED MODE",
        body:
          "No model was called. The router and extractor answers came from the scenario's stubs: replayed chat " +
          "was routed to nothing (silence) and only plain in/out and the scripted steps were given a route. " +
          "This run shows what MatchTime's deterministic code does with those answers. It does not prove what " +
          "the real model would read in these messages.",
      }
    : {
        title: "LIVE MODE",
        body: "Real model calls were made with the developer key. Routes and facts are the model's own.",
      };
}

function summaryLines(s: Summary, facts: RenderFacts): Array<{ heading: string; lines: string[]; alarm?: boolean }> {
  const out: Array<{ heading: string; lines: string[]; alarm?: boolean }> = [];
  out.push({
    heading: "What MatchTime posted, per group",
    lines: facts.groups.map((g) => {
      const c = s.perGroup[g.key] ?? { posts: 0, reactions: 0, graphics: 0, blocked: 0 };
      const role = g.role === "players" ? "players" : g.role === "admin" ? "admin group" : g.matchtime ? "other" : "MatchTime not a member";
      return `${g.subject} (${role}): ${c.posts} messages, ${c.graphics} graphics, ${c.reactions} reactions${c.blocked ? `, ${c.blocked} refused by the postability gate` : ""}`;
    }),
  });
  const dms = Object.entries(s.dmsByRecipient).sort((a, b) => b[1] - a[1]);
  out.push({
    heading: "Direct messages from MatchTime",
    lines: dms.length ? dms.map(([to, n]) => `${facts.names[to] ?? to}: ${n}`) : ["none"],
  });
  if (facts.organisersAnnounce) {
    const line = (e: RehearsalEvent) => `${formatLocal(e.at, facts.timezone)}  ${(e.text ?? "").replace(/\n/g, " / ").slice(0, 300)}`;
    const listing = s.mainChatViolations.filter((e) => e.meta?.category === "squad-or-teams");
    const other = s.mainChatViolations.filter((e) => e.meta?.category !== "squad-or-teams");
    out.push({
      heading: "VIOLATION CHECK: the squad or teams listed in the players' group in organisers mode (must be none)",
      alarm: listing.length > 0,
      lines: listing.length ? listing.map(line) : ["none"],
    });
    out.push({
      heading: "Other posts in the players' group in organisers mode (only ticks were expected; each needs a decision)",
      alarm: other.length > 0,
      lines: other.length ? other.map(line) : ["none"],
    });
  }
  out.push({
    heading: "Errors",
    alarm: s.errors.length > 0,
    lines: s.errors.length ? s.errors.map((e) => `${formatLocal(e.at, facts.timezone)}  ${e.text ?? ""}`) : ["none"],
  });
  return [...out, ...facts.sections];
}

function bubble(e: RehearsalEvent, i: number, events: RehearsalEvent[], facts: RenderFacts): string {
  const time = formatLocal(e.at, facts.timezone);
  const mine = e.from === "matchtime" || e.from === "platform";
  const replied = e.replyTo !== undefined ? events[e.replyTo] : undefined;
  const quote = replied?.text ? `<div class="quote">${esc(who(replied, facts.names))}: ${esc(replied.text.slice(0, 120))}</div>` : "";
  const unseen = e.kind === "in" && e.meta?.seen === false;
  switch (e.kind) {
    case "note":
      return `<div class="note" id="e${i}">${esc(e.text ?? "")} <span class="t">${time}</span></div>`;
    case "db":
      return `<div class="db" id="e${i}"><span class="t">${time}</span> database: ${esc(e.text ?? "")}</div>`;
    case "info":
      return `<div class="info" id="e${i}"><span class="t">${time}</span> ${waFormat(e.text ?? "")}</div>`;
    case "error":
      return `<div class="err" id="e${i}"><span class="t">${time}</span> ERROR ${esc(e.text ?? "")}</div>`;
    case "react":
      return `<div class="react" id="e${i}"><span class="t">${time}</span> MatchTime reacted ${esc(e.text ?? "")}${replied ? ` to ${esc(who(replied, facts.names))}: “${esc((replied.text ?? "").slice(0, 80))}”` : ""}</div>`;
    case "blocked":
      return `<div class="blocked" id="e${i}"><span class="t">${time}</span> not sent (postability gate: MatchTime cannot post here): ${esc(e.text ?? "")}</div>`;
    default: {
      const cls = mine ? "b mt" : unseen ? "b in unseen" : "b in";
      const media = e.media ? `<div class="media">[${esc(e.media)}]</div>` : "";
      const img = e.image ? `<a href="${esc(e.image)}"><img src="${esc(e.image)}" alt="graphic"></a>` : "";
      const tagLine = e.meta?.route ? ` <span class="route">stub route: ${esc(String(e.meta.route))}</span>` : "";
      const seen = unseen ? ` <span class="route">${esc(String(e.meta?.why ?? "MatchTime did not see this"))}</span>` : "";
      const handled = e.meta?.handledBy ? ` <span class="route">${esc(String(e.meta.handledBy))}</span>` : "";
      return `<div class="${cls}" id="e${i}"><div class="who">${esc(who(e, facts.names))}${tagLine}${handled}${seen}</div>${quote}${media}${img}<div class="txt">${waFormat(e.text ?? "")}</div><div class="t">${time}</div></div>`;
    }
  }
}

export function renderHtml(events: RehearsalEvent[], facts: RenderFacts): string {
  const s = summarise(events, facts);
  const banner = modeBanner(facts.mode);
  const sections = summaryLines(s, facts)
    .map(
      (sec) =>
        `<section class="sum${sec.alarm ? " alarm" : ""}"><h3>${esc(sec.heading)}</h3><ul>${sec.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></section>`,
    )
    .join("\n");

  // Channels: every group, then every DM recipient, then system.
  const channelKey = (c: Channel) => (isGroup(c) ? `g:${c.group}` : isDm(c) ? `d:${c.dm}` : "s");
  const order: Channel[] = [
    ...facts.groups.map((g) => ({ group: g.key })),
    ...[...new Set(events.filter((e) => isDm(e.channel)).map((e) => (e.channel as { dm: string }).dm))].map((dm) => ({ dm })),
    { system: true as const },
  ];
  const panels = order
    .map((c) => {
      const key = channelKey(c);
      // A scenario note ("Week 2") heads every panel.
      const evs = events
        .map((e, i) => [e, i] as const)
        .filter(([e]) => channelKey(e.channel) === key || (e.kind === "note" && key !== "s"));
      if (evs.length === 0) return "";
      const body = evs.map(([e, i]) => bubble(e, i, events, facts)).join("\n");
      return `<details class="panel"${isGroup(c) ? " open" : ""}><summary>${esc(channelLabel(c, facts.groups, facts.names))} <span class="count">${evs.length}</span></summary><div class="chat">${body}</div></details>`;
    })
    .join("\n");

  const timeline = events
    .map((e, i) => `<div class="row"><span class="ch">${esc(channelLabel(e.channel, facts.groups, facts.names))}</span>${bubble(e, i, events, facts)}</div>`)
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(facts.title)}</title>
<style>
:root{--bg:#f4f1ea;--fg:#1d2327;--muted:#66707a;--in:#ffffff;--mt:#d9fdd3;--line:#d8d2c4;--alarm:#b3261e;--note:#24476b}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#111b21;--fg:#e9edef;--muted:#8696a0;--in:#202c33;--mt:#005c4b;--line:#2a3942;--alarm:#ff8a80;--note:#9ecbff}}
:root[data-theme="dark"]{--bg:#111b21;--fg:#e9edef;--muted:#8696a0;--in:#202c33;--mt:#005c4b;--line:#2a3942;--alarm:#ff8a80;--note:#9ecbff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:8px 0}h2{font-size:18px;margin:24px 0 8px}h3{font-size:15px;margin:0 0 6px}
.banner{border:2px solid var(--alarm);padding:10px 12px;border-radius:8px;margin:12px 0}.banner b{color:var(--alarm)}
.sum{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0}.sum ul{margin:0;padding-left:18px}
.alarm{border-color:var(--alarm)}.alarm h3{color:var(--alarm)}
.panel{border:1px solid var(--line);border-radius:8px;margin:10px 0;background:color-mix(in srgb,var(--bg) 80%,var(--line))}
.panel>summary{cursor:pointer;padding:10px 12px;font-weight:600}.count{color:var(--muted);font-weight:400}
.chat{padding:8px 12px 14px;display:flex;flex-direction:column;gap:6px}
.b{max-width:80%;padding:6px 9px;border-radius:8px;background:var(--in);white-space:pre-wrap;overflow-wrap:anywhere}
.b.mt{align-self:flex-end;background:var(--mt)}.b.unseen{opacity:.55}
.who{font-size:12px;font-weight:600;color:var(--note)}.t{font-size:11px;color:var(--muted)}
.route{font-weight:400;color:var(--muted);font-size:11px}
.quote{border-left:3px solid var(--note);padding-left:6px;font-size:12px;color:var(--muted);margin-bottom:4px}
.media{font-size:12px;color:var(--muted)}
.b img{max-width:100%;max-height:520px;display:block;margin:4px 0;border-radius:6px}
.react,.db,.info,.blocked{font-size:12px;color:var(--muted);align-self:center;text-align:center;max-width:95%;white-space:pre-wrap}
.blocked,.err{color:var(--alarm)}.err{font-weight:600;font-size:13px}
.note{align-self:center;font-weight:700;color:var(--note);margin:10px 0 4px}
.row{display:flex;flex-direction:column;gap:2px;margin:6px 0}.ch{font-size:11px;color:var(--muted)}
.row .b.mt{align-self:flex-end}
</style></head>
<body><main>
<h1>${esc(facts.title)}</h1>
<div class="banner"><b>${esc(banner.title)}</b>: ${esc(banner.body)}</div>
<h2>Summary</h2>
${sections}
<h2>Groups and direct messages</h2>
${panels}
<h2>Everything, in time order</h2>
<details class="panel"><summary>Show all ${events.length} events</summary><div class="chat">${timeline}</div></details>
</main></body></html>
`;
}

export function renderMarkdown(events: RehearsalEvent[], facts: RenderFacts): string {
  const s = summarise(events, facts);
  const banner = modeBanner(facts.mode);
  const lines: string[] = [`# ${facts.title}`, "", `**${banner.title}**: ${banner.body}`, "", "## Summary", ""];
  for (const sec of summaryLines(s, facts)) {
    lines.push(`### ${sec.alarm ? "⚠ " : ""}${sec.heading}`, "", ...sec.lines.map((l) => `- ${l}`), "");
  }
  lines.push("## Everything, in time order", "");
  events.forEach((e) => {
    const time = formatLocal(e.at, facts.timezone);
    const ch = channelLabel(e.channel, facts.groups, facts.names);
    const text = (e.text ?? "").replace(/\n/g, "\n    ");
    const unseen =
      e.kind === "in" && e.meta?.seen === false
        ? ` _(${String(e.meta?.why ?? "MatchTime did not see this")})_`
        : e.kind === "in" && e.meta?.handledBy
          ? ` _(${String(e.meta.handledBy)}${e.meta.route ? `; stub route ${String(e.meta.route)}` : ""})_`
          : "";
    const media = e.media ? ` [${e.media}]` : "";
    switch (e.kind) {
      case "note":
        lines.push("", `### ${e.text ?? ""} (${time})`, "");
        break;
      case "react":
        lines.push(`- ${time} [${ch}] MatchTime reacted ${e.text ?? ""}`);
        break;
      case "graphic":
        lines.push(`- ${time} [${ch}] **MatchTime** (image): ${text}`, `  ![graphic](${e.image ?? ""})`);
        break;
      case "db":
        lines.push(`- ${time} database: ${text}`);
        break;
      default:
        lines.push(`- ${time} [${ch}] ${e.kind === "error" ? "ERROR " : ""}${e.kind === "blocked" ? "NOT SENT (postability) " : ""}**${who(e, facts.names)}**${media}: ${text}${unseen}`);
    }
  });
  return `${lines.join("\n")}\n`;
}
