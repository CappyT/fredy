/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getListingImage } from '../services/storage/listingsStorage.js';

/**
 * The image types a vision model will accept.
 * @type {Set<string>}
 */
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * How many leading bytes every signature below needs. WEBP's is the longest, at twelve.
 * @type {number}
 */
const IMAGE_HEADER_BYTES = 12;

/**
 * Decide what an image actually is, preferring the declared type and falling back to its bytes.
 *
 * A stored blob whose recorded content type the portal got wrong is the same problem as a portal
 * serving `application/octet-stream`, and a vision model refuses a mime type it does not know.
 * Returns null when the bytes are of no format a model reads, which is the caller's cue to say so
 * rather than to hand over something unusable.
 *
 * @param {string|null|undefined} declaredMimeType What the stored row calls it.
 * @param {Uint8Array|Buffer} bytes At least {@link IMAGE_HEADER_BYTES} of the image.
 * @returns {string|null} The resolved mime type, or null when it is not one a model accepts.
 */
function resolveImageMimeType(declaredMimeType, bytes) {
  const declared = (declaredMimeType ?? '').split(';')[0].trim().toLowerCase();
  if (SUPPORTED_IMAGE_MIME_TYPES.has(declared)) return declared;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * The photograph Fredy kept for a listing, as the `get_photo_for_listing` tool result.
 *
 * The bytes Fredy kept when it stored the listing come first, exactly as the image route serves
 * them. The url on the row is a rental - idealista signs its cloudfront links for about a day - so
 * fetching it was guaranteed to answer 403 on precisely the adverts this instance already holds a
 * photograph of.
 *
 * Returns null when nothing usable was kept: no stored row, too few bytes to identify, or a format
 * no vision model reads. The tool then falls back to fetching the listing's image url. Call it only
 * after the access check, since it does not look at who is asking.
 *
 * @param {string} listingId The listing's row id.
 * @returns {{content: Array<{type: 'image', data: string, mimeType: string}>}|null}
 */
export function getStoredListingPhoto(listingId) {
  const stored = getListingImage(listingId);
  if (stored?.bytes == null || stored.bytes.length < IMAGE_HEADER_BYTES) return null;
  const mimeType = resolveImageMimeType(stored.mime_type, stored.bytes);
  if (mimeType == null) return null;
  return {
    content: [{ type: 'image', data: Buffer.from(stored.bytes).toString('base64'), mimeType }],
  };
}
