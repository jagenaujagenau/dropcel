import { describe, expect, it } from "vitest";
import { needsRefresh } from "./auth";
import { parseDeviceAuthorization, parseDevicePoll, parseTokenResponse } from "./vercel-api";

describe("parseDeviceAuthorization", () => {
  it("parses an RFC 8628 response, preferring the complete URI", () => {
    const d = parseDeviceAuthorization({
      device_code: "dc_1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://vercel.com/device",
      verification_uri_complete: "https://vercel.com/device?code=ABCD-EFGH",
      expires_in: 600,
      interval: 5,
    });
    expect(d).toEqual({
      deviceCode: "dc_1",
      userCode: "ABCD-EFGH",
      verificationUri: "https://vercel.com/device?code=ABCD-EFGH",
      expiresInMs: 600_000,
      intervalMs: 5_000,
    });
  });

  it("rejects malformed responses", () => {
    expect(parseDeviceAuthorization(null)).toBeNull();
    expect(parseDeviceAuthorization({ user_code: "X" })).toBeNull();
  });
});

describe("parseDevicePoll", () => {
  const now = 1_753_200_000_000;

  it("maps the standard polling states", () => {
    expect(parseDevicePoll({ error: "authorization_pending" }, now)).toEqual({ status: "pending" });
    expect(parseDevicePoll({ error: "slow_down" }, now)).toEqual({ status: "slow_down" });
    expect(parseDevicePoll({ error: "access_denied" }, now)).toEqual({
      status: "denied",
      reason: "access_denied",
    });
  });

  it("returns tokens on approval", () => {
    const r = parseDevicePoll(
      { access_token: "at", refresh_token: "rt", expires_in: 3600 },
      now,
    );
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.tokens.accessToken).toBe("at");
  });
});

const MIN = 60_000;

describe("needsRefresh", () => {
  const now = 1_753_200_000_000;

  it("never refreshes tokens with no known expiry (manual PATs)", () => {
    expect(needsRefresh(null, now)).toBe(false);
  });

  it("refreshes within the 15-minute margin and after expiry", () => {
    expect(needsRefresh(now + 10 * MIN, now)).toBe(true); // 10 min left
    expect(needsRefresh(now - 1, now)).toBe(true); // already expired
  });

  it("does not refresh comfortably-valid tokens", () => {
    expect(needsRefresh(now + 60 * MIN, now)).toBe(false);
  });
});

describe("parseTokenResponse", () => {
  const now = 1_753_200_000_000;

  it("parses a standard token response with rotation", () => {
    const t = parseTokenResponse(
      { access_token: "at_new", refresh_token: "rt_new", expires_in: 3600, token_type: "Bearer" },
      now,
    );
    expect(t).toEqual({
      accessToken: "at_new",
      refreshToken: "rt_new",
      expiresAtMs: now + 3600 * 1000,
    });
  });

  it("tolerates missing rotation and expiry", () => {
    const t = parseTokenResponse({ access_token: "at" }, now);
    expect(t).toEqual({ accessToken: "at", refreshToken: null, expiresAtMs: null });
  });

  it("rejects responses without an access token", () => {
    expect(parseTokenResponse({ error: "invalid_grant" }, now)).toBeNull();
    expect(parseTokenResponse(null, now)).toBeNull();
  });
});
