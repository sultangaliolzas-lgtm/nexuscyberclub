const db = require("../lib/db");
const { methodGuard } = require("../lib/guard");

// Сектора колеса и название клуба. Один источник правды: колесо рисуется
// из тех же строк prizes, по которым сервер разыгрывает приз, поэтому
// правка веса в кабинете сразу меняет и шанс, и ширину сектора.
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["GET"])) return;

  // Проверка состояния схемы. Все остальные ручки закрыты подписью
  // Telegram, поэтому убедиться снаружи, что schema.sql выполнен, было
  // нечем — приходилось каждый раз просить владельца открыть вкладку и
  // рассказать, что он видит. Наружу уходят только имена таблиц, никаких
  // данных клуба.
  if (req.query && req.query.health) {
    res.status(200).json(await health());
    return;
  }

  try {
    const [settings, prizes] = await Promise.all([db.getSettings(), db.getPrizes(true)]);

    res.status(200).json({
      clubName: settings.club_name,
      sectors: prizes
        .filter((p) => p.weight > 0)
        .map((p) => ({
          key: p.key,
          title: p.title,
          shortTitle: p.short_title || p.title,
          description: p.description,
          icon: p.icon,
          tier: p.tier,
          color: p.color,
          weight: p.weight
        }))
    });
  } catch (err) {
    console.error("config error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};

// Функции с побочными эффектами сюда не попадают намеренно: вызов
// due_reminders разослал бы клиентам настоящие напоминания.
const CHECKS = [
  { module: "prizes",        table: "prizes",      select: "key" },
  { module: "prizes",        table: "settings",    select: "currency" },
  { module: "notifications", table: "users",       select: "can_message" },
  { module: "notifications", table: "inventory",   select: "reminded_at" },
  { module: "broadcasts",    table: "broadcasts",  select: "photo_file_id" },
  { module: "broadcasts",    rpc: "audience_sizes" },
  { module: "booking",       table: "halls",       select: "name" },
  { module: "booking",       table: "seats",       select: "label" },
  { module: "booking",       table: "packages",    select: "price_per_hour" },
  { module: "booking",       table: "bookings",    select: "period" },
  { module: "booking",       rpc: "booking_config" }
];

async function health() {
  const modules = {};
  const failed = [];

  for (const check of CHECKS) {
    const name = check.table || check.rpc;

    try {
      if (check.rpc) {
        await db.rpc(check.rpc, {});
      } else {
        await db.request(check.table + "?select=" + check.select + "&limit=1", { method: "GET" });
      }

      if (modules[check.module] !== false) modules[check.module] = true;
    } catch (err) {
      modules[check.module] = false;
      failed.push({ name: name, reason: String(err.message || err).slice(0, 160) });
    }
  }

  return {
    ok: failed.length === 0,
    modules: modules,
    failed: failed
  };
}
