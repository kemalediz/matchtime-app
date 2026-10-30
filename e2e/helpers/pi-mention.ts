/**
 * THE PI'S MENTION FLAG, AS THE REAL PI SETS IT (2026-10-30).
 *
 * Since "no string parsing" the server reads no bot name in a body: a tag
 * is the Pi's structured `botMentioned` (or a reply to MatchTime, or the
 * router's own reading). The real Pi sets `botMentioned` and rewrites the
 * mention into the literal "@Match Time" in ONE function
 * (`whatsapp-bot/src/mentions.ts`), so a body carrying that rewrite always
 * arrives with the flag true. Specs that write "@Match Time" in a body get
 * the same here, unless they set the flag themselves (to exercise a
 * regression of it). Test infrastructure only.
 */
export function piBotMentioned(body: string, explicit: boolean | undefined): boolean | undefined {
  if (typeof explicit === "boolean") return explicit;
  return (body ?? "").includes("@Match Time") ? true : undefined;
}
