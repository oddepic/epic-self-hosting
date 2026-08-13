import { describe, it, expect } from "vitest";
import {
  parseStreamServer,
  buildStartPayload,
  buildProgressPayload,
  buildStoppedPayload,
} from "./report";
import type { PlaybackSession } from "./report";

const session: PlaybackSession = {
  url: "http://localhost:8096/Videos/jf-ep-1/stream.m3u8?ApiKey=abc123",
  startPositionTicks: 12_200_000_000,
  itemId: "jf-ep-1",
  mediaSourceId: "ms-1",
  playSessionId: "ps-1",
  playMethod: "Transcode",
};

describe("report", () => {
  describe("parseStreamServer", () => {
    it("extracts the origin and ApiKey from a stream URL", () => {
      expect(parseStreamServer(session.url)).toEqual({
        serverUrl: "http://localhost:8096",
        token: "abc123",
      });
    });

    it("returns an empty token when the URL has no ApiKey", () => {
      expect(
        parseStreamServer("http://localhost:8096/Videos/x/stream.m3u8").token,
      ).toBe("");
    });
  });

  describe("buildStartPayload", () => {
    it("includes the session identity and start position", () => {
      expect(buildStartPayload(session)).toEqual({
        ItemId: "jf-ep-1",
        MediaSourceId: "ms-1",
        PlaySessionId: "ps-1",
        PlayMethod: "Transcode",
        PositionTicks: 12_200_000_000,
      });
    });
  });

  describe("buildProgressPayload", () => {
    it("reports a new position and paused state", () => {
      expect(buildProgressPayload(session, 13_000_000_000, true)).toEqual({
        ItemId: "jf-ep-1",
        MediaSourceId: "ms-1",
        PlaySessionId: "ps-1",
        PlayMethod: "Transcode",
        PositionTicks: 13_000_000_000,
        IsPaused: true,
      });
    });
  });

  describe("buildStoppedPayload", () => {
    it("reports the final position", () => {
      expect(buildStoppedPayload(session, 14_000_000_000)).toEqual({
        ItemId: "jf-ep-1",
        MediaSourceId: "ms-1",
        PlaySessionId: "ps-1",
        PlayMethod: "Transcode",
        PositionTicks: 14_000_000_000,
      });
    });

    it("omits PlaySessionId when the session has none", () => {
      const stopped = buildStoppedPayload({ ...session, playSessionId: null }, 0);
      expect(stopped).not.toHaveProperty("PlaySessionId");
      expect(stopped.PositionTicks).toBe(0);
    });
  });
});
