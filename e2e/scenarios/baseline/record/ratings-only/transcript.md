# Ratings only type: no attendance (featureAttendance off), Man of the Match and ratings only (record)

**LIVE MODE**: Real model calls were made with the developer key. Routes and facts are the model's own.

## Summary

### What MatchTime posted, per group

- Thursday Fives Sandbox (players): 5 messages, 0 graphics, 1 reactions

### Direct messages from MatchTime

- Lee Carter: 3
- Nick Burns: 3
- Owen Platt: 3
- Paul Dunn: 3
- Quinn Hart: 3
- Sean Tully: 3
- Tony Wade: 3
- Vic Moss: 3
- Mark Evans: 1
- Ross Kemp: 1

### Errors

- none

## Everything, in time order


### Monday: a club that uses MatchTime for Man of the Match and ratings only (no IN list), game Thursday 19:00 (2026-11-09 08:00)

- 2026-11-09 08:00 [System] **rehearsal**: STAND-IN (club already live): "Thursday Fives Sandbox" has been live 90 days. Written to the database directly.
- 2026-11-09 08:00 [System] **rehearsal**: STAND-IN (settings page): Lee Carter saves:
    featureAttendance = false
    featureBench = false
    featureTeamBalancing = false
    featureReminders = false
    featureMomVoting = true
    featurePlayerRating = true
    featureSquadFromList = true
    featureBadgeAnnouncements = true
    paymentTrackingEnabled = false
    paymentCollectionEnabled = false
    quietHoursEnabled = false
    listAnnouncer = "matchtime"
    Lee Carter is an owner
- 2026-11-09 08:00 [Thursday Fives Sandbox] **rehearsal**: The Pi reads the players' group members: {"ok":true,"org":"Thursday Fives Sandbox","added":0,"alreadyKnown":11,"skippedNoPhone":0,"restoredMembership":0,"linkedPlaceholders":0,"total":11}
- 2026-11-09 08:00 database: club: approval: (new) approved
    club: members: (new) 11
    club: muted: (new) no
    club: stage: (new) live, bot on
    member Lee Carter: (new) OWNER
    member Mark Evans: (new) PLAYER
    member Nick Burns: (new) PLAYER
    member Owen Platt: (new) PLAYER
    member Paul Dunn: (new) PLAYER
    member Quinn Hart: (new) PLAYER
    member Ross Kemp: (new) PLAYER
    member Sean Tully: (new) PLAYER
    member Tony Wade: (new) PLAYER
    member Vic Moss: (new) PLAYER
    member Will Rowe: (new) PLAYER
    sent-notification org-<club>:bot-intro: (new) bot-intro
    user @lee: (new) name "Lee Carter"
    user @mark: (new) name "Mark Evans"
    user @nick: (new) name "Nick Burns"
    user @owen: (new) name "Owen Platt"
    user @paul: (new) name "Paul Dunn"
    user @quinn: (new) name "Quinn Hart"
    user @ross: (new) name "Ross Kemp"
    user @sean: (new) name "Sean Tully"
    user @tony: (new) name "Tony Wade"
    user @vic: (new) name "Vic Moss"
    user @will: (new) name "Will Rowe"
- 2026-11-09 08:02 database: <match 2026-11-12 19:00>: places: (new) 10
    match 2026-11-12 19:00: status: (new) UPCOMING
- 2026-11-09 10:00 [DM Lee Carter] **MatchTime**: 📍 Confirm *Thursday Fives Sandbox*'s venue so nearby clubs can find you: MatchTime has no venue for your club yet. Pick your pitch from the list here: <app>/r/<tok>
    MatchTime reminds you once a week until a venue is set.
- 2026-11-09 10:00 database: botjob dm → @lee: 📍 Confirm *Thursday Fives Sandbox*'s venue so nearby clubs can find you: MatchTime has no: (new) sent
- 2026-11-09 12:00 [System] **rehearsal**: cron /api/cron/generate-teams: {"completed":0}
- 2026-11-10 12:00 [System] **rehearsal**: cron /api/cron/generate-teams: {"completed":0}
- 2026-11-10 12:00 [Thursday Fives Sandbox] **Mark Evans**: in for thursday _(ignored / noise)_
- 2026-11-10 12:05 [Thursday Fives Sandbox] **Nick Burns**: @Match Time how many are playing thursday? _(fast-path / not_understood)_
- 2026-11-10 12:10 [Thursday Fives Sandbox] **rehearsal**: The Pi sent 2 message(s) to analyze in one batch; 2 model call(s) under the stubs.
- 2026-11-10 12:10 [Thursday Fives Sandbox] **MatchTime**: I didn't catch what you'd like me to do. Type *@Match Time help* to see what I can do.
- 2026-11-10 12:10 database: sent-notification greply:<club>:wa-ratingsonly-3: (new) group-reply
- 2026-11-11 12:00 [System] **rehearsal**: cron /api/cron/generate-teams: {"completed":0}
- 2026-11-12 00:00 database: <match 2026-11-19 19:00>: places: (new) 10
    match 2026-11-19 19:00: status: (new) UPCOMING
- 2026-11-12 12:00 [System] **rehearsal**: cron /api/cron/generate-teams: {"completed":0}
- 2026-11-12 17:00 [Thursday Fives Sandbox] **Lee Carter**: Thursday 5s tonight
    
    1. Lee
    2. Mark
    3. Nick
    4. Owen
    5. Paul
    6. Quinn
    7. Ross
    8. Sean
    9. Tony
    10. Vic _(fast-path / pasted_roster)_
- 2026-11-12 17:10 [Thursday Fives Sandbox] **rehearsal**: The Pi sent 1 message(s) to analyze in one batch; 3 model call(s) under the stubs.
- 2026-11-12 18:00 database: <match 2026-11-12 19:00>: attendance @lee: (new) CONFIRMED #1
    <match 2026-11-12 19:00>: attendance @mark: (new) CONFIRMED #2
    <match 2026-11-12 19:00>: attendance @nick: (new) CONFIRMED #3
    <match 2026-11-12 19:00>: attendance @owen: (new) CONFIRMED #4
    <match 2026-11-12 19:00>: attendance @paul: (new) CONFIRMED #5
    <match 2026-11-12 19:00>: attendance @quinn: (new) CONFIRMED #6
    <match 2026-11-12 19:00>: attendance @ross: (new) CONFIRMED #7
    <match 2026-11-12 19:00>: attendance @sean: (new) CONFIRMED #8
    <match 2026-11-12 19:00>: attendance @tony: (new) CONFIRMED #9
    <match 2026-11-12 19:00>: attendance @vic: (new) CONFIRMED #10
    alias "lee": (new) @lee (auto-detect)
    match 2026-11-12 19:00: Lee Carter: (new) CONFIRMED
    match 2026-11-12 19:00: Mark Evans: (new) CONFIRMED
    match 2026-11-12 19:00: Nick Burns: (new) CONFIRMED
    match 2026-11-12 19:00: Owen Platt: (new) CONFIRMED
    match 2026-11-12 19:00: Paul Dunn: (new) CONFIRMED
    match 2026-11-12 19:00: Quinn Hart: (new) CONFIRMED
    match 2026-11-12 19:00: Ross Kemp: (new) CONFIRMED
    match 2026-11-12 19:00: Sean Tully: (new) CONFIRMED
    match 2026-11-12 19:00: Tony Wade: (new) CONFIRMED
    match 2026-11-12 19:00: Vic Moss: (new) CONFIRMED
- 2026-11-12 20:00 database: match 2026-11-12 19:00: status: UPCOMING → COMPLETED
- 2026-11-12 20:30 [Thursday Fives Sandbox] **Lee Carter**: Reds 7 Blues 5 tonight _(llm / score)_
- 2026-11-12 20:40 [Thursday Fives Sandbox] **rehearsal**: The Pi sent 1 message(s) to analyze in one batch; 3 model call(s) under the stubs.
- 2026-11-12 20:40 [Thursday Fives Sandbox] MatchTime reacted 👍
- 2026-11-12 20:40 [Thursday Fives Sandbox] **MatchTime**: Got it 👍 *Reds* won 7 - 5 against Blues. Recorded.
- 2026-11-12 20:40 database: match 2026-11-12 19:00: score: (new) 7-5
    sent-notification greply:<club>:wa-ratingsonly-6: (new) group-reply
- 2026-11-13 08:00 [DM Lee Carter] **MatchTime**: 🏆 *Thursday Fives Sandbox*, Thu 12 Nov
    
    Rate your teammates and pick Man of the Match. Takes ~1 minute.
    
    Your personal link:
    <app>/r/<tok>
    
    Link expires in 5 days.
    
    📊 Your season stats (ratings, MoM, badges, share card), any time:
    <app>/r/<tok>
- 2026-11-13 08:00 [DM Mark Evans] **MatchTime**: 🏆 *Thursday Fives Sandbox*, Thu 12 Nov
    
    Rate your teammates and pick Man of the Match. Takes ~1 minute.
    
    Your personal link:
    <app>/r/<tok>
    
    Link expires in 5 days.
    
    📊 Your season stats (ratings, MoM, badges, share card), any time:
    <app>/r/<tok>
- 2026-11-13 08:00 [DM Nick Burns] **MatchTime**: 🏆 *Thursday Fives Sandbox*, Thu 12 Nov
    
    Rate your teammates and pick Man of the Match. Takes ~1 minute.
    
    Your personal link:
    <app>/r/<tok>
    
    Link expires in 5 days.
    
    📊 Your season stats (ratings, MoM, badges, share card), any time:
    <app>/r/<tok>
- 2026-11-13 08:00 [DM Owen Platt] **MatchTime**: 🏆 *Thursday Fives Sandbox*, Thu 12 Nov
    
    Rate your teammates and pick Man of the Match. Takes ~1 minute.
    
    Your personal link:
    <app>/r/<tok>
    
    Link expires in 5 days.
    
    📊 Your season stats (ratings, MoM, badges, share card), any time:
    <app>/r/<tok>
- 2026-11-13 08:00 [DM Paul Dunn] **MatchTime**: 🏆 *Thursday Fives Sandbox*, Thu 12 Nov
    
    Rate your teammates and pick Man of the Match. Takes ~1 minute.
    
    Your personal link:
    <app>/r/<tok>
    
    Link expires in 5 days.
    
    📊 Your season stats (ratings, MoM, badges, share card), any time:
    <app>/r/<tok>
- 2026-11-13 08:00 [DM Quinn Hart] **MatchTime**: 🏆 *Thursday Fives Sandbox*, Thu 12 Nov
    
    Rate your teammates and pick Man of the Match. Takes ~1 minute.
    
    Your personal link:
    <app>/r/<tok>
    
    Link expires in 5 days.
    
    📊 Your season stats (ratings, MoM, badges, share card), any time:
    <app>/r/<tok>
- 2026-11-13 08:00 [DM Ross Kemp] **MatchTime**: 🏆 *Thursday Fives Sandbox*, Thu 12 Nov
    
    Rate your teammates and pick Man of the Match. Takes ~1 minute.
    
    Your personal link:
    <app>/r/<tok>
    
    Link expires in 5 days.
    
    📊 Your season stats (ratings, MoM, badges, share card), any time:
    <app>/r/<tok>
- 2026-11-13 08:00 [DM Sean Tully] **MatchTime**: 🏆 *Thursday Fives Sandbox*, Thu 12 Nov
    
    Rate your teammates and pick Man of the Match. Takes ~1 minute.
    
    Your personal link:
    <app>/r/<tok>
    
    Link expires in 5 days.
    
    📊 Your season stats (ratings, MoM, badges, share card), any time:
    <app>/r/<tok>
- 2026-11-13 08:00 [DM Tony Wade] **MatchTime**: 🏆 *Thursday Fives Sandbox*, Thu 12 Nov
    
    Rate your teammates and pick Man of the Match. Takes ~1 minute.
    
    Your personal link:
    <app>/r/<tok>
    
    Link expires in 5 days.
    
    📊 Your season stats (ratings, MoM, badges, share card), any time:
    <app>/r/<tok>
- 2026-11-13 08:00 [DM Vic Moss] **MatchTime**: 🏆 *Thursday Fives Sandbox*, Thu 12 Nov
    
    Rate your teammates and pick Man of the Match. Takes ~1 minute.
    
    Your personal link:
    <app>/r/<tok>
    
    Link expires in 5 days.
    
    📊 Your season stats (ratings, MoM, badges, share card), any time:
    <app>/r/<tok>
- 2026-11-13 08:00 database: sent-notification <match 2026-11-12 19:00>:rate-dm:@lee: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-dm:@mark: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-dm:@nick: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-dm:@owen: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-dm:@paul: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-dm:@quinn: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-dm:@ross: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-dm:@sean: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-dm:@tony: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-dm:@vic: (new) dm
- 2026-11-13 09:00 [DM Mark Evans] **Mark Evans**: (opens the rating link and submits, Man of the Match: /Nick/) _(rating page: submitted (default scores; Man of the Match: N Nick Burns))_
- 2026-11-13 09:00 database: <match 2026-11-12 19:00>: MoM votes for @nick: (new) 1
    match 2026-11-12 19:00: MoM votes: (new) 1
    match 2026-11-12 19:00: ratings: (new) 9
- 2026-11-13 09:00 [Thursday Fives Sandbox] **MatchTime**: 🎯 Just DM'd every player from the *Thursday Fives Sandbox* on Thu 12 Nov a personal rating link. The more ratings we get, the better-balanced the teams get next week. Check your DMs from me 👇
- 2026-11-13 09:00 database: sent-notification <match 2026-11-12 19:00>:rate-promo: (new) group-message
    sent-notification txtlog:<club>:<text c9e1cc38>:<match 2026-11-12 19:00>:rate-promo: (new) outbound-text-log
- 2026-11-13 09:10 [DM Ross Kemp] **Ross Kemp**: (opens the rating link and submits, Man of the Match: /Nick/) _(rating page: submitted (default scores; Man of the Match: N Nick Burns))_
- 2026-11-13 09:10 database: <match 2026-11-12 19:00>: MoM votes for @nick: 1 → 2
    match 2026-11-12 19:00: MoM votes: 1 → 2
    match 2026-11-12 19:00: ratings: 9 → 18
- 2026-11-13 12:00 [System] **rehearsal**: cron /api/cron/generate-teams: {"completed":0}
- 2026-11-14 12:00 [System] **rehearsal**: cron /api/cron/generate-teams: {"completed":0}
- 2026-11-14 12:00 [DM Lee Carter] **Lee Carter**: (opens the rating link and submits, Man of the Match: /Owen/) _(rating page: submitted (default scores; Man of the Match: O Owen Platt))_
- 2026-11-14 12:00 database: <match 2026-11-12 19:00>: MoM votes for @owen: (new) 1
    match 2026-11-12 19:00: MoM votes: 2 → 3
    match 2026-11-12 19:00: ratings: 18 → 27
- 2026-11-14 18:00 [DM Nick Burns] **MatchTime**: Hey Nick 👋 Friendly nudge, you haven't rated *Thursday Fives Sandbox* yet.
    
    It takes 30 seconds to rate your teammates and pick Man of the Match, and it helps balance next week's teams 🙌
    <app>/r/<tok>
- 2026-11-14 18:00 [DM Owen Platt] **MatchTime**: Hey Owen 👋 Friendly nudge, you haven't rated *Thursday Fives Sandbox* yet.
    
    It takes 30 seconds to rate your teammates and pick Man of the Match, and it helps balance next week's teams 🙌
    <app>/r/<tok>
- 2026-11-14 18:00 [DM Paul Dunn] **MatchTime**: Hey Paul 👋 Friendly nudge, you haven't rated *Thursday Fives Sandbox* yet.
    
    It takes 30 seconds to rate your teammates and pick Man of the Match, and it helps balance next week's teams 🙌
    <app>/r/<tok>
- 2026-11-14 18:00 [DM Quinn Hart] **MatchTime**: Hey Quinn 👋 Friendly nudge, you haven't rated *Thursday Fives Sandbox* yet.
    
    It takes 30 seconds to rate your teammates and pick Man of the Match, and it helps balance next week's teams 🙌
    <app>/r/<tok>
- 2026-11-14 18:00 [DM Sean Tully] **MatchTime**: Hey Sean 👋 Friendly nudge, you haven't rated *Thursday Fives Sandbox* yet.
    
    It takes 30 seconds to rate your teammates and pick Man of the Match, and it helps balance next week's teams 🙌
    <app>/r/<tok>
- 2026-11-14 18:00 [DM Tony Wade] **MatchTime**: Hey Tony 👋 Friendly nudge, you haven't rated *Thursday Fives Sandbox* yet.
    
    It takes 30 seconds to rate your teammates and pick Man of the Match, and it helps balance next week's teams 🙌
    <app>/r/<tok>
- 2026-11-14 18:00 [DM Vic Moss] **MatchTime**: Hey Vic 👋 Friendly nudge, you haven't rated *Thursday Fives Sandbox* yet.
    
    It takes 30 seconds to rate your teammates and pick Man of the Match, and it helps balance next week's teams 🙌
    <app>/r/<tok>
- 2026-11-14 18:00 [Thursday Fives Sandbox] **MatchTime**: 🏅 *New badges this week*
    
    👟 *On the board*: welcome *Lee Carter*, *Mark Evans*, *Nick Burns*, *Owen Platt*, *Paul Dunn*, *Quinn Hart*, *Ross Kemp*, *Sean Tully*, *Tony Wade* and *Vic Moss*, first games for the club! 🎉
    
    Well played all! 👏
    📊 See your own stats and badges any time: tap the stats link in my rating DM after each match.
- 2026-11-14 18:00 database: sent-notification <match 2026-11-12 19:00>:badges: (new) group-message
    sent-notification <match 2026-11-12 19:00>:rate-reminder:@nick:2026-11-14: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-reminder:@owen:2026-11-14: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-reminder:@paul:2026-11-14: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-reminder:@quinn:2026-11-14: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-reminder:@sean:2026-11-14: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-reminder:@tony:2026-11-14: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-reminder:@vic:2026-11-14: (new) dm
    sent-notification txtlog:<club>:<text 28672f2a>:<match 2026-11-12 19:00>:badges: (new) outbound-text-log
- 2026-11-15 12:00 [System] **rehearsal**: cron /api/cron/generate-teams: {"completed":0}
- 2026-11-16 10:00 [DM Lee Carter] **MatchTime**: 📍 Confirm *Thursday Fives Sandbox*'s venue so nearby clubs can find you: MatchTime has no venue for your club yet. Pick your pitch from the list here: <app>/r/<tok>
    MatchTime reminds you once a week until a venue is set.
- 2026-11-16 10:00 database: botjob dm → @lee: 📍 Confirm *Thursday Fives Sandbox*'s venue so nearby clubs can find you: MatchTime has no (#2): (new) sent
- 2026-11-16 12:00 [System] **rehearsal**: cron /api/cron/generate-teams: {"completed":0}
- 2026-11-16 18:00 [DM Nick Burns] **MatchTime**: Last reminder, Nick 🔔 Ratings for *Thursday Fives Sandbox* close soon.
    
    If you'd like to rate your teammates and pick Man of the Match, here's your link. I won't remind you again:
    <app>/r/<tok>
- 2026-11-16 18:00 [DM Owen Platt] **MatchTime**: Last reminder, Owen 🔔 Ratings for *Thursday Fives Sandbox* close soon.
    
    If you'd like to rate your teammates and pick Man of the Match, here's your link. I won't remind you again:
    <app>/r/<tok>
- 2026-11-16 18:00 [DM Paul Dunn] **MatchTime**: Last reminder, Paul 🔔 Ratings for *Thursday Fives Sandbox* close soon.
    
    If you'd like to rate your teammates and pick Man of the Match, here's your link. I won't remind you again:
    <app>/r/<tok>
- 2026-11-16 18:00 [DM Quinn Hart] **MatchTime**: Last reminder, Quinn 🔔 Ratings for *Thursday Fives Sandbox* close soon.
    
    If you'd like to rate your teammates and pick Man of the Match, here's your link. I won't remind you again:
    <app>/r/<tok>
- 2026-11-16 18:00 [DM Sean Tully] **MatchTime**: Last reminder, Sean 🔔 Ratings for *Thursday Fives Sandbox* close soon.
    
    If you'd like to rate your teammates and pick Man of the Match, here's your link. I won't remind you again:
    <app>/r/<tok>
- 2026-11-16 18:00 [DM Tony Wade] **MatchTime**: Last reminder, Tony 🔔 Ratings for *Thursday Fives Sandbox* close soon.
    
    If you'd like to rate your teammates and pick Man of the Match, here's your link. I won't remind you again:
    <app>/r/<tok>
- 2026-11-16 18:00 [DM Vic Moss] **MatchTime**: Last reminder, Vic 🔔 Ratings for *Thursday Fives Sandbox* close soon.
    
    If you'd like to rate your teammates and pick Man of the Match, here's your link. I won't remind you again:
    <app>/r/<tok>
- 2026-11-16 18:00 database: sent-notification <match 2026-11-12 19:00>:rate-reminder:@nick:2026-11-16: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-reminder:@owen:2026-11-16: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-reminder:@paul:2026-11-16: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-reminder:@quinn:2026-11-16: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-reminder:@sean:2026-11-16: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-reminder:@tony:2026-11-16: (new) dm
    sent-notification <match 2026-11-12 19:00>:rate-reminder:@vic:2026-11-16: (new) dm
- 2026-11-17 12:00 [System] **rehearsal**: cron /api/cron/generate-teams: {"completed":0}
- 2026-11-17 19:00 [Thursday Fives Sandbox] **MatchTime**: 🏆 *Man of the Match: Thursday Fives Sandbox*
    
    Congrats *Nick Burns* (2/3 votes) 🎉
    
    Votes:
    • Nick Burns (2)
    • Owen Platt (1)
- 2026-11-17 19:00 database: sent-notification <match 2026-11-12 19:00>:mom-announcement: (new) group-message
    sent-notification txtlog:<club>:<text 350fd739>:<match 2026-11-12 19:00>:mom-announcement: (new) outbound-text-log

### Wednesday: the rating window has closed (2026-11-18 09:00)

