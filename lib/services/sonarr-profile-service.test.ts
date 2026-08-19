import { describe, it, expect, beforeEach } from "vitest";
import { SonarrProfileService } from "./sonarr-profile-service";
import type { SonarrClient } from "../integrations/types";

function oversizedFormat(maxGb: number | null, negate = true) {
  return {
    id: 34,
    name: "oversized",
    includeCustomFormatWhenRenaming: false,
    specifications: [
      {
        name: "Oversized",
        implementation: "SizeSpecification",
        implementationName: "Size",
        negate,
        required: true,
        fields: [
          { name: "min", value: 0, order: 0 },
          { name: "max", value: maxGb, order: 1 },
        ],
      },
    ],
  };
}

function fakeSonarr(behavior: {
  profiles?: { id: number; name: string; cutoff: number; minFormatScore: number; upgradeAllowed: boolean }[];
  customFormats?: unknown[];
} = {}): SonarrClient & { updatedCustomFormats: { id: number; format: unknown }[] } {
  const updatedCustomFormats: { id: number; format: unknown }[] = [];
  return {
    updatedCustomFormats,
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
      return (
        behavior.profiles ?? [
          { id: 9, name: "Anime - 1080p", cutoff: 1004, minFormatScore: 100, upgradeAllowed: true },
        ]
      );
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
      return behavior.customFormats ?? [];
    },
    async createCustomFormat() {
      return { id: 1 };
    },
    async updateCustomFormat(id: number, format: unknown) {
      updatedCustomFormats.push({ id, format });
      return {};
    },
    async getManualImport() {
      return [];
    },
    async triggerImport() {
      return { id: 1 };
    },
    async getMissingMonitoredBySeries() {
      return [];
    },
    async searchEpisodes() {
      return { id: 1 };
    },
    async rescanSeries() {
      return { id: 1 };
    },
    async getCommandStatus() {
      return "completed";
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

describe("SonarrProfileService.verifyProfile", () => {
  let service: SonarrProfileService;

  beforeEach(() => {
    service = new SonarrProfileService();
  });

  it("returns the configured profile when it exists", async () => {
    const result = await service.verifyProfile(fakeSonarr(), 9);
    expect(result).toMatchObject({ id: 9, name: "Anime - 1080p", cutoff: 1004, minFormatScore: 100 });
  });

  it("throws when the configured profile does not exist", async () => {
    await expect(service.verifyProfile(fakeSonarr(), 999)).rejects.toThrow(
      "Quality profile 999 not found in Sonarr",
    );
  });
});

describe("SonarrProfileService.getSizeLimit", () => {
  let service: SonarrProfileService;

  beforeEach(() => {
    service = new SonarrProfileService();
  });

  it("returns the max field of the oversized SizeSpecification format", async () => {
    const sonarr = fakeSonarr({ customFormats: [oversizedFormat(1.5)] });
    const result = await service.getSizeLimit(sonarr);
    expect(result).toEqual({ customFormatId: 34, maxGb: 1.5 });
  });

  it("returns nulls when no size-limit custom format exists", async () => {
    const sonarr = fakeSonarr({ customFormats: [{ id: 5, name: "VOSTFR", specifications: [] }] });
    const result = await service.getSizeLimit(sonarr);
    expect(result).toEqual({ customFormatId: null, maxGb: null });
  });

  it("ignores non-negated SizeSpecification formats (not a size cap)", async () => {
    const sonarr = fakeSonarr({ customFormats: [oversizedFormat(1.5, false)] });
    const result = await service.getSizeLimit(sonarr);
    expect(result).toEqual({ customFormatId: null, maxGb: null });
  });
});

describe("SonarrProfileService.setSizeLimit", () => {
  let service: SonarrProfileService;

  beforeEach(() => {
    service = new SonarrProfileService();
  });

  it("updates the max field of the oversized format in Sonarr", async () => {
    const sonarr = fakeSonarr({ customFormats: [oversizedFormat(1.5)] });
    const result = await service.setSizeLimit(sonarr, 2);
    expect(result).toEqual({ customFormatId: 34, maxGb: 2 });
    expect(sonarr.updatedCustomFormats).toHaveLength(1);
    const format = sonarr.updatedCustomFormats[0]!.format as { id: number; specifications: { fields: { name: string; value: number | null }[] }[] };
    expect(sonarr.updatedCustomFormats[0]!.id).toBe(34);
    const maxField = format.specifications[0]!.fields.find((field) => field.name === "max");
    expect(maxField!.value).toBe(2);
    const minField = format.specifications[0]!.fields.find((field) => field.name === "min");
    expect(minField!.value).toBe(0);
  });

  it("throws when no size-limit custom format exists", async () => {
    const sonarr = fakeSonarr({ customFormats: [{ id: 5, name: "VOSTFR", specifications: [] }] });
    await expect(service.setSizeLimit(sonarr, 2)).rejects.toThrow(
      "No oversize custom format found in Sonarr",
    );
  });

  it("rejects non-positive max sizes", async () => {
    const sonarr = fakeSonarr({ customFormats: [oversizedFormat(1.5)] });
    await expect(service.setSizeLimit(sonarr, 0)).rejects.toThrow("Max file size must be a positive number");
    await expect(service.setSizeLimit(sonarr, -1)).rejects.toThrow("Max file size must be a positive number");
    await expect(service.setSizeLimit(sonarr, Number.NaN)).rejects.toThrow("Max file size must be a positive number");
    expect(sonarr.updatedCustomFormats).toHaveLength(0);
  });
});




