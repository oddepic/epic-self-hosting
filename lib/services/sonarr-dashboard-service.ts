import type { Db } from "../db/client";
import type { SonarrClient } from "../integrations/types";

export interface SonarrOverview {
  librarySizeBytes: number;
  seriesCount: number;
  freeBytes: number;
}

export interface SonarrLibraryRow {
  id: number;
  title: string;
  year: number | null;
  status: string | null;
  monitored: boolean;
  episodesLabel: string;
  missingCount: number;
  sizeOnDisk: number;
  sizeRatio: number;
  downloadStatus: "finished" | "downloading" | "missing";
  addedLabel: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function capitalizeWords(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

function addedLabelOf(addedAt: number | null, now: number): string {
  if (addedAt == null) return "—";
  const days = Math.floor((now - addedAt) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return capitalizeWords(`${days} days ago`);
}

function formatEpisodes(episodeFileCount: number, monitoredEpisodesTotal: number): string {
  return `${episodeFileCount}/${monitoredEpisodesTotal}`;
}

function downloadStatusOf(
  episodeFileCount: number,
  monitoredEpisodesTotal: number,
  missingCount: number,
): SonarrLibraryRow["downloadStatus"] {
  if (missingCount > 0) return "missing";
  return monitoredEpisodesTotal > 0 && episodeFileCount >= monitoredEpisodesTotal ? "finished" : "downloading";
}

export class SonarrDashboardService {
  constructor(
    private readonly db: Db,
    private readonly sonarr: SonarrClient,
    private readonly config: { rootFolder: string },
  ) {}

  async getOverview(): Promise<SonarrOverview> {
    const [series, disks] = await Promise.all([this.sonarr.getSeries(), this.sonarr.getDiskSpace()]);
    const librarySizeBytes = series.reduce((sum, s) => sum + s.sizeOnDisk, 0);
    const root = disks.find((d) => this.config.rootFolder.startsWith(d.path));
    return {
      librarySizeBytes,
      seriesCount: series.length,
      freeBytes: root?.freeSpace ?? 0,
    };
  }

  async getLibrary(now: number = Date.now()): Promise<SonarrLibraryRow[]> {
    const [series, missingBySeries] = await Promise.all([
      this.sonarr.getSeries(),
      this.sonarr.getMissingMonitoredBySeries(),
    ]);
    const missingCountById = new Map(missingBySeries.map((entry) => [entry.seriesId, entry.episodeIds.length]));
    const maxSize = Math.max(1, ...series.map((s) => s.sizeOnDisk));
    return series
      .map((s) => ({
        id: s.id,
        title: s.title,
        year: s.year,
        status: s.status,
        monitored: s.monitored,
        episodesLabel: formatEpisodes(s.episodeFileCount, s.monitoredEpisodesTotal),
        missingCount: missingCountById.get(s.id) ?? 0,
        sizeOnDisk: s.sizeOnDisk,
        sizeRatio: s.sizeOnDisk / maxSize,
        downloadStatus: downloadStatusOf(s.episodeFileCount, s.monitoredEpisodesTotal, missingCountById.get(s.id) ?? 0),
        addedLabel: addedLabelOf(s.addedAt, now),
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }
}
