const db = require("../lib/db");

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const STAFF_IDS = (process.env.STAFF_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

const TELEGRAM_API = "https://api.telegram.org/bot" + BOT_TOKEN;

const ID_PATTERN = /^\d{5,}$/;
const USERNAME_PATTERN = /^@[a-zA-Z0-9_]{5,}$/;
const CODE_PATTERN = /^NX-[A-F0-9]{8}$/i;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(200).send("ok");
    return;
  }

  if (!BOT_TOKEN || !WEBAPP_URL) {
    console.error("BOT_TOKEN or WEBAPP_URL env var is missing");
    res.status(200).send("ok");
    return;
  }

  try {
    const update = req.body;
    const message = update && update.message;

    if (message && typeof message.text === "string") {
      const chatId = message.chat.id;
      const fromId = message.from.id;
      const text = message.text.trim();

      await db.upsertUser({
        id: fromId,
        username: message.from.username || null,
        first_name: message.from.first_name || null
      });

      if (text === "/start") {
        await sendStart(chatId, message.from.first_name || "");
        res.status(200).send("ok");
        return;
      }

      if (text === "/id") {
        await sendMessage(chatId, "Твой ID: " + fromId + (message.from.username ? "\nЮзернейм: @" + message.from.username : "") + "\n\nПокажи его сотруднику клуба, чтобы получить прокрут рулетки.");
        res.status(200).send("ok");
        return;
      }

      if (STAFF_IDS.includes(fromId)) {
        const handled = await handleStaffMessage(chatId, fromId, text);
        if (handled) {
          res.status(200).send("ok");
          return;
        }
      }
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }

  res.status(200).send("ok");
};

async function handleStaffMessage(chatId, staffId, text) {
  if (CODE_PATTERN.test(text)) {
    await redeemCode(chatId, text.toUpperCase(), staffId);
    return true;
  }

  if (ID_PATTERN.test(text)) {
    await grantSpin(chatId, Number(text));
    return true;
  }

  if (USERNAME_PATTERN.test(text)) {
    const userId = await db.resolveUserIdByUsername(text);
    if (!userId) {
      await sendMessage(chatId, "Не нашёл клиента с юзернеймом " + text + ". Он должен хотя бы раз нажать /start в этом боте, либо используйте числовой ID (команда /id у клиента).");
      return true;
    }
    await grantSpin(chatId, userId);
    return true;
  }

  return false;
}

async function grantSpin(chatId, userId) {
  try {
    let user = await db.getUser(userId);
    if (!user) {
      await db.upsertUser({ id: userId, visits_available: 0 });
    }
    const next = await db.incrementVisits(userId, 1);
    await sendMessage(chatId, "Готово. Клиенту " + userId + " начислен прокрут. Доступно прокрутов: " + next);
  } catch (err) {
    console.error("grantSpin error:", err);
    await sendMessage(chatId, "Не получилось начислить прокрут. Проверьте ID.");
  }
}

async function redeemCode(chatId, code, staffId) {
  try {
    const item = await db.getInventoryByCode(code);
    if (!item) {
      await sendMessage(chatId, "Код " + code + " не найден.");
      return;
    }
    if (item.status === "redeemed") {
      await sendMessage(chatId, "Код " + code + " уже был погашен ранее (" + item.redeemed_at + ").");
      return;
    }
    if (new Date(item.expires_at).getTime() < Date.now()) {
      await sendMessage(chatId, "Срок действия кода " + code + " истёк.");
      return;
    }
    await db.redeemInventory(item.id, staffId);
    await sendMessage(chatId, "Приз: " + item.title + " (" + item.tier + ")\nКод погашен. Внесите бонус клиенту в систему часов вручную.");
  } catch (err) {
    console.error("redeemCode error:", err);
    await sendMessage(chatId, "Ошибка при погашении кода.");
  }
}

async function sendStart(chatId, firstName) {
  const text =
    "Привет" + (firstName ? ", " + firstName : "") + "!\n\n" +
    "Это рулетка компьютерного клуба Nexus.\n" +
    "Купи часы игры в клубе — получишь прокрут рулетки на следующий визит.\n" +
    "Шанс выиграть доп. время, скидку, снек, напиток или VIP-апгрейд.";

  await sendMessage(chatId, text, {
    inline_keyboard: [[{ text: "🎰 Открыть рулетку", web_app: { url: WEBAPP_URL } }]]
  });
}

async function sendMessage(chatId, text, replyMarkup) {
  const resp = await fetch(TELEGRAM_API + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      reply_markup: replyMarkup
    })
  });
  if (!resp.ok) {
    console.error("sendMessage failed:", await resp.text());
  }
}
