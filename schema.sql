-- ============================================================
--  Nexus Roulette — схема базы данных
--  Выполнить в Supabase: Project -> SQL Editor -> New query -> Run
--
--  Скрипт идемпотентный: можно запускать сколько угодно раз,
--  существующие данные не теряются.
-- ============================================================


-- ------------------------------------------------------------
--  Клиенты
-- ------------------------------------------------------------

create table if not exists users (
  id bigint primary key,
  username text,
  first_name text,
  visits_available int not null default 0,
  created_at timestamptz not null default now()
);

-- новые колонки (для тех, у кого таблица уже создана первой версией)
alter table users add column if not exists last_checkin_at timestamptz;
alter table users add column if not exists visits_total int not null default 0;


-- ------------------------------------------------------------
--  Выигранные призы
-- ------------------------------------------------------------

create table if not exists inventory (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references users(id),
  prize_key text not null,
  title text not null,
  tier text not null,
  code text not null unique,
  status text not null default 'unused',      -- unused | redeemed
  won_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_by bigint
);

create index if not exists inventory_user_id_idx on inventory(user_id);
create index if not exists inventory_code_idx on inventory(code);
create index if not exists inventory_won_at_idx on inventory(won_at desc);
create index if not exists inventory_prize_key_idx on inventory(prize_key);


-- ------------------------------------------------------------
--  Призы. Владелец правит их из вкладки "Админ" — без деплоя.
--  weight  — относительный вес выпадения и одновременно
--            ширина сектора на колесе.
-- ------------------------------------------------------------

create table if not exists prizes (
  key text primary key,
  title text,                                  -- null у сектора "Пусто"
  short_title text,                            -- короткая подпись в секторе
  icon text,                                   -- эмодзи приза
  tier text,                                   -- COMMON | RARE | EPIC
  weight int not null default 0,
  expires_in_days int not null default 3,
  color text not null default '#a6ff2f',
  daily_limit int,                             -- null = без лимита
  enabled boolean not null default true,
  sort_order int not null default 0
);

-- Описание под названием на карточке ленты: короткое условие приза.
alter table prizes add column if not exists description text;

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
  ('nothing',     null,                    'Пусто',       'Не повезло — попробуй завтра',            '⬛', null,      1, 0, '#33363f', 11)
on conflict (key) do nothing;

-- Правки владельца из кабинета не затираются: on conflict do nothing.
-- Чтобы применить новую экономику к уже работающей базе, есть отдельный
-- разовый скрипт migrations/002-prizes.sql.


-- ------------------------------------------------------------
--  Настройки клуба (ровно одна строка)
-- ------------------------------------------------------------

create table if not exists settings (
  id int primary key default 1,
  club_name text not null default 'NEXUS',
  spin_cooldown_hours int not null default 24, -- как часто QR даёт новый прокрут
  checkin_enabled boolean not null default true,
  constraint settings_single_row check (id = 1)
);

insert into settings (id) values (1) on conflict (id) do nothing;


-- ------------------------------------------------------------
--  Персонал. role: owner видит вкладку "Админ", staff — только бот.
-- ------------------------------------------------------------

create table if not exists staff (
  id bigint primary key,
  role text not null default 'staff',          -- owner | staff
  title text,
  added_at timestamptz not null default now()
);

-- владелец клуба
insert into staff (id, role, title) values (420115296, 'owner', 'Владелец')
on conflict (id) do update set role = 'owner';


-- ------------------------------------------------------------
--  Лог событий: на нём строится вся статистика и разбор спорных
--  ситуаций (кто кому начислил прокрут, кто что погасил).
-- ------------------------------------------------------------

create table if not exists events (
  id bigserial primary key,
  type text not null,                          -- checkin | spin | redeem | grant
  user_id bigint,
  actor_id bigint,                             -- сотрудник, если действие его
  prize_key text,
  code text,
  source text,                                 -- метка QR-точки: r1, tables, flyer
  created_at timestamptz not null default now()
);

create index if not exists events_created_idx on events(created_at desc);
create index if not exists events_type_idx on events(type);
create index if not exists events_user_idx on events(user_id);


-- ============================================================
--  Функции
-- ============================================================

-- Сколько штук этого приза уже выдано с начала суток.
create or replace function prize_issued_today(p_key text)
returns int
language sql
stable
as $$
  select count(*)::int
    from inventory
   where prize_key = p_key
     and won_at >= date_trunc('day', now());
$$;


-- ------------------------------------------------------------
--  Прокрут рулетки — целиком одной транзакцией.
--
--  Почему в SQL, а не в Node: списание прокрута и выдача приза
--  должны быть атомарны. Если читать баланс, а потом писать его
--  из приложения, двойной тап по кнопке успевает пройти проверку
--  дважды и клиент получает два приза за один прокрут.
-- ------------------------------------------------------------

create or replace function do_spin(p_user_id bigint)
returns json
language plpgsql
as $$
declare
  v_left    int;
  v_total   int;
  v_roll    numeric;
  v_key     text;
  v_prize   prizes%rowtype;
  v_code    text;
  v_expires timestamptz;
  v_try     int := 0;
begin
  -- 1. Атомарно списываем один прокрут. Условие visits_available > 0
  --    проверяется той же командой, что и списывает, — гонки нет.
  update users
     set visits_available = visits_available - 1
   where id = p_user_id
     and visits_available > 0
  returning visits_available into v_left;

  if not found then
    return json_build_object('error', 'no_spins_available');
  end if;

  -- 2. Считаем суммарный вес призов, доступных прямо сейчас:
  --    включённых и не упёршихся в дневной лимит.
  select coalesce(sum(p.weight), 0) into v_total
    from prizes p
   where p.enabled
     and p.weight > 0
     and (p.daily_limit is null or prize_issued_today(p.key) < p.daily_limit);

  if v_total > 0 then
    -- Бросок делаем один раз в переменную: random() внутри запроса
    -- вычислялся бы заново для каждой строки и ломал распределение.
    v_roll := random() * v_total;

    select t.key into v_key
      from (
        select p.key,
               sum(p.weight) over (order by p.sort_order, p.key) as cum
          from prizes p
         where p.enabled
           and p.weight > 0
           and (p.daily_limit is null or prize_issued_today(p.key) < p.daily_limit)
      ) t
     where t.cum > v_roll
     order by t.cum
     limit 1;
  end if;

  -- 3. Пусто — записываем событие и выходим.
  if v_key is null or v_key = 'nothing' then
    insert into events (type, user_id, prize_key)
    values ('spin', p_user_id, coalesce(v_key, 'nothing'));

    return json_build_object(
      'prizeKey', coalesce(v_key, 'nothing'),
      'prize', null,
      'spinsLeft', v_left
    );
  end if;

  select * into v_prize from prizes where key = v_key;

  -- 4. Уникальный код приза. Коллизия почти невозможна, но если
  --    случится — просто пробуем ещё раз, а не роняем прокрут.
  loop
    v_try := v_try + 1;
    v_code := 'NX-' || upper(substr(md5(random()::text || clock_timestamp()::text || p_user_id::text), 1, 8));
    exit when not exists (select 1 from inventory where code = v_code) or v_try >= 5;
  end loop;

  -- Срок не меньше суток: приз с нулевым сроком родился бы уже сгоревшим.
  v_expires := now() + make_interval(days => greatest(v_prize.expires_in_days, 1));

  -- Название подстраховываем: в inventory оно not null, а владелец может
  -- случайно стереть поле в редакторе призов — прокрут падать не должен.
  insert into inventory (user_id, prize_key, title, tier, code, status, expires_at)
  values (
    p_user_id,
    v_prize.key,
    coalesce(v_prize.title, v_prize.short_title, v_prize.key),
    coalesce(v_prize.tier, 'COMMON'),
    v_code,
    'unused',
    v_expires
  );

  insert into events (type, user_id, prize_key, code)
  values ('spin', p_user_id, v_prize.key, v_code);

  return json_build_object(
    'prizeKey',  v_prize.key,
    'spinsLeft', v_left,
    'prize', json_build_object(
      'key',        v_prize.key,
      'title',      coalesce(v_prize.title, v_prize.short_title, v_prize.key),
      'shortTitle', v_prize.short_title,
      'icon',       v_prize.icon,
      'tier',       v_prize.tier,
      'color',      v_prize.color,
      'code',       v_code,
      'expiresAt',  v_expires
    )
  );
end;
$$;


-- ------------------------------------------------------------
--  Чек-ин по QR. Начисляет прокрут, если с прошлого раза прошёл
--  кулдаун. Условие проверяется внутри UPDATE, поэтому два скана
--  подряд не дадут двух прокрутов.
-- ------------------------------------------------------------

create or replace function do_checkin(p_user_id bigint, p_source text)
returns json
language plpgsql
as $$
declare
  v_cooldown int;
  v_enabled  boolean;
  v_spins    int;
  v_last     timestamptz;
begin
  select spin_cooldown_hours, checkin_enabled
    into v_cooldown, v_enabled
    from settings where id = 1;

  v_cooldown := coalesce(v_cooldown, 24);

  if not coalesce(v_enabled, true) then
    select visits_available into v_spins from users where id = p_user_id;
    return json_build_object('granted', false, 'reason', 'disabled', 'spinsAvailable', coalesce(v_spins, 0));
  end if;

  update users
     set visits_available = visits_available + 1,
         visits_total     = visits_total + 1,
         last_checkin_at  = now()
   where id = p_user_id
     and (last_checkin_at is null or last_checkin_at <= now() - make_interval(hours => v_cooldown))
  returning visits_available into v_spins;

  if found then
    insert into events (type, user_id, source) values ('checkin', p_user_id, p_source);
    return json_build_object('granted', true, 'spinsAvailable', v_spins);
  end if;

  select visits_available, last_checkin_at into v_spins, v_last
    from users where id = p_user_id;

  return json_build_object(
    'granted', false,
    'reason', 'cooldown',
    'spinsAvailable', coalesce(v_spins, 0),
    'nextAt', v_last + make_interval(hours => v_cooldown)
  );
end;
$$;


-- ------------------------------------------------------------
--  Погашение кода на стойке. Условие "ещё не погашен и не протух"
--  внутри UPDATE — два сотрудника не смогут погасить один код дважды.
-- ------------------------------------------------------------

create or replace function do_redeem(p_code text, p_staff_id bigint)
returns json
language plpgsql
as $$
declare
  v_item inventory%rowtype;
begin
  update inventory
     set status      = 'redeemed',
         redeemed_at = now(),
         redeemed_by = p_staff_id
   where upper(code) = upper(p_code)
     and status = 'unused'
     and expires_at > now()
  returning * into v_item;

  if found then
    insert into events (type, user_id, actor_id, prize_key, code)
    values ('redeem', v_item.user_id, p_staff_id, v_item.prize_key, v_item.code);

    return json_build_object('ok', true, 'title', v_item.title, 'tier', v_item.tier);
  end if;

  -- Не сработало — разбираемся, почему именно, чтобы сотрудник
  -- увидел внятную причину, а не общее "ошибка".
  select * into v_item from inventory where upper(code) = upper(p_code);

  if not found then
    return json_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_item.status = 'redeemed' then
    return json_build_object('ok', false, 'reason', 'already_redeemed', 'redeemedAt', v_item.redeemed_at);
  end if;

  return json_build_object('ok', false, 'reason', 'expired', 'expiresAt', v_item.expires_at);
end;
$$;


-- ------------------------------------------------------------
--  Начисление прокрута сотрудником вручную (запасной путь, если
--  клиент не смог отсканировать QR).
-- ------------------------------------------------------------

create or replace function do_grant(p_user_id bigint, p_staff_id bigint, p_amount int)
returns int
language plpgsql
as $$
declare
  v_left int;
begin
  update users
     set visits_available = visits_available + p_amount
   where id = p_user_id
  returning visits_available into v_left;

  if not found then
    return -1;
  end if;

  insert into events (type, user_id, actor_id, source)
  values ('grant', p_user_id, p_staff_id, 'manual');

  return v_left;
end;
$$;


-- ------------------------------------------------------------
--  Статистика для кабинета владельца.
--
--  Ключевая часть — воронка по каждому призу:
--    won         сколько раз выпал
--    redeemed    сколько забрали на стойке
--    outstanding сколько кодов живых и не погашенных (обязательства клуба)
--    expired     сколько сгорело невостребованными
--  Причём won = redeemed + outstanding + expired, цифры всегда сходятся.
-- ------------------------------------------------------------

create or replace function admin_stats(p_days int)
returns json
language plpgsql
stable
as $$
declare
  v_from        timestamptz := now() - make_interval(days => greatest(p_days, 1));
  v_prizes      json;
  v_summary     json;
  v_sources     json;
  v_outstanding json;
begin
  select coalesce(json_agg(row_to_json(t) order by t.sort_order), '[]'::json)
    into v_prizes
    from (
      select p.key, p.title, p.short_title, p.icon, p.tier, p.color, p.sort_order,
             (select count(*) from inventory i
               where i.prize_key = p.key and i.won_at >= v_from)::int as won,
             (select count(*) from inventory i
               where i.prize_key = p.key and i.won_at >= v_from
                 and i.status = 'redeemed')::int as redeemed,
             (select count(*) from inventory i
               where i.prize_key = p.key and i.won_at >= v_from
                 and i.status = 'unused' and i.expires_at > now())::int as outstanding,
             (select count(*) from inventory i
               where i.prize_key = p.key and i.won_at >= v_from
                 and i.status = 'unused' and i.expires_at <= now())::int as expired
        from prizes p
       where p.key <> 'nothing'
    ) t;

  select json_build_object(
    'spins',          (select count(*) from events where type = 'spin' and created_at >= v_from),
    'checkins',       (select count(*) from events where type = 'checkin' and created_at >= v_from),
    'emptySpins',     (select count(*) from events where type = 'spin' and prize_key = 'nothing' and created_at >= v_from),
    'prizesWon',      (select count(*) from inventory where won_at >= v_from),
    'redeemed',       (select count(*) from inventory where won_at >= v_from and status = 'redeemed'),
    'expired',        (select count(*) from inventory where won_at >= v_from and status = 'unused' and expires_at <= now()),
    'outstandingAll', (select count(*) from inventory where status = 'unused' and expires_at > now()),
    'uniqueClients',  (select count(distinct user_id) from events where type = 'spin' and created_at >= v_from),
    'newClients',     (select count(*) from users where created_at >= v_from),
    'totalClients',   (select count(*) from users),
    'spinsPending',   (select coalesce(sum(visits_available), 0) from users)
  ) into v_summary;

  select coalesce(json_agg(json_build_object('source', coalesce(s.source, '—'), 'count', s.c) order by s.c desc), '[]'::json)
    into v_sources
    from (
      select source, count(*)::int as c
        from events
       where type = 'checkin' and created_at >= v_from
       group by source
    ) s;

  select coalesce(json_agg(row_to_json(t) order by t.expires_at), '[]'::json)
    into v_outstanding
    from (
      select i.code, i.title, i.expires_at, i.prize_key,
             p.icon, u.first_name, u.username
        from inventory i
        join users u on u.id = i.user_id
        left join prizes p on p.key = i.prize_key
       where i.status = 'unused' and i.expires_at > now()
       order by i.expires_at
       limit 50
    ) t;

  return json_build_object(
    'summary',     v_summary,
    'prizes',      v_prizes,
    'sources',     v_sources,
    'outstanding', v_outstanding
  );
end;
$$;


-- ------------------------------------------------------------
--  База клиентов для кабинета владельца.
-- ------------------------------------------------------------

create or replace function admin_clients(p_limit int default 100)
returns json
language sql
stable
as $$
  select coalesce(json_agg(row_to_json(t) order by t.last_seen desc), '[]'::json)
    from (
      select u.id, u.first_name, u.username, u.visits_total, u.visits_available,
             u.created_at, u.last_checkin_at,
             coalesce(u.last_checkin_at, u.created_at) as last_seen,
             (select count(*) from inventory i where i.user_id = u.id)::int as won,
             (select count(*) from inventory i where i.user_id = u.id and i.status = 'redeemed')::int as redeemed
        from users u
       order by coalesce(u.last_checkin_at, u.created_at) desc
       limit p_limit
    ) t;
$$;


-- ------------------------------------------------------------
--  Лента последних действий персонала.
-- ------------------------------------------------------------

create or replace function admin_activity(p_limit int default 40)
returns json
language sql
stable
as $$
  select coalesce(json_agg(row_to_json(t) order by t.created_at desc), '[]'::json)
    from (
      select e.type, e.code, e.prize_key, e.source, e.created_at,
             e.user_id, e.actor_id,
             u.first_name as user_name, u.username as user_username,
             a.first_name as actor_name
        from events e
        left join users u on u.id = e.user_id
        left join users a on a.id = e.actor_id
       order by e.created_at desc
       limit p_limit
    ) t;
$$;


-- ============================================================
--  Доступ
--  RLS включён, политик нет: читать и писать может только наш
--  бэкенд с service_role ключом. Анонимный ключ не увидит ничего.
-- ============================================================

alter table users     enable row level security;
alter table inventory enable row level security;
alter table prizes    enable row level security;
alter table settings  enable row level security;
alter table staff     enable row level security;
alter table events    enable row level security;


-- PostgREST держит схему в кэше и не увидит новые функции, пока его
-- не пнуть. На Supabase это обычно происходит само, но лишним не будет.
notify pgrst, 'reload schema';
