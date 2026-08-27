const db = require("./db");
const tg = require("./telegram");
const fmt = require("./fmt");

// Telegram не даёт слать больше ~30 сообщений в секунду на всех
// получателей сразу. 40 мс между отправками держат нас под лимитом.
const PACE_MS = 40;

// Потолок на один запуск одного клуба.
const MAX_PER_RUN = 200;

/* ---------------------------------------------------- напоминания */

// Одно напоминание на приз, за сутки до сгорания. Отметка ставится в
// базе тем же запросом, который отдаёт список, поэтому повторный запуск
// не пришлёт клиенту второе сообщение.
//
// clubId задан — гоним напоминания только этого клуба (кнопка «сейчас» в
// кабинете). Без него (ежедневный крон) обходим все активные клубы.
async function runReminders(clubId) {
  if (clubId) return runRemindersForClub(clubId);

  const clubs = (await db.listActiveClubs()) || [];
  const totals = { clubs: clubs.length, found: 0, sent: 0, failed: 0 };

  for (const club of clubs) {
    const r = await runRemindersForClub(club.id);
    totals.found += r.found;
    totals.sent += r.sent;
    totals.failed += r.failed;
  }

  return totals;
}

async function runRemindersForClub(clubId) {
  const settings = await db.getSettings(clubId);
  const found = [];
  const results = [];
  const unreachable = [];

  while (found.length < MAX_PER_RUN) {
    const batch = await db.rpc("due_reminders", { p_club_id: clubId, p_limit: 50 });
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

  if (unreachable.length) await db.setCanMessage(clubId, unreachable, false);

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

// Одна партия рассылки клуба. Вызывается столько раз, сколько нужно:
// панель владельца дёргает эндпоинт по кругу и рисует прогресс.
async function sendBroadcastBatch(clubId, broadcastId, size) {
  const batch = await db.rpc("next_broadcast_batch", {
    p_club_id: clubId,
    p_id: broadcastId,
    p_limit: Math.min(60, Math.max(1, size || 25))
  });

  if (!batch || batch.error) return { error: (batch && batch.error) || "not_found" };

  const ids = batch.userIds || [];
  if (!ids.length) {
    return await db.rpc("finish_broadcast_batch", { p_club_id: clubId, p_id: broadcastId, p_results: [] });
  }

  const results = [];
  const markup = tg.openAppMarkup("Открыть приложение");
  const photo = batch.photo || null;

  for (const userId of ids) {
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

  return await db.rpc("finish_broadcast_batch", { p_club_id: clubId, p_id: broadcastId, p_results: results });
}

module.exports = { runReminders, sendBroadcastBatch };
