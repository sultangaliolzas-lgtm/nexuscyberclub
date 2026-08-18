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

async function incrementVisits(id, delta) {
  const user = await getUser(id);
  if (!user) throw new Error("User not found: " + id);
  const next = Math.max(0, (user.visits_available || 0) + delta);
  await request("users?id=eq." + id, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ visits_available: next })
  });
  return next;
}

async function insertInventory(item) {
  const rows = await request("inventory", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([item])
  });
  return rows[0];
}

async function getInventoryForUser(userId) {
  return request(
    "inventory?user_id=eq." + userId + "&status=eq.unused&expires_at=gt." + encodeURIComponent(new Date().toISOString()) + "&order=won_at.desc&select=*",
    { method: "GET" }
  );
}

async function getInventoryByCode(code) {
  const rows = await request("inventory?code=eq." + encodeURIComponent(code) + "&select=*", { method: "GET" });
  return rows && rows[0] ? rows[0] : null;
}

async function redeemInventory(id, staffId) {
  return request("inventory?id=eq." + id, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "redeemed", redeemed_at: new Date().toISOString(), redeemed_by: staffId })
  });
}

async function resolveUserIdByUsername(username) {
  const clean = username.replace(/^@/, "");
  const rows = await request("users?username=eq." + encodeURIComponent(clean) + "&select=id", { method: "GET" });
  return rows && rows[0] ? rows[0].id : null;
}

module.exports = {
  getUser,
  upsertUser,
  incrementVisits,
  insertInventory,
  getInventoryForUser,
  getInventoryByCode,
  redeemInventory,
  resolveUserIdByUsername
};
