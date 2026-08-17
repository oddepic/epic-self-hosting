"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import Button from "@/components/ui/button";
import Skeleton from "@/components/ui/skeleton";
import MediaCard, { MediaRow } from "@/components/media/media-card";
import type {
  ContinueWatchingItem,
  UpcomingItem,
  WatchingItem,
} from "@/lib/services/dashboard-service";

function formatAiringDate(timestamp: number): string {
  const date = new Date(timestamp);
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${dd}/${mm} - ${time}`;
}

export default function AnimeView({
  onOpenAnime,
  refreshSignal,
}: {
  onOpenAnime: (animeId: number) => void;
  refreshSignal?: number;
}) {
  const router = useRouter();
  const [continueWatching, setContinueWatching] = useState<ContinueWatchingItem[]>([]);
  const [watching, setWatching] = useState<WatchingItem[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/dashboard");
    if (res.ok) {
      const body = await res.json() as {
        continueWatching: ContinueWatchingItem[];
        watching: WatchingItem[];
        upcoming: UpcomingItem[];
      };
      setContinueWatching(body.continueWatching);
      setWatching(body.watching);
      setUpcoming(body.upcoming);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const hero = continueWatching[0] ?? null;
  const heroBackground = hero?.backdropUrl ?? hero?.coverImageUrl ?? null;

  return (
    <div>
      {!loaded ? (
        <div>
          <Skeleton className="h-[400px] w-full rounded-2xl" />
          <Skeleton className="mt-10 h-5 w-40" />
          <div className="mt-4 flex gap-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-56 w-36 shrink-0 rounded-xl" />
            ))}
          </div>
        </div>
      ) : hero ? (
        <div className="relative h-[400px] overflow-hidden rounded-2xl border border-border lg:h-[430px]">
          <div
            className="absolute inset-0 bg-cover bg-no-repeat"
            style={heroBackground ? { backgroundImage: `url(${heroBackground})` } : undefined}
          />
          <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(13,11,18,0.95),rgba(13,11,18,0.4)_50%,transparent)]" />
          <div className="absolute inset-x-0 bottom-0 max-w-2xl p-8 lg:p-12">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-accent">
              Now watching
            </p>
            <h2 className="mt-3 text-3xl font-semibold text-text-primary lg:text-4xl">
              {hero.animeTitle}
            </h2>
            <p className="mt-1.5 text-sm">
              <span className="font-mono text-text-secondary">{hero.label}</span>
              {hero.episodeTitle && (
                <>
                  <span className="text-text-secondary"> · </span>
                  <span className="font-medium text-text-primary">{hero.episodeTitle}</span>
                </>
              )}
            </p>
            <Button
              variant="primary"
              className="mt-6 px-5 py-2.5"
              onClick={() => router.push(`/watch/${hero.episodeId}`)}
            >
              <Play className="mr-2 inline h-4 w-4" fill="currentColor" strokeWidth={0} aria-hidden />
              {hero.progressSeconds > 0
                ? `Resume EP ${hero.episodeNumber}`
                : `Start EP ${hero.episodeNumber}`}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <p className="text-lg font-medium">Nothing in progress</p>
          <p className="text-sm text-text-muted">Episodes you start watching will show up here.</p>
        </div>
      )}

      {continueWatching.length > 1 && (
        <MediaRow title="Continue Watching">
          {continueWatching.map((item) => (
            <MediaCard
              key={item.episodeId}
              imageUrl={item.coverImageUrl}
              title={item.animeTitle}
              subtitle={item.episodeTitle ? `${item.label} · ${item.episodeTitle}` : item.label}
              progress={item.durationSeconds ? (item.progressSeconds / item.durationSeconds) * 100 : null}
              onClick={() => router.push(`/watch/${item.episodeId}`)}
            />
          ))}
        </MediaRow>
      )}

      {watching.length > 0 && (
        <MediaRow title="Watching">
          {watching.map((anime) => (
            <MediaCard
              key={anime.id}
              imageUrl={anime.coverImageUrl}
              title={anime.titleEnglish ?? anime.titleRomaji}
              subtitle={[anime.format, anime.seasonYear, anime.episodeCount ? `${anime.episodeCount} eps` : null]
                .filter(Boolean)
                .join(" · ")}
              badge="Watching"
              onClick={() => onOpenAnime(anime.id)}
            />
          ))}
        </MediaRow>
      )}

      {upcoming.length > 0 && (
        <div className="mt-10">
          <h3 className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-text-muted">
            Upcoming episodes
          </h3>
          <div className="mt-3 overflow-hidden rounded-xl border border-border">
            {upcoming.map((item, index) => (
              <div key={item.animeId} className={index > 0 ? "border-t border-border" : ""}>
                <div className="flex items-baseline gap-3 px-4 py-2.5">
                  <button
                    onClick={() => onOpenAnime(item.animeId)}
                    className="min-w-0 shrink-0 max-w-[60%] truncate text-left text-sm text-text-primary transition-colors hover:text-accent"
                  >
                    {item.titleEnglish ?? item.titleRomaji}
                  </button>
                  <span className="min-w-4 flex-1 border-t border-border" aria-hidden />
                  <span className="shrink-0 font-mono text-xs text-text-secondary">
                    {formatAiringDate(item.nextEpisodeAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


