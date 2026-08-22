"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCheck, ChevronDown, Download, Loader2, Play, X } from "lucide-react";
import Button from "@/components/ui/button";
import { usePlayer } from "@/components/player/player-provider";
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

// MAL's score scale with its descriptive labels.
const MAL_SCORES: { value: number; label: string }[] = [
  { value: 0, label: "No score" },
  { value: 10, label: "10 - Masterpiece" },
  { value: 9, label: "9 - Great" },
  { value: 8, label: "8 - Very Good" },
  { value: 7, label: "7 - Good" },
  { value: 6, label: "6 - Fine" },
  { value: 5, label: "5 - Average" },
  { value: 4, label: "4 - Bad" },
  { value: 3, label: "3 - Very Bad" },
  { value: 2, label: "2 - Horrible" },
  { value: 1, label: "1 - Appalling" },
];

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
  const { play } = usePlayer();
  const [detail, setDetail] = useState<AnimeDetail | null>(null);
  const [progressInput, setProgressInput] = useState("");
  // Start from the persisted season (if any) so the very first fetch already
  // targets the right season instead of flashing the default one.
  const [season, setSeason] = useState<number | undefined>(() => {
    if (animeId == null) return undefined;
    try {
      const saved = localStorage.getItem(`epic-modal-season:${animeId}`);
      return saved != null && saved !== "" ? Number(saved) : undefined;
    } catch {
      return undefined;
    }
  });
  // Specials visibility in the season dropdown is a persisted user setting
  // (Settings > Library > Show specials seasons).
  const [showSpecials, setShowSpecials] = useState(false);
  // MAL-only entries have no episode rows (nothing was ever downloaded or
  // synced); this reveals a virtual list built from the entry's episodeCount
  // so episodes stay visible and markable before the series is added.
  const [showVirtualEpisodes, setShowVirtualEpisodes] = useState(false);
  const loadGenerationRef = useRef(0);
  const [changingStatus, setChangingStatus] = useState(false);
  const [fetchingMissing, setFetchingMissing] = useState(false);
  // Per-episode fetch in flight (Bug 06 Problem 5 follow-up).
  const [fetchingEpisodeIds, setFetchingEpisodeIds] = useState<number[]>([]);
  // Episodes whose search was requested this session. They STAY locked
  // (spinner + "Searching…") until actually available — the API returns as
  // soon as Sonarr ACCEPTS the search, long before the download finishes.
  const [requestedEpisodeIds, setRequestedEpisodeIds] = useState<number[]>([]);
  const [addState, setAddState] = useState<{
    phase: "checking" | "confirm" | "added";
    candidates: SonarrCandidate[] | null;
    picked: SonarrCandidate | null;
    monitor: MonitorOption;
    error: string | null;
  } | null>(null);

  const load = useCallback(async () => {
    if (animeId == null) return;
    // A season restore can fire a second fetch before the first resolves;
    // discard responses from superseded requests so the default-season
    // payload can never overwrite the restored season's episodes.
    const generation = ++loadGenerationRef.current;
    const res = await fetch(
      `/api/library/detail?animeId=${animeId}${season != null ? `&season=${season}` : ""}`,
    );
    if (generation !== loadGenerationRef.current) return;
    if (res.ok) {
      const body = (await res.json()) as { detail: AnimeDetail };
      if (generation !== loadGenerationRef.current) return;
      setDetail(body.detail);
    }
  }, [animeId, season]);

  useEffect(() => {
    if (animeId != null) void load();
  }, [load, animeId]);

  // Pull each franchise member's current MAL state when it becomes relevant
  // (the clicked entry on open, plus the entry bound to the displayed season
  // when the user switches seasons). Once per entry per modal session.
  const malSyncedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (animeId == null) return;
    const ids = [animeId, ...(detail?.selectedEntryId != null ? [detail.selectedEntryId] : [])].filter(
      (id) => !malSyncedRef.current.has(id),
    );
    if (ids.length === 0) return;
    for (const id of ids) malSyncedRef.current.add(id);
    void (async () => {
      let syncedAny = false;
      await Promise.all(
        ids.map(async (id) => {
          try {
            const response = await fetch("/api/library/mal-sync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ animeId: id }),
            });
            if (response.ok) {
              const body = (await response.json()) as { synced?: boolean };
              if (body.synced) syncedAny = true;
            }
          } catch {
            // Keep local detail data when MAL is unavailable.
          }
        }),
      );
      if (syncedAny) void load();
    })();
  }, [animeId, detail?.selectedEntryId, load]);

  // Load the persisted specials setting when the modal opens for an entry.
  useEffect(() => {
    if (animeId == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/settings/library");
        if (!res.ok) return;
        const body = (await res.json()) as { showSpecials?: boolean };
        if (!cancelled) setShowSpecials(body.showSpecials === true);
      } catch {
        // Keep the default (hidden) when the settings call fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [animeId]);

  // The lazy initializer only covers the first mount; when the modal switches
  // to a different anime while mounted, restore that anime's persisted season.
  useEffect(() => {
    if (animeId == null) return;
    try {
      const saved = localStorage.getItem(`epic-modal-season:${animeId}`);
      setSeason(saved != null && saved !== "" ? Number(saved) : undefined);
    } catch {
      setSeason(undefined);
    }
    // Leaving the entry hides any revealed virtual list.
    setShowVirtualEpisodes(false);
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

  // Franchise modal: header controls bind to the ENTRY that owns the displayed
  // season (each season keeps its own MAL status/score/progress); specials
  // belong to no entry and fall back to the clicked one.
  const selectedMember = detail?.members.find((m) => m.id === detail.selectedEntryId) ?? null;

  const seasonEpisodes = detail?.episodes ?? [];
  const progressCount = selectedMember?.watchedEpisodes ?? 0;
  const entryTotal = selectedMember?.episodeCount ?? null;

  // Displayed season: explicit pick ?? server default (the entry's mapped
  // season ?? resume ?? first with content).
  const displayedSeasonNumber =
    season ?? detail?.selectedSeasonNumber ?? detail?.resume?.seasonNumber ?? detail?.seasons[0]?.number ?? null;
  const selectedSeasonSummary =
    detail?.seasons.find((s) => s.number === displayedSeasonNumber) ?? null;

  // An episode reads as "watched" when its flag is set OR when the owning
  // entry's counter covers it. Uses the stored entry↔season mapping (the
  // member's entrySeasonNumber) — mirroring episode-service.
  const isWatched = (episode: {
    watched: boolean;
    episodeNumber: number;
    absoluteNumber: number | null;
  }): boolean => {
    if (episode.watched) return true;
    if (selectedMember == null) return false;
    if (entryTotal != null) {
      if (selectedMember.entrySeasonNumber != null && selectedMember.entrySeasonNumber === displayedSeasonNumber) {
        return episode.episodeNumber <= Math.min(progressCount, entryTotal);
      }
      return false;
    }
    return episode.absoluteNumber != null && episode.absoluteNumber <= progressCount;
  };

  // Virtual episode rows for entries with no Sonarr link: Sonarr never synced
  // rows for them, so placeholders are built from the entry's episodeCount.
  // The counter is the only stored truth here, watched simply reads as
  // "position reached". Only offered when the displayed member is MAL-only;
  // added franchises get real rows from Sonarr sync instead.
  const virtualEpisodeTotal =
    !newAnime &&
    detail != null &&
    selectedMember != null &&
    selectedMember.sonarrId == null &&
    detail.episodes.length === 0 &&
    (selectedMember.episodeCount ?? 0) > 0
      ? selectedMember.episodeCount!
      : null;
  const virtualEpisodes: AnimeDetail["episodes"] | null =
    virtualEpisodeTotal != null
      ? Array.from({ length: virtualEpisodeTotal }, (_, i) => ({
          id: -(i + 1),
          episodeNumber: i + 1,
          absoluteNumber: null,
          title: null,
          thumbnailUrl: null,
          available: false,
          watched: false,
          progressSeconds: 0,
          durationSeconds: null,
        }))
      : null;
  const nextUnwatched = seasonEpisodes.find((e) => !isWatched(e)) ?? null;
  const showProgress =
    selectedMember != null && !newAnime && selectedMember.status !== "completed" && selectedMember.status !== "plan_to_watch";

  // Per-season download for an added franchise (Bug 06 Problem 5): the season
  // has un-downloaded episodes and the entry is linked to Sonarr.
  const canGetMissing =
    selectedMember?.sonarrId != null &&
    selectedSeasonSummary != null &&
    selectedSeasonSummary.totalCount > 0 &&
    selectedSeasonSummary.availableCount < selectedSeasonSummary.totalCount;

  async function onGetMissing() {
    const seriesId = selectedMember?.sonarrId;
    if (seriesId == null || displayedSeasonNumber == null) return;
    setFetchingMissing(true);
    try {
      await fetch("/api/sonarr/search-season", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesId, season: displayedSeasonNumber }),
      });
    } catch {
      // The view still reloads below; Sonarr failures surface on next poll.
    }
    setFetchingMissing(false);
    void load();
    onChanged();
  }

  async function onFetchEpisode(episodeId: number) {
    if (fetchingEpisodeIds.includes(episodeId) || requestedEpisodeIds.includes(episodeId)) return;
    setRequestedEpisodeIds((ids) => [...ids, episodeId]);
    setFetchingEpisodeIds((ids) => [...ids, episodeId]);
    try {
      await fetch("/api/sonarr/search-episode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId }),
      });
    } catch {
      // Keep the lock; the user can retry after reopening if Sonarr failed.
    }
    setFetchingEpisodeIds((ids) => ids.filter((id) => id !== episodeId));
    void load();
  }

  useEffect(() => {
    setProgressInput(String(progressCount));
  }, [progressCount]);

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

  // The whole header — hero, title, romaji, metadata — belongs to the entry
  // that owns the displayed season, so switching seasons swaps everything.
  const heroImage = newAnime
    ? newAnime.bannerImageUrl ?? newAnime.coverImageUrl
    : selectedMember?.bannerImageUrl ??
      selectedMember?.coverImageUrl ??
      anime?.bannerImageUrl ??
      anime?.coverImageUrl ??
      null;
  const primary = detail ? (detail.resume ?? detail.start) : null;
  const metadata = newAnime
    ? [
        newAnime.format,
        newAnime.seasonYear ? String(newAnime.seasonYear) : null,
        newAnime.episodeCount ? `${newAnime.episodeCount} eps` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : selectedMember
      ? [
          selectedMember.format,
          selectedMember.seasonYear ? String(selectedMember.seasonYear) : null,
          selectedMember.episodeCount ? `${selectedMember.episodeCount} eps` : null,
          STATUS_LABELS[selectedMember.status],
        ]
          .filter(Boolean)
          .join(" · ")
      : "";

  async function onChangeStatus(status: string, targetAnimeId?: number) {
    const id = targetAnimeId ?? animeId;
    if (id == null) return;
    setChangingStatus(true);
    const res = await fetch("/api/library/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ animeId: id, status }),
    });
    setChangingStatus(false);
    if (res.ok) {
      void load();
      onChanged();
    }
  }

  async function onChangeScore(score: number, targetAnimeId?: number) {
    const id = targetAnimeId ?? animeId;
    if (id == null) return;
    setChangingStatus(true);
    const res = await fetch("/api/library/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ animeId: id, score }),
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

  async function onCommitProgress(value: string) {
    const id = selectedMember?.id ?? animeId;
    if (id == null) return;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < 0) {
      setProgressInput(String(progressCount));
      return;
    }
    const clamped = entryTotal != null ? Math.min(n, entryTotal) : Math.min(n, 99_999);
    if (clamped === progressCount) {
      setProgressInput(String(progressCount));
      return;
    }
    // Sync the viewed season's flags up to the counter when the season has
    // that many episodes; the counter itself is always set exactly.
    const flagNumber = Math.min(clamped, seasonEpisodes.length);
    const flagTarget = seasonEpisodes.find((e) => e.episodeNumber === flagNumber) ?? null;
    const res = await fetch("/api/episodes/set-watched", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        animeId: id,
        watchedEpisodes: clamped,
        ...(flagTarget ? { episodeId: flagTarget.id } : {}),
      }),
    });
    if (res.ok) {
      void load();
      onChanged();
    } else {
      setProgressInput(String(progressCount));
    }
  }

  // Virtual-row picking writes the entry counter directly (no flags exist):
  // single check advances to the clicked position (never rewinds),
  // unmark rewinds to just below the clicked row, double-check sets exactly N
  // (it may rewind, mirroring setWatchedThrough on real flags).
  async function onSetCounter(next: number) {
    const id = selectedMember?.id;
    if (id == null) return;
    const res = await fetch("/api/episodes/set-watched", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ animeId: id, watchedEpisodes: next }),
    });
    if (res.ok) {
      void load();
      onChanged();
    }
  }


  // Virtual list for not-added entries: same row geometry minus thumbnail,
  // play, and download actions. Check / double-check / unmark write the entry
  // counter through set-watched; there are no flags, so status reads purely
  // from the position.
  function renderVirtualEpisodes() {
    if (!virtualEpisodes) return null;
    return virtualEpisodes.map((episode) => {
      const watched = progressCount >= episode.episodeNumber;
      return (
        <div key={episode.id} className="flex items-center gap-3 border-b border-border px-6 py-3">
          <div className="h-14 w-24 shrink-0 rounded-lg bg-surface-hover" />
          <span className="w-10 shrink-0 font-mono text-sm font-semibold text-accent">
            {String(episode.episodeNumber).padStart(2, "0")}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-text-primary">Episode {episode.episodeNumber}</p>
            <p className="text-xs text-text-muted">{watched ? "Watched" : "Not downloaded"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              title={watched ? `Unmark EP ${episode.episodeNumber}` : `Mark EP ${episode.episodeNumber} watched`}
              aria-label={`Toggle episode ${episode.episodeNumber} watched`}
              onClick={(e) => {
                e.stopPropagation();
                void (watched
                  ? onSetCounter(Math.max(0, Math.min(progressCount, episode.episodeNumber - 1)))
                  : onSetCounter(Math.max(progressCount, episode.episodeNumber)));
              }}
              className={`rounded-lg p-1.5 transition-colors ${
                watched ? "text-success" : "text-text-muted hover:bg-surface-hover hover:text-success"
              }`}
            >
              <Check className="h-4 w-4" aria-hidden />
            </button>
            <button
              title={watched ? `Unmark through EP ${episode.episodeNumber}` : `Mark through EP ${episode.episodeNumber} watched`}
              aria-label={`Set watched count to ${episode.episodeNumber}`}
              onClick={(e) => {
                e.stopPropagation();
                void onSetCounter(episode.episodeNumber);
              }}
              className={`rounded-lg p-1.5 transition-colors ${
                watched ? "text-success" : "text-text-muted hover:bg-surface-hover hover:text-success"
              }`}
            >
              <CheckCheck className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      );
    });
  }

  async function onMarkNext() {
    if (!nextUnwatched) return;
    const res = await fetch("/api/episodes/watched", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodeId: nextUnwatched.id }),
    });
    if (res.ok) {
      void load();
      onChanged();
    }
  }

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
                : selectedMember?.titleEnglish ?? selectedMember?.titleRomaji ?? anime?.titleEnglish ?? anime?.titleRomaji}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {newAnime?.romajiTitle ?? selectedMember?.titleRomaji ?? anime?.titleRomaji}
            </p>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-text-muted">{metadata}</p>
            <div className="mt-3 flex items-center gap-3">
              {primary && (
                <Button
                  variant="primary"
                  onClick={() => {
                    onClose();
                    void play(primary.episodeId);
                  }}
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
              {selectedMember && !newAnime && (
                <>
                  <select
                    name="status"
                    value={selectedMember.status}
                    onChange={(e) => void onChangeStatus(e.target.value, selectedMember.id)}
                    disabled={changingStatus}
                    className="rounded-lg border border-border bg-surface-raised px-2 py-1.5 text-xs text-text-primary disabled:opacity-50"
                  >
                    {STATUS_ORDER.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                  <span className="text-text-muted/60" aria-hidden>|</span>
                  <select
                    name="score"
                    value={selectedMember.score ?? 0}
                    onChange={(e) => void onChangeScore(Number(e.target.value), selectedMember.id)}
                    disabled={changingStatus}
                    aria-label="Score"
                    className="rounded-lg border border-border bg-surface-raised px-2 py-1.5 text-xs text-text-primary disabled:opacity-50"
                  >
                    {MAL_SCORES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  {showProgress && (
                    <>
                      <span className="text-text-muted/60" aria-hidden>|</span>
                      <div className="flex items-center gap-1">
                        <div className="flex items-center rounded-lg border border-border bg-surface-raised px-2 py-1.5">
                          <input
                            type="number"
                            min={0}
                            max={entryTotal ?? 99_999}
                            value={progressInput}
                            onChange={(e) => setProgressInput(e.target.value)}
                            onBlur={(e) => void onCommitProgress(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                            aria-label="Watched episodes"
                            style={{
                              width: `calc(${Math.max(progressInput.length, 2)}ch)`,
                            }}
                            className="min-w-8 bg-transparent text-right font-mono text-xs text-text-primary outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          {entryTotal != null && (
                            <span className="ml-0.5 shrink-0 font-mono text-xs text-text-muted">
                              / {entryTotal}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => void onMarkNext()}
                          disabled={!nextUnwatched}
                          title="Mark next episode watched"
                          aria-label="Mark next episode watched"
                          className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm leading-none text-text-primary transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          +
                        </button>
                      </div>
                    </>
                  )}
                </>
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
                <SeasonSelect
                  seasons={detail.seasons}
                  value={displayedSeasonNumber}
                  onSelect={onPickSeason}
                  showSpecials={showSpecials}
                />
                {canGetMissing && (
                  <Button
                    variant="secondary"
                    onClick={() => void onGetMissing()}
                    disabled={fetchingMissing}
                  >
                    {fetchingMissing ? "Searching…" : "Get missing episodes"}
                  </Button>
                )}
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {detail && detail.episodes.length === 0 ? (
                virtualEpisodeTotal == null || !showVirtualEpisodes ? (
                  <p className="px-6 py-3 text-sm text-text-muted">
                    No episodes yet.
                    {virtualEpisodeTotal != null && (
                      <>
                        {' '}
                        <button
                          type="button"
                          onClick={() => setShowVirtualEpisodes(true)}
                          className="text-accent hover:underline"
                        >
                          Show episodes anyway
                        </button>
                      </>
                    )}
                  </p>
                ) : (
                  renderVirtualEpisodes()
                )
              ) : (
                detail &&
                detail.episodes.map((episode) => {
                  // Pending = request in flight, OR already requested this
                  // session and still not available (Sonarr accepted the
                  // search; the download takes minutes). Locked until the
                  // file exists.
                  const fetching =
                    fetchingEpisodeIds.includes(episode.id) ||
                    (!episode.available && requestedEpisodeIds.includes(episode.id));
                  return (
                  <div
                    key={episode.id}
                    className={`flex items-center gap-3 border-b border-border px-6 py-3 ${
                      episode.available ? "cursor-pointer transition-colors hover:bg-surface-hover" : ""
                    }`}
                    onClick={() => {
                      if (episode.available) {
                        onClose();
                        void play(episode.id);
                      }
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
                    <span className="w-10 shrink-0 font-mono text-sm font-semibold text-accent">
                      {episode.absoluteNumber != null
                        ? String(episode.absoluteNumber)
                        : String(episode.episodeNumber).padStart(2, "0")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-text-primary">{episode.title ?? `Episode ${episode.episodeNumber}`}</p>
                      <p className="text-xs text-text-muted">
                        {fetching
                          ? "Searching…"
                          : episodeStatusText({ ...episode, watched: isWatched(episode) })}
                      </p>
                    </div>
                    <span className="shrink-0 font-mono text-xs text-text-muted">
                      {formatDuration(episode.durationSeconds)}
                    </span>
                    {episode.available ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          title={isWatched(episode) ? `Unmark EP ${episode.episodeNumber}` : `Mark EP ${episode.episodeNumber} watched`}
                          aria-label={`Toggle episode ${episode.episodeNumber} watched`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void (episode.watched ? onUnwatch(episode.id) : onMarkWatched(episode.id));
                          }}
                          className={`rounded-lg p-1.5 transition-colors ${
                            isWatched(episode)
                              ? "text-success"
                              : "text-text-muted hover:bg-surface-hover hover:text-success"
                          }`}
                        >
                          <Check className="h-4 w-4" aria-hidden />
                        </button>
                        <button
                          title={isWatched(episode) ? `Unmark through EP ${episode.episodeNumber}` : `Mark through EP ${episode.episodeNumber} watched`}
                          aria-label={`Toggle all episodes up to ${episode.episodeNumber} watched`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void (episode.watched ? onUnwatchThrough(episode.id) : onMarkWatchedThrough(episode.id));
                          }}
                          className={`rounded-lg p-1.5 transition-colors ${
                            isWatched(episode)
                              ? "text-success"
                              : "text-text-muted hover:bg-surface-hover hover:text-success"
                          }`}
                        >
                          <CheckCheck className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                    ) : selectedMember?.sonarrId != null ? (
                      // Un-downloaded + linked to Sonarr: fetch this single
                      // episode. Disappears once the file exists (by any means).
                      <button
                        title={`Search & download EP ${episode.episodeNumber}`}
                        aria-label={`Search & download episode ${episode.episodeNumber}`}
                        disabled={fetching}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onFetchEpisode(episode.id);
                        }}
                        className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {fetching ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <Download className="h-4 w-4" aria-hidden />
                        )}
                      </button>
                    ) : null}
                  </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Custom season dropdown for the franchise modal: one list of every season in
// the franchise (specials labeled), with per-season download counts. A native
// select cannot carry the richer per-row labels. Specials are filtered out of
// the list unless showSpecials is set; a hidden specials season still renders
// as the trigger label when it is the displayed value.
function SeasonSelect({
  seasons,
  value,
  onSelect,
  showSpecials = false,
}: {
  seasons: Array<{ number: number; availableCount: number; totalCount: number; isSpecials: boolean }>;
  value: number | null;
  onSelect: (number_: number) => void;
  showSpecials?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const label = (season: { number: number; availableCount: number; totalCount: number; isSpecials: boolean }) =>
    `${season.isSpecials ? "Specials" : `Season ${season.number}`} · ${season.availableCount}/${season.totalCount} downloaded`;
  const current = seasons.find((s) => s.number === value) ?? null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-surface-hover"
      >
        <span>{current ? label(current) : "Select season"}</span>
        <ChevronDown className="h-4 w-4 text-text-muted" aria-hidden />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Seasons"
          className="absolute z-10 mt-1 max-h-72 w-64 overflow-y-auto rounded-lg border border-border bg-surface-raised py-1"
        >
          {seasons.filter((s) => showSpecials || !s.isSpecials).map((season) => (
            <button
              key={season.number}
              type="button"
              role="option"
              aria-selected={season.number === value}
              onClick={() => {
                onSelect(season.number);
                setOpen(false);
              }}
              className={`block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-surface-hover ${
                season.number === value ? "text-accent" : "text-text-secondary"
              }`}
            >
              {label(season)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


