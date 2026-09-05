/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Download a listing photograph and hand back what it takes to keep it.
 *
 * The portals serve their photographs from public CDNs, so a plain request with a browser's
 * clothes is all it takes - the same request the listing page makes when it renders. Every
 * failure mode collapses into null: a bot wall, an expired signature, a body that is not an
 * image, a photograph too large to want. The caller treats null as "not this time" rather than
 * as data, because a failed download stored as bytes would be a broken image served forever.
 */

/** A browser's user agent - the CDNs are built for browsers, not for scripts. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** How long one download may take before it counts as failed. */
const FETCH_TIMEOUT_MS = 10_000;

/** A photograph larger than this is not a photograph; it is a mistake worth refusing. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * @param {string|undefined} contentType the response's content-type header
 * @returns {boolean} whether the body claims to be an image
 */
function isImageContentType(contentType) {
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('image/');
}

/**
 * Fetch an image and reduce it to its content type and bytes.
 *
 * @param {string|null|undefined} imageUrl The url as the portal signed it.
 * @returns {Promise<{mimeType: string, bytes: Buffer}|null>} The image, or null when it could
 *   not be fetched, is not an image, or is too large to keep.
 */
export async function fetchListingImage(imageUrl) {
  if (!imageUrl) return null;

  let response;
  try {
    response = await fetch(imageUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    // A dropped connection or a timeout is the same "not this time" as any other failure.
    return null;
  }

  if (!response.ok || !isImageContentType(response.headers.get('content-type'))) return null;

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) return null;

  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_BYTES) return null;
    return { mimeType: response.headers.get('content-type').split(';')[0].trim(), bytes: buffer };
  } catch {
    return null;
  }
}
