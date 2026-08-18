const crypto = require("crypto");
const { verifyInitData } = require("../lib/telegram-auth");
const db = require("../lib/db");
const { pickPrize } = require("../lib/prizes");

const BOT_TOKEN = process.env.BOT_TOKEN;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const initData = req.headers["x-telegram-init-data"];
  const auth = verifyInitData(initData, BOT_TOKEN);
  if (!auth.ok) {
    res.status(401).json({ error: "invalid_init_data", reason: auth.reason });
    return;
  }
  const tgUser = auth.user;

  try {
    let user = await db.getUser(tgUser.id);
    if (!user) {
      await db.upsertUser({
        id: tgUser.id,
        username: tgUser.username || null,
        first_name: tgUser.first_name || null,
        visits_available: 0
      });
      user = await db.getUser(tgUser.id);
    }

    if (!user || user.visits_available <= 0) {
      res.status(403).json({ error: "no_spins_available" });
      return;
    }

    await db.incrementVisits(tgUser.id, -1);

    const prize = pickPrize();

    if (prize.key === "nothing") {
      res.status(200).json({ prize: null });
      return;
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + prize.expiresInDays * 86400000).toISOString();

    const item = await db.insertInventory({
      user_id: tgUser.id,
      prize_key: prize.key,
      title: prize.title,
      tier: prize.tier,
      code: code,
      status: "unused",
      expires_at: expiresAt
    });

    res.status(200).json({ prize: { title: prize.title, tier: prize.tier, code: item.code, expiresAt: item.expires_at } });
  } catch (err) {
    console.error("spin error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};

function generateCode() {
  return "NX-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}
