/**
 * Bring `#id` into view when the page's address points at it.
 *
 * A section drawn only after its data has loaded is not in the page when
 * the browser jumps to the address's #section, so a link to it lands at the
 * top. The section calls this once it is drawn. True when it scrolled.
 *
 * Instant, not the page's smooth default: cards above the section are still
 * loading, and only an instant jump lets the browser's scroll anchoring keep
 * the section in view as they push it down.
 */
export function scrollToHashTarget(
  id: string,
  doc: Pick<Document, "getElementById"> = document,
  loc: Pick<Location, "hash"> = window.location,
): boolean {
  if (loc.hash !== `#${id}`) return false;
  const el = doc.getElementById(id);
  if (!el) return false;
  el.scrollIntoView({ block: "start", behavior: "instant" });
  return true;
}
