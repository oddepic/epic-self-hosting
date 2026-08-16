import { describe, it, expect } from "vitest";
import { srtToAss } from "./srt-to-ass";

describe("srtToAss", () => {
  it("converts a simple SRT cue into an ASS dialogue with a header", () => {
    const srt = "1\n00:00:01,000 --> 00:00:04,000\nHello world\n";
    const ass = srtToAss(srt);
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello world");
  });

  it("drops the milliseconds to centisecond precision", () => {
    const ass = srtToAss("1\n00:01:02,345 --> 00:01:05,678\nHi\n");
    expect(ass).toContain("0:01:02.34");
    expect(ass).toContain("0:01:05.67");
  });

  it("joins multi-line cue text with \\N and converts newlines", () => {
    const ass = srtToAss("1\n00:00:01,000 --> 00:00:03,000\nline one\nline two\n");
    expect(ass).toContain("line one\\Nline two");
  });

  it("converts <i> tags to ASS italics", () => {
    const ass = srtToAss("1\n00:00:01,000 --> 00:00:03,000\nthis is <i>italic</i>\n");
    expect(ass).toContain("this is {\\i1}italic{\\i0}");
  });

  it("escapes ASS special characters in the text", () => {
    const ass = srtToAss("1\n00:00:01,000 --> 00:00:03,000\n100% {ok} \\o/\n");
    expect(ass).toContain("100% \\{ok\\} \\\\o/");
  });

  it("skips empty and malformed lines without crashing", () => {
    const ass = srtToAss("garbage line\n\n1\n00:00:01,000 --> 00:00:02,000\nok\n\nnot timing\n");
    expect(ass).toContain("ok");
  });

  it("handles dot-separated SRT timestamps too", () => {
    const ass = srtToAss("1\n00:00:01.500 --> 00:00:02.250\nHi\n");
    expect(ass).toContain("0:00:01.50");
    expect(ass).toContain("0:00:02.25");
  });
});
