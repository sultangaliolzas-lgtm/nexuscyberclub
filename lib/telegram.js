const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;

const API = "https://api.telegram.org/bot" + BOT_TOKEN;

// Кнопка, открывающая мини-апп прямо из сообщения. Без неё клиент,
// получив напоминание, должен искать приложение сам — а на этом шаге
// половина отваливается.
// Юзернейм бота меняется редко, а лямбда живёт между запросами, поэтому
// спрашиваем его у Telegram один раз и держим в памяти. Переменная
// окружения в приоритете: она экономит запрос на холодном старте, но её
// отсутствие ничего не ломает — раньше из-за этого ссылка на бота
// оказывалась пустой в одном месте и рабочей в другом.
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

function openAppMarkup(label) {
  if (!WEBAPP_URL) return undefined;
  return { inline_keyboard: [[{ text: label || "Открыть приложение", web_app: { url: WEBAPP_URL } }]] };
}

// В отличие от прежней версии внутри вебхука, эта возвращает результат,
// а не пишет ошибку в консоль и молчит. Рассылке обязательно знать,
// кому не дошло и почему: иначе счётчик доставки врёт, а клиент,
// закрывший переписку с ботом, каждый раз считается новой неудачей.
async function sendMessage(chatId, text, replyMarkup) {
  const payload = {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  let resp;
  try {
    resp = await request("sendMessage", payload);
  } catch (err) {
    // Сеть отвалилась — это не вина получателя, повторить можно.
    return { ok: false, blocked: false, error: String(err.message || err) };
  }

  if (resp.ok) return { ok: true, blocked: false };

  // 429 — мы уперлись в лимит Telegram, а не в проблему с адресатом.
  // Одна пауза по указанию самого Telegram обычно всё решает.
  if (resp.status === 429) {
    const wait = Math.min(3000, (resp.retryAfter || 1) * 1000);
    await sleep(wait);
    try {
      const retry = await request("sendMessage", payload);
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

module.exports = { sendMessage, openAppMarkup, botUsername, sleep };
