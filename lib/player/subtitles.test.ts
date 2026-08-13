import { describe, it, expect } from "vitest";
import { isTextSubtitleCodec, isImageSubtitleCodec } from "./subtitles";

describe("subtitle codec classification", () => {
  it("classifies text subtitle codecs", () => {
    expect(isTextSubtitleCodec("ass")).toBe(true);
    expect(isTextSubtitleCodec("ssa")).toBe(true);
    expect(isTextSubtitleCodec("srt")).toBe(true);
    expect(isTextSubtitleCodec("subrip")).toBe(true);
  });

  it("classifies image subtitle codecs", () => {
    expect(isImageSubtitleCodec("pgs")).toBe(true);
    expect(isImageSubtitleCodec("pgssub")).toBe(true);
    expect(isImageSubtitleCodec("vobsub")).toBe(true);
    expect(isImageSubtitleCodec("dvdsub")).toBe(true);
  });

  it("is case-insensitive and tolerant of null", () => {
    expect(isTextSubtitleCodec("ASS")).toBe(true);
    expect(isTextSubtitleCodec("Srt")).toBe(true);
    expect(isTextSubtitleCodec(null)).toBe(false);
    expect(isImageSubtitleCodec("PGS")).toBe(true);
    expect(isImageSubtitleCodec(null)).toBe(false);
  });

  it("does not classify image codecs as text or vice versa", () => {
    expect(isTextSubtitleCodec("pgs")).toBe(false);
    expect(isImageSubtitleCodec("ass")).toBe(false);
  });
});
