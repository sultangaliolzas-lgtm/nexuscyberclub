-- ============================================================
--  Новая таблица призов клуба Nexus
--  Выполнять ПОСЛЕ schema.sql (там добавляются колонки effect,
--  bonus_next_checkin и max_unused_prizes).
--
--  Supabase -> SQL Editor -> New query -> Run
-- ============================================================

-- Призы, которых нет в новом списке, выводим из игры, но не удаляем:
-- на них ссылается история уже выигранных призов и отчёт.
update prizes
   set enabled = false, weight = 0
 where key in ('kitchen_10', 'kitchen_20', 'kitchen_30', 'nothing');

insert into prizes (key, title, short_title, description, icon, tier, weight, expires_in_days, color, sort_order, effect) values
  ('time_30',     '+30 минут игры',      '+30 мин',   'Полчаса игрового времени в подарок',              '⏱', 'COMMON', 25, 3, '#8be04e',  1, 'item'),
  ('drink',       'Напиток в подарок',   'Напиток',   'Напиток на выбор за счёт клуба',                  '🥤', 'COMMON', 20, 3, '#ff5c8a',  2, 'item'),
  ('snack',       'Снек в подарок',      'Снек',      'Снек на выбор за счёт клуба',                     '🍿', 'COMMON', 15, 3, '#ffb02e',  3, 'item'),
  ('discount_10', 'Скидка 10% на визит', 'Скидка 10%','Скидка 10% на следующее посещение клуба',         '🏷', 'COMMON', 15, 5, '#d4e84a',  4, 'item'),
  ('time_60',     '+1 час игры',         '+1 час',    'Час игрового времени в подарок',                  '🕐', 'RARE',   12, 3, '#31d0ff',  5, 'item'),
  ('discount_20', 'Скидка 20% на визит', 'Скидка 20%','Скидка 20% на следующее посещение клуба',         '🔖', 'RARE',    6, 5, '#ffd23f',  6, 'item'),
  ('vip_upgrade', 'VIP-место на час',    'VIP час',   'Час на VIP-месте без доплаты',                    '💺', 'RARE',    5, 2, '#00e0c0',  7, 'item'),
  ('time_120',    '2 часа игры',         '2 часа',    'Два часа игрового времени в подарок',             '🔥', 'EPIC',    5, 2, '#ff4d4d',  8, 'item'),
  ('bonus_x2',    'Х2 бонус на завтра',  'Х2 завтра', 'Следующий визит даст два прокрута вместо одного', '⚡', 'RARE',    4, 1, '#c56bff',  9, 'bonus_next'),
  ('respin',      'Крути ещё раз',       'Ещё раз',   'Прокрут возвращается — крути сразу снова',        '🔄', 'EPIC',    3, 1, '#a6ff2f', 10, 'respin')
on conflict (key) do update set
  title           = excluded.title,
  short_title     = excluded.short_title,
  description     = excluded.description,
  icon            = excluded.icon,
  tier            = excluded.tier,
  weight          = excluded.weight,
  expires_in_days = excluded.expires_in_days,
  color           = excluded.color,
  sort_order      = excluded.sort_order,
  effect          = excluded.effect,
  enabled         = true;

-- Кап на неиспользованные призы: 0 снимает ограничение.
update settings set max_unused_prizes = 5 where id = 1;

-- Реальные шансы: доля веса приза от суммы всех весов.
select
  icon || '  ' || coalesce(title, short_title)          as приз,
  tier                                                  as редкость,
  weight                                                as вес,
  round(100.0 * weight / sum(weight) over (), 1) || '%' as шанс
from prizes
where enabled and weight > 0
order by weight desc, sort_order;
