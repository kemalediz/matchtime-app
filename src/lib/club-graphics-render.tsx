/**
 * DRAWS A CLUB'S LIST POSTER AND TEAM SHEET ON ITS OWN TEMPLATE (2026-10-14),
 * or hands the graphic to the default MatchTime design.
 *
 *   renderClubGraphic(data, template)   the PNG and which design drew it.
 *
 * On a template (`club-graphics-layout.ts` for the layout and the rules):
 *
 *   TEAM SHEET: the template's background as it is (its own team headers,
 *   shirts, frame and logo), each team's names on its column's rows, the
 *   day and the kickoff beside the template's calendar and clock icons.
 *
 *   LIST POSTER: the same background with one band laid over the two team
 *   headers, a gradient from the first team's colour to the second's with
 *   the squad word across it and the template's shirts put back on top;
 *   names 1 to 9 down the first column and 10 to 18 down the second, each
 *   row's number printed on its shirt icon; the bench as one line under
 *   the board.
 *
 * FONTS (SIL Open Font License, assets/fonts/OFL.txt): names, numbers and
 * the squad word in Barlow Semi Condensed Black Italic, the heavy italic
 * condensed capitals of the club boards these templates come from; the
 * day and kickoff in Barlow Medium. Every size is chosen BEFORE drawing
 * from the font's own widths (`font-metrics.ts`), since Satori cannot
 * shrink text to fit, and every line is placed by the centre of its
 * capitals, which is what the layout measures.
 *
 * SHARED AND UPLOADED DESIGNS (2026-10-14, the "Posters" card): an
 * owner's uploaded picture gets the default board drawn on it
 * (`renderGraphicPng` with a background); a shared measured template
 * drawn for another club (`foreign`) loses its own squad title and has
 * its `brandArea` covered with the picking club's name.
 *
 * No name, phone number or rating is logged here; the route logs ids,
 * sizes and the design.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import type { GraphicData, ListPosterData, TeamSheetData } from "./match-graphics";
import { graphicsCopy } from "./match-graphics-copy";
import { renderGraphicPng } from "./match-graphics-render";
import { shoutCase } from "./match-graphics-layout";
import { readFontMetrics, textWidth, type FontMetrics } from "./font-metrics";
import {
  fitTemplateName,
  graphicDesign,
  reservesLine,
  brandSubtitleLabel,
  templateDateLabel,
  templateTimeLabel,
  type ClubGraphicsLayout,
  type GraphicDesign,
} from "./club-graphics-layout";
import type { ClubGraphicsTemplate } from "./club-graphics-template";
import { foreignLayout } from "./club-graphics-choice";

const NAME_FONT = "Barlow Semi Condensed";
const INFO_FONT = "Barlow";
/** Kerning and the italic's overhang are not in the advances: a little room for both. */
const SLACK = 1.04;

interface LoadedFonts {
  specs: Array<{ name: string; data: Buffer; weight: 500 | 900; style: "normal" | "italic" }>;
  name: FontMetrics;
  info: FontMetrics;
}

let fontsPromise: Promise<LoadedFonts> | null = null;

function loadFonts(): Promise<LoadedFonts> {
  if (!fontsPromise) {
    const dir = path.join(process.cwd(), "assets", "fonts");
    fontsPromise = Promise.all([readFile(path.join(dir, "BarlowSemiCondensed-BlackItalic.ttf")), readFile(path.join(dir, "Barlow-Medium.ttf"))])
      .then(([name, info]) => ({
        specs: [
          { name: NAME_FONT, data: name, weight: 900 as const, style: "italic" as const },
          { name: INFO_FONT, data: info, weight: 500 as const, style: "normal" as const },
        ],
        name: readFontMetrics(name),
        info: readFontMetrics(info),
      }))
      .catch((err) => {
        fontsPromise = null;
        throw err;
      });
  }
  return fontsPromise;
}

/**
 * The top of a one-line text box whose capitals are centred on `centreY`.
 * The box's line height is the font's ascender to descender, so its
 * baseline sits one ascender below its top.
 */
function lineBox(m: FontMetrics, fontSize: number, centreY: number): { top: number; lineHeight: number } {
  const scale = fontSize / m.unitsPerEm;
  return {
    top: Math.round((centreY + (m.capHeight * scale) / 2 - m.ascender * scale) * 10) / 10,
    lineHeight: (m.ascender - m.descender) / m.unitsPerEm,
  };
}

interface TextProps {
  text: string;
  m: FontMetrics;
  family: string;
  weight: number;
  italic?: boolean;
  fontSize: number;
  colour: string;
  centreY: number;
  /** Left edge, or a centre with `align: "centre"`. */
  x: number;
  align?: "left" | "centre";
  letterSpacing?: number;
}

function Text({ text, m, family, weight, italic, fontSize, colour, centreY, x, align = "left", letterSpacing }: TextProps) {
  const { top, lineHeight } = lineBox(m, fontSize, centreY);
  const centred = align === "centre";
  return (
    <div
      style={{
        position: "absolute",
        top,
        left: centred ? x - 600 : x,
        ...(centred ? { width: 1200 } : {}),
        display: "flex",
        justifyContent: centred ? "center" : "flex-start",
        fontFamily: family,
        fontWeight: weight,
        fontStyle: italic ? "italic" : "normal",
        fontSize,
        lineHeight,
        color: colour,
        whiteSpace: "nowrap",
        ...(letterSpacing ? { letterSpacing } : {}),
      }}
    >
      {text}
    </div>
  );
}

function Background({ src, layout }: { src: string; layout: ClubGraphicsLayout }) {
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  return <img src={src} width={layout.width} height={layout.height} style={{ position: "absolute", left: 0, top: 0 }} />;
}

function DateAndTime({ data, layout, fonts }: { data: GraphicData; layout: ClubGraphicsLayout; fonts: LoadedFonts }) {
  const spot = (s: ClubGraphicsLayout["date"], label: string) => {
    const fit = fitTemplateName(label, {
      maxWidth: s.maxWidth,
      maxFontSize: s.fontSize,
      minFontSize: Math.round(s.fontSize * 0.7),
      measure: (t, size) => textWidth(fonts.info, t, size) * SLACK,
    });
    return <Text text={fit.text} m={fonts.info} family={INFO_FONT} weight={500} fontSize={fit.fontSize} colour={s.colour} centreY={s.centreY} x={s.x} />;
  };
  return (
    <>
      {spot(layout.date, templateDateLabel(data.lang, data.matchDate))}
      {spot(layout.time, templateTimeLabel(data.lang, data.matchDate))}
    </>
  );
}

function NameOnRow(props: { name: string; lang: string; column: ClubGraphicsLayout["columns"][number]; centreY: number; layout: ClubGraphicsLayout; fonts: LoadedFonts }) {
  const { name, lang, column, centreY, layout, fonts } = props;
  const fit = fitTemplateName(shoutCase(name, lang), {
    maxWidth: column.maxWidth,
    maxFontSize: layout.name.maxFontSize,
    minFontSize: layout.name.minFontSize,
    measure: (t, s) => textWidth(fonts.name, t, s) * SLACK,
  });
  return (
    <Text text={fit.text} m={fonts.name} family={NAME_FONT} weight={900} italic fontSize={fit.fontSize} colour={layout.name.colour} centreY={centreY} x={column.nameX} />
  );
}

function TeamSheet({ data, layout, src, fonts, overlay }: { data: TeamSheetData; layout: ClubGraphicsLayout; src: string; fonts: LoadedFonts; overlay?: React.ReactNode }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", position: "relative" }}>
      <Background src={src} layout={layout} />
      <DateAndTime data={data} layout={layout} fonts={fonts} />
      {data.teams.flatMap((team, c) =>
        team.names.map((name, r) => (
          <NameOnRow key={`${c}-${r}`} name={name} lang={data.lang} column={layout.columns[c]} centreY={layout.rows[r]} layout={layout} fonts={fonts} />
        )),
      )}
      {overlay}
    </div>
  );
}

function SquadHeader({ data, layout, src, fonts }: { data: ListPosterData; layout: ClubGraphicsLayout; src: string; fonts: LoadedFonts }) {
  const h = layout.squadHeader;
  const title = shoutCase(h.title ?? graphicsCopy(data.lang).listTitle, data.lang);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: h.panel.x,
          top: h.panel.y,
          width: h.panel.width,
          height: h.panel.height,
          display: "flex",
          backgroundImage: `linear-gradient(90deg, ${h.from} 0%, ${h.from} 36%, ${h.to} 64%, ${h.to} 100%)`,
        }}
      />
      {h.keep.map((k, i) => (
        <div key={i} style={{ position: "absolute", left: k.x, top: k.y, width: k.width, height: k.height, display: "flex", overflow: "hidden" }}>
          {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
          <img src={src} width={layout.width} height={layout.height} style={{ position: "absolute", left: -k.x, top: -k.y }} />
        </div>
      ))}
      <Text
        text={title}
        m={fonts.name}
        family={NAME_FONT}
        weight={900}
        italic
        fontSize={h.titleFontSize}
        colour={h.titleColour}
        centreY={h.panel.y + h.panel.height / 2}
        x={h.panel.x + h.panel.width / 2}
        align="centre"
      />
    </>
  );
}

function ListPoster({ data, layout, src, fonts, overlay }: { data: ListPosterData; layout: ClubGraphicsLayout; src: string; fonts: LoadedFonts; overlay?: React.ReactNode }) {
  const perColumn = layout.rows.length;
  const s = graphicsCopy(data.lang);
  const badgeSize = Math.round(layout.capHeight * 0.78);
  const r = layout.reserves;
  const reserves = reservesLine(
    data.reserves.map((n) => shoutCase(n, data.lang)),
    { label: s.reserves, more: s.moreReserves, maxWidth: r.maxWidth, fontSize: r.fontSize, measure: (t, size) => textWidth(fonts.name, t, size) * SLACK },
  );
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", position: "relative" }}>
      <Background src={src} layout={layout} />
      <SquadHeader data={data} layout={layout} src={src} fonts={fonts} />
      <DateAndTime data={data} layout={layout} fonts={fonts} />
      {data.players.map((name, i) => {
        const column = layout.columns[Math.floor(i / perColumn)];
        const centreY = layout.rows[i % perColumn];
        return (
          <div key={i} style={{ display: "flex" }}>
            <Text
              text={String(i + 1)}
              m={fonts.name}
              family={NAME_FONT}
              weight={900}
              italic
              fontSize={badgeSize}
              colour={column.badgeColour}
              centreY={centreY + Math.round(layout.capHeight * 0.12)}
              x={column.iconCentreX}
              align="centre"
            />
            <NameOnRow name={name} lang={data.lang} column={column} centreY={centreY} layout={layout} fonts={fonts} />
          </div>
        );
      })}
      {reserves ? (
        <Text text={reserves} m={fonts.name} family={NAME_FONT} weight={900} italic fontSize={r.fontSize} colour={r.colour} centreY={r.centreY} x={r.centreX} align="centre" />
      ) : null}
      {overlay}
    </div>
  );
}

/**
 * A shared template drawn for another club (2026-10-14): its brand area
 * covered with its fill (none when the image's branding is painted out
 * already), the picking club's name drawn there as big as fits, and the
 * subtitle line ("TUESDAY NIGHT FOOTBALL") under it when the layout has
 * one. Nothing of the template's own club shows through.
 */
function BrandCover({ area, data, fonts }: { area: NonNullable<ClubGraphicsLayout["brandArea"]>; data: GraphicData; fonts: LoadedFonts }) {
  const pad = Math.round(area.height * 0.12);
  const ceiling = area.nameCentreY !== undefined ? area.maxFontSize : Math.min(area.maxFontSize, Math.round(area.height * 0.7));
  const fit = fitTemplateName(shoutCase(data.clubName, data.lang), {
    maxWidth: Math.max(1, area.width - 2 * pad),
    maxFontSize: ceiling,
    minFontSize: Math.max(6, Math.round(ceiling * 0.4)),
    measure: (t, size) => textWidth(fonts.name, t, size) * SLACK,
  });
  const sub = area.subtitle;
  const subtitle = sub
    ? fitTemplateName(brandSubtitleLabel(data.lang, data.matchDate), {
        maxWidth: Math.max(1, area.width - 2 * pad),
        maxFontSize: sub.fontSize,
        minFontSize: Math.max(6, Math.round(sub.fontSize * 0.7)),
        // Spaced letters: the gaps count too.
        measure: (t, size) => textWidth(fonts.info, t, size) * SLACK + sub.letterSpacing * Math.max(0, t.length - 1),
      })
    : null;
  return (
    <>
      {area.fill ? (
        <div style={{ position: "absolute", left: area.x, top: area.y, width: area.width, height: area.height, display: "flex", background: area.fill }} />
      ) : null}
      <Text
        text={fit.text}
        m={fonts.name}
        family={NAME_FONT}
        weight={900}
        italic
        fontSize={fit.fontSize}
        colour={area.colour}
        centreY={area.nameCentreY ?? area.y + area.height / 2}
        x={area.x + area.width / 2}
        align="centre"
      />
      {sub && subtitle ? (
        <Text
          text={subtitle.text}
          m={fonts.info}
          family={INFO_FONT}
          weight={500}
          fontSize={subtitle.fontSize}
          colour={sub.colour}
          centreY={sub.centreY}
          x={area.x + area.width / 2}
          align="centre"
          letterSpacing={sub.letterSpacing}
        />
      ) : null}
    </>
  );
}

export type RenderedDesign = GraphicDesign | { design: "background" };

export interface RenderedGraphic {
  png: Buffer;
  design: RenderedDesign;
}

/**
 * The graphic as PNG bytes:
 *   - a BACKGROUND template (an owner's upload): the default board on it;
 *   - a MEASURED template that can hold this graphic (`graphicDesign`):
 *     drawn on it; with `foreign` (a shared template drawn for another
 *     club) its own squad title is dropped and its brand area covered
 *     with the picking club's name;
 *   - else the default MatchTime design.
 */
export async function renderClubGraphic(
  data: GraphicData,
  template: ClubGraphicsTemplate | null,
  opts: { foreign?: boolean } = {},
): Promise<RenderedGraphic> {
  if (template?.kind === "background") {
    const src = `data:${template.mimeType};base64,${template.image.toString("base64")}`;
    return { png: await renderGraphicPng(data, { background: { src } }), design: { design: "background" } };
  }
  const measured = template?.kind === "measured" ? template : null;
  const design = graphicDesign(data, measured?.layout ?? null);
  if (design.design === "default" || !measured) return { png: await renderGraphicPng(data), design };

  const fonts = await loadFonts();
  const layout = opts.foreign ? foreignLayout(measured.layout) : measured.layout;
  const src = `data:${measured.mimeType};base64,${measured.image.toString("base64")}`;
  const overlay = opts.foreign && layout.brandArea ? <BrandCover area={layout.brandArea} data={data} fonts={fonts} /> : null;
  const element =
    data.kind === "teams" ? (
      <TeamSheet data={data} layout={layout} src={src} fonts={fonts} overlay={overlay} />
    ) : (
      <ListPoster data={data} layout={layout} src={src} fonts={fonts} overlay={overlay} />
    );
  const res = new ImageResponse(element, { width: layout.width, height: layout.height, fonts: fonts.specs });
  return { png: Buffer.from(await res.arrayBuffer()), design };
}
