import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";

interface BadgeProps {
  children: ReactNode;
  variant?: "default" | "success" | "error" | "warn" | "info" | "tool" | "step" | "neutral";
  className?: string;
}

const variantClass: Record<NonNullable<BadgeProps["variant"]>, string> = {
  default: "bg-accent/20 text-accent border-accent/30",
  success: "bg-ev-success/15 text-ev-success border-ev-success/30",
  error: "bg-ev-error/15 text-ev-error border-ev-error/30",
  warn: "bg-ev-warn/15 text-ev-warn border-ev-warn/30",
  info: "bg-ev-info/15 text-ev-info border-ev-info/30",
  tool: "bg-ev-tool/15 text-ev-tool border-ev-tool/30",
  step: "bg-ev-step/15 text-ev-step border-ev-step/30",
  neutral: "bg-ev-checkpoint/15 text-ev-checkpoint border-ev-checkpoint/30",
};

export function Badge({ children, variant = "default", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-xs font-medium",
        variantClass[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
