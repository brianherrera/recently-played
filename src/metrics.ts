export const METRIC_NAMESPACE = "RecentlyPlayed";

/**
 * Emit a CloudWatch metric via Embedded Metric Format: a structured log line that
 * CloudWatch turns into a metric. No API calls or extra IAM permissions needed.
 */
export function emitMetric(
  name: string,
  value: number,
  dimensions: Record<string, string> = {},
  unit: "Count" | "None" = "None",
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: METRIC_NAMESPACE,
            Dimensions: [Object.keys(dimensions)],
            Metrics: [{ Name: name, Unit: unit }],
          },
        ],
      },
      ...dimensions,
      [name]: value,
    }),
  );
}
