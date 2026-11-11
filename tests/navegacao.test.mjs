/**
 * Regressão de navegação da OSVYRA.
 *
 * Cobre os defeitos corrigidos:
 *  - "Vídeos com IA" precisa abrir a tela do gerador, não login/CRM.
 *  - "Organização de projetos" precisa abrir uma tela existente.
 *  - Roteiro inteligente e Vídeos com IA precisam ser telas diferentes.
 *  - Sem elementos/chamadas duplicados (ids duplicados, chat na home, cards órfãos).
 *  - Botão voltar do celular/navegador volta para a tela anterior.
 *
 * Uso: node tests/navegacao.test.mjs
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

let failures = 0;
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} — ${name}${condition || !detail ? '' : ` (${detail})`}`);
}

/* ------------------------------------------------------------------ */
/* 1. Checagens estruturais (sem navegador)                            */
/* ------------------------------------------------------------------ */

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
const duplicatedIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
check('Nenhum id duplicado no documento', duplicatedIds.length === 0, duplicatedIds.join(', '));

const targets = [...html.matchAll(/data-(?:target|screen)="([^"]+)"/g)].map(match => match[1]);
const uniqueTargets = [...new Set(targets)];
const orphanTargets = uniqueTargets.filter(target =>
  target === 'home' ? !ids.includes('moduleGrid') : !ids.includes(target)
);
check('Todo card/menu aponta para uma tela existente', orphanTargets.length === 0, orphanTargets.join(', '));
check('Card de Organização de projetos não usa id inexistente', !targets.includes('clients'));

const videoStart = html.indexOf('<section id="video" class="panel');
const generatorStart = html.indexOf('id="videoGenerator"');
const videoAiStart = html.indexOf('<section id="video-ai"');
const projectsStart = html.indexOf('<section id="projects"');

check('Seção de Roteiro inteligente existe', videoStart > -1);
check('Gerador de vídeo está dentro de Vídeos com IA',
  generatorStart > videoAiStart && generatorStart < projectsStart,
  'gerador fora da tela #video-ai');
check('Gerador de vídeo não fica na tela de Roteiro',
  !(generatorStart > videoStart && generatorStart < videoAiStart));
check('Tela de Organização de projetos existe', projectsStart > -1);
check('Chat inicia oculto (não aparece junto com a home)',
  /<section class="panel hidden" id="osvyra-chat">/.test(html));
check('Autenticação, CRM e tarefas preservados na tela de projetos',
  projectsStart > -1 &&
  html.indexOf('id="authEmail"') > projectsStart &&
  html.indexOf('id="crmArea"') > projectsStart &&
  html.indexOf('id="tasksList"') > projectsStart &&
  html.indexOf('id="leadList"') > projectsStart &&
  html.indexOf('id="customerList"') > projectsStart);
check('Estúdio de imagens preservado', /<section id="art" class="panel/.test(html));
check('Chat com Supabase preservado', html.includes('functions.invoke("osvyra-chat"'));
check('Perfil e configurações preservados',
  /<section id="profile" class="panel/.test(html) && /<section id="settings" class="panel/.test(html));
check('"Enviar para Vídeos com IA" navega para a tela do gerador',
  /sendToVideo[\s\S]{0,600}navigate\('video-ai'\)/.test(html));

/* ------------------------------------------------------------------ */
/* 2. Checagens de interação em navegador (viewport de celular)        */
/* ------------------------------------------------------------------ */

const SUPABASE_STUB = `
(function () {
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
const allErrors = [];

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

  allErrors.push(...[]);
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

  async function openPage(session, label) {
    const page = await context.newPage();
    const errors = watchErrors(page, label);

    await page.addInitScript(value => {
      window.__OSVYRA_TEST_SESSION__ = value;
    }, session);

    await page.goto(`${baseUrl}/index.html`, { waitUntil: 'load' });

    return { page, errors };
  }

  async function openToolPage(target, label) {
    const { page, errors } = await openPage(SESSION, label);

    await page.waitForFunction(() => !document.getElementById('moduleGrid').classList.contains('hidden'));
    await page.locator(`[data-target="${target}"]`).click();

    return { page, errors };
  }

  /* Home + Vídeos com IA + botão voltar */
  {
    const { page, errors } = await openPage(SESSION, 'home');
    await page.waitForFunction(() => !document.getElementById('moduleGrid').classList.contains('hidden'));

    check('Home visível após login', await page.locator('#moduleGrid').isVisible());
    check('Nenhum painel aberto junto com a home', (await visiblePanels(page)).length === 0);

    await page.locator('[data-target="video-ai"]').click();
    await page.waitForFunction(() => !document.getElementById('video-ai').classList.contains('hidden'));

    check('Card "Vídeos com IA" abre a tela do gerador',
      await page.locator('#video-ai #videoGenerator').isVisible());
    check('Tela de vídeos não mostra login/CRM',
      (await page.locator('#video-ai #authEmail').count()) === 0 &&
      (await page.locator('#video-ai #crmArea').count()) === 0);
    check('Apenas a tela de vídeos fica visível', (await visiblePanels(page)).join() === 'video-ai');
    check('Hash sincronizado com a tela de vídeos',
      (await page.evaluate(() => location.hash)) === '#video-ai');

    await page.locator('#backButton').click();
    await page.waitForFunction(() => !document.getElementById('moduleGrid').classList.contains('hidden'));
    check('Botão voltar retorna à home', await page.locator('#moduleGrid').isVisible());

    check('Sem erros de JavaScript na navegação para vídeos', errors.length === 0, errors.join(' | '));

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

    await page.close();
  }

  /* Roteiro inteligente separado do gerador de vídeo */
  {
    const { page, errors } = await openToolPage('video', 'roteiro');
    await page.waitForFunction(() => !document.getElementById('video').classList.contains('hidden'));

    check('Card "Roteiro inteligente" abre a tela de roteiro',
      await page.locator('#video #scriptOut').isVisible());
    check('Gerador de vídeo não aparece na tela de roteiro',
      (await page.locator('#video #videoGenerator').count()) === 0);
    check('Apenas a tela de roteiro fica visível', (await visiblePanels(page)).join() === 'video');

    await page.locator('#scriptOut').evaluate(element => {
      element.value = 'Roteiro de teste OSVYRA';
    });
    await page.locator('#sendToVideo').click();
    await page.waitForFunction(() => !document.getElementById('video-ai').classList.contains('hidden'));

    check('"Enviar para Vídeos com IA" abre a tela do gerador',
      await page.locator('#video-ai #videoGenerator').isVisible());
    check('Roteiro enviado preenche a descrição do vídeo',
      (await page.locator('#videoPrompt').inputValue()) === 'Roteiro de teste OSVYRA');
    check('Sem erros de JavaScript no fluxo de roteiro', errors.length === 0, errors.join(' | '));

    await page.close();
  }

  /* Organização de projetos com CRM e tarefas */
  {
    const { page, errors } = await openToolPage('projects', 'projetos');
    await page.waitForFunction(() => !document.getElementById('projects').classList.contains('hidden'));

    check('Card "Organização de projetos" abre a tela de projetos',
      await page.locator('#projects').isVisible());
    check('Tela de projetos mantém CRM e tarefas',
      await page.locator('#crmArea').isVisible() &&
      (await page.locator('#tasksList').count()) === 1 &&
      (await page.locator('#leadList').count()) === 1);
    check('Apenas a tela de projetos fica visível', (await visiblePanels(page)).join() === 'projects');
    check('Sem erros de JavaScript na tela de projetos', errors.length === 0, errors.join(' | '));

    await page.close();
  }

  /* Estúdio de imagens, chat e voltar do navegador */
  {
    const { page, errors } = await openToolPage('art', 'imagens');
    check('Card "Imagens com IA" abre o estúdio de imagens',
      (await visiblePanels(page)).join() === 'art' && await page.locator('#artCanvas').isVisible());

    await page.locator('#backButton').click();
    await page.waitForFunction(() => !document.getElementById('moduleGrid').classList.contains('hidden'));
    await page.locator('.assistant-cta').click();
    await page.waitForFunction(() => !document.getElementById('osvyra-chat').classList.contains('hidden'));

    check('Card da assistente abre o chat',
      (await visiblePanels(page)).join() === 'osvyra-chat' && await page.locator('#chatInput').isVisible());

    await page.goBack();
    await page.waitForFunction(() => !document.getElementById('moduleGrid').classList.contains('hidden'));
    check('Voltar do navegador retorna à home', await page.locator('#moduleGrid').isVisible());
    check('Sem erros de JavaScript em imagens e chat', errors.length === 0, errors.join(' | '));

    await page.close();
  }

  /* Visitante sem sessão: landing e "Entrar" levam ao acesso em projetos */
  {
    const { page, errors } = await openPage(null, 'visitante');
    await page.waitForFunction(() => !document.getElementById('publicLanding').classList.contains('hidden'));

    await page.locator('#landingLogin').click();
    await page.waitForFunction(() => !document.getElementById('projects').classList.contains('hidden'));

    check('"Entrar" na landing abre a tela de projetos com o formulário de acesso',
      await page.locator('#projects #authEmail').isVisible());
    check('Visitante não vê o CRM antes de entrar',
      !(await page.locator('#crmArea').isVisible()));
    check('Landing sem erros de JavaScript', errors.length === 0, errors.join(' | '));

    await page.close();
  }

  await context.close();
  await browser.close();
}

server.close();

console.log(`\n${results.length - failures}/${results.length} verificações aprovadas.`);
process.exit(failures === 0 ? 0 : 1);
