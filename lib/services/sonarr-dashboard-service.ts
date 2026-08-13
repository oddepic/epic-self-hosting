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
  sizeOnDisk: number;
  sizeRatio: number;
  downloadStatus: "finished" | "downloading";
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

function formatEpisodes(episodeFileCount: number, totalEpisodeCount: number): string {
  return `${episodeFileCount}/${totalEpisodeCount}`;
}

function downloadStatusOf(episodeFileCount: number, totalEpisodeCount: number): SonarrLibraryRow["downloadStatus"] {
  return totalEpisodeCount > 0 && episodeFileCount >= totalEpisodeCount ? "finished" : "downloading";
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
    const series = await this.sonarr.getSeries();
    const maxSize = Math.max(1, ...series.map((s) => s.sizeOnDisk));
    return series
      .map((s) => ({
        id: s.id,
        title: s.title,
        year: s.year,
        status: s.status,
        monitored: s.monitored,
        episodesLabel: formatEpisodes(s.episodeFileCount, s.totalEpisodeCount),
        sizeOnDisk: s.sizeOnDisk,
        sizeRatio: s.sizeOnDisk / maxSize,
        downloadStatus: downloadStatusOf(s.episodeFileCount, s.totalEpisodeCount),
        addedLabel: addedLabelOf(s.addedAt, now),
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }
}
