/**
 * WIDTHS OUT OF A TRUETYPE FONT (2026-10-14).
 *
 * A club's graphics template (`club-graphics-render.tsx`) gives each name a
 * fixed box on the board. The renderer (Satori) cannot shrink text to fit,
 * so the size is chosen before drawing, from the font's own advance
 * widths. This reads just enough of a .ttf for that: `head` (units per
 * em), `hhea` (ascender, descender, how many metrics), `hmtx` (advances),
 * `OS/2` (cap height) and `cmap` (formats 4 and 12, character to glyph).
 *
 * Kerning is ignored: it moves a capital name by a few per cent at most,
 * and the caller fits to a box with that much to spare. Pure; no I/O.
 */

export interface FontMetrics {
  unitsPerEm: number;
  ascender: number;
  /** Negative, below the baseline. */
  descender: number;
  capHeight: number;
  /** The advance of a code point in font units, or undefined when the font lacks it. */
  advance(codePoint: number): number | undefined;
}

/** What a missing character counts as, in ems: wide, so a fallback font never overflows. */
const FALLBACK_EM = 0.7;

export function readFontMetrics(buf: Buffer): FontMetrics {
  if (buf.length < 12) throw new Error("font too short");
  const version = buf.readUInt32BE(0);
  if (version !== 0x00010000 && version !== 0x74727565) throw new Error("not a TrueType font");
  const numTables = buf.readUInt16BE(4);
  const tables = new Map<string, number>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables.set(buf.toString("latin1", rec, rec + 4), buf.readUInt32BE(rec + 8));
  }
  const table = (tag: string) => {
    const at = tables.get(tag);
    if (at === undefined) throw new Error(`font has no ${tag} table`);
    return at;
  };

  const head = table("head");
  const unitsPerEm = buf.readUInt16BE(head + 18);
  const hhea = table("hhea");
  const ascender = buf.readInt16BE(hhea + 4);
  const descender = buf.readInt16BE(hhea + 6);
  const numberOfHMetrics = buf.readUInt16BE(hhea + 34);
  const hmtx = table("hmtx");

  let capHeight = Math.round(unitsPerEm * 0.7);
  const os2 = tables.get("OS/2");
  if (os2 !== undefined && buf.readUInt16BE(os2) >= 2) capHeight = buf.readInt16BE(os2 + 88);

  const glyphOf = cmapLookup(buf, table("cmap"));
  const advanceOfGlyph = (g: number) => buf.readUInt16BE(hmtx + Math.min(g, numberOfHMetrics - 1) * 4);

  return {
    unitsPerEm,
    ascender,
    descender,
    capHeight,
    advance(codePoint: number) {
      const g = glyphOf(codePoint);
      return g ? advanceOfGlyph(g) : undefined;
    },
  };
}

function cmapLookup(buf: Buffer, cmap: number): (cp: number) => number {
  const count = buf.readUInt16BE(cmap + 2);
  let format4: number | null = null;
  let format12: number | null = null;
  for (let i = 0; i < count; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const sub = cmap + buf.readUInt32BE(rec + 4);
    const format = buf.readUInt16BE(sub);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12 && format12 === null) format12 = sub;
    if (format === 4 && format4 === null) format4 = sub;
  }

  if (format12 !== null) {
    const sub = format12;
    const groups = buf.readUInt32BE(sub + 12);
    return (cp) => {
      for (let i = 0; i < groups; i++) {
        const g = sub + 16 + i * 12;
        const start = buf.readUInt32BE(g);
        const end = buf.readUInt32BE(g + 4);
        if (cp >= start && cp <= end) return buf.readUInt32BE(g + 8) + (cp - start);
      }
      return 0;
    };
  }
  if (format4 !== null) {
    const sub = format4;
    const segCount = buf.readUInt16BE(sub + 6) / 2;
    const ends = sub + 14;
    const starts = ends + segCount * 2 + 2;
    const deltas = starts + segCount * 2;
    const offsets = deltas + segCount * 2;
    return (cp) => {
      if (cp > 0xffff) return 0;
      for (let i = 0; i < segCount; i++) {
        if (cp > buf.readUInt16BE(ends + i * 2)) continue;
        const start = buf.readUInt16BE(starts + i * 2);
        if (cp < start) return 0;
        const delta = buf.readInt16BE(deltas + i * 2);
        const rangeOffset = buf.readUInt16BE(offsets + i * 2);
        if (rangeOffset === 0) return (cp + delta) & 0xffff;
        const g = buf.readUInt16BE(offsets + i * 2 + rangeOffset + (cp - start) * 2);
        return g === 0 ? 0 : (g + delta) & 0xffff;
      }
      return 0;
    };
  }
  throw new Error("font has no Unicode cmap");
}

/** The width of `text` at `fontSize` px, from the advances alone. */
export function textWidth(metrics: FontMetrics, text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    units += metrics.advance(ch.codePointAt(0)!) ?? FALLBACK_EM * metrics.unitsPerEm;
  }
  return (units * fontSize) / metrics.unitsPerEm;
}
