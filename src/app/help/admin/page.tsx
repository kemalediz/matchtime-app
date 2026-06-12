export const metadata = { title: "Admin guide" };

export default function AdminGuidePage() {
  return (
    <>
      <h2 className="!mt-0">Admin guide</h2>
      <p>
        You&apos;re running a group. This walks through everything MatchTime
        does on your behalf and what you control from{" "}
        <code>/admin</code>.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="setup">1. Setting up your organisation</h2>

      <h3>Create the org</h3>
      <p>
        After signing in, hit <strong>Create organisation</strong>. Give it
        the same name as your WhatsApp group so it&apos;s obvious when the
        MatchTime posts there (e.g. &quot;Sutton FC&quot;).
      </p>

      <h3>Connect MatchTime to your group chat</h3>
      <p>
        MatchTime reads and posts in your group chat on your behalf — that&apos;s
        how attendance, reminders, scores and team line-ups all flow through
        the chat everyone already uses. Nothing else changes.
      </p>
      <ul>
        <li>Reads messages in your group (and nothing else)</li>
        <li>Posts reminders and DMs on a schedule you configure</li>
        <li>Reacts to attendance messages with slot-number emojis</li>
      </ul>
      <p>
        Setup is a one-time handshake with your group, done from{" "}
        <code>/admin/settings</code>. You can pause MatchTime any time —
        it keeps tracking your matches internally but stops posting to the
        group.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="activities">2. Activities (the sports you play)</h2>

      <p>
        An <strong>activity</strong> is one kind of match your group
        plays — e.g. &quot;Tuesday 7-a-side&quot;, &quot;Saturday 5-a-side&quot;,
        &quot;Sunday basketball 5v5&quot;. Each activity defines:
      </p>
      <ul>
        <li>The sport (football 7-a-side, 5-a-side, basketball 5v5, custom)</li>
        <li>Day of week, kickoff time, duration, venue</li>
        <li>Max players (2× players-per-team + bench)</li>
        <li>Attendance deadline (when the squad is locked)</li>
      </ul>

      <h3>Alternative formats</h3>
      <p>
        If you run 7-a-side on Tuesdays but occasionally switch to 5-a-side
        when numbers are short, set up <strong>both</strong> activities.
        MatchTime then automatically proposes the switch when confirmed players
        drop below the 7-a-side max and there&apos;s enough for a smaller
        game. You — the admin — do the actual rebooking (e.g. call Goals)
        and flip the match in the app.
      </p>

      <h3>Match generation</h3>
      <p>
        The system generates matches <strong>daily</strong> via a cron job.
        Every active activity has its next upcoming match visible on the
        dashboard. When one match completes, the next is scheduled
        automatically.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="players">3. Players</h2>

      <h3>Adding players</h3>
      <p>Three ways a player ends up in your roster:</p>
      <ol>
        <li>
          <strong>You add them manually</strong> via{" "}
          <code>/admin/players</code> — name, phone (optional), position,
          seed rating.
        </li>
        <li>
          <strong>They post in the group</strong> and MatchTime auto-creates
          them as a <em>provisional</em> member (see below).
        </li>
        <li>
          <strong>They&apos;re mentioned in a third-party sign-up</strong>{" "}
          like &quot;my dad Najib is also in&quot; — resolved to an existing
          player or auto-provisioned.
        </li>
      </ol>

      <h3>Provisional members</h3>
      <p>
        When an unknown WhatsApp name posts in your group, MatchTime creates
        a lightweight user + membership flagged as <strong>provisional</strong>.
        Their attendance lands immediately so the message isn&apos;t lost, and
        your dashboard shows:
      </p>
      <ul>
        <li>An amber banner at the top of <code>/admin/players</code></li>
        <li>A <strong>NEW</strong> badge next to their name</li>
        <li>Green <strong>✓ Confirm</strong> button once you&apos;ve reviewed</li>
        <li>Grey <strong>✕ Remove</strong> button if they shouldn&apos;t be in the roster</li>
      </ul>
      <p>
        You&apos;ll also receive a <strong>WhatsApp DM</strong> (once a day,
        deduped) listing the pending ones, with a magic-link that signs you
        in and jumps straight to the review screen.
      </p>

      <h3>Seed ratings</h3>
      <p>
        A 1–10 starting skill score. Used by the team-balancer until the
        player has accumulated enough peer ratings. Rule of thumb:
      </p>
      <ul>
        <li><strong>9</strong> — elite, carries a team</li>
        <li><strong>7–8</strong> — strong regular</li>
        <li><strong>5–6</strong> — steady contributor (neutral default)</li>
        <li><strong>3–4</strong> — still learning</li>
      </ul>
      <p>
        Once real ratings pile up, the system smoothly shifts from seed
        to earned ratings — no manual crossover.
      </p>

      <h3>Positions</h3>
      <p>
        Per sport, not per player globally. A player&apos;s &quot;I play
        goalkeeper in football&quot; applies to every football activity in
        the org (7-a-side and 5-a-side share it). Basketball positions
        are separate.
      </p>

      <h3>Phones</h3>
      <p>
        Optional but recommended — MatchTime uses phone numbers to send
        personal DMs (rating links, reminders, admin nudges). Without a
        phone, a player can still sign up via the group but won&apos;t
        receive DMs.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="match-lifecycle">4. Match lifecycle</h2>

      <p>Walkthrough of one week for a typical 7-a-side Tuesday 21:30:</p>

      <h3>Wednesday–Sunday: attendance opens</h3>
      <p>
        The next match is visible. Players start saying <code>IN</code> or{" "}
        <code>OUT</code>. Bot reacts with slot emojis (1️⃣, 2️⃣, …). A daily
        17:00 roll-call chase goes out if the squad is short.
      </p>

      <h3>Monday: chase day</h3>
      <p>
        Morning chase if still short. Afternoon chase if very short. Bot
        names who can&apos;t make it (from explicit drop messages) and asks
        for covers.
      </p>

      <h3>Monday night &amp; Tuesday: admin nudges</h3>
      <ul>
        <li>
          <strong>10:00 Monday</strong> — if short, you get a DM proposing
          a format switch (7-a-side → 5-a-side).
        </li>
        <li>
          <strong>18:00 Monday</strong> — if below the minimum to play at
          all, you get a DM to cancel.
        </li>
      </ul>

      <h3>Tuesday morning: roll-call + teams</h3>
      <p>
        Morning check-in. When someone types{" "}
        <code>@MatchTime generate teams</code> (or similar), MatchTime
        balances and posts the two team lineups with positions.
      </p>

      <h3>Tuesday ~19:00: gear reminder</h3>
      <p>
        MatchTime posts a short reminder with kickoff time + venue, asks people
        to bring goalie gloves, a ball, and spare bibs.
      </p>

      <h3>21:30–22:30: match plays</h3>
      <p>
        Nothing happens in the app during the match.
      </p>

      <h3>Just after kickoff ends</h3>
      <ul>
        <li>
          <strong>Payment poll</strong> fires as soon as the match
          time-window ends (not at midnight) — collect pitch fees.
        </li>
        <li>
          <strong>Score ask</strong> posted to the group —
          <em>&quot;🏁 hope it was a good one. What was the final score?&quot;</em>
          Any player posting <code>7-3</code> or <code>we won 5-4</code>{" "}
          records it.
        </li>
      </ul>

      <h3>Wednesday morning: ratings</h3>
      <ul>
        <li>
          <strong>08:00</strong> — every confirmed player with a phone
          gets a personal rating DM (magic link, no login friction).
        </li>
        <li>
          <strong>08:05</strong> — group post: &quot;Morning all — DM&apos;d
          everyone a rating link&quot;.
        </li>
      </ul>

      <h3>Wed–Sun: daily reminder at 18:00</h3>
      <p>
        Non-voters get a personal DM each day (day 1 warm, day 5 last
        call). Stops the moment they rate.
      </p>

      <h3>Sunday 15:00: Man of the Match announcement</h3>
      <p>
        MatchTime announces the winner(s) based on peer votes + a short
        well-done post.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="team-balancing">5. Team balancing</h2>

      <p>
        Default strategy is <strong>position-aware</strong>: snake-draft
        by rating, then 1000 hill-climb iterations to minimise the
        per-position rating gap between teams. Alternative:{" "}
        <strong>rating-only</strong> if you prefer simplicity.
      </p>
      <p>
        You or any player can trigger balancing from the group chat with{" "}
        <code>@MatchTime generate teams</code>. You can also force-include
        missing confirmations in the same message:{" "}
        <em>&quot;generate teams and count Ibrahim and Ehtisham as IN&quot;</em>.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="scores-ratings">6. Scores &amp; ratings</h2>

      <h3>Recording the score</h3>
      <p>
        Any player can post the score in the group and MatchTime records
        it automatically. If MatchTime can&apos;t resolve the sender to a
        real user (rare — WhatsApp hides some phones), it still writes
        the score. You can correct it in{" "}
        <code>/admin/matches/[id]</code> if needed.
      </p>

      <h3>How ratings are computed</h3>
      <ul>
        <li>
          Each player rates each teammate 1–10 after the match.
        </li>
        <li>
          <strong>Elo-style</strong> updates with margin-of-victory:
          a 7–3 shifts ratings more than a 5–4.
        </li>
        <li>
          Your match rating converges toward your true skill over time;
          seed ratings fade in influence.
        </li>
      </ul>

      <h3>MoM voting</h3>
      <p>
        Everyone picks one teammate (or multi-pick depending on activity
        config). Most votes wins. Announced 5 days after the match at
        15:00 London.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="admin-dms">7. Admin DMs you&apos;ll receive</h2>

      <p>Automated messages that go only to org admins with a phone number:</p>
      <ul>
        <li>
          <strong>Provisional-review</strong> — once per day while there
          are unreviewed auto-provisioned players.
        </li>
        <li>
          <strong>Format switch</strong> — Monday 10:00 when the squad is
          short and a smaller format is configured.
        </li>
        <li>
          <strong>Cancel</strong> — Monday 18:00 when even the smallest
          format can&apos;t fill.
        </li>
      </ul>
      <p>
        Every DM includes a <strong>magic link</strong> that signs you in
        and lands you on the right admin screen. Valid for 1 hour, single
        use.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="corrections">8. Common corrections</h2>

      <h3>Add a missed player</h3>
      <p>
        Go to <code>/admin/players</code> → Add player. Or: ask someone
        to say &quot;[Name] is IN&quot; in the group — MatchTime resolves or
        auto-provisions them.
      </p>

      <h3>Fix attendance</h3>
      <p>
        Open the match in <code>/admin/matches/[id]</code>. Each player
        row has status controls.
      </p>

      <h3>Correct a wrong score</h3>
      <p>
        Match detail page → edit score. Elo deltas recalculate
        automatically and all affected player ratings are updated.
      </p>

      <h3>Switch format</h3>
      <p>
        Match detail → <strong>Switch format</strong>. Pick the smaller
        activity, confirm who goes to the bench. MatchTime announces the
        switch to the group.
      </p>

      <h3>Cancel a match</h3>
      <p>
        Match detail → <strong>Cancel</strong>. MatchTime posts the cancellation
        and any pending rating/MoM flows are skipped.
      </p>

      <h3>Remove a player from the roster</h3>
      <p>
        Set <code>leftAt</code> on their membership — preserves all
        historical attendance and ratings, just excludes them from future
        matches and rosters. Done via the <strong>Remove</strong> button
        on <code>/admin/players</code>.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="historical">9. Historical data</h2>
      <p>
        If you imported chat history from before MatchTime existed, the
        system can create <strong>synthetic</strong> matches to anchor
        old MoMs and leaderboard data. These are flagged{" "}
        <code>isHistorical=true</code> and excluded from current stats
        (Completed tile, Recent results, past matches list) so they
        don&apos;t pollute &quot;what happened recently&quot;.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="faq">10. FAQ</h2>

      <h3>Someone&apos;s name didn&apos;t resolve — why?</h3>
      <p>
        MatchTime tries phone match first, then exact name match, then a
        fuzzy first-name match (which handles nicknames and short display
        names — &quot;Kara&quot; will resolve to &quot;Karahan&quot; for
        example). If none of those match, it creates a provisional entry
        for you to review.
      </p>

      <h3>Duplicate player?</h3>
      <p>
        If a player got auto-provisioned as a new user when they already
        existed under a different name, you&apos;ll see two rows on{" "}
        <code>/admin/players</code>. Remove the provisional one (✕). The
        next time the real player posts, fuzzy matching will route to
        the correct user.
      </p>

      <h3>Why 18:00 for rating reminders?</h3>
      <p>
        Empirically, end-of-workday beats morning or evening — people tap
        the link while wrapping up. Adjustable per-org in the future.
      </p>

      <h3>Can I pause MatchTime for a week?</h3>
      <p>
        Yes — pause it in <code>/admin/settings</code>. Existing matches
        stay put; scheduled posts don&apos;t go out while paused.
      </p>
    </>
  );
}
