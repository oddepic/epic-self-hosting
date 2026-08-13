import type { SonarrClient } from "../integrations/types";

interface QualityProfileDto {
  id: number;
  name: string;
  cutoff: number;
  minFormatScore: number;
  upgradeAllowed: boolean;
}

interface CustomFormatSpecificationDto {
  name: string;
  implementation: string;
  implementationName: string;
  negate: boolean;
  required: boolean;
  fields: { name: string; value: number | null; order: number }[];
}

interface CustomFormatDto {
  id: number;
  name: string;
  includeCustomFormatWhenRenaming: boolean;
  specifications: CustomFormatSpecificationDto[];
}

function findSizeLimitFormat(formats: CustomFormatDto[]): CustomFormatDto | null {
  return (
    formats.find((format) =>
      format.specifications.some(
        (spec) => spec.implementation === "SizeSpecification" && spec.negate === true,
      ),
    ) ?? null
  );
}

export class SonarrProfileService {
  async verifyProfile(sonarr: SonarrClient, profileId: number): Promise<{
    id: number;
    name: string;
    cutoff: number;
    minFormatScore: number;
    upgradeAllowed: boolean;
  }> {
    const profiles = (await sonarr.getQualityProfiles()) as unknown as QualityProfileDto[];
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) {
      throw new Error(`Quality profile ${profileId} not found in Sonarr`);
    }
    return {
      id: profile.id,
      name: profile.name,
      cutoff: profile.cutoff,
      minFormatScore: profile.minFormatScore,
      upgradeAllowed: profile.upgradeAllowed,
    };
  }

  async getSizeLimit(sonarr: SonarrClient): Promise<{ customFormatId: number | null; maxGb: number | null }> {
    const formats = (await sonarr.getCustomFormats()) as unknown as CustomFormatDto[];
    const format = findSizeLimitFormat(formats);
    if (!format) return { customFormatId: null, maxGb: null };
    const spec = format.specifications.find((s) => s.implementation === "SizeSpecification");
    const maxField = spec?.fields.find((field) => field.name === "max");
    return { customFormatId: format.id, maxGb: typeof maxField?.value === "number" ? maxField.value : null };
  }

  async setSizeLimit(sonarr: SonarrClient, maxGb: number): Promise<{ customFormatId: number; maxGb: number }> {
    if (!Number.isFinite(maxGb) || maxGb <= 0) {
      throw new Error("Max file size must be a positive number in GB");
    }
    const formats = (await sonarr.getCustomFormats()) as unknown as CustomFormatDto[];
    const format = findSizeLimitFormat(formats);
    if (!format) {
      throw new Error("No oversize custom format found in Sonarr (SizeSpecification with negate)");
    }
    const updated: CustomFormatDto = {
      ...format,
      specifications: format.specifications.map((spec) => ({
        ...spec,
        fields: spec.fields.map((field) => (field.name === "max" ? { ...field, value: maxGb } : field)),
      })),
    };
    await sonarr.updateCustomFormat(format.id, updated);
    return { customFormatId: format.id, maxGb };
  }
}
