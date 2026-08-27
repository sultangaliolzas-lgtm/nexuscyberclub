const { verifyInitData } = require("./telegram-auth");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN;

// Аварийный вход платформы: перечисленные id считаются владельцами в
// ЛЮБОМ клубе (оператор SaaS). Обычные владельцы клубов сюда не входят —
// их роль берётся из таблицы staff по конкретному club_id.
const ENV_OWNER_IDS = (process.env.OWNER_IDS || process.env.STAFF_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

// Проверяет подпись Telegram. Возвращает либо клиента, либо готовый ответ
// с ошибкой. Бот один на всех клубов, поэтому токен тоже один.
function authenticate(req) {
  const auth = verifyInitData(req.headers["x-telegram-init-data"], BOT_TOKEN);
  if (!auth.ok) {
    return { ok: false, status: 401, body: { error: "invalid_init_data", reason: auth.reason } };
  }
  return { ok: true, user: auth.user, startParam: auth.startParam };
}

// Код клуба приходит заголовком x-club-code — приложение берёт его из
// start_param при загрузке и шлёт с каждым запросом. Заголовок подделать
// можно, но утечки это не даёт: все запросы скоупятся по (club_id,
// user_id), а доступ владельца/сотрудника проверяется по таблице staff
// именно этого клуба.
async function clubContext(req) {
  const code = req.headers["x-club-code"];
  try {
    if (code) {
      const club = await db.getClubByCode(code);
      if (club) return club;
    }
    // Нет кода (или он не найден) — пробуем клуб по умолчанию: старые
    // ссылки первого клуба ещё без кода.
    return await db.getFallbackClub();
  } catch (err) {
    console.error("clubContext error:", err);
    return null;
  }
}

// Роль клиента в конкретном клубе: owner | staff | client.
async function roleOf(clubId, userId) {
  if (ENV_OWNER_IDS.includes(Number(userId))) return "owner";
  if (!clubId) return "client";
  try {
    const member = await db.getStaffMember(clubId, userId);
    return member ? member.role : "client";
  } catch (err) {
    console.error("roleOf error:", err);
    return "client";
  }
}

// Разбирает start_param общего бота: первые 6 символов — код клуба,
// остаток — метка QR-точки. Пример: "nx0001r1" -> { code:"nx0001", source:"r1" }.
function parseStartParam(raw) {
  const clean = String(raw || "").replace(/[^a-zA-Z0-9_-]/g, "");
  // Короткий параметр (< 6) — это старая метка точки без кода клуба:
  // отдаём его как source, клуб определится по умолчанию.
  if (clean.length < 6) return { code: null, source: clean || null };
  return {
    code: clean.slice(0, 6).toLowerCase(),
    source: clean.slice(6) || null
  };
}

// Общая часть для админских проверок: подпись + клуб + роль.
async function requireRole(req, allowed) {
  const auth = authenticate(req);
  if (!auth.ok) return auth;

  const club = await clubContext(req);
  if (!club) {
    return { ok: false, status: 400, body: { error: "no_club" } };
  }

  const role = await roleOf(club.id, auth.user.id);
  if (allowed.indexOf(role) === -1) {
    return { ok: false, status: 403, body: { error: "forbidden" } };
  }
  return { ok: true, user: auth.user, role: role, club: club };
}

// Пускает дальше только владельца клуба.
function requireOwner(req) {
  return requireRole(req, ["owner"]);
}

// Пускает и сотрудника, и владельца: касса нужна обоим.
function requireStaff(req) {
  return requireRole(req, ["owner", "staff"]);
}

// Единая обёртка: снимает дублирование проверок метода и заголовков.
function methodGuard(req, res, allowed) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (allowed.indexOf(req.method) === -1) {
    res.status(405).json({ error: "method_not_allowed" });
    return false;
  }
  return true;
}

module.exports = {
  authenticate,
  clubContext,
  requireOwner,
  requireStaff,
  roleOf,
  parseStartParam,
  methodGuard
};
