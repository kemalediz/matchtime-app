/**
 * The WhatsApp names the bot already knows for people just added to a
 * group, for the server's group-join (2026-09-30). See join-names.test.ts.
 *
 * Reads `driver.getContact`, which on Baileys answers from the harvested
 * directory only (no network: a directory query is what got linked
 * devices unlinked on 2026-09-17). Best effort and bounded: a name that
 * is unknown, only a number, or slow to read is left out.
 */

function pick(contact: unknown): string | null {
  if (!contact || typeof contact !== "object") return null;
  const c = contact as { pushname?: unknown; name?: unknown };
  for (const v of [c.pushname, c.name]) {
    if (typeof v !== "string") continue;
    const name = v.trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 60) continue;
    if (/^[+\d\s().-]+$/.test(name)) continue;
    return name;
  }
  return null;
}

export async function namesForJoiners(
  phones: string[],
  getContact: (jid: string) => Promise<unknown>,
  timeoutMs = 1500,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const phone of phones) {
    try {
      const contact = await Promise.race([
        getContact(`${phone}@c.us`),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      const name = pick(contact);
      if (name) out[phone] = name;
    } catch {
      // Unknown is fine: the server names them from their first post.
    }
  }
  return out;
}
