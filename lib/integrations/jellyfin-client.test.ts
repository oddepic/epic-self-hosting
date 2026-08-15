import { describe, it, expect } from "vitest";
import { WEB_DEVICE_PROFILE } from "./jellyfin-client";

describe("WEB_DEVICE_PROFILE", () => {
  it("requests MPEG-TS HLS segments to avoid the fMP4 audio drift (ADR-0001)", () => {
    expect(WEB_DEVICE_PROFILE.TranscodingProfiles[0]?.Container).toBe("ts");
  });
});
