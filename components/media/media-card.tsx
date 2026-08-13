import type { ReactNode } from "react";
import Badge from "@/components/ui/badge";
import Progress from "@/components/ui/progress";

interface Props {
  imageUrl: string | null;
  title: string;
  subtitle?: string | null;
  badge?: string | null;
  progress?: number | null;
  onClick?: () => void;
  className?: string;
}

export default function MediaCard({ imageUrl, title, subtitle, badge, progress, onClick, className = "" }: Props) {
  return (
    <button
      onClick={onClick}
      className={`group flex w-36 shrink-0 flex-col text-left transition-transform duration-200 hover:-translate-y-0.5 ${className}`}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl border border-border bg-surface">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={title}
            className="h-full w-full object-cover transition-opacity duration-200 group-hover:opacity-90"
          />
        ) : (
          <div className="h-full w-full bg-surface-hover" />
        )}
        {badge && (
          <Badge className="absolute left-1.5 top-1.5 bg-background/80 backdrop-blur-sm">
            {badge}
          </Badge>
        )}
      </div>
      <p className="mt-2 line-clamp-2 text-xs font-medium text-text-primary">{title}</p>
      {subtitle && <p className="mt-0.5 line-clamp-1 text-[11px] text-text-muted">{subtitle}</p>}
      {progress != null && <Progress value={progress} className="mt-2" />}
    </button>
  );
}

export function MediaRow({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      <div className="mt-4 flex gap-4 overflow-x-auto pb-2">
        {children}
      </div>
    </section>
  );
}
