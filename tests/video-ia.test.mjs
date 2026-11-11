#!/usr/bin/env node
/**
 * tests/video-ia.test.mjs — Regressão do módulo "Vídeos com IA" da OSVYRA.
 *
 * Por que existe: a tela #video-ai era 100% demonstrativa (o botão só escrevia
 * texto e nenhuma chamada de rede acontecia). Ao conectar a geração real com o
 * Space Lightricks/ltx-video-distilled, três riscos passaram a existir:
 *
 *   1. GASTAR COTA — o ZeroGPU dá apenas 5 minutos de GPU por dia para toda a
 *      plataforma. Um teste automatizado que disparasse uma geração real
 *      queimaria a cota do usuário. Este arquivo NUNCA permite isso: toda
 *      requisição fora do servidor local é abortada e registrada, e ao final o
 *      teste falha se qualquer URL do Hugging Face tiver sido tentada.
 *
 *   2. GERAR SEM CONFIRMAÇÃO — a chamada externa só pode acontecer depois do
 *      botão "Confirmar geração". O teste verifica que, ao clicar em "Gerar
 *      vídeo", nenhuma invocação da Edge Function aconteceu ainda.
 *
 *   3. OFERECER DURAÇÃO IMPOSSÍVEL — a interface antiga oferecia 10s, mas o
 *      modelo aceita no máximo 8,5s. O teste trava 2s/5s/8s.
 *
 * A Edge Function em si é substituída por um stub, então nenhum vídeo é gerado,
 * nenhuma GPU é usada e nenhum crédito de imagem é tocado.
 *
 * Uso: node tests/video-ia.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

let passed = 0;
const failures = [];

function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failures.push(label);
    console.log(`  \u2717 ${label}`);
  }
}

/* ================================================================== */
/* 1. Checagens estáticas (não precisam de navegador)                 */
/* ================================================================== */

console.log('\n--- estrutura da tela #video-ai ---');

const videoStart = html.indexOf('<section id="video-ai"');
const videoEnd = html.indexOf('</section>', videoStart);
const videoSection = videoStart > -1 ? html.slice(videoStart, videoEnd) : '';

check('A tela #video-ai existe', videoStart > -1);
check('O gerador #videoGenerator está dentro da tela', videoSection.includes('id="videoGenerator"'));

/* Durações reais do modelo: 2, 5 e 8 segundos. */
const durationBlock = /<select id="videoDuration">([\s\S]*?)<\/select>/.exec(videoSection);
const durationValues = durationBlock
  ? [...durationBlock[1].matchAll(/value="(\d+)"/g)].map(match => match[1])
  : [];

check(
  'Durações oferecidas são exatamente 2s, 5s e 8s',
  durationValues.length === 3 &&
    durationValues.join(',') === '2,5,8'
);
check('A duração impossível de 10s não é mais oferecida', !durationValues.includes('10'));
check(
  'A duração padrão do primeiro teste é 2s',
  /<option value="2"[^>]*selected/.test(durationBlock ? durationBlock[1] : '') ||
    (durationBlock !== null && !/selected/.test(durationBlock[1]))
);

const formatValues = [...(/<select id="videoFormat">([\s\S]*?)<\/select>/.exec(videoSection) || [, ''])[1]
  .matchAll(/value="([^"]+)"/g)].map(match => match[1]);

check(
  'Formatos oferecidos são 9:16, 16:9 e 1:1',
  formatValues.join(',') === '9:16,16:9,1:1'
);
check('O formato padrão é 16:9 (default do modelo)', /<option value="16:9"[^>]*selected/.test(videoSection));

check('O botão "Gerar vídeo" existe', videoSection.includes('id="generateVideo"'));
check('O botão "Verificar serviço" existe', videoSection.includes('id="videoProbe"'));
check('A confirmação explícita existe', videoSection.includes('id="videoConfirmYes"'));
check('O cancelamento da confirmação existe', videoSection.includes('id="videoConfirmNo"'));
check('O player do resultado existe', videoSection.includes('id="videoPlayer"'));
check('O download do resultado existe', videoSection.includes('id="videoDownload"'));
check('O histórico local existe', videoSection.includes('id="videoHistory"'));
check(
  'A tela avisa que o histórico não sincroniza',
  /n\u00e3o sincronizam entre dispositivos/i.test(videoSection)
);

console.log('\n--- limites e custo ---');

check('O histórico local é limitado a 5 vídeos por usuário', /const VIDEO_HISTORY_LIMIT = 5;/.test(html));
check(
  'A tela informa que nenhum crédito de imagem é usado',
  /nenhum cr\u00e9dito de imagem/i.test(videoSection)
);
check(
  'A tela informa a cota gratuita do ZeroGPU',
  /5 minutos de GPU por dia/i.test(videoSection)
);

/* A tela de vídeos não pode chamar a função de imagens. */
const videoJsStart = html.indexOf('VÍDEOS COM IA — geração real');
const videoJsEnd = html.indexOf('ENVIAR ROTEIRO PARA VÍDEOS COM IA', videoJsStart);
const videoJs = videoJsStart > -1 ? html.slice(videoJsStart, videoJsEnd) : '';

check('A lógica de vídeo foi extraída do handler demonstrativo', videoJs.length > 2000);
check(
  'A lógica de vídeo não chama a Edge Function de imagens',
  !/gerar-imagem-ia/.test(videoJs)
);
check(
  'A lógica de vídeo não referencia créditos de imagem',
  !/consume_image_credit|user_credits/.test(videoJs)
);
check(
  'A geração só acontece após confirmação explícita',
  /videoEl\.generate\.addEventListener[\s\S]{0,900}videoEl\.confirm\.hidden = false/.test(videoJs) &&
    /videoEl\.confirmYes\.addEventListener[\s\S]{0,400}videoGenerate\(pending\)/.test(videoJs)
);
check(
  'O botão "Gerar vídeo" não invoca a Edge Function diretamente',
  !/videoEl\.generate\.addEventListener[^]*?\n\}\);/.test(
    /videoEl\.generate\.addEventListener[^]*?\n\}\);/.exec(videoJs)?.[0]?.replace(/videoInvoke/g, 'NAO_PERMITIDO') || ''
  ) || !/videoInvoke/.test(/videoEl\.generate\.addEventListener[^]*?\n\}\);/.exec(videoJs)?.[0] || '')
);
check(
  'O progresso usa o estado real do poll, não animação falsa',
  /async function videoPollUntilDone[\s\S]{0,900}data\.status === 'complete'/.test(videoJs)
);

console.log('\n--- Edge Function gerar-video-ia ---');

const fnPath = join(root, 'supabase/functions/gerar-video-ia/index.ts');
const fnSrc = existsSync(fnPath) ? readFileSync(fnPath, 'utf8') : '';
const configSrc = readFileSync(join(root, 'supabase/config.toml'), 'utf8');

check('A Edge Function existe no repositório', fnSrc.length > 0);
check('A função está declarada no config.toml', /\[functions\.gerar-video-ia\]/.test(configSrc));
check(
  'A função exige usuário autenticado (verify_jwt = true)',
  /\[functions\.gerar-video-ia\]\s*\nverify_jwt = true/.test(configSrc)
);

const healthBlock = /if \(action === "health"\) \{([\s\S]{0,800}?)\n    \}/.exec(fnSrc)?.[1] || '';

check('A ação health existe', healthBlock.length > 0);
check('health devolve hasToken booleano', /hasToken:\s*hfToken\.length > 0|hasToken:\s*Boolean\(hfToken\)/.test(healthBlock));
check(
  'health NÃO devolve trecho, prefixo ou comprimento do token',
  !/tokenPreview|hfToken\.slice|hfToken\.substring|hfToken\.charAt|\.length\b(?![^,}]*>)/.test(
    healthBlock.replace(/hasToken:[^,\n]*/, '')
  )
);

check('O token é lido apenas de Deno.env', /Deno\.env\.get\(\s*["']HF_TOKEN["']\s*\)/.test(fnSrc));
check(
  'Nenhum token do Hugging Face está hardcoded',
  !/hf_[A-Za-z0-9]{20,}/.test(fnSrc) && !/Bearer\s+hf_/.test(fnSrc)
);
check(
  'Nenhuma chave service_role está hardcoded',
  !/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}/.test(fnSrc)
);
check('A função não toca em créditos de imagem', !/consume_image_credit|refund_image_credit|user_credits/.test(fnSrc));
check('A função não usa a Cloudflare paga', !/cloudflare\.com|CLOUDFLARE_/i.test(fnSrc));
check('A função valida o usuário autenticado', /auth\/v1\/user/.test(fnSrc));
check('A função envia mode "text-to-video"', /"text-to-video"/.test(fnSrc));
check('A função oferece somente 2, 5 e 8 segundos', /const ALLOWED_DURATIONS = \[2, 5, 8\];/.test(fnSrc));
check('A função rejeita duração fora da lista', /Dura\u00e7\u00e3o inv\u00e1lida/.test(fnSrc));
check('A função separa submit e poll', /action === "submit"/.test(fnSrc) && /action === "poll"/.test(fnSrc));
check('poll lê o SSE do Gradio', /text\/event-stream/.test(fnSrc));
check('A função tem ação probe que não gera', /gradio_api\/info/.test(fnSrc) && /action === "probe"/.test(fnSrc));

/* ================================================================== */
/* 2. Interação em navegador (viewport de celular)                    */
/* ================================================================== */

const SUPABASE_STUB = `
(function () {
  window.__OSVYRA_TEST_CALLS__ = [];

  function queryResult(result) {
    const proxy = new Proxy(function () {}, {
      get(_, prop) {
        if (prop === 'then') return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
        if (prop === 'catch') return reject => Promise.resolve(result).catch(reject);
        return () => proxy;
      },
      apply() { return proxy; }
    });
    return proxy;
  }

  window.supabase = {
    createClient: function () {
      return {
        auth: {
          getSession: async function () {
            return { data: { session: window.__OSVYRA_TEST_SESSION__ || null }, error: null };
          },
          signUp: async function () { return { data: { session: null }, error: null }; },
          signInWithPassword: async function () { return { error: null }; },
          signOut: async function () { return { error: null }; }
        },
        from: function () { return queryResult({ data: [], error: null }); },
        functions: {
          invoke: async function (name, options) {
            const payload = (options && options.body) || {};
            window.__OSVYRA_TEST_CALLS__.push({ name: name, payload: payload });

            if (name !== 'gerar-video-ia') {
              return { data: { answer: 'ok' }, error: null };
            }

            if (payload.action === 'health') {
              return { data: { success: true, hasToken: true, durations: [2, 5, 8] }, error: null };
            }

            if (payload.action === 'probe') {
              return {
                data: { success: true, tokenValid: true, spaceReachable: true },
                error: null
              };
            }

            if (payload.action === 'submit') {
              return { data: { success: true, eventId: 'evt-stub-0001' }, error: null };
            }

            if (payload.action === 'poll') {
              return {
                data: {
                  success: true,
                  status: 'complete',
                  video: 'data:video/mp4;base64,' + window.__OSVYRA_TEST_VIDEO_B64__,
                  sizeBytes: 2048
                },
                error: null
              };
            }

            return { data: { success: false, error: 'ação desconhecida' }, error: null };
          }
        }
      };
    }
  };
})();
`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

const server = createServer((request, response) => {
  const path = decodeURIComponent(request.url.split('?')[0]);
  const filePath = join(root, path === '/' ? 'index.html' : path);
  const extension = filePath.slice(filePath.lastIndexOf('.'));

  try {
    const body = readFileSync(filePath);
    response.writeHead(200, { 'content-type': MIME[extension] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('não encontrado');
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

let chromium;
try {
  const playwright = await import('/opt/appjet/browser/node_modules/playwright/index.js');
  chromium = playwright.chromium || (playwright.default && playwright.default.chromium);

  if (!chromium) throw new Error('export chromium não encontrado');
} catch (error) {
  console.log(`\nSKIP — checagens de navegador indisponíveis: ${error.message}`);
}

const SESSION = { user: { id: 'usuario-video', email: 'video@osvyra.app' } };
const TEST_VIDEO_B64 = Buffer.from('osvyra-stub-video-bytes').toString('base64');
const externalRequests = [];

if (chromium) {
  let browser;

  try {
    browser = await chromium.launch({ args: ['--no-sandbox'] });
  } catch {
    browser = await chromium.launch({
      args: ['--no-sandbox'],
      executablePath: '/opt/appjet/browser-binaries/chromium-1234/chrome-linux64/chrome'
    });
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });

  await context.route('**/*', route => {
    const url = route.request().url();

    if (url.includes('supabase-js')) {
      return route.fulfill({ contentType: 'application/javascript', body: SUPABASE_STUB });
    }

    if (url.startsWith(baseUrl)) return route.continue();

    /* Imagens decorativas da página: servidas localmente para não gerar erros
     * de rede falsos. Não têm relação alguma com a geração de vídeo. */
    if (/images\.unsplash\.com/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: TINY_PNG });
    }

    /* Qualquer destino externo é bloqueado e registrado.
     * É esta lista que prova que nenhuma cota do ZeroGPU foi consumida. */
    externalRequests.push(url);
    return route.abort();
  });

  const page = await context.newPage();

  await page.addInitScript(
    value => {
      window.__OSVYRA_TEST_SESSION__ = value.session;
      window.__OSVYRA_TEST_VIDEO_B64__ = value.video;
    },
    { session: SESSION, video: TEST_VIDEO_B64 }
  );

  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource|ERR_FAILED|net::|ERR_ABORTED/i.test(text)) return;
    consoleErrors.push(`console: ${text}`);
  });

  await page.goto(`${baseUrl}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.getElementById('moduleGrid').classList.contains('hidden'));

  console.log('\n--- navegação até a tela de vídeos ---');

  await page.locator('[data-target="video-ai"]').click();
  await page.waitForFunction(() => !document.getElementById('video-ai').classList.contains('hidden'));

  check('A tela de vídeos abre com o gerador visível', await page.locator('#videoGenerator').isVisible());
  check(
    'A tela de vídeos não mostra a tela de login/CRM',
    !(await page.locator('#projects').isVisible())
  );

  check(
    'O seletor de duração mostra 2, 5 e 8 no navegador',
    (await page.locator('#videoDuration option').evaluateAll(nodes => nodes.map(n => n.value))).join(',') === '2,5,8'
  );

  console.log('\n--- validação e confirmação obrigatória ---');

  await page.locator('#generateVideo').click();
  await page.waitForFunction(() =>
    document.getElementById('videoStatus').textContent.includes('Descreva o vídeo')
  );
  check(
    'Prompt vazio é recusado com mensagem clara',
    (await page.locator('#videoStatus').textContent()).includes('Descreva o vídeo antes de continuar.')
  );

  await page.selectOption('#videoDuration', '2');
  await page.fill('#videoPrompt', 'Um gato astronauta flutuando devagar');
  await page.locator('#generateVideo').click();

  await page.waitForSelector('#videoConfirm:not([hidden])');

  const callsAfterGenerate = await page.evaluate(() => window.__OSVYRA_TEST_CALLS__.length);

  check('A confirmação aparece antes de qualquer ação externa', await page.locator('#videoConfirm').isVisible());
  check('Nenhuma invocação aconteceu ao clicar em "Gerar vídeo"', callsAfterGenerate === 0);
  check(
    'A confirmação explica o custo em cota gratuita',
    (await page.locator('#videoConfirmText').textContent()).includes('ZeroGPU')
  );
  check(
    'A confirmação avisa que créditos de imagem não são usados',
    (await page.locator('#videoConfirmText').textContent()).includes('não utiliza créditos de imagem')
  );

  await page.locator('#videoConfirmNo').click();
  await page.waitForFunction(() =>
    document.getElementById('videoStatus').textContent.includes('cancelada')
  );
  check(
    'Cancelar não envia nada e informa que nenhuma cota foi consumida',
    (await page.locator('#videoStatus').textContent()).includes('nenhuma cota foi consumida')
  );
  check(
    'Após cancelar, nenhuma invocação foi feita',
    (await page.evaluate(() => window.__OSVYRA_TEST_CALLS__.length)) === 0
  );

  console.log('\n--- geração confirmada (com stub, sem cota) ---');

  await page.locator('#generateVideo').click();
  await page.waitForSelector('#videoConfirm:not([hidden])');
  await page.locator('#videoConfirmYes').click();

  await page.waitForSelector('#videoResult:not([hidden])', { timeout: 20000 });
  await page.waitForFunction(() =>
    document.getElementById('videoStatus').textContent.includes('Vídeo pronto')
  );

  const calls = await page.evaluate(() => window.__OSVYRA_TEST_CALLS__);
  const submitCall = calls.find(call => call.payload && call.payload.action === 'submit');
  const pollCall = calls.find(call => call.payload && call.payload.action === 'poll');

  check('A geração envia exatamente uma submissão', calls.filter(c => c.payload?.action === 'submit').length === 1);
  check('A submissão vai para a função gerar-video-ia', submitCall && submitCall.name === 'gerar-video-ia');
  check('A submissão usa a duração de 2 segundos', submitCall?.payload?.duration === 2);
  check('A submissão usa o formato 16:9', submitCall?.payload?.format === '16:9');
  check(
    'A submissão envia o prompt digitado',
    submitCall?.payload?.prompt === 'Um gato astronauta flutuando devagar'
  );
  check('A submissão não envia créditos nem usuário', submitCall && !('credits' in submitCall.payload));
  check('O poll é chamado com o eventId recebido', pollCall?.payload?.eventId === 'evt-stub-0001');

  check(
    'O status confirma que nenhum crédito de imagem foi usado',
    (await page.locator('#videoStatus').textContent()).includes('Nenhum crédito de imagem foi usado')
  );
  check(
    'O player recebe o vídeo gerado',
    (await page.locator('#videoPlayer').getAttribute('src'))?.startsWith('blob:')
  );
  check(
    'O download aponta para o vídeo gerado',
    (await page.locator('#videoDownload').getAttribute('href'))?.startsWith('blob:')
  );

  await page.waitForFunction(() => document.querySelectorAll('#videoHistory .video-history-item').length === 1);
  check(
    'O vídeo entra no histórico local',
    (await page.locator('#videoHistory .video-history-item').count()) === 1
  );
  check(
    'O histórico identifica a duração do vídeo',
    (await page.locator('#videoHistory .video-history-item').first().textContent()).includes('2s')
  );

  console.log('\n--- verificação do serviço sem consumir cota ---');

  await page.locator('#videoProbe').click();
  await page.waitForFunction(
    () => document.getElementById('videoHealth').textContent.includes('Serviço disponível'),
    { timeout: 15000 }
  );

  const probeCalls = await page.evaluate(() => window.__OSVYRA_TEST_CALLS__);
  const healthCall = probeCalls.find(call => call.payload?.action === 'health');
  const probeCall = probeCalls.find(call => call.payload?.action === 'probe');

  check(
    'A verificação informa serviço disponível sem gerar vídeo',
    (await page.locator('#videoHealth').textContent()).includes('Nenhuma cota foi consumida')
  );
  check('health é chamada sem parâmetros extras', healthCall && Object.keys(healthCall.payload).length === 1);
  check('probe é chamada sem parâmetros extras', probeCall && Object.keys(probeCall.payload).length === 1);
  check(
    'Nenhum payload de verificação contém token',
    probeCalls.every(call => !JSON.stringify(call.payload).toLowerCase().includes('hf_'))
  );

  console.log('\n--- garantia de custo zero ---');

  check(
    'Nenhuma requisição ao Hugging Face foi tentada',
    externalRequests.filter(url => /huggingface\.co|hf\.space|gradio/i.test(url)).length === 0
  );
  check(
    'Nenhuma requisição externa foi tentada',
    externalRequests.filter(url => !url.includes('supabase-js')).length === 0
  );
  check('Nenhum erro de JavaScript na página', consoleErrors.length === 0);

  if (consoleErrors.length) console.log('  erros:', consoleErrors.join(' | '));
  if (externalRequests.length) console.log('  externos:', externalRequests.join(' | '));

  await browser.close();
}

server.close();

console.log(`\n${passed} verificações aprovadas, ${failures.length} falha(s).`);

if (failures.length) {
  console.log('\nFalhas:');
  failures.forEach(failure => console.log(`  - ${failure}`));
  process.exitCode = 1;
}
