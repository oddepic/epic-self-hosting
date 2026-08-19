"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/layout/app-shell";
import type { AppView } from "@/components/layout/navigation";
import AnimeView from "@/components/views/anime-view";
import ListView from "@/components/views/list-view";
import SonarrView from "@/components/views/sonarr-view";
import DownloadsView from "@/components/views/downloads-view";
import SettingsView from "@/components/views/settings-view";
import AnimeDetailModal from "@/components/media/anime-detail-modal";
import type { SearchItem } from "@/lib/services/search-service";

type ModalTarget = { animeId: number } | { item: SearchItem };

export default function Home() {
  const [view, setView] = useState<AppView>("anime");
  const [modal, setModal] = useState<ModalTarget | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [sonarrMissing, setSonarrMissing] = useState(false);

  // Missing-status polling lives at the app level so the Sonarr red dot stays
  // current regardless of the active tab (the Sonarr view only mounts when it
  // is selected, which would leave the dot stale everywhere else).
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/sonarr/library");
        if (res.ok) {
          const body = (await res.json()) as { library: { missingCount: number }[] };
          if (active) setSonarrMissing(body.library.some((row) => row.missingCount > 0));
        }
      } catch {
        // Keep the last known state; the next interval tick retries.
      }
    };
    void tick();
    const timer = setInterval(tick, 20_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("availability-updated", () => setRefresh((r) => r + 1));
    return () => es.close();
  }, []);

  async function onRefresh() {
    setRefreshing(true);
    setRefreshed(false);
    try {
      await fetch("/api/library/sync", { method: "POST" });
    } catch {
      // The view still reloads below even if the sync fails.
    }
    setRefresh((r) => r + 1);
    setRefreshing(false);
    setRefreshed(true);
    setTimeout(() => setRefreshed(false), 1800);
  }

  return (
    <AppShell
      active={view}
      onNavigate={setView}
      onRefresh={onRefresh}
      refreshing={refreshing}
      refreshed={refreshed}
      sonarrAlert={sonarrMissing}
    >
      {view === "anime" && (
        <AnimeView onOpenAnime={(id) => setModal({ animeId: id })} refreshSignal={refresh} />
      )}
      {view === "list" && (
        <ListView onOpenAnime={(target) => setModal(target)} refreshSignal={refresh} />
      )}
      {view === "sonarr" && <SonarrView refreshSignal={refresh} />}
      {view === "downloads" && <DownloadsView refreshSignal={refresh} />}
      {view === "settings" && <SettingsView refreshSignal={refresh} />}

      {modal && (
        <AnimeDetailModal
          {...modal}
          onClose={() => setModal(null)}
          onChanged={() => setRefresh((r) => r + 1)}
        />
      )}
    </AppShell>
  );
}
