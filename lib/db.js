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
async function rpc(name, args) {
  return request("rpc/" + name, {
    method: "POST",
    body: JSON.stringify(args || {})
  });
}

/* ---------------------------------------------------------- клиенты */

async function getUser(id) {
  const rows = await request("users?id=eq." + id + "&select=*", { method: "GET" });
  return rows && rows[0] ? rows[0] : null;
}

async function upsertUser(user) {
  return request("users", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([user])
  });
}

// Заводит клиента, если его ещё нет, и подтягивает свежие имя/юзернейм.
// Возвращает актуальную строку.
async function ensureUser(tgUser) {
  await upsertUser({
    id: tgUser.id,
    username: tgUser.username || null,
    first_name: tgUser.first_name || null
  });
  return getUser(tgUser.id);
}

async function resolveUserIdByUsername(username) {
  const clean = username.replace(/^@/, "");
  const rows = await request("users?username=eq." + encodeURIComponent(clean) + "&select=id", { method: "GET" });
  return rows && rows[0] ? rows[0].id : null;
}

async function listClients(limit) {
  return rpc("admin_clients", { p_limit: limit || 100 });
}

/* ---------------------------------------------------------- призы */

async function getPrizes(onlyEnabled) {
  const filter = onlyEnabled ? "&enabled=is.true" : "";
  return request("prizes?select=*" + filter + "&order=sort_order.asc", { method: "GET" });
}

async function updatePrize(key, patch) {
  const rows = await request("prizes?key=eq." + encodeURIComponent(key), {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch)
  });
  return rows && rows[0] ? rows[0] : null;
}

/* ---------------------------------------------------------- настройки */

async function getSettings() {
  const rows = await request("settings?id=eq.1&select=*", { method: "GET" });
  return rows && rows[0] ? rows[0] : { club_name: "NEXUS", spin_cooldown_hours: 24, checkin_enabled: true };
}

async function updateSettings(patch) {
  const rows = await request("settings?id=eq.1", {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch)
  });
  return rows && rows[0] ? rows[0] : null;
}

/* ---------------------------------------------------------- персонал */

async function getStaffMember(id) {
  const rows = await request("staff?id=eq." + id + "&select=*", { method: "GET" });
  return rows && rows[0] ? rows[0] : null;
}

async function listStaff() {
  return request("staff?select=*&order=role.asc,added_at.asc", { method: "GET" });
}

async function addStaff(id, role, title) {
  return request("staff", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{ id: id, role: role || "staff", title: title || null }])
  });
}

async function removeStaff(id) {
  return request("staff?id=eq." + id, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

/* ---------------------------------------------------------- инвентарь */

async function getInventoryForUser(userId) {
  return request(
    "inventory?user_id=eq." + userId +
      "&status=eq.unused&expires_at=gt." + encodeURIComponent(new Date().toISOString()) +
      "&order=won_at.desc&select=*",
    { method: "GET" }
  );
}

async function getRedeemedForUser(userId, limit) {
  return request(
    "inventory?user_id=eq." + userId + "&status=eq.redeemed&order=redeemed_at.desc&limit=" + (limit || 20) + "&select=*",
    { method: "GET" }
  );
}

/* ---------------------------------------------------------- статистика */

async function getStats(days) {
  return rpc("admin_stats", { p_days: days });
}

async function getActivity(limit) {
  return rpc("admin_activity", { p_limit: limit || 40 });
}

module.exports = {
  request,
  rpc,
  getUser,
  upsertUser,
  ensureUser,
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
