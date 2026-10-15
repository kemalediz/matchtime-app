/**
 * Ids as a log line may carry them (2026-10-15).
 *
 * bot.log on the Pi held full phone numbers: every `[baileys][msg]` line
 * printed the DM chat (`<number>@s.whatsapp.net`), the sender
 * (`<number>@c.us`), the resolved phone and the sender's name. A log is
 * copied, pasted and backed up; a phone number in it is personal data that
 * nobody needed to read the line. The last three digits are enough to tell
 * two people apart while reading a log.
 *
 * A modern group id (`120363...@g.us`) is not a person and is kept whole:
 * it is how every other line about a group is matched up. An old-style
 * group id begins with its creator's phone, and that part is masked.
 */

/** `***961`: the last three digits, or `***` for fewer. */
export function maskDigits(digits: string | null | undefined): string {
  if (typeof digits !== "string" || !digits) return "?";
  const d = digits.replace(/\D/g, "");
  return d.length > 3 ? `***${d.slice(-3)}` : "***";
}

const PERSON_JID = /(?<![\d*])(\d{4,})(?::\d+)?@(s\.whatsapp\.net|c\.us|hosted\.lid|hosted|lid)(?![A-Za-z.])/g;
const OLD_GROUP = /(?<![\d*])(\d{6,})-(\d+)@g\.us/g;

/**
 * Every person's JID inside a log line, masked: phone and LID JIDs in any
 * spelling, inside a serialised message id too (`false_447...@c.us_ABC`),
 * and the creator's phone in an old-style group id. Everything else as it
 * was. The driver passes every line it writes through this.
 */
export function maskIdsIn(line: string): string {
  if (typeof line !== "string") return line;
  return line
    .replace(PERSON_JID, (_m, user: string, server: string) => `${maskDigits(user)}@${server}`)
    .replace(OLD_GROUP, (_m, phone: string, ts: string) => `${maskDigits(phone)}-${ts}@g.us`);
}

export function maskJid(jid: string | null | undefined): string {
  if (typeof jid !== "string" || !jid) return "?";
  const at = jid.indexOf("@");
  if (at < 0) return /^\+?\d{4,}$/.test(jid) ? maskDigits(jid) : jid;
  const user = jid.slice(0, at);
  const server = jid.slice(at + 1);
  if (server === "g.us") {
    const old = /^(\d{6,})-(\d+)$/.exec(user);
    return old ? `${maskDigits(old[1])}-${old[2]}@g.us` : jid;
  }
  if (server === "s.whatsapp.net" || server === "c.us" || server === "lid" || server === "hosted" || server === "hosted.lid") {
    return `${maskDigits(user.split(":")[0])}@${server}`;
  }
  return jid;
}
