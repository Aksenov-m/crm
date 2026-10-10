import { createHmac, timingSafeEqual } from "node:crypto";

export type MessengerBinding = { ownerId: string; key: string; accountId: string; clientId: string };

function webhookScope(binding: MessengerBinding): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([binding.ownerId, binding.key, binding.accountId, binding.clientId]));
}

export function webhookSecret(env: (name: string) => string | undefined): string {
  const secret = env("AVITO_WEBHOOK_SECRET") || "";
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error("AVITO_WEBHOOK_SECRET must be 64 hexadecimal characters");
  return secret;
}

export function signWebhook(secret: string, binding: MessengerBinding): string {
  return createHmac("sha256", secret).update(webhookScope(binding)).digest("hex");
}

export function verifyWebhook(secret: string, binding: MessengerBinding, signature: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const actual = Buffer.from(signature, "hex");
  const expected = Buffer.from(signWebhook(secret, binding), "hex");
  return timingSafeEqual(actual, expected);
}
