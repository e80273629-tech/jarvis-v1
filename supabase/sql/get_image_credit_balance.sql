-- ============================================================================
-- OSVYRA — saldo de créditos de imagem (SOMENTE LEITURA)
-- ============================================================================
--
-- STATUS: ENTREGUE PARA REVISÃO. NÃO FOI EXECUTADO.
-- Este arquivo não é executado por nenhum processo automático: precisa ser
-- colado manualmente no SQL Editor do Supabase, depois da sua aprovação.
--
-- POR QUE ESTE ARQUIVO EXISTE
-- A Edge Function `gerar-imagem-ia` devolve `creditsRemaining` apenas DEPOIS de
-- uma geração. Isso não resolve o saldo na abertura do Estúdio de Imagens.
-- Para ler o saldo inicial sem abrir a tabela `public.user_credits` inteira ao
-- PostgREST (o que exigiria uma policy de SELECT), expomos uma única função
-- SECURITY DEFINER que devolve SOMENTE o saldo do próprio usuário.
--
-- GARANTIAS DESTA FUNÇÃO
--   * security definer  -> lê a tabela sem precisar de policy de SELECT;
--   * auth.uid()        -> devolve apenas o saldo de quem chamou;
--   * stable            -> sem efeitos colaterais (não consome nem concede);
--   * search_path fixo  -> evita sequestro de schema;
--   * grant só para `authenticated` -> visitante anônimo não lê nada.
--
-- O QUE ESTA FUNÇÃO **NÃO** FAZ
--   * não altera `user_credits`;
--   * não concede créditos;
--   * não substitui `consume_image_credit` nem `refund_image_credit`;
--   * não desativa RLS nem cria policy de SELECT na tabela.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PASSO 0 — CONFERIR OS NOMES REAIS ANTES DE RODAR
-- Rode este SELECT primeiro e compare com o corpo da função abaixo.
-- Se a coluna do saldo não se chamar `balance`, use a VARIANTE B.
-- ----------------------------------------------------------------------------
-- select column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'user_credits'
--  order by ordinal_position;


-- ----------------------------------------------------------------------------
-- VARIANTE A — usar quando a coluna do saldo se chama `balance`
-- ----------------------------------------------------------------------------
create or replace function public.get_image_credit_balance()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select uc.balance
       from public.user_credits uc
      where uc.user_id = auth.uid()),
    0
  )::integer;
$$;

revoke all on function public.get_image_credit_balance() from public;
grant execute on function public.get_image_credit_balance() to authenticated;

comment on function public.get_image_credit_balance() is
  'Saldo de creditos de imagem do usuario autenticado (auth.uid()). Somente leitura.';


-- ----------------------------------------------------------------------------
-- VARIANTE B — usar SOMENTE se a coluna do saldo se chamar `credits`
-- Deixe a Variante A comentada e descomente esta. Rode apenas UMA delas:
-- a segunda sobrescreve a primeira.
-- ----------------------------------------------------------------------------
-- create or replace function public.get_image_credit_balance()
-- returns integer
-- language sql
-- stable
-- security definer
-- set search_path = public, pg_temp
-- as $$
--   select coalesce(
--     (select uc.credits
--        from public.user_credits uc
--       where uc.user_id = auth.uid()),
--     0
--   )::integer;
-- $$;
--
-- revoke all on function public.get_image_credit_balance() from public;
-- grant execute on function public.get_image_credit_balance() to authenticated;


-- ----------------------------------------------------------------------------
-- PASSO FINAL — CONFERIR DEPOIS DE CRIAR
-- 1) Como usuário autenticado, no app, o frontend chama:
--      supabaseClient.rpc('get_image_credit_balance')
--    e espera um número inteiro.
-- 2) Teste rápido no SQL Editor (usa o usuário do painel, não o do app):
--      select public.get_image_credit_balance();
-- 3) Para desfazer, se algo sair diferente do esperado:
--      drop function if exists public.get_image_credit_balance();
--    O frontend continua funcionando: sem a RPC ele mostra "Créditos: —" e
--    passa a exibir o saldo a partir do `creditsRemaining` da primeira geração.
-- ============================================================================
