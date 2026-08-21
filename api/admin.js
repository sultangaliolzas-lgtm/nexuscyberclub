const db = require("../lib/db");
const { requireOwner, methodGuard } = require("../lib/guard");
const { runReminders, sendBroadcastBatch } = require("../lib/notify");
const { uploadPhoto, setMenuButton, getMenuButton, removeKeyboard, CAPTION_LIMIT } = require("../lib/telegram");

// Весь кабинет владельца — одна serverless-функция с раздельными
// обработчиками. Держать по файлу на раздел было бы аккуратнее, но
// Vercel на бесплатном тарифе разрешает не больше 12 функций на деплой,
// и шесть файлов кабинета съедали половину лимита.
//
// Раздел выбирается параметром r: /api/admin?r=stats
const ROUTES = {
  stats:    { methods: ["GET"],                     handler: stats },
  prizes:   { methods: ["GET", "PATCH"],            handler: prizes },
  clients:  { methods: ["GET"],                     handler: clients },
  staff:    { methods: ["GET", "POST", "DELETE"],   handler: staff },
  settings: { methods: ["GET", "PATCH"],            handler: settings },
  grant:    { methods: ["POST"],                    handler: grant },
  block:    { methods: ["POST"],                    handler: block },
  log:      { methods: ["GET"],                     handler: log },
  remind:   { methods: ["POST"],                    handler: remind },
  broadcast:{ methods: ["GET", "POST", "PATCH"],    handler: broadcast },
  photo:    { methods: ["POST"],                    handler: photo },
  menu:     { methods: ["GET", "POST"],             handler: menu },
  keyboard: { methods: ["POST"],                    handler: keyboard },
  export:   { methods: ["POST"],                    handler: exportCsv }
};

module.exports = async function handler(req, res) {
  const key = String((req.query && req.query.r) || "");
  const route = Object.prototype.hasOwnProperty.call(ROUTES, key) ? ROUTES[key] : null;

  if (!route) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ error: "unknown_resource" });
    return;
  }

  if (!methodGuard(req, res, route.methods)) return;

  const auth = await requireOwner(req);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  try {
    await route.handler(req, res, auth);
  } catch (err) {
    console.error("admin " + key + " error:", err);

    // Текст ошибки виден только владельцу и экономит час гадания:
    // "internal_error" не отличает отсутствующую функцию в базе от
    // упавшего Telegram.
    res.status(500).json({
      error: "internal_error",
      reason: String(err.message || err).slice(0, 300)
    });
  }
};

/* ---------------------------------------------------------- отчёт */

// Всё считается одной SQL-функцией: воронка по каждому призу
// (выпал -> забрали -> висит на руках -> сгорел) плюс сводка за период.
// Десяток REST-запросов был бы и медленнее, и несогласован по времени среза.
async function stats(req, res) {
  const days = clampDays(req.query && req.query.days);
  const [data, activity] = await Promise.all([db.getStats(days), db.getActivity(30)]);
  res.status(200).json(Object.assign({ days: days }, data, { activity: activity }));
}

function clampDays(raw) {
  const n = Number(raw);
  if (n === 1 || n === 7 || n === 30 || n === 90) return n;
  return 7;
}

/* ---------------------------------------------------------- призы */

// Белый список полей нужен не для красоты: без него в PATCH можно
// передать любой столбец, включая key и effect, и разъехаться
// с историей в inventory и events.
const EDITABLE = {
  title: (v) => (v === null ? null : String(v).slice(0, 80)),
  description: (v) => (v === null ? null : String(v).slice(0, 120)),
  short_title: (v) => (v === null ? null : String(v).slice(0, 24)),
  icon: (v) => (v === null ? null : String(v).slice(0, 8)),
  tier: (v) => (v === null ? null : String(v).slice(0, 16)),
  weight: (v) => clampInt(v, 0, 1000),
  cost: (v) => clampMoney(v),
  expires_in_days: (v) => clampInt(v, 0, 365),
  color: (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v) : "#a6ff2f"),
  daily_limit: (v) => (v === null || v === "" ? null : clampInt(v, 0, 10000)),
  enabled: (v) => Boolean(v),
  sort_order: (v) => clampInt(v, 0, 999)
};

async function prizes(req, res, auth) {
  if (req.method === "GET") {
    res.status(200).json({ prizes: await db.getPrizes(false) });
    return;
  }

  const body = req.body || {};
  if (!body.key) {
    res.status(400).json({ error: "key_required" });
    return;
  }

  const patch = {};
  Object.keys(EDITABLE).forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      patch[field] = EDITABLE[field](body[field]);
    }
  });

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "nothing_to_update" });
    return;
  }

  // Прежние значения нужны для истории изменений: владельцу важно
  // видеть не только что поменяли, но и с чего.
  const before = (await db.getPrizes(false)).filter((p) => p.key === body.key)[0];

  const updated = await db.updatePrize(body.key, patch);
  if (!updated) {
    res.status(404).json({ error: "prize_not_found" });
    return;
  }

  await logChanges(auth.user.id, "prize", body.key, before, patch);
  res.status(200).json({ prize: updated });
}

// Пишем только то, что действительно изменилось: иначе журнал забьётся
// записями от нажатия "Сохранить" без правок.
async function logChanges(actorId, entity, key, before, patch) {
  const changes = {};

  Object.keys(patch).forEach((field) => {
    const was = before ? before[field] : null;
    if (String(was) !== String(patch[field])) {
      changes[field] = { from: was, to: patch[field] };
    }
  });

  if (Object.keys(changes).length === 0) return;

  try {
    await db.request("config_log", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify([{ actor_id: actorId, entity: entity, entity_key: key, changes: changes }])
    });
  } catch (err) {
    // Журнал не должен ронять сохранение настройки.
    console.error("config_log error:", err);
  }
}

function clampMoney(v) {
  const n = Number(v);
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(1000000, Math.round(n * 100) / 100);
}

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/* ---------------------------------------------------------- клиенты */

async function clients(req, res) {
  res.status(200).json({ clients: (await db.listClients(200)) || [] });
}

/* ---------------------------------------------------------- персонал */

async function staff(req, res, auth) {
  if (req.method === "GET") {
    res.status(200).json({ staff: (await db.listStaff()) || [] });
    return;
  }

  const body = req.body || {};
  // Тело у DELETE разбирается не везде одинаково, поэтому id
  // принимаем и из query — так запрос не зависит от прослойки.
  const id = Number(body.id || (req.query && req.query.id));

  if (!id || !isFinite(id)) {
    res.status(400).json({ error: "bad_id" });
    return;
  }

  if (req.method === "DELETE") {
    // Владелец не должен случайно снести сам себя и потерять доступ
    // к кабинету — вернуть его можно было бы только через SQL.
    if (id === Number(auth.user.id)) {
      res.status(400).json({ error: "cannot_remove_self" });
      return;
    }
    await db.removeStaff(id);
    res.status(200).json({ ok: true });
    return;
  }

  await db.addStaff(id, body.role === "owner" ? "owner" : "staff",
                    body.title ? String(body.title).slice(0, 40) : null);
  res.status(200).json({ ok: true });
}

/* ---------------------------------------------------------- настройки */

async function settings(req, res, auth) {
  if (req.method === "GET") {
    res.status(200).json({ settings: await db.getSettings() });
    return;
  }

  const body = req.body || {};
  const patch = {};

  if (body.club_name !== undefined) {
    patch.club_name = String(body.club_name).slice(0, 40) || "NEXUS";
  }
  if (body.spin_cooldown_hours !== undefined) {
    patch.spin_cooldown_hours = clampInt(body.spin_cooldown_hours, 0, 720);
  }
  if (body.max_unused_prizes !== undefined) {
    patch.max_unused_prizes = clampInt(body.max_unused_prizes, 0, 50);
  }
  if (body.checkin_enabled !== undefined) {
    patch.checkin_enabled = Boolean(body.checkin_enabled);
  }
  if (body.reminders_enabled !== undefined) {
    patch.reminders_enabled = Boolean(body.reminders_enabled);
  }
  if (body.reminder_hours !== undefined) {
    patch.reminder_hours = clampInt(body.reminder_hours, 1, 168);
  }
  if (body.reminder_grace_minutes !== undefined) {
    patch.reminder_grace_minutes = clampInt(body.reminder_grace_minutes, 0, 1440);
  }
  if (body.welcome_text !== undefined) {
    // Приветствие с картинкой уходит подписью, а подпись у Telegram
    // ограничена 1024 символами. Пустая строка означает «вернуть текст
    // по умолчанию», поэтому превращается в null, а не сохраняется.
    const welcome = String(body.welcome_text).trim().slice(0, CAPTION_LIMIT);
    patch.welcome_text = welcome || null;
  }
  if (body.welcome_photo_file_id !== undefined) {
    const photo = body.welcome_photo_file_id
      ? String(body.welcome_photo_file_id).slice(0, 200)
      : null;
    patch.welcome_photo_file_id = photo;
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "nothing_to_update" });
    return;
  }

  const before = await db.getSettings();
  const updated = await db.updateSettings(patch);
  await logChanges(auth.user.id, "settings", "club", before, patch);

  res.status(200).json({ settings: updated });
}

/* ---------------------------------------------------------- начисление */

// Ручное начисление: клиенту не удалось отсканировать QR, или владелец
// возвращает человека бонусом. Идёт через ту же функцию, что и у бота,
// поэтому попадает в ленту действий вместе с автором.
async function grant(req, res, auth) {
  const body = req.body || {};
  const userId = Number(body.userId);

  if (!userId || !isFinite(userId)) {
    res.status(400).json({ error: "bad_user_id" });
    return;
  }

  // Потолок в 20 штук за раз — защита от лишнего нуля в поле ввода.
  const amount = clampInt(body.amount || 1, 1, 20);

  if (!(await db.getUser(userId))) {
    res.status(404).json({ error: "client_not_found" });
    return;
  }

  const left = await db.rpc("do_grant", {
    p_user_id: userId,
    p_staff_id: auth.user.id,
    p_amount: amount
  });

  res.status(200).json({ ok: true, spinsAvailable: left, granted: amount });
}

/* ---------------------------------------------------------- блокировка */

// Заблокированный клиент не крутит и не получает чек-ины. Проверка живёт
// в SQL, поэтому её нельзя обойти, обратившись к API мимо приложения.
async function block(req, res, auth) {
  const body = req.body || {};
  const userId = Number(body.userId);

  if (!userId || !isFinite(userId)) {
    res.status(400).json({ error: "bad_user_id" });
    return;
  }

  if (userId === Number(auth.user.id)) {
    res.status(400).json({ error: "cannot_block_self" });
    return;
  }

  const result = await db.rpc("set_blocked", {
    p_user_id: userId,
    p_actor_id: auth.user.id,
    p_blocked: Boolean(body.blocked),
    p_reason: body.reason ? String(body.reason).slice(0, 120) : null
  });

  res.status(200).json(result);
}

/* ---------------------------------------------------------- история настроек */

async function log(req, res) {
  res.status(200).json({ log: (await db.rpc("admin_config_log", { p_limit: 60 })) || [] });
}

/* ---------------------------------------------------------- напоминания */

// Кнопка "отправить сейчас". Дёргает ровно ту же функцию, что и
// ежедневная задача: владельцу не нужно ждать до утра, чтобы убедиться,
// что напоминания вообще уходят.
async function remind(req, res) {
  const result = await runReminders();
  res.status(200).json(Object.assign({ ok: true }, result));
}

/* ---------------------------------------------------------- рассылки */

// Рассылка идёт партиями, а не одним запросом: Telegram не даёт слать
// больше тридцати сообщений в секунду, а функция на Vercel живёт
// ограниченное время. Панель создаёт рассылку (POST), а затем повторяет
// PATCH, пока не кончатся получатели, и рисует по ответам прогресс.
async function broadcast(req, res, auth) {
  if (req.method === "GET") {
    const [list, sizes, unreachable] = await Promise.all([
      db.rpc("list_broadcasts", { p_limit: 20 }),
      db.rpc("audience_sizes", {}),
      db.rpc("unreachable_clients", { p_limit: 60 })
    ]);

    res.status(200).json({
      broadcasts: list || [],
      audiences: sizes || {},
      unreachable: unreachable || []
    });
    return;
  }

  if (req.method === "POST") {
    const photoId = (req.body && req.body.photo) ? String(req.body.photo).slice(0, 200) : null;

    // С картинкой текст уходит подписью, а подпись у Telegram короче
    // сообщения вчетверо. 3500 вместо телеграмных 4096 — запас на
    // случай, если текст придётся дополнить служебной строкой.
    const limit = photoId ? CAPTION_LIMIT : 3500;
    const text = String((req.body && req.body.text) || "").trim().slice(0, limit);

    if (!text) {
      res.status(400).json({ error: "empty_text" });
      return;
    }

    const created = await db.rpc("create_broadcast", {
      p_text: text,
      p_actor: auth.user.id,
      p_audience: String((req.body && req.body.audience) || "all"),
      p_photo: photoId
    });

    if (created && created.error) {
      res.status(400).json(created);
      return;
    }

    res.status(200).json(created);
    return;
  }

  const id = Number((req.query && req.query.id) || (req.body && req.body.id));
  if (!id || !isFinite(id)) {
    res.status(400).json({ error: "bad_id" });
    return;
  }

  const progress = await sendBroadcastBatch(id, 25);
  if (progress && progress.error) {
    res.status(404).json(progress);
    return;
  }

  res.status(200).json(progress);
}

/* ---------------------------------------------------------- кнопка меню */

// Кнопка под полем ввода в чате с ботом настраивается один раз и живёт
// на стороне Telegram. Если её когда-то завели через BotFather со старым
// адресом, она будет открывать старую версию приложения даже после
// переезда — отсюда её можно переписать на текущий адрес или убрать.
async function menu(req, res, auth) {
  if (req.method === "GET") {
    // Спрашиваем и общее правило, и то, что видит лично владелец:
    // персональная настройка чата перекрывает общую, и расхождение
    // между ними — самая частая причина "нажал, а не поменялось".
    const [common, mine] = await Promise.all([
      getMenuButton(),
      getMenuButton(auth.user.id)
    ]);

    res.status(200).json({
      button: common.ok ? common.button : null,
      chatButton: mine.ok ? mine.button : null,
      error: common.ok ? null : common.error,
      webappUrl: process.env.WEBAPP_URL || null
    });
    return;
  }

  const enable = !(req.body && req.body.enabled === false);
  const url = process.env.WEBAPP_URL;

  if (enable && !url) {
    res.status(400).json({ error: "no_webapp_url" });
    return;
  }

  const result = await setMenuButton(enable ? url : null, "Крутить", auth.user.id);

  if (!result.ok) {
    res.status(502).json({ error: "telegram_error", reason: result.error });
    return;
  }

  // Возвращаем не то, что просили, а то, что Telegram теперь отдаёт:
  // это единственный ответ на вопрос "а точно применилось?".
  const [common, mine] = await Promise.all([
    getMenuButton(),
    getMenuButton(auth.user.id)
  ]);

  res.status(200).json({
    ok: true,
    enabled: enable,
    url: enable ? url : null,
    button: common.ok ? common.button : null,
    chatButton: mine.ok ? mine.button : null
  });
}

/* ------------------------------------------------------ нижняя клавиатура */

// Клавиатура под полем ввода — не то же самое, что кнопка меню. Её
// когда-то прислал бот, и она остаётся в чате навсегда, пока её явно не
// снимут. Адрес внутри такой кнопки заморожен на момент отправки,
// поэтому старая клавиатура открывает давно мёртвый деплой.
async function keyboard(req, res, auth) {
  const result = await removeKeyboard(auth.user.id, "Нижняя клавиатура убрана.");

  if (!result.ok) {
    res.status(502).json({ error: "telegram_error", reason: result.error });
    return;
  }

  res.status(200).json({ ok: true });
}

/* ---------------------------------------------------------- картинка */

// Картинка загружается один раз, до рассылки: Telegram возвращает
// file_id, и дальше сообщение уходит по нему, не передавая файл заново.
// Своё хранилище не нужно, а владелец заодно получает превью в чат и
// видит объявление ровно так, как его увидит клиент.
async function photo(req, res, auth) {
  const raw = String((req.body && req.body.data) || "");
  const match = /^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(raw);

  if (!match) {
    res.status(400).json({ error: "bad_image" });
    return;
  }

  const buffer = Buffer.from(match[1], "base64");

  // Приложение ужимает снимок перед отправкой, так что сюда должно
  // приходить несколько сотен килобайт. Проверка — на случай, если
  // запрос пришёл мимо приложения.
  if (!buffer.length || buffer.length > 4 * 1024 * 1024) {
    res.status(413).json({ error: "too_large" });
    return;
  }

  // Подпись превью зависит от того, куда картинка пойдёт: владелец
  // загружает и афиши рассылок, и баннер приветствия, и должен понимать,
  // что именно он сейчас увидел.
  const welcome = (req.body && req.body.kind) === "welcome";

  const result = await uploadPhoto(auth.user.id, buffer,
    welcome ? "welcome.jpg" : "broadcast.jpg",
    welcome ? "Так приветствие увидят новые клиенты" : "Так объявление увидят клиенты");

  if (!result.ok) {
    console.error("uploadPhoto failed:", result.error);

    // Превью уходит в личку владельцу, а бот не может писать первым
    // тому, кто с ним не переписывался. Это самая вероятная причина
    // отказа, и она лечится одной командой.
    const blocked = /blocked|chat not found|initiate/i.test(result.error || "");

    res.status(502).json({
      error: "upload_failed",
      reason: blocked
        ? "Бот не может прислать вам превью. Напишите ему /start и повторите"
        : "Telegram не принял картинку"
    });
    return;
  }

  res.status(200).json({ fileId: result.fileId });
}

/* ---------------------------------------------------------- выгрузка */

const EXPORT_COLUMNS = [
  ["won_at",      "Дата выигрыша"],
  ["title",       "Приз"],
  ["tier",        "Редкость"],
  ["cost",        "Себестоимость"],
  ["состояние",   "Состояние"],
  ["redeemed_at", "Дата выдачи"],
  ["expires_at",  "Сгорает"],
  ["code",        "Код"],
  ["client_id",   "ID клиента"],
  ["first_name",  "Имя"],
  ["username",    "Юзернейм"],
  ["phone",       "Телефон"]
];

// Файл уходит в чат бота, а не отдаётся ссылкой: мини-апп внутри
// Telegram не может сохранить файл на устройство, а присланный ботом
// документ открывается в Excel одним нажатием и остаётся в переписке.
async function exportCsv(req, res, auth) {
  const days = clampInt((req.query && req.query.days) || 30, 1, 365);
  const rows = (await db.rpc("admin_export", { p_days: days })) || [];

  if (!rows.length) {
    res.status(200).json({ ok: false, reason: "empty" });
    return;
  }

  const csv = toCsv(rows);
  const name = "nexus-" + days + "d-" + new Date().toISOString().slice(0, 10) + ".csv";
  const sent = await sendDocument(auth.user.id, name, csv, "Отчёт по призам за " + days + " дн. Строк: " + rows.length);

  res.status(200).json({ ok: sent, rows: rows.length, sent: sent });
}

function toCsv(rows) {
  const lines = [EXPORT_COLUMNS.map((c) => c[1]).join(";")];

  rows.forEach((row) => {
    lines.push(EXPORT_COLUMNS.map((c) => cell(row[c[0]])).join(";"));
  });

  // BOM обязателен: без него Excel читает файл в своей кодировке
  // и вместо кириллицы показывает мусор.
  return "﻿" + lines.join("\r\n");
}

function cell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).replace(/"/g, '""');
  return /[";\r\n]/.test(text) ? '"' + text + '"' : text;
}

async function sendDocument(chatId, filename, content, caption) {
  const token = process.env.BOT_TOKEN;
  if (!token) return false;

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("document", new Blob([content], { type: "text/csv" }), filename);

  const resp = await fetch("https://api.telegram.org/bot" + token + "/sendDocument", {
    method: "POST",
    body: form
  });

  if (!resp.ok) {
    console.error("sendDocument failed:", await resp.text());
    return false;
  }
  return true;
}
