const db = require("../../lib/db");
const { requireOwner, methodGuard } = require("../../lib/guard");

// Статистика кабинета владельца.
//
// Всё считается одной SQL-функцией: воронка по каждому призу
// (выпал -> забрали -> висит на руках -> сгорел) плюс сводка за период.
// Тянуть это десятком REST-запросов было бы и медленно, и несогласованно
// между собой по времени среза.
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["GET"])) return;

  const auth = await requireOwner(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  const days = clampDays(req.query && req.query.days);

  try {
    const [stats, activity] = await Promise.all([db.getStats(days), db.getActivity(30)]);
    res.status(200).json(Object.assign({ days: days }, stats, { activity: activity }));
  } catch (err) {
    console.error("admin stats error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};

function clampDays(raw) {
  const n = Number(raw);
  if (n === 1 || n === 7 || n === 30 || n === 90) return n;
  return 7;
}
