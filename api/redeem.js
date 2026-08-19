const db = require("../lib/db");
const { requireStaff, methodGuard } = require("../lib/guard");

const CODE_PATTERN = /^NX-[A-F0-9]{8}$/i;

// Касса: сотрудник вводит код приза, сервер сам решает, годен ли он.
//
// Сотрудник ничего не сверяет глазами. Проверка «не использован, не
// истёк, чей он» и пометка о погашении делаются одной SQL-командой, так
// что пересланный другу скриншот второй раз не сработает.
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["POST"])) return;

  const auth = await requireStaff(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  const code = String((req.body && req.body.code) || "").trim().toUpperCase();

  if (!CODE_PATTERN.test(code)) {
    res.status(400).json({ ok: false, reason: "bad_format" });
    return;
  }

  try {
    // Сначала сотрудник смотрит, что это за код и чей он, и только
    // потом подтверждает. Предпросмотр ничего не меняет.
    if (req.query && req.query.peek) {
      const peek = await db.rpc("peek_code", { p_code: code });
      res.status(200).json(Object.assign({ code: code }, peek));
      return;
    }

    const result = await db.rpc("do_redeem", { p_code: code, p_staff_id: auth.user.id });
    res.status(200).json(Object.assign({ code: code }, result));
  } catch (err) {
    console.error("redeem error:", err);
    res.status(500).json({ ok: false, reason: "internal_error" });
  }
};
