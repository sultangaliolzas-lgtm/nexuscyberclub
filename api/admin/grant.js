const db = require("../../lib/db");
const { requireOwner, methodGuard } = require("../../lib/guard");

// Ручное начисление прокрутов из кабинета: клиенту не удалось
// отсканировать QR, или владелец хочет вернуть человека бонусом.
//
// Начисление идёт через ту же SQL-функцию, что и у бота, поэтому
// действие попадает в лог событий и видно, кто его сделал.
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["POST"])) return;

  const auth = await requireOwner(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  const body = req.body || {};
  const userId = Number(body.userId);
  if (!userId || !isFinite(userId)) {
    res.status(400).json({ error: "bad_user_id" });
    return;
  }

  // Потолок в 20 штук за раз — защита от лишнего нуля в поле ввода.
  const amount = Math.min(20, Math.max(1, Math.round(Number(body.amount) || 1)));

  try {
    const existing = await db.getUser(userId);
    if (!existing) {
      res.status(404).json({ error: "client_not_found" });
      return;
    }

    const left = await db.rpc("do_grant", {
      p_user_id: userId,
      p_staff_id: auth.user.id,
      p_amount: amount
    });

    res.status(200).json({ ok: true, spinsAvailable: left, granted: amount });
  } catch (err) {
    console.error("admin grant error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};
