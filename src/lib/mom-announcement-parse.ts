/**
 * READING OUR OWN MAN OF THE MATCH POST BACK (review of #608, 2026-11-16).
 * PURE. For `scripts/backfill-mom-announcements.ts`: results posted before
 * the result was stored at the claim ("MoMAnnouncement") are filled in from
 * the post's own words, which every post since 2026-10-20 kept in
 * `SentNotification.text`.
 *
 * NOT READING PEOPLE. This is MatchTime's own output, built by
 * `mom-announcement.ts` from the strings in `i18n/strings.*.ts`. The parser
 * splits it by that template's structure (header, winner line, "Votes:" and
 * one row per player, or the pick's congrats line), then renders the parsed
 * result with the SAME builder and accepts it only when that gives back the
 * exact text. A post that was cut short (the claim keeps 1000 characters),
 * edited, or written by anything else is no result, never a guess.
 *
 * The template is unchanged since 2026-10-20 except that until 2026-10-31
 * (#489) the post ended on a trophy line, removed from the strings since; it
 * is kept here, the only copy, so those posts still read back.
 */
import { buildMomAnnouncement, buildMomPickedAnnouncement } from "./mom-announcement";
import { t } from "./i18n/t";
import { announcedWinnersOf, type MomAnnouncedResult } from "./mom-announce-rules";

type PostLang = "en" | "tr";

/** The closing line of the post until 2026-10-31 (#489). */
export const RETIRED_TROPHY_LINES: Record<PostLang, string> = {
  en: "Your trophy awaits next match.",
  tr: "Kupa gelecek maçta sahibini bekliyor.",
};

/** What a post said, by name, as the group saw it. */
export type ParsedMomPost =
  | { lang: PostLang; kind: "vote"; tally: Array<{ name: string; votes: number }> }
  | { lang: PostLang; kind: "pick"; name: string };

/** The template's structure, per language (`strings.*.ts`, row 45). */
const SHAPE: Record<PostLang, { headerSep: string; row: RegExp; picked: RegExp }> = {
  en: { headerSep: ": ", row: /^• (.+) \((\d+)\)$/, picked: /^Congrats \*(.+)\* 🎉$/ },
  tr: { headerSep: ", ", row: /^• (.+): (\d+)$/, picked: /^Tebrikler \*(.+)\* 🎉$/ },
};

function parseAs(lang: PostLang, text: string): ParsedMomPost | null {
  const shape = SHAPE[lang];
  const trophy = `\n\n${RETIRED_TROPHY_LINES[lang]}`;
  const body = text.endsWith(trophy) ? text.slice(0, -trophy.length) : text;
  const blocks = body.split("\n\n");
  const header = blocks[0];
  if (!header.startsWith("🏆 *") || !header.endsWith("*")) return null;
  const inner = header.slice("🏆 *".length, -1);
  const at = inner.indexOf(shape.headerSep);
  if (at < 1) return null;
  const mvpLabel = inner.slice(0, at);
  const activityName = inner.slice(at + shape.headerSep.length);

  let parsed: ParsedMomPost | null = null;
  let rendered = "";
  if (blocks.length === 2) {
    const m = shape.picked.exec(blocks[1]);
    if (!m) return null;
    parsed = { lang, kind: "pick", name: m[1] };
    rendered = buildMomPickedAnnouncement({ mvpLabel, activityName, name: m[1], lang });
  } else if (blocks.length === 3) {
    const lines = blocks[2].split("\n");
    if (lines[0] !== t(lang).mom_votes_header || lines.length < 2) return null;
    const tally: Array<{ name: string; votes: number }> = [];
    for (const line of lines.slice(1)) {
      const m = shape.row.exec(line);
      if (!m) return null;
      const votes = Number(m[2]);
      if (!Number.isInteger(votes) || votes < 1) return null;
      tally.push({ name: m[1], votes });
    }
    parsed = { lang, kind: "vote", tally };
    rendered = buildMomAnnouncement({ mvpLabel, activityName, tally, lang });
  } else {
    return null;
  }
  return rendered === body ? parsed : null;
}

/** PURE. The post's result, or null when the text is not exactly our post. */
export function parseMomAnnouncementText(text: string): ParsedMomPost | null {
  if (!text) return null;
  return parseAs("en", text) ?? parseAs("tr", text);
}

/** PURE. The stored record for a parsed post: every name must be exactly
 *  one of the match's people (exact name, no folding), or it is skipped
 *  with the reason. */
export function matchMomPostToRoster(
  post: ParsedMomPost,
  roster: ReadonlyArray<{ userId: string; name: string }>,
): { ok: true; result: MomAnnouncedResult } | { ok: false; reason: string } {
  const resolve = (name: string): { userId: string } | { reason: string } => {
    const hits = roster.filter((r) => r.name === name);
    if (hits.length === 1) return { userId: hits[0].userId };
    return { reason: hits.length === 0 ? `no one at the match is called "${name}"` : `${hits.length} people at the match are called "${name}"` };
  };
  if (post.kind === "pick") {
    const r = resolve(post.name);
    return "reason" in r ? { ok: false, reason: r.reason } : { ok: true, result: { v: 1, kind: "pick", winner: { userId: r.userId, name: post.name } } };
  }
  const tally: Array<{ userId: string; name: string; votes: number }> = [];
  for (const e of post.tally) {
    const r = resolve(e.name);
    if ("reason" in r) return { ok: false, reason: r.reason };
    if (tally.some((x) => x.userId === r.userId)) return { ok: false, reason: `"${e.name}" is listed twice` };
    tally.push({ userId: r.userId, name: e.name, votes: e.votes });
  }
  return { ok: true, result: { v: 1, kind: "vote", tally, winners: announcedWinnersOf(tally) } };
}
