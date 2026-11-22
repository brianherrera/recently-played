import { App, TimeZone } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { RecentlyPlayedStack } from "../lib/recently-played-stack";

let template: Template;

beforeAll(() => {
  const app = new App();
  const stack = new RecentlyPlayedStack(app, "Test", {
    env: { account: "123456789012", region: "us-east-1" },
    domainName: "example.com",
    subdomain: "games",
    hostedZoneId: "Z123",
    allowedOrigins: ["https://example.com"],
    scheduleHour: 3,
    scheduleTimeZone: TimeZone.AMERICA_LOS_ANGELES,
    topN: 10,
  });
  template = Template.fromStack(stack);
});

describe("RecentlyPlayedStack", () => {
  it("keeps the bucket private and serves only the public/ prefix", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: ["games.example.com"],
        Origins: [Match.objectLike({ OriginPath: "/public" })],
      }),
    });
  });

  it("allows CORS only from the configured origins", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        CorsConfig: Match.objectLike({ AccessControlAllowOrigins: { Items: ["https://example.com"] } }),
      }),
    });
  });

  it("creates DNS records and a DNS-validated certificate", () => {
    template.resourceCountIs("AWS::Route53::RecordSet", 2);
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "games.example.com",
      ValidationMethod: "DNS",
    });
  });

  it("runs the Lambda daily at 3am Pacific", () => {
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "cron(0 3 * * ? *)",
      ScheduleExpressionTimezone: "America/Los_Angeles",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Environment: {
        Variables: Match.objectLike({ PUBLIC_BASE_URL: "https://games.example.com", TOP_N: "10" }),
      },
    });
  });

  it("lets the Lambda write rotated tokens back to the secret", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const actions = JSON.stringify(policies);
    expect(actions).toContain("secretsmanager:PutSecretValue");
    expect(actions).toContain("secretsmanager:GetSecretValue");
  });

  it("wires every alarm to the SNS topic", () => {
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.resourceCountIs("AWS::SNS::Subscription", 0);
    const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm"));
    expect(alarms).toHaveLength(6); // run failed, not running, PSN re-login, 3 platform failures
    for (const a of alarms) expect(a.Properties.AlarmActions).toHaveLength(1);
  });
});
