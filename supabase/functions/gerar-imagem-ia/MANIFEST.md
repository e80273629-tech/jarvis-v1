# MANIFEST — Edge Function `gerar-imagem-ia`

## Origem do código

O conteúdo de `index.ts` foi **reconstruído pelo próprio usuário** a partir de três
partes que ele havia copiado do painel do Supabase (Dashboard → Edge Functions →
`gerar-imagem-ia` → Code). Essas três partes foram enviadas a este repositório como
o arquivo anexo `gerar-imagem-ia.txt`.

Esse arquivo recebido foi copiado para `supabase/functions/gerar-imagem-ia/index.ts`
**sem qualquer alteração de conteúdo** — não houve reformatação, reindentação,
correção de lógica nem "melhoria" de nenhum trecho.

| Item | Valor |
| --- | --- |
| Arquivo recebido | `gerar-imagem-ia.txt` (anexo da conversa) |
| Tamanho / linhas | 5.758 bytes / 215 linhas |
| SHA-256 do arquivo recebido | `1fdb4c14432800f47b32b7d78054e0588abf73ba6df82e8e6a55e780e32faa5f` |
| SHA-256 da cópia versionada | `1fdb4c14432800f47b32b7d78054e0588abf73ba6df82e8e6a55e780e32faa5f` |
| Comparação `cmp` | idênticos byte a byte |

Como o `.txt` recebido e o `index.ts` versionado têm o mesmo SHA-256, o hash acima
serve para reconferir a integridade a qualquer momento: basta rodar
`sha256sum supabase/functions/gerar-imagem-ia/index.ts`.

## Ressalva de fidelidade (importante)

**A igualdade byte a byte entre esta cópia versionada e a função atualmente
publicada no Supabase NÃO foi comprovada.**

Motivos:

1. A cópia veio de um arquivo montado manualmente pelo usuário a partir de três
   trechos colados, não de um download direto do runtime publicado.
2. Não há, neste ambiente, acesso ao painel do Supabase nem ao código implantado
   (nenhuma credencial Supabase está configurada).
3. O `gerar-imagem-ia.txt` foi lido exatamente como recebido, mas nada garante que
   a soma dos três trechos reproduza o arquivo publicado — pode haver trecho
   omitido, duplicado ou fora de ordem.

Consequência prática: esta cópia é uma **referência de leitura confiável da
lógica**, não uma prova do que está em produção. Para fechar essa lacuna, o
caminho é `supabase functions download gerar-imagem-ia` (ou copiar o arquivo
integral do painel de uma só vez) e comparar o SHA-256 com o valor acima.

## Verificações executadas nesta cópia

Todas foram feitas sobre o arquivo versionado, sem executar a função:

| Verificação | Resultado |
| --- | --- |
| Sintaxe (TypeScript Compiler, `--noResolve`) | **0 erros de sintaxe** (nenhum `TS1xxx`) |
| Chaves `{ }` | 54 aberturas / 54 fechamentos |
| Parênteses `( )` | 68 aberturas / 68 fechamentos |
| Colchetes `[ ]` | 0 / 0 |
| Handler `Deno.serve` | presente, com tratamento de `OPTIONS` (CORS) |
| Autenticação | exige `Authorization: Bearer`, valida em `${SUPABASE_URL}/auth/v1/user`, retorna 401 se ausente/inválida |
| Validação de entrada | `prompt` obrigatório (400), limite de 2.000 caracteres (400) |
| Débito de crédito | RPC `consume_image_credit` via `/rest/v1/rpc/`, com `p_user_id` |
| Créditos insuficientes | HTTP **402** quando a resposta contém `CRÉDITOS_INSUFICIENTES` |
| Integração Cloudflare | `POST https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`, header `Authorization: Bearer` |
| Variáveis de ambiente | `SUPABASE_URL`, `SUPABASE_SECRET_KEYS`, `SUPABASE_PUBLISHABLE_KEYS`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Resposta de sucesso | `data:image/png;base64,<image>` + `creditsRemaining` |
| Estorno | RPC `refund_image_credit` no `catch`, condicionado a `charged && userId && adminKey && supabaseUrl` |
| Segredos hardcoded | nenhum encontrado |

Os erros `TS2304`/`TS7006` do compilador referem-se apenas à ausência dos tipos do
Deno neste ambiente (`Cannot find name 'Deno'`) e não indicam problema no código.

## Configuração de deploy

`supabase/config.toml` declara a função:

```toml
[functions.gerar-imagem-ia]
verify_jwt = true
```

Essa é a configuração **do repositório** para um futuro `supabase functions deploy`.
Ela não foi conferida contra a configuração real do painel, e não publica nada por
si só — não existe CI/CD neste repositório.

## O que este commit NÃO faz

- Não faz deploy nem publica a função.
- Não altera banco de dados, tabelas, RLS, RPCs ou autenticação.
- Não altera a lógica da função.
- Não toca na branch `main`.
