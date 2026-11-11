const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

  let charged = false;
  let userId = "";
  let adminKey = "";
  let supabaseUrl = "";

  try {
    if (req.method !== "POST") {
      return respond({ error: "Método não permitido." }, 405);
    }

    // 1. Verificar autenticação
    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return respond({ error: "Utilizador não autenticado." }, 401);
    }

    supabaseUrl = Deno.env.get("SUPABASE_URL") || "";

    const secretKeys = JSON.parse(
      Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"
    );

    const publishableKeys = JSON.parse(
      Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}"
    );

    adminKey = secretKeys.default;
    const publishableKey = publishableKeys.default;

    if (!supabaseUrl || !adminKey || !publishableKey) {
      throw new Error("Configuração do Supabase incompleta.");
    }

    const authResponse = await fetch(
      `${supabaseUrl}/auth/v1/user`,
      {
        headers: {
          "Authorization": authorization,
          "apikey": publishableKey,
        },
      }
    );

    if (!authResponse.ok) {
      return respond({ error: "Sessão inválida. Entre novamente." }, 401);
    }

    const user = await authResponse.json();
    userId = user.id;

    // 2. Validar descrição
    const body = await req.json();

    const prompt =
      typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!prompt) {
      return respond({
        error: "Nenhuma descrição de imagem foi recebida.",
      }, 400);
    }

    if (prompt.length > 2000) {
      return respond({
        error: "A descrição da imagem é demasiado longa.",
      }, 400);
    }

    // 3. Descontar um crédito no servidor
    const debitResponse = await fetch(
      `${supabaseUrl}/rest/v1/rpc/consume_image_credit`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${adminKey}`,
          "apikey": adminKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_user_id: userId,
        }),
      }
    );

    if (!debitResponse.ok) {
      const errorText = await debitResponse.text();

      if (errorText.includes("CRÉDITOS_INSUFICIENTES")) {
        return respond({
          error: "Créditos insuficientes. Adquira mais créditos para continuar.",
        }, 402);
      }

      console.error("Erro ao descontar crédito:", errorText);
      throw new Error("Não foi possível verificar os seus créditos.");
    }

    const balance = await debitResponse.json();
    charged = true;

    // 4. Gerar imagem no Cloudflare
    const apiToken = Deno.env.get("CLOUDFLARE_API_TOKEN");
    const accountId = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");

    if (!apiToken || !accountId) {
      throw new Error("Configuração do Cloudflare não encontrada.");
    }

    const model = "@cf/black-forest-labs/flux-1-schnell";

    const cloudflareResponse = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt }),
      }
    );

    const result = await cloudflareResponse.json();

    if (!cloudflareResponse.ok || !result.success) {
      console.error("Erro Cloudflare:", result);
      const cloudflareError = JSON.stringify(result);

      if (cloudflareError.includes("daily free allocation")) {
        throw new Error(
          "Limite diário de imagens atingido. Seus créditos foram preservados. Tente novamente amanhã."
        );
      }

      throw new Error(
        "O serviço de imagens está temporariamente indisponível. Seu crédito será devolvido."
      );
    }

    const image = result.result?.image;

    if (!image) {
      throw new Error("O Cloudflare não retornou uma imagem.");
    }

    // 5. Devolver imagem e saldo
    return respond({
      success: true,
      image: `data:image/png;base64,${image}`,
      creditsRemaining: balance,
    });

  } catch (error) {
    console.error("Erro na função gerar-imagem-ia:", error);

    // 6. Devolver crédito se a geração falhar
    if (charged && userId && adminKey && supabaseUrl) {
      try {
        const refundResponse = await fetch(
          `${supabaseUrl}/rest/v1/rpc/refund_image_credit`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${adminKey}`,
              "apikey": adminKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              p_user_id: userId,
            }),
          }
        );

        if (!refundResponse.ok) {
          console.error(
            "ATENÇÃO: Falha ao devolver crédito:",
            await refundResponse.text()
          );
        }

      } catch (refundError) {
        console.error("Erro ao devolver crédito:", refundError);
      }
    }

    return respond({
      success: false,
      error: error instanceof Error
        ? error.message
        : "Erro inesperado ao gerar imagem.",
    }, 500);
  }
});
