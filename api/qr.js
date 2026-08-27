const QRCode = require("qrcode");
const { botUsername } = require("../lib/telegram");

const CODE_PATTERN = /^NX-[A-F0-9]{8}$/;

// Отдаёт QR-код наклейки для ресепшена конкретного клуба.
//
// Ссылка вида t.me/<bot>?startapp=<clubcode><source> открывает мини-апп
// в одно действие и сразу попадает в нужный клуб: первые 6 символов
// start_param — код клуба, остаток — метка точки размещения.
module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  // Второй режим: QR с кодом приза, чтобы сотрудник сканировал его
  // с экрана клиента. Секретом код не является.
  const rawCode = String((req.query && req.query.code) || "").toUpperCase();
  if (rawCode) {
    if (!CODE_PATTERN.test(rawCode)) {
      res.status(400).json({ error: "bad_code" });
      return;
    }
    await renderQr(res, rawCode);
    return;
  }

  const club = normalizeClub(req.query && req.query.club);
  if (!club) {
    res.status(400).json({ error: "club_required" });
    return;
  }

  const source = normalizeSource(req.query && req.query.source);

  try {
    const username = await botUsername();
    if (!username) {
      res.status(500).json({ error: "bot_username_unavailable" });
      return;
    }

    const link = "https://t.me/" + username + "?startapp=" + club + source;

    if (req.query && req.query.format === "json") {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ link: link, source: source, club: club, username: username });
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

function normalizeClub(raw) {
  const clean = String(raw || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  return clean.length === 6 ? clean : null;
}

function normalizeSource(raw) {
  if (!raw) return "r1";
  const clean = String(raw).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return clean || "r1";
}
