import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import Navigation, { type AppView } from "./navigation";

interface Props {
  active: AppView;
  onNavigate: (view: AppView) => void;
  onRefresh: () => void;
  refreshing: boolean;
  refreshed: boolean;
  children: ReactNode;
}

export default function AppShell({ active, onNavigate, onRefresh, refreshing, refreshed, children }: Props) {
  return (
    <div className="min-h-screen bg-background text-text-primary">
      <header className="mx-auto flex w-full max-w-[1800px] flex-wrap items-center justify-between gap-4 px-8 py-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">Anime</h1>
            <button
              onClick={onRefresh}
              aria-label="Refresh"
              className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
            </button>
            {refreshed && (
              <span className="text-xs text-success transition-opacity">Refreshed</span>
            )}
          </div>
          <p className="text-xs text-text-muted">Library footprint, downloads & anime tracking</p>
        </div>
        <Navigation active={active} onNavigate={onNavigate} />
      </header>
      <main className="mx-auto w-full max-w-[1800px] px-8 pb-12">{children}</main>
    </div>
  );
}
