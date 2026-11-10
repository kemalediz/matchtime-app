/**
 * The picture under a shared /play link (2026-11-03; centred 2026-11-10),
 * 1200x630, for Facebook, Nextdoor, WhatsApp and X (`twitter-image.tsx` is
 * this one). Player-facing and plain: the headline and "Free to join", no
 * prices and nothing for organisers. The words are `pool-link-preview`'s,
 * in English as /play is. Generated once at build time (no request data).
 *
 * Some Facebook mobile layouts centre-crop it to the middle 630x630 square,
 * so the logo and every word sit in the centred safe area
 * (`SHARE_IMAGE_SAFE_AREA`, x 330 to 870); the sides carry only faint pitch
 * markings so the wide version still looks full. Pinned on the pixels by
 * `__tests__/opengraph-image.test.ts`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { poolLinkPreviewCopy } from "@/lib/i18n/pool-link-preview";
import { SHARE_IMAGE, SHARE_IMAGE_SAFE_AREA as SAFE } from "@/lib/pool/share-image-layout";

const copy = poolLinkPreviewCopy("en");

export const alt = copy.imageAlt;
export const size = { width: SHARE_IMAGE.width, height: SHARE_IMAGE.height };
export const contentType = "image/png";

const FONT = "Barlow Condensed";
const LINE = "rgba(255,255,255,0.13)";
const STROKE = 4;

/** One end of a pitch, drawn against the left or right edge, outside the safe area. */
function PitchEnd({ side }: { side: "left" | "right" }) {
  const W = SHARE_IMAGE.width;
  const H = SHARE_IMAGE.height;
  // Penalty box 400 tall, goal box 180, spot 140 in from the goal line, the
  // "D" (radius 105 round the spot) only where it leaves the box.
  const box = { depth: 210, top: (H - 400) / 2, height: 400 };
  const goal = { depth: 84, top: (H - 180) / 2, height: 180 };
  const spot = 140;
  const r = 105;
  const at = (x: number, width: number) => (side === "left" ? { left: x } : { left: W - x - width });
  // The goal line is the picture's edge: no border drawn on that side.
  const open = side === "left" ? { borderLeftWidth: 0 } : { borderRightWidth: 0 };
  // The "D": a circle round the spot with only its far quarter drawn (the
  // part outside the box).
  const arc = side === "left" ? { borderRightColor: LINE } : { borderLeftColor: LINE };
  return (
    <>
      <div style={{ position: "absolute", top: box.top, width: box.depth, height: box.height, border: `${STROKE}px solid ${LINE}`, ...open, ...at(0, box.depth) }} />
      <div style={{ position: "absolute", top: goal.top, width: goal.depth, height: goal.height, border: `${STROKE}px solid ${LINE}`, ...open, ...at(0, goal.depth) }} />
      <div style={{ position: "absolute", top: H / 2 - 7, width: 14, height: 14, borderRadius: 999, background: LINE, ...at(spot - 7, 14) }} />
      <div
        style={{
          position: "absolute",
          top: H / 2 - r,
          width: 2 * r,
          height: 2 * r,
          borderRadius: 999,
          border: `${STROKE}px solid transparent`,
          ...arc,
          ...at(spot - r, 2 * r),
        }}
      />
      {/* Corner arcs, top and bottom. */}
      <div style={{ position: "absolute", top: -44, width: 88, height: 88, borderRadius: 999, border: `${STROKE}px solid ${LINE}`, ...at(-44, 88) }} />
      <div style={{ position: "absolute", top: H - 44, width: 88, height: 88, borderRadius: 999, border: `${STROKE}px solid ${LINE}`, ...at(-44, 88) }} />
    </>
  );
}

export default async function Image() {
  const root = process.cwd();
  const [extra, icon] = await Promise.all([
    readFile(path.join(root, "assets", "fonts", "BarlowCondensed-ExtraBold.ttf")),
    readFile(path.join(root, "brand", "matchtime-icon-192.png")),
  ]);
  const iconSrc = `data:image/png;base64,${icon.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          color: "white",
          background: "linear-gradient(150deg, #0f172a 0%, #1e3a8a 60%, #1e40af 100%)",
          fontFamily: FONT,
        }}
      >
        {/* A soft light behind the words. */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: SHARE_IMAGE.width,
            height: SHARE_IMAGE.height,
            background: "radial-gradient(circle at 50% 50%, rgba(59,130,246,0.32) 0%, rgba(59,130,246,0) 45%)",
          }}
        />
        <PitchEnd side="left" />
        <PitchEnd side="right" />

        <div
          style={{
            position: "absolute",
            left: SAFE.left,
            top: SAFE.top,
            width: SAFE.right - SAFE.left,
            height: SAFE.bottom - SAFE.top,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <img src={iconSrc} width={64} height={64} alt="" style={{ borderRadius: 16 }} />
            <div style={{ marginLeft: 16, fontWeight: 800, fontSize: 46, letterSpacing: 0.5 }}>MatchTime</div>
          </div>

          <div style={{ display: "flex", marginTop: 26, fontWeight: 800, fontSize: 84, lineHeight: 1.0, textAlign: "center", justifyContent: "center", maxWidth: SAFE.right - SAFE.left }}>
            {copy.title}
          </div>

          <div
            style={{
              display: "flex",
              marginTop: 30,
              padding: "10px 30px",
              borderRadius: 999,
              background: "#22c55e",
              color: "#052e16",
              fontWeight: 800,
              fontSize: 36,
            }}
          >
            {copy.imageBadge}
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: FONT, data: extra, weight: 800, style: "normal" }],
    },
  );
}
