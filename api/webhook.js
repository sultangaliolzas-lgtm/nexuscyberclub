const db = require("../lib/db");
const { roleOf } = require("../lib/guard");

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;

const TELEGRAM_API = "https://api.telegram.org/bot" + BOT_TOKEN;

const ID_PATTERN = /^(\d{5,})(?:\s+(\d{1,2}))?$/;
const USERNAME_PATTERN = /^(@[a-zA-Z0-9_]{5,})(?:\s+(\d{1,2}))?$/;
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

      const role = await roleOf(fromId);

      if (text === "/start" || text.startsWith("/start ")) {
        await sendStart(chatId, message.from.first_name || "", role);
      } else if (text === "/id") {
        await sendId(chatId, message.from);
      } else if (text === "/help") {
        await sendHelp(chatId, role);
      } else if (role !== "client") {
        await handleStaffMessage(chatId, fromId, text, role);
      }
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }

  // Telegram повторяет доставку на любой ответ кроме 200, поэтому
  // отвечаем успехом даже на своей ошибке — иначе апдейт зациклится.
  res.status(200).send("ok");
};

async function handleStaffMessage(chatId, staffId, text, role) {
  if (CODE_PATTERN.test(text)) {
    await redeemCode(chatId, text, staffId);
    return;
  }

  const byId = ID_PATTERN.exec(text);
  if (byId) {
    await grantSpin(chatId, Number(byId[1]), staffId, amountOf(byId[2]));
    return;
  }

  const byName = USERNAME_PATTERN.exec(text);
  if (byName) {
    const userId = await db.resolveUserIdByUsername(byName[1]);
    if (!userId) {
      await sendMessage(
        chatId,
        "Не нашёл клиента с юзернеймом " + byName[1] + ".\n" +
          "Он должен хотя бы раз нажать /start в этом боте — либо используйте числовой ID (команда /id у клиента)."
      );
      return;
    }
    await grantSpin(chatId, userId, staffId, amountOf(byName[2]));
    return;
  }

  await sendHelp(chatId, role);
}

// Потолок в 20 штук — защита от опечатки вроде лишнего нуля.
function amountOf(raw) {
  const n = Math.round(Number(raw));
  if (!isFinite(n) || n < 1) return 1;
  return Math.min(20, n);
}

async function grantSpin(chatId, userId, staffId, amount) {
  try {
    const existing = await db.getUser(userId);
    if (!existing) {
      await db.upsertUser({ id: userId, visits_available: 0 });
    }

    const left = await db.rpc("do_grant", { p_user_id: userId, p_staff_id: staffId, p_amount: amount });

    if (left === -1 || left === null) {
      await sendMessage(chatId, "Не получилось начислить прокрут. Проверьте ID.");
      return;
    }

    await sendMessage(chatId, "Готово. Клиенту " + userId + " начислено прокрутов: " + amount + ".\nДоступно прокрутов: " + left);
  } catch (err) {
    console.error("grantSpin error:", err);
    await sendMessage(chatId, "Не получилось начислить прокрут. Проверьте ID.");
  }
}

async function redeemCode(chatId, code, staffId) {
  try {
    const result = await db.rpc("do_redeem", { p_code: code.toUpperCase(), p_staff_id: staffId });

    if (result && result.ok) {
      await sendMessage(
        chatId,
        "✅ " + result.title + " (" + result.tier + ")\n\n" +
          "Код погашен. Выдайте приз клиенту."
      );
      return;
    }

    const reason = result && result.reason;

    if (reason === "already_redeemed") {
      await sendMessage(chatId, "⚠️ Код " + code.toUpperCase() + " уже был погашен: " + formatDate(result.redeemedAt) + ".");
    } else if (reason === "expired") {
      await sendMessage(chatId, "⚠️ Срок действия кода " + code.toUpperCase() + " истёк " + formatDate(result.expiresAt) + ".");
    } else {
      await sendMessage(chatId, "❌ Код " + code.toUpperCase() + " не найден.");
    }
  } catch (err) {
    console.error("redeemCode error:", err);
    await sendMessage(chatId, "Ошибка при погашении кода.");
  }
}

async function sendStart(chatId, firstName, role) {
  let text =
    "Привет" + (firstName ? ", " + firstName : "") + "!\n\n" +
    "Это рулетка компьютерного клуба Nexus.\n\n" +
    "Отсканируй QR-код на ресепшене — прокрут откроется сам, сразу в приложении.\n" +
    "Выигрывай доп. время, скидки, снеки, напитки и VIP-места.\n\n" +
    "Призы забираются на стойке клуба: покажи код сотруднику.";

  if (role !== "client") {
    text += "\n\n———\nВы вошли как " + (role === "owner" ? "владелец" : "сотрудник") + ". Команды: /help";
  }

  await sendMessage(chatId, text, {
    inline_keyboard: [[{ text: "🎰 Открыть рулетку", web_app: { url: WEBAPP_URL } }]]
  });
}

async function sendId(chatId, from) {
  await sendMessage(
    chatId,
    "Твой ID: " + from.id +
      (from.username ? "\nЮзернейм: @" + from.username : "") +
      "\n\nОбычно он не нужен — прокрут начисляется по QR-коду на ресепшене. " +
      "Пригодится, только если что-то пошло не так и сотрудник начисляет прокрут вручную."
  );
}

async function sendHelp(chatId, role) {
  if (role === "client") {
    await sendMessage(chatId, "Отсканируй QR-код на ресепшене клуба — рулетка откроется сама.\n\n/id — твой номер, если сотрудник попросит.");
    return;
  }

  await sendMessage(
    chatId,
    "Команды сотрудника:\n\n" +
      "• Пришлите код вида NX-1A2B3C4D — приз будет погашен.\n" +
      "• Пришлите числовой ID клиента — начислится один прокрут.\n" +
      "• Пришлите @юзернейм клиента — то же самое.\n" +
      "• Через пробел можно указать количество: 420115296 5\n\n" +
      (role === "owner"
        ? "Статистика, редактор призов и база клиентов — во вкладке «Админ» внутри приложения."
        : "")
  );
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
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
