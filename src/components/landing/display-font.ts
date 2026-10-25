import type { CSSProperties } from "react";

/** The website's display face (Plus Jakarta Sans, loaded in app/layout.tsx).
 *  Its own module so the client menu can use it without the sections. */
export const DISPLAY_FONT: CSSProperties = {
  fontFamily: "var(--font-display), system-ui, sans-serif",
};
