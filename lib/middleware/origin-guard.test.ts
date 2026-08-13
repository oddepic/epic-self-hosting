import { describe, it, expect } from "vitest";
import { guardMutatingRequest, isSameOrigin } from "./origin-guard";

describe("isSameOrigin", () => {
  it("matches the origin host to the request host", () => {
    expect(isSameOrigin("http://localhost:3000", "localhost:3000")).toBe(true);
    expect(isSameOrigin("http://192.168.1.5:3000", "192.168.1.5:3000")).toBe(true);
  });

  it("rejects cross-origin, missing, or malformed values", () => {
    expect(isSameOrigin("http://evil.com", "localhost:3000")).toBe(false);
    expect(isSameOrigin(null, "localhost:3000")).toBe(false);
    expect(isSameOrigin("http://localhost:3000", null)).toBe(false);
    expect(isSameOrigin("not-a-url", "localhost:3000")).toBe(false);
  });
});

describe("guardMutatingRequest", () => {
  it("allows non-mutating methods even cross-origin", () => {
    const decision = guardMutatingRequest({
      method: "GET",
      pathname: "/api/library",
      origin: "http://evil.com",
      host: "localhost:3000",
    });
    expect(decision).toBe("allow");
  });

  it("allows same-origin mutating requests", () => {
    const decision = guardMutatingRequest({
      method: "POST",
      pathname: "/api/library/sync",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    });
    expect(decision).toBe("allow");
  });

  it("forbids cross-origin mutating requests", () => {
    const decision = guardMutatingRequest({
      method: "POST",
      pathname: "/api/library/sync",
      origin: "http://evil.com",
      host: "localhost:3000",
    });
    expect(decision).toBe("forbid");
  });

  it("forbids mutating requests with no origin (curl / LAN device)", () => {
    const decision = guardMutatingRequest({
      method: "POST",
      pathname: "/api/library/sync",
      origin: null,
      host: "localhost:3000",
    });
    expect(decision).toBe("forbid");
  });

  it("allows the webhook route regardless of origin", () => {
    const decision = guardMutatingRequest({
      method: "POST",
      pathname: "/api/webhooks/jellyfin",
      origin: null,
      host: "localhost:3000",
    });
    expect(decision).toBe("allow");
  });

  it("allows the jellyfin refresh route regardless of origin", () => {
    const decision = guardMutatingRequest({
      method: "POST",
      pathname: "/api/jellyfin/refresh",
      origin: null,
      host: "localhost:3000",
    });
    expect(decision).toBe("allow");
  });
});
