"use client";

import { useMeta } from "@/components/ui";
import { DEMO_URL } from "@/lib/site";

/** "Try the demo" on the real app. Hidden on the demo itself (simulated chain). */
export function DemoCta({ className = "btn-secondary" }: { className?: string }) {
  const meta = useMeta();
  if (meta?.chain === "sim") return null;
  return (
    <a href={DEMO_URL} className={className} data-testid="demo-link">
      Try the demo · no ZEC needed
    </a>
  );
}
