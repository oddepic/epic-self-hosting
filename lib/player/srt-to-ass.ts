// Convert an SRT (SubRip) subtitle file into a minimal ASS script so the
// libass-based renderer (JASSUB) can draw it. JASSUB only understands
// ASS/SSA; SRT is a much simpler format (plain timed text), so we translate
// the cues into Dialogue lines with a single default style.

function srtTimeToAss(time: string): string {
  const m = time.match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return time;
  const hours = parseInt(m[1], 10);
  const minutes = m[2];
  const seconds = m[3];
  const centiseconds = m[4].padEnd(3, "0").slice(0, 2);
  return `${hours}:${minutes}:${seconds}.${centiseconds}`;
}

function convertSrtText(text: string): string {
  return text
    .replace(/\r/g, "")
    // Escape ASS-special characters in the source text FIRST, so the override
    // tags inserted below ({\i1} etc.) are not themselves escaped.
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/<i>(.*?)<\/i>/gi, "{\\i1}$1{\\i0}")
    .replace(/<b>(.*?)<\/b>/gi, "{\\b1}$1{\\b0}")
    .replace(/<u>(.*?)<\/u>/gi, "{\\u1}$1{\\u0}")
    .replace(/<font[^>]*>(.*?)<\/font>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .join("\\N");
}

const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

export function srtToAss(srt: string): string {
  const lines = srt.split(/\r?\n/);
  const dialogues: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "") {
      i++;
      continue;
    }
    // Skip the optional numeric cue index (e.g. "1").
    if (/^\d+$/.test(line)) {
      i++;
      continue;
    }
    const timing = line.match(
      /^(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})/,
    );
    if (!timing) {
      i++;
      continue;
    }
    const start = srtTimeToAss(timing[1]);
    const end = srtTimeToAss(timing[2]);
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }
    const text = convertSrtText(textLines.join("\n"));
    if (text.trim() !== "") {
      dialogues.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
    }
  }

  return ASS_HEADER + dialogues.join("\n");
}
