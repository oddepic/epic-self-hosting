export class RateLimitedError extends Error {
  constructor(
    public readonly retryAfterMs: number,
    message = "Rate limited",
  ) {
    super(message);
  }
}

export class SearchFailedError extends Error {
  constructor(message = "Search failed") {
    super(message);
  }
}
