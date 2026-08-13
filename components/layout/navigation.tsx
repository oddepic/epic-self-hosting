export type AppView = "anime" | "list" | "sonarr" | "downloads" | "settings";

const ITEMS: { id: AppView; label: string }[] = [
  { id: "anime", label: "Anime" },
  { id: "list", label: "List" },
  { id: "sonarr", label: "Sonarr" },
  { id: "downloads", label: "Downloads" },
  { id: "settings", label: "Settings" },
];

interface Props {
  active: AppView;
  onNavigate: (view: AppView) => void;
}

export default function Navigation({ active, onNavigate }: Props) {
  return (
    <nav className="flex items-center gap-1 rounded-full border border-border bg-surface p-1">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          onClick={() => onNavigate(item.id)}
          aria-current={active === item.id ? "page" : undefined}
          className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
            active === item.id
              ? "bg-surface-raised text-text-primary"
              : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
          }`}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
