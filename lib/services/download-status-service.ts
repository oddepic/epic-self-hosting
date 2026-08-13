import type { Db } from "../db/client";
import { animes } from "../db/schema";
import type { SonarrClient } from "../integrations/types";

export interface DownloadItem {
  animeId: number;
  animeTitle: string;
  filesDownloaded: number;
  totalEpisodes: number;
  percent: number;
  state: string;
  downloadClient: string | null;
  error: string | null;
}

const STATE_ORDER: Record<string, number> = {
  downloading: 0,
  importPending: 1,
  importing: 2,
  imported: 3,
  failed: 4,
  warning: 5,
};

export class DownloadStatusService {
  constructor(
    private readonly db: Db,
    private readonly sonarr: SonarrClient,
  ) {}

  async getDownloadStatus(): Promise<DownloadItem[]> {
    const [queue, series] = await Promise.all([this.sonarr.getQueue(), this.sonarr.getSeries()]);

    const animeBySonarrId = new Map<number, { id: number; title: string }>();
    for (const anime of this.db.select().from(animes).all()) {
      if (anime.sonarrId != null) {
        animeBySonarrId.set(anime.sonarrId, { id: anime.id, title: anime.titleEnglish ?? anime.titleRomaji });
      }
    }

    const seriesById = new Map(
      series.map((s) => [s.id, s]),
    );

    const bySeries = new Map<number, { state: string; downloadClient: string | null; error: string | null }>();
    for (const record of queue as {
      seriesId?: number;
      status?: string;
      trackedDownloadState?: string;
      errorMessage?: string | null;
      downloadClient?: string | null;
    }[]) {
      if (record.seriesId == null) continue;
      const state = record.trackedDownloadState ?? record.status ?? "unknown";
      bySeries.set(record.seriesId, {
        state,
        downloadClient: record.downloadClient ?? null,
        error: record.errorMessage ?? null,
      });
    }

    const items: DownloadItem[] = [];
    for (const [seriesId, queueInfo] of bySeries) {
      const anime = animeBySonarrId.get(seriesId);
      const sonarrSeries = seriesById.get(seriesId);
      if (!anime) continue;

      const filesDownloaded = sonarrSeries?.episodeFileCount ?? 0;
      const totalEpisodes = sonarrSeries?.monitoredEpisodesTotal ?? 0;
      const percent =
        totalEpisodes > 0 ? Math.min(100, Math.round((filesDownloaded / totalEpisodes) * 100)) : 0;

      items.push({
        animeId: anime.id,
        animeTitle: anime.title,
        filesDownloaded,
        totalEpisodes,
        percent,
        state: queueInfo.state,
        downloadClient: queueInfo.downloadClient,
        error: queueInfo.error,
      });
    }

    return items.sort((a, b) => {
      const stateDiff = (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9);
      if (stateDiff !== 0) return stateDiff;
      return a.animeTitle.localeCompare(b.animeTitle);
    });
  }
}
