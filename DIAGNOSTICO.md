# OSVYRA — Diagnóstico de navegação e plano de correção

Branch analisada: `osvyra-v1-rebuild`. Nenhuma alteração de código foi feita na etapa de análise.

## Arquitetura encontrada

- `index.html` — aplicação PWA completa (HTML + CSS + JS inline, ~2.900 linhas). Tela única com troca de `<section class="panel">` por JavaScript.
- `supabase/functions/osvyra-chat/index.ts` — Edge Function `osvyra-chat` (Supabase), usada pelo chat da página.
- `sw.js` — service worker com cache `osvyra-v3-cache`.
- `manifest.webmanifest`, `icon.svg` — instalação PWA.
- Supabase: `createClient` no navegador com chave *publishable*; tabelas `osvyra_leads`, `osvyra_customers`, `osvyra_tasks` e função `osvyra-chat`.

Telas existentes: `#publicLanding`, `#moduleGrid` (home), `#osvyra-chat`, `#art`, `#video`, `#video-ai`, `#phone`, `#profile`, `#settings`.

## Problemas encontrados (causa raiz)

### 1. "Vídeos com IA" abre a tela errada — CRÍTICO
O card da home usa `data-target="video-ai"`, mas a seção `#video-ai` **não é** a tela de vídeos: ela contém o formulário de **login/cadastro + CRM + tarefas**. O gerador de vídeo real (`#videoGenerator`) está dentro de `#video` (Roteiro). Resultado: o usuário clica em "Vídeos com IA" e cai na tela de acesso/CRM.

### 2. "Organização de projetos" não abre — CRÍTICO
O card usa `data-target="clients"`, porém **não existe nenhum elemento `id="clients"`** no documento. O handler apenas escreve `console.warn` e retorna: o clique morre sem feedback.

Pior: `showLandingLogin()` e `updateAuthUI()` chamam `document.getElementById('clients').classList...` sem verificação. Isso lança `TypeError` (null):
- nos botões "Entrar" / "Começar agora" / "Acessar a OSVYRA" da landing;
- dentro de `updateAuthUI()`, interrompendo tudo o que vem depois: exibição do menu lateral, `#moduleGrid`, carregamento de leads, clientes e tarefas.
Consequência: mesmo com login válido a home e o menu podem nunca aparecer, e o CRM nunca carrega — a instabilidade relatada.

### 3. Roteiro inteligente e Vídeos com IA na mesma tela — ALTO
`#video` acumula duas ferramentas distintas: montagem de roteiro (`#videoStyle`, `#videoTopic`, `#makeScript`, `#scriptOut`, `#copyScript`, `#downloadScript`) **e** o gerador de vídeo (`#videoGenerator`, `#videoPrompt`, `#videoDuration`, `#videoFormat`, `#prepareVideo`, `#videoStatus`). Além disso `#sendToVideo` chama `showOsvyraScreen('video')`, ou seja, navega para a própria tela em vez de abrir Vídeos com IA.

### 4. Elementos e chamadas duplicados — MÉDIO
- `#osvyra-chat` é o único painel **sem** a classe `hidden`: aparece junto com o grid de ferramentas no carregamento e fica visível se `updateAuthUI()` falhar.
- `#sendToVideo` escreve em `#videoStatus` e em `#copyStatus` (duas mensagens para a mesma ação).
- Seletor morto `.tile` no binding de ferramentas (nenhum elemento `.tile` existe) e `showOsvyraScreen`/`osvyraScreenHistory` declarados **depois** do primeiro uso, o que fragiliza o roteamento.
- Dois blocos `<script>` independentes sem estado de navegação compartilhado; histórico de telas sem sincronização com o histórico do navegador (botão "voltar" do Android fecha o app em vez de voltar de tela).
- Menu lateral só tem Perfil/Configurações/Sair: nenhuma ferramenta é acessível pelo menu em celular.
- `#phone` (Automação Android) existe e hoje é alcançável pelo menu (`navigate('phone')` e hash `#phone`); a tela, porém, é apenas informativa — não tem lógica nem integrações.

## Plano de correção

1. **Roteador único** (`navigate(screen)`): uma função para todas as trocas de tela, com histórico interno, sincronização de `location.hash` e `hashchange` (botão voltar do celular), fechamento do menu e `backButton` coerente.
2. **Tela `#video-ai` = Vídeos com IA**: mover o bloco `#videoGenerator` para essa seção e dar a ela cabeçalho próprio. Card "Vídeos com IA" passa a abrir o gerador.
3. **Tela `#video` = Roteiro inteligente**: apenas montagem/cópia/download de roteiro. "Enviar para Vídeos com IA" passa a navegar para `#video-ai` e preencher o prompt.
4. **Nova seção `#projects` = Organização de projetos**: recebe acesso (login/cadastro), lembretes/tarefas e Central comercial (oportunidades e clientes) — nada é removido. O card "Organização de projetos" passa a abrir essa seção.
5. **Blindagem da autenticação**: trocar ascessos diretos a `#clients` por helpers tolerantes a nulo; `updateAuthUI()` deixa de esconder a seção de projetos (a visibilidade fica só com o roteador) e passa a preencher o e-mail do perfil.
6. **Remover duplicações**: `#osvyra-chat` inicia oculto; binding único e delegado de `[data-target]`; remover seletor morto; eliminar a escrita dupla de status em `sendToVideo`; adicionar itens de ferramentas ao menu lateral para navegação em celular.
7. **Teste de regressão** (`tests/navegacao.test.mjs`): valida que todo `data-target` tem seção correspondente, que não há IDs duplicados, e (com navegador) que cada card abre a tela correta, que só um painel fica visível, que o chat não aparece na home, que "Enviar para Vídeos com IA" leva ao gerador e que o botão voltar retorna à tela anterior, sem erros de console.

## Causa raiz adicional encontrada pelo teste de regressão

`getCurrentUser()` era chamado em **8 pontos** (carregar/salvar lembretes, carregar/salvar oportunidades, salvar/excluir clientes e contadores do CRM) e **nunca havia sido definido**. Toda chamada lançava `ReferenceError: getCurrentUser is not defined`, o que abortava `loadTasks()`, `loadLeads()` e `loadCustomers()` dentro de `updateAuthUI()` — ou seja, a tela de projetos abria sem tarefas, sem CRM e com o contador vazio. A função foi definida com `supabaseClient.auth.getSession()`, preservando a sessão e a tabela original.

## Correções aplicadas (branch `osvyra-v1-rebuild`)

- `#video-ai` agora é a tela **Vídeos com IA**, com o gerador (`#videoGenerator`, `#videoPrompt`, `#videoDuration`, `#videoFormat`, `#prepareVideo`, `#videoStatus`).
- `#video` agora é a tela **Roteiro inteligente** (montagem, cópia, download e envio).
- Nova tela **`#projects`** concentra acesso (login/cadastro), lembretes/tarefas e Central comercial (oportunidades e clientes). O card "Organização de projetos" abre essa tela.
- Roteador único `navigate()` com histórico interno, `location.hash`, `popstate`/`hashchange` e botão "Voltar" funcional no celular.
- `#osvyra-chat` inicia oculto; binding único e delegado de `[data-target]`/`[data-screen]`; removido o seletor morto `.tile`; `sendToVideo` com uma única mensagem de status; menu lateral ganhou atalhos para todas as ferramentas.
- Removidas as referências a `#clients` (id inexistente) em `showLandingLogin()` e `updateAuthUI()`.
- Supabase, autenticação, banco, CRM, tarefas, chat, perfil, configurações e estúdio de imagens preservados.

## Verificação

`node tests/navegacao.test.mjs` — **39/39 verificações aprovadas**, incluindo navegador em viewport de celular (390×844) com sessão Supabase simulada: cada card abre somente a sua tela, Roteiro e Vídeos com IA separados, envio de roteiro abre o gerador, voltar do navegador retorna à home e nenhum erro de JavaScript.

---

# Diagnóstico: Lembretes e tarefas

## Sintoma relatado

Login e Central comercial funcionam (oportunidades e clientes carregam), mas a seção **Lembretes e tarefas** mostra "Erro ao carregar lembretes" e o salvamento também falha.

## Causa encontrada (verificada no banco)

O código usa `.from("osvyra_tasks")` com as colunas `id, title, description, status, scheduled_at, result`, filtrando por `user_id = usuário autenticado`. Consulta direta ao PostgREST do projeto (`GET /rest/v1/osvyra_tasks?select=id,title,description,status,scheduled_at,result`) devolveu:

```json
{"code":"42501","message":"permission denied for table osvyra_tasks",
 "hint":"Grant the required privileges to the current role with: GRANT SELECT ON public.osvyra_tasks TO anon;"}
```

Interpretação:

1. **A tabela existe** em `public` — o nome e as colunas usados pelo código estão corretos, nada foi inventado.
2. **O papel da API não tem privilégio nela.** Com RLS ativa e grants corretos, uma leitura sem sessão devolveria `200 []`; `42501 permission denied for table` significa que falta `GRANT` para o papel `authenticated` (e/ou políticas).
3. As tabelas `opportunities` e `customers` funcionam porque possuem grants e políticas RLS — a `osvyra_tasks` foi criada sem essa configuração.
4. O cliente **engolia a causa**: `loadTasks()` e o salvamento exibiam apenas "Erro ao carregar lembretes." / "Erro ao salvar lembrete." e descartavam `error.message`/`error.code`.
5. Não havia nenhum `UPDATE` de tarefas no código, portanto a política de UPDATE nunca existiu nem era exercitada.

Observação de transparência: a listagem remota de colunas (spec OpenAPI) exige chave secreta, então não foi possível confirmar coluna por coluna; o conjunto de colunas foi mantido exatamente como o código original já usava, e qualquer divergência agora aparece na tela com o código do erro.

## Alterações realizadas

- **Erros reais expostos**: `describeSupabaseError()` e `reportTaskError()` mostram `message`, `code` e `details`, registram o erro completo no console e indicam o arquivo SQL de correção.
- **Validação de data/horário**: `parseScheduleValue()` converte o campo `datetime-local` sem lançar `RangeError`; título, data e formato são validados antes de qualquer chamada ao Supabase.
- **Lista de lembretes**: estado "Carregando...", renderização com status traduzido (Pendente/Concluída) e data em pt-BR.
- **Conclusão de tarefa (UPDATE)**: botão "Concluir" executa `update({status:'completed'})` com `.eq('id').eq('user_id').select('id')` e confirma se a linha foi realmente alterada — sem isso, um UPDATE bloqueado por RLS passaria silenciosamente. O valor `completed` é o aceito pela constraint `osvyra_tasks_status_check` (a tabela aceita `pending`, `running`, `completed`, `failed`, `cancelled`); enviar `done` causava o erro `23514` "violates check constraint".
- **Migração `supabase/osvyra_tasks_rls.sql`** (idempotente, executar no SQL Editor): garante `enable row level security`, concede `select, insert, update` ao papel `authenticated` e cria as três políticas `auth.uid() = user_id`. **O RLS nunca é desativado.**
- Login, CRM, oportunidades, clientes, chat, perfil, configurações e estúdio de imagens preservados.

## Testes de leitura e gravação

`node tests/lembretes.test.mjs` — **34/34 verificações aprovadas**, com stub do Supabase em viewport de celular:

| Cenário | Resultado |
|---|---|
| Leitura bloqueada (42501) | mostra `permission denied for table osvyra_tasks`, o código e o arquivo SQL |
| Leitura com sucesso | lista renderizada, status Pendente/Concluída, data em pt-BR, sem erro |
| Gravação com sucesso | INSERT em `osvyra_tasks` com `user_id` da sessão, `status: pending` e `scheduled_at` ISO válido + confirmação |
| Gravação bloqueada (42501) | mensagem real do Supabase exibida |
| Validação | título vazio e data vazia bloqueados sem chamar o Supabase |
| UPDATE | conclui lembrete com `status: completed` (aceito pela constraint) e confirma a linha alterada |
| Migração | RLS ativo (sem `disable`), grant ao `authenticated`, 3 políticas por usuário |

Regressão de navegação: `node tests/navegacao.test.mjs` — **39/39 aprovadas**.
