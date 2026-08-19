const { verifyInitData } = require("./telegram-auth");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN;

// Аварийный вход: если таблица staff по какой-то причине недоступна,
// владелец всё равно попадёт в панель по id из переменных окружения.
const ENV_OWNER_IDS = (process.env.OWNER_IDS || process.env.STAFF_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

// Проверяет подпись Telegram. Возвращает либо клиента, либо готовый ответ с ошибкой.
function authenticate(req) {
  const auth = verifyInitData(req.headers["x-telegram-init-data"], BOT_TOKEN);
  if (!auth.ok) {
    return { ok: false, status: 401, body: { error: "invalid_init_data", reason: auth.reason } };
  }
  return { ok: true, user: auth.user, startParam: auth.startParam };
}

// Роль клиента: owner | staff | client.
async function roleOf(userId) {
  if (ENV_OWNER_IDS.includes(Number(userId))) return "owner";
  try {
    const member = await db.getStaffMember(userId);
    return member ? member.role : "client";
  } catch (err) {
    console.error("roleOf error:", err);
    return "client";
  }
}

// Пускает дальше только владельца. Скрытая вкладка в интерфейсе — не защита,
// каждый админский эндпоинт проверяет роль сам.
async function requireOwner(req) {
  const auth = authenticate(req);
  if (!auth.ok) return auth;

  const role = await roleOf(auth.user.id);
  if (role !== "owner") {
    return { ok: false, status: 403, body: { error: "forbidden" } };
  }
  return { ok: true, user: auth.user, role: role };
}

// Единая обёртка: снимает дублирование проверок метода и заголовков
// во всех эндпоинтах.
function methodGuard(req, res, allowed) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (allowed.indexOf(req.method) === -1) {
    res.status(405).json({ error: "method_not_allowed" });
    return false;
  }
  return true;
}

module.exports = { authenticate, requireOwner, roleOf, methodGuard };
