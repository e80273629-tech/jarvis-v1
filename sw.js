/* OSVYRA — service worker
   - cache do app shell (funciona offline)
   - navegação network-first com fallback para o index.html em cache
   - Web Share Target: a navegação com ?share-target=1 preserva os parâmetros
     para a tela #share-in e continua funcionando sem conexão. */

const CACHE = 'osvyra-v5-cache';
const SHARE_PARAM = 'share-target';

const FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

const OFFLINE_URL = new URL('index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(FILES))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* Navegação: rede primeiro, cache depois.
   A cópia guardada usa a chave limpa do index.html, sem os parâmetros do
   compartilhamento, para não servir conteúdo antigo de outro compartilhamento. */
async function handleNavigation(request) {
  const cache = await caches.open(CACHE);

  try {
    const response = await fetch(request);

    if (response && response.ok) {
      cache.put(OFFLINE_URL, response.clone()).catch(() => {});
    }

    return response;
  } catch (error) {
    const exact = await caches.match(request);
    if (exact) return exact;

    const shell = await cache.match(OFFLINE_URL);
    if (shell) return shell;

    throw error;
  }
}

/* Arquivos estáticos do app: cache primeiro. */
function isAppAsset(url) {
  return (
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.webmanifest')
  );
}

async function handleAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);

  if (response && response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
  }

  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (isAppAsset(url)) {
    event.respondWith(handleAsset(request));
  }
});

/* O conteúdo compartilhado chega pela URL (?share-target=1&title=...&text=...).
   O service worker só garante a entrega da página; nada é salvo aqui. */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'osvyra-share-check') {
    event.source?.postMessage({
      type: 'osvyra-share-ready',
      hasShareParam: SHARE_PARAM
    });
  }
});
