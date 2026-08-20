const db = require("./db");
const tg = require("./telegram");
const fmt = require("./fmt");

// Telegram не даёт слать больше ~30 сообщений в секунду на всех
// получателей сразу. 40 мс между отправками держат нас под лимитом
// и без ретраев, которые всё равно вышли бы дольше.
const PACE_MS = 40;

// Потолок на один запуск. Задача крутится раз в сутки, столько
// напоминаний за раз у клуба не наберётся, но лучше упереться в
// потолок и дослать в следующий раз, чем словить таймаут функции.
const MAX_PER_RUN = 200;

/* ---------------------------------------------------- напоминания */

// Одно напоминание на приз, за сутки до сгорания. Отметка ставится в
// базе тем же запросом, который отдаёт список, поэтому повторный запуск
// задачи не пришлёт клиенту второе сообщение.
async function runReminders() {
  const settings = await db.getSettings();
  const found = [];
  const results = [];
  let unreachable = [];

  while (found.length < MAX_PER_RUN) {
    const batch = await db.rpc("due_reminders", { p_limit: 50 });
    const items = (batch && batch.items) || [];
    if (!items.length) break;

    const grace = (batch && batch.graceMinutes) || 30;

    for (const item of items) {
      const res = await tg.sendMessage(
        item.userId,
        reminderText(item, grace, settings),
        tg.openAppMarkup("Показать код")
      );
      results.push(res);
      if (res.blocked) unreachable.push(item.userId);
      await tg.sleep(PACE_MS);
    }

    found.push.apply(found, items);
    if (items.length < 50) break;
  }

  if (unreachable.length) await db.setCanMessage(unreachable, false);

  const sent = results.filter((r) => r.ok).length;
  return { found: found.length, sent: sent, failed: results.length - sent };
}

function reminderText(item, grace, settings) {
  return (
    "⏳ Приз скоро сгорит\n\n" +
    "🎁 " + item.title + "\n" +
    "Код: " + item.code + "\n\n" +
    "Забрать можно до " + fmt.moment(item.expiresAt, settings.timezone) + ".\n" +
    "Мы добавили ещё " + grace + " минут к сроку, чтобы ты успел зайти.\n\n" +
    "Покажи код на стойке " + (settings.club_name || "клуба") + "."
  );
}

/* ---------------------------------------------------- рассылки */

// Одна партия рассылки. Вызывается столько раз, сколько нужно: панель
// владельца дёргает эндпоинт по кругу и рисует прогресс. Так отправка
// не упирается в лимит времени функции и переживает обрыв связи —
// список получателей помнит, кому уже ушло.
async function sendBroadcastBatch(broadcastId, size) {
  const batch = await db.rpc("next_broadcast_batch", {
    p_id: broadcastId,
    p_limit: Math.min(60, Math.max(1, size || 25))
  });

  if (!batch || batch.error) return { error: (batch && batch.error) || "not_found" };

  const ids = batch.userIds || [];
  if (!ids.length) {
    return await db.rpc("finish_broadcast_batch", { p_id: broadcastId, p_results: [] });
  }

  const results = [];
  const markup = tg.openAppMarkup("Открыть приложение");
  const photo = batch.photo || null;

  for (const userId of ids) {
    // Картинка уже лежит у Telegram: отправляем её по file_id, поэтому
    // рассылка на сотню человек не передаёт файл сотню раз.
    const res = photo
      ? await tg.sendPhoto(userId, photo, batch.text, markup)
      : await tg.sendMessage(userId, batch.text, markup);
    results.push({
      userId: String(userId),
      ok: res.ok,
      blocked: Boolean(res.blocked),
      error: res.ok ? null : String(res.error || "").slice(0, 200)
    });
    await tg.sleep(PACE_MS);
  }

  return await db.rpc("finish_broadcast_batch", { p_id: broadcastId, p_results: results });
}

module.exports = { runReminders, sendBroadcastBatch };
