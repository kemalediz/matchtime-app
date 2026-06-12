export const metadata = { title: "Player guide" };

export default function PlayerGuidePage() {
  return (
    <>
      <h2 className="!mt-0">Player guide</h2>
      <p>
        You&apos;re in a WhatsApp group where MatchTime runs the admin.
        Everything you need to do, you can do right from the chat — no
        app required (though there&apos;s one if you want it).
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="signup">1. Signing up for a match</h2>

      <p>Any of these work — type naturally:</p>
      <ul>
        <li><code>IN</code></li>
        <li><code>I&apos;m in</code> / <code>count me in</code></li>
        <li><code>I&apos;ll play</code></li>
        <li><code>yes playing</code></li>
      </ul>

      <p>
        MatchTime reacts to your message with your squad number: <strong>1️⃣</strong>{" "}
        if you&apos;re the first in, <strong>2️⃣</strong> second, and so on.
        If the squad is already full you get <strong>🪑</strong> (bench).
      </p>

      <h3>Tentative</h3>
      <p>
        If you&apos;re not 100%, say so — MatchTime keeps you off the
        confirmed list but tracks you as a backstop:
      </p>
      <ul>
        <li><code>probably, will confirm later</code></li>
        <li><code>in if my back holds up</code></li>
        <li><code>maybe</code></li>
      </ul>
      <p>Reaction: <strong>🤔</strong>.</p>

      <h3>Signing up someone else</h3>
      <p>
        Useful when a mate can&apos;t message right now:
      </p>
      <ul>
        <li><code>my dad Najib is also in, he&apos;s busy</code></li>
        <li><code>bringing Ahmet with me</code></li>
        <li><code>me and Steve both in</code></li>
      </ul>
      <p>
        If the named person is already in the group, their squad spot is
        taken. If they aren&apos;t yet, MatchTime provisionally adds them
        and the admin reviews later.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="dropping-out">2. Dropping out</h2>

      <p>Just say so:</p>
      <ul>
        <li><code>OUT</code></li>
        <li><code>can&apos;t make it</code></li>
        <li><code>not playing tonight, work</code></li>
      </ul>
      <p>Reaction: <strong>👋</strong>.</p>

      <h3>Asking for a replacement</h3>
      <p>
        When you drop with a reason, MatchTime names you in the chase
        post so others know who&apos;s looking for cover:
      </p>
      <ul>
        <li><code>I&apos;m out, ankle sore, can anyone step in?</code></li>
        <li><code>sorry guys, work ran late — anyone free?</code></li>
      </ul>

      <h3>Tentative drop</h3>
      <p>
        If you&apos;ll play only if nobody else steps in, say it:
      </p>
      <ul>
        <li><code>feeling rough, will play if no one replaces me</code></li>
        <li><code>anyone else who can replace me too? If not I&apos;ll still join</code></li>
      </ul>
      <p>
        MatchTime keeps you on the roster as a <strong>Tentative</strong>{" "}
        under the numbered list. Reaction: <strong>🤔</strong>.
      </p>

      <h3>Dropping someone else</h3>
      <ul>
        <li><code>Ibrahim can&apos;t make it tonight</code></li>
        <li><code>Karahan just told me he&apos;s out</code></li>
      </ul>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="questions">3. Asking MatchTime questions</h2>

      <p>MatchTime answers short questions about the next match:</p>
      <ul>
        <li><code>how many are we?</code></li>
        <li><code>who&apos;s playing?</code></li>
        <li><code>where tonight?</code></li>
        <li><code>what time is kickoff?</code></li>
      </ul>
      <p>
        It replies with a numbered roster showing exactly who&apos;s
        confirmed and how many spots are open (shown as 🥁). If someone
        is tentative, they&apos;re listed separately below the roster.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="format-switch">4. Format switch (7-a-side ↔ 5-a-side)</h2>

      <p>
        If numbers are short and an alternative format exists for your
        group, MatchTime proactively proposes it — for example:
      </p>
      <blockquote>
        <p>
          If we don&apos;t find 2 more, we could switch to 5-a-side (10
          players) — Mauricio + Ersin go on the bench. Admins can rebook
          and flip it in the portal.
        </p>
      </blockquote>
      <p>
        You can also ask directly: <code>@MatchTime 5-a-side?</code>.
      </p>
      <p>
        The <strong>admin</strong> makes the actual call (rebooking the
        venue) — MatchTime only recommends and displays.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="teams">5. Team generation</h2>

      <p>Ask MatchTime to split the confirmed squad:</p>
      <ul>
        <li><code>@MatchTime generate teams</code></li>
        <li><code>teams please</code></li>
        <li><code>balance the teams</code></li>
      </ul>
      <p>
        MatchTime considers everyone&apos;s rating + preferred position,
        runs a balancing algorithm, and posts the two team lineups.
      </p>
      <p>
        You can also include people who haven&apos;t confirmed yet:
      </p>
      <ul>
        <li><code>@MatchTime generate teams and count Ibrahim and Ehtisham as IN</code></li>
        <li><code>teams please, count Baki in</code></li>
      </ul>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="match-day">6. Match day</h2>
      <p>MatchTime posts:</p>
      <ul>
        <li>
          <strong>Morning check-in</strong> — if the squad is short, asks
          who can step in.
        </li>
        <li>
          <strong>~2h before kickoff</strong> — gear reminder with kickoff
          time and venue. &quot;⚽ 21:30 at [Venue] — see you there!
          Bring goalie gloves, a ball, and spare bibs if you&apos;ve got
          them.&quot;
        </li>
      </ul>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="after-match">7. After the match</h2>

      <h3>Score</h3>
      <p>
        As soon as the match time-window ends, MatchTime asks for the
        score. Any confirmed player can type:
      </p>
      <ul>
        <li><code>7-3</code></li>
        <li><code>we won 5-4</code></li>
        <li><code>Final 2:1</code></li>
      </ul>
      <p>
        MatchTime records it, updates everyone&apos;s rating (Elo with
        margin-of-victory — 7-3 shifts more than 5-4), and thanks the
        group.
      </p>

      <h3>Payment poll</h3>
      <p>
        Right after the match ends (not at midnight), MatchTime posts a
        payment poll so people can pay pitch fees while it&apos;s fresh.
      </p>

      <h3>Rating DM — the morning after</h3>
      <p>
        At <strong>08:00 the next day</strong>, every confirmed player
        with a phone gets a personal DM with a magic link:
      </p>
      <blockquote>
        <p>
          🏆 Tuesday 7-a-side — Mon 21 Apr.<br />
          Rate your teammates and pick Man of the Match. Takes ~1 minute.<br />
          Your personal link: https://matchtime.ai/r/…<br />
          Link expires in 5 days.
        </p>
      </blockquote>
      <p>Tap the link — you&apos;re signed in, no password.</p>

      <h3>Daily reminder at 18:00</h3>
      <p>
        If you haven&apos;t rated yet, you&apos;ll get a friendly nudge
        at 18:00 each day for up to 5 days. Tone varies — day 1 warm,
        day 5 last call. Stops the moment you submit.
      </p>

      <h3>Man of the Match</h3>
      <p>
        Announced <strong>5 days after the match at 15:00 London</strong>.
        Most votes wins; ties are ties.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="emoji-reference">8. Bot reactions quick reference</h2>

      <ul>
        <li><strong>1️⃣ – 🔟</strong> — you&apos;re confirmed at that slot</li>
        <li><strong>✅</strong> — confirmed, past slot 10 (Unicode keycaps stop at 🔟)</li>
        <li><strong>🪑</strong> — bench (squad was full)</li>
        <li><strong>👋</strong> — you dropped out</li>
        <li><strong>🤔</strong> — tentative, MatchTime is keeping an eye on you</li>
        <li><strong>⚽</strong> on a &quot;generate teams&quot; message — balancer is running</li>
        <li><strong>👍</strong> — acknowledged (often replaced by the actual slot a few seconds later once the batch runs)</li>
      </ul>

      <p>
        Reactions can lag by up to ~10 minutes because MatchTime batches
        messages to save cost. Don&apos;t re-send — your message is
        already queued.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="profile">9. Your profile</h2>

      <p>
        Sign in on <a href="https://matchtime.ai" className="text-blue-600 underline">matchtime.ai</a>{" "}
        to:
      </p>
      <ul>
        <li>Set your preferred positions per sport</li>
        <li>Add your phone number (so you get rating DMs)</li>
        <li>See your ratings history and leaderboard standing</li>
      </ul>
      <p>You can sign in with Google, or any magic link we send you.</p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="tips">10. Tips</h2>

      <ul>
        <li>
          <strong>Say IN early</strong> — the squad fills in the order
          people commit, so first in = first on the pitch if numbers are
          tight.
        </li>
        <li>
          <strong>One message is enough</strong> — don&apos;t repeat
          &quot;count me in&quot; then &quot;IN&quot;. MatchTime will pick
          it up on the next batch.
        </li>
        <li>
          <strong>Use real words, not codes</strong> — &quot;I&apos;ll
          play&quot;, &quot;can&apos;t make it&quot;, &quot;who&apos;s in
          tonight?&quot; all work. MatchTime understands natural
          language.
        </li>
        <li>
          <strong>Nicknames are fine</strong> — MatchTime fuzzy-matches
          first names, so &quot;Kara&quot; resolves to &quot;Karahan&quot;
          if they&apos;re already in the roster.
        </li>
        <li>
          <strong>Rate when the DM lands</strong> — 60 seconds, keeps
          teams balanced for next week. Low turnout = noisier ratings.
        </li>
      </ul>
    </>
  );
}
