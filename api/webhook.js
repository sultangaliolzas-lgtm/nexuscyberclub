const db = require("../lib/db");
const { sendMessage, sendPhoto } = require("../lib/telegram");

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;

const ID_PATTERN = /^(\d{5,})(?:\s+(\d{1,2}))?$/;
const USERNAME_PATTERN = /^(@[a-zA-Z0-9_]{5,})(?:\s+(\d{1,2}))?$/;
const CODE_PATTERN = /^NX-[A-F0-9]{8}$/i;

// Общий бот на все клубы. Клуб для конкретного сообщения определяется по
// контексту: из полезной нагрузки /start, из кода приза (коды глобально
// уникальны) или из принадлежности сотрудника к клубу (таблица staff).
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

    if (message && message.contact) {
      await saveContact(message);
      res.status(200).send("ok");
      return;
    }

    if (message && typeof message.text === "string") {
      const chatId = message.chat.id;
      const fromId = message.from.id;
      const text = message.text.trim();

      // Раз человек сам написал боту — переписка открыта. Это факт уровня
      // личности (общий бот один), поэтому пишем во все его карточки.
      await db.touchUserEverywhere(fromId, {
        username: message.from.username || null,
        first_name: message.from.first_name || null,
        can_message: true
      });

      const staffClubs = await db.getStaffClubs(fromId);

      if (text === "/start" || text.startsWith("/start ")) {
        await handleStart(chatId, message.from, text);
      } else if (text === "/id") {
        await sendId(chatId, message.from);
      } else if (text === "/help") {
        await sendHelp(chatId, staffClubs.length ? "staff" : "client");
      } else if (staffClubs.length) {
        await handleStaffMessage(chatId, fromId, text, staffClubs);
      }
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }

  res.status(200).send("ok");
};

// /start <clubcode> — заводим человека в конкретный клуб и показываем его
// приветствие. Без кода (просто /start) — общий экран платформы.
async function handleStart(chatId, from, text) {
  const payload = text.length > 6 ? text.slice(6).trim() : "";
  const code = payload.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  const club = code ? await db.getClubByCode(code) : null;

  if (!club) {
    await sendMessage(
      chatId,
      "Это бот-рулетка для компьютерных клубов.\n\n" +
        "Чтобы крутить, откройте приложение по ссылке или QR-коду вашего клуба — " +
        "на ресепшене или в его сообществе."
    );
    return;
  }

  await db.ensureUser(club.id, from);

  const member = await db.getStaffMember(club.id, from.id);
  const role = member ? member.role : "client";
  await sendStart(chatId, club, from.first_name || "", role);

  const existing = await db.getUser(club.id, from.id);
  if (!existing || !existing.phone) await askPhone(chatId);
}

async function handleStaffMessage(chatId, staffId, text, staffClubs) {
  if (CODE_PATTERN.test(text)) {
    await redeemCode(chatId, text, staffId, staffClubs);
    return;
  }

  // Начисление прокрута идёт в клуб сотрудника. Если он сотрудник сразу
  // нескольких клубов — по боту не угадать, в какой; отправляем в кассу.
  if (staffClubs.length > 1) {
    const byCmd = ID_PATTERN.test(text) || USERNAME_PATTERN.test(text);
    if (byCmd) {
      await sendMessage(chatId, "Вы сотрудник нескольких клубов — начислите прокрут через кассу в приложении нужного клуба.");
      return;
    }
    await sendHelp(chatId, "staff");
    return;
  }

  const clubId = staffClubs[0].club_id;

  const byId = ID_PATTERN.exec(text);
  if (byId) {
    await grantSpin(chatId, clubId, Number(byId[1]), staffId, amountOf(byId[2]));
    return;
  }

  const byName = USERNAME_PATTERN.exec(text);
  if (byName) {
    const userId = await db.resolveUserIdByUsername(clubId, byName[1]);
    if (!userId) {
      await sendMessage(
        chatId,
        "Не нашёл клиента с юзернеймом " + byName[1] + " в вашем клубе.\n" +
          "Он должен хотя бы раз открыть рулетку клуба — либо используйте числовой ID (команда /id у клиента)."
      );
      return;
    }
    await grantSpin(chatId, clubId, userId, staffId, amountOf(byName[2]));
    return;
  }

  await sendHelp(chatId, "staff");
}

function amountOf(raw) {
  const n = Math.round(Number(raw));
  if (!isFinite(n) || n < 1) return 1;
  return Math.min(20, n);
}

async function grantSpin(chatId, clubId, userId, staffId, amount) {
  try {
    const existing = await db.getUser(clubId, userId);
    if (!existing) {
      await db.upsertUser(clubId, { id: userId, visits_available: 0 });
    }

    const left = await db.rpc("do_grant", {
      p_club_id: clubId,
      p_user_id: userId,
      p_staff_id: staffId,
      p_amount: amount
    });

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

async function redeemCode(chatId, code, staffId, staffClubs) {
  try {
    // Клуб определяем по самому коду, затем проверяем, что отправитель —
    // сотрудник именно этого клуба.
    const clubId = await db.clubOfCode(code);
    if (!clubId) {
      await sendMessage(chatId, "❌ Код " + code.toUpperCase() + " не найден.");
      return;
    }

    const allowed = staffClubs.some((s) => String(s.club_id) === String(clubId));
    if (!allowed) {
      await sendMessage(chatId, "Этот код относится к другому клубу — погасить его может только его сотрудник.");
      return;
    }

    const result = await db.rpc("do_redeem", {
      p_club_id: clubId,
      p_code: code.toUpperCase(),
      p_staff_id: staffId
    });

    if (result && result.ok) {
      await sendMessage(chatId, "✅ " + result.title + "\n\nКод погашен. Выдайте приз клиенту.");
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

// Контактом можно поделиться и чужим, поэтому принимаем только свой.
async function saveContact(message) {
  const contact = message.contact;

  if (!contact.user_id || contact.user_id !== message.from.id) {
    await sendMessage(message.chat.id, "Нужен ваш собственный номер — нажмите кнопку под полем ввода.");
    return;
  }

  try {
    // Телефон — свойство человека, а не клуба: пишем во все его карточки.
    await db.touchUserEverywhere(message.from.id, {
      username: message.from.username || null,
      first_name: message.from.first_name || null,
      phone: contact.phone_number,
      phone_at: new Date().toISOString(),
      can_message: true
    });

    await sendMessage(
      message.chat.id,
      "Спасибо! Номер сохранён — теперь сотрудник найдёт вас на стойке, даже если вы забудете телефон дома.",
      { remove_keyboard: true }
    );
  } catch (err) {
    console.error("saveContact error:", err);
  }
}

async function askPhone(chatId) {
  await sendMessage(
    chatId,
    "Ещё пара секунд: поделитесь номером телефона, чтобы сотрудник мог найти вас на стойке и вернуть приз, если что-то пойдёт не так. Это по желанию.",
    {
      keyboard: [[{ text: "📱 Поделиться номером", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  );
}

const DEFAULT_WELCOME =
  "Привет{name}!\n\n" +
  "Это рулетка нашего компьютерного клуба.\n\n" +
  "Отсканируй QR-код на ресепшене — прокрут откроется сам, сразу в приложении.\n" +
  "Выигрывай доп. время, скидки, снеки, напитки и VIP-места.\n\n" +
  "Призы забираются на стойке клуба: покажи код сотруднику.";

async function sendStart(chatId, club, firstName, role) {
  const settings = await db.getSettings(club.id);

  let text = (settings.welcome_text || DEFAULT_WELCOME)
    .replace("{name}", firstName ? ", " + firstName : "");

  if (role !== "client") {
    text += "\n\n———\nВы вошли как " + (role === "owner" ? "владелец" : "сотрудник") + ". Команды: /help";
  }

  // Кнопка открывает приложение с кодом клуба в URL — так мини-апп,
  // запущенный из чата (а не по startapp-ссылке), тоже знает свой клуб.
  const url = WEBAPP_URL + (WEBAPP_URL.indexOf("?") === -1 ? "?" : "&") + "club=" + club.code;
  const markup = { inline_keyboard: [[{ text: "Крутить 🎰", web_app: { url: url } }]] };

  if (settings.welcome_photo_file_id) {
    await sendPhoto(chatId, settings.welcome_photo_file_id, text, markup);
    return;
  }

  await sendMessage(chatId, text, markup);
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
      "Статистика, редактор призов и база клиентов — во вкладке «Админ» внутри приложения."
  );
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
