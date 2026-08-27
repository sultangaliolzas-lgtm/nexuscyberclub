const db = require("../lib/db");
const { authenticate, clubContext, roleOf, methodGuard } = require("../lib/guard");
const { botUsername } = require("../lib/telegram");

// Стартовое состояние мини-аппа для клиента конкретного клуба: сколько
// прокрутов доступно, что в инвентаре, что забрано и какая роль (от неё
// зависит, показывать ли вкладку «Админ» — именно в ЭТОМ клубе).
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["GET"])) return;

  const auth = authenticate(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  const club = await clubContext(req);
  if (!club) {
    res.status(400).json({ error: "no_club" });
    return;
  }

  try {
    const user = await db.ensureUser(club.id, auth.user);

    const [items, redeemed, prizes, role, settings, bot] = await Promise.all([
      db.getInventoryForUser(club.id, auth.user.id),
      db.getRedeemedForUser(club.id, auth.user.id, 20),
      db.getPrizes(club.id, false),
      roleOf(club.id, auth.user.id),
      db.getSettings(club.id),
      botUsername()
    ]);

    // Иконку берём из справочника призов: в inventory лежит только
    // название на момент выигрыша, а картинку владелец может поменять.
    const iconByKey = {};
    prizes.forEach((p) => { iconByKey[p.key] = p.icon; });

    res.status(200).json({
      role: role,
      clubStatus: club.status,
      bookingEnabled: Boolean(club.booking_enabled),
      spinsAvailable: user ? user.visits_available : 0,
      nextSpinAt: nextSpinAt(user, settings),
      maxUnusedPrizes: settings.max_unused_prizes || 0,
      canMessage: Boolean(user && user.can_message),
      // Ссылка открывает общий бот с кодом клуба, чтобы /start завёл
      // человека именно в этом клубе и разрешил боту писать.
      botLink: bot ? "https://t.me/" + bot + "?start=" + club.code : null,
      visitsTotal: user ? user.visits_total : 0,
      items: items.map((i) => shape(i, iconByKey)),
      redeemed: redeemed.map((i) => shape(i, iconByKey))
    });
  } catch (err) {
    console.error("inventory error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};

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
