const QRCode = require("qrcode");
const { botUsername } = require("../lib/telegram");

const CODE_PATTERN = /^NX-[A-F0-9]{8}$/;

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

  // Второй режим: QR с кодом приза, чтобы сотрудник сканировал его
  // с экрана клиента вместо набора вручную. Секретом код не является —
  // чтобы нарисовать такой QR, его нужно уже знать.
  const rawCode = String((req.query && req.query.code) || "").toUpperCase();
  if (rawCode) {
    if (!CODE_PATTERN.test(rawCode)) {
      res.status(400).json({ error: "bad_code" });
      return;
    }
    await renderQr(res, rawCode);
    return;
  }

  const source = normalizeSource(req.query && req.query.source);

  try {
    const username = await botUsername();
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

    await renderQr(res, link);
  } catch (err) {
    console.error("qr error:", err);
    res.status(500).json({ error: "internal_error" });
  }
};

async function renderQr(res, text) {
  const svg = await QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" }
  });

  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).send(svg);
}


function normalizeSource(raw) {
  if (!raw) return "r1";
  const clean = String(raw).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return clean || "r1";
}
