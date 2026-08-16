"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CheckCheck, Play, X } from "lucide-react";
import Button from "@/components/ui/button";
import type { AnimeDetail } from "@/lib/services/anime-detail-service";
import type { SearchItem } from "@/lib/services/search-service";
import type { MonitorOption, SonarrCandidate } from "@/lib/integrations/types";

const STATUS_LABELS: Record<string, string> = {
  watching: "Watching",
  completed: "Completed",
  plan_to_watch: "Planned",
  on_hold: "On Hold",
  dropped: "Dropped",
};

const STATUS_ORDER = ["watching", "completed", "plan_to_watch", "on_hold", "dropped"] as const;

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "";
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function airsIn(nextEpisodeAt: number, now: number): string {
  const diffMs = nextEpisodeAt - now;
  if (diffMs < 24 * 60 * 60 * 1000) return "today";
  if (diffMs < 48 * 60 * 60 * 1000) return "tomorrow";
  return `in ${Math.ceil(diffMs / (24 * 60 * 60 * 1000))} days`;
}

function episodeStatusText(episode: { watched: boolean; available: boolean; progressSeconds: number; durationSeconds: number | null }): string {
  if (episode.watched) return "Watched";
  if (episode.progressSeconds > 0) {
    return episode.durationSeconds
      ? `${formatClock(episode.progressSeconds)} / ${formatClock(episode.durationSeconds)}`
      : "In progress";
  }
  return episode.available ? "Available" : "Not downloaded";
}

interface Props {
  animeId?: number | null;
  item?: SearchItem | null;
  onClose: () => void;
  onChanged: () => void;
}

export default function AnimeDetailModal({ animeId, item, onClose, onChanged }: Props) {
  const router = useRouter();
  const [now] = useState(() => Date.now());
  const [detail, setDetail] = useState<AnimeDetail | null>(null);
  const [season, setSeason] = useState<number | undefined>(undefined);
  const [changingStatus, setChangingStatus] = useState(false);
  const [addState, setAddState] = useState<{
    phase: "checking" | "confirm" | "added";
    candidates: SonarrCandidate[] | null;
    picked: SonarrCandidate | null;
    monitor: MonitorOption;
    error: string | null;
  } | null>(null);

  const load = useCallback(async () => {
    if (animeId == null) return;
    const res = await fetch(
      `/api/library/detail?animeId=${animeId}${season != null ? `&season=${season}` : ""}`,
    );
    if (res.ok) {
      const body = (await res.json()) as { detail: AnimeDetail };
      setDetail(body.detail);
    }
  }, [animeId, season]);

  useEffect(() => {
    if (animeId != null) void load();
  }, [load, animeId]);

  // Restore the last season this user viewed for this anime (persisted per
  // anime in localStorage); the default (resume/first season) applies when
  // nothing was saved.
  useEffect(() => {
    if (animeId == null) return;
    try {
      const saved = localStorage.getItem(`epic-modal-season:${animeId}`);
      setSeason(saved != null && saved !== "" ? Number(saved) : undefined);
    } catch {
      setSeason(undefined);
    }
  }, [animeId]);

  // Drop a stale saved season (e.g. the season list changed) so the select
  // falls back instead of showing a blank option.
  useEffect(() => {
    if (!detail || season == null) return;
    if (!detail.seasons.some((s) => s.number === season)) {
      setSeason(undefined);
    }
  }, [detail, season]);

  const onPickSeason = useCallback(
    (number: number) => {
      setSeason(number);
      if (animeId == null) return;
      try {
        localStorage.setItem(`epic-modal-season:${animeId}`, String(number));
      } catch {
        // Storage may be unavailable (private mode); the pick still applies
        // for this session.
      }
    },
    [animeId],
  );

  const newAnime = animeId == null ? item : null;
  const anime = detail?.anime ?? null;

  const addItem: SearchItem | null = useMemo(() => {
    if (newAnime) return newAnime;
    if (!anime) return null;
    return {
      anilistId: anime.anilistId,
      malId: anime.malId,
      title: anime.titleEnglish ?? anime.titleRomaji,
      romajiTitle: anime.titleRomaji,
      englishTitle: anime.titleEnglish,
      nativeTitle: anime.titleNative,
      synonyms: anime.synonyms,
      synopsis: anime.synopsis,
      coverImageUrl: anime.coverImageUrl,
      bannerImageUrl: anime.bannerImageUrl,
      genres: anime.genres,
      format: anime.format,
      seasonYear: anime.seasonYear,
      episodeCount: anime.episodeCount,
      nextEpisodeAt: anime.nextEpisodeAt,
    };
  }, [newAnime, anime]);

  if (!detail && !newAnime) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
        <div className="w-full max-w-3xl rounded-2xl border border-border bg-surface p-8 text-text-secondary">
          Loading…
        </div>
      </div>
    );
  }

  const heroImage = newAnime
    ? newAnime.bannerImageUrl ?? newAnime.coverImageUrl
    : anime?.bannerImageUrl ?? anime?.coverImageUrl ?? null;
  const primary = detail ? (detail.resume ?? detail.start) : null;
  const nextEpisodeAt = newAnime?.nextEpisodeAt ?? anime?.nextEpisodeAt ?? null;
  const metadata = newAnime
    ? [
        newAnime.format,
        newAnime.seasonYear ? String(newAnime.seasonYear) : null,
        newAnime.episodeCount ? `${newAnime.episodeCount} eps` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : anime
      ? [
          anime.format,
          anime.seasonYear ? String(anime.seasonYear) : null,
          anime.episodeCount ? `${anime.episodeCount} eps` : null,
          STATUS_LABELS[anime.status],
        ]
          .filter(Boolean)
          .join(" · ")
      : "";

  async function onChangeStatus(status: string) {
    if (animeId == null) return;
    setChangingStatus(true);
    const res = await fetch("/api/library/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ animeId, status }),
    });
    setChangingStatus(false);
    if (res.ok) {
      void load();
      onChanged();
    }
  }

  async function onMarkWatched(episodeId: number) {
    const res = await fetch("/api/episodes/watched", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodeId }),
    });
    if (res.ok) {
      void load();
      onChanged();
    }
  }

  async function onMarkWatchedThrough(episodeId: number) {
    const res = await fetch("/api/episodes/watched-through", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodeId }),
    });
    if (res.ok) {
      void load();
      onChanged();
    }
  }

  async function onUnwatch(episodeId: number) {
    const res = await fetch("/api/episodes/unwatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodeId }),
    });
    if (res.ok) {
      void load();
      onChanged();
    }
  }

  async function onUnwatchThrough(episodeId: number) {
    const res = await fetch("/api/episodes/unwatch-through", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodeId }),
    });
    if (res.ok) {
      void load();
      onChanged();
    }
  }

  async function onStartAdd() {
    if (!addItem) return;
    setAddState({ phase: "checking", candidates: null, picked: null, monitor: { type: "all" }, error: null });
    try {
      const res = await fetch("/api/library/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item: addItem }),
      });
      if (!res.ok) throw new Error("Lookup failed");
      const body = (await res.json()) as
        | { matched: true; candidate: SonarrCandidate; monitor?: MonitorOption }
        | { matched: false; candidates: SonarrCandidate[] };
      setAddState(
        body.matched
          ? { phase: "confirm", candidates: null, picked: body.candidate, monitor: body.monitor ?? { type: "all" }, error: null }
          : { phase: "confirm", candidates: body.candidates, picked: null, monitor: { type: "all" }, error: null },
      );
    } catch {
      setAddState({ phase: "confirm", candidates: null, picked: null, monitor: { type: "all" }, error: "Could not reach Sonarr." });
    }
  }

  async function onConfirmAdd() {
    if (!addItem || !addState?.picked) return;
    setAddState({ ...addState, phase: "checking", error: null });
    try {
      const res = await fetch("/api/library/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item: addItem, candidate: addState.picked, monitor: addState.monitor }),
      });
      if (!res.ok) throw new Error("Add failed");
      setAddState({ phase: "added", candidates: null, picked: null, monitor: { type: "all" }, error: null });
      onChanged();
    } catch {
      setAddState({ ...addState, phase: "confirm", error: "Sonarr rejected the add — it may already be in your library." });
    }
  }

  const MONITOR_OPTIONS: { key: MonitorOption["type"]; label: string }[] = [
    { key: "all", label: "All seasons" },
    { key: "firstSeason", label: "First season" },
    { key: "lastSeason", label: "Last season" },
    { key: "specificSeason", label: "Specific season…" },
    { key: "future", label: "Future episodes" },
    { key: "missing", label: "Missing episodes" },
    { key: "recent", label: "Recent episodes" },
  ];

  const derivedAddPhase: "hidden" | "added" | "idle" =
    newAnime != null
      ? "idle"
      : detail?.fullyDownloaded
        ? "hidden"
        : anime?.sonarrId != null
          ? "added"
          : "idle";

  const addPhase = addState?.phase ?? derivedAddPhase;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface">
        <div
          className="relative h-80 shrink-0 bg-cover bg-center"
          style={heroImage ? { backgroundImage: `url(${heroImage})` } : undefined}
        >
          <div className="absolute inset-0 bg-linear-to-t from-surface via-background/40 to-background/10" />
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-surface-raised text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
          <div className="absolute inset-x-0 bottom-0 p-6">
            <h1 className="text-2xl font-bold text-text-primary">
              {newAnime
                ? newAnime.title
                : anime?.titleEnglish ?? anime?.titleRomaji}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {newAnime?.romajiTitle ?? anime?.titleRomaji}
            </p>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-text-muted">{metadata}</p>
            {nextEpisodeAt != null && nextEpisodeAt > now && (
              <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-text-muted">
                Next episode · {airsIn(nextEpisodeAt, now)}
              </p>
            )}
            <div className="mt-3 flex items-center gap-3">
              {primary && (
                <Button
                  variant="primary"
                  onClick={() => router.push(`/watch/${primary.episodeId}`)}
                >
                  <Play className="mr-2 inline h-4 w-4" fill="currentColor" strokeWidth={0} aria-hidden />
                  {detail!.resume ? `Resume EP ${primary.episodeNumber}` : `Start EP ${primary.episodeNumber}`}
                </Button>
              )}
              {addPhase === "idle" && !addState && (
                <Button variant="primary" onClick={() => void onStartAdd()}>
                  Add to library
                </Button>
              )}
              {addPhase === "checking" && (
                <Button variant="primary" disabled>
                  Checking…
                </Button>
              )}
              {addPhase === "added" && (
                <Button variant="primary" disabled>
                  Added
                </Button>
              )}
              {anime && !newAnime && (
                <select
                  name="status"
                  value={anime.status}
                  onChange={(e) => void onChangeStatus(e.target.value)}
                  disabled={changingStatus}
                  className="rounded-lg border border-border bg-surface-raised px-2 py-1.5 text-xs text-text-primary disabled:opacity-50"
                >
                  {STATUS_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {newAnime?.synopsis && (
              <p className="mt-3 line-clamp-3 max-w-xl text-xs text-text-secondary">{newAnime.synopsis}</p>
            )}
          </div>
        </div>

        {addState?.phase === "confirm" && (
          <div className="border-b border-border px-6 py-4">
            {addState.error && <p className="text-sm text-danger">{addState.error}</p>}
            {addState.candidates ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-text-secondary">Pick the matching series:</p>
                {addState.candidates.map((candidate) => (
                  <button
                    key={candidate.tvdbId}
                    onClick={() => setAddState({ ...addState, picked: candidate, error: null })}
                    className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      addState.picked?.tvdbId === candidate.tvdbId
                        ? "border-accent bg-accent-soft text-text-primary"
                        : "border-border bg-surface text-text-secondary hover:bg-surface-hover"
                    }`}
                  >
                    {candidate.title} · {candidate.year ?? "?"} · {candidate.status ?? "?"}
                  </button>
                ))}
              </div>
            ) : (
              addState.picked && (
                <>
                  <p className="text-sm text-text-secondary">
                    Adding: {addState.picked.title} · {addState.picked.year ?? "?"} · {addState.picked.status ?? "?"}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <label className="text-xs text-text-muted">Monitor</label>
                    <select
                      value={addState.monitor.type}
                      onChange={(e) => {
                        const type = e.target.value as MonitorOption["type"];
                        if (type === "specificSeason") {
                          const seasons = addState.picked?.seasons ?? [];
                          const last = seasons.length ? seasons[seasons.length - 1]!.seasonNumber : 1;
                          setAddState({ ...addState, monitor: { type, season: last } });
                        } else {
                          setAddState({ ...addState, monitor: { type } });
                        }
                      }}
                      className="rounded-lg border border-border bg-surface-raised px-2 py-1.5 text-sm text-text-primary"
                    >
                      {MONITOR_OPTIONS.map((option) => (
                        <option key={option.key} value={option.key}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {addState.monitor.type === "specificSeason" && (
                      <select
                        value={addState.monitor.season}
                        onChange={(e) =>
                          setAddState({ ...addState, monitor: { type: "specificSeason", season: Number(e.target.value) } })
                        }
                        className="rounded-lg border border-border bg-surface-raised px-2 py-1.5 text-sm text-text-primary"
                      >
                        {[...addState.picked.seasons]
                          .sort((a, b) => a.seasonNumber - b.seasonNumber)
                          .map((season) => (
                            <option key={season.seasonNumber} value={season.seasonNumber}>
                              Season {season.seasonNumber}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                </>
              )
            )}
            <div className="mt-3 flex justify-end gap-2">
              <Button onClick={() => setAddState(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => void onConfirmAdd()}
                disabled={!addState.picked}
              >
                Confirm
              </Button>
            </div>
          </div>
        )}

        {newAnime ? (
          <div className="flex-1 overflow-y-auto p-6">
            <p className="text-sm text-text-muted">
              {newAnime.genres?.length ? newAnime.genres.join(" · ") : ""}
            </p>
          </div>
        ) : (
          <>
            {detail && detail.seasons.length > 0 && (
              <div className="flex items-center gap-2 border-b border-border px-6 py-3">
                <select
                  name="season"
                  value={season ?? detail.resume?.seasonNumber ?? detail.seasons[0]!.number}
                  onChange={(e) => onPickSeason(Number(e.target.value))}
                  className="rounded-lg border border-border bg-surface-raised px-2 py-1.5 text-sm text-text-primary"
                >
                  {detail.seasons.map((s) => (
                    <option key={s.number} value={s.number}>
                      Season {s.number} · {s.availableCount}/{s.totalCount} downloaded
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {detail && detail.episodes.length === 0 ? (
                <p className="p-6 text-sm text-text-muted">No episodes yet.</p>
              ) : (
                detail &&
                detail.episodes.map((episode) => (
                  <div
                    key={episode.id}
                    className={`flex items-center gap-3 border-b border-border px-6 py-3 ${
                      episode.available ? "cursor-pointer transition-colors hover:bg-surface-hover" : ""
                    }`}
                    onClick={() => {
                      if (episode.available) router.push(`/watch/${episode.id}`);
                    }}
                  >
                    {episode.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={episode.thumbnailUrl}
                        alt={episode.title ?? `Episode ${episode.episodeNumber}`}
                        className="h-14 w-24 shrink-0 rounded-lg object-cover"
                      />
                    ) : (
                      <div className="h-14 w-24 shrink-0 rounded-lg bg-surface-hover" />
                    )}
                    <span className="w-8 shrink-0 font-mono text-sm font-semibold text-accent">
                      {String(episode.episodeNumber).padStart(2, "0")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-text-primary">{episode.title ?? `Episode ${episode.episodeNumber}`}</p>
                      <p className="text-xs text-text-muted">{episodeStatusText(episode)}</p>
                    </div>
                    <span className="shrink-0 font-mono text-xs text-text-muted">
                      {formatDuration(episode.durationSeconds)}
                    </span>
                    {episode.available && (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          title={episode.watched ? `Unmark EP ${episode.episodeNumber}` : `Mark EP ${episode.episodeNumber} watched`}
                          aria-label={`Toggle episode ${episode.episodeNumber} watched`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void (episode.watched ? onUnwatch(episode.id) : onMarkWatched(episode.id));
                          }}
                          className={`rounded-lg p-1.5 transition-colors ${
                            episode.watched
                              ? "text-success"
                              : "text-text-muted hover:bg-surface-hover hover:text-success"
                          }`}
                        >
                          <Check className="h-4 w-4" aria-hidden />
                        </button>
                        <button
                          title={episode.watched ? `Unmark through EP ${episode.episodeNumber}` : `Mark through EP ${episode.episodeNumber} watched`}
                          aria-label={`Toggle all episodes up to ${episode.episodeNumber} watched`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void (episode.watched ? onUnwatchThrough(episode.id) : onMarkWatchedThrough(episode.id));
                          }}
                          className={`rounded-lg p-1.5 transition-colors ${
                            episode.watched
                              ? "text-success"
                              : "text-text-muted hover:bg-surface-hover hover:text-success"
                          }`}
                        >
                          <CheckCheck className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}


