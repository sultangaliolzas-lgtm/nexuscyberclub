const db = require("../lib/db");
const { requireOwner, methodGuard } = require("../lib/guard");

// Весь кабинет владельца — одна serverless-функция с раздельными
// обработчиками. Держать по файлу на раздел было бы аккуратнее, но
// Vercel на бесплатном тарифе разрешает не больше 12 функций на деплой,
// и шесть файлов кабинета съедали половину лимита.
//
// Раздел выбирается параметром r: /api/admin?r=stats
const ROUTES = {
  stats:    { methods: ["GET"],                     handler: stats },
  prizes:   { methods: ["GET", "PATCH"],            handler: prizes },
  clients:  { methods: ["GET"],                     handler: clients },
  staff:    { methods: ["GET", "POST", "DELETE"],   handler: staff },
  settings: { methods: ["GET", "PATCH"],            handler: settings },
  grant:    { methods: ["POST"],                    handler: grant }
};

module.exports = async function handler(req, res) {
  const key = String((req.query && req.query.r) || "");
  const route = Object.prototype.hasOwnProperty.call(ROUTES, key) ? ROUTES[key] : null;

  if (!route) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ error: "unknown_resource" });
    return;
  }

  if (!methodGuard(req, res, route.methods)) return;

  const auth = await requireOwner(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  try {
    await route.handler(req, res, auth);
  } catch (err) {
    console.error("admin " + key + " error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};

/* ---------------------------------------------------------- отчёт */

// Всё считается одной SQL-функцией: воронка по каждому призу
// (выпал -> забрали -> висит на руках -> сгорел) плюс сводка за период.
// Десяток REST-запросов был бы и медленнее, и несогласован по времени среза.
async function stats(req, res) {
  const days = clampDays(req.query && req.query.days);
  const [data, activity] = await Promise.all([db.getStats(days), db.getActivity(30)]);
  res.status(200).json(Object.assign({ days: days }, data, { activity: activity }));
}

function clampDays(raw) {
  const n = Number(raw);
  if (n === 1 || n === 7 || n === 30 || n === 90) return n;
  return 7;
}

/* ---------------------------------------------------------- призы */

// Белый список полей нужен не для красоты: без него в PATCH можно
// передать любой столбец, включая key и effect, и разъехаться
// с историей в inventory и events.
const EDITABLE = {
  title: (v) => (v === null ? null : String(v).slice(0, 80)),
  description: (v) => (v === null ? null : String(v).slice(0, 120)),
  short_title: (v) => (v === null ? null : String(v).slice(0, 24)),
  icon: (v) => (v === null ? null : String(v).slice(0, 8)),
  tier: (v) => (v === null ? null : String(v).slice(0, 16)),
  weight: (v) => clampInt(v, 0, 1000),
  expires_in_days: (v) => clampInt(v, 0, 365),
  color: (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v) : "#a6ff2f"),
  daily_limit: (v) => (v === null || v === "" ? null : clampInt(v, 0, 10000)),
  enabled: (v) => Boolean(v),
  sort_order: (v) => clampInt(v, 0, 999)
};

async function prizes(req, res) {
  if (req.method === "GET") {
    res.status(200).json({ prizes: await db.getPrizes(false) });
    return;
  }

  const body = req.body || {};
  if (!body.key) {
    res.status(400).json({ error: "key_required" });
    return;
  }

  const patch = {};
  Object.keys(EDITABLE).forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      patch[field] = EDITABLE[field](body[field]);
    }
  });

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "nothing_to_update" });
    return;
  }

  const updated = await db.updatePrize(body.key, patch);
  if (!updated) {
    res.status(404).json({ error: "prize_not_found" });
    return;
  }

  res.status(200).json({ prize: updated });
}

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/* ---------------------------------------------------------- клиенты */

async function clients(req, res) {
  res.status(200).json({ clients: (await db.listClients(200)) || [] });
}

/* ---------------------------------------------------------- персонал */

async function staff(req, res, auth) {
  if (req.method === "GET") {
    res.status(200).json({ staff: (await db.listStaff()) || [] });
    return;
  }

  const body = req.body || {};
  // Тело у DELETE разбирается не везде одинаково, поэтому id
  // принимаем и из query — так запрос не зависит от прослойки.
  const id = Number(body.id || (req.query && req.query.id));

  if (!id || !isFinite(id)) {
    res.status(400).json({ error: "bad_id" });
    return;
  }

  if (req.method === "DELETE") {
    // Владелец не должен случайно снести сам себя и потерять доступ
    // к кабинету — вернуть его можно было бы только через SQL.
    if (id === Number(auth.user.id)) {
      res.status(400).json({ error: "cannot_remove_self" });
      return;
    }
    await db.removeStaff(id);
    res.status(200).json({ ok: true });
    return;
  }

  await db.addStaff(id, body.role === "owner" ? "owner" : "staff",
                    body.title ? String(body.title).slice(0, 40) : null);
  res.status(200).json({ ok: true });
}

/* ---------------------------------------------------------- настройки */

async function settings(req, res) {
  if (req.method === "GET") {
    res.status(200).json({ settings: await db.getSettings() });
    return;
  }

  const body = req.body || {};
  const patch = {};

  if (body.club_name !== undefined) {
    patch.club_name = String(body.club_name).slice(0, 40) || "NEXUS";
  }
  if (body.spin_cooldown_hours !== undefined) {
    patch.spin_cooldown_hours = clampInt(body.spin_cooldown_hours, 0, 720);
  }
  if (body.max_unused_prizes !== undefined) {
    patch.max_unused_prizes = clampInt(body.max_unused_prizes, 0, 50);
  }
  if (body.checkin_enabled !== undefined) {
    patch.checkin_enabled = Boolean(body.checkin_enabled);
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "nothing_to_update" });
    return;
  }

  res.status(200).json({ settings: await db.updateSettings(patch) });
}

/* ---------------------------------------------------------- начисление */

// Ручное начисление: клиенту не удалось отсканировать QR, или владелец
// возвращает человека бонусом. Идёт через ту же функцию, что и у бота,
// поэтому попадает в ленту действий вместе с автором.
async function grant(req, res, auth) {
  const body = req.body || {};
  const userId = Number(body.userId);

  if (!userId || !isFinite(userId)) {
    res.status(400).json({ error: "bad_user_id" });
    return;
  }

  // Потолок в 20 штук за раз — защита от лишнего нуля в поле ввода.
  const amount = clampInt(body.amount || 1, 1, 20);

  if (!(await db.getUser(userId))) {
    res.status(404).json({ error: "client_not_found" });
    return;
  }

  const left = await db.rpc("do_grant", {
    p_user_id: userId,
    p_staff_id: auth.user.id,
    p_amount: amount
  });

  res.status(200).json({ ok: true, spinsAvailable: left, granted: amount });
}
