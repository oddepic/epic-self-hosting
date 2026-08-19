import { isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes } from "../db/schema";
import type { JellyfinClient, SonarrClient } from "../integrations/types";
import { AvailabilityService, type SyncResult } from "./availability-service";

export interface AvailabilityReconciliationResult extends SyncResult {
  rescanTriggered: boolean;
  sonarrRescanned: number;
}

export interface AvailabilityReconciliationOptions {
  // Ask Sonarr to rescan its series folders before reconciling. This catches
  // external deletions/additions that Sonarr's file watcher sometimes misses.
  rescanSonarr?: boolean;
}

export async function waitForJellyfinLibraryScan(
  jellyfin: Pick<JellyfinClient, "isLibraryScanRunning">,
): Promise<void> {
  // RefreshLibrary starts asynchronously. Give Jellyfin time to transition
  // the task to Running, then wait until it returns to Idle (max 60s).
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!(await jellyfin.isLibraryScanRunning())) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSonarrCommand(sonarr: SonarrClient, commandId: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  let status = "";
  while (Date.now() < deadline) {
    try {
      status = await sonarr.getCommandStatus(commandId);
    } catch {
      // A transient failure should not block the reconciliation.
      return;
    }
    if (status === "completed" || status === "failed" || status === "aborted" || status === "cancelled") {
      return;
    }
    await sleep(1_500);
  }
}

async function rescanSonarrSeries(db: Db, sonarr: SonarrClient): Promise<number> {
  const linked = db
    .select({ sonarrId: animes.sonarrId })
    .from(animes)
    .where(isNotNull(animes.sonarrId))
    .all();
  const uniqueSeriesIds = [...new Set(linked.map((row) => row.sonarrId!))];
  let rescanned = 0;
  for (const seriesId of uniqueSeriesIds) {
    try {
      const command = await sonarr.rescanSeries(seriesId);
      await waitForSonarrCommand(sonarr, command.id);
      rescanned++;
    } catch (error) {
      // A failed rescan must not break the whole reconciliation.
      console.error(`Sonarr rescan failed for series ${seriesId}:`, error);
    }
  }
  return rescanned;
}

/**
 * Reconcile the app with the current Jellyfin/Sonarr state. If Sonarr has a
 * file that Jellyfin has not indexed, request one library rescan and retry
 * after the scan finishes.
 */
export async function reconcileAvailability(
  db: Db,
  jellyfin: JellyfinClient,
  sonarr: SonarrClient,
  options: AvailabilityReconciliationOptions = {},
): Promise<AvailabilityReconciliationResult> {
  const sonarrRescanned = options.rescanSonarr ? await rescanSonarrSeries(db, sonarr) : 0;

  const service = new AvailabilityService(db, jellyfin, sonarr);
  let result = await service.sync();
  let rescanTriggered = false;

  if (result.missingFromJellyfin > 0) {
    try {
      await jellyfin.refreshLibrary();
      await waitForJellyfinLibraryScan(jellyfin);
      result = await service.sync();
      rescanTriggered = true;
    } catch {
      // Keep the first result; a later automatic or manual reconciliation retries.
    }
  }

  return { ...result, rescanTriggered, sonarrRescanned };
}
