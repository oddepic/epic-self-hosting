import type { Db } from "../db/client";
import type { JellyfinClient, SonarrClient } from "../integrations/types";
import { AvailabilityService, type SyncResult } from "./availability-service";

export interface AvailabilityReconciliationResult extends SyncResult {
  rescanTriggered: boolean;
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

/**
 * Reconcile the app with the current Jellyfin/Sonarr state. If Sonarr has a
 * file that Jellyfin has not indexed, request one library rescan and retry
 * after the scan finishes.
 */
export async function reconcileAvailability(
  db: Db,
  jellyfin: JellyfinClient,
  sonarr: SonarrClient,
): Promise<AvailabilityReconciliationResult> {
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

  return { ...result, rescanTriggered };
}
