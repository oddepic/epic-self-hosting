"use client";

import { useCallback, useEffect, useState } from "react";
import { Database, HardDrive, Search, Tv, Wrench } from "lucide-react";
import Input from "@/components/ui/input";
import Skeleton from "@/components/ui/skeleton";
import Card from "@/components/ui/card";
import type { SonarrLibraryRow, SonarrOverview } from "@/lib/services/sonarr-dashboard-service";

function formatBytes(bytes: number): string {
  if (bytes >= 1_099_511_627_776) return `${(bytes / 1_099_511_627_776).toFixed(2)} TB`;
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_048_576)} MB`;
}

const DOWNLOAD_STATUS: Record<string, { label: string; className: string }> = {
  finished: { label: "Finished", className: "text-success" },
  downloading: { label: "Downloading", className: "text-info" },
  missing: { label: "Missing", className: "text-danger" },
};

export default function SonarrView({
  refreshSignal,
  onMissingChange,
}: {
  refreshSignal?: number;
  onMissingChange?: (hasMissing: boolean) => void;
}) {
  const [overview, setOverview] = useState<SonarrOverview | null>(null);
  const [library, setLibrary] = useState<SonarrLibraryRow[]>([]);
  const [filter, setFilter] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [fixingId, setFixingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch("/api/sonarr/library");
      if (res.ok) {
        const body = await res.json() as { overview: SonarrOverview; library: SonarrLibraryRow[] };
        setOverview(body.overview);
        setLibrary(body.library);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    // Re-check missing episodes automatically so deletions or new imports
    // are reflected without waiting for a manual refresh.
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load, refreshSignal]);

  useEffect(() => {
    onMissingChange?.(library.some((row) => row.missingCount > 0));
  }, [library, onMissingChange]);

  async function fixSeries(seriesId: number) {
    setFixingId(seriesId);
    try {
      const res = await fetch("/api/sonarr/search-missing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesId }),
      });
      if (res.ok) void load();
    } finally {
      setFixingId(null);
    }
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <p className="text-lg font-medium">Unable to load Sonarr library</p>
        <button
          onClick={() => void load()}
          className="rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-surface-hover"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="grid grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28 rounded-2xl" />
        ))}
        <Skeleton className="col-span-3 mt-4 h-96 rounded-2xl" />
      </div>
    );
  }

  const filtered = filter.trim()
    ? library.filter((row) => row.title.toLowerCase().includes(filter.trim().toLowerCase()))
    : library;

  return (
    <div>
      <div className="grid grid-cols-3 gap-4">
        <Card className="flex items-center gap-4 p-5">
          <HardDrive className="h-6 w-6 text-accent" aria-hidden />
          <div>
            <p className="font-mono text-[11px] uppercase tracking-wider text-text-muted">Library size</p>
            <p className="mt-1 text-2xl font-semibold">{formatBytes(overview?.librarySizeBytes ?? 0)}</p>
          </div>
        </Card>
        <Card className="flex items-center gap-4 p-5">
          <Tv className="h-6 w-6 text-accent" aria-hidden />
          <div>
            <p className="font-mono text-[11px] uppercase tracking-wider text-text-muted">Series</p>
            <p className="mt-1 text-2xl font-semibold">{overview?.seriesCount ?? 0}</p>
          </div>
        </Card>
        <Card className="flex items-center gap-4 p-5">
          <Database className="h-6 w-6 text-accent" aria-hidden />
          <div>
            <p className="font-mono text-[11px] uppercase tracking-wider text-text-muted">NAS free</p>
            <p className="mt-1 text-2xl font-semibold">{formatBytes(overview?.freeBytes ?? 0)}</p>
          </div>
        </Card>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-base font-semibold">Library</h2>
        <span className="font-mono text-xs text-text-muted">{library.length} series</span>
      </div>

      <div className="relative mt-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden />
        <Input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter Sonarr library…"
          className="w-full pl-9"
        />
      </div>

      <Card className="mt-4 overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border font-mono text-[11px] uppercase tracking-wider text-text-muted">
              <th className="px-4 py-3 font-medium">Series</th>
              <th className="px-4 py-3 font-medium">Downloaded</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Monitor</th>
              <th className="px-4 py-3 font-medium">Episodes</th>
              <th className="px-4 py-3 text-right font-medium">Size</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3 text-text-primary">{row.title}</td>
                <td className="px-4 py-3 font-mono text-xs text-text-secondary">{row.addedLabel}</td>
                <td className={`px-4 py-3 text-xs ${DOWNLOAD_STATUS[row.downloadStatus]?.className ?? "text-text-secondary"}`}>
                  <span className="inline-flex items-center gap-2">
                    {row.downloadStatus === "missing"
                      ? `Missing · ${row.missingCount}`
                      : DOWNLOAD_STATUS[row.downloadStatus]?.label ?? "—"}
                    {row.downloadStatus === "missing" && (
                      <button
                        onClick={() => void fixSeries(row.id)}
                        disabled={fixingId === row.id}
                        aria-label={`Search missing episodes for ${row.title}`}
                        className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-text-primary transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Wrench className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                        {fixingId === row.id ? "Searching…" : "Fix"}
                      </button>
                    )}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                  {row.monitored ? "● MON" : "—"}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-text-secondary">{row.episodesLabel}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <span className="font-mono text-xs text-text-secondary">{formatBytes(row.sizeOnDisk)}</span>
                    <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-hover">
                      <div className="h-full rounded-full bg-accent/60" style={{ width: `${row.sizeRatio * 100}%` }} />
                    </div>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-text-muted">
                  No series match the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
