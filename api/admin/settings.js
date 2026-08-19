const db = require("../../lib/db");
const { requireOwner, methodGuard } = require("../../lib/guard");

// Настройки клуба: название и правила начисления прокрутов.
// spin_cooldown_hours вынесен сюда, чтобы позже, при подключении API
// кассы клуба, перейти с "раз в сутки" на "раз за посещение" без деплоя.
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["GET", "PATCH"])) return;

  const auth = await requireOwner(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  try {
    if (req.method === "GET") {
      const settings = await db.getSettings();
      res.status(200).json({ settings: settings });
      return;
    }

    const body = req.body || {};
    const patch = {};

    if (body.club_name !== undefined) {
      patch.club_name = String(body.club_name).slice(0, 40) || "NEXUS";
    }
    if (body.spin_cooldown_hours !== undefined) {
      const h = Math.round(Number(body.spin_cooldown_hours));
      patch.spin_cooldown_hours = isFinite(h) ? Math.min(720, Math.max(0, h)) : 24;
    }
    if (body.max_unused_prizes !== undefined) {
      const cap = Math.round(Number(body.max_unused_prizes));
      patch.max_unused_prizes = isFinite(cap) ? Math.min(50, Math.max(0, cap)) : 5;
    }
    if (body.checkin_enabled !== undefined) {
      patch.checkin_enabled = Boolean(body.checkin_enabled);
    }

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "nothing_to_update" });
      return;
    }

    const settings = await db.updateSettings(patch);
    res.status(200).json({ settings: settings });
  } catch (err) {
    console.error("admin settings error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};
