"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import Button from "@/components/ui/button";
import Input from "@/components/ui/input";
import { SettingRow, SettingSection } from "@/components/settings/setting-section";

interface ResetStatus {
  sonarr: { success: boolean; seriesDeleted: number };
  jellyfin: { success: boolean; itemsDeleted: number };
  db: { success: boolean; tables: Record<string, number> };
  files: { success: boolean; empty: boolean };
}

function ConnectionStatus({ linked }: { linked: boolean | null }) {
  if (linked === null) return <span className="text-xs text-text-muted">Checking…</span>;
  return (
    <span className={`font-mono text-[11px] uppercase tracking-wider ${linked ? "text-success" : "text-text-muted"}`}>
      {linked ? "Connected" : "Not connected"}
    </span>
  );
}

function ResetLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={ok ? "text-success" : "text-danger"}>
      {ok ? <Check className="inline h-3.5 w-3.5" aria-hidden /> : <X className="inline h-3.5 w-3.5" aria-hidden />} {label}
    </span>
  );
}

export default function SettingsView({ refreshSignal }: { refreshSignal?: number }) {
  const [linked, setLinked] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [syncingLibrary, setSyncingLibrary] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [settingUpSonarr, setSettingUpSonarr] = useState(false);
  const [sonarrSetupResult, setSonarrSetupResult] = useState<string | null>(null);
  const [prefAudio, setPrefAudio] = useState("");
  const [prefSubtitle, setPrefSubtitle] = useState("");
  const [prefForced, setPrefForced] = useState(false);
  const [prefSaved, setPrefSaved] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState<string | null>(null);
  const [resetStatus, setResetStatus] = useState<ResetStatus | null>(null);
  const [reloading, setReloading] = useState(false);
  const [sizeLimit, setSizeLimit] = useState("");
  const [sizeLimitLoading, setSizeLimitLoading] = useState(true);
  const [sizeLimitSaving, setSizeLimitSaving] = useState(false);
  const [sizeLimitResult, setSizeLimitResult] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    const res = await fetch("/api/mal/status");
    if (res.ok) {
      const body = (await res.json()) as { linked: boolean };
      setLinked(body.linked);
    } else {
      setLinked(false);
    }
  }, []);

  const loadSizeLimit = useCallback(async () => {
    setSizeLimitLoading(true);
    try {
      const res = await fetch("/api/sonarr/size-limit");
      if (res.ok) {
        const body = (await res.json()) as { maxGb: number | null };
        setSizeLimit(body.maxGb != null ? String(body.maxGb) : "");
        setSizeLimitResult(body.maxGb != null ? null : "No oversize custom format found in Sonarr");
      } else {
        const body = (await res.json()) as { error?: string };
        setSizeLimitResult(body.error ?? "Could not read the size limit.");
      }
    } catch {
      setSizeLimitResult("Could not reach Sonarr.");
    } finally {
      setSizeLimitLoading(false);
    }
  }, []);

  useEffect(() => {
    void checkStatus();
    void loadSizeLimit();
  }, [checkStatus, loadSizeLimit, refreshSignal]);

  async function onSaveSizeLimit() {
    const maxGb = Number(sizeLimit);
    if (!Number.isFinite(maxGb) || maxGb <= 0) {
      setSizeLimitResult("Enter a positive number in GB.");
      return;
    }
    setSizeLimitSaving(true);
    try {
      const res = await fetch("/api/sonarr/size-limit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxGb }),
      });
      if (!res.ok) throw new Error("Save failed");
      setSizeLimitResult(`Size limit set to ${maxGb} GB.`);
    } catch {
      setSizeLimitResult("Could not save the size limit.");
    } finally {
      setSizeLimitSaving(false);
    }
  }

  async function onSync() {
    setSyncing(true);
    setResult(null);
    const started = performance.now();
    try {
      const res = await fetch("/api/mal/sync", { method: "POST" });
      if (!res.ok) throw new Error("Sync failed");
      const body = (await res.json()) as {
        linked: boolean;
        result: { imported: number; updated: number; skipped: number } | null;
      };
      setLinked(body.linked);
      if (body.result) {
        const elapsed = ((performance.now() - started) / 1000).toFixed(1);
        setResult(`Imported ${body.result.imported}, updated ${body.result.updated}, skipped ${body.result.skipped} · Synced in ${elapsed}s`);
      }
    } catch {
      setResult("Sync failed — check the MAL connection.");
    } finally {
      setSyncing(false);
    }
  }

  async function onUnlink() {
    setUnlinking(true);
    try {
      const res = await fetch("/api/mal/unlink", { method: "POST" });
      if (!res.ok) throw new Error("Unlink failed");
      setLinked(false);
      setResult(null);
    } catch {
      setResult("Unlink failed — try again.");
    } finally {
      setUnlinking(false);
    }
  }

  async function onSyncLibrary() {
    setSyncingLibrary(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/library/sync", { method: "POST" });
      if (!res.ok) throw new Error("Library sync failed");
      const body = (await res.json()) as {
        seriesMatched: number;
        seriesLinked: number;
        episodesAvailable: number;
        progressUpdated: number;
        importsTriggered?: number;
        jellyfinRebuilt?: boolean;
      };
      const imports = body.importsTriggered ? `, ${body.importsTriggered} files sent for import` : "";
      const rebuilt = body.jellyfinRebuilt ? ", Jellyfin library rebuilt" : "";
      setSyncResult(`Matched ${body.seriesMatched} series, linked ${body.seriesLinked}, ${body.episodesAvailable} episodes available, ${body.progressUpdated} progress updates${imports}${rebuilt}`);
    } catch {
      setSyncResult("Library sync failed — check the Jellyfin connection.");
    } finally {
      setSyncingLibrary(false);
    }
  }

  async function onSetupSonarr() {
    setSettingUpSonarr(true);
    setSonarrSetupResult(null);
    try {
      const res = await fetch("/api/sonarr/setup", { method: "POST" });
      if (!res.ok) throw new Error("Setup failed");
      const body = (await res.json()) as {
        profile: { id: number; name: string; cutoff: number; minFormatScore: number };
      };
      setSonarrSetupResult(`Profile verified: "${body.profile.name}" (id ${body.profile.id}), min format score ${body.profile.minFormatScore}`);
    } catch {
      setSonarrSetupResult("Sonarr setup failed — check the connection and SONARR_QUALITY_PROFILE_ID.");
    } finally {
      setSettingUpSonarr(false);
    }
  }

  async function onSavePreferences() {
    setPrefSaved(false);
    const res = await fetch("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioLanguage: prefAudio || null,
        subtitleLanguage: prefSubtitle || null,
        subtitleForced: prefForced,
      }),
    });
    if (res.ok) setPrefSaved(true);
  }

  async function onLoadPreferences() {
    setPrefSaved(false);
    const res = await fetch("/api/preferences");
    if (res.ok) {
      const body = (await res.json()) as {
        preference: { audioLanguage: string | null; subtitleLanguage: string | null; subtitleForced: boolean } | null;
      };
      setPrefAudio(body.preference?.audioLanguage ?? "");
      setPrefSubtitle(body.preference?.subtitleLanguage ?? "");
      setPrefForced(body.preference?.subtitleForced ?? false);
    }
  }

  async function onHardReset() {
    if (!window.confirm("Hard reset? This removes ALL Sonarr series and empties the anime folder (the folder itself is kept), purges the Jellyfin library, and wipes the app database — back to a brand-new user.")) {
      return;
    }
    setResetting(true);
    setResetResult(null);
    setResetStatus(null);
    setReloading(false);
    try {
      const res = await fetch("/api/settings/reset", { method: "POST" });
      const body = (await res.json()) as ResetStatus & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Reset failed");
      setResetStatus(body);
      setResetResult("Reset complete — reloading…");
      setReloading(true);
      setTimeout(() => window.location.reload(), 1800);
    } catch (error) {
      setResetResult(error instanceof Error ? error.message : "Reset failed — check the connections.");
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <SettingSection title="Playback">
        <SettingRow label="Audio language" description="ISO-639 code applied at playback (jpn, spa, eng…).">
          <Input
            type="text"
            value={prefAudio}
            onChange={(e) => setPrefAudio(e.target.value)}
            placeholder="jpn"
            className="w-28"
          />
        </SettingRow>
        <SettingRow label="Subtitle language" description="ISO-639 code applied at playback.">
          <Input
            type="text"
            value={prefSubtitle}
            onChange={(e) => setPrefSubtitle(e.target.value)}
            placeholder="spa"
            className="w-28"
          />
        </SettingRow>
        <SettingRow label="Forced subtitles only">
          <input
            type="checkbox"
            checked={prefForced}
            onChange={(e) => setPrefForced(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
        </SettingRow>
        <SettingRow label="Track preferences">
          <Button onClick={onLoadPreferences}>Load</Button>
          <Button variant="primary" onClick={onSavePreferences}>
            Save
          </Button>
          {prefSaved && <span className="text-xs text-success">Saved.</span>}
        </SettingRow>
      </SettingSection>

      <SettingSection title="Integrations">
        <SettingRow label="MyAnimeList" description="Status changes and completed episodes push automatically while connected.">
          <ConnectionStatus linked={linked} />
        </SettingRow>
        <SettingRow label="MAL account">
          <a href="/api/auth/mal">
            <Button>{linked ? "Re-link" : "Link"}</Button>
          </a>
          <Button onClick={onSync} disabled={syncing || !linked}>
            {syncing ? "Syncing…" : "Sync now"}
          </Button>
          <Button onClick={onUnlink} disabled={unlinking || !linked}>
            {unlinking ? "Unlinking…" : "Unlink"}
          </Button>
        </SettingRow>
        <SettingRow label="Jellyfin">
          <Button onClick={onSyncLibrary} disabled={syncingLibrary}>
            {syncingLibrary ? "Syncing…" : "Sync library"}
          </Button>
        </SettingRow>
        <SettingRow label="Sonarr">
          <Button onClick={onSetupSonarr} disabled={settingUpSonarr}>
            {settingUpSonarr ? "Checking…" : "Verify profile"}
          </Button>
        </SettingRow>
        <SettingRow label="Max file size" description="Per-episode cap enforced by the oversized custom format.">
          <div className="relative">
            <Input
              type="number"
              min="0.1"
              step="0.1"
              value={sizeLimit}
              onChange={(e) => setSizeLimit(e.target.value)}
              placeholder={sizeLimitLoading ? "Loading…" : "1.5"}
              className="w-24 pr-10"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[11px] uppercase tracking-wider text-text-muted">
              GB
            </span>
          </div>
          <Button onClick={() => void onSaveSizeLimit()} disabled={sizeLimitSaving || sizeLimitLoading}>
            {sizeLimitSaving ? "Saving…" : "Save"}
          </Button>
          {sizeLimitResult && <span className="text-xs text-text-muted">{sizeLimitResult}</span>}
        </SettingRow>
      </SettingSection>

      {(result || syncResult || sonarrSetupResult) && (
        <div className="mt-4 flex flex-col gap-1 text-sm text-text-secondary">
          {result && <p>{result}</p>}
          {syncResult && <p>{syncResult}</p>}
          {sonarrSetupResult && <p>{sonarrSetupResult}</p>}
        </div>
      )}

      <SettingSection title="System">
        <SettingRow label="About" description="Self-hosted anime platform — Jellyfin, Sonarr and MAL in one place." />
        <SettingRow label="Hard reset" description="Removes all Sonarr series, empties the anime folder (kept on disk), purges Jellyfin, and wipes the app database.">
          <Button variant="danger" onClick={() => void onHardReset()} disabled={resetting}>
            {resetting ? "Resetting…" : "Hard reset"}
          </Button>
        </SettingRow>
      </SettingSection>
      {resetResult && <p className="mt-4 text-sm text-text-secondary">{resetResult}</p>}
      {resetStatus && (
        <div className="mt-2 flex flex-col gap-1.5 text-sm">
          <ResetLine ok={resetStatus.sonarr.success} label={`Sonarr — success (${resetStatus.sonarr.seriesDeleted} series removed)`} />
          <ResetLine ok={resetStatus.jellyfin.success} label={`Jellyfin — success (${resetStatus.jellyfin.itemsDeleted} items removed)`} />
          <ResetLine ok={resetStatus.files.success} label={`Files - success (anime folder emptied, kept on disk)`} />
          <ResetLine
            ok={resetStatus.db.success}
            label={`Database — success (${Object.keys(resetStatus.db.tables).join(", ")})`}
          />
          {reloading && <p className="text-xs text-text-muted">Reloading…</p>}
        </div>
      )}
    </div>
  );
}
