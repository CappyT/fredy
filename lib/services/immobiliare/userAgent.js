/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The user agent the Immobiliare.it android app sends.
 *
 * Every call to the app's hosts wears it: the search api, the geography service and the detail api.
 * They answer a request without it, but a client that does not look like the app is the one a bot
 * guard watches for. The values are the device's - a Pixel 7a on Android 17, app version 26.14.0.
 *
 * @type {string}
 */
export const USER_AGENT =
  'WSCommand3<Furious>|REL|PRD|1080,2400,2.625|26.14.0|ANDROID|Google Pixel 7a|17|PHO|2.0-01/09/2016-16:40|0|0';
