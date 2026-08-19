const crypto = require("crypto");

// Проверяет подпись initData, которую Telegram кладёт в мини-апп.
// Всё, что вернулось отсюда, подписано ботом и ему можно доверять —
// в отличие от initDataUnsafe на клиенте, который подделывается тривиально.
function verifyInitData(initData, botToken) {
  if (!initData) return { ok: false, reason: "no_init_data" };
  if (!botToken) return { ok: false, reason: "no_bot_token" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no_hash" };
  params.delete("hash");

  const pairs = [];
  params.forEach((value, key) => pairs.push(key + "=" + value));
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(computedHash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  const authDate = Number(params.get("auth_date") || 0);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > 86400) return { ok: false, reason: "expired" };

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "no_user" };

  try {
    return {
      ok: true,
      user: JSON.parse(userRaw),
      // Метка QR-точки из ссылки t.me/bot?startapp=<...>.
      // Входит в подписанную строку, поэтому источнику можно верить.
      startParam: params.get("start_param") || null
    };
  } catch (e) {
    return { ok: false, reason: "bad_user_json" };
  }
}

module.exports = { verifyInitData };
