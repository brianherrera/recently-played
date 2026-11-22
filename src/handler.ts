import { SecretsManagerCredentialStore } from "./credentials";
import { run, type RunSummary } from "./run";
import { S3Storage } from "./storage";

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
};

export async function handler(): Promise<RunSummary> {
  const summary = await run({
    storage: new S3Storage(required("BUCKET_NAME")),
    credentials: new SecretsManagerCredentialStore(required("SECRET_ID")),
    config: {
      topN: Number(process.env.TOP_N ?? 10),
      perPlatformLimit: Number(process.env.PER_PLATFORM_LIMIT ?? 25),
      publicBaseUrl: required("PUBLIC_BASE_URL"),
    },
  });
  console.log("Run summary", JSON.stringify(summary));
  return summary;
}
