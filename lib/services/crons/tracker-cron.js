/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import cron from 'node-cron';
import { inDevMode } from '../../utils.js';
import { trackMainEvent } from '../tracking/Tracker.js';
import { getSettings } from '../storage/settingsStorage.js';

async function runTask() {
  const settings = await getSettings();
  //make sure to only send tracking events if the user gave us the green light and we are not in dev mode
  if (settings.analyticsEnabled && !inDevMode()) {
    await trackMainEvent();
  }
}

/**
 * Report this instance once now, then every eight hours.
 *
 * Sends nothing unless the user turned analytics on, and nothing at all in dev mode - the check
 * lives in the task rather than here, so the schedule follows a setting changed after startup.
 *
 * @returns {Promise<void>}
 */
export async function initTrackerCron() {
  //run directly on start
  await runTask();
  // then every 8 hours
  cron.schedule('0 */8 * * *', runTask);
}
