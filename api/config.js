const db = require("../lib/db");
const { methodGuard } = require("../lib/guard");

// Сектора колеса и название клуба. Один источник правды: колесо рисуется
// из тех же строк prizes, по которым сервер разыгрывает приз, поэтому
// правка веса в кабинете сразу меняет и шанс, и ширину сектора.
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["GET"])) return;

  try {
    const [settings, prizes] = await Promise.all([db.getSettings(), db.getPrizes(true)]);

    res.status(200).json({
      clubName: settings.club_name,
      sectors: prizes
        .filter((p) => p.weight > 0)
        .map((p) => ({
          key: p.key,
          title: p.title,
          shortTitle: p.short_title || p.title,
          icon: p.icon,
          tier: p.tier,
          color: p.color,
          weight: p.weight
        }))
    });
  } catch (err) {
    console.error("config error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};
