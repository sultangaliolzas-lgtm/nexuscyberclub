const db = require("../lib/db");
const { authenticate, roleOf, methodGuard } = require("../lib/guard");

// Стартовое состояние мини-аппа: сколько прокрутов доступно, что лежит
// в инвентаре, что уже забрано и какая у клиента роль (от неё зависит,
// показывать ли вкладку "Админ").
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["GET"])) return;

  const auth = authenticate(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  try {
    const user = await db.ensureUser(auth.user);

    const [items, redeemed, prizes, role, settings] = await Promise.all([
      db.getInventoryForUser(auth.user.id),
      db.getRedeemedForUser(auth.user.id, 20),
      db.getPrizes(false),
      roleOf(auth.user.id),
      db.getSettings()
    ]);

    // Иконку берём из справочника призов: в inventory лежит только
    // название на момент выигрыша, а картинку владелец может поменять.
    const iconByKey = {};
    prizes.forEach((p) => { iconByKey[p.key] = p.icon; });

    res.status(200).json({
      role: role,
      spinsAvailable: user ? user.visits_available : 0,
      // Когда откроется следующий бесплатный прокрут — на этом
      // приложение рисует обратный отсчёт вместо кнопки.
      nextSpinAt: nextSpinAt(user, settings),
      maxUnusedPrizes: settings.max_unused_prizes || 0,
      // Может ли бот написать клиенту. Если нет, приложение предложит
      // включить напоминания: Telegram запрещает боту писать первым,
      // пока человек сам не начал с ним переписку.
      canMessage: Boolean(user && user.can_message),
      botLink: botLink(),
      visitsTotal: user ? user.visits_total : 0,
      items: items.map((i) => shape(i, iconByKey)),
      redeemed: redeemed.map((i) => shape(i, iconByKey))
    });
  } catch (err) {
    console.error("inventory error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};

// start=notify — чтобы в логах бота было видно, что человек пришёл
// именно за уведомлениями, а не отсканировал QR на стойке.
function botLink() {
  const name = process.env.BOT_USERNAME;
  return name ? "https://t.me/" + String(name).replace(/^@/, "") + "?start=notify" : null;
}

function nextSpinAt(user, settings) {
  if (!user || !user.last_checkin_at) return null;
  const hours = settings.spin_cooldown_hours || 0;
  return new Date(new Date(user.last_checkin_at).getTime() + hours * 3600000).toISOString();
}

function shape(i, iconByKey) {
  return {
    title: i.title,
    tier: i.tier,
    code: i.code,
    icon: iconByKey[i.prize_key] || "🎁",
    wonAt: i.won_at,
    expiresAt: i.expires_at,
    redeemedAt: i.redeemed_at
  };
}
