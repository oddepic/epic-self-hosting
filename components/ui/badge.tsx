import type { HTMLAttributes } from "react";

export default function Badge({ className = "", ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-text-secondary ${className}`}
      {...props}
    />
  );
}
