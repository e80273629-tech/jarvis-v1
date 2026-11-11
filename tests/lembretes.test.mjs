/**
 * Regressão de "Lembretes e tarefas" da OSVYRA.
 *
 * Cobre o defeito relatado: a seção mostrava "Erro ao carregar lembretes" e o
 * salvamento falhava, sem informar a causa. A causa real (verificada no banco)
 * é privilégio/RLS ausente em public.osvyra_tasks: o PostgREST responde
 * 42501 "permission denied for table osvyra_tasks".
 *
 * Este teste verifica:
 *  - leitura: erro real (código + mensagem) exibido e caminho de sucesso renderizando;
 *  - gravação: INSERT com user_id do usuário autenticado, status e data ISO;
 *  - UPDATE: conclusão de lembrete confirmando a linha alterada e usando o
 *    status aceito pela constraint osvyra_tasks_status_check ("completed",
 *    nunca "done");
 *  - validação de título e de data/horário antes de chamar o Supabase;
 *  - a migração SQL mantém o RLS ATIVO e cria políticas por usuário.
 *
 * Uso: node tests/lembretes.test.mjs
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const sqlFile = readFileSync(join(root, 'supabase', 'osvyra_tasks_rls.sql'), 'utf8');

let failures = 0;
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} — ${name}${condition || !detail ? '' : ` (${detail})`}`);
}

/* ------------------------------------------------------------------ */
/* 1. Checagens estruturais                                            */
/* ------------------------------------------------------------------ */

check('Conclusão envia o status aceito pela constraint (completed)',
  /\.update\(\{ status: "completed" \}\)/.test(html));
check('Código não envia o status inválido "done" ao banco',
  !/status:\s*["']done["']/.test(html));
check('Interface traduz completed como "Concluída"',
  /completed:\s*["']Concluída["']/.test(html));
check('Consulta usa a tabela existente osvyra_tasks', html.includes('.from("osvyra_tasks")'));
check('Consulta filtra pelo usuário autenticado', /from\("osvyra_tasks"\)[\s\S]{0,300}eq\("user_id", user\.id\)/.test(html));
check('INSERT associa o registro ao usuário autenticado', /insert\(\{[\s\S]{0,200}user_id: user\.id/.test(html));
check('Erro do Supabase é exibido com código e mensagem', html.includes('describeSupabaseError') && html.includes('reportTaskError'));
check('Data é validada antes de chamar o Supabase', html.includes('parseScheduleValue') && html.includes('Data ou horário inválido'));

check('Migração mantém o RLS ativo (não desativa)',
  /alter table public\.osvyra_tasks enable row level security/i.test(sqlFile) &&
  !/disable row level security/i.test(sqlFile) &&
  !/disable row level security/i.test(html));
check('Migração concede privilégios ao papel authenticated',
  /grant select, insert, update on public\.osvyra_tasks to authenticated/i.test(sqlFile));
check('Migração cria políticas de SELECT, INSERT e UPDATE',
  /for select to authenticated/.test(sqlFile) &&
  /for insert to authenticated/.test(sqlFile) &&
  /for update to authenticated/.test(sqlFile));
check('Políticas amarram os registros ao usuário (auth.uid() = user_id)',
  (sqlFile.match(/auth\.uid\(\) = user_id/g) || []).length >= 3);
check('Login, CRM, chat e estúdio de imagens preservados',
  html.includes('signInWithPassword') &&
  html.includes('.from(\'opportunities\')') &&
  html.includes('.from(\'customers\')') &&
  html.includes('functions.invoke("osvyra-chat"') &&
  /<section id="art" class="panel/.test(html));

/* ------------------------------------------------------------------ */
/* 2. Cenários de leitura e gravação em navegador                      */
/* ------------------------------------------------------------------ */

const SUPABASE_STUB = `<script>
(function () {
  var config = window.__osvyraConfig || {};
  var state = window.__osvyraStub = { inserts: [], updates: [], selects: 0 };
  var session = config.session === null ? null : (config.session || { user: { id: 'user-1', email: 'teste@osvyra.app' } });

  function forTable(table) {
    if (table === 'osvyra_tasks') {
      state.selects += 1;
      if (config.selectError) return { data: null, error: config.selectError };
      return { data: config.tasks || [], error: null };
    }
    return { data: [], error: null };
  }

  function chain(result) {
    var proxy = new Proxy(function () {}, {
      get: function (_, prop) {
        if (prop === 'then') return function (resolve, reject) { return Promise.resolve(result).then(resolve, reject); };
        if (prop === 'catch') return function (reject) { return Promise.resolve(result).catch(reject); };
        return function () { return proxy; };
      },
      apply: function () { return proxy; }
    });
    return proxy;
  }

  window.supabase = {
    createClient: function () {
      return {
        auth: {
          getSession: async function () { return { data: { session: session }, error: null }; },
          getUser: async function () { return { data: { user: session && session.user }, error: null }; },
          onAuthStateChange: function (cb) {
            if (session) setTimeout(function () { cb('SIGNED_IN', session); }, 0);
            return { data: { subscription: { unsubscribe: function () {} } } };
          },
          signInWithPassword: async function () { return { data: { session: session }, error: null }; },
          signUp: async function () { return { data: { session: session }, error: null }; },
          signOut: async function () { return { error: null }; }
        },
        from: function (table) {
          var builder = {
            select: function () { return builder; },
            eq: function () { return builder; },
            order: function () { return builder; },
            limit: function () { return builder; },
            single: function () { return builder; },
            maybeSingle: function () { return builder; },
            insert: function (payload) {
              state.inserts.push({ table: table, payload: payload });
              return chain(config.insertError ? { data: null, error: config.insertError } : { data: [payload], error: null });
            },
            update: function (payload) {
              state.updates.push({ table: table, payload: payload });
              return chain(config.updateError ? { data: null, error: config.updateError } : { data: [{ id: 'task-1' }], error: null });
            },
            delete: function () { return chain({ data: null, error: null }); },
            then: function (resolve, reject) { return Promise.resolve(forTable(table)).then(resolve, reject); },
            catch: function (reject) { return Promise.resolve(forTable(table)).catch(reject); }
          };
          return builder;
        },
        functions: { invoke: async function () { return { data: { reply: '' }, error: null }; } }
      };
    }
  };
})();
</script>`;

const pageHtml = html.replace(/<body([^>]*)>/i, (match, attrs) => `<body${attrs}>${SUPABASE_STUB}`);

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;

  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
    return;
  }

  try {
    const file = readFileSync(join(root, path.replace(/^\/+/, '')));
    const type = path.endsWith('.js') ? 'text/javascript'
      : path.endsWith('.svg') ? 'image/svg+xml'
      : path.endsWith('.png') ? 'image/png'
      : path.endsWith('.webmanifest') ? 'application/manifest+json'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const { chromium } = (await import('/opt/appjet/browser/node_modules/playwright/index.js')).default;
const browser = await chromium.launch();

const RLS_ERROR = {
  code: '42501',
  message: 'permission denied for table osvyra_tasks',
  details: null,
  hint: 'GRANT SELECT ON public.osvyra_tasks TO authenticated;'
};

async function scenario(config, run) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));

  await page.route('**/*', route =>
    route.request().url().startsWith(base) ? route.continue() : route.abort()
  );

  await page.addInitScript(value => { window.__osvyraConfig = value; }, config);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__osvyraStub, null, { timeout: 15000 });
  await page.locator('[data-target="projects"]').first().click();
  await page.waitForTimeout(400);

  const output = await run(page);
  await context.close();
  return { output, errors };
}

/* 2.1 Leitura com RLS/privilégio ausente: precisa mostrar a causa real */
{
  const { output, errors } = await scenario({ selectError: RLS_ERROR }, page =>
    page.textContent('#taskMessage')
  );
  check('Leitura bloqueada mostra a mensagem real do Supabase',
    /permission denied for table osvyra_tasks/.test(output || ''), output || '(vazio)');
  check('Leitura bloqueada mostra o código 42501', /42501/.test(output || ''));
  check('Leitura bloqueada indica o arquivo SQL de correção',
    /osvyra_tasks_rls\.sql/.test(output || ''));
  check('Leitura bloqueada não gera erro de JavaScript', errors.length === 0, errors.join(' | '));
}

/* 2.2 Leitura com sucesso: lista renderizada e status correto */
{
  const tasks = [
    { id: 'task-1', title: 'Revisar projeto', description: 'Ajustar cores', status: 'pending', scheduled_at: '2026-12-01T12:30:00.000Z', result: null },
    { id: 'task-2', title: 'Enviar proposta', description: '', status: 'completed', scheduled_at: null, result: null }
  ];
  const { output, errors } = await scenario({ tasks }, async page => ({
    text: await page.textContent('#tasksList'),
    completeButtons: await page.locator('[data-complete-task]').count(),
    message: await page.textContent('#taskMessage')
  }));
  check('Leitura com sucesso lista os lembretes',
    /Revisar projeto/.test(output.text || '') && /Enviar proposta/.test(output.text || ''));
  check('Status pendente/concluída traduzidos na lista',
    /Pendente/.test(output.text || '') && /Concluída/.test(output.text || ''));
  check('Somente lembrete pendente oferece o botão Concluir', output.completeButtons === 1);
  check('Data do lembrete formatada em pt-BR', /2026/.test(output.text || ''));
  check('Leitura com sucesso não mostra erro', !/Erro ao carregar/.test(output.message || ''));
  check('Leitura com sucesso não gera erro de JavaScript', errors.length === 0, errors.join(' | '));
}

/* 2.3 Gravação com sucesso: INSERT correto e confirmação */
{
  const { output, errors } = await scenario({ tasks: [] }, async page => {
    await page.fill('#taskTitle', 'Ligar para cliente');
    await page.fill('#taskDescription', 'Confirmar reunião');
    await page.fill('#taskSchedule', '2026-12-05T09:30');
    await page.click('#saveTask');
    await page.waitForTimeout(500);
    return {
      message: await page.textContent('#taskMessage'),
      inserts: await page.evaluate(() => window.__osvyraStub.inserts)
    };
  });

  const insert = (output.inserts || [])[0] || {};
  check('Gravação chama a tabela osvyra_tasks', insert.table === 'osvyra_tasks');
  check('Gravação associa o lembrete ao usuário autenticado', insert.payload && insert.payload.user_id === 'user-1');
  check('Gravação envia status pendente', insert.payload && insert.payload.status === 'pending');
  check('Gravação envia data e horário em ISO válido',
    !!insert.payload && typeof insert.payload.scheduled_at === 'string' &&
    !Number.isNaN(Date.parse(insert.payload.scheduled_at)));
  check('Gravação confirma sucesso ao usuário',
    /Lembrete salvo com sucesso!/.test(output.message || ''), output.message || '');
  check('Gravação com sucesso não gera erro de JavaScript', errors.length === 0, errors.join(' | '));
}

/* 2.4 Gravação bloqueada: erro real exibido */
{
  const { output } = await scenario({ tasks: [], insertError: RLS_ERROR }, async page => {
    await page.fill('#taskTitle', 'Ligar para cliente');
    await page.fill('#taskSchedule', '2026-12-05T09:30');
    await page.click('#saveTask');
    await page.waitForTimeout(500);
    return page.textContent('#taskMessage');
  });
  check('Gravação bloqueada mostra a mensagem real do Supabase',
    /permission denied for table osvyra_tasks/.test(output || '') && /42501/.test(output || ''),
    output || '(vazio)');
}

/* 2.5 Validação antes de chamar o Supabase */
{
  const { output } = await scenario({ tasks: [] }, async page => {
    await page.fill('#taskSchedule', '2026-12-05T09:30');
    await page.click('#saveTask');
    await page.waitForTimeout(200);
    const semTitulo = await page.textContent('#taskMessage');
    const insertsSemTitulo = (await page.evaluate(() => window.__osvyraStub.inserts)).length;

    await page.fill('#taskTitle', 'Ligar para cliente');
    await page.fill('#taskSchedule', '');
    await page.click('#saveTask');
    await page.waitForTimeout(200);
    const semData = await page.textContent('#taskMessage');
    const insertsSemData = (await page.evaluate(() => window.__osvyraStub.inserts)).length;

    return { semTitulo, semData, insertsSemTitulo, insertsSemData };
  });
  check('Título vazio é bloqueado com mensagem clara', /Informe o título do lembrete/.test(output.semTitulo || ''));
  check('Título vazio não chama o Supabase', output.insertsSemTitulo === 0);
  check('Data vazia é bloqueada com mensagem clara', /Informe a data e o horário/.test(output.semData || ''));
  check('Data vazia não chama o Supabase', output.insertsSemData === 0);
}

/* 2.6 UPDATE: concluir lembrete */
{
  const tasks = [{ id: 'task-1', title: 'Revisar projeto', description: '', status: 'pending', scheduled_at: '2026-12-01T12:30:00.000Z', result: null }];
  const { output, errors } = await scenario({ tasks }, async page => {
    await page.locator('[data-complete-task]').first().click();
    await page.waitForTimeout(500);
    return {
      message: await page.textContent('#taskMessage'),
      updates: await page.evaluate(() => window.__osvyraStub.updates)
    };
  });
  const update = (output.updates || [])[0] || {};
  check('Concluir lembrete faz UPDATE de status na osvyra_tasks',
    update.table === 'osvyra_tasks' && update.payload && update.payload.status === 'completed');
  check('Concluir lembrete confirma ao usuário', /Lembrete concluído/.test(output.message || ''), output.message || '');
  check('Concluir lembrete não gera erro de JavaScript', errors.length === 0, errors.join(' | '));
}

await browser.close();
server.close();

console.log(`\n${results.length - failures}/${results.length} verificações aprovadas`);
if (failures > 0) {
  console.error(`${failures} verificação(ões) falharam`);
  process.exit(1);
}
