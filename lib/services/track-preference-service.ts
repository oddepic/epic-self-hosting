import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { trackPreferences } from "../db/schema";
import type { JellyfinMediaStream } from "../integrations/types";

export interface TrackPreference {
  audioLanguage: string | null;
  subtitleLanguage: string | null;
  subtitleForced: boolean;
}

export const SUBTITLE_OFF = "off";

const TEXT_SUBTITLE_CODECS = new Set([
  "ass",
  "ssa",
  "srt",
  "subrip",
  "vtt",
  "webvtt",
  "mov_text",
  "text",
  "ttml",
]);

export function isTextSubtitleCodec(codec: string | null): boolean {
  return codec != null && TEXT_SUBTITLE_CODECS.has(codec.toLowerCase());
}

export const DEFAULT_PREFERENCE: TrackPreference = {
  audioLanguage: "jpn",
  subtitleLanguage: "eng",
  subtitleForced: false,
};

export interface StreamMatch {
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
  burnInSubtitleStreamIndex?: number;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  ja: "jpn",
  jp: "jpn",
  japanese: "jpn",
  en: "eng",
  english: "eng",
  es: "spa",
  spanish: "spa",
  "es-419": "spa",
  "es-mx": "spa",
  latin: "spa",
  "latin american": "spa",
  "español": "spa",
  fr: "fra",
  french: "fra",
  de: "deu",
  german: "deu",
  ko: "kor",
  korean: "kor",
  zh: "zho",
  chinese: "zho",
  pt: "por",
  portuguese: "por",
  th: "tha",
  thai: "tha",
  ind: "ind",
  indonesian: "ind",
  it: "ita",
  italian: "ita",
};

function normalizeLanguage(language: string | null): string | null {
  if (!language) return null;
  const lower = language.toLowerCase().trim();
  if (LANGUAGE_ALIASES[lower]) return LANGUAGE_ALIASES[lower]!;
  const primary = lower.split(/[-_]/)[0]!;
  if (primary !== lower) {
    if (LANGUAGE_ALIASES[primary]) return LANGUAGE_ALIASES[primary]!;
    if (primary.length === 3) return primary;
    return null;
  }
  return lower.length === 3 ? lower : null;
}

export class TrackPreferenceService {
  constructor(private readonly db: Db) {}

  matchStreams(streams: JellyfinMediaStream[], pref: TrackPreference): StreamMatch {
    const audio = normalizeLanguage(pref.audioLanguage);

    const audioIndex = audio
      ? this.pickStream(streams, "Audio", audio, false)
      : undefined;

    const subtitleIndex = this.pickSubtitle(streams, pref);
    const burnInSubtitleIndex = this.pickBurnInSubtitle(streams, pref);

    return {
      audioStreamIndex: audioIndex,
      subtitleStreamIndex: subtitleIndex,
      burnInSubtitleStreamIndex: burnInSubtitleIndex,
    };
  }

  private pickBurnInSubtitle(streams: JellyfinMediaStream[], pref: TrackPreference): number | undefined {
    if (pref.subtitleLanguage === SUBTITLE_OFF) return undefined;
    const images = streams.filter(
      (s) => s.type === "Subtitle" && !isTextSubtitleCodec(s.codec),
    );
    if (images.length === 0) return undefined;

    const lang = normalizeLanguage(pref.subtitleLanguage);
    if (lang) {
      const sameLang = images.filter((s) => normalizeLanguage(s.language) === lang);
      if (sameLang.length > 0) {
        const exact = sameLang.filter((s) => s.isForced === pref.subtitleForced);
        return this.pickPreferred(exact.length > 0 ? exact : sameLang);
      }
    }

    const nonForced = images.filter((s) => !s.isForced);
    return this.pickPreferred(nonForced.length > 0 ? nonForced : images);
  }

  private pickSubtitle(streams: JellyfinMediaStream[], pref: TrackPreference): number | undefined {
    if (pref.subtitleLanguage === SUBTITLE_OFF) return undefined;
    const text = streams.filter(
      (s) => s.type === "Subtitle" && isTextSubtitleCodec(s.codec),
    );
    if (text.length === 0) return undefined;

    const lang = normalizeLanguage(pref.subtitleLanguage);
    if (lang) {
      const sameLang = text.filter((s) => normalizeLanguage(s.language) === lang);
      if (sameLang.length > 0) {
        const exact = sameLang.filter((s) => s.isForced === pref.subtitleForced);
        if (exact.length > 0) return this.pickPreferred(exact);
        if (pref.subtitleForced) {
          const forced = text.filter((s) => s.isForced);
          return this.pickPreferred(forced.length > 0 ? forced : text);
        }
      }
    }

    const nonForced = text.filter((s) => !s.isForced);
    return this.pickPreferred(nonForced.length > 0 ? nonForced : text);
  }

  private pickPreferred(streams: JellyfinMediaStream[]): number | undefined {
    const preferred = streams.find((s) => s.isDefault);
    return (preferred ?? streams[0])?.index;
  }

  private pickStream(
    streams: JellyfinMediaStream[],
    type: JellyfinMediaStream["type"],
    language: string,
    requireDefault: boolean,
  ): number | undefined {
    const matches = streams.filter(
      (s) => s.type === type && normalizeLanguage(s.language) === language,
    );
    if (matches.length === 0) return undefined;
    if (matches.length === 1) return matches[0]!.index;
    const preferred = matches.find((s) => requireDefault || s.isDefault);
    if (preferred) return preferred.index;
    return matches[0]!.index;
  }

  getPreference(userId: number): TrackPreference | null {
    const row = this.db
      .select()
      .from(trackPreferences)
      .where(eq(trackPreferences.userId, userId))
      .get();
    if (!row) return null;
    return {
      audioLanguage: row.audioLanguage,
      subtitleLanguage: row.subtitleLanguage,
      subtitleForced: row.subtitleForced,
    };
  }

  savePreference(userId: number, pref: TrackPreference): void {
    const existing = this.db
      .select()
      .from(trackPreferences)
      .where(eq(trackPreferences.userId, userId))
      .get();
    const values = {
      audioLanguage: pref.audioLanguage,
      subtitleLanguage: pref.subtitleLanguage,
      subtitleForced: pref.subtitleForced,
    };
    if (existing) {
      this.db.update(trackPreferences).set(values).where(eq(trackPreferences.id, existing.id)).run();
    } else {
      this.db.insert(trackPreferences).values({ userId, ...values }).run();
    }
  }

  getPreferenceForEpisode(userId: number | undefined, _episodeId?: number): TrackPreference {
    if (userId == null) return DEFAULT_PREFERENCE;
    return this.getPreference(userId) ?? DEFAULT_PREFERENCE;
  }
}
