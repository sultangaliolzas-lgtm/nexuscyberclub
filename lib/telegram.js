const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;

const API = "https://api.telegram.org/bot" + BOT_TOKEN;

// Подпись под фотографией у Telegram короче обычного сообщения: 1024
// символа против 4096. Клиенту это не объяснить, поэтому ограничение
// проверяется и в интерфейсе, и здесь.
const CAPTION_LIMIT = 1024;

// Юзернейм бота меняется редко, а лямбда живёт между запросами, поэтому
// спрашиваем его у Telegram один раз и держим в памяти. Переменная
// окружения в приоритете: она экономит запрос на холодном старте, но её
// отсутствие ничего не ломает.
let cachedUsername = process.env.BOT_USERNAME
  ? String(process.env.BOT_USERNAME).replace(/^@/, "")
  : null;

async function botUsername() {
  if (cachedUsername) return cachedUsername;
  if (!BOT_TOKEN) return null;

  try {
    const resp = await fetch(API + "/getMe");
    if (!resp.ok) return null;
    const data = await resp.json();
    cachedUsername = (data && data.result && data.result.username) || null;
    return cachedUsername;
  } catch (err) {
    console.error("getMe failed:", err);
    return null;
  }
}

// Кнопка, открывающая мини-апп прямо из сообщения. Без неё клиент,
// получив напоминание, должен искать приложение сам — а на этом шаге
// половина отваливается.
function openAppMarkup(label) {
  if (!WEBAPP_URL) return undefined;
  return { inline_keyboard: [[{ text: label || "Открыть приложение", web_app: { url: WEBAPP_URL } }]] };
}

// Кнопка меню бота — та самая панель под полем ввода. Она хранится на
// стороне Telegram и переживает любые деплои, поэтому адрес, вбитый туда
// когда-то через BotFather, продолжает открывать старую версию
// приложения ещё долго после переезда. Отсюда её можно переписать на
// текущий адрес или убрать совсем.
// Что за кнопка стоит прямо сейчас. Без этого настройка превращается в
// гадание: панель сообщает "готово", а в чате всё по-старому, и понять,
// кто врёт — Telegram, кэш клиента или наш запрос, — нечем.
// Убирает клавиатуру, залипшую под полем ввода. Отдельная операция:
// клавиатура и кнопка меню — разные сущности, и снятие одной никак не
// затрагивает другую.
function removeKeyboard(chatId, text) {
  return deliver("sendMessage", {
    chat_id: chatId,
    text: text || "Готово.",
    disable_web_page_preview: true
  }, { remove_keyboard: true });
}

async function getMenuButton(chatId) {
  try {
    const resp = await fetch(API + "/getChatMenuButton", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatId ? { chat_id: chatId } : {})
    });

    const body = await resp.json();
    if (!resp.ok || !body.ok) {
      return { ok: false, error: body.description || ("HTTP " + resp.status) };
    }

    return { ok: true, button: body.result || null };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function setMenuButton(url, label, chatId) {
  const menu = url
    ? { type: "web_app", text: label || "Открыть рулетку", web_app: { url: url } }
    : { type: "commands" };

  const result = await putMenuButton({ menu_button: menu });
  if (!result.ok) return result;

  // У кнопки есть два уровня: общий для всех и персональный для
  // конкретной переписки. Персональный перекрывает общий, и если он
  // когда-то был выставлен, правка общего ничего не изменит в этом чате.
  // Тип "default" снимает персональную настройку и возвращает чат к
  // общему правилу.
  if (chatId) await putMenuButton({ chat_id: chatId, menu_button: { type: "default" } });

  return { ok: true };
}

async function putMenuButton(payload) {
  try {
    const resp = await fetch(API + "/setChatMenuButton", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (resp.ok) return { ok: true };

    let body = {};
    try { body = await resp.json(); } catch (err) { body = {}; }
    return { ok: false, error: body.description || ("HTTP " + resp.status) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function sendMessage(chatId, text, replyMarkup) {
  return deliver("sendMessage", {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: true
  }, replyMarkup);
}

// Фотография отправляется по file_id, полученному при загрузке: файл
// уже лежит у Telegram, и рассылка на сотни человек не передаёт его
// заново ни разу.
function sendPhoto(chatId, fileId, caption, replyMarkup) {
  const payload = { chat_id: chatId, photo: fileId };
  if (caption) payload.caption = String(caption).slice(0, CAPTION_LIMIT);
  return deliver("sendPhoto", payload, replyMarkup);
}

// Заливает картинку в Telegram и возвращает её file_id. Отправляем её
// владельцу: он сразу видит объявление глазами клиента, а мы получаем
// идентификатор для рассылки. Своё хранилище файлов не нужно.
async function uploadPhoto(chatId, buffer, filename, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", String(caption).slice(0, CAPTION_LIMIT));
  form.append("photo", new Blob([buffer], { type: "image/jpeg" }), filename || "photo.jpg");

  let resp;
  try {
    resp = await fetch(API + "/sendPhoto", { method: "POST", body: form });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }

  if (!resp.ok) {
    let body = {};
    try { body = await resp.json(); } catch (err) { body = {}; }
    return { ok: false, error: body.description || ("HTTP " + resp.status) };
  }

  const data = await resp.json();
  const sizes = (data.result && data.result.photo) || [];

  // Telegram возвращает несколько размеров одной картинки; последний —
  // самый крупный, его file_id и рассылаем.
  const largest = sizes[sizes.length - 1];
  if (!largest) return { ok: false, error: "no_photo_in_response" };

  return { ok: true, fileId: largest.file_id };
}

// Возвращает результат, а не пишет ошибку в консоль и молчит. Рассылке
// обязательно знать, кому не дошло и почему: иначе счётчик доставки
// врёт, а клиент, закрывший переписку с ботом, каждый раз считается
// новой неудачей.
async function deliver(method, payload, replyMarkup) {
  if (replyMarkup) payload.reply_markup = replyMarkup;

  let resp;
  try {
    resp = await request(method, payload);
  } catch (err) {
    // Сеть отвалилась — это не вина получателя, повторить можно.
    return { ok: false, blocked: false, error: String(err.message || err) };
  }

  if (resp.ok) return { ok: true, blocked: false };

  // 429 — мы уперлись в лимит Telegram, а не в проблему с адресатом.
  // Одна пауза по указанию самого Telegram обычно всё решает.
  if (resp.status === 429) {
    await sleep(Math.min(3000, (resp.retryAfter || 1) * 1000));
    try {
      const retry = await request(method, payload);
      if (retry.ok) return { ok: true, blocked: false };
      return { ok: false, blocked: isPermanent(retry), error: retry.description };
    } catch (err) {
      return { ok: false, blocked: false, error: String(err.message || err) };
    }
  }

  return { ok: false, blocked: isPermanent(resp), error: resp.description };
}

async function request(method, payload) {
  const resp = await fetch(API + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (resp.ok) return { ok: true, status: 200 };

  let body = {};
  try {
    body = await resp.json();
  } catch (err) {
    body = {};
  }

  return {
    ok: false,
    status: resp.status,
    description: body.description || ("HTTP " + resp.status),
    retryAfter: body.parameters && body.parameters.retry_after
  };
}

// Отличаем "сейчас не получилось" от "больше никогда не получится".
// Второе означает, что клиента надо пометить как недостижимого, иначе
// каждая рассылка будет тратить на него попытку.
function isPermanent(resp) {
  if (resp.status === 403) return true;
  return /chat not found|user is deactivated|bot can't initiate|blocked by the user/i.test(resp.description || "");
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

module.exports = {
  sendMessage,
  sendPhoto,
  uploadPhoto,
  openAppMarkup,
  setMenuButton,
  getMenuButton,
  removeKeyboard,
  botUsername,
  sleep,
  CAPTION_LIMIT
};
