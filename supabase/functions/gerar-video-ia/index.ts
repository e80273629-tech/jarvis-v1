/**
 * OSVYRA — Edge Function `gerar-video-ia` (experimental, custo zero)
 *
 * Gera vídeos a partir de texto usando o Space oficial
 * `Lightricks/ltx-video-distilled` no Hugging Face ZeroGPU.
 *
 * Por que existe: a OSVYRA tinha uma tela de vídeos apenas demonstrativa.
 * Esta função é a primeira integração real, mantida em modo experimental e
 * sem qualquer cobrança: a cota gratuita do ZeroGPU é de 5 minutos de GPU por
 * dia para toda a conta, portanto cada chamada precisa ser explícita.
 *
 * AÇÕES (campo `action` no corpo JSON):
 *   health → { success, hasToken, space, durations, formats }
 *            `hasToken` é BOOLEANO. O token nunca é devolvido, nem parcialmente.
 *   probe  → valida o token em /api/whoami-v2 e o alcance do Space em
 *            /gradio_api/info. NÃO dispara geração, logo NÃO consome cota.
 *   submit → envia o prompt para a fila do Space e devolve `eventId`.
 *   poll   → consulta o SSE do Gradio com o `eventId` e devolve
 *            { status: "pending" | "complete" | "error", ... }.
 *
 * Por que submit e poll são separados: a Edge Function tem limite de
 * wall-clock e a fila gratuita do ZeroGPU pode levar minutos. Dividir em duas
 * chamadas evita estourar o limite e permite progresso real na interface.
 *
 * SEGURANÇA: `HF_TOKEN` é lido apenas via Deno.env.get, nunca literal. A
 * função exige usuário autenticado (verify_jwt = true em supabase/config.toml)
 * e valida o Bearer token em /auth/v1/user antes de qualquer chamada externa.
 *
 * DOWNLOAD: o arquivo do vídeo só é baixado quando a URL é HTTPS e o host é
 * EXATAMENTE o de `SPACE_BASE` (comparação por igualdade, nunca por sufixo).
 * Redirecionamentos não são seguidos, endereços internos são recusados e o
 * `HF_TOKEN` jamais acompanha uma requisição para outra origem. O corpo é lido
 * em stream com teto de 6 MB e timeout de 30s.
 *
 * MEMÓRIA: o buffer SSE de `poll` também tem teto (2 MB), para que um stream
 * anómalo não infle a função.

 * CRÉDITOS: esta função NÃO consome créditos de imagem. Não consulta a tabela
 * de créditos nem chama as RPCs de débito/estorno do Estúdio de Imagens.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Space oficial da Lightricks (licença LTX: uso comercial abaixo de US$10M). */
const SPACE_ID = "Lightricks/ltx-video-distilled";
export const SPACE_BASE = "https://lightricks-ltx-video-distilled.hf.space";
const GRADIO_CALL = `${SPACE_BASE}/gradio_api/call/text_to_video`;
const HF_WHOAMI = "https://huggingface.co/api/whoami-v2";

/** Host exato aceito para download. Comparado por igualdade, nunca por sufixo. */
const SPACE_HOST = new URL(SPACE_BASE).hostname;

/**
 * Durações aprovadas. O slider do Space aceita 0.3–8.5s; oferecer "10s" na
 * interface criaria uma opção impossível, por isso o limite é 8.
 */
const ALLOWED_DURATIONS = [2, 5, 8];

/**
 * Formatos mapeados para dimensões que o modelo suporta.
 * Todas são múltiplos de 32 e ficam dentro de 256–1280. 704x512 é o default
 * do Space, portanto a opção horizontal é a de menor risco.
 */
const ASPECT_RATIO: Record<string, { width: number; height: number }> = {
  "9:16": { width: 512, height: 704 },
  "16:9": { width: 704, height: 512 },
  "1:1": { width: 512, height: 512 },
};

const FPS = 24;
const MIN_FRAMES = 9;
const MAX_FRAMES = 257;
const FRAME_STEP = 8;

/** Limite do JSON recebido pela função (16 KB). */
export const MAX_REQUEST_BYTES = 16 * 1024;

/** Acima deste tamanho o vídeo volta só como URL, para não inflar a resposta. */
export const MAX_INLINE_BYTES = 6 * 1024 * 1024;

/** Teto do buffer SSE de uma única chamada de `poll` (2 MB). */
export const MAX_SSE_BYTES = 2 * 1024 * 1024;

/** Tempo máximo segurando o SSE numa única chamada de `poll`. */
export const POLL_TIMEOUT_MS = 20000;

/** Tempo máximo do download do arquivo de vídeo. */
export const DOWNLOAD_TIMEOUT_MS = 30000;

/** Teto de comprimento da URL de vídeo recebida do Space. */
const MAX_VIDEO_URL_LENGTH = 2048;

const MAX_PROMPT_LENGTH = 1200;

/**
 * Hosts que nunca podem ser baixados, mesmo que a comparação de host mude no
 * futuro: loopback, redes privadas, metadata de nuvem e nomes internos.
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^0\.0\.0\.0$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /\.internal$/i,
  /\.local$/i,
  /^metadata\./i,
];

/**
 * Converte segundos em frames válidos (9..257, passo 8, como o slider exige).
 * 2s → 49, 5s → 121, 8s → 193.
 */
function framesFor(duration: number): number {
  const raw = Math.round(duration * FPS);
  const steps = Math.round((raw - MIN_FRAMES) / FRAME_STEP);
  const snapped = MIN_FRAMES + steps * FRAME_STEP;
  return Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, snapped));
}

/** Lê blocos SSE (`event:` / `data:`) do Gradio. */
function parseSse(raw: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];

  for (const block of raw.split("\n\n")) {
    let event = "message";
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join("\n") });
    }
  }

  return events;
}

/** Base64 em blocos, sem depender de Buffer (indisponível no Deno por padrão). */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }

  return btoa(binary);
}

/**
 * Lê o corpo com teto de bytes, sem confiar no tamanho anunciado.
 *
 * Por que existe: `arrayBuffer()` materializa o arquivo inteiro na memória
 * antes de qualquer checagem. Um arquivo inesperado derrubaria a função. Aqui
 * o `Content-Length` é conferido primeiro (quando presente) e, mesmo sem ele,
 * a leitura é interrompida assim que o acumulado passa do limite.
 */


export async function readBoundedBody(
  response: Pick<Response, "headers" | "body">,
  maxBytes: number
): Promise<{ bytes: Uint8Array | null; sizeBytes: number; truncated: boolean }> {
  const declared = Number(response.headers.get("content-length") ?? "");

  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // Corpo já encerrado.
    }
    return { bytes: null, sizeBytes: declared, truncated: true };
  }

  if (!response.body) {
    return { bytes: null, sizeBytes: 0, truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (value.byteLength > maxBytes - total) {
        total += value.byteLength;
        truncated = true;
        chunks.length = 0;
        break;
      }

      total += value.byteLength;
      chunks.push(value);
    }
  } finally {
    if (truncated) {
      try {
        await reader.cancel();
      } catch {
        // Stream já encerrado.
      }
    }

    try {
      reader.releaseLock();
    } catch {
      // Lock já liberado.
    }
  }

  if (truncated) {
    return { bytes: null, sizeBytes: total, truncated: true };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, sizeBytes: total, truncated: false };
}

/**
 * Aceita apenas HTTPS no host exato do Space.
 *
 * A comparação é por igualdade de `hostname`, o que já rejeita o truque
 * `lightricks-ltx-video-distilled.hf.space.evil.com`. Credenciais embutidas,
 * portas alternativas e hosts internos também são recusados.
 */
export function isSpaceUrl(candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;

  const value = candidate.trim();

  if (!value || value.length > MAX_VIDEO_URL_LENGTH) return false;

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== "443") return false;
  if (parsed.hostname !== SPACE_HOST) return false;

  return !BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname));
}

/** Devolve a URL normalizada quando ela é do Space; string vazia caso contrário. */
export function sanitizeVideoUrl(candidate: unknown): string {
  if (!isSpaceUrl(candidate)) return "";

  try {
    return new URL((candidate as string).trim()).toString();
  } catch {
    return "";
  }
}

/**
 * Monta a URL de arquivo do Gradio a partir do `path`.
 *
 * O prefixo já fixa o host; ainda assim `?`, `#`, `\` e `..` são recusados para
 * que o caminho não consiga reescrever a URL montada.
 */
function spaceFilePathUrl(path: unknown): string {
  if (typeof path !== "string") return "";
  if (!path || /[?#\\\s]/.test(path)) return "";
  if (path.includes("..")) return "";

  return sanitizeVideoUrl(`${SPACE_BASE}/gradio_api/file=${path}`);
}

/**
 * Extrai a URL do vídeo de dentro da resposta heterogênea do Gradio.
 *
 * Toda URL passa por `sanitizeVideoUrl`: uma resposta manipulada do Space não
 * consegue apontar o download (e o `HF_TOKEN`) para outra origem.
 */
export function extractVideoUrl(payload: unknown): string {
  const first = Array.isArray(payload) ? payload[0] : payload;

  if (typeof first === "string") return sanitizeVideoUrl(first);

  if (first && typeof first === "object") {
    const record = first as Record<string, unknown>;
    const video = record.video as Record<string, unknown> | undefined;

    if (video && typeof video.url === "string") {
      const direct = sanitizeVideoUrl(video.url);
      if (direct) return direct;
    }

    if (video && typeof video.path === "string") {
      const fromVideoPath = spaceFilePathUrl(video.path);
      if (fromVideoPath) return fromVideoPath;
    }

    if (typeof record.url === "string") {
      const direct = sanitizeVideoUrl(record.url);
      if (direct) return direct;
    }

    if (typeof record.path === "string") {
      return spaceFilePathUrl(record.path);
    }
  }

  return "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const respond = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });

  try {
    if (req.method !== "POST") {
      return respond({ error: "Método não permitido." }, 405);
    }

    // 1. Exigir usuário autenticado
    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return respond({ error: "Utilizador não autenticado." }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";

    const publishableKeys = JSON.parse(
      Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}"
    );

    const publishableKey = publishableKeys.default;

    if (!supabaseUrl || !publishableKey) {
      throw new Error("Configuração do Supabase incompleta.");
    }

    const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        "Authorization": authorization,
        "apikey": publishableKey,
      },
    });

    if (!authResponse.ok) {
      return respond({ error: "Sessão inválida. Entre novamente." }, 401);
    }

    // 2. Segredo lido apenas do ambiente — nunca devolvido ao cliente
    const hfToken = Deno.env.get("HF_TOKEN") || "";

    const requestBody = await readBoundedBody(req, MAX_REQUEST_BYTES);

    if (requestBody.truncated) {
      return respond({
        error: "A solicitação é muito grande. Reduza os dados enviados e tente novamente.",
      }, 413);
    }

    if (!requestBody.bytes) {
      return respond({ error: "Corpo da solicitação ausente ou inválido." }, 400);
    }

    let parsedBody: unknown;

    try {
      parsedBody = JSON.parse(new TextDecoder().decode(requestBody.bytes));
    } catch {
      return respond({ error: "O corpo da solicitação precisa ser um JSON válido." }, 400);
    }

    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return respond({ error: "Formato de solicitação inválido." }, 400);
    }

    const body = parsedBody as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";

    // ------------------------------------------------ health (sem segredo)
    if (action === "health") {
      return respond({
        success: true,
        hasToken: hfToken.length > 0,
        space: SPACE_ID,
        durations: ALLOWED_DURATIONS,
        formats: Object.keys(ASPECT_RATIO),
      });
    }

    // ------------------------------------------------ probe (não consome cota)
    if (action === "probe") {
      if (!hfToken) {
        return respond({
          success: false,
          hasToken: false,
          error: "HF_TOKEN não configurado no Supabase.",
        }, 503);
      }

      let tokenValid = false;

      try {
        const whoami = await fetch(HF_WHOAMI, {
          headers: { "Authorization": `Bearer ${hfToken}` },
        });
        tokenValid = whoami.ok;
      } catch (probeError) {
        console.error("Falha ao validar o token do Hugging Face:", probeError);
      }

      let spaceReachable = false;
      let spaceStatus = 0;
      let endpoints: string[] = [];

      try {
        const info = await fetch(`${SPACE_BASE}/gradio_api/info`, {
          headers: { "Authorization": `Bearer ${hfToken}` },
        });

        spaceStatus = info.status;
        spaceReachable = info.ok;

        if (info.ok) {
          const config = await info.json();
          endpoints = Object.keys(config?.named_endpoints || {});
        }
      } catch (spaceError) {
        console.error("Falha ao alcançar o Space:", spaceError);
      }

      return respond({
        success: true,
        hasToken: true,
        tokenValid,
        space: SPACE_ID,
        spaceReachable,
        spaceStatus,
        endpoints,
      });
    }

    // ------------------------------------------------ submit
    if (action === "submit") {
      if (!hfToken) {
        return respond({
          success: false,
          error: "HF_TOKEN não configurado no Supabase.",
        }, 503);
      }

      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

      if (!prompt) {
        return respond({ error: "Descreva o vídeo antes de gerar." }, 400);
      }

      if (prompt.length > MAX_PROMPT_LENGTH) {
        return respond({
          error: `A descrição do vídeo deve ter até ${MAX_PROMPT_LENGTH} caracteres.`,
        }, 400);
      }

      const duration = Number(body.duration);

      if (!ALLOWED_DURATIONS.includes(duration)) {
        return respond({
          error: "Duração inválida. Use 2, 5 ou 8 segundos.",
        }, 400);
      }

      const format = typeof body.format === "string" ? body.format : "16:9";
      const aspect = ASPECT_RATIO[format] || ASPECT_RATIO["16:9"];

      const negativePrompt =
        typeof body.negativePrompt === "string"
          ? body.negativePrompt.trim().slice(0, 400)
          : "";

      const frames = framesFor(duration);
      const seed = Math.floor(Math.random() * 2147483647);

      /**
       * Ordem dos argumentos de `text_to_video` no Space:
       * mode, prompt, negative_prompt, image_file, height, width, duration,
       * frames, guidance_scale, improve_texture, seed, randomize_seed.
       *
       * `mode` precisa ser "text-to-video": o default do Space é
       * "image-to-video" e a geração falharia sem imagem de entrada.
       * `improve_texture` fica false para poupar cota.
       */
      const payload = {
        data: [
          "text-to-video",
          prompt,
          negativePrompt,
          null,
          aspect.height,
          aspect.width,
          duration,
          frames,
          1,
          false,
          seed,
          false,
        ],
      };

      const submitResponse = await fetch(GRADIO_CALL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${hfToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const submitText = await submitResponse.text();

      if (!submitResponse.ok) {
        console.error(
          "Erro ao submeter ao Space:",
          submitResponse.status,
          submitText.slice(0, 500)
        );

        const friendly = submitResponse.status === 401
          ? "O Hugging Face recusou o token configurado."
          : submitResponse.status === 429
          ? "A fila gratuita do ZeroGPU está cheia. Tente novamente mais tarde."
          : "O serviço gratuito de vídeo não aceitou a solicitação.";

        return respond({ success: false, error: friendly }, 502);
      }

      let eventId = "";

      try {
        const parsed = JSON.parse(submitText);
        eventId = typeof parsed.event_id === "string" ? parsed.event_id : "";
      } catch {
        eventId = submitText.trim();
      }

      if (!eventId) {
        return respond({
          success: false,
          error: "O serviço não devolveu um identificador de geração.",
        }, 502);
      }

      return respond({
        success: true,
        eventId,
        duration,
        format,
        width: aspect.width,
        height: aspect.height,
        frames,
        seed,
      });
    }

    // ------------------------------------------------ poll
    if (action === "poll") {
      if (!hfToken) {
        return respond({
          success: false,
          error: "HF_TOKEN não configurado no Supabase.",
        }, 503);
      }

      const eventId = typeof body.eventId === "string"
        ? body.eventId.trim()
        : "";

      if (!/^[A-Za-z0-9_-]{4,120}$/.test(eventId)) {
        return respond({ error: "Identificador de geração inválido." }, 400);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);

      let raw = "";

      try {
        const streamResponse = await fetch(`${GRADIO_CALL}/${eventId}`, {
          headers: {
            "Authorization": `Bearer ${hfToken}`,
            "Accept": "text/event-stream",
          },
          signal: controller.signal,
        });

        if (!streamResponse.ok) {
          return respond({
            success: false,
            error: "Não foi possível consultar a geração.",
          }, 502);
        }

        const reader = streamResponse.body?.getReader();
        const decoder = new TextDecoder();

        if (reader) {
          let finished = false;
          let received = 0;
          let sseTruncated = false;

          while (!finished) {
            const { value, done } = await reader.read();
            if (done) break;

            if (value) received += value.byteLength;

            raw += decoder.decode(value, { stream: true });

            // Para de ler assim que o resultado chega.
            if (/event:\s*(complete|error)/.test(raw)) {
              finished = true;

              try {
                await reader.cancel();
              } catch {
                // cancelar um stream já encerrado não é erro relevante
              }

              break;
            }

            // Teto de memória: um stream anómalo não pode inflar a função.
            if (received > MAX_SSE_BYTES || raw.length > MAX_SSE_BYTES) {
              sseTruncated = true;

              try {
                await reader.cancel();
              } catch {
                // cancelar um stream já encerrado não é erro relevante
              }

              break;
            }
          }

          if (sseTruncated) {
            console.warn(
              "Buffer SSE acima de 2 MB: leitura interrompida.",
              received
            );
          }
        }
      } catch (pollError) {
        const aborted = pollError instanceof Error &&
          pollError.name === "AbortError";

        // Timeout é esperado: a fila ainda está a correr.
        if (!aborted) {
          console.error("Erro ao consultar o Space:", pollError);
          return respond({
            success: false,
            error: "Falha ao consultar a geração.",
          }, 502);
        }
      } finally {
        clearTimeout(timer);
      }

      const events = parseSse(raw);

      const errorEvent = events.find((item) => item.event === "error");

      if (errorEvent) {
        return respond({
          success: false,
          status: "error",
          error: errorEvent.data.slice(0, 300),
        });
      }

      const completeEvent = events.find((item) => item.event === "complete");

      if (!completeEvent) {
        return respond({
          success: true,
          status: "pending",
          progress: events.filter((item) => item.event === "generating").length,
        });
      }

      let videoUrl = "";

      try {
        videoUrl = extractVideoUrl(JSON.parse(completeEvent.data));
      } catch {
        videoUrl = "";
      }

      if (!videoUrl) {
        return respond({
          success: false,
          status: "error",
          error: "A geração terminou sem devolver um vídeo.",
        });
      }

      // Tenta embutir os bytes para evitar expiração da URL e CORS no cliente.
      // O download só acontece no host do Space: se a URL não passar na
      // validação, nada é baixado e o token não sai daqui.
      let video = "";
      let sizeBytes = 0;

      if (!isSpaceUrl(videoUrl)) {
        console.warn("URL de vídeo recusada pela validação de origem.");
      } else {
        const downloadController = new AbortController();
        const downloadTimer = setTimeout(
          () => downloadController.abort(),
          DOWNLOAD_TIMEOUT_MS
        );

        try {
          const fileResponse = await fetch(videoUrl, {
            headers: { "Authorization": `Bearer ${hfToken}` },
            // 3xx nunca é seguido: um redirecionamento sairia do domínio.
            redirect: "manual",
            signal: downloadController.signal,
          });

          if (fileResponse.ok && fileResponse.status < 300) {
            const read = await readBoundedBody(fileResponse, MAX_INLINE_BYTES);
            sizeBytes = read.sizeBytes;

            if (read.bytes) {
              video = `data:video/mp4;base64,${encodeBase64(read.bytes)}`;
            } else if (read.truncated) {
              console.warn(
                "Vídeo acima de 6 MB: devolvido apenas como URL.",
                read.sizeBytes
              );
            }
          }
        } catch (downloadError) {
          const aborted = downloadError instanceof Error &&
            downloadError.name === "AbortError";

          console.error(
            aborted
              ? "Download do vídeo excedeu 30s e foi interrompido."
              : "Falha ao baixar o vídeo:",
            downloadError
          );
        } finally {
          clearTimeout(downloadTimer);
        }
      }

      return respond({
        success: true,
        status: "complete",
        videoUrl,
        video,
        sizeBytes,
      });
    }

    return respond({ error: "Ação não reconhecida." }, 400);
  } catch (error) {
    console.error("Erro na função gerar-video-ia:", error);

    return respond({
      success: false,
      error: error instanceof Error
        ? error.message
        : "Erro inesperado ao gerar vídeo.",
    }, 500);
  }
});
