import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-background hover:bg-accent-hover active:bg-accent",
  secondary: "border border-border-strong bg-surface text-text-primary hover:bg-surface-hover active:bg-surface",
  ghost: "text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface",
  danger: "bg-danger/15 text-danger hover:bg-danger/25 active:bg-danger/15",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export default function Button({ variant = "secondary", className = "", ...props }: Props) {
  return (
    <button
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}
