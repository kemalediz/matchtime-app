export const metadata = { title: "Player guide" };

export default function PlayerGuidePage() {
  return (
    <>
      <h2 className="!mt-0">Player guide</h2>
      <p>
        You&apos;re in a WhatsApp group where MatchTime runs the admin.
        Everything you need to do, you do right in the chat. There&apos;s no
        app to install.
      </p>

      <h3>The one rule: tag it for anything but In or Out</h3>
      <p>
        MatchTime picks up <code>IN</code> and <code>OUT</code> on its own.
        For anything else (questions, teams, stats) tag it: type @ and pick
        Match Time from the list, so it shows as{" "}
        <strong>@Match Time</strong> in your message. Typing the name or
        replying to MatchTime is not enough: without the tag it stays quiet.
        Everything else in the group, like the
        jokes and the arguments about last week&apos;s penalty, it leaves
        alone. Tagged messages are answered straight away; plain In and Out
        messages are picked up within about 10 minutes (straight away in the
        last hour before kickoff).
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="signup">1. Saying you&apos;re in</h2>

      <p>Type it the way you normally would:</p>
      <ul>
        <li><code>IN</code></li>
        <li><code>I&apos;m in</code> or <code>count me in</code></li>
        <li><code>I&apos;ll play</code></li>
      </ul>

      <p>
        MatchTime reacts to your message with <strong>✅</strong> when
        you&apos;re in the squad. If the squad is already full you get{" "}
        <strong>🪑</strong>: you&apos;re on the bench (see below).
      </p>

      <h3>Maybe</h3>
      <p>
        Not sure yet? Say so (<code>maybe</code>,{" "}
        <code>in if my back holds up</code>). A maybe doesn&apos;t take a
        squad spot and gets no reaction. A day before kickoff MatchTime DMs
        you to ask whether you&apos;re in or out, unless you&apos;ve already
        decided. Just reply <code>IN</code> or <code>OUT</code>.
      </p>

      <h3>Saying in for someone in the group</h3>
      <ul>
        <li><code>me and Steve both in</code></li>
      </ul>
      <p>
        If Steve is already a player in your group, MatchTime reacts 👍 and
        posts the updated squad. Bringing someone new? See{" "}
        <a href="#friend">Bringing a friend</a>.
      </p>

      <h3>Adding names to the list</h3>
      <p>
        If your group likes copying the squad list and adding names at the
        bottom, that works too: forward MatchTime&apos;s latest list with the
        new names on the end and they&apos;re signed up.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="friend">2. Bringing a friend</h2>

      <p>
        Say it in the group the way you normally would, no need to tag
        MatchTime:
      </p>
      <ul>
        <li><code>my friend Ali is coming</code></li>
        <li><code>my brother can play</code></li>
        <li><code>+1</code></li>
      </ul>
      <p>
        MatchTime reacts <strong>✉️</strong> and DMs you a personal link for
        your friend. Forward it to them. Each friend needs their own link.
      </p>
      <p>
        Your friend opens the link, fills in their details and sends the
        WhatsApp code the page gives them. They are not in the game until
        they send that code. Once they do:
      </p>
      <ul>
        <li>They are booked into the match, or onto the bench if the squad is full.</li>
        <li>They join the MatchTime player pool, so they hear about other games near them.</li>
        <li>The group is told, for example <em>Ali Y. (Shane&apos;s friend) is in</em>.</li>
      </ul>
      <p>
        The link works until kick-off. If your friend can&apos;t make it after
        all, they can give their place back by replying to MatchTime on
        WhatsApp or with the button on their link&apos;s page.
      </p>
      <p>
        Your friend pays like any guest: if your club collects match fees,
        they get their own pay link after the game (in a club with a monthly
        squad, as a pay as you go player). When an organiser adds someone
        themselves, that person goes straight on the list, with no link.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="dropping-out">3. Dropping out</h2>

      <p>Just say so:</p>
      <ul>
        <li><code>OUT</code></li>
        <li><code>can&apos;t make it</code></li>
        <li><code>not playing tonight, work</code></li>
      </ul>
      <p>
        Reaction: <strong>👋</strong>. If there&apos;s a bench, the spot is
        offered to the bench straight away. If not, MatchTime asks the group for a
        replacement.
      </p>

      <h3>Replacements</h3>
      <p>
        Found someone in the group to take your place? Say it:{" "}
        <code>I&apos;m out, Sam is replacing me</code>, or for someone else,{" "}
        <code>Sam is replacing Joe</code>. The replacement takes the leaving
        player&apos;s place in the squad.
        If the teams are already out, they step into that player&apos;s team
        as well, so nobody has to redo the teams.
      </p>

      <h3>Dropping someone else</h3>
      <p>
        The organiser and admins can drop someone who&apos;s told them
        they&apos;re out (<code>Joe can&apos;t make it tonight</code>). Anyone
        else needs to tag it: <code>@Match Time Joe is out tonight</code>.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="bench">4. The bench</h2>

      <p>
        When the squad is full, late Ins go on the bench 🪑 in the order they
        came in. When a confirmed player drops, MatchTime posts in the group,
        tags everyone on the bench and DMs them too.{" "}
        <strong>The first to claim the spot plays.</strong> Reply{" "}
        <code>IN</code> in the group, or <code>YES</code> to the DM.
      </p>
      <p>
        If someone beat you to it, you stay on the bench and you&apos;re first
        in line for the next spot. Saying no, or not replying, never takes
        you off the bench.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="questions">5. Asking MatchTime questions</h2>

      <p>Tag it and ask. The answer is posted in the group:</p>
      <ul>
        <li><code>@Match Time how many are we?</code></li>
        <li><code>@Match Time who&apos;s playing?</code></li>
        <li><code>@Match Time what time is kickoff?</code></li>
        <li><code>@Match Time top 5 rated players this season</code></li>
        <li><code>@Match Time who&apos;s played the most?</code></li>
        <li><code>@Match Time most Man of the Match awards all time</code></li>
      </ul>
      <p>
        Stats questions work for &quot;this season&quot;, &quot;all
        time&quot; or a period like &quot;the last 3 months&quot;. Say{" "}
        <code>@Match Time my stats</code> and your own stats page link comes
        to you by DM.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="teams">6. Teams</h2>

      <p>Anyone can ask MatchTime to split the confirmed squad:</p>
      <ul>
        <li><code>@Match Time generate the teams</code></li>
      </ul>
      <p>
        It uses everyone&apos;s rating and preferred position to make two
        even sides, and posts both line-ups. You can also count someone in who
        already replied for this match:{" "}
        <code>@Match Time generate the teams including Dan</code>.
      </p>
      <p>
        Want a change? <code>@Match Time swap Dan with Leo</code> swaps two
        players, and <code>@Match Time swap the colours</code> swaps the
        bibs. The organiser can also edit the teams from the dashboard.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="match-day">7. Before the match</h2>
      <ul>
        <li>
          <strong>Daily update at 17:00.</strong> The squad so far, and a call
          for players if you&apos;re short.
        </li>
        <li>
          <strong>Extra calls if you&apos;re short</strong> on match morning
          and in the last few hours before kickoff. Once the squad is full
          they stop.
        </li>
        <li>
          <strong>About 2 hours before kickoff</strong>: a reminder
          to bring goalie gloves, a ball and spare bibs.
        </li>
      </ul>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="after-match">8. After the match</h2>

      <h3>Score</h3>
      <p>
        About an hour after the match ends, MatchTime asks for the score.
        Anyone who played can post it:
      </p>
      <ul>
        <li><code>7-3</code></li>
        <li><code>we won 5-4</code></li>
      </ul>

      <h3>Ratings and Man of the Match</h3>
      <p>
        From <strong>08:00 the next morning</strong>, everyone who played gets
        a personal link by DM. Tap it and you&apos;re signed in, no password.
        Rate the other players from 1 to 10 and pick your Man of the Match.
        It takes about a minute, and the link works for 5 days.
      </p>
      <p>
        If you haven&apos;t rated yet you get a friendly nudge at 18:00 each
        day, for up to 5 days. It stops the moment you submit.
      </p>
      <p>
        <strong>Man of the Match</strong> is announced in the group as soon
        as everyone has voted (between 09:00 and 21:00), or from day 5 at the
        latest.
      </p>

      <h3>Paying</h3>
      <p>
        If your organiser has switched on payments, you get a pay link by DM
        after the game. It shows the ways your club takes payment, which can
        be card, Apple Pay, Google Pay, pay by bank or paying the collector
        directly. If you haven&apos;t paid, you&apos;ll get a reminder.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="emoji-reference">9. Reactions quick reference</h2>

      <ul>
        <li><strong>✅</strong>: you&apos;re in the squad</li>
        <li><strong>🪑</strong>: you&apos;re on the bench (squad was full)</li>
        <li><strong>👋</strong>: you&apos;ve dropped out</li>
        <li><strong>👍</strong>: got it, for a message about someone else or a score</li>
        <li><strong>✉️</strong>: I&apos;ve DMed you a link for your friend</li>
        <li><strong>⚽</strong>: teams posted</li>
        <li>No reaction on a maybe: you&apos;ll get a DM before kickoff</li>
      </ul>

      <p>
        A plain In or Out can take up to about 10 minutes to get its reaction.
        Don&apos;t send it again: it&apos;s already queued.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="profile">10. Your stats page and profile</h2>

      <p>
        Every rating and result builds into your own stats page: your rating
        over time, Man of the Match awards, games played, wins, form, who you
        play best with, your rivalries, badges, the squad leaderboard and the
        Team of the Season. Open it from any link MatchTime sends you, or sign
        in at{" "}
        <a href="https://matchtime.ai" className="text-blue-600 underline">matchtime.ai</a>.
      </p>
      <p>On your profile you can also:</p>
      <ul>
        <li>Set your preferred positions</li>
        <li>Add your phone number (so you get rating links by DM)</li>
      </ul>

      <h3>Too many DMs?</h3>
      <p>
        DM MatchTime <code>stop</code> to turn off everything except payment
        messages, or <code>stop ratings</code> to turn off just the rating
        links and reminders. Send <code>start messages</code> or{" "}
        <code>start ratings</code> to turn them back on.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="tips">11. Tips</h2>

      <ul>
        <li>
          <strong>Say IN early.</strong> The squad fills in the order people
          commit, so first in means first on the pitch.
        </li>
        <li>
          <strong>One message is enough.</strong> No need to say &quot;count
          me in&quot; and then &quot;IN&quot;.
        </li>
        <li>
          <strong>Use real words.</strong> &quot;I&apos;ll play&quot; and
          &quot;can&apos;t make it&quot; both work.
        </li>
        <li>
          <strong>Nicknames are fine.</strong> MatchTime matches short names
          and nicknames to players it already knows.
        </li>
        <li>
          <strong>Rate when the link lands.</strong> It takes a minute and
          keeps next week&apos;s teams fair.
        </li>
      </ul>
    </>
  );
}
