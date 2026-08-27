const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function headers(extra) {
  return Object.assign(
    {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json"
    },
    extra || {}
  );
}

async function request(path, options) {
  const resp = await fetch(SUPABASE_URL + "/rest/v1/" + path, Object.assign({}, options, { headers: headers(options && options.headers) }));
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error("Supabase error " + resp.status + ": " + text);
  }
  if (resp.status === 204) return null;
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

// Вызов SQL-функции. Всё, что должно быть атомарным (прокрут, чек-ин,
// погашение кода), живёт там, а не размазано по запросам отсюда.
// В мультиарендной схеме первый аргумент любой такой функции — p_club_id.
async function rpc(name, args) {
  return request("rpc/" + name, {
    method: "POST",
    body: JSON.stringify(args || {})
  });
}

/* ---------------------------------------------------------- клубы */

// Клуб по короткому коду из deep-link (t.me/bot?startapp=<code>...).
async function getClubByCode(code) {
  const clean = String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  if (!clean) return null;
  const rows = await request("clubs?code=eq." + clean + "&select=*", { method: "GET" });
  return rows && rows[0] ? rows[0] : null;
}

async function getClubById(id) {
  const rows = await request("clubs?id=eq." + encodeURIComponent(id) + "&select=*", { method: "GET" });
  return rows && rows[0] ? rows[0] : null;
}

// Все клубы, где данный tg-id — сотрудник или владелец. Нужно вебхуку
// общего бота: по сообщению без контекста понять, за какой клуб человек.
async function getStaffClubs(tgId) {
  const rows = await request(
    "staff?id=eq." + tgId + "&select=club_id,role,clubs(id,code,name,status)",
    { method: "GET" }
  );
  return rows || [];
}

// Активные клубы — для ежедневных напоминаний (обходим каждый по очереди).
async function listActiveClubs() {
  return request("clubs?status=eq.active&select=id,code,name", { method: "GET" }) || [];
}

// Создать новый клуб (реестр + настройки + призы + владелец) одной
// транзакцией на стороне базы. Возвращает { id, code, name }.
async function createClub(ownerTgId, name) {
  return rpc("create_club", { p_owner_tg_id: ownerTgId, p_name: name || "" });
}

/* ---------------------------------------------------------- клиенты */

async function getUser(clubId, id) {
  const rows = await request(
    "users?club_id=eq." + encodeURIComponent(clubId) + "&id=eq." + id + "&select=*",
    { method: "GET" }
  );
  return rows && rows[0] ? rows[0] : null;
}

async function upsertUser(clubId, user) {
  const row = Object.assign({ club_id: clubId }, user);
  return request("users", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([row])
  });
}

// Заводит клиента в конкретном клубе, если его ещё нет, и подтягивает
// свежие имя/юзернейм. Возвращает актуальную строку.
async function ensureUser(clubId, tgUser) {
  const patch = {
    id: tgUser.id,
    username: tgUser.username || null,
    first_name: tgUser.first_name || null
  };

  // Telegram кладёт в подписанную initData флаг allows_write_to_pm —
  // разрешил ли клиент боту писать первым. Если поля нет, это не "нет",
  // а "неизвестно", поэтому колонку в таком случае не трогаем вовсе.
  if (typeof tgUser.allows_write_to_pm === "boolean") {
    patch.can_message = tgUser.allows_write_to_pm;
  }

  await upsertUser(clubId, patch);
  return getUser(clubId, tgUser.id);
}

// Обновить факты уровня личности (имя, телефон, доступность бота) сразу
// во всех клубах, где у человека есть карточка. Нужно вебхуку общего
// бота: разрешение писать и номер — свойства человека, а не клуба.
async function touchUserEverywhere(tgId, patch) {
  return request("users?id=eq." + tgId, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch)
  });
}

// Помечает клиентов клуба, которым бот писать не может.
async function setCanMessage(clubId, ids, value) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(function (n) {
    return isFinite(n) && n > 0;
  });
  if (!list.length) return null;

  return request(
    "users?club_id=eq." + encodeURIComponent(clubId) + "&id=in.(" + list.join(",") + ")",
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ can_message: Boolean(value) })
    }
  );
}

// Клуб, которому принадлежит приз с этим кодом. Коды глобально уникальны,
// поэтому по коду можно определить клуб — нужно для погашения по боту.
async function clubOfCode(code) {
  const clean = String(code || "").toUpperCase();
  const rows = await request(
    "inventory?code=eq." + encodeURIComponent(clean) + "&select=club_id&limit=1",
    { method: "GET" }
  );
  return rows && rows[0] ? rows[0].club_id : null;
}

async function resolveUserIdByUsername(clubId, username) {
  const clean = username.replace(/^@/, "");
  const rows = await request(
    "users?club_id=eq." + encodeURIComponent(clubId) + "&username=eq." + encodeURIComponent(clean) + "&select=id",
    { method: "GET" }
  );
  return rows && rows[0] ? rows[0].id : null;
}

async function listClients(clubId, limit) {
  return rpc("admin_clients", { p_club_id: clubId, p_limit: limit || 100 });
}

/* ---------------------------------------------------------- призы */

async function getPrizes(clubId, onlyEnabled) {
  const filter = onlyEnabled ? "&enabled=is.true" : "";
  return request(
    "prizes?club_id=eq." + encodeURIComponent(clubId) + "&select=*" + filter + "&order=sort_order.asc",
    { method: "GET" }
  );
}

async function updatePrize(clubId, key, patch) {
  const rows = await request(
    "prizes?club_id=eq." + encodeURIComponent(clubId) + "&key=eq." + encodeURIComponent(key),
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(patch)
    }
  );
  return rows && rows[0] ? rows[0] : null;
}

/* ---------------------------------------------------------- настройки */

async function getSettings(clubId) {
  const rows = await request("settings?club_id=eq." + encodeURIComponent(clubId) + "&select=*", { method: "GET" });
  return rows && rows[0] ? rows[0] : { club_name: "Клуб", spin_cooldown_hours: 24, checkin_enabled: true };
}

async function updateSettings(clubId, patch) {
  const rows = await request("settings?club_id=eq." + encodeURIComponent(clubId), {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch)
  });
  return rows && rows[0] ? rows[0] : null;
}

/* ---------------------------------------------------------- персонал */

async function getStaffMember(clubId, id) {
  const rows = await request(
    "staff?club_id=eq." + encodeURIComponent(clubId) + "&id=eq." + id + "&select=*",
    { method: "GET" }
  );
  return rows && rows[0] ? rows[0] : null;
}

async function listStaff(clubId) {
  return request(
    "staff?club_id=eq." + encodeURIComponent(clubId) + "&select=*&order=role.asc,added_at.asc",
    { method: "GET" }
  );
}

async function addStaff(clubId, id, role, title) {
  return request("staff", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{ club_id: clubId, id: id, role: role || "staff", title: title || null }])
  });
}

async function removeStaff(clubId, id) {
  return request(
    "staff?club_id=eq." + encodeURIComponent(clubId) + "&id=eq." + id,
    { method: "DELETE", headers: { Prefer: "return=minimal" } }
  );
}

/* ---------------------------------------------------------- инвентарь */

async function getInventoryForUser(clubId, userId) {
  return request(
    "inventory?club_id=eq." + encodeURIComponent(clubId) + "&user_id=eq." + userId +
      "&status=eq.unused&expires_at=gt." + encodeURIComponent(new Date().toISOString()) +
      "&order=won_at.desc&select=*",
    { method: "GET" }
  );
}

async function getRedeemedForUser(clubId, userId, limit) {
  return request(
    "inventory?club_id=eq." + encodeURIComponent(clubId) + "&user_id=eq." + userId +
      "&status=eq.redeemed&order=redeemed_at.desc&limit=" + (limit || 20) + "&select=*",
    { method: "GET" }
  );
}

/* ---------------------------------------------------------- статистика */

async function getStats(clubId, days) {
  return rpc("admin_stats", { p_club_id: clubId, p_days: days });
}

async function getActivity(clubId, limit) {
  return rpc("admin_activity", { p_club_id: clubId, p_limit: limit || 40 });
}

module.exports = {
  request,
  rpc,
  getClubByCode,
  getClubById,
  getStaffClubs,
  listActiveClubs,
  createClub,
  getUser,
  upsertUser,
  ensureUser,
  touchUserEverywhere,
  setCanMessage,
  clubOfCode,
  resolveUserIdByUsername,
  listClients,
  getPrizes,
  updatePrize,
  getSettings,
  updateSettings,
  getStaffMember,
  listStaff,
  addStaff,
  removeStaff,
  getInventoryForUser,
  getRedeemedForUser,
  getStats,
  getActivity
};
