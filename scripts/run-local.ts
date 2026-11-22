/**
 * Run the retriever locally against real platform APIs without touching AWS.
 *
 *   cp local-credentials.example.json local-credentials.json   # fill in (gitignored)
 *   npm run run:local
 *
 * Output lands in .local/ (same layout as the bucket). Rotated PSN tokens are
 * written back to local-credentials.json, just as the Lambda writes to Secrets Manager.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CredentialStore, Credentials } from "../src/credentials";
import { run } from "../src/run";
import type { Storage } from "../src/storage";

const ROOT = join(process.cwd(), ".local");
const CREDS_FILE = join(process.cwd(), "local-credentials.json");

class FileStorage implements Storage {
  async getJson<T>(key: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(join(ROOT, key), "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }
  async put(key: string, body: string | Uint8Array): Promise<void> {
    const file = join(ROOT, key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
}

class FileCredentialStore implements CredentialStore {
  async load(): Promise<Credentials> {
    return JSON.parse(await readFile(CREDS_FILE, "utf8")) as Credentials;
  }
  async save(creds: Credentials): Promise<void> {
    await writeFile(CREDS_FILE, JSON.stringify(creds, null, 2) + "\n");
  }
}

/** Same URL the deployed Lambda uses, so cover URLs in .local/ look like production. */
function publicBaseUrl(): string {
  const domain = process.env.DOMAIN_NAME?.trim();
  if (!domain) return "https://games.example.com";
  return `https://${process.env.SUBDOMAIN?.trim() || "games"}.${domain}`;
}

async function main() {
  try {
    process.loadEnvFile();
  } catch {
    // no .env; defaults are fine for a local dry run
  }
  const summary = await run({
    storage: new FileStorage(),
    credentials: new FileCredentialStore(),
    config: { topN: Number(process.env.TOP_N) || 10, perPlatformLimit: 25, publicBaseUrl: publicBaseUrl() },
  });
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${join(ROOT, "public/games.json")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
