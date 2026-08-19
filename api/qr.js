const QRCode = require("qrcode");

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = "https://api.telegram.org/bot" + BOT_TOKEN;

// Юзернейм бота меняется редко, а лямбда живёт между запросами,
// поэтому спрашиваем его у Telegram один раз и держим в памяти.
let cachedUsername = process.env.BOT_USERNAME || null;

// Отдаёт QR-код наклейки для ресепшена.
//
// Ссылка вида t.me/<bot>?startapp=<метка> открывает мини-апп в одно
// действие: клиент наводит камеру -> открывается Telegram -> сразу
// приложение с уже начисленным прокрутом.
module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const source = normalizeSource(req.query && req.query.source);

  try {
    const username = await resolveBotUsername();
    if (!username) {
      res.status(500).json({ error: "bot_username_unavailable" });
      return;
    }

    const link = "https://t.me/" + username + "?startapp=" + source;

    if (req.query && req.query.format === "json") {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ link: link, source: source, username: username });
      return;
    }

    const svg = await QRCode.toString(link, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" }
    });

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).send(svg);
  } catch (err) {
    console.error("qr error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};

async function resolveBotUsername() {
  if (cachedUsername) return cachedUsername;
  if (!BOT_TOKEN) return null;

  const resp = await fetch(TELEGRAM_API + "/getMe");
  if (!resp.ok) return null;

  const data = await resp.json();
  cachedUsername = data && data.result ? data.result.username : null;
  return cachedUsername;
}

function normalizeSource(raw) {
  if (!raw) return "r1";
  const clean = String(raw).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return clean || "r1";
}
