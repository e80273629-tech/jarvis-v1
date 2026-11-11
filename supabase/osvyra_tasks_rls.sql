-- OSVYRA — privilégios e políticas RLS da tabela public.osvyra_tasks
--
-- Quando usar: a seção "Lembretes e tarefas" mostra
--   Erro ao carregar lembretes: permission denied for table osvyra_tasks — código 42501
-- ou o salvamento do lembrete falha com o mesmo código.
--
-- Causa: a tabela existe, mas o papel da API (authenticated) não tem GRANT nela
-- e/ou não existem políticas de RLS por usuário. As tabelas opportunities e
-- customers funcionam porque já possuem grants + políticas.
--
-- IMPORTANTE: este script NÃO desativa o RLS. Ele garante o RLS ativo e cria
-- políticas que só permitem ao usuário autenticado acessar os próprios registros.
-- Rode no SQL Editor do projeto Supabase (uma vez; é idempotente).

-- 1) Garante o RLS ativo (nunca desative).
alter table public.osvyra_tasks enable row level security;

-- 2) Permissões de tabela para o papel autenticado (sem elas, o RLS nem é avaliado).
grant select, insert, update on public.osvyra_tasks to authenticated;

-- 3) Políticas por usuário: user_id deve ser o usuário autenticado.
drop policy if exists "osvyra_tasks_select_own" on public.osvyra_tasks;
create policy "osvyra_tasks_select_own" on public.osvyra_tasks
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "osvyra_tasks_insert_own" on public.osvyra_tasks;
create policy "osvyra_tasks_insert_own" on public.osvyra_tasks
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "osvyra_tasks_update_own" on public.osvyra_tasks;
create policy "osvyra_tasks_update_own" on public.osvyra_tasks
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 4) Conferência (execute separadamente para ver o resultado):
-- select grantee, privilege_type
--   from information_schema.role_table_grants
--  where table_schema = 'public' and table_name = 'osvyra_tasks';
--
-- select policyname, cmd, qual
--   from pg_policies
--  where schemaname = 'public' and tablename = 'osvyra_tasks';
