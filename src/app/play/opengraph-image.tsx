/**
 * The picture under a shared /play link (2026-11-03), 1200x630, for
 * Facebook, Nextdoor, WhatsApp and X (`twitter-image.tsx` is this one).
 * Player-facing and plain: what he gets in three lines, free to join, no
 * prices and nothing for organisers. The words are `pool-link-preview`'s,
 * in English as /play is. Generated once at build time (no request data).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { poolLinkPreviewCopy } from "@/lib/i18n/pool-link-preview";

const copy = poolLinkPreviewCopy("en");

export const alt = copy.imageAlt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const FONT = "Barlow Condensed";
const BODY = "Barlow";

export default async function Image() {
  const root = process.cwd();
  const [extra, semi, body, icon] = await Promise.all([
    readFile(path.join(root, "assets", "fonts", "BarlowCondensed-ExtraBold.ttf")),
    readFile(path.join(root, "assets", "fonts", "BarlowCondensed-SemiBold.ttf")),
    readFile(path.join(root, "assets", "fonts", "Barlow-Medium.ttf")),
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
          flexDirection: "column",
          padding: "48px 72px 40px",
          color: "white",
          background: "linear-gradient(150deg, #0f172a 0%, #1e3a8a 60%, #1e40af 100%)",
          fontFamily: BODY,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <img src={iconSrc} width={64} height={64} alt="" style={{ borderRadius: 16 }} />
            <div style={{ marginLeft: 18, fontFamily: FONT, fontWeight: 800, fontSize: 44, letterSpacing: 0.5 }}>MatchTime</div>
          </div>
          <div
            style={{
              display: "flex",
              padding: "10px 24px",
              borderRadius: 999,
              background: "#22c55e",
              color: "#052e16",
              fontFamily: FONT,
              fontWeight: 800,
              fontSize: 32,
            }}
          >
            {copy.imageBadge}
          </div>
        </div>

        <div style={{ display: "flex", marginTop: 34, fontFamily: FONT, fontWeight: 800, fontSize: 80, lineHeight: 1.02, maxWidth: 1000 }}>{copy.title}</div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: 30 }}>
          {copy.imageSteps.map((step, i) => (
            <div key={step} style={{ display: "flex", alignItems: "center", marginTop: i === 0 ? 0 : 14 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 48,
                  height: 48,
                  borderRadius: 999,
                  background: "#fbbf24",
                  color: "#0f172a",
                  fontFamily: FONT,
                  fontWeight: 800,
                  fontSize: 30,
                }}
              >
                {String(i + 1)}
              </div>
              <div style={{ display: "flex", marginLeft: 20, fontSize: 32, color: "#e2e8f0" }}>{step}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", marginTop: "auto", paddingTop: 16, fontFamily: FONT, fontWeight: 600, fontSize: 28, color: "#93c5fd" }}>matchtime.ai</div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: FONT, data: extra, weight: 800, style: "normal" },
        { name: FONT, data: semi, weight: 600, style: "normal" },
        { name: BODY, data: body, weight: 500, style: "normal" },
      ],
    },
  );
}
