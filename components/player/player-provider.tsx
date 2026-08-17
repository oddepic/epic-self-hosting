"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, AudioLines, Captions, Loader2, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, SkipForward, Volume1, Volume2, VolumeX, X } from "lucide-react";
import { usePlayerEngine, type PlaybackStart, type PlayerState } from "./use-player-engine";
import { activeSkipSegment } from "@/lib/player/skip-segments";

export interface PlayerContextValue {
  videoRef: RefObject<HTMLVideoElement | null>;
  state: PlayerState;
  play: (episodeId: number, resume?: boolean) => Promise<void>;
  close: () => void;
  setAudio: (index: number) => Promise<void>;
  setSubtitle: (index: number | null) => void;
  session: PlaybackStart | null;
  mode: "hidden" | "big" | "mini";
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function usePlayer(): PlayerContextValue {
  const value = useContext(PlayerContext);
  if (!value) throw new Error("usePlayer must be used within PlayerProvider");
  return value;
}

function formatPosition(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function saveTrackPreference(body: Record<string, unknown>): void {
  void fetch("/api/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const fullscreenRef = useRef<HTMLDivElement | null>(null);
  const pendingSkipRef = useRef(0);
  const skipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const SKIP_COALESCE_MS = 300;

  const [skipSeconds, setSkipSeconds] = useState(5);
  const [autoplayNext, setAutoplayNext] = useState(true);
  const [volume, setVolume] = useState(1);

  useEffect(() => {
    void fetch("/api/settings/playback")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!b) return;
        setSkipSeconds(typeof b.skipSeconds === "number" ? b.skipSeconds : 5);
        setAutoplayNext(typeof b.autoplayNext === "boolean" ? b.autoplayNext : true);
        setVolume(typeof b.volume === "number" ? b.volume : 1);
      })
      .catch(() => {});
  }, [pathname]);

  const onAutoAdvance = useMemo(
    () => (episodeId: number): boolean => {
      if (!autoplayNext) return false;
      router.replace(`/watch/${episodeId}`);
      return true;
    },
    [router, autoplayNext],
  );

  const { state, play, close, setSubtitle, setAudio } = usePlayerEngine({ onAutoAdvance, videoRef });
  const isWatchRoute = (pathname ?? "").startsWith("/watch/");

  const mode: PlayerContextValue["mode"] = isWatchRoute
    ? "big"
    : state.status !== "idle" && state.session != null
      ? "mini"
      : "hidden";
  const value = useMemo<PlayerContextValue>(
    () => ({ videoRef, state, play, close, setAudio, setSubtitle, session: state.session, mode }),
    [videoRef, state, play, close, setAudio, setSubtitle, mode],
  );

  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === fullscreenRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Escape is handled by the browser; this just leaves fullscreen when the
  // player shrinks out of big mode (back to home) so the mini card is not
  // stuck inside a fullscreened element.
  useEffect(() => {
    if (mode !== "big" && isFullscreen) {
      void document.exitFullscreen().catch(() => {});
    }
  }, [mode, isFullscreen]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement === fullscreenRef.current) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void fullscreenRef.current?.requestFullscreen().catch(() => {});
    }
  }, []);

  const [controlsVisible, setControlsVisible] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsHoveredRef = useRef(false);
  const saveVolumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the always-mounted <video> element's volume in sync with the state
  // (covers both the initial load of the persisted value and slider changes).
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (controlsHoveredRef.current) return;
      const video = videoRef.current;
      if (video && !video.paused) setControlsVisible(false);
    }, 3000);
  }, []);

  useEffect(() => {
    if (mode !== "big") return;
    if (state.status === "playing") {
      showControls();
    } else {
      setControlsVisible(true);
    }
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [mode, state.status, showControls]);

  const label = state.session
    ? `${state.session.animeTitle ?? "Anime"} · S${String(state.session.seasonNumber).padStart(2, "0")}E${String(state.session.episodeNumber).padStart(2, "0")}`
    : null;

  const episodeLabel = state.session
    ? `S${String(state.session.seasonNumber).padStart(2, "0")} · E${String(state.session.episodeNumber).padStart(2, "0")}`
    : null;

  const progress =
    state.durationSeconds && state.durationSeconds > 0
      ? (state.positionSeconds / state.durationSeconds) * 100
      : 0;

  const displayedFraction =
    dragging && dragFraction != null
      ? dragFraction
      : state.durationSeconds && state.durationSeconds > 0
        ? state.positionSeconds / state.durationSeconds
        : 0;

  // Skip Intro / Skip Ending: while the playhead is inside a detected segment
  // window (Intro Skipper plugin), offer a one-click jump to the segment end.
  const skipTarget = useMemo(
    () => activeSkipSegment(state.session?.skipSegments, state.positionSeconds),
    [state.session?.skipSegments, state.positionSeconds],
  );

  // Continue to EP X: when the episode ends and autoplay-next is off, offer a
  // manual jump to the next episode instead of auto-advancing.
  const continueEpisode = useMemo(() => {
    if (autoplayNext || !state.ended) return null;
    const session = state.session;
    if (session?.nextEpisodeId == null) return null;
    return { episodeId: session.nextEpisodeId, episodeNumber: session.nextEpisodeNumber };
  }, [autoplayNext, state.ended, state.session]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, []);

  const setVolumeLevel = useCallback((level: number) => {
    const video = videoRef.current;
    setVolume(level);
    if (video) video.volume = level;
    // Persist the volume, debounced so dragging the slider doesn't spam.
    if (saveVolumeTimerRef.current != null) clearTimeout(saveVolumeTimerRef.current);
    saveVolumeTimerRef.current = setTimeout(() => {
      void fetch("/api/settings/playback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ volume: level }),
      }).catch(() => {});
    }, 300);
  }, []);

  // Keep the pre-mute level in sync with whatever the user sets (slider,
  // persisted load, restore itself).
  useEffect(() => {
    if (volume > 0) lastVolumeRef.current = volume;
  }, [volume]);

  const toggleMute = useCallback(() => {
    setVolumeLevel(volume > 0 ? 0 : lastVolumeRef.current > 0 ? lastVolumeRef.current : 1);
  }, [volume, setVolumeLevel]);

  const onPickAudio = useCallback(
    (index: number) => {
      setAudioMenuOpen(false);
      void setAudio(index);
      const track = state.session?.audioTracks.find((t) => t.index === index);
      if (track?.language) saveTrackPreference({ audioLanguage: track.language });
    },
    [setAudio, state.session],
  );

  const onPickSubtitle = useCallback(
    (index: number | null) => {
      setSubtitleMenuOpen(false);
      setSubtitle(index);
      const track =
        index == null ? null : (state.session?.subtitleTracks.find((t) => t.index === index) ?? null);
      saveTrackPreference(
        track
          ? { subtitleLanguage: track.language, subtitleForced: track.isForced }
          : { subtitleLanguage: "off", subtitleForced: false },
      );
    },
    [setSubtitle, state.session],
  );

  const skip = useCallback(
    (deltaSeconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      // Coalesce rapid skips (holding ±5s / arrow keys): accumulate all
      // presses within a window into ONE jump to the final target. hls.js
      // cannot handle a flood of currentTime changes on a transcoded HLS
      // stream (→ CHUNK_DEMUXER_ERROR_APPEND_FAILED), so collapse them.
      pendingSkipRef.current += deltaSeconds;
      if (skipTimerRef.current) return;
      skipTimerRef.current = setTimeout(() => {
        skipTimerRef.current = null;
        const delta = pendingSkipRef.current;
        pendingSkipRef.current = 0;
        if (delta === 0) return;
        const duration = video.duration;
        const target = Number.isFinite(duration)
          ? clamp(video.currentTime + delta, 0, duration)
          : Math.max(0, video.currentTime + delta);
        video.currentTime = target;
        showControls();
      }, SKIP_COALESCE_MS);
    },
    [showControls],
  );

  const fractionFromEvent = useCallback((clientX: number): number => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  }, []);

  const volumeBarRef = useRef<HTMLDivElement | null>(null);
  const volumeDragRef = useRef(false);
  // Last non-zero volume, so unmuting restores the level instead of jumping
  // to 100%. Synced from state so slider changes and the persisted load
  // update it too.
  const lastVolumeRef = useRef(1);

  const volumeFractionFromEvent = useCallback((clientX: number): number => {
    const rect = volumeBarRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  }, []);

  const onVolumePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      volumeDragRef.current = true;
      setVolumeLevel(volumeFractionFromEvent(e.clientX));
    },
    [volumeFractionFromEvent, setVolumeLevel],
  );

  const onVolumePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!volumeDragRef.current) return;
      setVolumeLevel(volumeFractionFromEvent(e.clientX));
    },
    [volumeFractionFromEvent, setVolumeLevel],
  );

  const onVolumePointerUp = useCallback(() => {
    volumeDragRef.current = false;
  }, []);

  const onBarPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const video = videoRef.current;
      if (!video) return;
      e.preventDefault();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      setDragging(true);
      setDragFraction(fractionFromEvent(e.clientX));
    },
    [fractionFromEvent],
  );

  const onBarPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      setDragFraction(fractionFromEvent(e.clientX));
    },
    [dragging, fractionFromEvent],
  );

  const onBarPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const video = videoRef.current;
      const duration = video?.duration;
      if (video && Number.isFinite(duration)) {
        video.currentTime = fractionFromEvent(e.clientX) * (duration as number);
      }
      setDragging(false);
      setDragFraction(null);
    },
    [fractionFromEvent],
  );

  useEffect(() => {
    if (mode !== "big") return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        skip(-skipSeconds);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        skip(skipSeconds);
      } else if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        toggleMute();
      } else if (e.key === "Escape" && !document.fullscreenElement) {
        // In fullscreen the browser owns Escape (exits fullscreen); outside
        // it, Escape does the same as the back arrow: back to home.
        e.preventDefault();
        router.push("/");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, skip, togglePlay, skipSeconds, router, toggleFullscreen, toggleMute]);

  return (
    <PlayerContext.Provider value={value}>
      {children}

      {/* One <video>, always mounted. Only its wrapper's layout changes. */}
      <div
        ref={fullscreenRef}
        className={
          mode === "hidden"
            ? "hidden"
            : mode === "big"
              ? "fixed inset-0 z-40 bg-black"
              : "fixed bottom-4 left-1/2 z-50 w-80 -translate-x-1/2 overflow-hidden rounded-xl border border-border-strong bg-surface"
        }
      >
        <div
          className={mode === "big" ? "relative h-full w-full" : "relative"}
          onPointerMove={mode === "big" ? showControls : undefined}
          onPointerDown={mode === "big" ? showControls : undefined}
        >
          {/* Media layer — independent of the overlay layers. It owns the
              clip (overflow-hidden) and the video's black background, so the
              video's letterbox edge can never bleed into the overlays. */}
          <div
            className={
              mode === "big"
                ? "absolute inset-0 overflow-hidden bg-black"
                : "relative h-36 w-full overflow-hidden rounded-lg bg-black"
            }
          >
            <video
              ref={videoRef}
              autoPlay
              crossOrigin="anonymous"
              className="h-full w-full object-contain"
            />
          </div>

          {mode === "big" && (state.buffering || state.status === "starting") && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-12 w-12 animate-spin text-text-secondary" aria-hidden />
            </div>
          )}

          {mode === "mini" && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-surface-raised">
              <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
            </div>
          )}

          {mode === "big" && (
            <div
              className={`absolute inset-x-0 top-0 flex items-center justify-between bg-linear-to-b from-black/80 to-transparent px-4 pb-10 pt-3 transition-opacity ${
                controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
              }`}
              onPointerEnter={() => {
                controlsHoveredRef.current = true;
                showControls();
              }}
              onPointerLeave={() => {
                controlsHoveredRef.current = false;
                showControls();
              }}
            >
              <button
                onClick={() => router.push("/")}
                aria-label="Back"
                className="rounded-lg p-2 text-text-primary transition-colors hover:bg-surface-hover"
              >
                <ArrowLeft className="h-5 w-5" aria-hidden />
              </button>
              <span
                className="h-2.5 w-2.5 rounded-full transition-colors"
                style={{
                  backgroundColor:
                    state.status === "playing"
                      ? "var(--success)"
                      : state.status === "paused"
                        ? "var(--warning)"
                        : state.status === "error"
                          ? "var(--danger)"
                          : "var(--text-muted)",
                }}
                aria-label={`Status: ${state.status}`}
              />
            </div>
          )}

          {mode === "big" && skipTarget && (
            <div className="absolute bottom-24 right-6">
              <button
                onClick={() => {
                  const video = videoRef.current;
                  if (video && Number.isFinite(video.duration)) {
                    // A plain seek: the engine's `seeked` listener reports it
                    // through the normal save cycle; nothing marks the episode
                    // watched.
                    video.currentTime = skipTarget.end;
                  }
                  showControls();
                }}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent-hover active:bg-accent"
              >
                <SkipForward className="mr-1.5 inline h-4 w-4" aria-hidden />
                {skipTarget.kind === "intro" ? "Skip Intro" : "Skip Ending"}
              </button>
            </div>
          )}

          {mode === "big" && continueEpisode && (
            <div className="absolute bottom-24 right-6">
              <button
                onClick={() => router.replace(`/watch/${continueEpisode.episodeId}`)}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent-hover active:bg-accent"
              >
                <SkipForward className="mr-1.5 inline h-4 w-4" aria-hidden />
                {continueEpisode.episodeNumber != null
                  ? `Continue to EP ${continueEpisode.episodeNumber}`
                  : "Continue to next episode"}
              </button>
            </div>
          )}

          {mode === "big" && state.status === "error" && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80">
              <div className="max-w-md p-8 text-center">
                <h1 className="text-xl font-semibold text-text-primary">Playback failed</h1>
                {state.error && <p className="mt-2 text-sm text-text-secondary">{state.error}</p>}
                <Link href="/" className="mt-4 inline-block text-accent hover:underline">
                  ← Back to home
                </Link>
              </div>
            </div>
          )}

          {mode === "big" && (
            <div
              className={`absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 to-transparent px-4 pb-3 pt-10 transition-opacity ${
                controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
              }`}
              onPointerEnter={() => {
                controlsHoveredRef.current = true;
                showControls();
              }}
              onPointerLeave={() => {
                controlsHoveredRef.current = false;
                showControls();
              }}
            >
              <div
                ref={barRef}
                role="slider"
                aria-label="Seek"
                aria-valuemin={0}
                aria-valuemax={Math.round(state.durationSeconds ?? 0)}
                aria-valuenow={Math.round(state.durationSeconds ? displayedFraction * state.durationSeconds : 0)}
                className="group flex h-5 cursor-pointer touch-none items-center"
                onPointerDown={onBarPointerDown}
                onPointerMove={onBarPointerMove}
                onPointerUp={onBarPointerUp}
              >
                <div className="relative h-1 w-full overflow-hidden rounded-full bg-surface-raised">
                  <div
                    className="absolute inset-y-0 left-0 bg-accent"
                    style={{ width: `${displayedFraction * 100}%` }}
                  />
                </div>
              </div>

              <div className="relative mt-1 flex items-center gap-1">
                <button
                  onClick={() => skip(-skipSeconds)}
                  aria-label={`Back ${skipSeconds} seconds`}
                  className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                >
                  <RotateCcw className="h-5 w-5" aria-hidden />
                  <span className="sr-only">Back {skipSeconds} seconds</span>
                </button>
                <button
                  onClick={togglePlay}
                  aria-label={state.status === "paused" ? "Resume" : "Pause"}
                  className="rounded-lg p-2 text-text-primary transition-colors hover:bg-surface-hover"
                >
                  {state.status === "paused" ? (
                    <Play className="h-5 w-5" aria-hidden />
                  ) : (
                    <Pause className="h-5 w-5" aria-hidden />
                  )}
                </button>
                <button
                  onClick={() => skip(skipSeconds)}
                  aria-label={`Forward ${skipSeconds} seconds`}
                  className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                >
                  <RotateCw className="h-5 w-5" aria-hidden />
                  <span className="sr-only">Forward {skipSeconds} seconds</span>
                </button>

                {episodeLabel && (
                  <div className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 -translate-y-0.5 flex-col items-center gap-0.5">
                    <span className="font-mono text-xs text-text-primary">{episodeLabel}</span>
                    <span className="font-mono text-xs text-text-secondary">
                      {formatPosition(state.positionSeconds)}
                      {state.durationSeconds ? ` / ${formatPosition(state.durationSeconds)}` : ""}
                    </span>
                  </div>
                )}

                <div className="ml-auto flex items-center gap-1">
                  <div className="group flex items-center">
                    <div
                      ref={volumeBarRef}
                      role="slider"
                      aria-label="Volume"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(volume * 100)}
                      className="relative h-5 w-0 origin-right scale-x-0 cursor-pointer touch-none opacity-0 transition-all duration-150 group-hover:mr-1 group-hover:w-20 group-hover:scale-x-100 group-hover:opacity-100"
                      onPointerDown={onVolumePointerDown}
                      onPointerMove={onVolumePointerMove}
                      onPointerUp={onVolumePointerUp}
                    >
                      <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-surface-raised" />
                      <div
                        className="peer/volthumb absolute top-1/2 z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent transition-colors hover:bg-accent-hover active:bg-accent"
                        style={{ left: `${volume * 100}%` }}
                      />
                      <div
                        className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent transition-colors peer-hover/volthumb:bg-accent-hover"
                        style={{ width: `${volume * 100}%` }}
                      />
                    </div>
                    <button
                      onClick={toggleMute}
                      aria-label={volume > 0 ? "Mute" : "Unmute"}
                      className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                    >
                      {volume === 0 ? (
                        <VolumeX className="h-5 w-5" aria-hidden />
                      ) : volume < 0.5 ? (
                        <Volume1 className="h-5 w-5" aria-hidden />
                      ) : (
                        <Volume2 className="h-5 w-5" aria-hidden />
                      )}
                    </button>
                  </div>

                  <div className="relative">
                    <button
                      onClick={() => {
                        setAudioMenuOpen((o) => !o);
                        setSubtitleMenuOpen(false);
                      }}
                      aria-label="Audio track"
                      className={`rounded-lg p-2 transition-colors hover:bg-surface-hover ${
                        audioMenuOpen ? "text-accent" : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      <AudioLines className="h-5 w-5" aria-hidden />
                    </button>
                    {audioMenuOpen && (
                      <div className="absolute bottom-12 right-0 max-h-64 w-56 overflow-y-auto rounded-xl border border-border-strong bg-surface p-1">
                        {state.session?.audioTracks.map((track) => (
                          <button
                            key={track.index}
                            onClick={() => onPickAudio(track.index)}
                            className={`w-full truncate rounded-lg px-3 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover ${
                              state.activeAudioIndex === track.index ? "text-accent" : "text-text-secondary"
                            }`}
                          >
                            {track.displayTitle ?? track.language ?? `Track ${track.index}`}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>


                  <div className="relative">
                    <button
                      onClick={() => {
                        setSubtitleMenuOpen((o) => !o);
                        setAudioMenuOpen(false);
                      }}
                      aria-label="Subtitle track"
                      className={`rounded-lg p-2 transition-colors hover:bg-surface-hover ${
                        subtitleMenuOpen ? "text-accent" : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      <Captions className="h-5 w-5" aria-hidden />
                    </button>
                    {subtitleMenuOpen && (
                      <div className="absolute bottom-12 right-0 max-h-64 w-56 overflow-y-auto rounded-xl border border-border-strong bg-surface p-1">
                        <button
                          onClick={() => onPickSubtitle(null)}
                          className={`w-full truncate rounded-lg px-3 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover ${
                            state.activeSubtitleIndex === null ? "text-accent" : "text-text-secondary"
                          }`}
                        >
                          Off
                        </button>
                        {state.session?.subtitleTracks.map((track) => (
                          <button
                            key={track.index}
                            onClick={() => onPickSubtitle(track.index)}
                            className={`w-full truncate rounded-lg px-3 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover ${
                              state.activeSubtitleIndex === track.index ? "text-accent" : "text-text-secondary"
                            }`}
                          >
                            {track.displayTitle ?? track.language ?? `Track ${track.index}`}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>


                  <button
                    onClick={toggleFullscreen}
                    aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
                    className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                  >
                    {isFullscreen ? (
                      <Minimize className="h-5 w-5" aria-hidden />
                    ) : (
                      <Maximize className="h-5 w-5" aria-hidden />
                    )}
                    <span className="sr-only">
                      {isFullscreen ? "Exit full screen" : "Full screen"}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {mode === "mini" && state.session && (
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
            <button
              onClick={togglePlay}
              aria-label={state.status === "paused" ? "Resume" : "Pause"}
              className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            >
              {state.status === "paused" ? (
                <Play className="h-4 w-4" aria-hidden />
              ) : (
                <Pause className="h-4 w-4" aria-hidden />
              )}
            </button>
            <button
              onClick={() => router.push(`/watch/${state.session!.episodeId}`)}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-surface-hover"
            >
              <Maximize className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
              <span className="truncate font-mono text-xs text-text-primary">{label}</span>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">
                {formatPosition(state.positionSeconds)}
                {state.durationSeconds ? ` / ${formatPosition(state.durationSeconds)}` : ""}
              </span>
            </button>
            <button
              onClick={close}
              aria-label="Close player"
              className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}
      </div>
    </PlayerContext.Provider>
  );
}
