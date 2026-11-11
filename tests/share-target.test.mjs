/**
 * Regressão da Fase 1 — PWA instalável + Web Share Target.
 *
 * Cobre:
 *  - manifest.webmanifest com ícones 192/512, scope, id, atalhos e share_target.
 *  - Ícones PNG reais com as dimensões declaradas.
 *  - sw.js com precache dos ícones, fallback offline e preservação do share target.
 *  - Tela #share-in: conteúdo recebido é exibido e nada é salvo sem confirmação.
 *  - Criar lembrete grava em osvyra_tasks pelo caminho já existente (saveTask).
 *  - Salvar oportunidade grava em opportunities pelo caminho já existente (saveLead).
 *  - Descartar não grava nada.
 *  - Compartilhamento de saída em roteiro e arte (com alternativa quando não há
 *    Web Share API).
 *  - Funcionalidades anteriores preservadas (telas, sem ids duplicados).
 *
 * Uso: node tests/share-target.test.mjs
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
const serviceWorker = readFileSync(join(root, 'sw.js'), 'utf8');

let failures = 0;
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} — ${name}${condition || !detail ? '' : ` (${detail})`}`);
}

/* ------------------------------------------------------------------ */
/* 1. Manifest e ícones                                               */
/* ------------------------------------------------------------------ */

const iconSources = manifest.icons.map(icon => icon.src);
const iconSizes = manifest.icons.map(icon => icon.sizes);

check('Manifest declara o ícone 192x192', iconSizes.includes('192x192'), iconSizes.join(', '));
check('Manifest declara o ícone 512x512', iconSizes.includes('512x512'), iconSizes.join(', '));
check('Manifest declara ícone maskable para o Android',
  manifest.icons.some(icon => String(icon.purpose || '').includes('maskable')));
check('Manifest usa caminhos de ícone existentes',
  iconSources.includes('icons/icon-192.png') && iconSources.includes('icons/icon-512.png'),
  iconSources.join(', '));
check('Manifest define scope e id dentro do app', manifest.scope === './' && manifest.id === './',
  `${manifest.scope} / ${manifest.id}`);
check('Manifest mantém a instalação em tela cheia', manifest.display === 'standalone');
check('Manifest declara atalhos de app', Array.isArray(manifest.shortcuts) && manifest.shortcuts.length >= 2);

const shareTarget = manifest.share_target || {};
check('Manifest registra o app no compartilhamento do Android', !!manifest.share_target);
check('Share target recebe por GET em uma ação própria',
  shareTarget.method === 'GET' && String(shareTarget.action).includes('share-target'),
  `${shareTarget.method} ${shareTarget.action}`);
check('Share target recebe título, texto e link',
  shareTarget.params && shareTarget.params.title === 'title' &&
  shareTarget.params.text === 'text' && shareTarget.params.url === 'url');

function pngInfo(relativePath) {
  const buffer = readFileSync(join(root, relativePath));

  return {
    signature: buffer.subarray(0, 8).toString('hex'),
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.length
  };
}

const PNG_SIGNATURE = '89504e470d0a1a0a';
const icon192 = pngInfo('icons/icon-192.png');
const icon512 = pngInfo('icons/icon-512.png');
const iconMaskable = pngInfo('icons/icon-maskable-512.png');

check('Ícone 192x192 é um PNG válido de 192x192',
  icon192.signature === PNG_SIGNATURE && icon192.width === 192 && icon192.height === 192,
  `${icon192.width}x${icon192.height}`);
check('Ícone 512x512 é um PNG válido de 512x512',
  icon512.signature === PNG_SIGNATURE && icon512.width === 512 && icon512.height === 512,
  `${icon512.width}x${icon512.height}`);
check('Ícone maskable é um PNG válido de 512x512',
  iconMaskable.signature === PNG_SIGNATURE && iconMaskable.width === 512 && iconMaskable.height === 512);
check('Ícones têm conteúdo real (não vazios)', icon192.bytes > 500 && icon512.bytes > 1000);
check('HTML referencia os ícones PNG e o apple-touch-icon',
  html.includes('href="icons/icon-192.png"') &&
  html.includes('href="icons/icon-512.png"') &&
  html.includes('rel="apple-touch-icon"'));

/* ------------------------------------------------------------------ */
/* 2. Service worker                                                  */
/* ------------------------------------------------------------------ */

check('Service worker guarda os ícones no cache',
  serviceWorker.includes('./icons/icon-192.png') && serviceWorker.includes('./icons/icon-512.png'));
check('Service worker mantém fallback offline do app shell',
  /cache\.match\(OFFLINE_URL\)/.test(serviceWorker) && serviceWorker.includes('index.html'));
check('Service worker conhece o parâmetro do compartilhamento',
  serviceWorker.includes('share-target'));
check('Service worker ignora métodos que não são GET',
  /request\.method !== 'GET'/.test(serviceWorker));
check('Service worker não intercepta chamadas de outros domínios (Supabase)',
  /url\.origin !== self\.location\.origin/.test(serviceWorker));
check('Versão do cache foi atualizada', /osvyra-v[4-9]-cache/.test(serviceWorker));

/* ------------------------------------------------------------------ */
/* 3. Estrutura da tela de confirmação                                */
/* ------------------------------------------------------------------ */

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
const duplicatedIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];

check('Nenhum id duplicado no documento', duplicatedIds.length === 0, duplicatedIds.join(', '));
check('Tela #share-in existe', /<section id="share-in" class="panel hidden">/.test(html));
check('Tela de confirmação oferece criar lembrete, salvar oportunidade e descartar',
  html.includes('id="shareCreateTask"') && html.includes('id="shareSaveLead"') && html.includes('id="shareDiscard"'));
check('Confirmação exige data e horário antes de salvar o lembrete',
  html.includes('id="shareInSchedule"') && html.includes('type="datetime-local"'));
check('Estúdio de imagens ganhou o botão de compartilhar', html.includes('id="shareArt"'));
check('Roteiro inteligente ganhou o botão de compartilhar', html.includes('id="shareScript"'));
check('Funcionalidades anteriores preservadas',
  /<section id="art" class="panel/.test(html) &&
  /<section id="video" class="panel/.test(html) &&
  /<section id="projects" class="panel/.test(html) &&
  /<section class="panel hidden" id="osvyra-chat">/.test(html) &&
  html.includes('functions.invoke("osvyra-chat"'));
check('Criação de lembrete reaproveita o handler existente (sem chamada duplicada)',
  /shareCreateTaskButton[\s\S]{0,900}getElementById\('saveTask'\)\.click\(\)/.test(html));
check('Criação de oportunidade reaproveita o handler existente (sem chamada duplicada)',
  /shareSaveLeadButton[\s\S]{0,900}getElementById\('saveLead'\)\.click\(\)/.test(html));
check('Nenhuma chamada direta a osvyra_tasks dentro do módulo de compartilhamento',
  !/shareCreateTaskButton[\s\S]{0,900}from\('osvyra_tasks'\)/.test(html));

/* ------------------------------------------------------------------ */
/* 4. Interação em navegador (viewport de celular)                    */
/* ------------------------------------------------------------------ */

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
        from: function (table) {
          return new Proxy({}, {
            get(_, prop) {
              if (prop === 'then') return undefined;
              return function (...args) {
                window.__OSVYRA_TEST_CALLS__.push({ table: table, op: String(prop), args: args });
                return queryResult({ data: [], error: null });
              };
            }
          });
        },
        functions: { invoke: async function () { return { data: { answer: 'ok' }, error: null }; } }
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
    response.end('not found');
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
  console.log(`SKIP — checagens de navegador indisponíveis: ${error.message}`);
}

const SESSION = { user: { id: 'teste', email: 'teste@osvyra.app' } };

const SHARED_QUERY =
  'share-target=1' +
  '&title=' + encodeURIComponent('Reunião com cliente') +
  '&text=' + encodeURIComponent('Confirmar orçamento amanhã pelo WhatsApp') +
  '&url=' + encodeURIComponent('https://exemplo.com/orcamento');

function visiblePanels(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.panel')]
      .filter(panel => !panel.classList.contains('hidden'))
      .map(panel => panel.id)
  );
}

function watchErrors(page, label) {
  const errors = [];

  page.on('pageerror', error => errors.push(`${label} pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;

    const text = message.text();

    if (/Failed to load resource|ERR_FAILED|net::/i.test(text)) return;

    errors.push(`${label} console: ${text}`);
  });

  return errors;
}

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

    return route.abort();
  });

  async function openPage(query, label) {
    const page = await context.newPage();
    const errors = watchErrors(page, label);

    await page.addInitScript(value => {
      window.__OSVYRA_TEST_SESSION__ = value;
    }, SESSION);

    await page.goto(`${baseUrl}/index.html${query ? `?${query}` : ''}`, { waitUntil: 'load' });

    return { page, errors };
  }

  /* Compartilhar um texto do Android e criar lembrete */
  {
    const { page, errors } = await openPage(SHARED_QUERY, 'share-lembrete');
    await page.waitForFunction(() => !document.getElementById('share-in').classList.contains('hidden'));

    check('Compartilhamento abre a tela de confirmação', await page.locator('#share-in').isVisible());
    check('Somente a confirmação fica visível', (await visiblePanels(page)).join() === 'share-in',
      (await visiblePanels(page)).join());
    check('Título recebido é exibido',
      (await page.locator('#shareInTitle').inputValue()) === 'Reunião com cliente');
    check('Texto recebido é exibido',
      (await page.locator('#shareInText').inputValue()).includes('Confirmar orçamento'));
    check('Link recebido é exibido',
      (await page.locator('#shareInUrl').inputValue()) === 'https://exemplo.com/orcamento');
    check('Origem do conteúdo é indicada',
      (await page.locator('#shareInSource').textContent()).includes('exemplo.com'));
    check('Data e horário já vêm sugeridos',
      (await page.locator('#shareInSchedule').inputValue()).length >= 16);
    const writesBeforeConfirm = await page.evaluate(() =>
      window.__OSVYRA_TEST_CALLS__.filter(call => ['insert', 'update', 'upsert', 'delete'].includes(call.op)));

    check('Nada é salvo antes da confirmação', writesBeforeConfirm.length === 0,
      writesBeforeConfirm.map(call => `${call.table}.${call.op}`).join(', '));

    await page.locator('#shareCreateTask').click();
    await page.waitForFunction(() => !document.getElementById('projects').classList.contains('hidden'));

    const calls = await page.evaluate(() => window.__OSVYRA_TEST_CALLS__);
    const taskInsert = calls.find(call => call.table === 'osvyra_tasks' && call.op === 'insert');

    check('Criar lembrete grava na tabela osvyra_tasks', !!taskInsert,
      calls.map(call => `${call.table}.${call.op}`).join(', '));
    check('Lembrete é associado ao usuário autenticado',
      !!taskInsert && taskInsert.args[0].user_id === 'teste');
    check('Lembrete usa o título compartilhado',
      !!taskInsert && taskInsert.args[0].title === 'Reunião com cliente');
    check('Lembrete recebe o texto compartilhado na descrição',
      !!taskInsert && String(taskInsert.args[0].description).includes('Confirmar orçamento'));
    check('Lembrete recebe data e horário em ISO',
      !!taskInsert && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(taskInsert.args[0].scheduled_at)));
    check('Lembrete entra como pending (constraint respeitada)',
      !!taskInsert && taskInsert.args[0].status === 'pending');
    check('Criar lembrete abre Lembretes e tarefas', (await visiblePanels(page)).join() === 'projects');
    check('Parâmetros do compartilhamento são removidos da URL',
      (await page.evaluate(() => location.search)) === '');
    check('Sem erros de JavaScript ao criar lembrete', errors.length === 0, errors.join(' | '));

    await page.close();
  }

  /* Compartilhar e salvar oportunidade */
  {
    const { page, errors } = await openPage(SHARED_QUERY, 'share-oportunidade');
    await page.waitForFunction(() => !document.getElementById('share-in').classList.contains('hidden'));

    await page.locator('#shareSaveLead').click();
    await page.waitForFunction(() => !document.getElementById('projects').classList.contains('hidden'));

    const calls = await page.evaluate(() => window.__OSVYRA_TEST_CALLS__);
    const leadInsert = calls.find(call => call.table === 'opportunities' && call.op === 'insert');
    const leadPayload = leadInsert ? JSON.stringify(leadInsert.args[0]) : '';

    check('Salvar oportunidade grava na Central comercial', !!leadInsert,
      calls.map(call => `${call.table}.${call.op}`).join(', '));
    check('Oportunidade usa o conteúdo compartilhado', leadPayload.includes('Reunião com cliente'));
    check('Oportunidade guarda o link recebido', leadPayload.includes('exemplo.com/orcamento'));
    check('Oportunidade é associada ao usuário autenticado', leadPayload.includes('"teste"'));
    check('Salvar oportunidade não cria lembrete',
      !calls.some(call => call.table === 'osvyra_tasks' && call.op === 'insert'));
    check('Salvar oportunidade abre a tela de projetos',
      (await visiblePanels(page)).join() === 'projects');
    check('Sem erros de JavaScript ao salvar oportunidade', errors.length === 0, errors.join(' | '));

    await page.close();
  }

  /* Descartar não grava nada */
  {
    const { page, errors } = await openPage(SHARED_QUERY, 'share-descartar');
    await page.waitForFunction(() => !document.getElementById('share-in').classList.contains('hidden'));

    await page.locator('#shareDiscard').click();
    await page.waitForFunction(() => !document.getElementById('moduleGrid').classList.contains('hidden'));

    const calls = await page.evaluate(() => window.__OSVYRA_TEST_CALLS__);
    const writes = calls.filter(call => ['insert', 'update', 'upsert', 'delete'].includes(call.op));

    check('Descartar volta para a home', await page.locator('#moduleGrid').isVisible());
    check('Descartar não grava nada', writes.length === 0,
      writes.map(call => `${call.table}.${call.op}`).join(', '));
    check('Descartar limpa os parâmetros da URL',
      (await page.evaluate(() => location.search)) === '');
    check('Sem erros de JavaScript ao descartar', errors.length === 0, errors.join(' | '));

    await page.close();
  }

  /* Compartilhamento de saída: roteiro e arte */
  {
    const { page, errors } = await openPage('', 'share-saida');
    await page.waitForFunction(() => !document.getElementById('moduleGrid').classList.contains('hidden'));

    const hasWebShare = await page.evaluate(() => typeof navigator.share === 'function');

    await page.locator('[data-target="art"]').click();
    await page.waitForFunction(() => !document.getElementById('art').classList.contains('hidden'));
    await page.locator('#shareArt').click();
    await page.waitForFunction(() =>
      document.getElementById('artStatus').textContent.includes('Gere a arte'));

    check('Compartilhar arte exige uma arte gerada',
      (await page.locator('#artStatus').textContent()).includes('Gere a arte antes de compartilhar'));
    check('Compartilhar arte não dispara erro com canvas vazio', errors.length === 0, errors.join(' | '));

    await page.locator('#backButton').click();
    await page.waitForFunction(() => !document.getElementById('moduleGrid').classList.contains('hidden'));

    await page.locator('[data-target="video"]').click();
    await page.waitForFunction(() => !document.getElementById('video').classList.contains('hidden'));

    await page.locator('#scriptOut').evaluate(element => {
      element.value = 'Roteiro OSVYRA para compartilhar';
    });
    await page.locator('#shareScript').click();
    await page.waitForFunction(() => document.getElementById('copyStatus').textContent.trim() !== '');

    const copyStatus = (await page.locator('#copyStatus').textContent()).trim();

    if (hasWebShare) {
      check('Compartilhar roteiro usa o compartilhamento do sistema',
        /compartilhad|cancelado|não foi possível/i.test(copyStatus), copyStatus);
    } else {
      check('Sem Web Share API, o roteiro oferece alternativa (copiar/baixar)',
        copyStatus.includes('não oferece compartilhamento'), copyStatus);
    }

    await page.close();
  }

  /* Regressão: navegação principal continua funcionando */
  {
    const { page, errors } = await openPage('', 'regressao');
    await page.waitForFunction(() => !document.getElementById('moduleGrid').classList.contains('hidden'));

    check('Home continua abrindo sem compartilhamento', await page.locator('#moduleGrid').isVisible());
    check('Nenhum painel aberto junto com a home', (await visiblePanels(page)).length === 0);

    await page.locator('[data-target="video-ai"]').click();
    await page.waitForFunction(() => !document.getElementById('video-ai').classList.contains('hidden'));
    check('Vídeos com IA continua abrindo o gerador', await page.locator('#video-ai #videoGenerator').isVisible());

    await page.locator('#backButton').click();
    await page.waitForFunction(() => !document.getElementById('moduleGrid').classList.contains('hidden'));
    check('Botão voltar continua funcionando', await page.locator('#moduleGrid').isVisible());

    const domDuplicatedIds = await page.evaluate(() => {
      const seen = new Set();
      const duplicates = [];

      document.querySelectorAll('[id]').forEach(element => {
        if (seen.has(element.id)) duplicates.push(element.id);
        seen.add(element.id);
      });

      return duplicates;
    });

    check('Nenhum id duplicado no DOM renderizado', domDuplicatedIds.length === 0, domDuplicatedIds.join(', '));
    check('Sem erros de JavaScript na regressão', errors.length === 0, errors.join(' | '));

    await page.close();
  }

  await context.close();
  await browser.close();
}

server.close();

console.log(`\n${results.length - failures}/${results.length} verificações aprovadas.`);
process.exit(failures === 0 ? 0 : 1);
