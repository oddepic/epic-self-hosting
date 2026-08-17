"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import Input from "@/components/ui/input";
import Skeleton from "@/components/ui/skeleton";
import type { LibraryItem } from "@/lib/services/library-service";
import type { SearchItem } from "@/lib/services/search-service";

const STATUS_LABELS: Record<string, string> = {
  watching: "Watching",
  completed: "Completed",
  plan_to_watch: "Planned",
  on_hold: "On Hold",
  dropped: "Dropped",
};

type AnimeStatus = "watching" | "completed" | "plan_to_watch" | "on_hold" | "dropped";

interface Section {
  status: AnimeStatus;
  count: number;
  items: LibraryItem[];
}

type ModalTarget = { animeId: number } | { item: SearchItem };

interface Props {
  onOpenAnime: (target: ModalTarget) => void;
  refreshSignal?: number;
}

export default function ListView({ onOpenAnime, refreshSignal }: Props) {
  const [search, setSearch] = useState("");
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [results, setResults] = useState<SearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());

    try {
      const res = await fetch(`/api/library?${params.toString()}`);
      if (res.ok) {
        const body = (await res.json()) as { sections: Section[] };
        setSections(body.sections);
      }
    } catch {
      // Transient failure; leave the current sections and let the next load retry.
    }
    setLoading(false);
  }, [search]);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load, refreshSignal]);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const term = search.trim();
    if (!term) {
      setResults([]);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
      if (res.ok) {
        const body = (await res.json()) as { items: SearchItem[] };
        setResults(body.items);
      }
      setSearching(false);
    }, 400);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search]);

  const totalCount = useMemo(() => sections.reduce((sum, s) => sum + s.count, 0), [sections]);

  const items = useMemo(() => {
    if (selectedStatus == null) {
      return sections.flatMap((s) => s.items);
    }
    return sections.find((s) => s.status === selectedStatus)?.items ?? [];
  }, [sections, selectedStatus]);

  const libraryAnilistIds = useMemo(
    () => new Set(sections.flatMap((s) => s.items).map((a) => a.anilistId)),
    [sections],
  );

  const sidebarItems = [
    { key: null, label: "All Anime", count: totalCount },
    ...sections.map((s) => ({ key: s.status, label: STATUS_LABELS[s.status], count: s.count })),
  ];

  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden />
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by title..."
          className="w-full pl-9"
        />
      </div>

      <div className="mt-6 flex gap-8">
        <aside className="w-56 shrink-0">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-text-muted">
            Status
          </p>
          <nav className="mt-3 flex flex-col gap-0.5">
            {sidebarItems.map((item) => (
              <button
                key={item.key ?? "all"}
                onClick={() => setSelectedStatus(item.key)}
                className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  selectedStatus === item.key
                    ? "bg-accent-soft text-accent"
                    : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                }`}
              >
                <span>{item.label}</span>
                <span className="font-mono text-xs text-text-muted">{item.count}</span>
              </button>
            ))}
          </nav>

          <div className="mt-10">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-text-muted">
              Stats
            </p>
            <div className="mt-3 flex items-center justify-between px-3">
              <span className="text-sm text-text-secondary">Total titles</span>
              <span className="font-mono text-xs text-text-muted">{totalCount}</span>
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          {loading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <Skeleton key={i} className="aspect-[2/3] rounded-xl" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="mt-8 text-text-muted">No anime in this view.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
              {items.map((anime) => (
                <button
                  key={anime.id}
                  onClick={() => onOpenAnime({ animeId: anime.id })}
                  className="group flex flex-col text-left transition-transform duration-200 hover:-translate-y-0.5"
                >
                  <div className="relative aspect-[2/3] overflow-hidden rounded-xl border border-border bg-surface">
                    {anime.coverImageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={anime.coverImageUrl}
                        alt={anime.titleEnglish ?? anime.titleRomaji}
                        className="h-full w-full object-cover transition-opacity duration-200 group-hover:opacity-90"
                      />
                    )}
                    <span className="absolute left-1.5 top-1.5 rounded-full bg-background/80 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-text-secondary backdrop-blur-sm">
                      {STATUS_LABELS[anime.status]}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs font-medium text-text-primary">
                    {anime.titleEnglish ?? anime.titleRomaji}
                  </p>
                  <p className="mt-0.5 line-clamp-1 font-mono text-[11px] text-text-muted">
                    {[anime.format, anime.seasonYear, anime.episodeCount ? `${anime.episodeCount} eps` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </button>
              ))}
            </div>
          )}

          {search.trim() !== "" && (
            <section className="mt-10">
              <h3 className="text-base font-semibold text-text-primary">
                Add new{searching ? "…" : ` — results for "${search.trim()}"`}
              </h3>
              {searching ? (
                <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="aspect-[2/3] rounded-xl" />
                  ))}
                </div>
              ) : results.length === 0 ? (
                <p className="mt-4 text-text-muted">No results on AniList.</p>
              ) : (
                <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
                  {results.map((item) => (
                    <button
                      key={item.anilistId}
                      onClick={() => {
                        const inLibrary = sections
                          .flatMap((s) => s.items)
                          .find((a) => a.anilistId === item.anilistId);
                        if (inLibrary) onOpenAnime({ animeId: inLibrary.id });
                        else onOpenAnime({ item });
                      }}
                      className="group flex flex-col text-left transition-transform duration-200 hover:-translate-y-0.5"
                    >
                      <div className="relative aspect-[2/3] overflow-hidden rounded-xl border border-border bg-surface">
                        {item.coverImageUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.coverImageUrl}
                            alt={item.title}
                            className="h-full w-full object-cover transition-opacity duration-200 group-hover:opacity-90"
                          />
                        )}
                        {libraryAnilistIds.has(item.anilistId) && (
                          <span className="absolute left-1.5 top-1.5 rounded-full bg-background/80 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-text-secondary backdrop-blur-sm">
                            In library
                          </span>
                        )}
                      </div>
                      <p className="mt-2 line-clamp-2 text-xs font-medium text-text-primary">{item.title}</p>
                      <p className="mt-0.5 line-clamp-1 font-mono text-[11px] text-text-muted">
                        {[item.format, item.seasonYear, item.episodeCount ? `${item.episodeCount} eps` : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
