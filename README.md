# Recently Played

A daily job that gathers recently played games from Steam, PlayStation and Xbox and publishes them as a JSON file at `https://<SUBDOMAIN>.<DOMAIN_NAME>/games.json`. From there your website can fetch it in the browser and render the list.

```
EventBridge Scheduler
        │
        ▼
Lambda (Node 24), Secrets Manager (platform creds)
        │
        ├── Steam Web API (GetOwnedGames)
        ├── PSN (psn-api)
        └── Xbox (OpenXBL)
        │
        ▼
S3 bucket ── public/  ──► CloudFront (games.example.com, CORS for example.com)
          └─ private/ (state.json, daily snapshots; never served)
        │
        ▼
CloudWatch alarms ──► SNS topic
```

## How it works

- Each run fetches up to 25 recent games per platform. Each game is merged into `private/state.json`.
- The generated file consolidates the list into the top 10 by last-played date across all platforms. Older games move down and drop off the list as new ones are played.
- Cover art is copied into the bucket the first time a game shows up in the top 10, under `public/covers/<platform>/<id>.<ext>`.

## Repo layout

- **CDK app** (`bin/`, `lib/`): the stack defining all AWS resources, configured from env vars
- **Lambda source** (`src/`): fetches from each platform, merges and ranks games, caches cover art, and publishes the result
- **Local runner** (`scripts/`): runs against the APIs without AWS, writing to `.local/`
- **Tests** (`test/`): Vitest suites for logic, mocked adapters, and CDK template assertions
- **CI/CD** (`.github/workflows/`): runs on every push/PR; deploys `main` when configured

## Setup

### Prerequisites

- Node 22+
- An AWS account with a Route53 public hosted zone for your domain
- AWS CLI credentials for your account (local deploys) or GitHub repo secrets (CI deploys)
- CDK bootstrapped in us-east-1: `npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1`

```sh
npm ci
npm run check   # typecheck + tests
```

### Configuration

All deploy settings come from environment variables: a `.env` file locally, or repository variables and secrets in GitHub Actions.

| Name | Required | Default | Description |
|---|---|---|---|
| `DOMAIN_NAME` | yes | | Domain with a Route53 hosted zone, e.g. `example.com` |
| `SUBDOMAIN` | | `games` | The feed is served from `https://<SUBDOMAIN>.<DOMAIN_NAME>` |
| `ALLOWED_ORIGINS` | | `https://<DOMAIN_NAME>,https://www.<DOMAIN_NAME>` | Comma-separated CORS origins. Add `http://localhost:port` for local web testing |
| `SCHEDULE_HOUR` | | `3` | Hour of the daily run (0–23) |
| `SCHEDULE_TIMEZONE` | | `America/Los_Angeles` | IANA time zone for `SCHEDULE_HOUR` |
| `TOP_N` | | `10` | Games published in `games.json` |
| `HOSTED_ZONE_ID` | | lookup | Pin the zone ID instead of looking it up at synth time |
| `AWS_ACCOUNT_ID` | | from credentials | Target account; in CI it also guards against deploying to the wrong account |

### 1. Collect credentials

| Platform | What you need | Where |
|---|---|---|
| Steam | Web API key and your 64-bit SteamID | Key: https://steamcommunity.com/dev/apikey. SteamID: 17-digit SteamID64. |
| PlayStation | NPSSO token (64 characters) | Sign in at https://www.playstation.com, then open https://ca.account.sony.com/api/v1/ssocookie in the same browser and copy `npsso`. |
| Xbox | OpenXBL API key | Sign in at https://xbl.io with your Microsoft account and create a key. |

Leave a platform out of the JSON to disable it.

### 2. Test locally

```sh
cp local-credentials.example.json local-credentials.json   # gitignored
# Update file

npm run run:local
cat .local/public/games.json
```

This calls the platform APIs and writes the same files the Lambda would, into `.local/`.

### 3. Deploy

**Locally:**

```sh
cp .env.example .env   # set DOMAIN_NAME, etc.

# Set AWS CLI credentials
npx cdk diff # Check stack differences
npm run deploy
```

**From GitHub Actions:** 

In your repo go to **Settings → Secrets and variables → Actions** and add:

| Kind | Name | Value |
|---|---|---|
| Variable | `DOMAIN_NAME` | Your domain (required; the deploy job is skipped without it) |
| Variable | `SUBDOMAIN`, `ALLOWED_ORIGINS`, `SCHEDULE_HOUR`, `SCHEDULE_TIMEZONE`, `TOP_N` | Optional, see [Configuration](#configuration) |
| Secret | `AWS_ACCOUNT_ID` | Your 12-digit AWS account ID |
| Secret | `AWS_ROLE_ARN` | **Recommended:** an IAM role GitHub can assume via OIDC (no long-lived keys) |
| Secret | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Alternative to `AWS_ROLE_ARN`: an IAM user's access keys |
| Secret | `HOSTED_ZONE_ID` | Optional, see [Configuration](#configuration) |

The deploy job runs in a GitHub environment named `production`, so you can also put these on that environment and add protection rules (e.g. required reviewers).

### 4. Store platform credentials in Secrets Manager

The stack creates the `recently-played/credentials` secret with a random placeholder value. CDK never overwrites the value after creation. Replace it with your JSON:

```sh
aws secretsmanager put-secret-value \
  --secret-id recently-played/credentials \
  --secret-string file://local-credentials.json
```

The secret has this shape. `refreshToken` and `refreshTokenExpiresAt` are managed by the Lambda.

```json
{
  "steam":       { "apiKey": "...", "steamId": "..." },
  "playstation": { "npsso": "...", "refreshToken": "...", "refreshTokenExpiresAt": "..." },
  "xbox":        { "apiKey": "..." }
}
```

### 5. Run it once

```sh
aws lambda invoke --function-name <FunctionName output> /dev/stdout
curl -s https://games.example.com/games.json | jq
```

## Alerts

| Alarm | Fires when |
|---|---|
| RunFailed | The Lambda errored: every platform failed, or it crashed |
| NotRunning | No invocations for 2 days, so the schedule is broken |
| \<platform\>Failure | One platform failed 2 days in a row |
| PlayStationRelogin | The PSN refresh token expires in under 7 days |

Manually subscribe to the SNS topic as needed.

**PSN re-login:** get a new NPSSO (step 1). Then edit the `playstation.npsso` field in the secret. Leave the other fields alone; the Lambda overwrites the token fields itself.

## Output (`games.json`)

This is what your website will use to render the list as you like.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-20T11:00:02.123Z",
  "platforms": {
    "steam":       { "lastSuccess": "2026-11-20T11:00:02.123Z" },
    "playstation": { "lastSuccess": "2026-11-20T11:00:02.123Z" },
    "xbox":        { "lastSuccess": "2026-11-18T11:00:01.456Z" }
  },
  "games": [
    {
      "id": "steam:1145360",
      "platform": "steam",
      "title": "Hades",
      "lastPlayed": "2026-11-19T04:12:00.000Z",
      "coverUrl": "https://games.example.com/covers/steam/1145360.jpg"
    }
  ]
}
```

`platform` is one of `steam`, `playstation` or `xbox`. `coverUrl` can be missing.
