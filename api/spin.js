const db = require("../lib/db");
const { authenticate, methodGuard } = require("../lib/guard");

// Прокрут рулетки.
//
// Списание прокрута, взвешенный выбор приза с учётом дневных лимитов,
// выдача кода и запись события делаются одной SQL-функцией do_spin —
// целиком внутри одной транзакции. Раньше баланс читался и писался
// двумя отдельными запросами, и быстрый двойной тап по кнопке успевал
// пройти проверку дважды, отдавая два приза за один прокрут.
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["POST"])) return;

  const auth = authenticate(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  try {
    await db.ensureUser(auth.user);
    const result = await db.rpc("do_spin", { p_user_id: auth.user.id });

    if (result && result.error === "no_spins_available") {
      res.status(403).json({ error: "no_spins_available" });
      return;
    }

    // Инвентарь заполнен: прокрут не списан, клиенту надо сначала
    // забрать своё на стойке.
    if (result && result.error === "inventory_full") {
      res.status(409).json(result);
      return;
    }

    res.status(200).json(result);
  } catch (err) {
    console.error("spin error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};
