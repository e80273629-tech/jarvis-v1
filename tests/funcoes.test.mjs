#!/usr/bin/env node
/**
 * tests/funcoes.test.mjs — Verificação estrutural das Edge Functions da OSVYRA.
 *
 * Por que existe: as Edge Functions vivem no painel do Supabase e precisam ser
 * versionadas no Git. Antes de confiar numa cópia, este script confere que o
 * arquivo é sintaticamente válido e que preserva as peças obrigatórias do fluxo
 * (autenticação, débito de crédito, chamada Cloudflare, estorno).
 *
 * O que verifica, para cada supabase/functions/<nome>/index.ts:
 *   1. SINTAXE — roda o TypeScript Compiler com --noResolve. Somente erros
 *      TS1xxx são tratados como falha de sintaxe (blocos/chaves não fechados).
 *      Erros TS2xxx do tipo "Cannot find name 'Deno'" são esperados fora do
 *      runtime Deno e são ignorados de propósito.
 *   2. ESTRUTURA — handler Deno.serve, cabeçalhos CORS, leitura de configuração
 *      via Deno.env.get (nunca literal).
 *   3. SEGREDOS — ausência de JWT, chaves sk-..., service_role, Bearer literal
 *      e account id Cloudflare hardcoded.
 *   4. CONFIG — a pasta da função está declarada em supabase/config.toml.
 *
 * Para gerar-imagem-ia confere ainda as quatro peças do fluxo de créditos:
 * autenticação do usuário, débito (consume_image_credit), geração via Cloudflare
 * e estorno (refund_image_credit).
 *
 * Uso:   node tests/funcoes.test.mjs
 * Saída: 0 = todas as verificações aplicáveis passaram.
 *        1 = falha real.
 * Uma função declarada no config.toml mas ainda sem arquivo é reportada como
 * PENDENTE (não é falha): significa que a captura do código ainda não chegou.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const FN_ROOT = 'supabase/functions';
const CONFIG = 'supabase/config.toml';

let pass = 0;
let fail = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) {
    pass++;
    console.log(`PASS — ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`FAIL — ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}

function info(msg) {
  console.log(`INFO — ${msg}`);
}

// ---------------------------------------------------------------- descoberta
if (!existsSync(FN_ROOT)) {
  console.log(`FAIL — pasta ${FN_ROOT} ausente`);
  process.exit(1);
}

const dirs = readdirSync(FN_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

check(dirs.length > 0, 'Existe pelo menos uma Edge Function versionada');

const config = existsSync(CONFIG) ? readFileSync(CONFIG, 'utf8') : '';
const declared = [...config.matchAll(/\[functions\.([A-Za-z0-9_-]+)\]/g)].map((m) => m[1]);

check(declared.length > 0, 'config.toml declara as funções');

// ------------------------------------------------ sintaxe via TypeScript Compiler
function syntaxErrors(file) {
  const args = [
    '--noEmit',
    '--noResolve',
    '--skipLibCheck',
    '--target',
    'es2022',
    '--module',
    'esnext',
    '--moduleResolution',
    'bundler',
    file,
  ];
  try {
    execFileSync('tsc', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return [];
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /error TS1\d{3}/.test(l));
  }
}

// ------------------------------------------------------------- segredos
const SECRET_PATTERNS = [
  { name: 'JWT hardcoded (eyJ...)', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'chave sk-... hardcoded', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  {
    name: 'service_role atribuído a literal',
    re: /(SERVICE_ROLE|service_role)[A-Za-z_]*\s*[:=]\s*['"][^'"]{20,}['"]/g,
  },
  {
    name: 'token/api_key/secret atribuído a literal',
    re: /\b(api[_-]?key|apiKey|secret|password)\b\s*[:=]\s*['"][A-Za-z0-9_\-.]{20,}['"]/g,
  },
  { name: 'Bearer com token literal', re: /Bearer\s+[A-Za-z0-9_\-.]{20,}/g },
  {
    name: 'account id Cloudflare hardcoded',
    re: /(account[_-]?id|accountId)\s*[:=]\s*['"][0-9a-f]{32}['"]/gi,
  },
];

function findSecrets(src) {
  const found = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const matches = src.match(re);
    if (matches) found.push(`${name} (${matches.length}x)`);
  }
  return found;
}

// ------------------------------------------------------- checagens por função
const REQUIREMENTS = {
  'gerar-imagem-ia': [
    ['autenticação do usuário', /auth\.getUser|getUser\(|Authorization/i],
    ['débito de crédito', /consume_image_credit/],
    ['estorno de crédito', /refund_image_credit/],
    ['geração via Cloudflare', /cloudflare\.com|CLOUDFLARE_/i],
    ['retorno HTTP 402', /\b402\b/],
    ['imagem no corpo da resposta', /\bimage\s*:/],
  ],
  'gerar-video-ia': [
    ['autenticação do usuário', /auth\/v1\/user/],
    ['token do Hugging Face lido do ambiente', /Deno\.env\.get\(\s*["']HF_TOKEN["']\s*\)/],
    ['Space oficial LTX-Video', /Lightricks\/ltx-video-distilled/],
    ['modo text-to-video explícito', /"text-to-video"/],
    ['submit devolve eventId', /eventId/],
    ['poll lê o SSE do Gradio', /text\/event-stream/],
    ['probe usa /gradio_api/info sem gerar', /gradio_api\/info/],
    ['duração inválida é rejeitada', /Duração inválida/],
  ],
};

for (const name of declared) {
  const file = join(FN_ROOT, name, 'index.ts');
  if (!existsSync(file)) {
    info(`PENDENTE — ${name}: pasta declarada no config.toml mas ${file} ainda não existe`);
    continue;
  }

  const src = readFileSync(file, 'utf8');
  console.log(`\n--- ${name} (${src.split('\n').length} linhas) ---`);

  check(src.trim().length > 200, `${name}: arquivo não está vazio`);

  const syn = syntaxErrors(file);
  check(syn.length === 0, `${name}: sintaxe válida (chaves e blocos fechados)`, syn.slice(0, 3).join(' | '));

  check(/Deno\.serve\s*\(/.test(src), `${name}: handler Deno.serve presente`);
  check(/corsHeaders/i.test(src), `${name}: cabeçalhos CORS definidos`);
  check(/Access-Control-Allow-Origin/i.test(src), `${name}: CORS libera Origin`);

  const envVars = [...src.matchAll(/Deno\.env\.get\(\s*['"]([A-Z0-9_]+)['"]/g)].map((m) => m[1]);
  check(envVars.length > 0, `${name}: configuração lida via Deno.env.get`);
  if (envVars.length) info(`${name}: variáveis de ambiente usadas -> ${[...new Set(envVars)].join(', ')}`);

  const secrets = findSecrets(src);
  check(secrets.length === 0, `${name}: nenhum segredo hardcoded`, secrets.join(' | '));

  for (const [label, re] of REQUIREMENTS[name] || []) {
    check(re.test(src), `${name}: ${label}`);
  }
}

// -------------------------------------------------- pastas órfãs no repositório
for (const d of dirs) {
  check(declared.includes(d), `config.toml declara a função ${d}`);
}

// --------------------------------------- invariantes da função de vídeo
//
// Estas regras não são "estilo": cada uma protege uma decisão explícita do
// utilizador (custo zero, sem créditos de imagem, sem vazar o token).
const VIDEO_FN = join(FN_ROOT, 'gerar-video-ia', 'index.ts');

if (existsSync(VIDEO_FN)) {
  const videoSrc = readFileSync(VIDEO_FN, 'utf8');
  console.log('\n--- invariantes de gerar-video-ia ---');

  check(
    !/consume_image_credit|refund_image_credit|user_credits/.test(videoSrc),
    'gerar-video-ia: não toca nos créditos de imagem'
  );

  check(
    /hasToken\s*:\s*(hfToken\.length|Boolean\()/.test(videoSrc),
    'gerar-video-ia: health devolve hasToken como booleano'
  );

  check(
    !/tokenPreview|hfToken\.slice|hfToken\.substring|hfToken\.charAt/.test(videoSrc),
    'gerar-video-ia: health não expõe trecho, prefixo ou comprimento do token'
  );

  check(
    /const ALLOWED_DURATIONS = \[2, 5, 8\];/.test(videoSrc),
    'gerar-video-ia: durações oferecidas são 2, 5 e 8 segundos'
  );

  check(
    !/ALLOWED_DURATIONS\s*=\s*\[[^\]]*\b10\b/.test(videoSrc),
    'gerar-video-ia: não oferece 10s (o máximo do modelo é 8,5s)'
  );

  check(
    /improve_texture|\bfalse\b[\s\S]{0,40}seed/.test(videoSrc) || /poupar cota/.test(videoSrc),
    'gerar-video-ia: documenta a economia de cota'
  );

  check(
    /AbortController/.test(videoSrc) && /AbortError/.test(videoSrc),
    'gerar-video-ia: poll tem timeout e trata abort como pendente'
  );
}

// ------------------------------------------------------------------ resultado
console.log('');
if (fail > 0) {
  console.log(`${pass}/${pass + fail} verificações aprovadas.`);
  console.log(`FALHAS: ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`${pass}/${pass + fail} verificações aprovadas.`);
