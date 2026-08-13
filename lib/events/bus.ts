type Listener = (event: string, data: unknown) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publish(event: string, data: unknown): void {
  for (const listener of [...listeners]) {
    try {
      listener(event, data);
    } catch (error) {
      console.error("event bus listener failed:", error);
    }
  }
}
