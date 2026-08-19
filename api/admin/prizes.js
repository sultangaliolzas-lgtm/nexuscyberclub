const db = require("../../lib/db");
const { requireOwner, methodGuard } = require("../../lib/guard");

// Редактор призов. Правки применяются мгновенно: и шанс выпадения,
// и ширина сектора на колесе читаются из этих же строк.
//
// Белый список полей нужен не для красоты: без него в PATCH можно
// передать любой столбец, включая key, и разъехаться с историей
// в inventory и events.
const EDITABLE = {
  title: (v) => (v === null ? null : String(v).slice(0, 80)),
  short_title: (v) => (v === null ? null : String(v).slice(0, 24)),
  description: (v) => (v === null ? null : String(v).slice(0, 120)),
  icon: (v) => (v === null ? null : String(v).slice(0, 8)),
  tier: (v) => (v === null ? null : String(v).slice(0, 16)),
  weight: (v) => clampInt(v, 0, 1000),
  expires_in_days: (v) => clampInt(v, 0, 365),
  color: (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v) : "#a6ff2f"),
  daily_limit: (v) => (v === null || v === "" ? null : clampInt(v, 0, 10000)),
  enabled: (v) => Boolean(v),
  sort_order: (v) => clampInt(v, 0, 999)
};

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["GET", "PATCH"])) return;

  const auth = await requireOwner(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  try {
    if (req.method === "GET") {
      const prizes = await db.getPrizes(false);
      res.status(200).json({ prizes: prizes });
      return;
    }

    const body = req.body || {};
    if (!body.key) {
      res.status(400).json({ error: "key_required" });
      return;
    }

    const patch = {};
    Object.keys(EDITABLE).forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        patch[field] = EDITABLE[field](body[field]);
      }
    });

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "nothing_to_update" });
      return;
    }

    const updated = await db.updatePrize(body.key, patch);
    if (!updated) {
      res.status(404).json({ error: "prize_not_found" });
      return;
    }

    res.status(200).json({ prize: updated });
  } catch (err) {
    console.error("admin prizes error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
