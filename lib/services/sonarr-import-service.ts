import type { SonarrClient } from "../integrations/types";

export interface ManualImportEpisodeDto {
  id: number;
  episodeNumber: number;
  seasonNumber: number;
  hasFile: boolean;
}

export interface ManualImportItemDto {
  path: string;
  name: string;
  series: { id: number; title: string } | null;
  episodes: ManualImportEpisodeDto[];
  quality: { quality: { name: string } } | null;
  languages?: { id: number; name: string }[];
  releaseGroup: string | null;
  size: number;
}

export interface PendingImport {
  path: string;
  name: string;
  seriesId: number;
  seriesTitle: string;
  episodeIds: number[];
  episodeLabel: string;
  quality: unknown;
  qualityName: string | null;
  languages: unknown[];
  languageNames: string[];
  releaseGroup: string | null;
  size: number;
}

function episodeLabel(episode: ManualImportEpisodeDto): string {
  return `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`;
}

/**
 * Finds downloaded files in a folder that Sonarr hasn't imported yet.
 *
 * It uses Sonarr's manual-import folder scan rather than the download queue —
 * which is the point: a download that Sonarr staged as "already imported" (a
 * known stale-cache quirk when the same release is re-grabbed after a reset)
 * never appears in the queue, but its files still turn up in a folder scan.
 * Only episodes whose Sonarr record has `hasFile: false` are reported, so an
 * already-imported file (e.g. a leftover copy in the download folder) is never
 * re-imported over the real one.
 */
export class SonarrImportService {
  constructor(private readonly sonarr: SonarrClient) {}

  async findPendingImports(folder: string, seriesId?: number): Promise<PendingImport[]> {
    const items = (await this.sonarr.getManualImport(folder)) as unknown as ManualImportItemDto[];
    const pending: PendingImport[] = [];

    for (const item of items) {
      if (!item.series) continue;
      if (seriesId != null && item.series.id !== seriesId) continue;
      const needed = (item.episodes ?? []).filter((episode) => !episode.hasFile);
      if (needed.length === 0) continue;

      pending.push({
        path: item.path,
        name: item.name,
        seriesId: item.series.id,
        seriesTitle: item.series.title,
        episodeIds: needed.map((episode) => episode.id),
        episodeLabel: needed.map(episodeLabel).join(", "),
        quality: item.quality,
        qualityName: item.quality?.quality.name ?? null,
        languages: item.languages ?? [],
        languageNames: (item.languages ?? []).map((language) => language.name),
        releaseGroup: item.releaseGroup ?? null,
        size: item.size,
      });
    }

    return pending.sort((a, b) => a.seriesTitle.localeCompare(b.seriesTitle) || a.name.localeCompare(b.name));
  }

  async importFiles(pending: PendingImport[]): Promise<number> {
    if (pending.length === 0) return 0;

    await this.sonarr.triggerImport(
      pending.map((item) => ({
        path: item.path,
        seriesId: item.seriesId,
        episodeIds: item.episodeIds,
        quality: item.quality,
        languages: item.languages,
        releaseGroup: item.releaseGroup ?? undefined,
        downloadId: undefined,
        importMode: "auto",
      })),
    );

    return pending.length;
  }
}
