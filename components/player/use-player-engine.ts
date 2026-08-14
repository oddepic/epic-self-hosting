"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  buildStartPayload,
  buildProgressPayload,
  buildStoppedPayload,
  parseStreamServer,
} from "@/lib/player/report";
import {
  secondsFromTicks,
  shouldSaveNow,
  ticksFromSeconds,
} from "@/lib/player/save-policy";
import { reanchorTarget } from "@/lib/player/reanchor";
import { subtitleDriftOffsetSeconds } from "@/lib/player/subtitle-drift";

const RECOVER_COOLDOWN_MS = 4000;
const STALL_TIMEOUT_MS = 10_000;
const MANIFEST_TIMEOUT_MS = 15_000;

export interface SubtitleTrackInfo {
  index: number;
  language: string | null;
  isForced: boolean;
  codec: string | null;
  displayTitle: string | null;
  isText: boolean;
  url: string | null;
}

export interface AudioTrackInfo {
  index: number;
  language: string | null;
  codec: string | null;
  displayTitle: string | null;
}

export interface PlaybackStart {
  url: string;
  startPositionTicks: number;
  itemId: string;
  mediaSourceId: string | null;
  playSessionId: string | null;
  playMethod: string;
  nextEpisodeId: number | null;
  episodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  animeTitle: string | null;
  subtitleTracks: SubtitleTrackInfo[];
  audioTracks: AudioTrackInfo[];
  fontUrls: string[];
  selectedAudioIndex: number | null;
  selectedSubtitleIndex: number | null;
}

export interface PlayerState {
  status: "idle" | "starting" | "playing" | "paused" | "error";
  error: string | null;
  session: PlaybackStart | null;
  positionSeconds: number;
  durationSeconds: number | null;
  activeSubtitleIndex: number | null;
  activeAudioIndex: number | null;
  buffering: boolean;
}

export interface PlayerEngineOptions {
  onAutoAdvance: (episodeId: number) => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  subtitleCanvasRef: RefObject<HTMLCanvasElement | null>;
}

export function usePlayerEngine({ onAutoAdvance, videoRef, subtitleCanvasRef }: PlayerEngineOptions) {
  const [state, setState] = useState<PlayerState>({
    status: "idle",
    error: null,
    session: null,
    positionSeconds: 0,
    durationSeconds: null,
    activeSubtitleIndex: null,
    activeAudioIndex: null,
    buffering: false,
  });

  const sessionRef = useRef<PlaybackStart | null>(null);
  const lastPositionRef = useRef(0);
  const lastSaveAtRef = useRef(0);
  const hlsRef = useRef<import("hls.js").default | null>(null);
  const jassubRef = useRef<import("jassub").default | null>(null);
  const startPositionRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const autoAdvanceRef = useRef(onAutoAdvance);
  autoAdvanceRef.current = onAutoAdvance;
  const playRef = useRef<(episodeId: number, resume?: boolean) => Promise<void>>(async () => {});
  const lastRecoverAtRef = useRef(0);
  const hlsPositionManagedRef = useRef(false);
  const reanchoredRef = useRef(false);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manifestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playInFlightRef = useRef<number | null>(null);

  const report = useCallback((path: string, body: Record<string, unknown>): void => {
    const session = sessionRef.current;
    if (!session) return;
    const { serverUrl, token } = parseStreamServer(session.url);
    void fetch(`${serverUrl}${path}`, {
      method: "POST",
      headers: { "X-Emby-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
  }, []);

  const reportProgress = useCallback(
    (positionSeconds: number, isPaused: boolean): void => {
      const session = sessionRef.current;
      if (!session) return;
      report("/Sessions/Playing/Progress", buildProgressPayload(session, ticksFromSeconds(positionSeconds), isPaused));
      lastSaveAtRef.current = Date.now();
    },
    [report],
  );

  const reportStopped = useCallback(
    (positionSeconds: number): void => {
      const session = sessionRef.current;
      if (!session) return;
      report("/Sessions/Playing/Stopped", buildStoppedPayload(session, ticksFromSeconds(positionSeconds)));
    },
    [report],
  );

  const recoverStream = useCallback((video: HTMLVideoElement) => {
    const session = sessionRef.current;
    if (!session) return;
    // Cooldown guard: only re-resolve once per few seconds. A fatal hls.js
    // error from rapid seeking is self-healed with a single re-resolve; the
    // cooldown stops it from looping into an infinite start/stop cycle.
    const now = Date.now();
    if (now - lastRecoverAtRef.current < RECOVER_COOLDOWN_MS) return;
    lastRecoverAtRef.current = now;
    const position = video.currentTime;
    reportStopped(position);
    sessionRef.current = null;
    setState((s) => ({ ...s, session: null, status: "starting" }));
    void playRef.current(session.episodeId, true);
  }, [reportStopped]);

  // In-place recovery for hls.js media/buffer errors: flush the buffer and
  // reload the current stream. Far cheaper than a full re-resolve, so rapid
  // seeking that trips a buffer append error self-heals instantly.
  const recoverMediaError = useCallback(() => {
    const hls = hlsRef.current;
    if (!hls || !sessionRef.current) return;
    console.debug("[player] recoverMediaError");
    hls.recoverMediaError();
  }, []);

  const attachVideo = useCallback((video: HTMLVideoElement) => {
    const onTimeUpdate = () => {
      const position = video.currentTime;
      lastPositionRef.current = position;
      setState((s) => ({ ...s, positionSeconds: position, durationSeconds: video.duration }));
      // Jellyfin's HLS transcode drifts the audio content progressively early
      // vs its PTS; compensate the JASSUB clock so subtitles track the audio.
      // Applied continuously so the offset keeps pace as playback advances.
      if (jassubRef.current) {
        jassubRef.current.timeOffset = subtitleDriftOffsetSeconds(position);
      }
      if (shouldSaveNow(lastSaveAtRef.current, Date.now())) {
        reportProgress(position, video.paused);
      }
    };
    const onPlay = () => {
      setState((s) => ({ ...s, status: "playing", buffering: false }));
      if (stallTimerRef.current != null) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
      if (reanchoredRef.current) return;
      const startSeconds = startPositionRef.current;
      if (startSeconds <= 0) {
        // No resume position — nothing to re-anchor; consume the guard so the
        // common fresh-play path never re-seeks.
        reanchoredRef.current = true;
        return;
      }
      const duration = video.duration;
      if (duration == null || !Number.isFinite(duration) || duration <= 0) {
        // Media not ready yet (duration unknown — e.g. the first `play` event
        // on the native HLS path fires before metadata loads). Keep the guard
        // armed; re-anchor on the next `play`/`playing` once duration is known.
        return;
      }
      reanchoredRef.current = true;
      // hls.js `startPosition` / the native-path seek handle the initial
      // fragment selection, but a mid-stream start can still leave the element
      // clock off the resume position. Re-anchor once after playback starts,
      // mirroring jellyfin-web's `seekOnPlaybackStart`.
      const target = reanchorTarget({
        startSeconds,
        currentTime: video.currentTime,
        duration,
      });
      if (target == null) return;
      if (Math.abs(video.currentTime - target) >= 1) {
        // The element clock is already off the resume position — a plain
        // assignment is a real seek.
        video.currentTime = target;
      } else {
        // The element clock already reads the resume position. `currentTime =
        // target` would be a no-op, so back off the target first to force a
        // genuine seek, then land exactly on it.
        const generation = loadGenerationRef.current;
        video.currentTime = Math.max(0, target - 2);
        video.addEventListener(
          "seeked",
          () => {
            // Guard against a stale listener: if a re-resolve (recoverStream /
            // play) happened while the first seek was in flight, the session
            // and target are obsolete — do not re-seek into the old position.
            if (generation !== loadGenerationRef.current) return;
            video.currentTime = target;
          },
          { once: true },
        );
      }
    };
    const onWaiting = () => {
      setState((s) => ({ ...s, buffering: true }));
      if (stallTimerRef.current != null) return;
      // Stall watchdog: if buffering persists without `playing`/`canplay`
      // returning, the stream is wedged (e.g. a seek landed on a fragment
      // with no data, or the token went stale). Re-resolve once to break out
      // instead of spinning forever.
      stallTimerRef.current = setTimeout(() => {
        stallTimerRef.current = null;
        recoverStream(video);
      }, STALL_TIMEOUT_MS);
    };
    const onCanPlay = () => {
      setState((s) => ({ ...s, buffering: false }));
      if (stallTimerRef.current != null) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
    };
    const onPause = () => {
      const position = video.currentTime;
      lastPositionRef.current = position;
      reportProgress(position, true);
      setState((s) => ({ ...s, status: "paused" }));
    };
    const onSeeked = () => {
      const position = video.currentTime;
      lastPositionRef.current = position;
      reportProgress(position, video.paused);
    };
    const onLoadedMetadata = () => {
      // hls.js already seeks to `startPosition` itself; a second manual seek
      // here can land on a different segment and desync the subtitle clock.
      // Only native playback needs the manual seek.
      if (hlsPositionManagedRef.current) return;
      const start = startPositionRef.current;
      if (start > 0 && video.currentTime < 1) {
        video.currentTime = start;
      }
    };
    const onEnded = () => {
      const position = video.duration || video.currentTime;
      lastPositionRef.current = position;
      reportStopped(position);
      const session = sessionRef.current;
      sessionRef.current = null;
      setState((s) => ({ ...s, session: null, status: "idle", positionSeconds: position }));
      if (session?.nextEpisodeId != null) {
        autoAdvanceRef.current(session.nextEpisodeId);
      }
    };
    const onError = () => {
      // Network (2) usually means a stale token → full re-resolve. Decode (3)
      // is typically back-buffer seek collision → cheap in-place recovery.
      if (video.error?.code === 2) {
        recoverStream(video);
      } else if (video.error?.code === 3) {
        recoverMediaError();
      }
    };
    const onPageHide = () => {
      reportStopped(lastPositionRef.current);
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    // `playing` as well: on the native HLS path the only `play` event fires
    // before metadata (duration unknown); the re-anchor guard stays armed and
    // needs a second chance once the media is actually rendering.
    video.addEventListener("playing", onPlay);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("playing", onPlay);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [recoverMediaError, recoverStream, reportProgress, reportStopped]);

  const teardown = useCallback(() => {
    if (stallTimerRef.current != null) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
    if (manifestTimerRef.current != null) {
      clearTimeout(manifestTimerRef.current);
      manifestTimerRef.current = null;
    }
    hlsRef.current?.destroy();
    hlsRef.current = null;
    jassubRef.current?.destroy();
    jassubRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }, [videoRef]);

  const attachSubtitles = useCallback(async (track: SubtitleTrackInfo | null, fonts: string[]) => {
    jassubRef.current?.destroy();
    jassubRef.current = null;

    const video = videoRef.current;
    if (!video || !track?.url) return;

    const generation = loadGenerationRef.current;
    try {
        const { default: JASSUB } = await import("jassub");
        const [subResponse, ...fontResponses] = await Promise.all([
          fetch(track.url),
          ...fonts.map((url) => fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null))),
        ]);
        if (generation !== loadGenerationRef.current) return;
        if (!subResponse.ok) return;

        const subContent = await subResponse.text();
        const fontBuffers = fontResponses.filter((b): b is ArrayBuffer => b != null).map((b) => new Uint8Array(b));

        jassubRef.current = new JASSUB({
          video,
          subContent,
          fonts: fontBuffers,
          canvas: subtitleCanvasRef.current ?? undefined,
          // Compensate Jellyfin's copied-AAC drift from the very first frame so
          // the compensation can never be missed by a teardown/attach race.
          timeOffset: subtitleDriftOffsetSeconds(video.currentTime),
        });
        await jassubRef.current.ready;
      } catch {
        jassubRef.current = null;
      }
    }, [subtitleCanvasRef, videoRef]);

    const setSubtitle = useCallback(
      (index: number | null) => {
        const session = sessionRef.current;
        if (!session) return;
        const track = index == null ? null : session.subtitleTracks.find((t) => t.index === index) ?? null;
        setState((s) => ({ ...s, activeSubtitleIndex: track?.isText ? track.index : null }));
        if (!track || !track.isText) {
          void attachSubtitles(null, []);
          return;
        }
        void attachSubtitles(track, session.fontUrls);
      },
      [attachSubtitles],
    );

    const setAudio = useCallback(
      async (index: number) => {
        const session = sessionRef.current;
        const video = videoRef.current;
        if (!session || !video) return;
        const currentTime = video.currentTime;

        const res = await fetch("/api/playback/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            episodeId: session.episodeId,
            resume: false,
            audioStreamIndex: index,
            subtitleStreamIndex: state.activeSubtitleIndex ?? session.selectedSubtitleIndex ?? null,
          }),
        });
        if (!res.ok) return;
        const start = (await res.json()) as PlaybackStart;
        if (!start.url) return;

        reportStopped(lastPositionRef.current);
        sessionRef.current = start;
        lastPositionRef.current = currentTime;
        lastSaveAtRef.current = Date.now();
        setState((s) => ({ ...s, session: start, activeAudioIndex: start.selectedAudioIndex }));

        hlsRef.current?.destroy();
        hlsRef.current = null;
        if (manifestTimerRef.current != null) {
          clearTimeout(manifestTimerRef.current);
          manifestTimerRef.current = null;
        }
        if (stallTimerRef.current != null) {
          clearTimeout(stallTimerRef.current);
          stallTimerRef.current = null;
        }
        reanchoredRef.current = true;
        video.removeAttribute("src");
        video.load();

        const needsHls = start.url.includes(".m3u8") || start.url.includes("master");
        const canPlayNativeHls = !needsHls || video.canPlayType("application/vnd.apple.mpegurl") !== "";
        const seekAfterReady = () => {
          video.currentTime = currentTime;
          video
            .play()
            .then(() => setState((s) => ({ ...s, status: "playing" })))
            .catch(() => setState((s) => ({ ...s, status: "paused" })));
        };
        if (needsHls && !canPlayNativeHls) {
          hlsPositionManagedRef.current = true;
          const { default: Hls } = await import("hls.js");
          if (!Hls.isSupported()) return;
          const hls = new Hls({ startPosition: currentTime });
          hlsRef.current = hls;
          hls.loadSource(start.url);
          hls.attachMedia(video);
          manifestTimerRef.current = setTimeout(() => {
            manifestTimerRef.current = null;
            recoverStream(video);
          }, MANIFEST_TIMEOUT_MS);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (manifestTimerRef.current != null) {
              clearTimeout(manifestTimerRef.current);
              manifestTimerRef.current = null;
            }
            seekAfterReady();
          });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            const isNetworkAuth =
              data.type === Hls.ErrorTypes.NETWORK_ERROR &&
              (data as { response?: { code?: number } }).response?.code === 401;
            if (isNetworkAuth) {
              recoverStream(video);
            } else if (data.fatal) {
              recoverMediaError();
            }
          });
        } else {
          hlsPositionManagedRef.current = false;
          video.src = start.url;
          video.addEventListener("loadedmetadata", seekAfterReady, { once: true });
          video.play().catch(() => {});
        }
      },
      [reportStopped, recoverMediaError, recoverStream, state.activeSubtitleIndex, videoRef],
    );
    const play = useCallback(async (episodeId: number, resume = true) => {
      const video = videoRef.current;
      if (!video) return;

      // StrictMode (dev) mounts the watch page twice, firing two play() calls
      // for the same episode back-to-back. Without this guard the second call
      // tears down what the first just built - including the JASSUB instance
      // that the drift compensation updates on every timeupdate.
      if (playInFlightRef.current === episodeId) return;
      playInFlightRef.current = episodeId;
      try {

      // Always re-resolve the stream. Jellyfin invalidates the previous service
      // token whenever a new one is minted (per-user single session), so any
      // held-over URL — e.g. after a dev-server restart — is already dead.
      // Re-resolving mints a fresh token and, thanks to single-flight auth,
      // concurrent starts share it instead of killing each other.

      if (sessionRef.current) {
        reportStopped(lastPositionRef.current);
      }
      sessionRef.current = null;
      reanchoredRef.current = false;
      teardown();
      const generation = ++loadGenerationRef.current;
      setState({
        status: "starting",
        error: null,
        session: null,
        positionSeconds: 0,
        durationSeconds: null,
        activeSubtitleIndex: null,
        activeAudioIndex: null,
        buffering: true,
      });

      try {
        const res = await fetch("/api/playback/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ episodeId, resume }),
        });
        if (generation !== loadGenerationRef.current) return;
        if (!res.ok) {
          setState((s) => ({ ...s, status: "error", error: "Could not start playback for this episode." }));
          return;
        }
        const start = (await res.json()) as PlaybackStart;
        if (generation !== loadGenerationRef.current) return;
        if (!start.url) {
          setState((s) => ({ ...s, status: "error", error: "No playable stream for this episode." }));
          return;
        }

        sessionRef.current = start;
        startPositionRef.current = secondsFromTicks(start.startPositionTicks);
        lastPositionRef.current = startPositionRef.current;
        lastSaveAtRef.current = Date.now();
        const selectedSub = start.subtitleTracks.find((t) => t.index === start.selectedSubtitleIndex) ?? null;
        setState((s) => ({
          ...s,
          session: start,
          activeSubtitleIndex: selectedSub?.isText ? selectedSub.index : null,
          activeAudioIndex: start.selectedAudioIndex,
        }));

        if (selectedSub?.isText) {
          void attachSubtitles(selectedSub, start.fontUrls);
        }

        report("/Sessions/Playing", buildStartPayload(start));

        const needsHls = start.url.includes(".m3u8") || start.url.includes("master");
        const canPlayNativeHls =
          !needsHls || video.canPlayType("application/vnd.apple.mpegurl") !== "";

        if (needsHls && !canPlayNativeHls) {
          hlsPositionManagedRef.current = true;
          const { default: Hls } = await import("hls.js");
          if (!Hls.isSupported()) {
            sessionRef.current = null;
            setState((s) => ({ ...s, status: "error", error: "HLS is not supported in this browser." }));
            return;
          }
          const hls = new Hls({
            ...(startPositionRef.current > 0 ? { startPosition: startPositionRef.current } : {}),
            // hls.js defaults / jellyfin-web alignment (issue 37). Earlier custom
            // values (enableWorker:false, maxBufferHole:0.5, nudgeMaxRetry:5,
            // backBufferLength:90) were added for seek append-failures; the
            // defaults handle rapid seeks via the gap controller + worker.
            // backBufferLength: 90,
            // maxBufferLength: 30,
            // maxMaxBufferLength: 90,
            // enableWorker: false,
            // nudgeMaxRetry: 5,
            // maxBufferHole: 0.5,
          });
          hlsRef.current = hls;
          hls.loadSource(start.url);
          hls.attachMedia(video);
          // Manifest timeout: if MANIFEST_PARSED never fires (stale token 401,
          // slow transcode start), re-resolve instead of hanging on "starting".
          manifestTimerRef.current = setTimeout(() => {
            manifestTimerRef.current = null;
            recoverStream(video);
          }, MANIFEST_TIMEOUT_MS);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (manifestTimerRef.current != null) {
              clearTimeout(manifestTimerRef.current);
              manifestTimerRef.current = null;
            }
            video
              .play()
              .then(() => setState((s) => ({ ...s, status: "playing" })))
              // Autoplay can be blocked on a fresh page load (no user gesture yet).
              // Reflect the real state so the play button is honest, not a lie.
              .catch(() => setState((s) => ({ ...s, status: "paused" })));
          });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            const isNetworkAuth =
              data.type === Hls.ErrorTypes.NETWORK_ERROR &&
              (data as { response?: { code?: number } }).response?.code === 401;
            if (isNetworkAuth) {
              // Stale token → full re-resolve mints a fresh stream.
              recoverStream(video);
            } else if (data.fatal) {
              // Buffer/media churn (e.g. rapid seeks) → cheap in-place recovery.
              recoverMediaError();
            }
          });
        } else {
          hlsPositionManagedRef.current = false;
          video.src = start.url;
          if (startPositionRef.current > 0 && video.currentTime < 1) {
            video.currentTime = startPositionRef.current;
          }
          video
            .play()
            .then(() => setState((s) => ({ ...s, status: "playing" })))
            .catch(() => setState((s) => ({ ...s, status: "paused" })));
        }
      } catch (err) {
        if (generation !== loadGenerationRef.current) return;
        sessionRef.current = null;
        setState((s) => ({
          ...s,
          status: "error",
          error: err instanceof Error ? err.message : "Playback failed",
        }));
      }
    } finally {
      if (playInFlightRef.current === episodeId) {
        playInFlightRef.current = null;
      }
    }
  }, [attachSubtitles, recoverMediaError, recoverStream, report, reportStopped, teardown, videoRef]);

  playRef.current = play;

  const close = useCallback(() => {
    reportStopped(lastPositionRef.current);
    playInFlightRef.current = null;
    teardown();
    sessionRef.current = null;
    setState({ status: "idle", error: null, session: null, positionSeconds: 0, durationSeconds: null, activeSubtitleIndex: null, activeAudioIndex: null, buffering: false });
  }, [reportStopped, teardown]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    return attachVideo(video);
  }, [attachVideo, videoRef]);

  return { videoRef, state, play, close, setSubtitle, setAudio };
}
