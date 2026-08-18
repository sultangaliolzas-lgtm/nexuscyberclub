// Отредактируйте список под реальные призы клуба Nexus.
// weight — относительный вес шанса выпадения (не обязательно суммируется в 100).
// expiresInDays — через сколько дней сгорает невостребованный приз.
const PRIZES = [
  { key: "time_30", title: "+30 минут игры", tier: "COMMON", weight: 25, expiresInDays: 3 },
  { key: "time_60", title: "+1 час игры", tier: "RARE", weight: 10, expiresInDays: 3 },
  { key: "discount_10", title: "Скидка 10% на визит", tier: "COMMON", weight: 20, expiresInDays: 5 },
  { key: "snack", title: "Снек в подарок", tier: "COMMON", weight: 15, expiresInDays: 3 },
  { key: "drink", title: "Напиток в подарок", tier: "COMMON", weight: 15, expiresInDays: 3 },
  { key: "vip_upgrade", title: "Апгрейд до VIP-места", tier: "EPIC", weight: 5, expiresInDays: 2 },
  { key: "nothing", title: null, tier: null, weight: 30, expiresInDays: 0 }
];

function pickPrize() {
  const totalWeight = PRIZES.reduce((sum, p) => sum + p.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const prize of PRIZES) {
    roll -= prize.weight;
    if (roll <= 0) return prize;
  }
  return PRIZES[PRIZES.length - 1];
}

module.exports = { PRIZES, pickPrize };
