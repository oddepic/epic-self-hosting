import { describe, it, expect } from "vitest";
import { SonarrImportService, type ManualImportItemDto } from "./sonarr-import-service";
import type { SonarrClient } from "../integrations/types";

function manualImportItem(overrides: Partial<ManualImportItemDto> = {}): ManualImportItemDto {
  return {
    path: "D:\\Downloads\\Torrents\\Anime\\[Group] Any Anime - S01E01.mkv",
    name: "[Group] Any Anime - S01E01",
    series: { id: 7, title: "Any Anime" },
    episodes: [{ id: 101, seasonNumber: 1, episodeNumber: 1, hasFile: false }],
    quality: { quality: { name: "WEBRip-1080p" } },
    languages: [{ id: 8, name: "Japanese" }],
    releaseGroup: "Group",
    size: 700_000_000,
    ...overrides,
  };
}

function fakeSonarr(items: ManualImportItemDto[]): SonarrClient & { imported: unknown[] } {
  const imported: unknown[] = [];
  return {
    imported,
    async lookup() {
      return [];
    },
    async addSeries() {
      return { id: 1 };
    },
    async getEpisodes() {
      return [];
    },
    async getQueue() {
      return [];
    },
    async getEpisodeFiles() {
      return [];
    },
    async getQualityProfiles() {
      return [];
    },
    async getQualityDefinitions() {
      return [];
    },
    async createQualityProfile() {
      return { id: 99 };
    },
    async updateQualityProfile() {
      return {};
    },
    async getCustomFormats() {
      return [];
    },
    async createCustomFormat() {
      return { id: 1 };
    },
    async updateCustomFormat() {
      return {};
    },
    async getManualImport() {
      return items;
    },
    async triggerImport(files: unknown[]) {
      imported.push(...files);
      return { id: 1 };
    },
    async getSeries() {
      return [];
    },
    async getDiskSpace() {
      return [];
    },
    async deleteSeries() {},
  };
}

describe("SonarrImportService.findPendingImports", () => {
  it("returns files whose episodes have no file yet", async () => {
    const service = new SonarrImportService(
      fakeSonarr([manualImportItem(), manualImportItem({ path: "D:\\x\\Any Anime - S01E02.mkv", episodes: [{ id: 102, seasonNumber: 1, episodeNumber: 2, hasFile: false }] })]),
    );
    const pending = await service.findPendingImports("D:\\Downloads\\Torrents\\Anime");
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ seriesId: 7, episodeIds: [101], episodeLabel: "S01E01", qualityName: "WEBRip-1080p" });
  });

  it("skips files whose episodes are already imported", async () => {
    const service = new SonarrImportService(
      fakeSonarr([manualImportItem({ episodes: [{ id: 101, seasonNumber: 1, episodeNumber: 1, hasFile: true }] })]),
    );
    const pending = await service.findPendingImports("D:\\Downloads\\Torrents\\Anime");
    expect(pending).toHaveLength(0);
  });

  it("skips files with no matched series", async () => {
    const service = new SonarrImportService(fakeSonarr([manualImportItem({ series: null })]));
    const pending = await service.findPendingImports("D:\\Downloads\\Torrents\\Anime");
    expect(pending).toHaveLength(0);
  });

  it("only reports the episodes that lack a file within a mixed file", async () => {
    const service = new SonarrImportService(
      fakeSonarr([
        manualImportItem({
          episodes: [
            { id: 101, seasonNumber: 1, episodeNumber: 1, hasFile: false },
            { id: 102, seasonNumber: 1, episodeNumber: 2, hasFile: true },
          ],
        }),
      ]),
    );
    const pending = await service.findPendingImports("D:\\Downloads\\Torrents\\Anime");
    expect(pending[0]!.episodeIds).toEqual([101]);
    expect(pending[0]!.episodeLabel).toBe("S01E01");
  });

  it("sorts by series title then name", async () => {
    const service = new SonarrImportService(
      fakeSonarr([
        manualImportItem({ path: "D:\\x\\Zeta.mkv", name: "Zeta" }),
        manualImportItem({ path: "D:\\x\\Alpha.mkv", name: "Alpha" }),
      ]),
    );
    const pending = await service.findPendingImports("D:\\Downloads\\Torrents\\Anime");
    expect(pending.map((p) => p.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("filters to a single series when a seriesId is given", async () => {
    const service = new SonarrImportService(
      fakeSonarr([
        manualImportItem({ path: "D:\\x\\Alpha.mkv", name: "Alpha", series: { id: 7, title: "Any Anime" } }),
        manualImportItem({
          path: "D:\\x\\Beta.mkv",
          name: "Beta",
          series: { id: 9, title: "Other Anime" },
          episodes: [{ id: 901, seasonNumber: 1, episodeNumber: 1, hasFile: false }],
        }),
      ]),
    );
    const pending = await service.findPendingImports("D:\\Downloads\\Torrents\\Anime", 7);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.seriesId).toBe(7);
  });
});

describe("SonarrImportService.importFiles", () => {
  it("triggers a ManualImport command with the pending files", async () => {
    const sonarr = fakeSonarr([
      manualImportItem(),
      manualImportItem({ path: "D:\\x\\Any Anime - S01E02.mkv", episodes: [{ id: 102, seasonNumber: 1, episodeNumber: 2, hasFile: false }] }),
    ]);
    const service = new SonarrImportService(sonarr);
    const pending = await service.findPendingImports("D:\\Downloads\\Torrents\\Anime");

    const imported = await service.importFiles(pending);

    expect(imported).toBe(2);
    expect(sonarr.imported).toHaveLength(2);
    const first = sonarr.imported[0] as {
      path: string;
      seriesId: number;
      episodeIds: number[];
      importMode: string;
      releaseGroup: string;
    };
    expect(first).toMatchObject({
      seriesId: 7,
      episodeIds: [101],
      importMode: "copy",
      releaseGroup: "Group",
    });
    expect(first.path).toContain("S01E01");
  });

  it("returns 0 and does nothing when there is nothing to import", async () => {
    const sonarr = fakeSonarr([]);
    const service = new SonarrImportService(sonarr);
    const imported = await service.importFiles([]);
    expect(imported).toBe(0);
    expect(sonarr.imported).toHaveLength(0);
  });
});
