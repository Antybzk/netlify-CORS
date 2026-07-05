// netlify/edge-functions/proxy-handler.ts
import type { Context } from "@netlify/edge-functions";

// Конфигурация прокси
const PROXY_CONFIG = {
  "/gigachat": "https://gigachat.devices.sberbank.ru",
};

// Переменные для хранения токена
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

// Функция для получения Access Token
async function getAccessToken(): Promise<string> {
  // Проверяем, не истек ли токен (с запасом в 60 секунд)
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  const authKey = Deno.env.get("GIGACHAT_API_KEY");
  if (!authKey) {
    throw new Error("GIGACHAT_API_KEY не найден в переменных окружения");
  }

  const tokenUrl = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
  const rqUid = crypto.randomUUID ? crypto.randomUUID() : "94d77663-887c-45f2-baa1-53eb0cf48e70";

  console.log("🔄 Получение нового Access Token...");

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "RqUID": rqUid,
      "Authorization": `Basic ${authKey}`,
    },
    body: "scope=GIGACHAT_API_PERS",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ошибка получения токена: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 1800) * 1000;

  console.log("✅ Access Token получен, действует до:", new Date(tokenExpiry).toISOString());
  return cachedToken;
}

// Основная функция прокси
export default async (request: Request, context: Context) => {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  // Ищем правило прокси
  let targetBaseUrl: string | null = null;
  let matchedPrefix: string | null = null;

  const prefixes = Object.keys(PROXY_CONFIG).sort().reverse();
  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(prefix + "/")) {
      targetBaseUrl = PROXY_CONFIG[prefix as keyof typeof PROXY_CONFIG];
      matchedPrefix = prefix;
      break;
    }
  }

  if (!targetBaseUrl || !matchedPrefix) {
    return; // Не наш прокси-путь — пропускаем
  }

  // Строим целевой URL
  const remainingPath = path.substring(matchedPrefix.length);
  const targetUrlString = targetBaseUrl.replace(/\/$/, "") + remainingPath;
  const targetUrl = new URL(targetUrlString);
  targetUrl.search = url.search;

  context.log(`➡️ Проксируем "${path}" в "${targetUrl.toString()}"`);

  try {
    // Получаем Access Token (с кешированием)
    const accessToken = await getAccessToken();

    // Создаем запрос к целевому серверу
    const proxyRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
    });

    // Устанавливаем правильные заголовки
    proxyRequest.headers.set("Host", targetUrl.host);
    proxyRequest.headers.set("Authorization", `Bearer ${accessToken}`);
    proxyRequest.headers.delete("accept-encoding");

    // Добавляем CORS-заголовки для ответа
    const response = await fetch(proxyRequest);

    let newResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    newResponse.headers.set("Access-Control-Allow-Origin", "*");
    newResponse.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    newResponse.headers.set("Access-Control-Allow-Headers", "*");

    // Если токен истек (401), принудительно обновим при следующем запросе
    if (response.status === 401) {
      console.warn("⚠️ Access Token истек, будет обновлен при следующем запросе");
      cachedToken = null;
      tokenExpiry = 0;
    }

    return newResponse;
  } catch (error) {
    context.log("❌ Ошибка прокси:", error);
    return new Response(`Прокси-запрос не удался: ${error.message}`, {
      status: 502,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/plain;charset=UTF-8",
      },
    });
  }
};
