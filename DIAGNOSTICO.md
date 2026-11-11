# OSVYRA — Diagnóstico de navegação e plano de correção

Branch analisada: `osvyra-v1-rebuild`. Nenhuma alteração de código foi feita na etapa de análise.

## Arquitetura encontrada

- `index.html` — aplicação PWA completa (HTML + CSS + JS inline, ~2.900 linhas). Tela única com troca de `<section class="panel">` por JavaScript.
- `index.ts` — Edge Function `osvyra-chat` (Supabase), usada pelo chat da página.
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
- `#phone` (Automação Android) existe e não é alcançável por nenhum caminho de navegação.

## Plano de correção

1. **Roteador único** (`navigate(screen)`): uma função para todas as trocas de tela, com histórico interno, sincronização de `location.hash` e `hashchange` (botão voltar do celular), fechamento do menu e `backButton` coerente.
2. **Tela `#video-ai` = Vídeos com IA**: mover o bloco `#videoGenerator` para essa seção e dar a ela cabeçalho próprio. Card "Vídeos com IA" passa a abrir o gerador.
3. **Tela `#video` = Roteiro inteligente**: apenas montagem/cópia/download de roteiro. "Enviar para Vídeos com IA" passa a navegar para `#video-ai` e preencher o prompt.
4. **Nova seção `#projects` = Organização de projetos**: recebe acesso (login/cadastro), lembretes/tarefas e Central comercial (oportunidades e clientes) — nada é removido. O card "Organização de projetos" passa a abrir essa seção.
5. **Blindagem da autenticação**: trocar ascessos diretos a `#clients` por helpers tolerantes a nulo; `updateAuthUI()` deixa de esconder a seção de projetos (a visibilidade fica só com o roteador) e passa a preencher o e-mail do perfil.
6. **Remover duplicações**: `#osvyra-chat` inicia oculto; binding único e delegado de `[data-target]`; remover seletor morto; eliminar a escrita dupla de status em `sendToVideo`; adicionar itens de ferramentas ao menu lateral para navegação em celular.
7. **Teste de regressão** (`tests/navegacao.test.mjs`): valida que todo `data-target` tem seção correspondente, que não há IDs duplicados, e (com navegador) que cada card abre a tela correta, que só um painel fica visível, que o chat não aparece na home, que "Enviar para Vídeos com IA" leva ao gerador e que o botão voltar retorna à tela anterior, sem erros de console.
