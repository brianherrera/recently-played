import { TimeZone } from "aws-cdk-lib";

/**
 * Deployment settings, read from environment variables so nothing site-specific lives in the repo.
 * Locally they can come from a `.env` file; in GitHub Actions they come from repo variables/secrets.
 */
export interface DeployConfig {
  account?: string;
  domainName: string;
  subdomain: string;
  allowedOrigins: string[];
  hostedZoneId?: string;
  scheduleHour: number;
  scheduleTimeZone: TimeZone;
  topN: number;
}

type Env = Record<string, string | undefined>;

function get(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = get(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

export function loadConfig(env: Env = process.env): DeployConfig {
  const domainName = get(env, "DOMAIN_NAME");
  if (!domainName) {
    throw new Error(
      "DOMAIN_NAME is required (apex domain with a Route53 hosted zone, e.g. example.com). " +
        "Set it in .env locally, or as a repository variable in GitHub Actions.",
    );
  }
  const subdomain = get(env, "SUBDOMAIN") ?? "games";
  const allowedOrigins = (get(env, "ALLOWED_ORIGINS") ?? `https://${domainName},https://www.${domainName}`)
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  return {
    account: get(env, "AWS_ACCOUNT_ID") ?? get(env, "CDK_DEFAULT_ACCOUNT"),
    domainName,
    subdomain,
    allowedOrigins,
    hostedZoneId: get(env, "HOSTED_ZONE_ID"),
    scheduleHour: int(env, "SCHEDULE_HOUR", 3, 0, 23),
    scheduleTimeZone: TimeZone.of(get(env, "SCHEDULE_TIMEZONE") ?? "America/Los_Angeles"),
    topN: int(env, "TOP_N", 10, 1, 100),
  };
}

/** Loads `.env` from the working directory if present (Node 21.7+). Real env vars win. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file; rely on the real environment
  }
}
