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

-- Приз "Х2 бонус на завтра" не выдаёт предмет, а запоминается здесь и
-- срабатывает при следующем чек-ине.
alter table users add column if not exists bonus_next_checkin int not null default 0;

-- Телефон Telegram в initData не отдаёт: его можно получить, только если
-- клиент сам нажмёт "Поделиться номером" в боте. Поэтому колонка
-- заполняется не всегда.
alter table users add column if not exists phone text;
alter table users add column if not exists phone_at timestamptz;

-- Блокировка: заблокированный клиент не получает чек-ины и не крутит.
alter table users add column if not exists blocked boolean not null default false;
alter table users add column if not exists blocked_reason text;


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

-- Что делает приз: item — обычный предмет с кодом, respin — сразу
-- возвращает прокрут, bonus_next — удваивает следующий чек-ин.
-- Эффекты не создают предмет: гасить на стойке нечего.
alter table prizes add column if not exists effect text not null default 'item';

-- Себестоимость одной выдачи в валюте клуба. Для скидок это
-- недополученная выручка — владелец оценивает сам.
alter table prizes add column if not exists cost numeric(10,2) not null default 0;

insert into prizes (key, title, short_title, description, icon, tier, weight, expires_in_days, color, sort_order, effect, cost) values
  ('time_30',     '+30 минут игры',      '+30 мин',   'Полчаса игрового времени в подарок',              '⏱', 'COMMON', 25, 3, '#8be04e',  1, 'item',       0),
  ('drink',       'Напиток в подарок',   'Напиток',   'Напиток на выбор за счёт клуба',                  '🥤', 'COMMON', 20, 3, '#ff5c8a',  2, 'item',       0),
  ('snack',       'Снек в подарок',      'Снек',      'Снек на выбор за счёт клуба',                     '🍿', 'COMMON', 15, 3, '#ffb02e',  3, 'item',       0),
  ('discount_10', 'Скидка 10% на визит', 'Скидка 10%','Скидка 10% на следующее посещение клуба',         '🏷', 'COMMON', 15, 5, '#d4e84a',  4, 'item',       0),
  ('time_60',     '+1 час игры',         '+1 час',    'Час игрового времени в подарок',                  '🕐', 'RARE',   12, 3, '#31d0ff',  5, 'item',       0),
  ('discount_20', 'Скидка 20% на визит', 'Скидка 20%','Скидка 20% на следующее посещение клуба',         '🔖', 'RARE',    6, 5, '#ffd23f',  6, 'item',       0),
  ('vip_upgrade', 'VIP-место на час',    'VIP час',   'Час на VIP-месте без доплаты',                    '💺', 'RARE',    5, 2, '#00e0c0',  7, 'item',       0),
  ('time_120',    '2 часа игры',         '2 часа',    'Два часа игрового времени в подарок',             '🔥', 'EPIC',    5, 2, '#ff4d4d',  8, 'item',       0),
  ('bonus_x2',    'Х2 бонус на завтра',  'Х2 завтра', 'Следующий визит даст два прокрута вместо одного', '⚡', 'RARE',    4, 1, '#c56bff',  9, 'bonus_next', 0),
  ('respin',      'Крути ещё раз',       'Ещё раз',   'Прокрут возвращается — крути сразу снова',        '🔄', 'EPIC',    3, 1, '#a6ff2f', 10, 'respin',     0)
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
  max_unused_prizes int not null default 5,    -- 0 = без ограничения
  constraint settings_single_row check (id = 1)
);

insert into settings (id) values (1) on conflict (id) do nothing;

alter table settings add column if not exists max_unused_prizes int not null default 5;
alter table settings add column if not exists currency text not null default '₸';

-- Часовой пояс клуба. Используется при форматировании времени в
-- сообщениях клиентам: "успей до 21:30" должно означать 21:30 по
-- местному времени, а не по UTC.
alter table settings add column if not exists timezone text not null default 'Asia/Almaty';


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


-- ------------------------------------------------------------
--  История изменений настроек: кто, когда и что менял.
--  Отдельно от events, потому что здесь важны прежние значения,
--  а не сам факт события.
-- ------------------------------------------------------------

create table if not exists config_log (
  id bigserial primary key,
  actor_id bigint,
  entity text not null,          -- prize | settings
  entity_key text,
  changes jsonb not null,        -- {поле: {from: ..., to: ...}}
  created_at timestamptz not null default now()
);

create index if not exists config_log_created_idx on config_log(created_at desc);


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
  v_cap     int;
  v_held    int;
begin
  -- 0. Заблокированный клиент не крутит. Проверка здесь, а не в Node:
  --    так её нельзя обойти, зайдя мимо приложения.
  if (select blocked from users where id = p_user_id) then
    return json_build_object('error', 'blocked');
  end if;

  -- 1. Кап на неиспользованные призы. Пока клиент не заберёт своё,
  --    новые не выдаём — иначе призы копятся и сгорают пачками, а повод
  --    прийти в клуб теряется. Проверяем ДО списания, чтобы прокрут
  --    не пропал впустую.
  select max_unused_prizes into v_cap from settings where id = 1;
  v_cap := coalesce(v_cap, 5);

  if v_cap > 0 then
    select count(*) into v_held
      from inventory
     where user_id = p_user_id
       and status = 'unused'
       and expires_at > now();

    if v_held >= v_cap then
      return json_build_object('error', 'inventory_full', 'cap', v_cap, 'held', v_held);
    end if;
  end if;

  -- 2. Атомарно списываем один прокрут. Условие visits_available > 0
  --    проверяется той же командой, что и списывает, — гонки нет.
  update users
     set visits_available = visits_available - 1
   where id = p_user_id
     and visits_available > 0
  returning visits_available into v_left;

  if not found then
    return json_build_object('error', 'no_spins_available');
  end if;

  -- 3. Считаем суммарный вес призов, доступных прямо сейчас:
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

  -- 4. Пусто — записываем событие и выходим.
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

  -- 5. Мгновенные эффекты. Предмет не создаётся: гасить на стойке нечего,
  --    приз срабатывает сразу здесь.
  if v_prize.effect = 'respin' then
    update users set visits_available = visits_available + 1
     where id = p_user_id
    returning visits_available into v_left;

    insert into events (type, user_id, prize_key) values ('spin', p_user_id, v_prize.key);

    return json_build_object(
      'prizeKey',  v_prize.key,
      'effect',    'respin',
      'spinsLeft', v_left,
      'prize', json_build_object(
        'key',   v_prize.key,
        'title', coalesce(v_prize.title, v_prize.short_title, v_prize.key),
        'icon',  v_prize.icon,
        'tier',  v_prize.tier,
        'color', v_prize.color,
        'code',  null
      )
    );
  end if;

  if v_prize.effect = 'bonus_next' then
    update users set bonus_next_checkin = 1 where id = p_user_id;

    insert into events (type, user_id, prize_key) values ('spin', p_user_id, v_prize.key);

    return json_build_object(
      'prizeKey',  v_prize.key,
      'effect',    'bonus_next',
      'spinsLeft', v_left,
      'prize', json_build_object(
        'key',   v_prize.key,
        'title', coalesce(v_prize.title, v_prize.short_title, v_prize.key),
        'icon',  v_prize.icon,
        'tier',  v_prize.tier,
        'color', v_prize.color,
        'code',  null
      )
    );
  end if;

  -- 6. Обычный приз: уникальный код. Коллизия почти невозможна, но если
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
    'effect',    'item',
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
  v_bonus    int;
begin
  select spin_cooldown_hours, checkin_enabled
    into v_cooldown, v_enabled
    from settings where id = 1;

  v_cooldown := coalesce(v_cooldown, 24);

  if (select blocked from users where id = p_user_id) then
    return json_build_object('granted', false, 'reason', 'blocked', 'spinsAvailable', 0);
  end if;

  if not coalesce(v_enabled, true) then
    select visits_available into v_spins from users where id = p_user_id;
    return json_build_object('granted', false, 'reason', 'disabled', 'spinsAvailable', coalesce(v_spins, 0));
  end if;

  -- Бонус читаем заранее: в UPDATE его нужно и прибавить, и обнулить,
  -- а старое значение оттуда уже не достать.
  select coalesce(bonus_next_checkin, 0) into v_bonus from users where id = p_user_id;

  update users
     set visits_available   = visits_available + 1 + coalesce(v_bonus, 0),
         visits_total       = visits_total + 1,
         last_checkin_at    = now(),
         bonus_next_checkin = 0
   where id = p_user_id
     and (last_checkin_at is null or last_checkin_at <= now() - make_interval(hours => v_cooldown))
  returning visits_available into v_spins;

  if found then
    insert into events (type, user_id, source) values ('checkin', p_user_id, p_source);
    return json_build_object(
      'granted', true,
      'spinsAvailable', v_spins,
      'bonus', coalesce(v_bonus, 0) > 0
    );
  end if;

  -- Кулдаун не прошёл: бонус остался нетронутым, UPDATE не сработал.
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
  v_item   inventory%rowtype;
  v_client text;
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

    -- Сотруднику важно видеть, чей это приз: сверить с тем, кто стоит
    -- перед ним, и не выдать чужой выигрыш по пересланному скриншоту.
    select coalesce(u.first_name, '@' || u.username, u.id::text)
      into v_client
      from users u where u.id = v_item.user_id;

    return json_build_object(
      'ok', true,
      'title', v_item.title,
      'tier', v_item.tier,
      'client', v_client,
      'clientId', v_item.user_id,
      'wonAt', v_item.won_at
    );
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
--  Предпросмотр кода для кассы: что это за приз, чей он и годен ли.
--  Ничего не меняет — сотрудник сначала видит, потом решает.
-- ------------------------------------------------------------

create or replace function peek_code(p_code text)
returns json
language plpgsql
stable
as $$
declare
  v_item   inventory%rowtype;
  v_client text;
  v_status text;
begin
  select * into v_item from inventory where upper(code) = upper(p_code);

  if not found then
    return json_build_object('found', false, 'reason', 'not_found');
  end if;

  select coalesce(u.first_name, '@' || u.username, u.id::text)
    into v_client
    from users u where u.id = v_item.user_id;

  if v_item.status = 'redeemed' then
    v_status := 'already_redeemed';
  elsif v_item.expires_at <= now() then
    v_status := 'expired';
  else
    v_status := 'ok';
  end if;

  return json_build_object(
    'found', true,
    'status', v_status,
    'title', v_item.title,
    'tier', v_item.tier,
    'code', v_item.code,
    'client', v_client,
    'clientId', v_item.user_id,
    'wonAt', v_item.won_at,
    'expiresAt', v_item.expires_at,
    'redeemedAt', v_item.redeemed_at
  );
end;
$$;


-- ------------------------------------------------------------
--  Прокруты и чек-ины по дням — для графика на главной кабинета.
-- ------------------------------------------------------------

create or replace function admin_daily(p_days int)
returns json
language sql
stable
as $$
  select coalesce(json_agg(row_to_json(t) order by t.day), '[]'::json)
    from (
      select d::date as day,
             (select count(*) from events e
               where e.type = 'spin' and e.created_at >= d and e.created_at < d + interval '1 day')::int as spins,
             (select count(*) from events e
               where e.type = 'checkin' and e.created_at >= d and e.created_at < d + interval '1 day')::int as checkins,
             (select count(*) from users u
               where u.created_at >= d and u.created_at < d + interval '1 day')::int as newcomers
        from generate_series(
               date_trunc('day', now()) - make_interval(days => greatest(p_days, 1) - 1),
               date_trunc('day', now()),
               interval '1 day'
             ) d
    ) t;
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

-- Метрики за произвольный отрезок. Вынесено отдельной функцией, чтобы
-- тем же кодом посчитать текущий период и предыдущий для сравнения.
create or replace function period_summary(p_from timestamptz, p_to timestamptz)
returns json
language sql
stable
as $$
  select json_build_object(
    'spins',         (select count(*) from events where type = 'spin' and created_at >= p_from and created_at < p_to),
    'checkins',      (select count(*) from events where type = 'checkin' and created_at >= p_from and created_at < p_to),
    'emptySpins',    (select count(*) from events where type = 'spin' and prize_key = 'nothing' and created_at >= p_from and created_at < p_to),
    'prizesWon',     (select count(*) from inventory where won_at >= p_from and won_at < p_to),
    'redeemed',      (select count(*) from inventory where won_at >= p_from and won_at < p_to and status = 'redeemed'),
    'expired',       (select count(*) from inventory where won_at >= p_from and won_at < p_to and status = 'unused' and expires_at <= now()),
    'uniqueClients', (select count(distinct user_id) from events where type = 'spin' and created_at >= p_from and created_at < p_to),
    'newClients',    (select count(*) from users where created_at >= p_from and created_at < p_to),
    'totalClients',  (select count(*) from users),
    'spinsPending',  (select coalesce(sum(visits_available), 0) from users),
    -- Потрачено — по факту выдачи приза на стойке, а не по выигрышу.
    'spent',         (select coalesce(sum(p.cost), 0)::numeric(12,2) from inventory i
                        join prizes p on p.key = i.prize_key
                       where i.status = 'redeemed' and i.redeemed_at >= p_from and i.redeemed_at < p_to)
  );
$$;


create or replace function admin_stats(p_days int)
returns json
language plpgsql
stable
as $$
declare
  v_days        int         := greatest(p_days, 1);
  v_from        timestamptz := now() - make_interval(days => v_days);
  v_prev_from   timestamptz := now() - make_interval(days => v_days * 2);
  v_today       timestamptz := date_trunc('day', now());
  v_currency    text;
  v_prizes      json;
  v_summary     json;
  v_previous    json;
  v_sources     json;
  v_outstanding json;
begin
  select currency into v_currency from settings where id = 1;

  -- Воронка приза: выпал -> забрали -> висит на руках -> сгорел.
  -- Цифры сходятся: выпал = забрали + на руках + сгорел.
  select coalesce(json_agg(row_to_json(t) order by t.sort_order), '[]'::json)
    into v_prizes
    from (
      select p.key, p.title, p.short_title, p.icon, p.tier, p.color, p.sort_order, p.cost,
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
                 and i.status = 'unused' and i.expires_at <= now())::int as expired,
             -- Реальные деньги — только по забранным призам.
             (p.cost * (select count(*) from inventory i
               where i.prize_key = p.key and i.status = 'redeemed'
                 and i.redeemed_at >= v_from))::numeric(12,2) as spent
        from prizes p
       where p.key <> 'nothing'
    ) t;

  v_summary := period_summary(v_from, now());
  v_previous := period_summary(v_prev_from, v_from);

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
    'currency',    coalesce(v_currency, '₸'),
    'summary',     v_summary,
    'previous',    v_previous,
    'prizes',      v_prizes,
    'sources',     v_sources,
    'outstanding', v_outstanding,
    'daily',       admin_daily(7),
    -- Обязательства и траты за сегодня считаются вне периода:
    -- владельцу они нужны как есть, а не за выбранный отрезок.
    'today', json_build_object(
      'spins',    (select count(*) from events where type = 'spin' and created_at >= v_today),
      'checkins', (select count(*) from events where type = 'checkin' and created_at >= v_today),
      'newcomers',(select count(*) from users where created_at >= v_today),
      'spent',    (select coalesce(sum(p.cost), 0)::numeric(12,2) from inventory i
                     join prizes p on p.key = i.prize_key
                    where i.status = 'redeemed' and i.redeemed_at >= v_today)
    ),
    'liability', json_build_object(
      'count', (select count(*) from inventory where status = 'unused' and expires_at > now()),
      'cost',  (select coalesce(sum(p.cost), 0)::numeric(12,2) from inventory i
                  join prizes p on p.key = i.prize_key
                 where i.status = 'unused' and i.expires_at > now())
    )
  );
end;
$$;


-- ------------------------------------------------------------
--  База клиентов для кабинета владельца.
-- ------------------------------------------------------------

create or replace function admin_clients(p_limit int default 200)
returns json
language sql
stable
as $$
  select coalesce(json_agg(row_to_json(t) order by t.last_seen desc), '[]'::json)
    from (
      select u.id, u.first_name, u.username, u.phone, u.blocked, u.blocked_reason,
             u.visits_total, u.visits_available, u.created_at, u.last_checkin_at,
             coalesce(u.last_checkin_at, u.created_at) as last_seen,
             (select count(*) from inventory i where i.user_id = u.id)::int as won,
             (select count(*) from inventory i where i.user_id = u.id and i.status = 'redeemed')::int as redeemed,
             (select count(*) from inventory i
               where i.user_id = u.id and i.status = 'unused' and i.expires_at > now())::int as holding
        from users u
       order by coalesce(u.last_checkin_at, u.created_at) desc
       limit p_limit
    ) t;
$$;


-- ------------------------------------------------------------
--  Блокировка клиента. Заблокированный не получает чек-ины и не крутит,
--  но его история и выданные призы остаются на месте.
-- ------------------------------------------------------------

create or replace function set_blocked(p_user_id bigint, p_actor_id bigint, p_blocked boolean, p_reason text)
returns json
language plpgsql
as $$
declare
  v_blocked boolean;
begin
  update users
     set blocked = p_blocked,
         blocked_reason = case when p_blocked then p_reason else null end
   where id = p_user_id
  returning blocked into v_blocked;

  if not found then
    return json_build_object('ok', false, 'reason', 'not_found');
  end if;

  insert into config_log (actor_id, entity, entity_key, changes)
  values (p_actor_id, 'client', p_user_id::text,
          json_build_object('blocked', json_build_object('to', p_blocked, 'reason', p_reason))::jsonb);

  return json_build_object('ok', true, 'blocked', v_blocked);
end;
$$;


-- ------------------------------------------------------------
--  Выгрузка призов за период — сырьё для CSV-отчёта.
-- ------------------------------------------------------------

create or replace function admin_export(p_days int)
returns json
language sql
stable
as $$
  select coalesce(json_agg(row_to_json(t) order by t.won_at desc), '[]'::json)
    from (
      select i.won_at, i.redeemed_at, i.expires_at, i.code, i.title, i.tier,
             i.prize_key, i.status, p.cost,
             u.id as client_id, u.first_name, u.username, u.phone,
             case
               when i.status = 'redeemed'            then 'забран'
               when i.expires_at <= now()            then 'сгорел'
               else                                       'на руках'
             end as состояние
        from inventory i
        join users u on u.id = i.user_id
        left join prizes p on p.key = i.prize_key
       where i.won_at >= now() - make_interval(days => greatest(p_days, 1))
    ) t;
$$;


-- ------------------------------------------------------------
--  История изменений настроек: кто и что менял.
-- ------------------------------------------------------------

create or replace function admin_config_log(p_limit int default 40)
returns json
language sql
stable
as $$
  select coalesce(json_agg(row_to_json(t) order by t.created_at desc), '[]'::json)
    from (
      select c.entity, c.entity_key, c.changes, c.created_at,
             coalesce(a.first_name, '@' || a.username, c.actor_id::text) as actor
        from config_log c
        left join users a on a.id = c.actor_id
       order by c.created_at desc
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
alter table events     enable row level security;
alter table config_log enable row level security;


-- PostgREST держит схему в кэше и не увидит новые функции, пока его
-- не пнуть. На Supabase это обычно происходит само, но лишним не будет.
notify pgrst, 'reload schema';


-- ============================================================
--  Уведомления клиентам
-- ============================================================

-- Бот не может написать первым тому, кто не разрешил ему переписку.
-- Мини-апп, открытый по ссылке t.me/bot?startapp=..., такого разрешения
-- сам по себе не даёт. Флаг приходит в подписанной initData как
-- allows_write_to_pm и выставляется в true, когда клиент жмёт /start.
alter table users add column if not exists can_message boolean not null default false;

-- Отметка о том, что напоминание по этому призу уже уходило. Нужна
-- именно в inventory, а не в отдельной таблице: одно напоминание на
-- приз, и повтор невозможен даже при двойном запуске задачи.
alter table inventory add column if not exists reminded_at timestamptz;

-- Сколько минут срока подарили вместе с напоминанием. Хранится, чтобы
-- в отчёте было видно реальную длину жизни кода, а не только исходную.
alter table inventory add column if not exists extended_minutes int not null default 0;

create index if not exists inventory_reminder_idx
  on inventory(status, reminded_at, expires_at);

alter table settings add column if not exists reminders_enabled boolean not null default true;
alter table settings add column if not exists reminder_hours int not null default 24;
alter table settings add column if not exists reminder_grace_minutes int not null default 30;


-- ------------------------------------------------------------
--  Массовые рассылки
--
--  Рассылка разбита на две таблицы, а не отправляется одним запросом,
--  по двум причинам. Telegram не даёт слать больше ~30 сообщений в
--  секунду, а функция на Vercel живёт 10 секунд — тысяча клиентов в
--  один заход не поместится. И если отправка оборвётся на середине,
--  по списку получателей видно, кому уже ушло, и повтор не задваивает.
-- ------------------------------------------------------------

create table if not exists broadcasts (
  id bigserial primary key,
  text text not null,
  audience text not null default 'all',        -- all | active | holding | lapsed
  actor_id bigint,
  status text not null default 'pending',      -- pending | sending | done | cancelled
  total int not null default 0,
  sent int not null default 0,
  failed int not null default 0,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists broadcast_recipients (
  broadcast_id bigint not null references broadcasts(id) on delete cascade,
  user_id bigint not null references users(id),
  status text not null default 'pending',      -- pending | sent | failed
  error text,
  sent_at timestamptz,
  primary key (broadcast_id, user_id)
);

create index if not exists broadcast_recipients_queue_idx
  on broadcast_recipients(broadcast_id, status);

-- Картинка хранится не у нас, а на серверах Telegram: при загрузке он
-- отдаёт file_id, по которому потом можно отправлять сколько угодно раз
-- без повторной передачи файла. Своё хранилище тут было бы лишним.
alter table broadcasts add column if not exists photo_file_id text;


-- ------------------------------------------------------------
--  Кого пора предупредить о сгорании приза
--
--  Функция не просто выбирает призы, а сразу помечает их и продлевает
--  срок. Пометка и выборка в одном операторе — иначе повторный запуск
--  задачи (Vercel умеет ретраить) прислал бы клиенту второе письмо и
--  продлил бы код ещё раз.
--
--  Продление на полчаса — жест доброй воли: клиент читает сообщение
--  уже с запасом времени, а не с мыслью "всё равно не успею".
-- ------------------------------------------------------------

create or replace function due_reminders(p_limit int default 60)
returns json
language plpgsql
as $$
declare
  v_enabled boolean;
  v_hours   int;
  v_grace   int;
  v_items   json;
begin
  select reminders_enabled, reminder_hours, reminder_grace_minutes
    into v_enabled, v_hours, v_grace
    from settings where id = 1;

  v_hours := coalesce(v_hours, 24);
  v_grace := coalesce(v_grace, 30);

  if not coalesce(v_enabled, true) then
    return json_build_object('items', '[]'::json, 'skipped', 'disabled');
  end if;

  with due as (
    select i.id
      from inventory i
      join users u on u.id = i.user_id
     where i.status = 'unused'
       and i.reminded_at is null
       and i.expires_at > now()
       and i.expires_at <= now() + make_interval(hours => v_hours)
       and u.can_message
       and not u.blocked
     order by i.expires_at
     limit greatest(1, coalesce(p_limit, 60))
     for update of i skip locked
  ),
  bumped as (
    update inventory i
       set reminded_at      = now(),
           expires_at       = i.expires_at + make_interval(mins => v_grace),
           extended_minutes = i.extended_minutes + v_grace
      from due
     where i.id = due.id
    returning i.user_id, i.title, i.code, i.expires_at
  )
  select coalesce(json_agg(json_build_object(
           'userId',    b.user_id,
           'title',     b.title,
           'code',      b.code,
           'expiresAt', b.expires_at
         )), '[]'::json)
    into v_items
    from bumped b;

  return json_build_object('items', v_items, 'graceMinutes', v_grace);
end;
$$;


-- ------------------------------------------------------------
--  Аудитории рассылки
--
--  Во всех выборках отсечены заблокированные и те, кому бот писать не
--  может: слать им бессмысленно, а в статистике они выглядели бы как
--  провалившаяся доставка.
-- ------------------------------------------------------------

create or replace function audience_sizes()
returns json
language sql
as $$
  select json_build_object(
    'all',     count(*) filter (where true),
    'active',  count(*) filter (where u.last_checkin_at >= now() - interval '30 days'),
    'lapsed',  count(*) filter (where u.last_checkin_at is null
                                   or u.last_checkin_at <  now() - interval '30 days'),
    'holding', count(*) filter (where exists (
                 select 1 from inventory i
                  where i.user_id = u.id and i.status = 'unused' and i.expires_at > now())),
    'unreachable', (select count(*) from users x where not x.can_message and not x.blocked)
  )
  from users u
  where u.can_message and not u.blocked;
$$;


-- Функция получила четвёртый аргумент. Без явного drop в базе остались
-- бы обе версии, и PostgREST не смог бы выбрать между ними.
drop function if exists create_broadcast(text, bigint, text);

create or replace function create_broadcast(p_text text, p_actor bigint, p_audience text, p_photo text default null)
returns json
language plpgsql
as $$
declare
  v_id    bigint;
  v_total int;
  v_aud   text := coalesce(p_audience, 'all');
begin
  if coalesce(btrim(p_text), '') = '' then
    return json_build_object('error', 'empty_text');
  end if;

  if v_aud not in ('all', 'active', 'lapsed', 'holding') then
    return json_build_object('error', 'bad_audience');
  end if;

  insert into broadcasts (text, audience, actor_id, status, photo_file_id)
  values (btrim(p_text), v_aud, p_actor, 'sending', nullif(btrim(coalesce(p_photo, '')), ''))
  returning id into v_id;

  insert into broadcast_recipients (broadcast_id, user_id)
  select v_id, u.id
    from users u
   where u.can_message
     and not u.blocked
     and (
       v_aud = 'all'
       or (v_aud = 'active'  and u.last_checkin_at >= now() - interval '30 days')
       or (v_aud = 'lapsed'  and (u.last_checkin_at is null
                                  or u.last_checkin_at < now() - interval '30 days'))
       or (v_aud = 'holding' and exists (
             select 1 from inventory i
              where i.user_id = u.id and i.status = 'unused' and i.expires_at > now()))
     );

  get diagnostics v_total = row_count;

  update broadcasts
     set total = v_total,
         status = case when v_total = 0 then 'done' else 'sending' end,
         finished_at = case when v_total = 0 then now() else null end
   where id = v_id;

  return json_build_object('id', v_id, 'total', v_total, 'audience', v_aud);
end;
$$;


-- Момент, когда получателя взяли в работу. По нему возвращаются в
-- очередь партии, зависшие из-за упавшей функции.
alter table broadcast_recipients add column if not exists claimed_at timestamptz;


create or replace function next_broadcast_batch(p_id bigint, p_limit int default 25)
returns json
language plpgsql
as $$
declare
  v_text   text;
  v_status text;
  v_photo  text;
  v_ids    json;
  v_left   int;
begin
  select b.text, b.status, b.photo_file_id
    into v_text, v_status, v_photo
    from broadcasts b where b.id = p_id;

  if v_text is null then
    return json_build_object('error', 'not_found');
  end if;
  if v_status = 'cancelled' then
    return json_build_object('error', 'cancelled');
  end if;

  update broadcast_recipients
     set status = 'pending', claimed_at = null
   where broadcast_id = p_id
     and status = 'sending'
     and claimed_at < now() - interval '2 minutes';

  with batch as (
    select r.user_id
      from broadcast_recipients r
     where r.broadcast_id = p_id and r.status = 'pending'
     limit greatest(1, coalesce(p_limit, 25))
     for update skip locked
  ),
  claimed as (
    update broadcast_recipients r
       set status = 'sending', claimed_at = now()
      from batch
     where r.broadcast_id = p_id and r.user_id = batch.user_id
    returning r.user_id
  )
  select coalesce(json_agg(c.user_id), '[]'::json) into v_ids from claimed c;

  select count(*) into v_left
    from broadcast_recipients
   where broadcast_id = p_id and status = 'pending';

  return json_build_object('text', v_text, 'photo', v_photo, 'userIds', v_ids, 'pending', v_left);
end;
$$;


create or replace function finish_broadcast_batch(p_id bigint, p_results jsonb)
returns json
language plpgsql
as $$
declare
  v_left int;
  v_out  json;
begin
  update broadcast_recipients r
     set status     = case when coalesce((e->>'ok')::boolean, false) then 'sent' else 'failed' end,
         error      = nullif(e->>'error', ''),
         sent_at    = now(),
         claimed_at = null
    from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) e
   where r.broadcast_id = p_id
     and r.user_id = (e->>'userId')::bigint;

  -- Кто закрыл переписку с ботом — больше не получит ничего. Помечаем,
  -- чтобы каждая следующая рассылка не билась в ту же стену.
  update users u
     set can_message = false
    from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) e
   where u.id = (e->>'userId')::bigint
     and coalesce((e->>'blocked')::boolean, false);

  update broadcasts b
     set sent   = (select count(*) from broadcast_recipients r
                    where r.broadcast_id = b.id and r.status = 'sent'),
         failed = (select count(*) from broadcast_recipients r
                    where r.broadcast_id = b.id and r.status = 'failed')
   where b.id = p_id;

  select count(*) into v_left
    from broadcast_recipients
   where broadcast_id = p_id and status in ('pending', 'sending');

  if v_left = 0 then
    update broadcasts set status = 'done', finished_at = now()
     where id = p_id and status <> 'cancelled';
  end if;

  select json_build_object(
           'id', b.id, 'total', b.total, 'sent', b.sent,
           'failed', b.failed, 'pending', v_left, 'status', b.status
         )
    into v_out
    from broadcasts b where b.id = p_id;

  return v_out;
end;
$$;


-- ------------------------------------------------------------
--  Клиенты, которым бот писать не может
--
--  Telegram запрещает боту писать первым, пока человек сам не начал
--  переписку. Владельцу важно видеть не только их количество, но и кто
--  это: у половины из них на руках призы, которые сгорят без
--  предупреждения, а телефон позволяет позвонить.
-- ------------------------------------------------------------

create or replace function unreachable_clients(p_limit int default 60)
returns json
language sql
as $$
  select coalesce(json_agg(t), '[]'::json) from (
    select u.id,
           u.first_name,
           u.username,
           u.phone,
           u.last_checkin_at,
           u.visits_total,
           (select count(*) from inventory i
             where i.user_id = u.id
               and i.status = 'unused'
               and i.expires_at > now()) as holding
      from users u
     where not u.can_message
       and not u.blocked
     order by (select count(*) from inventory i
                where i.user_id = u.id
                  and i.status = 'unused'
                  and i.expires_at > now()) desc,
              u.last_checkin_at desc nulls last
     limit greatest(1, coalesce(p_limit, 60))
  ) t;
$$;


create or replace function list_broadcasts(p_limit int default 20)
returns json
language sql
as $$
  select coalesce(json_agg(t), '[]'::json) from (
    select b.id, b.text, b.audience, b.status, b.total, b.sent, b.failed,
           b.photo_file_id, b.created_at, b.finished_at
      from broadcasts b
     order by b.created_at desc
     limit greatest(1, coalesce(p_limit, 20))
  ) t;
$$;

notify pgrst, 'reload schema';
