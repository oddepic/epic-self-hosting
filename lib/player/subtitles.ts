const TEXT_SUBTITLE_CODECS = new Set(["ass", "ssa", "srt", "subrip"]);
const IMAGE_SUBTITLE_CODECS = new Set(["pgs", "pgssub", "vobsub", "dvdsub"]);

function normalize(codec: string | null): string | null {
  return codec ? codec.toLowerCase().trim() : null;
}

export function isTextSubtitleCodec(codec: string | null): boolean {
  const normalized = normalize(codec);
  return normalized != null && TEXT_SUBTITLE_CODECS.has(normalized);
}

export function isImageSubtitleCodec(codec: string | null): boolean {
  const normalized = normalize(codec);
  return normalized != null && IMAGE_SUBTITLE_CODECS.has(normalized);
}
