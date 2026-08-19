import type { MonitorOption, SonarrClient, SonarrCandidate, SonarrDiskSpace, SonarrEpisode, SonarrSeries } from "./types";

interface SonarrSeriesResource {
  tvdbId: number;
  title: string;
  year: number | null;
  status: string | null;
  seriesType: string;
  added?: string;
  seasons?: { seasonNumber: number; monitored?: boolean; statistics?: { totalEpisodeCount?: number } }[];
  id?: number;
  monitored?: boolean;
  statistics?: {
    episodeFileCount?: number;
    totalEpisodeCount?: number;
    sizeOnDisk?: number;
  };
}

interface SonarrDiskSpaceResource {
  path: string;
  freeSpace: number;
  totalSpace: number;
}

interface SonarrEpisodeResource {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber: number | null;
  title: string | null;
  hasFile?: boolean;
}

export class SonarrHttpClient implements SonarrClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v3${path}`, {
      ...init,
      headers: {
        "X-Api-Key": this.apiKey,
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`Sonarr responded ${response.status} for ${path}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async lookup(term: string): Promise<SonarrCandidate[]> {
    const results = await this.request<SonarrSeriesResource[]>(
      `/series/lookup?term=${encodeURIComponent(term)}`,
    );
    return results.map((s) => ({
      tvdbId: s.tvdbId,
      title: s.title,
      year: s.year,
      status: s.status,
      seriesType: s.seriesType,
      seasons: (s.seasons ?? []).map((season) => ({ seasonNumber: season.seasonNumber })),
    }));
  }

  async addSeries(
    candidate: SonarrCandidate,
    rootFolderPath: string,
    qualityProfileId: number,
    monitor?: MonitorOption,
  ): Promise<{ id: number }> {
    return this.request("/series", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildAddSeriesBody(candidate, rootFolderPath, qualityProfileId, monitor)),
    });
  }

  async getEpisodes(seriesId: number): Promise<SonarrEpisode[]> {
    const results = await this.request<SonarrEpisodeResource[]>(
      `/episode?seriesId=${seriesId}`,
    );
    return results.map((e) => ({
      id: e.id,
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
      absoluteEpisodeNumber: e.absoluteEpisodeNumber,
      title: e.title,
      hasFile: e.hasFile === true,
    }));
  }

  async getQueue(): Promise<unknown[]> {
    const body = await this.request<{ records: unknown[] }>("/queue");
    return body.records;
  }

  async getEpisodeFiles(seriesId: number): Promise<unknown[]> {
    return this.request(`/episodefile?seriesId=${seriesId}`);
  }

  async getQualityProfiles(): Promise<unknown[]> {
    return this.request("/qualityprofile");
  }

  async getQualityDefinitions(): Promise<unknown[]> {
    return this.request("/qualitydefinition");
  }

  async createQualityProfile(profile: unknown): Promise<{ id: number }> {
    return this.request("/qualityprofile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
  }

  async updateQualityProfile(id: number, profile: unknown): Promise<unknown> {
    return this.request(`/qualityprofile/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
  }

  async getCustomFormats(): Promise<unknown[]> {
    return this.request("/customformat");
  }

  async createCustomFormat(format: unknown): Promise<{ id: number }> {
    return this.request("/customformat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(format),
    });
  }

  async updateCustomFormat(id: number, format: unknown): Promise<unknown> {
    return this.request(`/customformat/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(format),
    });
  }

  async getManualImport(folder: string): Promise<unknown[]> {
    return this.request(`/manualimport?folder=${encodeURIComponent(folder)}`);
  }

  async triggerImport(files: unknown[]): Promise<{ id: number }> {
    return this.request("/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ManualImport", importMode: "auto", files }),
    });
  }

  async getMissingMonitoredBySeries(): Promise<{ seriesId: number; episodeIds: number[] }[]> {
    const bySeries = new Map<number, number[]>();
    const pageSize = 1000;
    for (let page = 1; ; page++) {
      const body = await this.request<{
        records?: { id: number; hasFile?: boolean; monitored?: boolean; seriesId?: number }[];
        totalRecords?: number;
      }>(`/wanted/missing?monitored=true&includeSeries=false&page=${page}&pageSize=${pageSize}`);
      const records = body.records ?? [];
      for (const episode of records) {
        if (episode.monitored === false || episode.hasFile === true || episode.seriesId == null) continue;
        const ids = bySeries.get(episode.seriesId) ?? [];
        ids.push(episode.id);
        bySeries.set(episode.seriesId, ids);
      }
      if (records.length === 0 || page * pageSize >= (body.totalRecords ?? 0)) break;
    }
    return [...bySeries.entries()].map(([seriesId, episodeIds]) => ({ seriesId, episodeIds }));
  }

  async searchEpisodes(episodeIds: number[]): Promise<{ id: number }> {
    return this.request("/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildEpisodeSearchCommand(episodeIds)),
    });
  }

  async rescanSeries(seriesId: number): Promise<{ id: number }> {
    return this.request("/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "RescanSeries", seriesId }),
    });
  }

  async getCommandStatus(commandId: number): Promise<string> {
    const body = await this.request<{ status?: string }>(`/command/${commandId}`);
    return body.status ?? "unknown";
  }

  async getSeries(): Promise<SonarrSeries[]> {
    const results = await this.request<SonarrSeriesResource[]>("/series");
    return results.map((s) => ({
      id: s.id ?? 0,
      tvdbId: s.tvdbId,
      title: s.title,
      year: s.year,
      status: s.status,
      monitored: s.monitored ?? false,
      episodeFileCount: s.statistics?.episodeFileCount ?? 0,
      totalEpisodeCount: countRealEpisodes(s.seasons ?? []),
      monitoredEpisodesTotal: (s.seasons ?? [])
        .filter((season) => season.monitored)
        .reduce((sum, season) => sum + (season.statistics?.totalEpisodeCount ?? 0), 0),
      sizeOnDisk: s.statistics?.sizeOnDisk ?? 0,
      addedAt: s.added ? Date.parse(s.added) : null,
    }));
  }

  async getDiskSpace(): Promise<SonarrDiskSpace[]> {
    const results = await this.request<SonarrDiskSpaceResource[]>("/diskspace");
    return results.map((d) => ({
      path: d.path,
      freeSpace: d.freeSpace,
      totalSpace: d.totalSpace,
    }));
  }

  async deleteSeries(id: number, deleteFiles: boolean): Promise<void> {
    await this.request(`/series/${id}?deleteFiles=${deleteFiles}`, { method: "DELETE" });
  }
}

export function countRealEpisodes(seasons: { seasonNumber: number; statistics?: { totalEpisodeCount?: number } }[]): number {
  return seasons
    .filter((season) => season.seasonNumber !== 0)
    .reduce((sum, season) => sum + (season.statistics?.totalEpisodeCount ?? 0), 0);
}

export function buildAddSeriesBody(
  candidate: SonarrCandidate,
  rootFolderPath: string,
  qualityProfileId: number,
  monitor: MonitorOption = { type: "all" },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    tvdbId: candidate.tvdbId,
    title: candidate.title,
    qualityProfileId,
    rootFolderPath,
    seriesType: "anime",
    monitored: true,
    monitor: monitor.type,
    addOptions: {
      searchForMissingEpisodes: true,
    },
  };

  if (monitor.type === "specificSeason") {
    body.seasons = candidate.seasons.map((s) => ({
      seasonNumber: s.seasonNumber,
      monitored: s.seasonNumber === monitor.season,
    }));
    body.addOptions = {
      searchForMissingEpisodes: true,
      monitorNewItems: false,
    };
  }

  return body;
}

export function buildEpisodeSearchCommand(episodeIds: number[]): { name: "EpisodeSearch"; episodeIds: number[] } {
  return {
    name: "EpisodeSearch",
    episodeIds: [...new Set(episodeIds)],
  };
}
