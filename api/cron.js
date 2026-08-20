const crypto = require("crypto");
const { runReminders } = require("../lib/notify");

// Ежедневная задача: предупредить клиентов, у которых приз сгорает в
// ближайшие сутки, и подарить им немного времени сверху.
//
// Расписание задаётся в vercel.json. Бесплатный тариф Vercel разрешает
// запуск раз в сутки — этого хватает ровно потому, что задача смотрит
// на 24 часа вперёд: каждый приз попадает в один запуск и получает одно
// напоминание.
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!authorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const result = await runReminders();
    console.log("reminders:", JSON.stringify(result));
    res.status(200).json(Object.assign({ ok: true }, result));
  } catch (err) {
    console.error("cron error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};

// Vercel подписывает вызов заголовком Authorization, если в переменных
// окружения задан CRON_SECRET. Без секрета эндпоинт остаётся открытым,
// и это осознанно: навредить вызовом нельзя — приз помечается в базе в
// том же запросе, которым выбирается, и второго напоминания не получит.
// Но в логи пишем предупреждение, чтобы секрет всё-таки поставили.
function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn("CRON_SECRET не задан — /api/cron открыт для всех");
    return true;
  }

  const expected = Buffer.from("Bearer " + secret);
  const got = Buffer.from(String(req.headers.authorization || ""));

  // Сравнение постоянного времени: обычное === утекает длину совпавшего
  // префикса и позволяет подобрать секрет по времени ответа.
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
