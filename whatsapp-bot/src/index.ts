import type { GroupMembershipEvent, InboundMessage, InboundPollVote } from "./driver.js";
import { baileysLiveBanner, createDriver } from "./driver-select.js";
import {
  setMonitoredGroups,
  isMonitoredGroup,
  addMonitoredGroup,
  setOnboardingGroups,
  addOnboardingGroup,
} from "./handlers.js";
import { degradedMessage } from "./degraded.js";
import { asString, readInboundHeadline, readMessageBody, readNotifyName, safePath, safeRead } from "./wa-read.js";
import { handleGroupJoinForSelfAdd, type HistoryMessageForServer } from "./bot-added.js";
import {
  describeOrgSnapshotDiff,
  diffOrgSnapshot,
  parseOrgSnapshot,
  setOrgRefresher,
  startOrgRefreshTimer,
  stopOrgRefreshTimer,
  type OrgConfig,
  type OrgSnapshot,
} from "./org-refresh.js";
import { initScheduler, stopScheduler } from "./scheduler.js";
import {
  getEnabledOrgs,
  postReaction,
  postPollVote,
  postGroupJoin,
  postGroupLeave,
  postDmReply,
  postSyncParticipants,
  postBotAdded,
} from "./api.js";
import {
  enqueueForAnalysis,
  recordDegradedCapability,
  recordHistory,
  recoverGroupMessages,
  startBatchFlushTimer,
  stopBatchFlushTimer,
} from "./smart-analysis.js";
import { config } from "./config.js";
import { resolveWaMessageId } from "./message-id.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { resolveShadowMode, shadowBanner, shadowGroup, shadowOpenNotice } from "./shadow.js";

/**
 * Retry an async call a few times with a fixed delay. Used for the ONE
 * startup call whose failure silently disables the whole bot (org config).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  delayMs: number,
  label: string,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(
        `[startup] ${label} attempt ${i}/${attempts} failed:`,
        err instanceof Error ? err.message : err,
      );
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function main() {
  console.log("MatchTime WhatsApp Bot starting...");

  // ── Single-instance guard (2026-07-19 duplicate-send incident) ──────
  // Several bot processes were alive on the Pi at once (orphans left
  // outside systemd's cgroup by repeated `systemctl restart`), all
  // logged into the same WhatsApp account, all polling due-posts — so
  // one due instruction became 30+ group messages. Refuse to be the
  // second instance. Exit code is 0 under systemd on purpose: the unit
  // has Restart=on-failure, and a non-zero exit here would produce an
  // endless crash-restart loop. See instance-lock.ts.
  const lock = acquireInstanceLock();
  if (!lock.acquired) {
    console.error(
      `CRITICAL: another MatchTime bot instance is already running (pid ${lock.holderPid}). ` +
        `Refusing to start a second one — duplicate instances cause duplicate WhatsApp sends. ` +
        `Use scripts/deploy-pi.sh to restart cleanly; never bare 'systemctl restart'.`,
    );
    process.exit(lock.exitCode);
  }

  console.log(`API URL: ${config.apiUrl}`);

  // ── The WhatsApp line ────────────────────────────────────────────────
  // Everything below this point talks to a `WaDriver` and nothing else
  // (see src/driver.ts). Which library is underneath is one env var,
  // WA_DRIVER, defaulting to whatsapp-web.js, so today nothing changes;
  // Phase 3 of MDs/baileys-migration-plan-2026-09-21.md adds the
  // Baileys implementation behind the same interface. The client
  // construction, the WhatsApp Web version pin, the QR and the pairing
  // code all moved into src/drivers/wwebjs.ts, in the same order and with
  // the same log lines they had here.
  // ── Shadow mode (Phase 5 of the Baileys migration) ─────────────────
  // Read BEFORE the driver, because it decides what createDriver hands
  // back: with WA_SHADOW=1 the driver is wrapped so every send refuses,
  // and everything below that would have acted does not start. Unset, and
  // nothing here does anything at all.
  const shadow = resolveShadowMode(process.env);
  // Async since Phase 5: the Baileys driver is imported only when it is
  // actually selected, so an unset WA_DRIVER never loads the library.
  const driver = await createDriver(process.env);
  console.log(`WhatsApp driver: ${driver.name}`);
  if (shadow.enabled) console.log(shadowBanner(driver.name, shadow));
  const liveBanner = baileysLiveBanner(driver.name, shadow, process.env);
  if (liveBanner) console.log(liveBanner);

  // ── The Pi's picture of its groups, and how it stays current ──────────
  // Read at `ready`, every few minutes, and the moment a setup completes
  // (org-refresh.ts). Every consumer below reads the CURRENT snapshot:
  // the monitored set, the onboarding set, the scheduler's org list and
  // the flush timer's group list, so a group that becomes a live org
  // mid-run needs no restart.
  let currentSnapshot: OrgSnapshot | null = null;
  const currentOrgConfigs = (): OrgConfig[] => currentSnapshot?.orgConfigs ?? [];
  const currentOrgGroupIds = (): string[] => currentOrgConfigs().map((o) => o.groupId);

  async function refreshOrgs(reason: string): Promise<OrgSnapshot> {
    const data = await getEnabledOrgs();
    const next = parseOrgSnapshot(data);
    const diff = diffOrgSnapshot(currentSnapshot, next);
    currentSnapshot = next;
    setMonitoredGroups([...next.orgConfigs.map((o) => o.groupId), ...next.onboardingGroups]);
    setOnboardingGroups(next.onboardingGroups);
    // initScheduler is idempotent: a repeat call only replaces its org list.
    // Belt and braces in shadow mode: the open handler already returns
    // before anything calls this, and the scheduler must not start even if
    // some future path does.
    if (!shadow.enabled) initScheduler(driver, next.orgConfigs);
    if (diff.changed || reason === "ready") {
      console.log(
        `[org-refresh] (${reason}) ${next.orgConfigs.length} org(s), ${next.onboardingGroups.length} onboarding group(s): ` +
          describeOrgSnapshotDiff(diff),
      );
    }
    return next;
  }
  setOrgRefresher(async (reason) => {
    await refreshOrgs(reason);
  });

  driver.onOpen(async () => {
    console.log("\nWhatsApp bot is ready!");

    try {
      const groups = await driver.listGroups();
      console.log(`\n=== Groups this account is a member of (${groups.length}) ===`);
      groups.forEach((g) => {
        console.log(`  ${g.id}   "${g.name}"`);
      });
      console.log(`=== end groups ===\n`);
    } catch (err) {
      // Non-fatal: this block is a startup diagnostic only. But it is also
      // the CANARY for whatsapp-web.js's injected page code being out of
      // step with the live WhatsApp Web build (2026-08-28: this threw the
      // minified `r: r` while every contact/chat lookup on the inbound path
      // died the same way). Say so loudly rather than logging a bare error.
      // Logged AND reported. The log line is for whoever is reading the
      // journal; the record is what actually reaches a human, since since
      // 2026-09-09 the counters and this set travel off the Pi in the
      // 10-minute heartbeat. This particular one is the canary for the
      // whole injected layer.
      recordDegradedCapability("group-enumeration");
      console.error(degradedMessage("group-enumeration", err, undefined, driver.name));
    }

    // ── Shadow mode stops here ───────────────────────────────────────
    // Everything below acts: it starts the scheduler and the flush timer
    // (and with it the heartbeat, which would pollute the real Pi's health
    // signal), POSTs a roster to the server and replays messages into the
    // analyser. A receive-only run wants none of it. Inbound stays fully
    // wired, which is the whole point of the week.
    if (shadow.enabled) {
      console.log(shadowOpenNotice());
      // The one read a shadow run makes. WA_SHADOW_GROUP names the
      // throwaway group; this asks the driver what the restart catch-up
      // WOULD have been handed, and logs it. Nothing is enqueued, POSTed
      // or sent. It is how §2.15 gets its answer in the shape the real
      // catch-up sees, not only in the raw inbound lines.
      const watching = shadowGroup(process.env);
      if (watching) {
        try {
          const seen = await driver.fetchRecentGroupMessages(watching, 50);
          console.log(
            `[shadow] the restart catch-up would have been handed ${seen.length} message(s) ` +
              `for ${watching}. Zero after a restart that spanned real traffic means WhatsApp ` +
              "replayed nothing; see Phase 5 in MDs/baileys-migration-plan-2026-09-21.md.",
          );
        } catch (err) {
          console.error(
            `[shadow] the catch-up read for ${watching} failed: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return;
    }

    try {
      // Retry: everything below (scheduler, batch-flush timer, catch-up)
      // only ever starts here. A single transient failure used to leave the
      // bot connected to WhatsApp but permanently deaf and mute — no polling,
      // no analysis — until someone noticed and restarted it.
      const snapshot = await withRetry(() => refreshOrgs("ready"), 3, 5_000, "getEnabledOrgs");
      const orgConfigs = snapshot.orgConfigs;
      const onboardingGroups = snapshot.onboardingGroups;
      if (onboardingGroups.length)
        console.log(
          `Also monitoring ${onboardingGroups.length} onboarding group(s) (flushed immediately): ${onboardingGroups.join(", ")}`,
        );

      console.log(`Monitoring ${orgConfigs.length} group(s):`);
      orgConfigs.forEach((o) => console.log(`  - ${o.orgName} (${o.groupId})`));

      // Start the batch-flush timer. Every inbound group message is
      // buffered in-memory and flushed every 10 min (or immediately
      // when the next match is within an hour of kickoff, or when the
      // group is mid-setup), at which point the server-side analyser
      // classifies the batch and the bot executes the returned
      // reacts/replies. The group list is read fresh on every tick.
      startBatchFlushTimer(driver, currentOrgGroupIds);

      // And keep the org picture current without a restart.
      startOrgRefreshTimer();

      // Catch-up on reconnect: whatsapp-web.js silently DROPS messages
      // that arrive while the socket is down (during a deploy/restart).
      // Re-feed the last ~2h of each monitored group's messages into the
      // analyser — the server dedupes on waMessageId, so only genuinely
      // missed messages reach the LLM. Fixes the gap that lost Ibrahim's
      // "in" during a restart (Kemal 2026-06-06). Fire-and-forget; the
      // re-queued messages get classified by the startup flush above.
      recoverGroupMessages(driver, currentOrgGroupIds()).catch((err) =>
        console.error("[recover-group] sweep failed:", err),
      );

      // Backfill the "lurker gap": members who were in the WhatsApp
      // group before the bot joined, who haven't typed since (so
      // group_join + auto-provision never fired). Fire-and-forget on
      // every startup; idempotent on the server side. Ignores @lid
      // privacy participants — they're picked up by pushname-based
      // resolution the moment they message.
      for (const o of orgConfigs) {
        try {
          const participants = await driver.groupParticipants(o.groupId);
          // A chat object that resolves but carries no participants is the
          // QUIET version of the same breakage: nothing throws, we POST an
          // empty roster, the server reports "0 added, total=0" and everyone
          // assumes the group is simply already in sync. Treat it as the
          // failure it is.
          if (!Array.isArray(participants) || participants.length === 0) {
            recordDegradedCapability("participant-sync");
            console.error(
              degradedMessage(
                "participant-sync",
                "the chat resolved but its participants list was empty",
                `${o.orgName} (${o.groupId})`,
                driver.name,
              ),
            );
            // NOTE: this `continue` skips only the sync POST for THIS org
            // and moves to the next one. Nothing else in the loop body
            // runs after the POST, so no guard below is being deleted —
            // and the degradation is now recorded ABOVE the continue, so
            // it still reaches the server on the next heartbeat.
            continue;
          }
          const selfId = driver.selfId();
          const out: Array<{ phone?: string; lidId?: string; pushname?: string }> = [];
          for (const id of participants) {
            if (selfId && id === selfId) continue; // skip the bot itself
            let phone: string | undefined;
            let lidId: string | undefined;
            if (id.endsWith("@c.us")) {
              phone = id.replace("@c.us", "").replace(/^\+/, "");
            } else if (id.endsWith("@lid")) {
              lidId = id;
              // The contact record sometimes resolves the underlying phone;
              // try once, swallow any failure.
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const contact = (await driver.getContact(id)) as any;
                const num = contact.number;
                if (typeof num === "string" && num.length > 0) phone = num;
              } catch {
                /* ignore — server falls back to lurker-skipped */
              }
            }
            let pushname: string | undefined;
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const contact = (await driver.getContact(id)) as any;
              pushname = contact.pushname || contact.name || undefined;
            } catch {
              /* non-fatal */
            }
            out.push({ phone, lidId, pushname });
          }
          const result = await postSyncParticipants({
            groupId: o.groupId,
            participants: out,
          });
          if (result) {
            console.log(
              `[sync-participants] ${o.orgName}: ${result.added ?? 0} added, ${result.alreadyKnown ?? 0} known, ${result.skippedNoPhone ?? 0} no-phone, ${result.restoredMembership ?? 0} restored, total=${result.total ?? 0}`,
            );
          }
        } catch (err) {
          // Was `[sync-participants] <org> failed: r` — a line that told
          // nobody the web app's self-IN gate was about to start rejecting
          // real players. Say what it costs.
          recordDegradedCapability("participant-sync");
          console.error(degradedMessage("participant-sync", err, `${o.orgName} (${o.groupId})`, driver.name));
        }
      }
    } catch (err) {
      console.error(
        "CRITICAL: failed to fetch org configs after retries — the scheduler " +
          "and the batch-flush timer did NOT start, so nothing will be posted " +
          "and no inbound message will be analysed. Restart the bot with " +
          "scripts/deploy-pi.sh once the API is reachable. Cause:",
        err,
      );
    }

    // One-shot recovery: if BOT_RECOVER_DM_REPLIES=1, walk every
    // non-group chat, pick up the most recent inbound text message
    // from the last 48h, and replay it through the dm-reply pipe.
    // Uses chat.lastMessage (already cached on the chat object) so
    // we don't have to fetch history per chat — fetchMessages() was
    // failing with whatsapp-web.js "waitForChatLoading" errors for
    // chats not yet opened in the headless WA Web session.
    // Idempotent: dm-reply is upsert-by-(survey, user).
    if (process.env.BOT_RECOVER_DM_REPLIES === "1") {
      try {
        console.log("[recover] BOT_RECOVER_DM_REPLIES=1 — replaying recent DM replies");
        const dms = await driver.listDmChats();
        const cutoffSec = Math.floor(Date.now() / 1000) - 48 * 60 * 60;
        let replayed = 0;
        let skippedNoLast = 0;
        let skippedFromMe = 0;
        let skippedOldOrEmpty = 0;
        let errored = 0;
        for (const chat of dms) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lm = (chat as any).lastMessage;
            if (!lm) {
              skippedNoLast += 1;
              continue;
            }
            if (lm.fromMe) {
              skippedFromMe += 1;
              continue;
            }
            if ((lm.timestamp ?? 0) < cutoffSec) {
              skippedOldOrEmpty += 1;
              continue;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const dataBody = (lm as any)._data?.body;
            const text = (
              typeof lm.body === "string" && lm.body.length > 0
                ? lm.body
                : typeof dataBody === "string"
                  ? dataBody
                  : ""
            ).trim();
            if (text.length === 0) {
              skippedOldOrEmpty += 1;
              continue;
            }

            const fromId = (lm.from as string | undefined) ?? "";
            let phone = "";
            if (fromId.endsWith("@c.us")) {
              phone = fromId.replace("@c.us", "").replace(/^\+/, "");
            }
            let authorName: string | undefined;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rawNotify = (lm as any)._data?.notifyName;
            if (typeof rawNotify === "string" && rawNotify.trim()) {
              authorName = rawNotify.trim();
            } else if (chat.name && chat.name.trim()) {
              authorName = chat.name.trim();
            }

            await postDmReply({
              phone,
              authorName,
              body: text,
              waMessageId: lm.id?._serialized ?? "",
            });
            replayed += 1;
            console.log(
              `[recover] replayed from=${fromId} authorName=${authorName ?? "?"} text=${JSON.stringify(text.slice(0, 50))}`,
            );
            await new Promise((r) => setTimeout(r, 250));
          } catch (innerErr) {
            errored += 1;
            console.error(
              "[recover] chat replay failed for",
              chat.id,
              innerErr instanceof Error ? innerErr.message : innerErr,
            );
          }
        }
        console.log(
          `[recover] done: replayed=${replayed} noLast=${skippedNoLast} fromMe=${skippedFromMe} oldOrEmpty=${skippedOldOrEmpty} errored=${errored}`,
        );
      } catch (err) {
        console.error(
          "[recover] failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  });

  // Inbound group messages. EVERY message goes to the smart-analysis
  // pipeline — no regex fast-path. Claude sees the batch every 10 min
  // (or sooner if kickoff is within an hour) and decides intent:
  // IN / OUT / score / replacement_request / conditional_in / question
  // / noise / unclear. The server executes side effects (attendance,
  // scoring, Elo, replies) and hands back the WhatsApp-side actions
  // (react, reply) for the bot to perform.
  driver.onMessage(async (msg) => {
    try {
      // Read EVERY headline field through one total helper.
      //
      // These reads used to be direct (`msg.body`, `(msg as any)._data?.body`,
      // `msg.from`, `msg.type`, `msg.hasMedia`). Optional chaining guards a
      // null `_data`; it does NOT guard a `_data` that is a THROWING GETTER,
      // which is what whatsapp-web.js's broken injected build produces. A
      // throw here lands in this handler's outer catch and the message is
      // lost before `enqueueForAnalysis` — which PRs #11/#13 went to some
      // trouble to make total — is ever reached. Same silent drop, one frame
      // earlier. See wa-read.ts.
      //
      // (The `_data.body` fallback itself predates all this: for chats the
      // bot hasn't fully synced, `msg.body` is empty while the raw payload
      // still carries the text. Found when 50+ roster-survey DM replies all
      // logged bodyLen=0 despite being plain text in WhatsApp.)
      const head = readInboundHeadline(msg);
      const effectiveBody = head.body;

      // Diagnostic — log every incoming message's headline metadata
      // so we can debug the DM-reply path without re-deploying.
      // Trim if too noisy in production.
      console.log(
        `[msg] from=${head.from} fromMe=${head.fromMe} type=${head.type} bodyLen=${effectiveBody.length} hasMedia=${head.hasMedia}`,
      );

      if (head.fromMe) return;

      // 1-1 DM detection: anything that's NOT a group (@g.us) is
      // treated as a DM. Sender JID can be @c.us (phone-keyed) or
      // @lid (privacy-mode, opaque). For @c.us we extract the phone.
      // For @lid we forward an empty phone + the sender's pushname,
      // and let the server resolve by name against open survey DMs.
      const isGroup = head.from.endsWith("@g.us");
      if (!isGroup) {
        const text = effectiveBody.trim();

        // Non-text replies (voice notes, images, stickers, audio,
        // video) come in with empty msg.body. The roster-survey
        // classifier only handles text — nudge the sender to retype
        // in words. Reply at most once per inbound non-text DM so we
        // don't spam reactions/system events; the server side gates
        // on the user's open-survey state too.
        if (text.length === 0) {
          const isMediaReply =
            head.hasMedia ||
            ["audio", "ptt", "image", "video", "sticker", "document"].includes(head.type);
          if (isMediaReply) {
            try {
              await driver.replyTo(
                msg,
                "Hey 👋 I can only read text replies for the check-in. Could you type a quick word or two?\n\n" +
                  "• \"yes\" / \"I'm in\" — keep me on the roster\n" +
                  "• \"maybe\" / \"depends\"\n" +
                  "• \"not for now\" / \"out\"",
              );
              console.log(`[dm] nudged non-text reply from=${head.from} type=${head.type}`);
            } catch (err) {
              console.error("dm nudge reply failed:", err);
            }
          }
          return;
        }
        let phone = "";
        if (head.from.endsWith("@c.us")) {
          phone = head.from.replace("@c.us", "").replace(/^\+/, "");
        }
        // Pushname / contact name — fallback identifier.
        let authorName: string | undefined = head.notifyName ?? undefined;
        // @lid privacy DMs hide the phone in the JID (msg.from ends in
        // "@lid", not "@c.us"). Without a phone the server can't map the
        // sender to a user and drops the reply as "unknown sender" — which
        // silently broke collector fee replies ("£10 each"), DM Q&A, etc.
        // Recover the real number (and name) from the contact record.
        if (!phone || !authorName) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const contact = (await driver.contactOf(msg)) as any;
            if (!phone) {
              // Contact.number is the real phone even when the JID is @lid.
              const num = contact?.number;
              if (num && String(num).trim()) {
                phone = String(num).replace(/[^\d]/g, "");
              }
            }
            if (!authorName) {
              const pn = contact.pushname || contact.name;
              if (pn && pn.trim()) authorName = pn.trim();
            }
          } catch {
            /* non-fatal */
          }
        }
        console.log(
          `[dm] resolved from=${head.from} phone=${phone || "?"} name=${authorName ?? "?"}`,
        );
        try {
          // `/api/whatsapp/dm-reply` 400s on an empty waMessageId, so the old
          // `msg.id?._serialized ?? ""` silently binned every DM reply once
          // the injected page code stopped exposing a readable id — the same
          // failure that killed group attendance on 2026-08-30. Degrade to a
          // deterministic synthetic id instead (the route only uses the field
          // as a presence check, so a stand-in is safe).
          await postDmReply({
            phone,
            authorName,
            body: text,
            waMessageId: resolveWaMessageId(msg).waMessageId,
          });
          console.log(
            `[dm] forwarded reply from=${head.from} authorName=${authorName ?? "?"}`,
          );
        } catch (err) {
          console.error("dm-reply forward failed:", err);
        }
        return;
      }

      // Phase 2: a group the bot isn't monitoring yet can bootstrap
      // itself with an explicit "@MatchTime setup". Loose pre-filter
      // here (server has the authoritative tight regex); on a hit we
      // start monitoring this group dynamically so the trigger + all
      // subsequent onboarding answers flow through the normal analyze
      // path. Everything else from unmonitored groups is still
      // dropped (no extra server load).
      //
      // 2026-05-25: also treat an @-mention of the bot's own JID as a
      // match. Reason: when a real user types `@MatchTime setup`,
      // WhatsApp replaces the visible "@MatchTime" with the bot's
      // PHONE NUMBER in the raw body (e.g. "@447... setup"), so a
      // literal-text-only regex misses every real @-mention. Without
      // this, every Amir-group setup attempt got silently dropped.
      if (!isMonitoredGroup(head.from)) {
        const t = effectiveBody.toLowerCase();
        // Both reads below go through the driver into whatsapp-web.js's
        // injected page code and can THROW on a build mismatch. Unguarded
        // they'd escape to the outer catch and drop the message entirely, so
        // the setup trigger could never fire while the library was broken.
        // Degrade to the text regex. (This is the one caller of `selfId()`
        // that survives the throw; the other three deliberately do not.)
        let selfId: string | undefined;
        try {
          selfId = driver.selfId(); // e.g. "447...@c.us"
        } catch {
          /* non-fatal — fall back to the literal "match time" regex below */
        }
        let mentionedIds: string[] = [];
        try {
          mentionedIds = msg.mentionedIds ?? [];
        } catch {
          /* non-fatal */
        }
        const mentionsBot = !!selfId && mentionedIds.includes(selfId);
        const looksLikeSetup =
          (mentionsBot || /match\s*time/.test(t)) &&
          /(?<!\p{L})(set\s*up|setup|get\s*started|onboard|kurulum|kuralım|kuralim)(?!\p{L})/u.test(
            effectiveBody.toLocaleLowerCase("tr"),
          );
        if (!looksLikeSetup) return;
        addMonitoredGroup(head.from);
        console.log(
          `[onboarding] setup trigger in ${head.from} — now monitoring (mentionsBot=${mentionsBot})`,
        );
      }

      // WhatsApp pushname — the sender's self-set profile name. Used
      // for auto-enrolment on new phones and for name-based fallback
      // when the sender is an @lid (opaque, no phone).
      let authorName: string | undefined = head.notifyName ?? undefined;
      if (!authorName) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const contact = (await driver.contactOf(msg)) as any;
          const pn = contact.pushname || contact.name;
          if (pn && pn.trim()) authorName = pn.trim();
        } catch {
          /* non-fatal — missing name just means server falls back to phone */
        }
      }

      // Context buffer the analyser reads for nuanced classification.
      recordHistory(head.from, {
        authorName: authorName ?? null,
        body: effectiveBody,
        timestamp: new Date(head.timestampSec * 1000).toISOString(),
      });

      await enqueueForAnalysis(driver, msg);
    } catch (err) {
      console.error("message handler failed:", err);
    }
  });

  // Reactions on any tracked message (bench-prompt 👍/👎). Forward to server
  // and let it decide the outcome.
  driver.onReaction(async (reaction) => {
    try {
      // Total reads — `msgId` is an id object built by the injected page
      // code, so on a broken build it is a throwing getter, not merely
      // absent.
      const waMessageId = asString(safePath(reaction, "msgId", "_serialized"));
      const fromId = asString(safeRead(reaction, "senderId"));
      const emoji = asString(safeRead(reaction, "reaction"));

      // An EMPTY emoji is a reaction being REMOVED, which is a normal thing
      // for a player to do — quietly ignore it. Only a missing id or sender
      // means we actually lost something.
      if (!emoji) return;
      if (!waMessageId || !fromId) {
        // Used to be a bare `return`. A bench-prompt 👍/👎 that lands here is
        // gone for good: there is no synthetic-id trick available, because
        // the server has to JOIN this reaction to the bench prompt it already
        // sent, and only the real WhatsApp id can do that. So the only honest
        // thing is to say so.
        recordDegradedCapability("reaction-forwarding");
        console.error(
          degradedMessage(
            "reaction-forwarding",
            `msgId=${waMessageId || "?"} senderId=${fromId || "?"} emoji=${emoji}`,
            undefined,
            driver.name,
          ),
        );
        return;
      }
      // @c.us reactors carry a phone in the senderId. @lid privacy
      // reactors don't — sending the opaque @lid string as a "phone"
      // is useless, so forward an empty phone + the pushname instead
      // and let the server verify identity against the expected bench
      // player. Mirrors the poll-vote + DM @lid handling. (Without
      // this, every privacy-mode bench player's 👍/👎 was silently
      // dropped — Kemal flagged Erdal's lost 👎 on 2026-05-18.)
      const isCus = fromId.endsWith("@c.us");
      const phone = isCus ? fromId.replace("@c.us", "").replace(/^\+/, "") : "";
      let fromAuthorName: string | undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const contact = (await driver.getContact(fromId)) as any;
        fromAuthorName =
          contact?.pushname ||
          contact?.name ||
          (contact as { verifiedName?: string })?.verifiedName ||
          undefined;
      } catch {
        // best-effort — server falls back to phone match if unavailable
      }
      await postReaction({ waMessageId, emoji, fromPhone: phone, fromAuthorName });
    } catch (err) {
      console.error("Error forwarding reaction:", err);
    }
  });

  // Poll votes — forwarded to the server so MoM polls can merge with app
  // votes. The wweb.js event delivers a PollVote object with the voter
  // and the selected option names.
  driver.onPollVote(async (vote: InboundPollVote) => {
    try {
      const waMessageId = vote.parentMessage?.id?._serialized;
      const voterId = vote.voter;
      if (!waMessageId || !voterId) return;
      const phone = voterId.replace("@c.us", "").replace(/^\+/, "");
      // selectedOptions can be empty (un-vote).
      const picked = vote.selectedOptions?.[0]?.name ?? null;
      // Pull the voter's pushname so the server can fuzzy-match as a
      // fallback when WhatsApp's @lid privacy hides the phone.
      let voterName: string | undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const contact = (await driver.getContact(voterId)) as any;
        voterName =
          contact?.pushname ||
          contact?.name ||
          (contact as { verifiedName?: string })?.verifiedName ||
          undefined;
      } catch {
        // best-effort — server falls back to phone match if unavailable
      }
      await postPollVote({ waMessageId, voterPhone: phone, voterName, optionName: picked });
    } catch (err) {
      console.error("Error forwarding poll vote:", err);
    }
  });

  // Group-membership events — someone joined or left a monitored group.
  // We forward the phone numbers (minus `@c.us`, minus any `@lid`
  // participants we can't resolve) to the server, which auto-onboards
  // new joiners and marks leavers as `leftAt` without destroying their
  // history. DMs to admins are queued server-side.
  //
  // Self-events (the bot itself being added/removed) are skipped so we
  // don't DM admins about the bot joining its own group.
  function extractPhones(recipientIds: string[] | undefined, selfId: string | undefined): string[] {
    if (!Array.isArray(recipientIds)) return [];
    return recipientIds
      .filter((id) => id.endsWith("@c.us"))
      .filter((id) => id !== selfId)
      .map((id) => id.replace("@c.us", "").replace(/^\+/, ""))
      .filter((p) => p.length > 0);
  }

  // Self-setup history capture (2026-09-17): the group's recent messages,
  // shaped for the server, WITHOUT getChatById (the bare Chat handle from
  // PR #84). WhatsApp may not have synced history to a freshly-joined
  // member yet, so this retries a couple of times. Best-effort: any
  // failure returns [] and the intro still goes out.
  async function collectHistoryForServer(
    groupId: string,
    selfIds: string[],
  ): Promise<HistoryMessageForServer[]> {
    const LIMIT = 600;
    const ATTEMPTS = 3;
    const RETRY_MS = 4000;
    const MIN_USEFUL = 5; // fewer → assume history hasn't synced yet
    const self = new Set(selfIds);

    let raw: InboundMessage[] = [];
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        raw = await driver.fetchRecentGroupMessages(groupId, LIMIT);
      } catch (err) {
        raw = [];
        console.warn(
          `[bot-added] history fetch attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      console.log(`[bot-added] history fetch attempt ${attempt}: got ${raw.length} msgs`);
      if (raw.length >= MIN_USEFUL) break;
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_MS));
    }
    if (raw.length === 0) return [];

    // Oldest → newest; never rely on the page's order.
    const dated = raw.map((m) => ({ m, t: Number(safeRead(m, "timestamp") ?? 0) || 0 }));
    dated.sort((a, b) => a.t - b.t);

    const out: HistoryMessageForServer[] = [];
    for (const { m, t } of dated) {
      try {
        if (safeRead(m, "fromMe") === true) continue;
        const author = asString(safeRead(m, "author")) ?? asString(safeRead(m, "from")) ?? "";
        if (self.has(author)) continue;
        const text = readMessageBody(m);
        if (!text.trim()) continue;
        // The pushname is on the serialised message (no page call), which
        // is what survives a broken build. Nameless rows are dropped by the
        // server anyway.
        const name = readNotifyName(m);
        if (!name) continue;
        let authorPhone: string | null = null;
        if (author.endsWith("@c.us")) authorPhone = author.replace("@c.us", "").replace(/\D/g, "") || null;
        out.push({
          author: name,
          authorPhone,
          text,
          timestamp: new Date((t || Date.now() / 1000) * 1000).toISOString(),
        });
      } catch {
        /* skip this message; never abort the whole capture */
      }
    }
    console.log(
      `[bot-added] history fetched ${raw.length} msgs (mapped ${out.length} after filtering) for ${groupId}`,
    );
    return out;
  }

  driver.onGroupJoin(async (notification: GroupMembershipEvent) => {
    try {
      const groupId = notification.chatId;
      if (!groupId) return;
      const selfId = driver.selfId();

      // ── Self-add detection (self-setup) ────────────────────────
      // The bot itself was just ADDED to a group it isn't monitoring
      // → tell the server. The server is fully authoritative: the
      // ONBOARDING_AUTOSTART flag gate and the live-org short-circuit
      // both live there; the bot only posts the intro (and starts
      // monitoring + immediate flushing) when the server hands text
      // back. Identity matching, the snapshot and the history live in
      // bot-added.ts / group-snapshot.ts (2026-09-17), tested against
      // a client whose page calls throw like the live build's.
      const outcome = await handleGroupJoinForSelfAdd(
        {
          driver,
          isMonitoredGroup,
          addMonitoredGroup,
          addOnboardingGroup,
          resolveSelfIds: () => driver.selfIds(),
          readGroupSnapshot: (gid, selfIds) => driver.groupSnapshot(gid, selfIds),
          fetchHistory: collectHistoryForServer,
          postBotAdded,
        },
        notification,
      );
      if (outcome.kind !== "not-self-add") return;

      // ── Existing human-join path (byte-identical behaviour) ────
      if (!isMonitoredGroup(groupId)) return;
      const phones = extractPhones(
        Array.isArray(notification.recipientIds)
          ? (notification.recipientIds as unknown[]).map((r) =>
              typeof r === "string" ? r : ((r as { _serialized?: string })?._serialized ?? ""),
            )
          : undefined,
        selfId,
      );
      if (phones.length === 0) return;
      console.log(`group_join in ${groupId}: ${phones.join(", ")}`);
      await postGroupJoin({ groupId, phones });
    } catch (err) {
      console.error("Error forwarding group_join:", err);
    }
  });

  driver.onGroupLeave(async (notification: GroupMembershipEvent) => {
    try {
      const groupId = notification.chatId;
      if (!groupId || !isMonitoredGroup(groupId)) return;
      const selfId = driver.selfId();
      const phones = extractPhones(notification.recipientIds, selfId);
      if (phones.length === 0) return;
      console.log(`group_leave in ${groupId}: ${phones.join(", ")}`);
      await postGroupLeave({ groupId, phones });
    } catch (err) {
      console.error("Error forwarding group_leave:", err);
    }
  });

  driver.onClose((reason: string) => {
    console.log("Client disconnected:", reason);
    stopScheduler();
    stopBatchFlushTimer();
    stopOrgRefreshTimer();
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    stopScheduler();
    stopBatchFlushTimer();
    stopOrgRefreshTimer();
    await driver.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    stopScheduler();
    stopBatchFlushTimer();
    stopOrgRefreshTimer();
    await driver.close();
    process.exit(0);
  });

  await driver.start();
}

main().catch(console.error);
