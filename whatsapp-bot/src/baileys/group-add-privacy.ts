/**
 * WHO MAY ADD MATCHTIME TO A GROUP: the value the server holds (2026-10-15).
 *
 * A new organiser's add was refused with "Can't add MatchTime ... invite
 * them privately", while MatchTime's phone showed Settings > Privacy >
 * Groups = Everyone. The phone's screen and the server's value are not
 * proven to agree, so on the first open of each process this reads the
 * server's privacy settings (`sock.fetchPrivacySettings(true)`: rc14
 * returns the `category` children of the privacy IQ as a flat
 * `{ name: value }` dictionary, `groupadd` among them), logs ONE line with
 * the `groupadd` value only, and when it is not `all` sets it with
 * `sock.updateGroupsAddPrivacy("all")` (rc14: a privacy `set` IQ with
 * `category name="groupadd" value="all"`) and logs the outcome.
 *
 * Once per process, not per reconnect: an open happens on every reconnect.
 * A failed READ may be tried again on a later open (at most three tries in
 * all), a failed update is not. Every failure is logged and swallowed: this
 * is a diagnosis and a nudge, never a reason for the bot to stop.
 *
 * MT_GROUPADD_PRIVACY_FIX=0 (or false/off/no) switches it off.
 */

const PREFIX = "[baileys][privacy]";
const MAX_READ_TRIES = 3;
const KNOWN_VALUES = new Set(["all", "contacts", "contact_blacklist", "none"]);

export interface PrivacySocketLike {
  fetchPrivacySettings?(force?: boolean): Promise<Record<string, string> | undefined | null>;
  updateGroupsAddPrivacy?(value: "all"): Promise<void>;
}

export function groupAddPrivacyEnabled(env: Record<string, string | undefined>): boolean {
  const v = (env.MT_GROUPADD_PRIVACY_FIX ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

function errorText(err: unknown): string {
  const t = err instanceof Error ? err.message : String(err);
  return t.replace(/\S*\d{6,}\S*/g, "<id>").slice(0, 120);
}

export function createGroupAddPrivacyCheck(opts: {
  enabled: boolean;
  /** Shadow mode: read and log, never change a WhatsApp setting. */
  readOnly?: boolean;
  log(line: string): void;
  error(line: string): void;
}): { onOpen(sock: PrivacySocketLike | null | undefined): Promise<void> } {
  let finished = !opts.enabled;
  let tries = 0;
  let running = false;

  return {
    async onOpen(sock) {
      if (finished || running) return;
      running = true;
      try {
        if (!sock || typeof sock.fetchPrivacySettings !== "function") {
          finished = true;
          opts.error(`${PREFIX} this socket cannot read privacy settings; groupadd not checked`);
          return;
        }
        tries++;
        let value: string | null;
        try {
          const settings = await sock.fetchPrivacySettings(true);
          const raw = settings?.groupadd;
          value = typeof raw === "string" ? raw : null;
        } catch (err) {
          if (tries >= MAX_READ_TRIES) finished = true;
          opts.error(
            `${PREFIX} could not read the groupadd value: ${errorText(err)}` +
              (finished ? " (giving up until the next restart)" : " (will try again on the next open)"),
          );
          return;
        }
        finished = true;
        const shown = value === null ? "(not reported)" : KNOWN_VALUES.has(value) ? value : "(unrecognised value)";
        if (value === "all") {
          opts.log(`${PREFIX} groupadd=all (anyone can add MatchTime to a group)`);
          return;
        }
        opts.log(`${PREFIX} groupadd=${shown}`);
        if (opts.readOnly) {
          opts.log(`${PREFIX} groupadd left at ${shown}: this process may not change WhatsApp settings (shadow mode)`);
          return;
        }
        if (typeof sock.updateGroupsAddPrivacy !== "function") {
          opts.error(`${PREFIX} this socket cannot update privacy settings; groupadd left at ${shown}`);
          return;
        }
        try {
          await sock.updateGroupsAddPrivacy("all");
          opts.log(`${PREFIX} groupadd set from ${shown} to all`);
        } catch (err) {
          opts.error(`${PREFIX} could not set groupadd to all: ${errorText(err)}`);
        }
      } finally {
        running = false;
      }
    },
  };
}
