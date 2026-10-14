/**
 * DRAWS THE LIST POSTER AND THE TEAM SHEET (2026-10-14) with next/og
 * (Satori + Resvg), as the badge card and the Wrapped card do, in the same
 * visual family: deep navy, a gold accent, MatchTime in the corner.
 *
 * Everything that depends on the data (columns, sizes, cuts, colours) is
 * decided in `match-graphics-layout.ts`; this file only draws it. Satori
 * does flexbox and a subset of CSS, no grid: every element with more than
 * one child sets `display: flex`.
 *
 * FONTS. Barlow Condensed (SIL Open Font License, assets/fonts/OFL.txt),
 * SemiBold and ExtraBold: a condensed sports face that keeps long names on
 * one line and covers Latin Extended, so Turkish (ğ ş ı İ ç ö ü) and most
 * accented European names render in it. Emoji are drawn by next/og's
 * built-in Twemoji loader, and a script the font lacks (Arabic, Cyrillic
 * and so on) falls back to next/og's dynamic Noto loader, as on the badge
 * card. The fonts are read from disk once per process; `next.config.ts`
 * traces them into the route's bundle.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import type { ListPosterData, TeamSheetData, GraphicData } from "./match-graphics";
import { graphicsCopy } from "./match-graphics-copy";
import { dayLabel } from "./i18n/dates";
import {
  GRAPHIC_HEIGHT,
  GRAPHIC_PADDING,
  GRAPHIC_WIDTH,
  COLUMN_GAP,
  CONTENT_WIDTH,
  clubNameFontSize,
  fitName,
  listPosterLayout,
  shoutCase,
  teamColour,
  teamSheetLayout,
} from "./match-graphics-layout";

const FONT = "Barlow Condensed";
const NAVY = "#0f172a";
const GOLD = "#fbbf24";
const SKY = "#93c5fd";
const MUTED = "#cbd5e1";

type FontSpec = { name: string; data: Buffer; weight: 600 | 800; style: "normal" };
let fontsPromise: Promise<FontSpec[]> | null = null;

function loadFonts(): Promise<FontSpec[]> {
  if (!fontsPromise) {
    const dir = path.join(process.cwd(), "assets", "fonts");
    fontsPromise = Promise.all([
      readFile(path.join(dir, "BarlowCondensed-SemiBold.ttf")),
      readFile(path.join(dir, "BarlowCondensed-ExtraBold.ttf")),
    ])
      .then(([semi, extra]) => [
        { name: FONT, data: semi, weight: 600 as const, style: "normal" as const },
        { name: FONT, data: extra, weight: 800 as const, style: "normal" as const },
      ])
      .catch((err) => {
        fontsPromise = null;
        throw err;
      });
  }
  return fontsPromise;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "linear-gradient(160deg, #0f172a 0%, #1e3a8a 60%, #1e40af 100%)",
        color: "white",
        padding: GRAPHIC_PADDING,
        fontFamily: FONT,
        fontWeight: 800,
      }}
    >
      {children}
    </div>
  );
}

function Header({ data, title }: { data: GraphicData; title: string }) {
  const size = clubNameFontSize(data.clubName);
  const maxChars = Math.floor(CONTENT_WIDTH / (size * 0.5));
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", fontSize: 30, fontWeight: 600, color: SKY, letterSpacing: 1 }}>⚽ MatchTime</div>
        <div
          style={{
            display: "flex",
            fontSize: 30,
            letterSpacing: 6,
            color: NAVY,
            background: GOLD,
            padding: "4px 18px",
            borderRadius: 8,
          }}
        >
          {title}
        </div>
      </div>
      <div style={{ display: "flex", fontSize: size, lineHeight: 1.05, marginTop: 18, letterSpacing: 1, whiteSpace: "nowrap", overflow: "hidden" }}>
        {fitName(shoutCase(data.clubName, data.lang), maxChars)}
      </div>
    </div>
  );
}

function Footer({ data }: { data: GraphicData }) {
  const s = graphicsCopy(data.lang);
  const cells: Array<[string, string, number]> = [
    [s.venue, fitName(shoutCase(data.venue || "-", data.lang), 19), 2],
    [s.date, shoutCase(dayLabel(data.lang, data.matchDate), data.lang), 1.4],
    [s.kickoff, data.kickoff, 1],
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", marginTop: "auto" }}>
      <div style={{ display: "flex", height: 4, background: GOLD, borderRadius: 2 }} />
      <div style={{ display: "flex", marginTop: 20 }}>
        {cells.map(([label, value, grow]) => (
          <div key={label} style={{ display: "flex", flexDirection: "column", flexGrow: grow, flexBasis: 0, paddingRight: 16 }}>
            <div style={{ display: "flex", fontSize: 24, fontWeight: 600, color: SKY, letterSpacing: 4 }}>{label}</div>
            <div style={{ display: "flex", fontSize: 40, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden" }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NameRow(props: { n: number; name: string; rowHeight: number; fontSize: number; numberWidth: number; maxChars: number; lang: string }) {
  const { n, name, rowHeight, fontSize, numberWidth, maxChars, lang } = props;
  const badge = Math.round(fontSize * 1.25);
  return (
    <div style={{ display: "flex", alignItems: "center", height: rowHeight }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: badge,
          height: Math.min(badge, rowHeight - 6),
          marginRight: numberWidth - badge,
          borderRadius: 8,
          background: GOLD,
          color: NAVY,
          fontSize: Math.round(fontSize * 0.7),
        }}
      >
        {String(n)}
      </div>
      <div style={{ display: "flex", fontSize, lineHeight: 1, whiteSpace: "nowrap", overflow: "hidden" }}>{fitName(shoutCase(name, lang), maxChars)}</div>
    </div>
  );
}

function ListPoster({ data }: { data: ListPosterData }) {
  const s = graphicsCopy(data.lang);
  const l = listPosterLayout({ count: data.players.length, reserves: data.reserves.length });
  const columns = Array.from({ length: l.columns }, (_, c) => data.players.slice(c * l.rows, (c + 1) * l.rows).map((name, i) => ({ name, n: c * l.rows + i + 1 })));
  const shown = data.reserves.slice(0, l.reservesShown);
  return (
    <Frame>
      <Header data={data} title={s.listTitle} />
      <div style={{ display: "flex", fontSize: 34, fontWeight: 600, color: GOLD, letterSpacing: 3, marginTop: 6, marginBottom: 18 }}>
        {s.players(data.players.length)}
      </div>
      <div style={{ display: "flex", height: l.namesAreaHeight }}>
        {columns.map((col, c) => (
          <div key={c} style={{ display: "flex", flexDirection: "column", width: l.columnWidth, marginLeft: c === 0 ? 0 : COLUMN_GAP }}>
            {col.map((p) => (
              <NameRow key={p.n} n={p.n} name={p.name} rowHeight={l.rowHeight} fontSize={l.fontSize} numberWidth={l.numberWidth} maxChars={l.maxChars} lang={data.lang} />
            ))}
          </div>
        ))}
      </div>
      {shown.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", marginTop: 12 }}>
          <div style={{ display: "flex", fontSize: 26, fontWeight: 600, color: SKY, letterSpacing: 4 }}>{s.reserves}</div>
          <div style={{ display: "flex", flexWrap: "wrap", marginTop: 6 }}>
            {shown.map((name, i) => (
              <div key={i} style={{ display: "flex", fontSize: 32, color: MUTED, marginRight: 26, marginBottom: 4 }}>
                {`${i + 1}. ${fitName(shoutCase(name, data.lang), 14)}`}
              </div>
            ))}
            {l.reservesHidden > 0 ? (
              <div style={{ display: "flex", fontSize: 32, fontWeight: 600, color: SKY }}>{s.moreReserves(l.reservesHidden)}</div>
            ) : null}
          </div>
        </div>
      ) : null}
      <Footer data={data} />
    </Frame>
  );
}

function TeamSheet({ data }: { data: TeamSheetData }) {
  const s = graphicsCopy(data.lang);
  const l = teamSheetLayout({ maxPerTeam: Math.max(data.teams[0].names.length, data.teams[1].names.length) });
  return (
    <Frame>
      <Header data={data} title={s.teamsTitle} />
      <div style={{ display: "flex", marginTop: 28 }}>
        {data.teams.map((team, slot) => {
          const colour = teamColour(team.label, slot as 0 | 1);
          return (
            <div key={slot} style={{ display: "flex", flexDirection: "column", width: l.columnWidth, marginLeft: slot === 0 ? 0 : COLUMN_GAP }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: colour.bg,
                  color: colour.fg,
                  borderRadius: 10,
                  padding: "8px 18px",
                  border: "3px solid rgba(255,255,255,0.35)",
                  fontSize: 46,
                }}
              >
                <div style={{ display: "flex", whiteSpace: "nowrap", overflow: "hidden" }}>{fitName(shoutCase(team.label, data.lang), 14)}</div>
                <div style={{ display: "flex", fontSize: 34, fontWeight: 600 }}>{String(team.names.length)}</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", height: l.namesAreaHeight, marginTop: 16 }}>
                {team.names.map((name, i) => (
                  <NameRow key={i} n={i + 1} name={name} rowHeight={l.rowHeight} fontSize={l.fontSize} numberWidth={l.numberWidth} maxChars={l.maxChars} lang={data.lang} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <Footer data={data} />
    </Frame>
  );
}

/** The graphic as PNG bytes. */
export async function renderGraphicPng(data: GraphicData): Promise<Buffer> {
  const fonts = await loadFonts();
  const element = data.kind === "list" ? <ListPoster data={data} /> : <TeamSheet data={data} />;
  const res = new ImageResponse(element, { width: GRAPHIC_WIDTH, height: GRAPHIC_HEIGHT, fonts });
  return Buffer.from(await res.arrayBuffer());
}
