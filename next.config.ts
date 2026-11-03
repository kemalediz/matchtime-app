import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The list poster and team sheet (2026-10-14) read Barlow Condensed from
  // assets/fonts at request time (src/lib/match-graphics-render.tsx); a
  // runtime readFile is not traced on its own, so the fonts are named here.
  outputFileTracingIncludes: {
    "/api/graphics/*": ["./assets/fonts/**/*"],
    // The Posters card's previews (2026-10-14) draw the same graphics.
    "/api/org/graphics/*": ["./assets/fonts/**/*"],
    // A shared /play link's picture (2026-11-03): the fonts and the icon.
    "/play/opengraph-image": ["./assets/fonts/**/*", "./brand/matchtime-icon-192.png"],
    "/play/twitter-image": ["./assets/fonts/**/*", "./brand/matchtime-icon-192.png"],
  },
};

export default nextConfig;
