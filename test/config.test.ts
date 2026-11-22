import { describe, expect, it } from "vitest";
import { loadConfig } from "../lib/config";

describe("loadConfig", () => {
  it("requires DOMAIN_NAME", () => {
    expect(() => loadConfig({})).toThrow(/DOMAIN_NAME is required/);
  });

  it("applies defaults derived from the domain", () => {
    const c = loadConfig({ DOMAIN_NAME: "example.com", CDK_DEFAULT_ACCOUNT: "111111111111" });
    expect(c).toMatchObject({
      account: "111111111111",
      domainName: "example.com",
      subdomain: "games",
      allowedOrigins: ["https://example.com", "https://www.example.com"],
      hostedZoneId: undefined,
      scheduleHour: 3,
      topN: 10,
    });
    expect(c.scheduleTimeZone.timezoneName).toBe("America/Los_Angeles");
  });

  it("reads overrides, ignoring blank values", () => {
    const c = loadConfig({
      DOMAIN_NAME: "example.org",
      SUBDOMAIN: "play",
      ALLOWED_ORIGINS: " https://example.org , http://localhost:1313 ,",
      HOSTED_ZONE_ID: "",
      AWS_ACCOUNT_ID: "222222222222",
      CDK_DEFAULT_ACCOUNT: "111111111111",
      SCHEDULE_HOUR: "5",
      SCHEDULE_TIMEZONE: "Europe/London",
      TOP_N: "20",
    });
    expect(c).toMatchObject({
      account: "222222222222",
      subdomain: "play",
      allowedOrigins: ["https://example.org", "http://localhost:1313"],
      hostedZoneId: undefined,
      scheduleHour: 5,
      topN: 20,
    });
    expect(c.scheduleTimeZone.timezoneName).toBe("Europe/London");
  });

  it("rejects invalid numbers", () => {
    expect(() => loadConfig({ DOMAIN_NAME: "example.com", SCHEDULE_HOUR: "24" })).toThrow(/SCHEDULE_HOUR/);
    expect(() => loadConfig({ DOMAIN_NAME: "example.com", TOP_N: "ten" })).toThrow(/TOP_N/);
  });
});
