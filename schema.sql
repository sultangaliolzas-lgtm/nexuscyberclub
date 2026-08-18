-- Выполните этот скрипт один раз в Supabase: Project -> SQL Editor -> New query -> Run

create table if not exists users (
  id bigint primary key,
  username text,
  first_name text,
  visits_available int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists inventory (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references users(id),
  prize_key text not null,
  title text not null,
  tier text not null,
  code text not null unique,
  status text not null default 'unused',
  won_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_by bigint
);

create index if not exists inventory_user_id_idx on inventory(user_id);
create index if not exists inventory_code_idx on inventory(code);

alter table users enable row level security;
alter table inventory enable row level security;
-- RLS включён, но политик нет — доступ только через service_role ключ (наш backend),
-- анонимный ключ (если он у вас есть) ничего не увидит и не изменит.
