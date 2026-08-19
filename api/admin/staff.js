const db = require("../../lib/db");
const { requireOwner, methodGuard } = require("../../lib/guard");

// Управление персоналом без деплоя: владелец добавляет и убирает
// сотрудников по Telegram ID прямо из кабинета.
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["GET", "POST", "DELETE"])) return;

  const auth = await requireOwner(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  try {
    if (req.method === "GET") {
      const staff = await db.listStaff();
      res.status(200).json({ staff: staff || [] });
      return;
    }

    // Тело у DELETE разбирается не везде одинаково, поэтому id
    // принимаем и из query — так запрос не зависит от прослойки.
    const body = req.body || {};
    const id = Number(body.id || (req.query && req.query.id));
    if (!id || !isFinite(id)) {
      res.status(400).json({ error: "bad_id" });
      return;
    }

    if (req.method === "DELETE") {
      // Владелец не должен случайно снести сам себя и потерять доступ
      // к кабинету — вернуть его можно было бы только через SQL.
      if (id === Number(auth.user.id)) {
        res.status(400).json({ error: "cannot_remove_self" });
        return;
      }
      await db.removeStaff(id);
      res.status(200).json({ ok: true });
      return;
    }

    const role = body.role === "owner" ? "owner" : "staff";
    const title = body.title ? String(body.title).slice(0, 40) : null;
    await db.addStaff(id, role, title);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("admin staff error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};
