export const MAX_IMAGE_RESPONSE_BYTES = 23 * 1024 * 1024;

type Environment = Record<string, string | undefined>;

export function imageRequestBody(prompt: string, model?: string) {
  return {
    model: model?.trim() || "gpt-image-2.5-flare",
    prompt,
    size: "1024x1024",
    quality: "medium",
    output_format: "jpeg",
    output_compression: 80,
    n: 1,
  };
}

export function imageProviderConfig(env: Environment = process.env) {
  const workerUrl = env.IMAGE_WORKER_URL?.trim();
  if (workerUrl) {
    const url = new URL(workerUrl);
    const privateHttp = url.protocol === "http:" && ["image-tunnel", "127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((!privateHttp && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("IMAGE_WORKER_URL must be an HTTPS origin or the private SSH tunnel origin");
    }
    const token = env.IMAGE_WORKER_TOKEN?.trim();
    if (!token || token.length < 32) throw new Error("IMAGE_WORKER_TOKEN must contain at least 32 characters");
    return { url: new URL("/v1/images/generations", url).href, token, remote: true };
  }
  const token = env.OPENAI_API_KEY?.trim();
  if (!token) throw new Error("OpenAI image generation is not configured");
  return { url: "https://api.openai.com/v1/images/generations", token, remote: false };
}

export function requestImage(
  prompt: string,
  config: ReturnType<typeof imageProviderConfig>,
  signal: AbortSignal,
  model?: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return fetcher(config.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(imageRequestBody(prompt, model)),
    redirect: "error",
    signal,
  });
}

// Enforce the limit while receiving the body, including chunked responses.
export async function readImageResponse(response: Response): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Image response exceeds size limit");
  }
  if (!response.body) throw new Error("Image response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_RESPONSE_BYTES) throw new Error("Image response exceeds size limit");
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
