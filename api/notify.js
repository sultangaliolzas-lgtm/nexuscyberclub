const db = require("../lib/db");
const { authenticate, clubContext, methodGuard } = require("../lib/guard");
const { sendMessage, openAppMarkup } = require("../lib/telegram");

// Клиент разрешил боту писать — Telegram.WebApp.requestWriteAccess
// показал ему системное окно, и он нажал «Разрешить».
//
// Верить на слово нельзя: проверяем делом — пробуем отправить
// подтверждение. Дошло — значит разрешение действительно есть.
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

  try {
    await db.ensureUser(club.id, auth.user);

    const result = await sendMessage(
      auth.user.id,
      "🔔 Напоминания включены.\n\n" +
        "Предупредим заранее, когда выигранный приз будет подходить к концу, " +
        "и добавим немного времени, чтобы вы успели зайти.",
      openAppMarkup("Открыть приложение")
    );

    await db.setCanMessage(club.id, [auth.user.id], result.ok);

    res.status(200).json({ ok: result.ok });
  } catch (err) {
    console.error("notify error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};
