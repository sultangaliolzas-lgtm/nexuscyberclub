-- ============================================================
--  Приветственное сообщение бота
--
--  Выполнить в Supabase: SQL Editor -> New query -> Run.
--  Скрипт идемпотентный, повторный запуск ничего не сломает.
--
--  Текст приветствия и картинка к нему переезжают из кода в настройки:
--  владелец правит их из кабинета, без деплоя. Картинка хранится не у
--  нас, а на серверах Telegram — в колонке лежит file_id, полученный
--  при загрузке.
-- ============================================================

alter table settings add column if not exists welcome_text text;
alter table settings add column if not exists welcome_photo_file_id text;

notify pgrst, 'reload schema';

select welcome_text, welcome_photo_file_id from settings where id = 1;
