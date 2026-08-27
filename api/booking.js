const db = require("../lib/db");
const fmt = require("../lib/fmt");
const { authenticate, requireStaff, clubContext, methodGuard } = require("../lib/guard");
const { sendMessage, openAppMarkup } = require("../lib/telegram");

// Бронирование мест — один файл на весь раздел по той же причине, что и
// кабинет владельца: Vercel на бесплатном тарифе считает функции, а не
// маршруты, и пять отдельных файлов съели бы почти половину остатка.
//
// Раздел выбирается параметром r: /api/booking?r=layout
const ROUTES = {
  config: { methods: ["GET"],  staff: false, handler: config },
  layout: { methods: ["GET"],  staff: false, handler: layout },
  create: { methods: ["POST"], staff: false, handler: create },
  mine:   { methods: ["GET"],  staff: false, handler: mine },
  cancel: { methods: ["POST"], staff: false, handler: cancel },
  desk:   { methods: ["GET"],  staff: true,  handler: desk }
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

  const auth = route.staff ? await requireStaff(req) : authenticate(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  // Клуб нужен и для проверки доступа к модулю брони, и чтобы не смешать
  // данные разных клубов. У staff-роутов клуб уже в auth, у клиентских —
  // берём из заголовка.
  const club = auth.club || await clubContext(req);
  if (!club) {
    res.status(400).json({ error: "no_club" });
    return;
  }

  // Бронь на этом этапе включена не у всех клубов (booking_enabled). Пока
  // она не сделана мультиарендной, у выключенных клубов отдаём пустоту —
  // так их сотрудники не увидят чужих броней первого клуба.
  if (!club.booking_enabled) {
    bookingDisabled(res, key);
    return;
  }
  auth.club = club;

  try {
    await route.handler(req, res, auth);
  } catch (err) {
    console.error("booking " + key + " error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};

function bookingDisabled(res, key) {
  res.setHeader("Cache-Control", "no-store");
  if (key === "desk" || key === "mine") { res.status(200).json({ bookings: [] }); return; }
  if (key === "layout") { res.status(200).json({ seats: [] }); return; }
  if (key === "config") { res.status(200).json({ halls: [], packages: [], disabled: true }); return; }
  res.status(403).json({ error: "booking_disabled" });
}

/* ---------------------------------------------------------- залы и тарифы */

async function config(req, res) {
  res.status(200).json(await db.rpc("booking_config", {}));
}

/* ---------------------------------------------------------- схема зала */

// Занятость считает база: отдавать клиенту список всех броней, чтобы он
// сам вычислил свободные места, значило бы показывать одному клиенту
// чужие визиты и телефоны.
async function layout(req, res) {
  const hall = String((req.query && req.query.hall) || "");
  const from = parseWhen(req.query && req.query.from);
  const hours = clampInt(req.query && req.query.hours, 1, 12);

  if (!hall || !from) {
    res.status(400).json({ error: "bad_params" });
    return;
  }

  const to = new Date(from.getTime() + hours * 3600000);

  const seats = await db.rpc("booking_layout", {
    p_hall_id: hall,
    p_from: from.toISOString(),
    p_to: to.toISOString()
  });

  res.status(200).json({
    from: from.toISOString(),
    to: to.toISOString(),
    seats: seats || []
  });
}

/* ---------------------------------------------------------- создание */

const ERRORS = {
  seat_taken:            [409, "Это место только что заняли — выберите другое"],
  blocked:               [403, "Бронирование недоступно"],
  seat_not_found:        [404, "Место не найдено"],
  package_not_found:     [404, "Тариф не найден"],
  package_zone_mismatch: [400, "Этот тариф не подходит к выбранному месту"],
  in_the_past:           [400, "Это время уже прошло"],
  too_far:               [400, "Бронировать можно не больше чем на две недели вперёд"]
};

async function create(req, res, auth) {
  const body = req.body || {};
  const from = parseWhen(body.startsAt);

  if (!body.seatId || !body.packageId || !from) {
    res.status(400).json({ error: "bad_params" });
    return;
  }

  await db.ensureUser(auth.club.id, auth.user);

  const result = await db.rpc("create_booking", {
    p_user_id: auth.user.id,
    p_seat_id: String(body.seatId),
    p_package_id: String(body.packageId),
    p_starts_at: from.toISOString(),
    p_hours: clampInt(body.hours, 1, 12)
  });

  if (result && result.error) {
    const known = ERRORS[result.error] || [400, "Не получилось забронировать"];
    res.status(known[0]).json({ error: result.error, reason: known[1] });
    return;
  }

  // Уведомление уходит после ответа клиенту по смыслу, но до него по
  // коду: если Telegram не ответит, бронь всё равно уже в базе, и
  // терять её из-за упавшей отправки нельзя.
  await notifyStaff(auth.club.id, result).catch((err) => console.error("booking notify:", err));

  res.status(200).json({ booking: result });
}

/* ---------------------------------------------------------- мои брони */

async function mine(req, res, auth) {
  res.status(200).json({ bookings: (await db.rpc("my_bookings", { p_user_id: auth.user.id })) || [] });
}

async function cancel(req, res, auth) {
  const id = String((req.body && req.body.id) || "");

  if (!id) {
    res.status(400).json({ error: "bad_params" });
    return;
  }

  const result = await db.rpc("cancel_booking", { p_id: id, p_user_id: auth.user.id });

  if (result && result.error) {
    res.status(409).json({ error: result.error, reason: "Отменить эту бронь уже нельзя" });
    return;
  }

  res.status(200).json(result);
}

/* ---------------------------------------------------------- стойка */

// Сотруднику нужен ближайший день, владельцу — картина за период,
// поэтому окно задаётся снаружи, а не зашито в функцию.
async function desk(req, res) {
  const days = clampInt(req.query && req.query.days, 1, 30);
  const from = startOfToday();
  const to = new Date(from.getTime() + days * 86400000);

  const rows = await db.rpc("admin_bookings", {
    p_from: from.toISOString(),
    p_to: to.toISOString()
  });

  res.status(200).json({ bookings: rows || [], from: from.toISOString(), days: days });
}

/* ---------------------------------------------------------- помощники */

// Сотрудники узнают о брони сразу, а не открыв приложение: место может
// понадобиться прибрать, а консоль — освободить от предыдущей компании.
async function notifyStaff(clubId, booking) {
  const [staff, settings] = await Promise.all([db.listStaff(clubId), db.getSettings(clubId)]);
  if (!staff || !staff.length) return;

  const client = booking.client || {};
  const who = [client.name, client.username ? "@" + client.username : null, client.phone]
    .filter(Boolean).join(" · ");

  const text =
    "📅 Новая бронь\n\n" +
    booking.hall + " · место " + booking.seat + "\n" +
    "Тариф: " + booking.package + "\n" +
    fmt.range(booking.startsAt, booking.endsAt, settings.timezone) +
    " (" + booking.hours + " ч)\n" +
    "Сумма: " + fmt.money(booking.price, settings.currency) + "\n\n" +
    "Клиент: " + (who || client.id) + "\n" +
    "Код брони: " + booking.code;

  const markup = openAppMarkup("Открыть приложение");

  for (const member of staff) {
    const result = await sendMessage(member.id, text, markup);
    if (result.blocked) await db.setCanMessage(clubId, [member.id], false);
  }
}

function parseWhen(raw) {
  if (!raw) return null;
  const date = new Date(String(raw));
  return isFinite(date.getTime()) ? date : null;
}

function startOfToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
