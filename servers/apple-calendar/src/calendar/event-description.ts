/** Build / merge Apple Calendar DESCRIPTION (notes + optional Maps URL). */

const MAPS_URL_LINE =
  /^(?:https?:\/\/)?(?:(?:www\.)?google\.[^/\s]+\/maps|maps\.google\.[^/\s]+|maps\.app\.goo\.gl|goo\.gl\/maps)\S*$/i;

export function assembleEventDescription(opts: {
  notes?: string | null;
  mapsUrl?: string | null;
}): string | undefined {
  const parts: string[] = [];
  const notes = opts.notes?.trim();
  if (notes) parts.push(notes);
  const url = opts.mapsUrl?.trim();
  if (url) parts.push(url);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Drop lines that are Google Maps links so we can re-append a fresh URL. */
export function stripMapsUrlsFromDescription(
  description: string | null | undefined,
): string | undefined {
  if (!description) return undefined;
  const kept = description
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !MAPS_URL_LINE.test(t);
    });
  if (kept.length === 0) return undefined;
  return kept.join("\n");
}

/**
 * Ensure DESCRIPTION keeps free-text notes and includes `mapsUrl` when set.
 * `explicitNotes` replaces the free-text portion when provided (including "").
 */
export function mergeEventDescription(opts: {
  existingDescription?: string | null;
  explicitNotes?: string | null;
  mapsUrl?: string | null;
}): string | undefined {
  const notes =
    opts.explicitNotes !== undefined
      ? opts.explicitNotes
      : stripMapsUrlsFromDescription(opts.existingDescription);
  return assembleEventDescription({
    notes,
    mapsUrl: opts.mapsUrl,
  });
}
