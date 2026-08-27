const db = require("../lib/db");
const { methodGuard } = require("../lib/guard");

// Сектора колеса и название клуба — для конкретного клуба (?club=<code>).
// Один источник правды: колесо рисуется из тех же строк prizes, по
// которым сервер разыгрывает приз, поэтому правка веса в кабинете сразу
// меняет и шанс, и ширину сектора.
//
// Ручка публичная (без подписи Telegram): отдаёт только витрину клуба
// (имя и призы), которая и так видна каждому, кто открыл ссылку.
module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, ["GET"])) return;

  // Проверка состояния схемы. Наружу уходят только имена таблиц.
  if (req.query && req.query.health) {
    res.status(200).json(await health());
    return;
  }

  try {
    const code = (req.query && req.query.club) || null;
    let club = code ? await db.getClubByCode(code) : null;
    // Нет кода или клуб не найден — пробуем клуб по умолчанию (переходный
    // период, старые ссылки первого клуба ещё без кода).
    if (!club) club = await db.getFallbackClub();

    if (!club) {
      // Без валидного клуба отдаём пустую витрину, а не 404: приложение
      // покажет экран «создать клуб» / «клуб не найден».
      res.status(200).json({ clubName: null, sectors: [], clubKnown: false });
      return;
    }

    const [settings, prizes] = await Promise.all([
      db.getSettings(club.id),
      db.getPrizes(club.id, true)
    ]);

    res.status(200).json({
      clubKnown: true,
      code: club.code,
      clubName: settings.club_name,
      status: club.status,                     // active | frozen
      bookingEnabled: Boolean(club.booking_enabled),
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
  { module: "tenancy",       table: "clubs",       select: "code" },
  { module: "tenancy",       table: "settings",    select: "club_id" },
  { module: "tenancy",       table: "users",       select: "club_id" },
  { module: "prizes",        table: "prizes",      select: "key" },
  { module: "prizes",        table: "settings",    select: "currency" },
  { module: "notifications", table: "users",       select: "can_message" },
  { module: "notifications", table: "inventory",   select: "reminded_at" },
  { module: "broadcasts",    table: "broadcasts",  select: "photo_file_id" },
  { module: "welcome",       table: "settings",    select: "welcome_photo_file_id" },
  { module: "booking",       table: "halls",       select: "name" },
  { module: "booking",       table: "seats",       select: "label" },
  { module: "booking",       table: "packages",    select: "price_per_hour" },
  { module: "booking",       table: "bookings",    select: "period" }
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
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || null,
    modules: modules,
    failed: failed
  };
}
