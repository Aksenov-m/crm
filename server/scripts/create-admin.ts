import { createInterface } from "node:readline";
import { pool } from "../db.js";
import { hashPassword, isValidEmail, normalizeEmail } from "../auth.js";

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Запустите эту команду в интерактивном терминале, чтобы пароль не попал в историю команд.");
  }
  process.stdout.write("Пароль (минимум 12 символов): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("Отменено."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          if (value.length) { value = value.slice(0, -1); process.stdout.write("\b \b"); }
          continue;
        }
        if (character >= " ") { value += character; process.stdout.write("*"); }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const email = normalizeEmail(await new Promise<string>((resolve) => prompt.question("Email владельца CRM: ", resolve)));
  prompt.close();
  const password = await readPassword();
  if (!isValidEmail(email) || password.length < 12 || password.length > 256) throw new Error("Укажите корректный email и пароль длиной от 12 до 256 символов.");

  const userCount = await pool.query<{ count: string }>("select count(*)::text as count from app_users");
  const exists = await pool.query("select 1 from app_users where email = $1", [email]);
  if (exists.rowCount) throw new Error("Пользователь с таким email уже существует.");
  const user = await pool.query<{ id: string }>(
    "insert into app_users(email,password_hash) values($1,$2) returning id",
    [email, hashPassword(password)],
  );
  console.info(`${userCount.rows[0]?.count === "0" ? "Создан первый владелец" : "Создан пользователь"}: ${email} (${user.rows[0]?.id})`);
}

main().then(() => pool.end()).catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : "Не удалось создать пользователя.");
  await pool.end();
  process.exitCode = 1;
});
