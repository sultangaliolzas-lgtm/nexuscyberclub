-- ============================================================
--  Миграция 004 — мультиарендность (много клубов в одной базе)
--
--  Выполнять в Supabase: Project -> SQL Editor -> New query -> Run.
--  Скрипт идемпотентный: повторный запуск безопасен.
--
--  Что делает:
--   * заводит реестр клубов `clubs`;
--   * добавляет `club_id` во все таблицы ядра и рассылок;
--   * привязывает существующие данные Nexus к его клубу;
--   * переводит ключи prizes/settings/staff/users на составные (с club_id);
--   * заменяет все функции на клуб-скоупные версии (первый аргумент p_club_id).
--
--  ВАЖНО: раздел брони (halls/seats/packages/bookings) здесь НЕ трогается —
--  он остаётся у Nexus как есть, у новых клубов вкладка скрыта на клиенте.
-- ============================================================

-- Фиксированный uuid клуба Nexus, чтобы бэкфилл был детерминированным.
-- (произвольное, но постоянное значение — на него ссылаемся ниже)
--   Nexus club id = 11111111-1111-1111-1111-111111111111


-- ------------------------------------------------------------
--  1. Реестр клубов
-- ------------------------------------------------------------

create table if not exists clubs (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                 -- ровно 6 символов [a-z0-9], префикс deep-link
  name text not null default 'Клуб',
  owner_tg_id bigint,
  plan text not null default 'trial',        -- trial | paid
  status text not null default 'active',     -- active | frozen
  paid_until timestamptz,
  booking_enabled boolean not null default false,
  tribute_sub_id text,
  created_at timestamptz not null default now()
);

-- Генератор короткого уникального кода клуба (6 символов a-z0-9).
create or replace function gen_club_code()
returns text
language plpgsql
as $$
declare
  v_code text;
  v_try  int := 0;
begin
  loop
    v_try := v_try + 1;
    -- 6 символов [0-9a-f] на основе случайного md5 — достаточно для кода клуба
    v_code := lower(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from clubs where code = v_code) or v_try >= 20;
  end loop;
  return v_code;
end;
$$;

-- Клуб Nexus (первый арендатор). Владелец — тот же tg-id, что и в staff.
-- Имя берём из существующих настроек (не по id — колонка id ниже удаляется,
-- иначе повторный запуск сломался бы на этой строке).
insert into clubs (id, code, name, owner_tg_id, plan, status, booking_enabled)
values ('11111111-1111-1111-1111-111111111111', 'nx0001',
        coalesce((select club_name from settings limit 1), 'Nexus'),
        420115296, 'paid', 'active', true)
on conflict (id) do nothing;


-- ------------------------------------------------------------
--  2. Колонки club_id (nullable), затем бэкфилл = Nexus
-- ------------------------------------------------------------

alter table users                 add column if not exists club_id uuid;
alter table inventory             add column if not exists club_id uuid;
alter table prizes                add column if not exists club_id uuid;
alter table settings              add column if not exists club_id uuid;
alter table staff                 add column if not exists club_id uuid;
alter table events                add column if not exists club_id uuid;
alter table config_log            add column if not exists club_id uuid;
alter table broadcasts            add column if not exists club_id uuid;
alter table broadcast_recipients  add column if not exists club_id uuid;

update users                set club_id = '11111111-1111-1111-1111-111111111111' where club_id is null;
update inventory            set club_id = '11111111-1111-1111-1111-111111111111' where club_id is null;
update prizes               set club_id = '11111111-1111-1111-1111-111111111111' where club_id is null;
update settings             set club_id = '11111111-1111-1111-1111-111111111111' where club_id is null;
update staff                set club_id = '11111111-1111-1111-1111-111111111111' where club_id is null;
update events               set club_id = '11111111-1111-1111-1111-111111111111' where club_id is null;
update config_log           set club_id = '11111111-1111-1111-1111-111111111111' where club_id is null;
update broadcasts           set club_id = '11111111-1111-1111-1111-111111111111' where club_id is null;
update broadcast_recipients set club_id = '11111111-1111-1111-1111-111111111111' where club_id is null;


-- ------------------------------------------------------------
--  3. Хирургия ключей и внешних связей.
--     Делаем через DO-блоки и pg_constraint, чтобы не зависеть от
--     точных имён ограничений и быть идемпотентными.
-- ------------------------------------------------------------

-- 3.1 Снять внешние ключи, которые ссылаются на users(id) — они мешают
--     сменить первичный ключ users на составной.
do $$
declare r record;
begin
  for r in
    select con.conname, cl.relname as tbl
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_class rf on rf.oid = con.confrelid
     where con.contype = 'f' and rf.relname = 'users'
  loop
    execute format('alter table %I drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

-- 3.2 Снять первичные ключи и единственно-строчный check настроек.
do $$
declare r record;
begin
  for r in
    select con.conname, cl.relname as tbl
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
     where con.contype in ('p')
       and cl.relname in ('users','prizes','settings','staff','broadcast_recipients')
  loop
    execute format('alter table %I drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

alter table settings drop constraint if exists settings_single_row;

-- 3.3 Проставить club_id в NOT NULL и завести составные первичные ключи.
alter table users                alter column club_id set not null;
alter table inventory            alter column club_id set not null;
alter table prizes               alter column club_id set not null;
alter table settings             alter column club_id set not null;
alter table staff                alter column club_id set not null;
alter table events               alter column club_id set not null;
alter table config_log           alter column club_id set not null;
alter table broadcasts           alter column club_id set not null;
alter table broadcast_recipients alter column club_id set not null;

alter table users     add constraint users_pkey     primary key (club_id, id);
alter table prizes    add constraint prizes_pkey    primary key (club_id, key);
alter table settings  add constraint settings_pkey  primary key (club_id);
alter table staff     add constraint staff_pkey     primary key (club_id, id);
alter table broadcast_recipients
  add constraint broadcast_recipients_pkey primary key (broadcast_id, user_id);

-- 3.4 Вернуть внешние ключи на составной users, теперь уже с club_id.
alter table inventory
  add constraint inventory_user_fkey
  foreign key (club_id, user_id) references users(club_id, id);

alter table broadcast_recipients
  add constraint broadcast_recipients_user_fkey
  foreign key (club_id, user_id) references users(club_id, id);

-- 3.5 Внешние ключи club_id -> clubs (для целостности).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'settings_club_fkey') then
    alter table settings add constraint settings_club_fkey
      foreign key (club_id) references clubs(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staff_club_fkey') then
    alter table staff add constraint staff_club_fkey
      foreign key (club_id) references clubs(id) on delete cascade;
  end if;
end $$;

-- 3.6 Колонка id у settings больше не нужна (ключ теперь club_id).
alter table settings drop column if exists id;

-- 3.7 Индексы под клуб-скоуп.
create index if not exists inventory_club_user_idx on inventory(club_id, user_id);
create index if not exists inventory_club_status_idx on inventory(club_id, status, expires_at);
create index if not exists events_club_idx on events(club_id, type, created_at desc);
create index if not exists config_log_club_idx on config_log(club_id, created_at desc);
create index if not exists broadcasts_club_idx on broadcasts(club_id, created_at desc);


-- ------------------------------------------------------------
--  4. Создание нового клуба одной транзакцией: реестр + настройки +
--     дефолтные призы + владелец. Возвращает код и id клуба.
-- ------------------------------------------------------------

create or replace function create_club(p_owner_tg_id bigint, p_name text)
returns json
language plpgsql
as $$
declare
  v_id   uuid;
  v_code text := gen_club_code();
  v_name text := coalesce(nullif(btrim(p_name), ''), 'Клуб');
begin
  insert into clubs (code, name, owner_tg_id, plan, status)
  values (v_code, v_name, p_owner_tg_id, 'trial', 'active')
  returning id into v_id;

  -- Настройки клуба (одна строка на клуб).
  insert into settings (club_id, club_name) values (v_id, v_name);

  -- Владелец клуба.
  insert into users (club_id, id) values (v_id, p_owner_tg_id)
  on conflict (club_id, id) do nothing;
  insert into staff (club_id, id, role, title)
  values (v_id, p_owner_tg_id, 'owner', 'Владелец')
  on conflict (club_id, id) do update set role = 'owner';

  -- Дефолтный набор призов клуба (тот же, что сидится в schema.sql).
  insert into prizes (club_id, key, title, short_title, description, icon, tier, weight, expires_in_days, color, sort_order, effect, cost) values
    (v_id, 'time_30',     '+30 минут игры',      '+30 мин',   'Полчаса игрового времени в подарок',              '⏱', 'COMMON', 25, 3, '#8be04e',  1, 'item',       0),
    (v_id, 'drink',       'Напиток в подарок',   'Напиток',   'Напиток на выбор за счёт клуба',                  '🥤', 'COMMON', 20, 3, '#ff5c8a',  2, 'item',       0),
    (v_id, 'snack',       'Снек в подарок',      'Снек',      'Снек на выбор за счёт клуба',                     '🍿', 'COMMON', 15, 3, '#ffb02e',  3, 'item',       0),
    (v_id, 'discount_10', 'Скидка 10% на визит', 'Скидка 10%','Скидка 10% на следующее посещение клуба',         '🏷', 'COMMON', 15, 5, '#d4e84a',  4, 'item',       0),
    (v_id, 'time_60',     '+1 час игры',         '+1 час',    'Час игрового времени в подарок',                  '🕐', 'RARE',   12, 3, '#31d0ff',  5, 'item',       0),
    (v_id, 'discount_20', 'Скидка 20% на визит', 'Скидка 20%','Скидка 20% на следующее посещение клуба',         '🔖', 'RARE',    6, 5, '#ffd23f',  6, 'item',       0),
    (v_id, 'vip_upgrade', 'VIP-место на час',    'VIP час',   'Час на VIP-месте без доплаты',                    '💺', 'RARE',    5, 2, '#00e0c0',  7, 'item',       0),
    (v_id, 'time_120',    '2 часа игры',         '2 часа',    'Два часа игрового времени в подарок',             '🔥', 'EPIC',    5, 2, '#ff4d4d',  8, 'item',       0),
    (v_id, 'bonus_x2',    'Х2 бонус на завтра',  'Х2 завтра', 'Следующий визит даст два прокрута вместо одного', '⚡', 'RARE',    4, 1, '#c56bff',  9, 'bonus_next', 0),
    (v_id, 'respin',      'Крути ещё раз',       'Ещё раз',   'Прокрут возвращается — крути сразу снова',        '🔄', 'EPIC',    3, 1, '#a6ff2f', 10, 'respin',     0)
  on conflict (club_id, key) do nothing;

  return json_build_object('id', v_id, 'code', v_code, 'name', v_name);
end;
$$;


-- ============================================================
--  5. Клуб-скоупные версии функций.
--     Каждая получила первым аргументом p_club_id uuid. Старые
--     сигнатуры дропаем явно — иначе PostgREST увидит перегрузку.
-- ============================================================

drop function if exists prize_issued_today(text);
drop function if exists do_spin(bigint);
drop function if exists do_checkin(bigint, text);
drop function if exists do_redeem(text, bigint);
drop function if exists peek_code(text);
drop function if exists admin_daily(int);
drop function if exists do_grant(bigint, bigint, int);
drop function if exists period_summary(timestamptz, timestamptz);
drop function if exists admin_stats(int);
drop function if exists admin_clients(int);
drop function if exists set_blocked(bigint, bigint, boolean, text);
drop function if exists admin_export(int);
drop function if exists admin_config_log(int);
drop function if exists admin_activity(int);
drop function if exists due_reminders(int);
drop function if exists audience_sizes();
drop function if exists create_broadcast(text, bigint, text, text);
drop function if exists next_broadcast_batch(bigint, int);
drop function if exists finish_broadcast_batch(bigint, jsonb);
drop function if exists unreachable_clients(int);
drop function if exists list_broadcasts(int);


-- Сколько штук этого приза уже выдано с начала суток (в этом клубе).
create or replace function prize_issued_today(p_club_id uuid, p_key text)
returns int
language sql
stable
as $$
  select count(*)::int
    from inventory
   where club_id = p_club_id
     and prize_key = p_key
     and won_at >= date_trunc('day', now());
$$;


create or replace function do_spin(p_club_id uuid, p_user_id bigint)
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
  if (select blocked from users where club_id = p_club_id and id = p_user_id) then
    return json_build_object('error', 'blocked');
  end if;

  select max_unused_prizes into v_cap from settings where club_id = p_club_id;
  v_cap := coalesce(v_cap, 5);

  if v_cap > 0 then
    select count(*) into v_held
      from inventory
     where club_id = p_club_id
       and user_id = p_user_id
       and status = 'unused'
       and expires_at > now();

    if v_held >= v_cap then
      return json_build_object('error', 'inventory_full', 'cap', v_cap, 'held', v_held);
    end if;
  end if;

  update users
     set visits_available = visits_available - 1
   where club_id = p_club_id
     and id = p_user_id
     and visits_available > 0
  returning visits_available into v_left;

  if not found then
    return json_build_object('error', 'no_spins_available');
  end if;

  select coalesce(sum(p.weight), 0) into v_total
    from prizes p
   where p.club_id = p_club_id
     and p.enabled
     and p.weight > 0
     and (p.daily_limit is null or prize_issued_today(p_club_id, p.key) < p.daily_limit);

  if v_total > 0 then
    v_roll := random() * v_total;

    select t.key into v_key
      from (
        select p.key,
               sum(p.weight) over (order by p.sort_order, p.key) as cum
          from prizes p
         where p.club_id = p_club_id
           and p.enabled
           and p.weight > 0
           and (p.daily_limit is null or prize_issued_today(p_club_id, p.key) < p.daily_limit)
      ) t
     where t.cum > v_roll
     order by t.cum
     limit 1;
  end if;

  if v_key is null or v_key = 'nothing' then
    insert into events (club_id, type, user_id, prize_key)
    values (p_club_id, 'spin', p_user_id, coalesce(v_key, 'nothing'));

    return json_build_object(
      'prizeKey', coalesce(v_key, 'nothing'),
      'prize', null,
      'spinsLeft', v_left
    );
  end if;

  select * into v_prize from prizes where club_id = p_club_id and key = v_key;

  if v_prize.effect = 'respin' then
    update users set visits_available = visits_available + 1
     where club_id = p_club_id and id = p_user_id
    returning visits_available into v_left;

    insert into events (club_id, type, user_id, prize_key) values (p_club_id, 'spin', p_user_id, v_prize.key);

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
    update users set bonus_next_checkin = 1 where club_id = p_club_id and id = p_user_id;

    insert into events (club_id, type, user_id, prize_key) values (p_club_id, 'spin', p_user_id, v_prize.key);

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

  -- Уникальность кода — глобальная (по всем клубам), чтобы приз можно было
  -- погасить по боту, определив клуб из самого кода.
  loop
    v_try := v_try + 1;
    v_code := 'NX-' || upper(substr(md5(random()::text || clock_timestamp()::text || p_user_id::text), 1, 8));
    exit when not exists (select 1 from inventory where code = v_code) or v_try >= 5;
  end loop;

  v_expires := now() + make_interval(days => greatest(v_prize.expires_in_days, 1));

  insert into inventory (club_id, user_id, prize_key, title, tier, code, status, expires_at)
  values (
    p_club_id,
    p_user_id,
    v_prize.key,
    coalesce(v_prize.title, v_prize.short_title, v_prize.key),
    coalesce(v_prize.tier, 'COMMON'),
    v_code,
    'unused',
    v_expires
  );

  insert into events (club_id, type, user_id, prize_key, code)
  values (p_club_id, 'spin', p_user_id, v_prize.key, v_code);

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


create or replace function do_checkin(p_club_id uuid, p_user_id bigint, p_source text)
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
    from settings where club_id = p_club_id;

  v_cooldown := coalesce(v_cooldown, 24);

  if (select blocked from users where club_id = p_club_id and id = p_user_id) then
    return json_build_object('granted', false, 'reason', 'blocked', 'spinsAvailable', 0);
  end if;

  if not coalesce(v_enabled, true) then
    select visits_available into v_spins from users where club_id = p_club_id and id = p_user_id;
    return json_build_object('granted', false, 'reason', 'disabled', 'spinsAvailable', coalesce(v_spins, 0));
  end if;

  select coalesce(bonus_next_checkin, 0) into v_bonus from users where club_id = p_club_id and id = p_user_id;

  update users
     set visits_available   = visits_available + 1 + coalesce(v_bonus, 0),
         visits_total       = visits_total + 1,
         last_checkin_at    = now(),
         bonus_next_checkin = 0
   where club_id = p_club_id
     and id = p_user_id
     and (last_checkin_at is null or last_checkin_at <= now() - make_interval(hours => v_cooldown))
  returning visits_available into v_spins;

  if found then
    insert into events (club_id, type, user_id, source) values (p_club_id, 'checkin', p_user_id, p_source);
    return json_build_object(
      'granted', true,
      'spinsAvailable', v_spins,
      'bonus', coalesce(v_bonus, 0) > 0
    );
  end if;

  select visits_available, last_checkin_at into v_spins, v_last
    from users where club_id = p_club_id and id = p_user_id;

  return json_build_object(
    'granted', false,
    'reason', 'cooldown',
    'spinsAvailable', coalesce(v_spins, 0),
    'nextAt', v_last + make_interval(hours => v_cooldown)
  );
end;
$$;


create or replace function do_redeem(p_club_id uuid, p_code text, p_staff_id bigint)
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
   where club_id = p_club_id
     and upper(code) = upper(p_code)
     and status = 'unused'
     and expires_at > now()
  returning * into v_item;

  if found then
    insert into events (club_id, type, user_id, actor_id, prize_key, code)
    values (p_club_id, 'redeem', v_item.user_id, p_staff_id, v_item.prize_key, v_item.code);

    select coalesce(u.first_name, '@' || u.username, u.id::text)
      into v_client
      from users u where u.club_id = p_club_id and u.id = v_item.user_id;

    return json_build_object(
      'ok', true,
      'title', v_item.title,
      'tier', v_item.tier,
      'client', v_client,
      'clientId', v_item.user_id,
      'wonAt', v_item.won_at
    );
  end if;

  select * into v_item from inventory where club_id = p_club_id and upper(code) = upper(p_code);

  if not found then
    return json_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_item.status = 'redeemed' then
    return json_build_object('ok', false, 'reason', 'already_redeemed', 'redeemedAt', v_item.redeemed_at);
  end if;

  return json_build_object('ok', false, 'reason', 'expired', 'expiresAt', v_item.expires_at);
end;
$$;


create or replace function peek_code(p_club_id uuid, p_code text)
returns json
language plpgsql
stable
as $$
declare
  v_item   inventory%rowtype;
  v_client text;
  v_status text;
begin
  select * into v_item from inventory where club_id = p_club_id and upper(code) = upper(p_code);

  if not found then
    return json_build_object('found', false, 'reason', 'not_found');
  end if;

  select coalesce(u.first_name, '@' || u.username, u.id::text)
    into v_client
    from users u where u.club_id = p_club_id and u.id = v_item.user_id;

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


create or replace function admin_daily(p_club_id uuid, p_days int)
returns json
language sql
stable
as $$
  select coalesce(json_agg(row_to_json(t) order by t.day), '[]'::json)
    from (
      select d::date as day,
             (select count(*) from events e
               where e.club_id = p_club_id and e.type = 'spin' and e.created_at >= d and e.created_at < d + interval '1 day')::int as spins,
             (select count(*) from events e
               where e.club_id = p_club_id and e.type = 'checkin' and e.created_at >= d and e.created_at < d + interval '1 day')::int as checkins,
             (select count(*) from users u
               where u.club_id = p_club_id and u.created_at >= d and u.created_at < d + interval '1 day')::int as newcomers
        from generate_series(
               date_trunc('day', now()) - make_interval(days => greatest(p_days, 1) - 1),
               date_trunc('day', now()),
               interval '1 day'
             ) d
    ) t;
$$;


create or replace function do_grant(p_club_id uuid, p_user_id bigint, p_staff_id bigint, p_amount int)
returns int
language plpgsql
as $$
declare
  v_left int;
begin
  update users
     set visits_available = visits_available + p_amount
   where club_id = p_club_id and id = p_user_id
  returning visits_available into v_left;

  if not found then
    return -1;
  end if;

  insert into events (club_id, type, user_id, actor_id, source)
  values (p_club_id, 'grant', p_user_id, p_staff_id, 'manual');

  return v_left;
end;
$$;


create or replace function period_summary(p_club_id uuid, p_from timestamptz, p_to timestamptz)
returns json
language sql
stable
as $$
  select json_build_object(
    'spins',         (select count(*) from events where club_id = p_club_id and type = 'spin' and created_at >= p_from and created_at < p_to),
    'checkins',      (select count(*) from events where club_id = p_club_id and type = 'checkin' and created_at >= p_from and created_at < p_to),
    'emptySpins',    (select count(*) from events where club_id = p_club_id and type = 'spin' and prize_key = 'nothing' and created_at >= p_from and created_at < p_to),
    'prizesWon',     (select count(*) from inventory where club_id = p_club_id and won_at >= p_from and won_at < p_to),
    'redeemed',      (select count(*) from inventory where club_id = p_club_id and won_at >= p_from and won_at < p_to and status = 'redeemed'),
    'expired',       (select count(*) from inventory where club_id = p_club_id and won_at >= p_from and won_at < p_to and status = 'unused' and expires_at <= now()),
    'uniqueClients', (select count(distinct user_id) from events where club_id = p_club_id and type = 'spin' and created_at >= p_from and created_at < p_to),
    'newClients',    (select count(*) from users where club_id = p_club_id and created_at >= p_from and created_at < p_to),
    'totalClients',  (select count(*) from users where club_id = p_club_id),
    'spinsPending',  (select coalesce(sum(visits_available), 0) from users where club_id = p_club_id),
    'spent',         (select coalesce(sum(p.cost), 0)::numeric(12,2) from inventory i
                        join prizes p on p.club_id = i.club_id and p.key = i.prize_key
                       where i.club_id = p_club_id and i.status = 'redeemed' and i.redeemed_at >= p_from and i.redeemed_at < p_to)
  );
$$;


create or replace function admin_stats(p_club_id uuid, p_days int)
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
  select currency into v_currency from settings where club_id = p_club_id;

  select coalesce(json_agg(row_to_json(t) order by t.sort_order), '[]'::json)
    into v_prizes
    from (
      select p.key, p.title, p.short_title, p.icon, p.tier, p.color, p.sort_order, p.cost,
             (select count(*) from inventory i
               where i.club_id = p_club_id and i.prize_key = p.key and i.won_at >= v_from)::int as won,
             (select count(*) from inventory i
               where i.club_id = p_club_id and i.prize_key = p.key and i.won_at >= v_from
                 and i.status = 'redeemed')::int as redeemed,
             (select count(*) from inventory i
               where i.club_id = p_club_id and i.prize_key = p.key and i.won_at >= v_from
                 and i.status = 'unused' and i.expires_at > now())::int as outstanding,
             (select count(*) from inventory i
               where i.club_id = p_club_id and i.prize_key = p.key and i.won_at >= v_from
                 and i.status = 'unused' and i.expires_at <= now())::int as expired,
             (p.cost * (select count(*) from inventory i
               where i.club_id = p_club_id and i.prize_key = p.key and i.status = 'redeemed'
                 and i.redeemed_at >= v_from))::numeric(12,2) as spent
        from prizes p
       where p.club_id = p_club_id and p.key <> 'nothing'
    ) t;

  v_summary := period_summary(p_club_id, v_from, now());
  v_previous := period_summary(p_club_id, v_prev_from, v_from);

  select coalesce(json_agg(json_build_object('source', coalesce(s.source, '—'), 'count', s.c) order by s.c desc), '[]'::json)
    into v_sources
    from (
      select source, count(*)::int as c
        from events
       where club_id = p_club_id and type = 'checkin' and created_at >= v_from
       group by source
    ) s;

  select coalesce(json_agg(row_to_json(t) order by t.expires_at), '[]'::json)
    into v_outstanding
    from (
      select i.code, i.title, i.expires_at, i.prize_key,
             p.icon, u.first_name, u.username
        from inventory i
        join users u on u.club_id = i.club_id and u.id = i.user_id
        left join prizes p on p.club_id = i.club_id and p.key = i.prize_key
       where i.club_id = p_club_id and i.status = 'unused' and i.expires_at > now()
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
    'daily',       admin_daily(p_club_id, 7),
    'today', json_build_object(
      'spins',    (select count(*) from events where club_id = p_club_id and type = 'spin' and created_at >= v_today),
      'checkins', (select count(*) from events where club_id = p_club_id and type = 'checkin' and created_at >= v_today),
      'newcomers',(select count(*) from users where club_id = p_club_id and created_at >= v_today),
      'spent',    (select coalesce(sum(p.cost), 0)::numeric(12,2) from inventory i
                     join prizes p on p.club_id = i.club_id and p.key = i.prize_key
                    where i.club_id = p_club_id and i.status = 'redeemed' and i.redeemed_at >= v_today)
    ),
    'liability', json_build_object(
      'count', (select count(*) from inventory where club_id = p_club_id and status = 'unused' and expires_at > now()),
      'cost',  (select coalesce(sum(p.cost), 0)::numeric(12,2) from inventory i
                  join prizes p on p.club_id = i.club_id and p.key = i.prize_key
                 where i.club_id = p_club_id and i.status = 'unused' and i.expires_at > now())
    )
  );
end;
$$;


create or replace function admin_clients(p_club_id uuid, p_limit int default 200)
returns json
language sql
stable
as $$
  select coalesce(json_agg(row_to_json(t) order by t.last_seen desc), '[]'::json)
    from (
      select u.id, u.first_name, u.username, u.phone, u.blocked, u.blocked_reason,
             u.visits_total, u.visits_available, u.created_at, u.last_checkin_at,
             coalesce(u.last_checkin_at, u.created_at) as last_seen,
             (select count(*) from inventory i where i.club_id = p_club_id and i.user_id = u.id)::int as won,
             (select count(*) from inventory i where i.club_id = p_club_id and i.user_id = u.id and i.status = 'redeemed')::int as redeemed,
             (select count(*) from inventory i
               where i.club_id = p_club_id and i.user_id = u.id and i.status = 'unused' and i.expires_at > now())::int as holding
        from users u
       where u.club_id = p_club_id
       order by coalesce(u.last_checkin_at, u.created_at) desc
       limit p_limit
    ) t;
$$;


create or replace function set_blocked(p_club_id uuid, p_user_id bigint, p_actor_id bigint, p_blocked boolean, p_reason text)
returns json
language plpgsql
as $$
declare
  v_blocked boolean;
begin
  update users
     set blocked = p_blocked,
         blocked_reason = case when p_blocked then p_reason else null end
   where club_id = p_club_id and id = p_user_id
  returning blocked into v_blocked;

  if not found then
    return json_build_object('ok', false, 'reason', 'not_found');
  end if;

  insert into config_log (club_id, actor_id, entity, entity_key, changes)
  values (p_club_id, p_actor_id, 'client', p_user_id::text,
          json_build_object('blocked', json_build_object('to', p_blocked, 'reason', p_reason))::jsonb);

  return json_build_object('ok', true, 'blocked', v_blocked);
end;
$$;


create or replace function admin_export(p_club_id uuid, p_days int)
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
        join users u on u.club_id = i.club_id and u.id = i.user_id
        left join prizes p on p.club_id = i.club_id and p.key = i.prize_key
       where i.club_id = p_club_id and i.won_at >= now() - make_interval(days => greatest(p_days, 1))
    ) t;
$$;


create or replace function admin_config_log(p_club_id uuid, p_limit int default 40)
returns json
language sql
stable
as $$
  select coalesce(json_agg(row_to_json(t) order by t.created_at desc), '[]'::json)
    from (
      select c.entity, c.entity_key, c.changes, c.created_at,
             coalesce(a.first_name, '@' || a.username, c.actor_id::text) as actor
        from config_log c
        left join users a on a.club_id = c.club_id and a.id = c.actor_id
       where c.club_id = p_club_id
       order by c.created_at desc
       limit p_limit
    ) t;
$$;


create or replace function admin_activity(p_club_id uuid, p_limit int default 40)
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
        left join users u on u.club_id = e.club_id and u.id = e.user_id
        left join users a on a.club_id = e.club_id and a.id = e.actor_id
       where e.club_id = p_club_id
       order by e.created_at desc
       limit p_limit
    ) t;
$$;


create or replace function due_reminders(p_club_id uuid, p_limit int default 60)
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
    from settings where club_id = p_club_id;

  v_hours := coalesce(v_hours, 24);
  v_grace := coalesce(v_grace, 30);

  if not coalesce(v_enabled, true) then
    return json_build_object('items', '[]'::json, 'skipped', 'disabled');
  end if;

  with due as (
    select i.id
      from inventory i
      join users u on u.club_id = i.club_id and u.id = i.user_id
     where i.club_id = p_club_id
       and i.status = 'unused'
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


create or replace function audience_sizes(p_club_id uuid)
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
                  where i.club_id = p_club_id and i.user_id = u.id and i.status = 'unused' and i.expires_at > now())),
    'unreachable', (select count(*) from users x where x.club_id = p_club_id and not x.can_message and not x.blocked)
  )
  from users u
  where u.club_id = p_club_id and u.can_message and not u.blocked;
$$;


create or replace function create_broadcast(p_club_id uuid, p_text text, p_actor bigint, p_audience text, p_photo text default null)
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

  insert into broadcasts (club_id, text, audience, actor_id, status, photo_file_id)
  values (p_club_id, btrim(p_text), v_aud, p_actor, 'sending', nullif(btrim(coalesce(p_photo, '')), ''))
  returning id into v_id;

  insert into broadcast_recipients (broadcast_id, club_id, user_id)
  select v_id, p_club_id, u.id
    from users u
   where u.club_id = p_club_id
     and u.can_message
     and not u.blocked
     and (
       v_aud = 'all'
       or (v_aud = 'active'  and u.last_checkin_at >= now() - interval '30 days')
       or (v_aud = 'lapsed'  and (u.last_checkin_at is null
                                  or u.last_checkin_at < now() - interval '30 days'))
       or (v_aud = 'holding' and exists (
             select 1 from inventory i
              where i.club_id = p_club_id and i.user_id = u.id and i.status = 'unused' and i.expires_at > now()))
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


create or replace function next_broadcast_batch(p_club_id uuid, p_id bigint, p_limit int default 25)
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
    from broadcasts b where b.id = p_id and b.club_id = p_club_id;

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


create or replace function finish_broadcast_batch(p_club_id uuid, p_id bigint, p_results jsonb)
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

  update users u
     set can_message = false
    from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) e
   where u.club_id = p_club_id
     and u.id = (e->>'userId')::bigint
     and coalesce((e->>'blocked')::boolean, false);

  update broadcasts b
     set sent   = (select count(*) from broadcast_recipients r
                    where r.broadcast_id = b.id and r.status = 'sent'),
         failed = (select count(*) from broadcast_recipients r
                    where r.broadcast_id = b.id and r.status = 'failed')
   where b.id = p_id and b.club_id = p_club_id;

  select count(*) into v_left
    from broadcast_recipients
   where broadcast_id = p_id and status in ('pending', 'sending');

  if v_left = 0 then
    update broadcasts set status = 'done', finished_at = now()
     where id = p_id and club_id = p_club_id and status <> 'cancelled';
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


create or replace function unreachable_clients(p_club_id uuid, p_limit int default 60)
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
             where i.club_id = p_club_id and i.user_id = u.id
               and i.status = 'unused'
               and i.expires_at > now()) as holding
      from users u
     where u.club_id = p_club_id
       and not u.can_message
       and not u.blocked
     order by (select count(*) from inventory i
                where i.club_id = p_club_id and i.user_id = u.id
                  and i.status = 'unused'
                  and i.expires_at > now()) desc,
              u.last_checkin_at desc nulls last
     limit greatest(1, coalesce(p_limit, 60))
  ) t;
$$;


create or replace function list_broadcasts(p_club_id uuid, p_limit int default 20)
returns json
language sql
as $$
  select coalesce(json_agg(t), '[]'::json) from (
    select b.id, b.text, b.audience, b.status, b.total, b.sent, b.failed,
           b.photo_file_id, b.created_at, b.finished_at
      from broadcasts b
     where b.club_id = p_club_id
     order by b.created_at desc
     limit greatest(1, coalesce(p_limit, 20))
  ) t;
$$;


-- Доступ к реестру клубов — только бэкенду (как и к остальным таблицам).
alter table clubs enable row level security;

notify pgrst, 'reload schema';

