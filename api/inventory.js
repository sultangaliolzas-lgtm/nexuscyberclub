const { verifyInitData } = require("../lib/telegram-auth");
const db = require("../lib/db");

const BOT_TOKEN = process.env.BOT_TOKEN;

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const initData = req.headers["x-telegram-init-data"];
  const tgUser = verifyInitData(initData, BOT_TOKEN);
  if (!tgUser) {
    res.status(401).json({ error: "invalid_init_data" });
    return;
  }

  try {
    const user = await db.getUser(tgUser.id);
    const items = await db.getInventoryForUser(tgUser.id);
    res.status(200).json({
      spinsAvailable: user ? user.visits_available : 0,
      items: items.map((i) => ({
        title: i.title,
        tier: i.tier,
        code: i.code,
        wonAt: i.won_at,
        expiresAt: i.expires_at
      }))
    });
  } catch (err) {
    console.error("inventory error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};
