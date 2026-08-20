// Форматирование дат и денег для сообщений клиентам и сотрудникам.
// Вынесено отдельно, потому что нужно и напоминаниям, и броням, а
// главное — везде одинаково: сервер живёт в UTC, и без явного часового
// пояса «сегодня в 21:30» уехало бы на несколько часов.

const DEFAULT_TZ = "Asia/Almaty";

function moment(iso, timezone) {
  return format(iso, timezone, {
    day: "numeric", month: "long", hour: "2-digit", minute: "2-digit"
  });
}

function time(iso, timezone) {
  return format(iso, timezone, { hour: "2-digit", minute: "2-digit" });
}

function day(iso, timezone) {
  return format(iso, timezone, { day: "numeric", month: "long", weekday: "short" });
}

// "21 августа, пт · 18:00 — 21:00" — одна строка вместо двух дат,
// из которых сотруднику пришлось бы вычитать длительность в уме.
function range(fromIso, toIso, timezone) {
  return day(fromIso, timezone) + " · " + time(fromIso, timezone) + " — " + time(toIso, timezone);
}

function format(iso, timezone, options) {
  const date = new Date(iso);

  try {
    return new Intl.DateTimeFormat("ru-RU",
      Object.assign({ timeZone: timezone || DEFAULT_TZ }, options)).format(date);
  } catch (err) {
    // Неизвестный часовой пояс не должен ронять отправку сообщения.
    return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
}

// Разряды пробелами: 2100 читается хуже, чем 2 100, а на суммах в
// тенге разница становится критичной.
function money(value, currency) {
  const number = Number(value) || 0;
  const text = number.toFixed(number % 1 === 0 ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return text + " " + (currency || "₸");
}

module.exports = { moment, time, day, range, money, DEFAULT_TZ };
