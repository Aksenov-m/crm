const configuredBase = process.env.NEXT_PUBLIC_BACKEND_URL?.trim().replace(/\/+$/u, "") || "";
export type AppUser = { id: string; email: string };

export function backendUrl(path: string): string {
  return `${configuredBase}${path.startsWith("/") ? path : `/${path}`}`;
}

export class BackendRequestError extends Error {
  constructor(message: string, public status: number, public code = "backend_error") {
    super(message);
    this.name = "BackendRequestError";
  }
}

export async function backendRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(backendUrl(path), {
      ...init,
      credentials: "include",
      cache: "no-store",
      headers: init.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init.headers },
    });
  } catch {
    throw new BackendRequestError("Не удалось подключиться к серверу CRM. Проверьте адрес API и сеть.", 0, "connection_error");
  }
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* Use the status fallback below. */ }
  if (!response.ok) {
    const row = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const message = typeof row.message === "string" ? row.message : `Сервер CRM ответил с ошибкой ${response.status}.`;
    const code = typeof row.code === "string" ? row.code : typeof row.error === "string" ? row.error : "backend_error";
    throw new BackendRequestError(message, response.status, code);
  }
  return data as T;
}
