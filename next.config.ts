import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The list poster and team sheet (2026-10-14) read Barlow Condensed from
  // assets/fonts at request time (src/lib/match-graphics-render.tsx); a
  // runtime readFile is not traced on its own, so the fonts are named here.
  outputFileTracingIncludes: {
    "/api/graphics/*": ["./assets/fonts/**/*"],
  },
};

export default nextConfig;
