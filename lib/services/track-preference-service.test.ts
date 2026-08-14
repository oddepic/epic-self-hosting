import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client";
import { trackPreferences, users } from "../db/schema";
import { hashPassword } from "./user-service";
import { TrackPreferenceService } from "./track-preference-service";
import type { JellyfinMediaStream } from "../integrations/types";

function makeStream(overrides: Partial<JellyfinMediaStream> = {}): JellyfinMediaStream {
  return {
    index: 0,
    type: "Audio",
    codec: "aac",
    language: "jpn",
    isForced: false,
    isDefault: false,
    displayTitle: "Japanese",
    ...overrides,
  };
}

function makeAudio(overrides: Partial<JellyfinMediaStream> = {}): JellyfinMediaStream {
  return makeStream({ type: "Audio", ...overrides });
}

describe("TrackPreferenceService.matchStreams", () => {
  let db: Db;
  let service: TrackPreferenceService;

  beforeEach(() => {
    db = createDb(":memory:");
    service = new TrackPreferenceService(db);
  });

  it("matches audio by language code", () => {
    const streams = [
      makeAudio({ index: 0, language: "eng", displayTitle: "English" }),
      makeAudio({ index: 1, language: "jpn", displayTitle: "Japanese" }),
    ];
    const result = service.matchStreams(streams, {
      audioLanguage: "jpn",
      subtitleLanguage: null,
      subtitleForced: false,
    });
    expect(result).toEqual({ audioStreamIndex: 1, subtitleStreamIndex: undefined });
  });

  it("matches audio by a 2-letter language code", () => {
    const streams = [
      makeAudio({ index: 0, language: "eng" }),
      makeAudio({ index: 1, language: "jpn" }),
    ];
    const result = service.matchStreams(streams, {
      audioLanguage: "ja",
      subtitleLanguage: null,
      subtitleForced: false,
    });
    expect(result.audioStreamIndex).toBe(1);
  });

  it("matches audio tracks carrying a BCP-47 language tag", () => {
    const streams = [
      makeAudio({ index: 0, language: "eng", displayTitle: "English" }),
      makeAudio({ index: 1, language: "ja-JP", displayTitle: "Japanese" }),
    ];
    const result = service.matchStreams(streams, {
      audioLanguage: "jpn",
      subtitleLanguage: null,
      subtitleForced: false,
    });
    expect(result.audioStreamIndex).toBe(1);
  });

  it("returns undefined indexes when the preferred language is absent", () => {
    const streams = [
      makeAudio({ index: 0, language: "eng" }),
    ];
    const result = service.matchStreams(streams, {
      audioLanguage: "fra",
      subtitleLanguage: "spa",
      subtitleForced: false,
    });
    expect(result).toEqual({ audioStreamIndex: undefined, subtitleStreamIndex: undefined });
  });

  it("prefers the default track among multiple language matches", () => {
    const streams = [
      makeAudio({ index: 0, language: "jpn", isDefault: false }),
      makeAudio({ index: 1, language: "jpn", isDefault: true }),
    ];
    const result = service.matchStreams(streams, {
      audioLanguage: "jpn",
      subtitleLanguage: null,
      subtitleForced: false,
    });
    expect(result.audioStreamIndex).toBe(1);
  });
});

function makeSubtitle(overrides: Partial<JellyfinMediaStream> = {}): JellyfinMediaStream {
  return makeStream({ type: "Subtitle", codec: "ass", language: "eng", ...overrides });
}

describe("TrackPreferenceService.matchStreams subtitles", () => {
  let db: Db;
  let service: TrackPreferenceService;

  beforeEach(() => {
    db = createDb(":memory:");
    service = new TrackPreferenceService(db);
  });

  it("matches a subtitle by language and forced flag", () => {
    const streams = [
      makeSubtitle({ index: 2, language: "eng", isForced: false, isDefault: true }),
      makeSubtitle({ index: 3, language: "eng", isForced: true }),
      makeSubtitle({ index: 4, language: "spa", isForced: false }),
    ];
    const result = service.matchStreams(streams, {
      audioLanguage: "jpn",
      subtitleLanguage: "eng",
      subtitleForced: false,
    });
    expect(result.subtitleStreamIndex).toBe(2);
  });

  it("matches a forced subtitle when forced is requested", () => {
    const streams = [
      makeSubtitle({ index: 2, language: "eng", isForced: false }),
      makeSubtitle({ index: 3, language: "eng", isForced: true }),
    ];
    const result = service.matchStreams(streams, {
      audioLanguage: "jpn",
      subtitleLanguage: "eng",
      subtitleForced: true,
    });
    expect(result.subtitleStreamIndex).toBe(3);
  });

  it("falls back to the first non-forced text track when the preferred language is absent", () => {
    const streams = [
      makeSubtitle({ index: 2, language: "spa", isForced: true }),
      makeSubtitle({ index: 3, language: "fra", isForced: false }),
    ];
    const result = service.matchStreams(streams, {
      audioLanguage: "jpn",
      subtitleLanguage: "eng",
      subtitleForced: false,
    });
    expect(result.subtitleStreamIndex).toBe(3);
  });

  it("does not select a signs-only track when the preferred language is only forced", () => {
    const streams = [
      makeSubtitle({ index: 2, language: "eng", isForced: true }),
      makeSubtitle({ index: 3, language: "spa", isForced: false }),
    ];
    const result = service.matchStreams(streams, {
      audioLanguage: "jpn",
      subtitleLanguage: "eng",
      subtitleForced: false,
    });
    expect(result.subtitleStreamIndex).toBe(3);
  });

  it("returns no subtitle when the preference is off", () => {
    const streams = [makeSubtitle({ index: 2, language: "eng", isForced: false })];
    const result = service.matchStreams(streams, {
      audioLanguage: "jpn",
      subtitleLanguage: "off",
      subtitleForced: false,
    });
    expect(result.subtitleStreamIndex).toBeUndefined();
  });

  it("ignores image subtitle tracks", () => {
    const streams = [makeSubtitle({ index: 2, language: "eng", codec: "pgs", isForced: false })];
    const result = service.matchStreams(streams, {
      audioLanguage: "jpn",
      subtitleLanguage: "eng",
      subtitleForced: false,
    });
    expect(result.subtitleStreamIndex).toBeUndefined();
  });
});

describe("TrackPreferenceService save/get", () => {
  let db: Db;
  let service: TrackPreferenceService;
  let userId: number;

  beforeEach(async () => {
    db = createDb(":memory:");
    service = new TrackPreferenceService(db);
    userId = db
      .insert(users)
      .values({ username: "admin", passwordHash: hashPassword("x"), preferences: {}, createdAt: 1 })
      .returning()
      .get().id;
  });

  it("saves and loads a global preference", () => {
    service.savePreference(userId, { audioLanguage: "jpn", subtitleLanguage: "spa", subtitleForced: true });
    const pref = service.getPreference(userId);
    expect(pref).toEqual({ audioLanguage: "jpn", subtitleLanguage: "spa", subtitleForced: true });
  });

  it("returns null when no preference exists", () => {
    expect(service.getPreference(userId)).toBeNull();
  });

  it("updates an existing preference instead of duplicating", () => {
    service.savePreference(userId, { audioLanguage: "jpn", subtitleLanguage: "spa", subtitleForced: false });
    service.savePreference(userId, { audioLanguage: "jpn", subtitleLanguage: "spa", subtitleForced: true });
    const rows = db.select().from(trackPreferences).all();
    expect(rows).toHaveLength(1);
    expect(service.getPreference(userId)!.subtitleForced).toBe(true);
  });
});

describe("TrackPreferenceService.getPreferenceForEpisode", () => {
  let db: Db;
  let service: TrackPreferenceService;
  let userId: number;

  beforeEach(() => {
    db = createDb(":memory:");
    service = new TrackPreferenceService(db);
    userId = db
      .insert(users)
      .values({ username: "admin", passwordHash: hashPassword("x"), preferences: {}, createdAt: 1 })
      .returning()
      .get().id;
  });

  it("returns the default jpn preference when nothing is saved", () => {
    expect(service.getPreferenceForEpisode(userId)).toEqual({
      audioLanguage: "jpn",
      subtitleLanguage: "eng",
      subtitleForced: false,
    });
  });

  it("returns the default for an unknown user id", () => {
    expect(service.getPreferenceForEpisode(999_999)).toEqual({
      audioLanguage: "jpn",
      subtitleLanguage: "eng",
      subtitleForced: false,
    });
  });

  it("returns the saved preference over the default", () => {
    service.savePreference(userId, { audioLanguage: "eng", subtitleLanguage: "spa", subtitleForced: true });
    expect(service.getPreferenceForEpisode(userId)).toEqual({
      audioLanguage: "eng",
      subtitleLanguage: "spa",
      subtitleForced: true,
    });
  });
});
