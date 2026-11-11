# MANIFEST — Edge Function `gerar-video-ia`

## Origem do código

Escrito especificamente para a OSVYRA nesta etapa. **Não** é cópia de código do
painel do Supabase (diferente de `gerar-imagem-ia`, cujo `MANIFEST.md` registra
uma captura do painel). Não houve versão anterior publicada desta função, então
não existe comparação byte a byte a fazer: o arquivo versionado é a fonte.

## Status

| Item | Estado |
|---|---|
| Versionado no Git | sim (`osvyra-v1-rebuild`) |
| Publicado no Supabase | **não** — aguardando aprovação do usuário |
| Geração real executada | **não** |
| Cota do Hugging Face consumida | **não** |
| Créditos de imagem afetados | **não** |

## O que a função faz

Quatro ações, todas exigindo usuário autenticado (`verify_jwt = true`):

| Ação | Efeito | Consome cota do ZeroGPU? |
|---|---|---|
| `health` | Devolve `hasToken` **booleano**, `space`, `durations`, `formats` | não |
| `probe` | Valida o token em `/api/whoami-v2` e o alcance do Space em `/gradio_api/info` | **não** |
| `submit` | Envia o prompt para a fila e devolve `eventId` | sim |
| `poll` | Lê o SSE do Gradio e devolve `pending`, `complete` ou `error` | não (consulta) |

## Por que `submit` e `poll` são separados

A Edge Function tem limite de wall-clock e a fila gratuita do ZeroGPU pode levar
minutos. Uma chamada única estouraria o limite. `poll` segura o SSE por no
máximo 20 segundos e devolve `pending` se a geração ainda não terminou; o
cliente repete.

## Parâmetros e limites reais do modelo

O Space `Lightricks/ltx-video-distilled` aceita `duration_ui` de 0,3 a 8,5 s e
`ui_frames_to_use` de 9 a 257 em passos de 8. Por isso a interface oferece
**2, 5 e 8 segundos** — a opção "10 segundos" que existia antes era impossível.

| Formato | Dimensões | Observação |
|---|---|---|
| 9:16 | 512 × 704 | vertical |
| 16:9 | 704 × 512 | default do Space, menor risco |
| 1:1 | 512 × 512 | quadrado |

Todas as dimensões são múltiplos de 32 e ficam dentro de 256–1280.

`mode` é enviado explicitamente como `"text-to-video"`. O default do Space é
`"image-to-video"`, que falharia sem imagem de entrada. `improve_texture` fica
`false` para poupar cota.

## Variáveis de ambiente necessárias (Supabase Secrets)

| Nome | Para que serve | Origem |
|---|---|---|
| `HF_TOKEN` | autenticar no Hugging Face e no Space | já configurado pelo usuário |
| `SUPABASE_URL` | validar o Bearer token em `/auth/v1/user` | automático no Supabase |
| `SUPABASE_PUBLISHABLE_KEYS` | header `apikey` da validação | automático no Supabase |

`HF_TOKEN` é lido **apenas** via `Deno.env.get("HF_TOKEN")`. Nenhum segredo é
literal no arquivo e nenhum valor é devolvido ao cliente — `health` retorna só
`hasToken: true/false`, sem trecho, sem prefixo e sem comprimento.

## Custo

Zero. O ZeroGPU concede **5 minutos de GPU por dia** para a conta gratuita.
Essa cota é compartilhada por toda a plataforma e não é ampliável sem plano pago.
Nenhum serviço pago foi adicionado: a Cloudflare Wan 3.0 foi vetada e não é usada.

Estimativa honesta, não medida: um vídeo de 2 s (~49 frames) em 704×512 deve
consumir poucos segundos de GPU; 5 s (~121 frames) e 8 s (~193 frames) consomem
proporcionalmente mais e podem esgotar a cota diária em poucas tentativas.

## Limitações conhecidas

1. Depende de um Space mantido por terceiros (Lightricks). Se ele mudar de nome,
   de assinatura de endpoint ou sair do ar, a integração para.
2. A cota gratuita é global: um usuário pode esgotar o dia para todos.
3. Arquivos do Gradio são temporários. Por isso a função embute o vídeo como
   `data:video/mp4;base64` quando ele tem até 6 MB; acima disso devolve apenas a
   URL, que pode expirar.
4. O histórico é local (IndexedDB, 5 vídeos por usuário) e **não sincroniza**
   entre dispositivos.
5. Nenhum crédito é cobrado nesta fase. A quantidade de créditos por vídeo fica
   para uma etapa posterior, por decisão do usuário.
6. `probe` valida token e alcance, mas não prova que a GPU está disponível na
   fila.

## Como verificar sem consumir cota

Depois de publicar a função (passo manual, não feito ainda):

```bash
curl -X POST "https://<projeto>.supabase.co/functions/v1/gerar-video-ia" \
  -H "Authorization: Bearer <jwt-do-usuario>" \
  -H "Content-Type: application/json" \
  -d '{"action":"health"}'
```

Retorno esperado, sem nenhum dado do token:

```json
{ "success": true, "hasToken": true, "space": "Lightricks/ltx-video-distilled",
  "durations": [2, 5, 8], "formats": ["9:16", "16:9", "1:1"] }
```

Em seguida `{"action":"probe"}` confirma token válido e Space acessível, ainda
sem gerar nada.

## Publicação (não executada)

```bash
supabase functions deploy gerar-video-ia --project-ref <ref>
```

Comando manual. Não existe CI/CD neste repositório.
