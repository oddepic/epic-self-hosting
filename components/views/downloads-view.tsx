"use client";

import { useEffect, useState } from "react";
import { Download, Import } from "lucide-react";
import Button from "@/components/ui/button";
import Card from "@/components/ui/card";
import Progress from "@/components/ui/progress";
import Skeleton from "@/components/ui/skeleton";

interface DownloadItem {
  animeId: number;
  animeTitle: string;
  filesDownloaded: number;
  totalEpisodes: number;
  percent: number;
  state: string;
  downloadClient: string | null;
  error: string | null;
}

interface PendingImportItem {
  path: string;
  name: string;
  seriesId: number;
  seriesTitle: string;
  episodeIds: number[];
  episodeLabel: string;
  quality: unknown;
  qualityName: string | null;
  languages: unknown[];
  languageNames: string[];
  releaseGroup: string | null;
  size: number;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function DownloadsView({ refreshSignal }: { refreshSignal?: number }) {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [pending, setPending] = useState<PendingImportItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [importing, setImporting] = useState(false);

  async function load() {
    try {
      const [downloadsRes, importRes] = await Promise.all([
        fetch("/api/downloads"),
        fetch("/api/sonarr/import"),
      ]);
      if (downloadsRes.ok) {
        const body = (await downloadsRes.json()) as { items: DownloadItem[] };
        setItems(body.items);
      }
      if (importRes.ok) {
        const body = (await importRes.json()) as { items: PendingImportItem[] };
        setPending(body.items);
      }
    } catch {
      // Transient failure; the 10s interval retries.
    }
    setLoaded(true);
  }

  async function onImport() {
    setImporting(true);
    try {
      const res = await fetch("/api/sonarr/import", { method: "POST" });
      if (res.ok) void load();
    } finally {
      setImporting(false);
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [refreshSignal]);

  if (!loaded) {
    return (
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {pending.length > 0 && (
        <Card className="p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-text-primary">Downloaded, awaiting import</p>
              <p className="mt-0.5 text-sm text-text-muted">
                {pending.length} {pending.length === 1 ? "file" : "files"} downloaded but not imported by Sonarr.
              </p>
            </div>
            <Button variant="primary" onClick={() => void onImport()} disabled={importing}>
              <Import className="mr-2 inline h-4 w-4" aria-hidden />
              {importing ? "Importing…" : `Import ${pending.length}`}
            </Button>
          </div>
          <div className="mt-3 divide-y divide-border">
            {pending.map((item) => (
              <div key={item.path} className="flex items-center justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text-primary">{item.seriesTitle}</p>
                  <p className="truncate font-mono text-[11px] uppercase tracking-wider text-text-muted">
                    {item.episodeLabel} · {item.qualityName ?? "Unknown"} · {item.name}
                  </p>
                </div>
                <p className="shrink-0 font-mono text-xs text-text-secondary">{formatSize(item.size)}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <Download className="h-8 w-8 text-text-muted" aria-hidden />
          <p className="text-lg font-medium">No downloads</p>
          <p className="text-sm text-text-muted">There are currently no active downloads.</p>
        </div>
      ) : (
        items.map((item) => (
          <Card key={item.animeId} className="p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-medium text-text-primary">{item.animeTitle}</p>
                <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-text-muted">
                  Downloading{item.totalEpisodes > 0 ? ` · ${item.filesDownloaded}/${item.totalEpisodes} episodes` : ""}
                </p>
              </div>
              <p className="font-mono text-sm text-text-secondary">{item.percent}%</p>
            </div>
            <Progress value={item.percent} className="mt-3" />
            {item.error && <p className="mt-2 text-sm text-danger">{item.error}</p>}
          </Card>
        ))
      )}
    </div>
  );
}
