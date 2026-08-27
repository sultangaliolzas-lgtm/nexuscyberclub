const db = require("../lib/db");
const { authenticate, clubContext, parseStartParam, methodGuard } = require("../lib/guard");

// Чек-ин по QR со стойки конкретного клуба.
//
// Клуб и метка точки берутся из start_param подписанной initData
// (t.me/<bot>?startapp=<clubcode><source>), а не из тела запроса, —
// подделать нельзя. Если start_param по какой-то причине пуст, клуб
// берём из заголовка x-club-code (тот же код, что приложение прочитало
// из ссылки).
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["POST"])) return;

  const auth = authenticate(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  const parsed = parseStartParam(auth.startParam);
  let club = null;
  if (parsed.code) club = await db.getClubByCode(parsed.code);
  if (!club) club = await clubContext(req);

  if (!club) {
    res.status(400).json({ error: "no_club" });
    return;
  }

  // Приостановленный (неоплаченный) клуб прокруты не начисляет.
  if (club.status === "frozen") {
    res.status(200).json({ granted: false, reason: "club_frozen", spinsAvailable: 0 });
    return;
  }

  const source = normalizeSource(parsed.source);

  try {
    await db.ensureUser(club.id, auth.user);
    const result = await db.rpc("do_checkin", {
      p_club_id: club.id,
      p_user_id: auth.user.id,
      p_source: source
    });
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
