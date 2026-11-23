# Recently Played

Gathers your recently played games from Steam, PlayStation and Xbox and publishes them as a single `games.json` file. Your website can fetch it in the browser and render the list.

There are two ways to run it:

- **Self-hosted:** the local runner writes `games.json` and cover art to a folder. Schedule it with cron and upload or serve the files on the host.
- **On AWS:** a CDK stack runs it daily as a Lambda and serves the files using CloudFront (e.g. `https://<SUBDOMAIN>.<DOMAIN_NAME>/games.json`).

## How it works

- Each run fetches up to 25 recent games per platform. Each game is merged into `private/state.json`.
- The generated file consolidates the list into the top 10 by last-played date across all platforms. Older games move down and drop off the list as new ones are played.
- Cover art is copied into the output the first time a game shows up in the top 10, under `public/covers/<platform>/<id>.<ext>`.

## Repo layout

- **Retriever** (`src/`): fetches from each platform, merges and ranks games, caches cover art, and publishes the result
- **Local runner** (`scripts/`): runs the code with file-based storage and credentials, writing to `.local/`
- **CDK app** (`bin/`, `lib/`): the stack defining AWS resources
- **Tests** (`test/`): test suites for logic, mocked adapters, and CDK template assertions
- **CI/CD** (`.github/workflows/`): deploys `main` to AWS when configured

## Setup

Requires Node 22+.

```sh
npm ci
npm run check   # typecheck + tests
```

### 1. Collect credentials

| Platform | What you need | Where |
|---|---|---|
| Steam | Web API key and your 64-bit SteamID | Key: https://steamcommunity.com/dev/apikey. SteamID: 17-digit SteamID64. |
| PlayStation | NPSSO token (64 characters) | Sign in at https://www.playstation.com, then open https://ca.account.sony.com/api/v1/ssocookie in the same browser and copy `npsso`. |
| Xbox | OpenXBL API key | Sign in at https://xbl.io with your Microsoft account and create a key. |

Put them in `local-credentials.json`:

```sh
cp local-credentials.example.json local-credentials.json   # gitignored
```

The file has this shape. Leave a platform out to disable it. `refreshToken` and `refreshTokenExpiresAt` are managed by the job; don't edit them.

```json
{
  "steam":       { "apiKey": "...", "steamId": "..." },
  "playstation": { "npsso": "...", "refreshToken": "...", "refreshTokenExpiresAt": "..." },
  "xbox":        { "apiKey": "..." }
}
```

### 2. Run it

```sh
npm run run:local
cat .local/public/games.json
```

This calls the platform APIs and writes into `.local/`:

- `.local/public/`: `games.json` and `covers/`. This is the folder to publish.
- `.local/private/`: `state.json` and daily snapshots. Keep it between runs.

Rotated PSN tokens are written back to `local-credentials.json`, so that file must stay writable. If the PlayStation fetch starts failing with a "Re-login required" error, get a new NPSSO (step 1) and update `playstation.npsso` in `local-credentials.json`.

You can run it on a schedule and copy `.local/public/` to wherever your site can fetch it.

- `coverUrl` values in `games.json` are absolute, built from `https://<SUBDOMAIN>.<DOMAIN_NAME>`. 
- Set these in the `.env` file so the URLs point to wherever you serve them. See [Configuration](#configuration).

## Deploy to AWS (optional)

The CDK stack does the scheduling, hosting and monitoring for you:

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

### Prerequisites

- An AWS account with a Route53 public hosted zone for your domain
- AWS CLI credentials for your account (local deploys) or GitHub repo secrets (CI deploys)
- CDK bootstrapped in us-east-1: `npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1`

### Configuration

All settings come from environment variables: a `.env` file locally, or repository variables and secrets in GitHub Actions. The local runner reads only `DOMAIN_NAME`, `SUBDOMAIN` and `TOP_N`.

| Name | Required | Default | Description |
|---|---|---|---|
| `DOMAIN_NAME` | yes (AWS) | | Domain with a Route53 hosted zone, e.g. `example.com` |
| `SUBDOMAIN` | | `games` | The feed is served from `https://<SUBDOMAIN>.<DOMAIN_NAME>` |
| `ALLOWED_ORIGINS` | | `https://<DOMAIN_NAME>,https://www.<DOMAIN_NAME>` | Comma-separated CORS origins. Add `http://localhost:port` for local web testing |
| `SCHEDULE_HOUR` | | `3` | Hour of the daily run (0–23) |
| `SCHEDULE_TIMEZONE` | | `America/Los_Angeles` | IANA time zone for `SCHEDULE_HOUR` |
| `TOP_N` | | `10` | Games published in `games.json` |
| `HOSTED_ZONE_ID` | | lookup | Pin the zone ID instead of looking it up at synth time |
| `AWS_ACCOUNT_ID` | | from credentials | Target account; in CI it also guards against deploying to the wrong account |

### 3. Deploy

Locally:

```sh
cp .env.example .env   # set DOMAIN_NAME, etc.

# Set AWS CLI credentials
npx cdk diff # Check stack differences
npm run deploy
```

From GitHub Actions: In your repo go to Settings → Secrets and variables → Actions and add the following.

| Kind | Name | Value |
|---|---|---|
| Variable | `DOMAIN_NAME` | Your domain (required; the deploy job is skipped without it) |
| Variable | `SUBDOMAIN`, `ALLOWED_ORIGINS`, `SCHEDULE_HOUR`, `SCHEDULE_TIMEZONE`, `TOP_N` | Optional, see [Configuration](#configuration) |
| Secret | `AWS_ACCOUNT_ID` | Your 12-digit AWS account ID |
| Secret | `AWS_ROLE_ARN` | An IAM role GitHub can assume via OIDC (no long-lived keys) |
| Secret | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Alternative to `AWS_ROLE_ARN`. |
| Secret | `HOSTED_ZONE_ID` | Optional, see [Configuration](#configuration) |

The deploy job runs in a GitHub environment named `production`, if you want to use the environment option.

### 4. Store platform credentials in Secrets Manager

The stack creates the `recently-played/credentials` secret with a random placeholder value. Replace it with the same JSON from step 1:

```sh
aws secretsmanager put-secret-value \
  --secret-id recently-played/credentials \
  --secret-string file://local-credentials.json
```

### 5. Invoke it for testing

```sh
aws lambda invoke --function-name <FunctionName output> /dev/stdout
curl -s https://games.example.com/games.json | jq
```

### Alerts

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
