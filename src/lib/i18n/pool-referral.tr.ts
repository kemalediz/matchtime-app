/** Referral badges and "Brought by" in Turkish (growth slice G4). See `pool-referral.ts`. */
import type { PoolReferralCopy } from "./pool-referral";

const bold = (names: string[]): string => {
  const b = names.map((n) => `*${n}*`);
  return b.length <= 1 ? (b[0] ?? "") : `${b.slice(0, -1).join(", ")} ve ${b[b.length - 1]}`;
};

export const POOL_REFERRAL_TR: PoolReferralCopy = {
  postLine: ({ key, emoji, label, names, friends }) => {
    const who = bold(names);
    const many = names.length > 1;
    switch (key) {
      case "recruiter":
        return `${emoji} *${label}*: ${who} oyuna ${many ? "birer" : "bir"} yeni oyuncu kazandırdı 🙌`;
      case "scout":
        return `${emoji} *${label}*: ${who} ${many ? "her biri " : ""}oyuna artık ${friends} oyuncu kazandırdı 👏`;
      case "talent-spotter":
        return `${emoji} *${label}*: ${who} ${many ? "her biri " : ""}oyuna artık ${friends} oyuncu kazandırdı, tam bir yetenek avcısı! 🌟`;
    }
  },
  statsTitle: "Oyuna oyuncu kazandırmak",
  statsCount: (n) => `Oyuna kazandırdığın oyuncular: ${n}`,
  statsHowItCounts: "Bağlantınla kaydolan bir arkadaşın, ilk maçını oynadığında sayılır.",
  statsPrivate: "Bunları gizli tutuyorsun, bu yüzden kulübünün grubunda duyurulmaz.",
  badgeHint: (n) => `Oyuna ${n} oyuncu kazandırmak`,
  broughtBy: (name) => `Getiren: ${name}`,
};
