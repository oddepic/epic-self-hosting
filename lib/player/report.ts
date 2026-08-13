export interface PlaybackSession {
  url: string;
  startPositionTicks: number;
  itemId: string;
  mediaSourceId: string | null;
  playSessionId: string | null;
  playMethod: string;
}

export interface StreamServer {
  serverUrl: string;
  token: string;
}

export function parseStreamServer(url: string): StreamServer {
  const parsed = new URL(url);
  return {
    serverUrl: parsed.origin,
    token: parsed.searchParams.get("ApiKey") ?? "",
  };
}

function sessionBase(session: PlaybackSession): Record<string, unknown> {
  return {
    ItemId: session.itemId,
    MediaSourceId: session.mediaSourceId ?? session.itemId,
    ...(session.playSessionId != null ? { PlaySessionId: session.playSessionId } : {}),
    PlayMethod: session.playMethod,
  };
}

export function buildStartPayload(session: PlaybackSession): Record<string, unknown> {
  return {
    ...sessionBase(session),
    PositionTicks: session.startPositionTicks,
  };
}

export function buildProgressPayload(
  session: PlaybackSession,
  positionTicks: number,
  isPaused: boolean,
): Record<string, unknown> {
  return {
    ...sessionBase(session),
    PositionTicks: positionTicks,
    IsPaused: isPaused,
  };
}

export function buildStoppedPayload(
  session: PlaybackSession,
  positionTicks: number,
): Record<string, unknown> {
  return {
    ...sessionBase(session),
    PositionTicks: positionTicks,
  };
}
