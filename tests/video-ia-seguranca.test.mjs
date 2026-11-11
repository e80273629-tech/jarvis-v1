#!/usr/bin/env node
/**
 * tests/video-ia-seguranca.test.mjs — Regressão das três correções da revisão
 * estática de `supabase/functions/gerar-video-ia`.
 *
 * Cobre, com comportamento real (não regex) das funções exportadas e do próprio
 * handler:
 *
 *   ALTO-1 — a URL do vídeo só pode ser HTTPS no host exato de SPACE_BASE.
 *            URLs externas, sufixo enganoso, userinfo, porta alternativa,
 *            loopback, redes privadas, metadata de nuvem e data:/javascript:
 *            são recusados. O `HF_TOKEN` nunca sai para outra origem e um 3xx
 *            nunca é seguido.
 *
 *   ALTO-2 — o download tem teto de 6 MB, conferido no `Content-Length` e
 *            também durante a leitura do stream, com timeout de 30s.
 *
 *   MÉDIO-1 — o buffer SSE de `poll` para em 2 MB.
 *
 * CUSTO ZERO: `fetch` é substituído por um stub completo. Nenhuma requisição
 * sai da máquina, nenhum probe é executado e nenhum vídeo é gerado. Ao final o
 * teste falha se qualquer URL chamada estiver fora de {auth do Supabase, Space}.
 *
 * Uso: node tests/video-ia-seguranca.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnPath = join(root, 'supabase/functions/gerar-video-ia/index.ts');

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
/* 0. Stub do runtime Deno (antes de importar a função)               */
/* ================================================================== */

const ENV = {
  SUPABASE_URL: 'https://projeto-de-teste.supabase.co',
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'chave-publica-de-teste' }),
  HF_TOKEN: 'token-de-teste-local-nao-real'
};

const served = [];

globalThis.Deno = {
  serve: (handler) => {
    served.push(handler);
    return { finished: Promise.resolve(), shutdown: () => {} };
  },
  env: {
    get: (name) => (name in ENV ? ENV[name] : undefined)
  }
};

/**
 * A função é um módulo TypeScript de Edge Function: executa `Deno.serve` no
 * topo e exporta os auxiliares testáveis. O Node moderno remove os tipos
 * nativamente; se a versão local não suportar, transpilamos com tsc.
 */
async function loadFunctionModule() {
  let nativeError = null;

  try {
    const mod = await import(`${pathToFileURL(fnPath).href}?v=${Date.now()}`);
    if (typeof mod.sanitizeVideoUrl === 'function') {
      return { mod, via: 'import nativo (.ts)' };
    }
  } catch (error) {
    nativeError = error;
  }

  const dir = mkdtempSync(join(tmpdir(), 'osvyra-video-'));

  try {
    execFileSync(
      process.env.TSC_BIN || 'tsc',
      [fnPath, '--target', 'es2022', '--module', 'esnext', '--skipLibCheck', '--outDir', dir],
      { stdio: 'ignore' }
    );
  } catch (error) {
    var tscError = error;
    /* tsc pode reclamar do global Deno e ainda assim emitir o JS */
  }

  const emitted = join(dir, 'index.js');

   if (!existsSync(emitted)) {
    const details = [
      nativeError ? `import nativo: ${nativeError.message}` : null,
      tscError ? `tsc: ${tscError.message}` : 'tsc: sem erro capturado'
    ].filter(Boolean).join(' | ');

    throw new Error(`não foi possível carregar a Edge Function (${details})`);
  }

  const asMjs = join(dir, 'index.mjs');
  renameSync(emitted, asMjs);

  return { mod: await import(pathToFileURL(asMjs).href), via: 'transpilado com tsc' };
}

const fnSrc = existsSync(fnPath) ? readFileSync(fnPath, 'utf8') : '';

console.log('\n--- carregamento da Edge Function ---');
check('A Edge Function existe no repositório', fnSrc.length > 0);

const { mod, via } = await loadFunctionModule();

console.log(`  (carregada via ${via})`);

const {
  isSpaceUrl,
  sanitizeVideoUrl,
  extractVideoUrl,
  readBoundedBody,
  MAX_INLINE_BYTES,
  MAX_REQUEST_BYTES,
  MAX_SUBMIT_RESPONSE_BYTES,
  MAX_PROBE_RESPONSE_BYTES,
  MAX_SSE_BYTES,
  AUTH_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  SUBMIT_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  SPACE_BASE
} = mod;

check('O handler é registrado uma única vez via Deno.serve', served.length === 1);
check('As constantes de segurança estão exportadas', MAX_INLINE_BYTES === 6 * 1024 * 1024 && MAX_SSE_BYTES === 2 * 1024 * 1024);
check('O limite do corpo da requisição é 16 KB', MAX_REQUEST_BYTES === 16 * 1024);
check('O limite da resposta de submit é 64 KB', MAX_SUBMIT_RESPONSE_BYTES === 64 * 1024);
check('O limite da resposta de diagnóstico é 128 KB', MAX_PROBE_RESPONSE_BYTES === 128 * 1024);
check('Timeout de autenticação é 10s', AUTH_TIMEOUT_MS === 10000);
check('Timeout de diagnóstico é 12s', PROBE_TIMEOUT_MS === 12000);
check('Timeout de envio é 20s', SUBMIT_TIMEOUT_MS === 20000);
check('O teto do SSE é 2 MB', MAX_SSE_BYTES === 2097152);
check('O teto do download é 6 MB', MAX_INLINE_BYTES === 6291456);
check('O timeout do download é de aproximadamente 30s', DOWNLOAD_TIMEOUT_MS >= 25000 && DOWNLOAD_TIMEOUT_MS <= 35000);
check('O Space base continua sendo o oficial', SPACE_BASE === 'https://lightricks-ltx-video-distilled.hf.space');

/* ================================================================== */
/* 1. ALTO-1 — validação da URL                                       */
/* ================================================================== */

console.log('\n--- ALTO-1: URLs maliciosas recusadas ---');

const MALICIOSAS = [
  ['http://lightricks-ltx-video-distilled.hf.space/gradio_api/file=/tmp/v.mp4', 'HTTP sem TLS'],
  ['https://evil.example.com/video.mp4', 'domínio externo'],
  ['https://lightricks-ltx-video-distilled.hf.space.evil.example.com/v.mp4', 'sufixo enganoso'],
  ['https://evil.example.com/?next=https://lightricks-ltx-video-distilled.hf.space/v.mp4', 'URL do Space como parâmetro'],
  ['https://lightricks-ltx-video-distilled.hf.space@evil.example.com/v.mp4', 'userinfo disfarçado de host'],
  ['https://user:senha@lightricks-ltx-video-distilled.hf.space/v.mp4', 'credenciais embutidas'],
  ['https://lightricks-ltx-video-distilled.hf.space:8443/v.mp4', 'porta alternativa'],
  ['https://sub.lightricks-ltx-video-distilled.hf.space/v.mp4', 'subdomínio não autorizado'],
  ['https://127.0.0.1/video.mp4', 'loopback IPv4'],
  ['https://localhost/video.mp4', 'localhost'],
  ['https://[::1]/video.mp4', 'loopback IPv6'],
  ['https://169.254.169.254/latest/meta-data/', 'metadata de nuvem'],
  ['https://10.0.0.5/video.mp4', 'rede privada 10/8'],
  ['https://192.168.0.10/video.mp4', 'rede privada 192.168/16'],
  ['https://172.16.4.4/video.mp4', 'rede privada 172.16/12'],
  ['https://servico.internal/video.mp4', 'host interno'],
  ['//evil.example.com/video.mp4', 'URL sem protocolo'],
  ['javascript:alert(1)', 'esquema javascript'],
  ['data:video/mp4;base64,QUFB', 'data URL'],
  ['file:///etc/passwd', 'esquema file'],
  ['', 'string vazia'],
  ['   ', 'apenas espaços']
];

for (const [url, motivo] of MALICIOSAS) {
  check(`Recusa ${motivo}: ${url.slice(0, 58)}`, sanitizeVideoUrl(url) === '');
}

check('Recusa valor não-string (objeto)', sanitizeVideoUrl({ url: 'https://evil.example.com/v.mp4' }) === '');
check('Recusa null', sanitizeVideoUrl(null) === '');
check(
  'Recusa URL acima de 2048 caracteres',
  sanitizeVideoUrl(`https://lightricks-ltx-video-distilled.hf.space/${'a'.repeat(2100)}`) === ''
);

console.log('\n--- ALTO-1: URLs legítimas aceitas ---');

const LEGITIMAS = [
  `${SPACE_BASE}/gradio_api/file=/tmp/gradio/abc/video.mp4`,
  `https://lightricks-ltx-video-distilled.hf.space:443/gradio_api/file=/tmp/gradio/abc/video.mp4`,
  'https://LIGHTRICKS-LTX-VIDEO-DISTILLED.HF.SPACE/gradio_api/file=/tmp/gradio/abc/video.mp4'
];

for (const url of LEGITIMAS) {
  check(`Aceita URL do Space: ${url.slice(0, 58)}`, sanitizeVideoUrl(url) !== '');
}

check('isSpaceUrl concorda com sanitizeVideoUrl', isSpaceUrl(LEGITIMAS[0]) === true && isSpaceUrl(MALICIOSAS[1][0]) === false);

console.log('\n--- ALTO-1: extração da resposta do Space ---');

check(
  'extractVideoUrl recusa video.url externo',
  extractVideoUrl([{ video: { url: 'https://evil.example.com/v.mp4' } }]) === ''
);
check(
  'extractVideoUrl recusa string externa',
  extractVideoUrl(['https://evil.example.com/v.mp4']) === ''
);
check(
  'extractVideoUrl recusa record.url apontando para metadata de nuvem',
  extractVideoUrl([{ url: 'http://169.254.169.254/latest/meta-data/' }]) === ''
);
check(
  'extractVideoUrl recusa sufixo enganoso',
  extractVideoUrl([{ video: { url: 'https://lightricks-ltx-video-distilled.hf.space.evil.example.com/v.mp4' } }]) === ''
);
check(
  'extractVideoUrl recusa path com query injetada',
  extractVideoUrl([{ video: { path: '/tmp/x.mp4?token=abc' } }]) === ''
);
check(
  'extractVideoUrl recusa path com fragmento',
  extractVideoUrl([{ video: { path: '/tmp/x.mp4#frag' } }]) === ''
);
check(
  'extractVideoUrl recusa travessia de diretório',
  extractVideoUrl([{ video: { path: '/tmp/../../etc/passwd' } }]) === ''
);
check(
  'extractVideoUrl aceita URL legítima do Space',
  extractVideoUrl([{ video: { url: `${SPACE_BASE}/gradio_api/file=/tmp/x.mp4` } }]).startsWith(SPACE_BASE)
);
check(
  'extractVideoUrl monta URL do Space a partir de path',
  extractVideoUrl([{ video: { path: '/tmp/gradio/x/video.mp4' } }]) === `${SPACE_BASE}/gradio_api/file=/tmp/gradio/x/video.mp4`
);

/* ================================================================== */
/* 2. ALTO-2 — leitura com teto de bytes                              */
/* ================================================================== */

console.log('\n--- ALTO-2: readBoundedBody ---');

function streamOf(chunks, tracker) {
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }

      const chunk = chunks[index++];
      if (tracker) tracker.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      if (tracker) tracker.cancelled = true;
    }
  });
}

/* Content-Length acima do limite: nem chega a ler o corpo. */
const declaredTracker = { pulled: 0, cancelled: false };
const declaredResult = await readBoundedBody(
  {
    headers: new Headers({ 'content-length': String(MAX_INLINE_BYTES + 1) }),
    body: streamOf([new Uint8Array(16)], declaredTracker)
  },
  MAX_INLINE_BYTES
);

check(
  'Recusa pelo Content-Length acima de 6 MB',
  declaredResult.truncated === true && declaredResult.bytes === null
);
check('Informa o tamanho declarado quando recusa', declaredResult.sizeBytes === MAX_INLINE_BYTES + 1);
check('Não lê nenhum byte quando o Content-Length já ultrapassa', declaredTracker.pulled === 0);

/* Sem Content-Length: interrompe durante a leitura. */
const overflowTracker = { pulled: 0, cancelled: false };
const overflowResult = await readBoundedBody(
  {
    headers: new Headers(),
    body: streamOf([new Uint8Array(MAX_INLINE_BYTES + 4096).fill(7)], overflowTracker)
  },
  MAX_INLINE_BYTES
);

check('Interrompe a leitura ao ultrapassar 6 MB', overflowResult.truncated === true && overflowResult.bytes === null);
check('Cancela o stream ao ultrapassar o limite', overflowTracker.cancelled === true);

/* Muitos blocos pequenos somando mais que o limite. */
const manyTracker = { pulled: 0, cancelled: false };
const manyChunks = Array.from({ length: 10 }, () => new Uint8Array(700 * 1024).fill(1));
const manyResult = await readBoundedBody(
  { headers: new Headers(), body: streamOf(manyChunks, manyTracker) },
  MAX_INLINE_BYTES
);

check(
  'Soma dos blocos acima de 6 MB também é interrompida',
  manyResult.truncated === true && manyResult.bytes === null
);
check(
  'Não consome todos os blocos quando o total passa do limite',
  manyTracker.pulled <= MAX_INLINE_BYTES + 700 * 1024
);

/* Exatamente no limite é aceito. */
const exactResult = await readBoundedBody(
  { headers: new Headers({ 'content-length': String(MAX_INLINE_BYTES) }), body: streamOf([new Uint8Array(MAX_INLINE_BYTES)]) },
  MAX_INLINE_BYTES
);

check(
  'Aceita um arquivo exatamente no limite de 6 MB',
  exactResult.truncated === false && exactResult.bytes !== null && exactResult.bytes.byteLength === MAX_INLINE_BYTES
);

/* Corpo pequeno e correto. */
const smallBytes = new TextEncoder().encode('osvyra-video-de-teste');
const smallResult = await readBoundedBody(
  { headers: new Headers(), body: streamOf([smallBytes]) },
  MAX_INLINE_BYTES
);

check(
  'Devolve os bytes corretos para corpo pequeno',
  new TextDecoder().decode(smallResult.bytes) === 'osvyra-video-de-teste'
);
check('Informa o tamanho real do corpo pequeno', smallResult.sizeBytes === smallBytes.byteLength);

/* Vários blocos pequenos são concatenados na ordem. */
const multiResult = await readBoundedBody(
  {
    headers: new Headers(),
    body: streamOf([new TextEncoder().encode('osvyra-'), new TextEncoder().encode('video')])
  },
  MAX_INLINE_BYTES
);

check(
  'Concatena blocos na ordem correta',
  new TextDecoder().decode(multiResult.bytes) === 'osvyra-video'
);

/* Sem corpo. */
const emptyResult = await readBoundedBody({ headers: new Headers(), body: null }, MAX_INLINE_BYTES);
check('Corpo ausente não gera erro nem dados', emptyResult.bytes === null && emptyResult.truncated === false);

/* ================================================================== */
/* 3. Comportamento do handler com fetch stubado                      */
/* ================================================================== */

console.log('\n--- handler: download e SSE com fetch stubado ---');

const AUTH_URL = `${ENV.SUPABASE_URL}/auth/v1/user`;
const CALL_PREFIX = `${SPACE_BASE}/gradio_api/call/text_to_video`;

const handler = served[0];
const calls = [];
let downloadCalls = [];

function installFetch({ stream, download }) {
  calls.length = 0;
  downloadCalls = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input && input.url);
    calls.push({ url, init });

    if (url === AUTH_URL) {
      return new Response(JSON.stringify({ id: 'usuario-de-teste' }), { status: 200 });
    }

    if (url.startsWith(`${CALL_PREFIX}/`)) {
      return stream(url, init);
    }

    downloadCalls.push({ url, init });
    return download(url, init);
  };
}

function sseResponse(events) {
  const body = events
    .map((event) => `event: ${event.event}\ndata: ${event.data}\n\n`)
    .join('');

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function completeEvent(payload) {
  return sseResponse([{ event: 'complete', data: JSON.stringify(payload) }]);
}

async function handlerOnce(body) {
  const response = await handler(
    new Request('https://projeto-de-teste.functions.supabase.co/gerar-video-ia', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer token-de-teste-local',
        'Content-Type': 'application/json'
      },
      body
    })
  );

  return { status: response.status, data: await response.json() };
}

async function pollOnce() {
  return handlerOnce(JSON.stringify({ action: 'poll', eventId: 'evt-teste-0001' }));
}

/* --- 3.0a Timeouts de autenticação, diagnóstico e envio --- */
const originalFetchForTimeouts = globalThis.fetch;
let authSignal;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : String(input && input.url);
  authSignal = init.signal;
  if (url === AUTH_URL) { const error = new Error('timeout auth'); error.name = 'TimeoutError'; throw error; }
  throw new Error('URL inesperada no timeout auth: ' + url);
};
const authTimedOut = await handlerOnce(JSON.stringify({ action: 'health' }));
check('Timeout de autenticação devolve HTTP 504', authTimedOut.status === 504);
check('Autenticação recebe AbortSignal', authSignal instanceof AbortSignal);

let submitSignal;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : String(input && input.url);
  if (url === AUTH_URL) return new Response(JSON.stringify({ id: 'usuario-de-teste' }), { status: 200 });
  if (url === CALL_PREFIX) { submitSignal = init.signal; const error = new Error('timeout submit'); error.name = 'TimeoutError'; throw error; }
  throw new Error('URL inesperada no timeout submit: ' + url);
};
const submitTimedOut = await handlerOnce(JSON.stringify({ action: 'submit', prompt: 'Vídeo de teste', duration: 2, format: '16:9' }));
check('Timeout de envio devolve HTTP 504', submitTimedOut.status === 504);
check('Envio ao Space recebe AbortSignal', submitSignal instanceof AbortSignal);

let probeSignals = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : String(input && input.url);
  if (url === AUTH_URL) return new Response(JSON.stringify({ id: 'usuario-de-teste' }), { status: 200 });
  probeSignals.push(init.signal);
  if (url === 'https://huggingface.co/api/whoami-v2') return new Response('{}', { status: 200 });
  if (url === SPACE_BASE + '/gradio_api/info') return new Response(JSON.stringify({ named_endpoints: {} }), { status: 200 });
  throw new Error('URL inesperada no teste de probe: ' + url);
};
const probeResult = await handlerOnce(JSON.stringify({ action: 'probe' }));
check('Diagnóstico continua respondendo sem geração', probeResult.status === 200);
check('As duas chamadas de diagnóstico recebem AbortSignal', probeSignals.length === 2 && probeSignals.every(signal => signal instanceof AbortSignal));

let probeInfoCancelled = false;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input && input.url);
  if (url === AUTH_URL) return new Response(JSON.stringify({ id: 'usuario-de-teste' }), { status: 200 });
  if (url === 'https://huggingface.co/api/whoami-v2') return new Response('{}', { status: 200 });
  if (url === SPACE_BASE + '/gradio_api/info') {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PROBE_RESPONSE_BYTES + 1024));
      },
      cancel() { probeInfoCancelled = true; }
    }), { status: 200 });
  }
  throw new Error('URL inesperada no teste de limite do probe: ' + url);
};
const oversizedProbe = await handlerOnce(JSON.stringify({ action: 'probe' }));
check('Diagnóstico com resposta acima de 128 KB continua controlado', oversizedProbe.status === 200);
check('Resposta excessiva do diagnóstico não produz endpoints', Array.isArray(oversizedProbe.data.endpoints) && oversizedProbe.data.endpoints.length === 0);
check('Stream excessivo do diagnóstico é cancelado', probeInfoCancelled);
globalThis.fetch = originalFetchForTimeouts;


/* --- 3.0b Resposta do submit limitada sem gerar vídeo real --- */
const originalFetchForSubmit = globalThis.fetch;
let submitResponseCancelled = false;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input && input.url);
  if (url === AUTH_URL) {
    return new Response(JSON.stringify({ id: 'usuario-de-teste' }), { status: 200 });
  }
  if (url === CALL_PREFIX) {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_SUBMIT_RESPONSE_BYTES + 1024));
        },
        cancel() {
          submitResponseCancelled = true;
        }
      }),
      { status: 200 }
    );
  }
  throw new Error('URL inesperada no teste de submit: ' + url);
};

const oversizedSubmit = await handlerOnce(JSON.stringify({
  action: 'submit',
  prompt: 'Vídeo de teste',
  duration: 2,
  format: '16:9'
}));

check('Resposta de submit acima de 64 KB recebe HTTP 502 controlado', oversizedSubmit.status === 502);
check('Resposta excessiva de submit não é processada como eventId', oversizedSubmit.data.success === false);
check('Stream excessivo do submit é cancelado', submitResponseCancelled);

globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input && input.url);
  if (url === AUTH_URL) return new Response(JSON.stringify({ id: 'usuario-de-teste' }), { status: 200 });
  if (url === CALL_PREFIX) return new Response(JSON.stringify({ event_id: 'evt-valid-123' }), { status: 200 });
  throw new Error('URL inesperada no teste de eventId válido: ' + url);
};
const validEventId = await handlerOnce(JSON.stringify({
  action: 'submit', prompt: 'Vídeo de teste', duration: 2, format: '16:9'
}));
check('Submit aceita eventId válido do Space', validEventId.status === 200 && validEventId.data.eventId === 'evt-valid-123');

globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input && input.url);
  if (url === AUTH_URL) return new Response(JSON.stringify({ id: 'usuario-de-teste' }), { status: 200 });
  if (url === CALL_PREFIX) return new Response('event_id inválido com espaços e caracteres!', { status: 200 });
  throw new Error('URL inesperada no teste de eventId inválido: ' + url);
};
const invalidEventId = await handlerOnce(JSON.stringify({
  action: 'submit', prompt: 'Vídeo de teste', duration: 2, format: '16:9'
}));
check('Submit recusa eventId malformado com HTTP 502', invalidEventId.status === 502 && invalidEventId.data.success === false);
globalThis.fetch = originalFetchForSubmit;


/* --- 3.0 Corpo da requisição limitado antes do JSON.parse --- */
installFetch({
  stream: () => completeEvent([]),
  download: () => { throw new Error('não deveria baixar nada'); }
});

const oversizedBody = JSON.stringify({
  action: 'health',
  padding: 'x'.repeat(MAX_REQUEST_BYTES + 100)
});
const oversizedRequest = await handlerOnce(oversizedBody);

check('Corpo acima de 16 KB é recusado com HTTP 413', oversizedRequest.status === 413);
check('Corpo excessivo não chama serviços externos além da autenticação', calls.length === 1 && calls[0].url === AUTH_URL);

const malformedRequest = await handlerOnce('{json-invalido');
check('JSON malformado recebe HTTP 400, não erro interno 500', malformedRequest.status === 400);

/* --- 3.1 URL maliciosa: nada é baixado, token não sai --- */
installFetch({
  stream: () => completeEvent([{ video: { url: 'https://evil.example.com/video.mp4' } }]),
  download: () => {
    throw new Error('download nunca deveria acontecer para URL externa');
  }
});

const malicious = await pollOnce();

check('URL maliciosa não dispara nenhum download', downloadCalls.length === 0);
check(
  'Nenhuma requisição vai para o domínio externo',
  calls.every((call) => !call.url.includes('evil.example.com'))
);
check(
  'Nenhuma requisição externa carrega o token do Hugging Face',
  calls.every((call) => {
    const header = String(call.init?.headers?.Authorization || '');
    if (!header.includes('Bearer token-de-teste-local')) return true;
    return call.url === AUTH_URL || call.url.startsWith(SPACE_BASE);
  })
);
check(
  'A resposta não devolve vídeo nem URL externa',
  malicious.data.video === undefined &&
    !JSON.stringify(malicious.data).includes('evil.example.com')
);
check(
  'A resposta informa que a geração não devolveu vídeo válido',
  malicious.data.success === false && malicious.data.status === 'error'
);

/* --- 3.2 Redirecionamento para outro domínio não é seguido --- */
installFetch({
  stream: () => completeEvent([{ video: { url: `${SPACE_BASE}/gradio_api/file=/tmp/x.mp4` } }]),
  download: () => ({
    ok: false,
    status: 302,
    headers: new Headers({ location: 'https://evil.example.com/v.mp4' }),
    body: null
  })
});

const redirected = await pollOnce();

check('O download usa redirect: "manual"', downloadCalls[0]?.init?.redirect === 'manual');
check('Um 3xx não é seguido para outro domínio', calls.every((call) => !call.url.includes('evil.example.com')));
check('Resposta de redirecionamento não embute bytes', redirected.data.video === '');
check('A URL do Space continua disponível ao cliente', redirected.data.videoUrl === `${SPACE_BASE}/gradio_api/file=/tmp/x.mp4`);

/* --- 3.3 Download acima de 6 MB --- */
installFetch({
  stream: () => completeEvent([{ video: { url: `${SPACE_BASE}/gradio_api/file=/tmp/big.mp4` } }]),
  download: () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(MAX_INLINE_BYTES + 1) }),
    body: null
  })
});

const tooBig = await pollOnce();

check('Vídeo acima de 6 MB não é embutido', tooBig.data.video === '');
check('O tamanho acima do limite é reportado', tooBig.data.sizeBytes === MAX_INLINE_BYTES + 1);
check('A geração continua concluída com a URL', tooBig.data.success === true && tooBig.data.status === 'complete');

/* --- 3.4 Stream acima do limite, sem Content-Length --- */
installFetch({
  stream: () => completeEvent([{ video: { url: `${SPACE_BASE}/gradio_api/file=/tmp/big2.mp4` } }]),
  download: () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: streamOf([new Uint8Array(MAX_INLINE_BYTES + 8192).fill(3)])
  })
});

const streamTooBig = await pollOnce();

check('Stream acima de 6 MB não é embutido', streamTooBig.data.video === '');
check('O stream acima do limite é interrompido', streamTooBig.data.sizeBytes > MAX_INLINE_BYTES);

/* --- 3.5 Timeout / abort do download --- */
installFetch({
  stream: () => completeEvent([{ video: { url: `${SPACE_BASE}/gradio_api/file=/tmp/slow.mp4` } }]),
  download: (url, init) => {
    const error = new Error('download abortado');
    error.name = 'AbortError';
    error.signalRecebido = init?.signal;
    throw error;
  }
});

const timedOut = await pollOnce();

check('O download recebe um AbortSignal', downloadCalls[0]?.init?.signal instanceof AbortSignal);
check('Timeout do download não quebra a resposta', timedOut.data.success === true && timedOut.data.status === 'complete');
check('Timeout do download não embute bytes', timedOut.data.video === '');

/* --- 3.6 SSE acima de 2 MB --- */
let ssePulled = 0;
let sseCancelled = false;
const sseChunk = new Uint8Array(64 * 1024).fill(0x20);

installFetch({
  stream: () => new Response(
    new ReadableStream({
      pull(controller) {
        if (ssePulled > MAX_SSE_BYTES * 4) {
          controller.close();
          return;
        }

        ssePulled += sseChunk.byteLength;
        controller.enqueue(sseChunk.slice());
      },
      cancel() {
        sseCancelled = true;
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  ),
  download: () => {
    throw new Error('sem complete, não há download');
  }
});

const sseOverflow = await pollOnce();

check('SSE acima de 2 MB é interrompido', sseCancelled === true);
check(
  'A leitura do SSE não consome o stream inteiro',
  ssePulled < MAX_SSE_BYTES * 4
);
check(
  'A leitura do SSE para logo após o teto de 2 MB',
  ssePulled <= MAX_SSE_BYTES + 2 * sseChunk.byteLength
);
check(
  'SSE truncado devolve pending, não erro',
  sseOverflow.data.success === true && sseOverflow.data.status === 'pending'
);
check('SSE truncado não dispara download', downloadCalls.length === 0);

/* --- 3.7 Caminho feliz continua funcionando --- */
const videoBytes = new TextEncoder().encode('osvyra-video-stub-bytes');

installFetch({
  stream: () => completeEvent([{ video: { url: `${SPACE_BASE}/gradio_api/file=/tmp/ok.mp4` } }]),
  download: () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(videoBytes.byteLength) }),
    body: streamOf([videoBytes])
  })
});

const happy = await pollOnce();

check('Vídeo pequeno é embutido como data URL', happy.data.video.startsWith('data:video/mp4;base64,'));
check(
  'Os bytes embutidos são idênticos aos baixados',
  happy.data.video.slice('data:video/mp4;base64,'.length) === Buffer.from(videoBytes).toString('base64')
);
check('O tamanho real é informado', happy.data.sizeBytes === videoBytes.byteLength);
check(
  'O download envia o token apenas para o Space',
  downloadCalls.length === 1 && downloadCalls[0].url.startsWith(SPACE_BASE)
);

console.log('\n--- garantia de custo zero ---');

check(
  'Nenhuma requisição saiu do stub (auth + Space apenas)',
  calls.every((call) => call.url === AUTH_URL || call.url.startsWith(SPACE_BASE))
);
check(
  'Nenhuma chamada ao Hugging Face fora do Space',
  calls.every((call) => !/huggingface\.co\/api|hf\.co/.test(call.url) || call.url.startsWith(SPACE_BASE))
);
check(
  'Nenhuma geração submetida durante os testes',
  calls.every((call) => !call.url.startsWith(CALL_PREFIX) || call.url.includes('/evt-teste-0001'))
);

/* ================================================================== */
/* 4. Invariantes estáticos (proteção contra regressão)               */
/* ================================================================== */

console.log('\n--- invariantes do código ---');

check('Não existe mais leitura sem teto (arrayBuffer)', !/\.arrayBuffer\(\)/.test(fnSrc));
check('Autenticação tem timeout', /AbortSignal\.timeout\(AUTH_TIMEOUT_MS\)/.test(fnSrc));
check('Diagnóstico tem timeout', (fnSrc.match(/AbortSignal\.timeout\(PROBE_TIMEOUT_MS\)/g) || []).length === 2);
check('Diagnóstico limita a resposta do Space', /readBoundedBody\(info, MAX_PROBE_RESPONSE_BYTES\)/.test(fnSrc));
check('Envio tem timeout', /AbortSignal\.timeout\(SUBMIT_TIMEOUT_MS\)/.test(fnSrc));
check('Submit valida o formato do eventId', fnSrc.includes('!/^[A-Za-z0-9_-]{4,120}$/.test(eventId)'));
check('O download usa redirect: "manual"', /redirect:\s*"manual"/.test(fnSrc));
check('O download tem AbortSignal', /signal:\s*downloadController\.signal/.test(fnSrc));
check('O download checa Content-Length', /content-length/.test(fnSrc));
check('O download usa readBoundedBody', /readBoundedBody\(fileResponse, MAX_INLINE_BYTES\)/.test(fnSrc));
check('A URL é validada antes do download', /if \(!isSpaceUrl\(videoUrl\)\)/.test(fnSrc));
check('O buffer SSE tem teto explícito', /received > MAX_SSE_BYTES/.test(fnSrc));
check('O poll continua com timeout de 20s', /POLL_TIMEOUT_MS = 20000/.test(fnSrc));
check('O limite inline continua em 6 MB', /MAX_INLINE_BYTES = 6 \* 1024 \* 1024/.test(fnSrc));
check('Nenhum token do Hugging Face está hardcoded', !/hf_[A-Za-z0-9]{20,}/.test(fnSrc));
check('A função continua sem tocar em créditos de imagem', !/consume_image_credit|refund_image_credit|user_credits/.test(fnSrc));
check('A função continua sem Cloudflare paga', !/cloudflare\.com|CLOUDFLARE_/i.test(fnSrc));
check('health continua devolvendo apenas booleano', /hasToken:\s*hfToken\.length > 0/.test(fnSrc));

/* ================================================================== */
/* Resumo                                                             */
/* ================================================================== */

console.log(`\n${passed} verificações aprovadas, ${failures.length} falha(s).`);

if (failures.length) {
  console.log('\nFalhas:');
  failures.forEach((failure) => console.log(`  - ${failure}`));
  process.exitCode = 1;
}
