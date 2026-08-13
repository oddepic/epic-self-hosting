interface Props {
  value: number;
  className?: string;
}

export default function Progress({ value, className = "" }: Props) {
  return (
    <div className={`h-1.5 overflow-hidden rounded-full bg-surface-hover ${className}`}>
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}
