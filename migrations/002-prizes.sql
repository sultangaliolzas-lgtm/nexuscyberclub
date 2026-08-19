-- ============================================================
--  Новая экономика призов клуба Nexus
--  Выполнить один раз: Supabase -> SQL Editor -> New query -> Run
--
--  Включает и колонку description, если она ещё не добавлена.
-- ============================================================

alter table prizes add column if not exists description text;

-- Напиток и снек объединены в один приз. Старый "drink" выводим из игры,
-- но не удаляем: на него ссылается история уже выигранных призов.
update prizes set enabled = false, weight = 0 where key = 'drink';

insert into prizes (key, title, short_title, description, icon, tier, weight, expires_in_days, color, sort_order) values
  ('discount_10', 'Скидка 10% на визит',   'Скидка 10%',  'Скидка 10% на следующее посещение клуба', '🏷', 'COMMON', 30, 5, '#d4e84a',  1),
  ('kitchen_10',  'Скидка 10% на кухню',   'Кухня −10%',  'Скидка 10% на заказ с кухни',             '🍔', 'COMMON', 30, 5, '#ffa94d',  2),
  ('time_30',     '+30 минут игры',        '+30 мин',     'Полчаса игрового времени в подарок',      '⏱', 'COMMON', 20, 3, '#8be04e',  3),
  ('snack',       'Напиток или снек',      'Напиток/снек','Напиток или снек на выбор за счёт клуба', '🥤', 'COMMON', 15, 3, '#ff5c8a',  4),
  ('time_60',     '+1 час игры',           '+1 час',      'Час игрового времени в подарок',          '🕐', 'RARE',   12, 3, '#31d0ff',  5),
  ('discount_20', 'Скидка 20% на визит',   'Скидка 20%',  'Скидка 20% на следующее посещение клуба', '🔖', 'RARE',   10, 5, '#ffd23f',  6),
  ('kitchen_20',  'Скидка 20% на кухню',   'Кухня −20%',  'Скидка 20% на заказ с кухни',             '🍕', 'RARE',   10, 5, '#ff7a45',  7),
  ('vip_upgrade', 'VIP-место на час',      'VIP час',     'Час на VIP-месте без доплаты',            '💺', 'EPIC',    7, 2, '#00e0c0',  8),
  ('time_120',    '2 часа игры',           '2 часа',      'Два часа игрового времени в подарок',     '🔥', 'EPIC',    5, 2, '#b06bff',  9),
  ('kitchen_30',  'Скидка 30% на кухню',   'Кухня −30%',  'Скидка 30% на заказ с кухни',             '🍽', 'EPIC',    5, 3, '#ff5252', 10),
  ('nothing',     null,                    'Пусто',       'Не повезло — попробуй завтра',            '😔', null,      1, 0, '#33363f', 11)
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
  enabled         = true;

-- Реальные шансы: доля веса приза от суммы всех весов.
select
  icon || '  ' || coalesce(title, short_title)          as приз,
  weight                                                as вес,
  round(100.0 * weight / sum(weight) over (), 1) || '%' as шанс
from prizes
where enabled and weight > 0
order by weight desc, sort_order;
