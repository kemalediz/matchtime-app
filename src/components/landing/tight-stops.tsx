import type { ReactNode } from "react";

/**
 * Display headings: pull each full stop back towards the word before it.
 *
 * Measured in the browser (2026-10-26): the headline is one text node with
 * no space ("Your players WhatsApp."), but Plus Jakarta Sans's "." glyph
 * starts its ink about 0.13em past its origin (canvas measureText at 36px:
 * actualBoundingBoxLeft -4.64px), so at the headings' tight tracking it
 * reads as "WhatsApp ." A -0.1em margin on the stop closes that gap. The
 * text itself is unchanged, so copy and screen readers read it as written.
 */
export const STOP_PULL = "-0.1em";

export function tightStops(node: ReactNode): ReactNode {
  if (typeof node !== "string") return node;
  // A stop at the end, or before a space: never one inside "1.2" or a URL.
  const parts = node.split(/\.(?=\s|$)/);
  if (parts.length === 1) return node;
  return parts.map((part, i) => (
    <span key={i}>
      {part}
      {i < parts.length - 1 && (
        <span data-stop="" style={{ marginLeft: STOP_PULL }}>
          .
        </span>
      )}
    </span>
  ));
}
