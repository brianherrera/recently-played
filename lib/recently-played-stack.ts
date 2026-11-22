import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, TimeZone, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as schedulerTargets from "aws-cdk-lib/aws-scheduler-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";
import { METRIC_NAMESPACE } from "../src/metrics";
import { PLATFORMS } from "../src/types";

export interface RecentlyPlayedStackProps extends StackProps {
  /** Apex domain with an existing Route53 hosted zone, e.g. "example.com". */
  domainName: string;
  /** Subdomain the data is served from, e.g. "games". */
  subdomain: string;
  /** Origins allowed to fetch the data (CORS). */
  allowedOrigins: string[];
  /** Skip the Route53 lookup (tests, or if you prefer pinning the zone ID). */
  hostedZoneId?: string;
  /** Daily run time, local to scheduleTimeZone. */
  scheduleHour: number;
  scheduleTimeZone: TimeZone;
  topN: number;
}

export class RecentlyPlayedStack extends Stack {
  constructor(scope: Construct, id: string, props: RecentlyPlayedStackProps) {
    super(scope, id, props);

    const dataDomain = `${props.subdomain}.${props.domainName}`;
    const zone = props.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
          hostedZoneId: props.hostedZoneId,
          zoneName: props.domainName,
        })
      : route53.HostedZone.fromLookup(this, "Zone", { domainName: props.domainName });

    // ---- Storage -------------------------------------------------------------
    // public/  -> served by CloudFront (origin path), private/ -> state + snapshots, never served.
    const bucket = new s3.Bucket(this, "DataBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true, // cheap insurance for state.json
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- Credentials ---------------------------------------------------------
    // Created with a random placeholder; set the real JSON with `aws secretsmanager put-secret-value`.
    // CDK never overwrites the value after creation. The Lambda writes rotated PSN tokens back.
    const secret = new secretsmanager.Secret(this, "Credentials", {
      secretName: "recently-played/credentials",
      description: "Platform credentials for recently-played (see README for the JSON shape)",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- CDN -----------------------------------------------------------------
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: dataDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const corsPolicy = new cloudfront.ResponseHeadersPolicy(this, "CorsPolicy", {
      comment: `CORS for ${dataDomain}`,
      corsBehavior: {
        accessControlAllowOrigins: props.allowedOrigins,
        accessControlAllowMethods: ["GET", "HEAD"],
        accessControlAllowHeaders: ["*"],
        accessControlAllowCredentials: false,
        accessControlMaxAge: Duration.days(1),
        originOverride: true,
      },
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "recently-played data",
      domainNames: [dataDomain],
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, { originPath: "/public" }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        // Honors the Cache-Control the Lambda sets on each object.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: corsPolicy,
        compress: true,
      },
    });

    for (const [id, RecordType] of [
      ["AliasA", route53.ARecord],
      ["AliasAAAA", route53.AaaaRecord],
    ] as const) {
      new RecordType(this, id, {
        zone,
        recordName: props.subdomain,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      });
    }

    // ---- Retriever Lambda ----------------------------------------------------
    const fn = new NodejsFunction(this, "Retriever", {
      entry: path.join(__dirname, "../src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(2),
      retryAttempts: 0, // the next scheduled run is the retry
      logGroup: new logs.LogGroup(this, "RetrieverLogs", {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        BUCKET_NAME: bucket.bucketName,
        SECRET_ID: secret.secretArn,
        PUBLIC_BASE_URL: `https://${dataDomain}`,
        TOP_N: String(props.topN),
        PER_PLATFORM_LIMIT: "25",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        format: OutputFormat.CJS,
        minify: true,
        sourceMap: true,
        target: "node24",
      },
    });
    bucket.grantReadWrite(fn);
    secret.grantRead(fn);
    secret.grantWrite(fn);

    new scheduler.Schedule(this, "DailySchedule", {
      description: "Daily recently-played refresh",
      schedule: scheduler.ScheduleExpression.cron({
        minute: "0",
        hour: String(props.scheduleHour),
        timeZone: props.scheduleTimeZone,
      }),
      target: new schedulerTargets.LambdaInvoke(fn, { retryAttempts: 0 }),
    });

    // ---- Alerts --------------------------------------------------------------
    // Subscribe your email manually (console or `aws sns subscribe`).
    const topic = new sns.Topic(this, "Alerts", { displayName: "recently-played alerts" });
    const alarmAction = new cwActions.SnsAction(topic);
    const day = Duration.days(1);

    const alarms: cloudwatch.Alarm[] = [
      fn.metricErrors({ period: day, statistic: "Sum" }).createAlarm(this, "RunFailedAlarm", {
        alarmDescription: "The retriever Lambda failed (all platforms failed, or a crash).",
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      fn.metricInvocations({ period: day, statistic: "Sum" }).createAlarm(this, "NotRunningAlarm", {
        alarmDescription: "The retriever hasn't run for 2 days; check the schedule.",
        threshold: 1,
        evaluationPeriods: 2, // 2 days tolerates the 25-hour DST day
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "PlayStationRefreshTokenDaysRemaining",
        dimensionsMap: { Platform: "playstation" },
        statistic: "Minimum",
        period: day,
      }).createAlarm(this, "PlayStationReloginAlarm", {
        alarmDescription: "PSN refresh token expires within 7 days. Get a new NPSSO and update the secret.",
        threshold: 7,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      ...PLATFORMS.map((platform) =>
        new cloudwatch.Metric({
          namespace: METRIC_NAMESPACE,
          metricName: "PlatformFailure",
          dimensionsMap: { Platform: platform },
          statistic: "Sum",
          period: day,
        }).createAlarm(this, `${platform}FailureAlarm`, {
          alarmDescription: `${platform} fetch failed 2 days in a row.`,
          threshold: 1,
          evaluationPeriods: 2,
          datapointsToAlarm: 2,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      ),
    ];
    for (const alarm of alarms) alarm.addAlarmAction(alarmAction);

    // ---- Outputs -------------------------------------------------------------
    new CfnOutput(this, "GamesUrl", { value: `https://${dataDomain}/games.json` });
    new CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new CfnOutput(this, "SecretName", { value: secret.secretName });
    new CfnOutput(this, "FunctionName", { value: fn.functionName });
    new CfnOutput(this, "AlertsTopicArn", { value: topic.topicArn });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
  }
}
