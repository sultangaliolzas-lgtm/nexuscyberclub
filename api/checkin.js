const db = require("../lib/db");
const { authenticate, methodGuard } = require("../lib/guard");

// Чек-ин по QR со стойки.
//
// Клиент сканирует наклейку камерой телефона -> открывается мини-апп ->
// этот запрос уходит автоматически -> прокрут уже начислен. Ни сотрудник,
// ни клиент больше ничего не делают.
//
// Метка точки размещения (start_param) берётся из подписанной строки
// initData, а не из тела запроса, — подделать её нельзя.
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["POST"])) return;

  const auth = authenticate(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  const source = normalizeSource(auth.startParam);

  try {
    await db.ensureUser(auth.user);
    const result = await db.rpc("do_checkin", { p_user_id: auth.user.id, p_source: source });
    res.status(200).json(result);
  } catch (err) {
    console.error("checkin error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};

// Метка попадает в статистику как есть, поэтому режем длину и мусорные
// символы — иначе в отчёте будет каша из чужих ссылок.
function normalizeSource(raw) {
  if (!raw) return "direct";
  const clean = String(raw).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return clean || "direct";
}
