/**
 * Regressão da Etapa 1 — Estúdio de Imagens com dois modos.
 *
 * Cobre:
 *  - Dois modos: "Arte promocional" (padrão, preservado) e "Imagem livre".
 *  - O modo promocional continua igual: campos, canvas, #makeArt, #downloadArt,
 *    #shareArt e #artStatus no lugar.
 *  - Imagem livre é conversacional e NUNCA chama a função sem confirmação.
 *  - Cada geração/refinamento avisa que custa 1 crédito antes de enviar.
 *  - Cancelar não gasta crédito e não chama a Edge Function.
 *  - Refinamento acumula contexto (descrição original + ajustes).
 *  - Prompt limitado a 2000 caracteres (limite de gerar-imagem-ia).
 *  - HTTP 402 / CRÉDITOS_INSUFICIENTES vira mensagem clara, sem imagem e
 *    sem gravar no histórico.
 *  - Saldo: RPC disponível mostra o saldo; RPC ausente degrada para "—" e a
 *    geração continua funcionando; creditsRemaining atualiza o badge.
 *  - Histórico em IndexedDB por usuário, limitado a 20.
 *  - O bloco novo não referencia osvyra-chat (requisito 5 da Etapa 1).
 *  - SQL de saldo entregue e sem alteração de RLS.
 *
 * Uso: node tests/estudio-imagens.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const serviceWorker = readFileSync(join(root, 'sw.js'), 'utf8');
const sqlPath = join(root, 'supabase/sql/get_image_credit_balance.sql');
const sql = existsSync(sqlPath) ? readFileSync(sqlPath, 'utf8') : '';
const edgeFunction = readFileSync(join(root, 'supabase/functions/gerar-imagem-ia/index.ts'), 'utf8');

let failures = 0;
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} — ${name}${condition || !detail ? '' : ` (${detail})`}`);
}

/* ------------------------------------------------------------------ */
/* 1. Estrutura dos dois modos                                        */
/* ------------------------------------------------------------------ */

check('Painel #art mantém a classe panel exigida pela navegação',
  /<section id="art" class="panel/.test(html));

check('Aba "Arte promocional" existe', /data-art-mode="promo"/.test(html));
check('Aba "Imagem livre" existe', /data-art-mode="free"/.test(html));
check('Aba promocional começa ativa',
  /class="mode-tab is-active"[^>]*data-art-mode="promo"/.test(html));
check('Aba livre começa inativa',
  /class="mode-tab"[^>]*data-art-mode="free"/.test(html));

const promoBlock = (html.match(/<div id="artPromoMode">([\s\S]*?)\n    <\/div>/) || [])[1] || '';
check('Bloco promocional contém o formulário completo', promoBlock.length > 500, `${promoBlock.length} chars`);
['biz', 'product', 'headline', 'details', 'price', 'contact', 'palette'].forEach(id => {
  check(`Campo promocional preservado: #${id}`, new RegExp(`id="${id}"`).test(promoBlock));
});
['makeArt', 'downloadArt', 'shareArt', 'artStatus', 'artCanvas'].forEach(id => {
  check(`Elemento promocional preservado: #${id}`, new RegExp(`id="${id}"`).test(promoBlock));
});
check('Canvas promocional mantém 1080x1350', /id="artCanvas"[^>]*width="1080"[^>]*height="1350"/.test(promoBlock));
check('Aviso do canvas promocional preservado',
  /Os textos da divulgação são aplicados separadamente/.test(promoBlock));

const freeBlock = (html.match(/<div id="artFreeMode" hidden>([\s\S]*?)\n    <\/div>\n  <\/section>/) || [])[1] || '';
check('Bloco "Imagem livre" existe e começa oculto', freeBlock.length > 400, `${freeBlock.length} chars`);
['artFreeInput', 'artFreeGenerate', 'artFreeConfirm', 'artFreeCancel', 'artFreeReset',
 'artFreePreview', 'artFreeDownload', 'artFreeStatus', 'artFreeMessages',
 'artHistoryList', 'artHistoryClear', 'artCreditBadge'].forEach(id => {
  check(`Elemento do modo livre presente: #${id}`, new RegExp(`id="${id}"`).test(html));
});

check('Aviso de 1 crédito aparece no texto do modo livre',
  /custa <strong>1 crédito<\/strong>/.test(freeBlock));
check('Histórico declara não sincronizar entre dispositivos',
  /não sincroniza entre dispositivos/.test(freeBlock));
check('Nível B declarado como não implementado',
  /Nível B\) ainda não está implementada/.test(freeBlock));

/* ------------------------------------------------------------------ */
/* 2. Isolamento: o bloco novo não depende de osvyra-chat             */
/* ------------------------------------------------------------------ */

const freeStart = html.indexOf('/* ART_FREE_START */');
const freeEnd = html.indexOf('/* ART_FREE_END */');
const freeScript = freeStart >= 0 && freeEnd > freeStart ? html.slice(freeStart, freeEnd) : '';

check('Marcadores do módulo novo existem', freeScript.length > 2000, `${freeScript.length} chars`);
check('Módulo novo não referencia osvyra-chat', freeScript.length > 0 && !/osvyra-chat/.test(freeScript));
check('Módulo novo usa a função gerar-imagem-ia', /gerar-imagem-ia/.test(freeScript));
check('Limite de histórico é 20', /ART_HISTORY_LIMIT = 20/.test(freeScript));
check('Limite de prompt é 2000', /ART_FREE_PROMPT_LIMIT = 2000/.test(freeScript));
check('Histórico usa IndexedDB', /indexedDB\.open\(ART_DB_NAME/.test(freeScript));
check('Índice por usuário é criado', /createIndex\('userId'/.test(freeScript));
check('Saldo usa a RPC get_image_credit_balance', /rpc\('get_image_credit_balance'\)/.test(freeScript));
check('Saldo usa creditsRemaining da geração', /data\.creditsRemaining/.test(freeScript));
check('Saldo consulta com a sessão autenticada',
  /auth\.getSession\(\)/.test(freeScript) && /artRefreshCredits/.test(freeScript));
check('Saldo tem reserva somente leitura em user_credits',
  /from\('user_credits'\)/.test(freeScript) && /select\('balance'\)/.test(freeScript));
check('Saldo normaliza número, string e objeto', /function artCoerceCredits/.test(freeScript));
check('Nenhuma tabela inventada de créditos',
  !/osvyra_image_credits/.test(html) && !/osvyra_image_credits/.test(sql));

/* ------------------------------------------------------------------ */
/* 3. Integrações preservadas                                         */
/* ------------------------------------------------------------------ */

check('Edge Function gerar-imagem-ia preservada (débito + estorno + Cloudflare)',
  /consume_image_credit/.test(edgeFunction) &&
  /refund_image_credit/.test(edgeFunction) &&
  /api\.cloudflare\.com/.test(edgeFunction));

check('Service worker com cache novo', /osvyra-v[5-9]-cache/.test(serviceWorker));

check('SQL de saldo entregue', sql.length > 500, `${sql.length} chars`);
check('SQL cria get_image_credit_balance', /create or replace function public\.get_image_credit_balance\(\)/.test(sql));
check('SQL é somente leitura (security definer + stable)',
  /security definer/i.test(sql) && /stable/i.test(sql));
check('SQL não desativa RLS nem cria policy',
  !/disable row level security/i.test(sql) && !/create policy/i.test(sql) && !/drop policy/i.test(sql));
check('SQL libera execução apenas para authenticated',
  /grant execute on function public\.get_image_credit_balance\(\) to authenticated/.test(sql));
check('SQL usa auth.uid() e não recebe user_id por parâmetro',
  /auth\.uid\(\)/.test(sql) && !/get_image_credit_balance\([^)]*uuid/i.test(sql));

/* ------------------------------------------------------------------ */
/* 4. Sem ids duplicados                                              */
/* ------------------------------------------------------------------ */

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
check('Nenhum id duplicado no documento', duplicated.length === 0, duplicated.join(', '));

/* ------------------------------------------------------------------ */
/* 5. Interação em navegador (viewport de celular)                    */
/* ------------------------------------------------------------------ */

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const target = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = join(root, target);

  try {
    const body = readFileSync(filePath);
    const extension = target.split('.').pop();
    const types = {
      html: 'text/html; charset=utf-8',
      js: 'text/javascript; charset=utf-8',
      mjs: 'text/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8',
      json: 'application/json; charset=utf-8',
      webmanifest: 'application/manifest+json',
      png: 'image/png',
      svg: 'image/svg+xml'
    };
    response.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream' });
    response.end(body);
  } catch (error) {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('não encontrado');
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const pageErrors = [];
let browser = null;

function stubSupabase(config) {
  window.__OSVYRA_TEST_CALLS__ = [];
  window.__ART_STUB__ = config;

  const log = entry => window.__OSVYRA_TEST_CALLS__.push(entry);

  const makeQuery = result => {
    const builder = {};
    ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
      'in', 'is', 'or', 'order', 'limit', 'range', 'single', 'maybeSingle', 'match', 'not',
      'ilike', 'like', 'contains', 'head', 'returns', 'abortSignal', 'filter'
    ].forEach(method => { builder[method] = () => builder; });
    builder.then = (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected);
    builder.catch = onRejected => Promise.resolve(result).catch(onRejected);
    builder.finally = handler => Promise.resolve(result).finally(handler);
    return builder;
  };

  const session = {
    access_token: 'token-de-teste',
    refresh_token: 'refresh-de-teste',
    user: { id: 'user-teste-1', email: 'teste@osvyra.app' }
  };

  const client = {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: session.user }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithPassword: async () => ({ data: { session, user: session.user }, error: null }),
      signUp: async () => ({ data: { session, user: session.user }, error: null }),
      signOut: async () => ({ error: null }),
      setSession: async () => ({ data: { session }, error: null })
    },
    from(table) {
      log({ kind: 'from', table });
      // Leitura de reserva do saldo: simula a própria linha em public.user_credits.
      if (table === 'user_credits' && window.__ART_STUB__.tableBalance != null) {
        return makeQuery({ data: { balance: window.__ART_STUB__.tableBalance }, error: null });
      }
      return makeQuery({ data: [], error: null });
    },
    rpc(name) {
      log({ kind: 'rpc', name });
      if (name === 'get_image_credit_balance') {
        if (window.__ART_STUB__.balanceMode === 'missing') {
          return Promise.resolve({
            data: null,
            error: { code: 'PGRST202', message: 'Could not find the function public.get_image_credit_balance' }
          });
        }
        return Promise.resolve({ data: window.__ART_STUB__.balance, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    functions: {
      invoke(name, options) {
        const body = options && options.body ? options.body : {};
        log({
          kind: 'invoke',
          name,
          prompt: body.prompt,
          authorization: options && options.headers ? options.headers.Authorization : null
        });

        if (name === 'gerar-imagem-ia') {
          if (window.__ART_STUB__.generateError === 'no_credits') {
            const error = new Error('Edge Function returned a non-2xx status code');
            error.status = 402;
            error.context = { status: 402, json: async () => ({ success: false, error: 'CRÉDITOS_INSUFICIENTES' }) };
            return Promise.resolve({ data: null, error });
          }

          return Promise.resolve({
            data: {
              success: true,
              image: window.__ART_STUB__.image,
              creditsRemaining: window.__ART_STUB__.credits
            },
            error: null
          });
        }

        return Promise.resolve({ data: { answer: 'ok' }, error: null });
      }
    }
  };

  window.supabase = { createClient: () => client };
}

async function openStudio(config = {}) {
  const settings = Object.assign({
    credits: 8,
    balance: 9,
    balanceMode: 'ok',
    tableBalance: null,
    generateError: null,
    image: TINY_PNG
  }, config);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(stubSupabase, settings);

  // O index.html carrega supabase-js por <script src>. Sem interceptar, o CDN
  // sobrescreveria window.supabase e o teste falaria com a rede real.
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    if (url.includes('supabase-js')) {
      return route.fulfill({
        contentType: 'application/javascript',
        body: '/* supabase-js não é baixado: o stub do init script permanece em window.supabase */'
      });
    }
    // Recursos externos (fotos de exemplo) são servidos localmente: abortar
    // geraria erros de rede no console e confundiria a checagem de erros de JS.
    const png = Buffer.from(String(TINY_PNG).split(',').pop(), 'base64');
    return route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });

  const page = await context.newPage();

  page.on('pageerror', error => pageErrors.push(`${page.url()} :: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') pageErrors.push(`${page.url()} :: console: ${message.text()}`);
  });

  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.navigate === 'function');
  await page.evaluate(() => window.navigate('art'));
  await page.waitForSelector('#art:not(.hidden)');

  return { context, page };
}

async function imageCalls(page) {
  const calls = await page.evaluate(() => window.__OSVYRA_TEST_CALLS__ || []);
  return calls.filter(call => call.kind === 'invoke' && call.name === 'gerar-imagem-ia');
}

async function readHistory(page) {
  return page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('osvyra-images', 1);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('images')) { resolve([]); return; }
      const tx = db.transaction('images', 'readonly');
      const getAll = tx.objectStore('images').getAll();
      getAll.onsuccess = () => resolve(getAll.result || []);
      getAll.onerror = () => resolve([]);
    };
    request.onerror = () => resolve([]);
  }));
}

async function askAndConfirm(page, text) {
  await page.fill('#artFreeInput', text);
  await page.click('#artFreeGenerate');
  await page.waitForSelector('#artFreeConfirmCard:not([hidden])');
  await page.click('#artFreeConfirm');
}

try {
  try {
    browser = await (await import('/opt/appjet/browser/node_modules/playwright/index.js')).default.chromium.launch({ args: ['--no-sandbox'] });
  } catch (launchError) {
    browser = await (await import('/opt/appjet/browser/node_modules/playwright/index.js')).default.chromium.launch({
      args: ['--no-sandbox'],
      executablePath: '/opt/appjet/browser-binaries/chromium-1234/chrome-linux64/chrome'
    });
  }

  /* 5.1 Modos e preservação do promocional */
  {
    const { context, page } = await openStudio();

    check('Estúdio abre no modo Arte promocional', await page.isVisible('#artPromoMode'));
    check('Modo Imagem livre começa oculto', await page.isHidden('#artFreeMode'));
    check('Canvas promocional visível ao abrir', await page.isVisible('#artCanvas'));

    const selected = await page.getAttribute('[data-art-mode="promo"]', 'aria-selected');
    check('Aba promocional marcada como selecionada', selected === 'true', String(selected));

    await page.click('[data-art-mode="free"]');
    check('Alternar para Imagem livre mostra o modo livre', await page.isVisible('#artFreeMode'));
    check('Alternar para Imagem livre oculta o promocional', await page.isHidden('#artPromoMode'));

    await page.click('[data-art-mode="promo"]');
    check('Voltar para Arte promocional restaura o canvas', await page.isVisible('#artCanvas'));

    check('Nenhum erro de JavaScript ao alternar os modos', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  /* 5.2 Confirmação obrigatória antes de gastar crédito */
  {
    const { context, page } = await openStudio();
    await page.click('[data-art-mode="free"]');

    await page.fill('#artFreeInput', 'um bolo de chocolate com fondant brilhante');
    await page.click('#artFreeGenerate');
    await page.waitForSelector('#artFreeConfirmCard:not([hidden])');

    const confirmText = await page.textContent('#artFreeConfirmText');
    check('Confirmação avisa que custa 1 crédito', /1 crédito/.test(confirmText || ''), confirmText || '');
    check('Confirmação mostra o saldo atual', /saldo atual: 9/.test(confirmText || ''), confirmText || '');
    check('Nada é enviado antes de confirmar', (await imageCalls(page)).length === 0);

    await page.click('#artFreeCancel');
    check('Cancelar oculta a confirmação', await page.isHidden('#artFreeConfirmCard'));
    check('Cancelar não chama a Edge Function', (await imageCalls(page)).length === 0);
    check('Cancelar informa que nenhum crédito foi usado',
      /Nenhum crédito foi usado/.test(await page.textContent('#artFreeStatus') || ''));

    await context.close();
  }

  /* 5.3 Geração confirmada, saldo e histórico */
  {
    const { context, page } = await openStudio();
    await page.click('[data-art-mode="free"]');

    await askAndConfirm(page, 'um bolo de chocolate com fondant brilhante');
    await page.waitForFunction(() => !document.getElementById('artFreePreview').hidden);

    const calls = await imageCalls(page);
    check('Confirmar envia exatamente 1 pedido', calls.length === 1, `${calls.length}`);
    check('Pedido contém a descrição do usuário',
      /bolo de chocolate com fondant brilhante/.test(calls[0]?.prompt || ''));
    check('Pedido é enviado com o token do usuário',
      calls[0]?.authorization === 'Bearer token-de-teste', String(calls[0]?.authorization));

    const badge = await page.textContent('#artCreditBadge');
    check('Badge usa o creditsRemaining da geração', /Créditos: 8/.test(badge || ''), badge || '');
    check('Prévia da imagem fica visível', await page.isVisible('#artFreePreview'));
    check('Download da imagem é liberado', !(await page.isDisabled('#artFreeDownload')));

    const history = await readHistory(page);
    check('Histórico grava 1 imagem', history.length === 1, `${history.length}`);
    check('Histórico é gravado por usuário', history[0]?.userId === 'user-teste-1', String(history[0]?.userId));
    check('Histórico guarda a descrição', /bolo de chocolate/.test(history[0]?.description || ''));
    await page.waitForSelector('#artHistoryList .history-item');
    check('Histórico aparece na tela', await page.isVisible('#artHistoryList .history-item'));

    await context.close();
  }

  /* 5.4 Refinamento acumula contexto e cobra de novo */
  {
    const { context, page } = await openStudio();
    await page.click('[data-art-mode="free"]');

    await askAndConfirm(page, 'um bolo de chocolate');
    await page.waitForFunction(() => !document.getElementById('artFreePreview').hidden);

    await askAndConfirm(page, 'fundo azul escuro');
    await page.waitForFunction(() => (window.__OSVYRA_TEST_CALLS__ || [])
      .filter(call => call.kind === 'invoke' && call.name === 'gerar-imagem-ia').length === 2);

    const calls = await imageCalls(page);
    check('Refinamento faz uma segunda chamada', calls.length === 2, `${calls.length}`);

    const second = calls[1]?.prompt || '';
    check('Refinamento mantém a descrição original', /um bolo de chocolate/.test(second));
    check('Refinamento inclui o ajuste pedido', /fundo azul escuro/.test(second));
    check('Refinamento usa a seção de ajustes', /AJUSTES PEDIDOS PELO USUÁRIO/.test(second));

    const history = await readHistory(page);
    check('Cada geração entra no histórico', history.length === 2, `${history.length}`);

    await page.click('#artFreeReset');
    check('Nova imagem limpa a conversa', await page.isHidden('#artFreePreview'));
    check('Nova imagem volta ao estado inicial',
      /Nenhum pedido ainda/.test(await page.textContent('#artFreeMessages') || ''));

    await context.close();
  }

  /* 5.5 Limite de 2000 caracteres do prompt */
  {
    const { context, page } = await openStudio();
    await page.click('[data-art-mode="free"]');

    await askAndConfirm(page, 'x'.repeat(2400));
    await page.waitForFunction(() => (window.__OSVYRA_TEST_CALLS__ || [])
      .filter(call => call.kind === 'invoke' && call.name === 'gerar-imagem-ia').length === 1);

    const calls = await imageCalls(page);
    const prompt = calls[0]?.prompt || '';
    check('Prompt é truncado em 2000 caracteres', prompt.length <= 2000, `${prompt.length}`);
    check('Prompt truncado mantém o início da instrução',
      prompt.startsWith('Crie uma imagem original e detalhada:'));

    await context.close();
  }

  /* 5.6 HTTP 402 / créditos insuficientes */
  {
    const { context, page } = await openStudio({ generateError: 'no_credits' });
    await page.click('[data-art-mode="free"]');

    await askAndConfirm(page, 'uma xícara de café');
    await page.waitForFunction(() => /Créditos insuficientes/.test(
      document.getElementById('artFreeStatus').textContent || ''));

    const status = await page.textContent('#artFreeStatus');
    check('402 vira mensagem de créditos insuficientes', /Créditos insuficientes/.test(status || ''), status || '');
    check('402 informa que nenhum crédito foi descontado', /Nenhum crédito foi descontado/.test(status || ''));
    check('402 não exibe imagem', await page.isHidden('#artFreePreview'));
    check('402 não grava histórico', (await readHistory(page)).length === 0);
    check('402 devolve o texto ao campo para nova tentativa',
      (await page.inputValue('#artFreeInput')) === 'uma xícara de café');
    check('402 reabilita o botão de gerar', !(await page.isDisabled('#artFreeGenerate')));

    await context.close();
  }

  /* 5.7 RPC de saldo indisponível: degradação sem bloquear */
  {
    const { context, page } = await openStudio({ balanceMode: 'missing' });
    await page.click('[data-art-mode="free"]');
    await page.waitForTimeout(300);

    const badge = await page.textContent('#artCreditBadge');
    check('Sem RPC o saldo aparece como desconhecido', /Créditos: —/.test(badge || ''), badge || '');
    check('Sem RPC a nota explica quando o saldo aparece',
      /após a primeira geração/.test(await page.textContent('#artCreditNote') || ''));

    await askAndConfirm(page, 'uma paisagem ao amanhecer');
    await page.waitForFunction(() => /Créditos: 8/.test(
      document.getElementById('artCreditBadge').textContent || ''));
    check('Sem RPC a geração continua funcionando', (await imageCalls(page)).length === 1);

    await context.close();
  }

  /* 5.7b RPC ausente, mas a leitura da própria linha em user_credits responde */
  {
    const { context, page } = await openStudio({ balanceMode: 'missing', tableBalance: 7 });
    await page.click('[data-art-mode="free"]');
    await page.waitForFunction(() => /Créditos: 7/.test(
      document.getElementById('artCreditBadge').textContent || ''));

    const badge = await page.textContent('#artCreditBadge');
    check('Sem RPC o saldo vem da tabela user_credits', /Créditos: 7/.test(badge || ''), badge || '');

    const calls = await page.evaluate(() => window.__OSVYRA_TEST_CALLS__);
    check('A reserva lê user_credits do próprio usuário',
      calls.some(call => call.kind === 'from' && call.table === 'user_credits'),
      JSON.stringify(calls.filter(call => call.kind === 'from')));

    check('Nota informa que o saldo foi consultado na conta',
      /Saldo consultado agora na sua conta/.test(await page.textContent('#artCreditNote') || ''));

    await context.close();
  }

  /* 5.7c creditsRemaining em texto numérico ainda atualiza o badge */
  {
    const { context, page } = await openStudio({ balanceMode: 'missing', credits: '6' });
    await page.click('[data-art-mode="free"]');
    await askAndConfirm(page, 'uma ponte de madeira sobre o rio');
    await page.waitForFunction(() => /Créditos: 6/.test(
      document.getElementById('artCreditBadge').textContent || ''));

    const badge = await page.textContent('#artCreditBadge');
    check('creditsRemaining em string atualiza o saldo', /Créditos: 6/.test(badge || ''), badge || '');
    check('Nota informa saldo vindo da geração',
      /última geração/.test(await page.textContent('#artCreditNote') || ''));

    await context.close();
  }

  /* 5.8 Modo promocional preservado de ponta a ponta */
  {
    const { context, page } = await openStudio();

    await page.fill('#product', 'Bolo de cenoura');
    await page.click('#makeArt');
    await page.waitForFunction(() => (window.__OSVYRA_TEST_CALLS__ || [])
      .filter(call => call.kind === 'invoke' && call.name === 'gerar-imagem-ia').length === 1);

    const calls = await imageCalls(page);
    check('Arte promocional continua chamando gerar-imagem-ia', calls.length === 1);
    check('Arte promocional envia o produto do formulário',
      /Bolo de cenoura/.test(calls[0]?.prompt || ''), (calls[0]?.prompt || '').slice(0, 120));

    await page.waitForFunction(() => !document.getElementById('downloadArt').disabled, null, { timeout: 15000 })
      .then(() => check('Arte promocional libera o download do PNG', true))
      .catch(() => check('Arte promocional libera o download do PNG', false, 'downloadArt continuou desabilitado'));

    check('Arte promocional não grava no histórico de imagens livres',
      (await readHistory(page)).length === 0);

    await context.close();
  }

  /* 5.9 Sem erros de JavaScript em nenhum cenário */
  check('Nenhum erro de JavaScript nos cenários testados', pageErrors.length === 0,
    pageErrors.slice(0, 4).join(' | '));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}

const passed = results.length - failures;
console.log(`\n${passed}/${results.length} verificações aprovadas.`);
if (failures > 0) {
  console.log(`FALHAS: ${results.filter(item => !item.ok).map(item => item.name).join(' | ')}`);
  process.exitCode = 1;
}
