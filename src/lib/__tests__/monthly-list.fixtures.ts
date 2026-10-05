/**
 * Anonymised monthly lists, in the style a real group writes them.
 *
 * Every name here is made up (the same fake names as the F3 fixture,
 * `setup-learning/__fixtures__/monthly-list.json`). There are no real
 * names, phone numbers or bank details in this file, and there must
 * never be. Only the SHAPES are real: the U+2060 word-joiners WhatsApp
 * leaves on a copied list, the stray leading spaces, every way of
 * writing "paid", the blanked slot, and the section at the bottom.
 */

/** WhatsApp's word-joiner, left behind when a list is copied. */
const WJ = "⁠";

/** The organiser's opening post: three names and a placeholder. */
export const OPENING_POST = `List for October:

1. Marco
2. ${WJ}Gary
3. ${WJ}JB
4. ${WJ}….`;

/** Mid sign-up: names only, one date-limited PAYG player. */
export const SIGN_UP = `List for October:

1.${WJ} ${WJ}Marco
2.${WJ} ${WJ}${WJ}Gary
3.${WJ} ${WJ}${WJ}JB
4.${WJ} ${WJ}Clive
5. Tom
6. ${WJ}Paulo
7. Danny
8. Simon (PAYG 5th only)
9. ${WJ}Mick
10. ${WJ}Wes
11. ${WJ}Sunny`;

/** The full 14-slot list on match day: every paid style, an ignored
 *  bracket, an emoji in a name, a blanked slot, PAYG fill-ins, and the
 *  "Paid but can't play" section with five names. */
export const MATCH_DAY = `List for October:

1.${WJ} ${WJ}Marco (Bossman)
2.${WJ} ${WJ}${WJ}Gary (Paid £22.50)
3.${WJ} ${WJ}${WJ}JB (Paid £22.50)
4.${WJ} ${WJ}Clive (paid pensioners rate)
 5. Tom (Paid 30)
 6. ${WJ}Vikram (PAYG)
 7. BoJan😁 (paid 22.50)
 8. Simon (PAYG 5th only)
 9. ${WJ}Mick (paid £22.50)
10.
11. ${WJ}Sunny paid
12. ${WJ}Mo (paid)
13. ${WJ}Sam (PAYG)
14. Alfie (PAYG)

Paid but can't play
1. Paulo
2. ${WJ}Kai
3. ${WJ}Finn
4. Nico
5. ${WJ}${WJ}Wes`;

/** A list with BOTH a can't-play section and a reserves block. */
export const TWO_SECTIONS = `October list

1. Marco (paid)
2. Gary (paid)
3. JB
4. Clive
5.
6. Tom

Can't play:
1. Paulo
2. Kai

Reserves:
1. Theo
2. Rafi`;

/** The same habit in Turkish. */
export const TURKISH = `Kasım listesi

1. Emre (ödedi)
2. Burak ödedi 300
3. Çağrı (PAYG 9 Kasım)
4.
5. Işıl (ödendi)

Ödedi gelemiyor
1. Deniz
2. Ozan`;

/** MatchTime's own month post, as the plan (section 4.1) words it. */
export const MATCHTIME_POST = `📋 List for November (5 Mondays: 2, 9, 16, 23, 30)

1. Alex
2. Bilal
3. Chris
4.
5.

Regulars from October are on already. Not in for November? Say OUT FOR NOVEMBER.`;
