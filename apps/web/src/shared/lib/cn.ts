/** Minimal className merge helper — avoids adding clsx as a dependency. */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}
