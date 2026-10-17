"use client";

import type { LocationFreshness } from "@geo/shared";
import { FRESHNESS_HINT, FRESHNESS_LABEL } from "@/lib/format";

const CLASS_BY_FRESHNESS: Record<LocationFreshness, string> = {
  CURRENT: "badge badge-current",
  STALE: "badge badge-stale",
  OFFLINE: "badge badge-offline",
  UNKNOWN: "badge badge-unknown",
};

export function FreshnessBadge({
  freshness,
  ageText,
}: {
  freshness: LocationFreshness;
  ageText?: string;
}) {
  return (
    <span
      className={CLASS_BY_FRESHNESS[freshness]}
      title={FRESHNESS_HINT[freshness]}
    >
      {FRESHNESS_LABEL[freshness]}
      {ageText ? ` · ${ageText}` : ""}
    </span>
  );
}
