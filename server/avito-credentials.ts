import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { pool } from "./db.js";

export type AvitoApiAccount = {
  key: string;
  name: string;
  ownerId: string;
  clientId: string;
  clientSecret: string;
};

type CredentialPayload = { clientId: string; clientSecret: string };
type AccountRow = { account_key: string; owner_id: string; name: string; credentials_ciphertext: string };

function encryptionKey(): Buffer {
  const encoded = process.env.AVITO_CREDENTIALS_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(encoded)) throw new Error("Avito credential encryption is not configured");
  return Buffer.from(encoded, "hex");
}

function encrypt(payload: CredentialPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decrypt(value: string): CredentialPayload {
  const [version, ivText, tagText, ciphertextText, ...extra] = value.split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText || extra.length) throw new Error("Invalid encrypted Avito credential format");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
  const payload: unknown = JSON.parse(plaintext);
  if (!payload || typeof payload !== "object" || typeof (payload as CredentialPayload).clientId !== "string" || typeof (payload as CredentialPayload).clientSecret !== "string") {
    throw new Error("Invalid decrypted Avito credential payload");
  }
  return payload as CredentialPayload;
}

function accountFromRow(row: AccountRow): AvitoApiAccount {
  const credentials = decrypt(row.credentials_ciphertext);
  return { key: row.account_key, name: row.name, ownerId: row.owner_id, ...credentials };
}

export async function createAvitoApiAccount(ownerId: string, name: string, clientId: string, clientSecret: string): Promise<AvitoApiAccount> {
  const key = randomBytes(18).toString("base64url");
  const { rows } = await pool.query<AccountRow>(
    `insert into avito_api_accounts(account_key,owner_id,name,credentials_ciphertext)
     values($1,$2,$3,$4)
     returning account_key,owner_id,name,credentials_ciphertext`,
    [key, ownerId, name, encrypt({ clientId, clientSecret })],
  );
  return accountFromRow(rows[0]);
}

export async function avitoApiAccountsForOwner(ownerId: string): Promise<AvitoApiAccount[]> {
  const { rows } = await pool.query<AccountRow>(
    `select account_key,owner_id,name,credentials_ciphertext from avito_api_accounts
      where owner_id=$1 order by created_at,account_key`,
    [ownerId],
  );
  return rows.map(accountFromRow);
}

export async function avitoApiAccountByKey(key: string): Promise<AvitoApiAccount | null> {
  const { rows } = await pool.query<AccountRow>(
    `select account_key,owner_id,name,credentials_ciphertext from avito_api_accounts where account_key=$1`,
    [key],
  );
  return rows[0] ? accountFromRow(rows[0]) : null;
}
