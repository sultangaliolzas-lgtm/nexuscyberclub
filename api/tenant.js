const db = require("../lib/db");
const { authenticate, isPlatformOwner, methodGuard } = require("../lib/guard");
const { botUsername } = require("../lib/telegram");

// Самообслуживание клубов: создать свой клуб и посмотреть список своих.
// Отдельный роутер, чтобы уложиться в лимит функций Vercel.
//   POST /api/tenant?r=create   — создать клуб
//   GET  /api/tenant?r=mine     — клубы, где я владелец
//   GET  /api/tenant?r=all      — все клубы платформы (только оператор)
//   POST /api/tenant?r=delete   — удалить клуб (только оператор)
const MAX_CLUBS_PER_OWNER = 3;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const auth = authenticate(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  const r = String((req.query && req.query.r) || "");

  try {
    if (r === "mine" && req.method === "GET") {
      await mine(req, res, auth);
      return;
    }
    if (r === "all" && req.method === "GET") {
      await all(req, res, auth);
      return;
    }
    if (r === "delete" && req.method === "POST") {
      await remove(req, res, auth);
      return;
    }
    if (r === "activate" && req.method === "POST") {
      await activate(req, res, auth);
      return;
    }
    if (r === "create" && req.method === "POST") {
      await create(req, res, auth);
      return;
    }
    res.status(404).json({ error: "unknown_resource" });
  } catch (err) {
    console.error("tenant " + r + " error:", err);
    res.status(500).json({ error: "internal_error", reason: String(err.message || err).slice(0, 200) });
  }
};

async function mine(req, res, auth) {
  const rows = await db.getStaffClubs(auth.user.id);
  const bot = await botUsername();
  const owned = rows
    .filter((s) => s.role === "owner" && s.clubs)
    .map((s) => shape(s.clubs, bot));
  res.status(200).json({ clubs: owned });
}

// Список всех подключённых клубов — только оператору платформы. Владелец
// обычного клуба сюда не пройдёт (видит лишь свой клуб через r=mine).
async function all(req, res, auth) {
  if (!isPlatformOwner(auth.user.id)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const rows = await db.listAllClubs();
  const bot = await botUsername();
  const clubs = rows.map((c) => ({
    code: c.code,
    name: c.name,
    ownerTgId: c.owner_tg_id,
    plan: c.plan,
    status: c.status,
    createdAt: c.created_at,
    paidUntil: c.paid_until,
    // Конец пробы = дата создания + неделя. Фронт по этой дате показывает
    // «осталось N дней»; та же неделя используется в автозаморозке.
    trialUntil: c.plan === "trial" && c.created_at
      ? new Date(new Date(c.created_at).getTime() + db.TRIAL_DAYS * 86400000).toISOString()
      : null,
    isDefault: Boolean(c.is_default),
    bookingEnabled: Boolean(c.booking_enabled),
    clients: count(c.users),
    prizesOut: count(c.inventory),
    link: bot ? "https://t.me/" + bot + "?startapp=" + c.code : null
  }));

  res.status(200).json({ clubs: clubs, total: clubs.length });
}

// PostgREST возвращает встроенный агрегат как [{ count: N }].
function count(embed) {
  return (embed && embed[0] && embed[0].count) || 0;
}

// Удаление клуба со всеми данными — только оператору. Дефолтный (первый)
// клуб удалить нельзя: на него завязан вход без кода.
async function remove(req, res, auth) {
  if (!isPlatformOwner(auth.user.id)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const code = String((req.body && req.body.code) || "").trim();
  const club = code ? await db.getClubByCode(code) : null;
  if (!club) {
    res.status(404).json({ error: "club_not_found" });
    return;
  }
  if (club.is_default) {
    res.status(400).json({ error: "cannot_delete_default" });
    return;
  }

  await db.deleteClub(club.id);
  res.status(200).json({ ok: true, code: club.code });
}

// Активация/продление клуба вручную — только оператору. Снимает заморозку и
// продлевает оплаченный доступ на N дней (по умолчанию неделя).
async function activate(req, res, auth) {
  if (!isPlatformOwner(auth.user.id)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const code = String((req.body && req.body.code) || "").trim();
  const club = code ? await db.getClubByCode(code) : null;
  if (!club) {
    res.status(404).json({ error: "club_not_found" });
    return;
  }

  const rows = await db.activateClub(club.id, req.body && req.body.days);
  res.status(200).json({ ok: true, code: club.code, paidUntil: rows && rows[0] ? rows[0].paid_until : null });
}

async function create(req, res, auth) {
  const owned = (await db.getStaffClubs(auth.user.id)).filter((s) => s.role === "owner");
  if (owned.length >= MAX_CLUBS_PER_OWNER) {
    res.status(409).json({ error: "too_many_clubs", limit: MAX_CLUBS_PER_OWNER });
    return;
  }

  const name = String((req.body && req.body.name) || "").trim().slice(0, 40);
  if (!name) {
    res.status(400).json({ error: "name_required" });
    return;
  }

  const created = await db.createClub(auth.user.id, name);
  const bot = await botUsername();

  res.status(200).json({
    club: {
      id: created.id,
      code: created.code,
      name: created.name,
      status: "active",
      link: bot ? "https://t.me/" + bot + "?startapp=" + created.code : null
    }
  });
}

function shape(club, bot) {
  return {
    id: club.id,
    code: club.code,
    name: club.name,
    status: club.status,
    link: bot ? "https://t.me/" + bot + "?startapp=" + club.code : null
  };
}
