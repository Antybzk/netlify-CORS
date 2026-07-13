// netlify/edge-functions/proxy-handler.ts
import type { Context } from "@netlify/edge-functions";

// ... (PROXY_CONFIG и другие настройки остаются без изменений)

// Переменные для хранения токена
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

// Функция для получения Access Token с отключённой проверкой SSL
async function getAccessToken(): Promise<string> {
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

  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "RqUID": rqUid,
        "Authorization": authKey, // Здесь уже должен быть "Basic ..."
      },
      body: "scope=GIGACHAT_API_PERS",
      // ↓↓↓ КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: Игнорируем ошибки SSL ↓↓↓
      // @ts-ignore - Deno-specific option
      deno: {
        tls: {
          allowInvalidCertificates: true,
        },
      },
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
  } catch (error) {
    console.error("Ошибка при получении токена:", error);
    throw error;
  }
}

// ... (остальной код прокси: export default, обработка запросов и т.д.)