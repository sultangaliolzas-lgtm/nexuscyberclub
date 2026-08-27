const db = require("../lib/db");
const { authenticate, clubContext, methodGuard } = require("../lib/guard");

// Прокрут рулетки.
//
// Списание прокрута, взвешенный выбор приза с учётом дневных лимитов,
// выдача кода и запись события делаются одной SQL-функцией do_spin —
// целиком внутри одной транзакции, чтобы двойной тап не отдал два приза.
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["POST"])) return;

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
  if (club.status === "frozen") {
    res.status(403).json({ error: "club_frozen" });
    return;
  }

  try {
    await db.ensureUser(club.id, auth.user);
    const result = await db.rpc("do_spin", { p_club_id: club.id, p_user_id: auth.user.id });

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
