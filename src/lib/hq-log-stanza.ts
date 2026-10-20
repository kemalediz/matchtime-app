/**
 * MATCHTIME'S HQ LINES CARRY THEIR SEND'S STANZA ID (review of #341,
 * findings 4 and 5). When the Pi acks one of MatchTime's posts in a club's
 * admin group (an inline HQ reply, `hqreply:<orgId>:...`, or an
 * `admin-group` BotJob such as the teams proposal), the HQ log row that
 * recorded the same words (`recordMatchTimeQuestion`) gets the stanza id,
 * so a YES quoting it is decided by the id (`quotedLogRow`). Our own two
 * copies of one string are compared, never a person's words. Never throws.
 */
import { db } from "./db";
import { botJobIdOfKey } from "./dispatch-claim";

const LOG_TEXT_MAX = 500;
/** The logged line is written in the same request as the send is claimed. */
const WINDOW_MS = 2 * 60 * 1000;

export async function stampHqLogStanza(key: string, waStanzaId: string | null): Promise<number> {
  if (!waStanzaId) return 0;
  try {
    let orgId: string | null = null;
    let text: string | null = null;
    let at: Date | null = null;
    if (key.startsWith("hqreply:")) {
      orgId = key.split(":")[1] ?? null;
      const row = await db.sentNotification.findUnique({ where: { key }, select: { text: true, createdAt: true } });
      text = row?.text ?? null;
      at = row?.createdAt ?? null;
    } else {
      const jobId = botJobIdOfKey(key);
      if (!jobId) return 0;
      const job = await db.botJob.findUnique({ where: { id: jobId }, select: { orgId: true, kind: true, text: true, createdAt: true } });
      if (!job || job.kind !== "admin-group") return 0;
      orgId = job.orgId;
      text = job.text;
      at = job.createdAt;
    }
    if (!orgId || !text || !at) return 0;
    const { count } = await db.adminGroupMessage.updateMany({
      where: {
        orgId,
        fromMatchTime: true,
        waStanzaId: null,
        text: text.slice(0, LOG_TEXT_MAX),
        createdAt: { gte: new Date(at.getTime() - WINDOW_MS), lte: new Date(at.getTime() + WINDOW_MS) },
      },
      data: { waStanzaId },
    });
    return count;
  } catch (err) {
    console.error(`[ack] HQ log stanza for ${key} not stamped:`, err instanceof Error ? err.message : "failed");
    return 0;
  }
}
