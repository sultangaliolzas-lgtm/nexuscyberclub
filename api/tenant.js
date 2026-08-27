const db = require("../lib/db");
const { authenticate, methodGuard } = require("../lib/guard");
const { botUsername } = require("../lib/telegram");

// Самообслуживание клубов: создать свой клуб и посмотреть список своих.
// Отдельный роутер, чтобы уложиться в лимит функций Vercel.
//   POST /api/tenant?r=create   — создать клуб
//   GET  /api/tenant?r=mine     — клубы, где я владелец
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
