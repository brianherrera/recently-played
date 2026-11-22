#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { loadConfig, loadDotEnv } from "../lib/config";
import { RecentlyPlayedStack } from "../lib/recently-played-stack";

loadDotEnv();
const { account, ...config } = loadConfig();

const app = new App();

new RecentlyPlayedStack(app, "RecentlyPlayed", {
  // Account is required for the Route53 hosted zone lookup. Region must be us-east-1
  // because the CloudFront certificate lives in the same stack.
  env: { account, region: "us-east-1" },
  description: `recently-played: daily game activity feed for ${config.domainName}`,
  ...config,
  tags: { project: "recently-played" },
});
