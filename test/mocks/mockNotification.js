/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

let tmpStore = {};

let priceChangeStore = [];

export const send = (serviceName, payload) => {
  tmpStore = { serviceName, payload };
  return [Promise.resolve()];
};

export const get = () => {
  return tmpStore;
};

export const sendPriceChange = (serviceName, priceChanges, notificationConfig, jobKey, baseUrl) => {
  priceChangeStore.push({ serviceName, priceChanges, notificationConfig, jobKey, baseUrl });
  return [Promise.resolve()];
};

export const getPriceChanges = () => priceChangeStore;

/**
 * Forget the last notification.
 *
 * Needed by any test asserting that nothing was sent: without it the previous test's payload is
 * still here, and "no notification" reads exactly like "the one from before".
 */
export const reset = () => {
  tmpStore = {};
  priceChangeStore = [];
};
