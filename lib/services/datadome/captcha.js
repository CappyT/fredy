/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The wall DataDome puts in front of a page, and how to clear it.
 *
 * When DataDome decides not to trust a request, the document a browser gets is
 * replaced by the interstitial. It comes in two shapes: one that runs its
 * check in place and reloads the page on a pass - nothing to drag, only a
 * navigation to wait out - and the captcha proper, whose challenge lives in a
 * cross-origin iframe served by `captcha-delivery.com`. The simple captcha
 * variant draws a handle on a track and asks for one drag to the right; the
 * verdict comes from a GET of `/captcha/check`, whose answer carries the
 * cookie that clears the wall.
 *
 * That verdict is judged on the trajectory as much as on the landing, so the
 * drag follows the shape of a hundred measured human drags: the mouse wanders
 * onto the handle, presses the moment it arrives, covers the track in bursts
 * of moves 7-14ms apart with a pause or two on the way, peaks in speed early
 * and decelerates over the last fifth, drifts across the handle's height, and
 * releases some tens of pixels past the end of the track.
 *
 * A pass is honoured per navigation. The reload the interstitial performs on
 * its own is where the cookie is spent, but a host that still distrusts the
 * client answers that reload with a fresh challenge - so the solver goes
 * around again, for as many rounds as it is allowed, until the page behind
 * the wall is the one that stays.
 *
 * What the looking costs is kept down by the answer the navigation already
 * gave. A page that answered 403 may well be walled, and gets the full wait
 * for the challenge to appear; a page that answered as content is only
 * probed briefly, because a challenge can still ride on a 200 however rarely.
 * Callers that held on to the navigation's response should hand it over so
 * the distinction can be made - a provider rendering twenty clean pages in a
 * walk would otherwise pay the full window on each of them.
 *
 * The measured layout this was built against:
 *   #captcha__frame.simple > #captcha__frame__bottom > .sliderContainer
 *     .sliderbg / .sliderMask / .sliderTarget (fixed right) / .slider (handle)
 *   success marks the container `.slider-success`, a refusal `.slider-error`,
 *   and `#captcha__reload__button` deals a fresh challenge.
 */

import { sleep } from '../../utils.js';
import logger from '../logger.js';

/** The iframe host the challenge is served from. */
const CAPTCHA_FRAME_HOST = 'captcha-delivery.com';

/** How long the challenge iframe may take to appear after a blocked navigation. */
const FRAME_WAIT_MS = 8000;

/**
 * How long a page that answered as content is probed for a challenge anyway.
 *
 * The frame an interstitial inserts is there by the time the navigation
 * resolves, so a short probe covers the rare 200 that carried one without
 * taxing every clean page render with the full window.
 */
const CONTENT_PROBE_MS = 500;

/** How long the slider handle may take to render inside the iframe. */
const HANDLE_WAIT_MS = 10000;

/** How long to wait for the verdict after a release. */
const RESULT_WAIT_MS = 6000;

/** How long the reload the success triggers may take to bring the real page back. */
const RESUME_WAIT_MS = 20000;

/** Sliders tried per challenge before that challenge is given up on. */
const MAX_ATTEMPTS = 3;

/** Challenges faced before conceding that the wall will not lift. */
const MAX_ROUNDS = 3;

/** The polling rhythm of every wait in this file. */
const POLL_EVERY_MS = 250;

/**
 * How much longer than the frame wait a self-clearing reload may take to arrive.
 *
 * The navigation watch has to outlive the wait for the challenge frame: a wall
 * that decides to lift itself right at the end of that window reloads just as
 * the solver is giving up on finding a slider, and that reload is the very
 * thing the watch exists to catch.
 */
const SELF_CLEAR_SLACK_MS = 2000;

/**
 * Repeat a probe until it holds true or the time runs out.
 *
 * @param {() => Promise<boolean>} probe the condition, re-read every poll
 * @param {{timeout: number, delayFn?: (ms: number) => Promise<void>}} options
 * @returns {Promise<boolean>} whether the probe ever held
 */
async function until(probe, { timeout, delayFn = sleep }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await delayFn(POLL_EVERY_MS);
  }
  return false;
}

/**
 * @param {number} min inclusive floor
 * @param {number} span how far above it the draw may land
 * @returns {number} a whole number in `[min, min + span)`
 */
function draw(min, span) {
  return min + Math.floor(Math.random() * span);
}

/**
 * Find the challenge iframe among the page's frames, waiting for it to arrive.
 * Always probed once, whatever the wait: a zero timeout asks "is one there
 * now", not "wait for nothing".
 *
 * @param {import('puppeteer-core').Page} page
 * @param {{timeout?: number, delayFn?: (ms: number) => Promise<void>}} [options]
 * @returns {Promise<import('puppeteer-core').Frame|undefined>} the frame, or
 *   undefined when the page carries no challenge within the wait
 */
async function challengeFrame(page, options = {}) {
  const delayFn = options.delayFn ?? sleep;
  const find = () =>
    page.frames().find((candidate) => candidate !== page.mainFrame() && candidate.url().includes(CAPTCHA_FRAME_HOST));
  const deadline = Date.now() + (options.timeout ?? FRAME_WAIT_MS);
  for (;;) {
    const frame = find();
    if (frame != null && !frame.detached) return frame;
    if (Date.now() >= deadline) return undefined;
    await delayFn(POLL_EVERY_MS);
  }
}

/**
 * Whether the challenge in front of the page has been cleared. Success
 * announces itself twice over: the container is marked, and then the whole
 * interstitial is reloaded away - by which time the frame is detached or gone
 * from the page, which is itself the success signature.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {import('puppeteer-core').Frame} frame the challenge frame
 * @returns {Promise<boolean>}
 */
async function isPassed(page, frame) {
  if (frame.detached || !page.frames().includes(frame)) return true;
  return (await frame.$('.sliderContainer.slider-success').catch(() => null)) != null;
}

/**
 * Walk the handle from where it rests to past the end of the track, on the
 * shape of a hundred measured human drags.
 *
 * What the measurements said: the drag itself runs 600-1100ms and some fifty
 * moves, the pointer travelling the track and a little past its end. The
 * moves stream 7-14ms apart in bursts, interrupted once or twice by a pause
 * of a few hundred milliseconds; the speed peaks early, holds, and decelerates
 * sharply over the last fifth; the pointer drifts across the handle's height
 * as it goes and is released some tens of pixels past the end, right after
 * the last movement.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {{x: number, y: number, width: number, height: number}} handle where the handle sits, in
 *   viewport coordinates
 * @param {number} distance how far the track runs, in pixels
 * @param {(ms: number) => Promise<void>} delayFn
 * @returns {Promise<void>}
 */
async function dragHandle(page, handle, distance, delayFn) {
  const startX = handle.x + handle.width / 2;
  const startY = handle.y + handle.height / 2;

  // The hand finds the handle rather than teleporting onto it, and presses
  // the moment it arrives.
  let x = startX - draw(60, 140);
  let y = startY + draw(-30, 60);
  await page.mouse.move(x, y);
  const approachSteps = draw(20, 40);
  const approachStepMs = draw(300, 600) / approachSteps;
  for (let step = 1; step <= approachSteps; step++) {
    await delayFn(approachStepMs);
    const remaining = approachSteps - step + 1;
    x += (startX - x) / remaining;
    y += (startY - y) / remaining;
    await page.mouse.move(x + Math.random() * 4 - 2, y + Math.random() * 4 - 2);
  }

  await page.mouse.down();

  const overshoot = draw(15, 80);
  const target = distance + overshoot;
  const wobbleAmp = draw(5, 14);
  const wobblePeriod = draw(400, 900);
  // One or two pauses of a few hundred milliseconds, somewhere along the way.
  let pausesLeft = draw(1, 3);
  let nextPauseAt = draw(40, 160);

  let travelled = 0;
  while (travelled < target) {
    if (pausesLeft > 0 && travelled >= nextPauseAt) {
      pausesLeft -= 1;
      await delayFn(draw(100, 350));
      nextPauseAt = travelled + draw(60, 200);
      continue;
    }
    const stepMs = Math.random() < 0.85 ? draw(5, 10) : draw(10, 18);
    await delayFn(stepMs);
    // Fast out of the press, held through the middle, decelerating hard over
    // the last fifth - with a fifth again of variance on top of it all. The
    // progress stops at the end of the track: the overshoot beyond it is
    // walked at the ending pace, not extrapolated past it into reverse.
    const progress = Math.min(1, travelled / distance);
    const base = progress < 0.15 ? 0.75 : progress < 0.8 ? 0.62 : 0.35 - 0.2 * ((progress - 0.8) / 0.2);
    const speed = base * (draw(80, 125) / 100);
    travelled = Math.min(target, travelled + speed * stepMs);
    const phase = (2 * Math.PI * travelled) / wobblePeriod;
    await page.mouse.move(startX + travelled, startY + Math.sin(phase) * wobbleAmp + (Math.random() - 0.5));
  }

  await delayFn(draw(10, 90));
  await page.mouse.up();

  // The hand keeps drifting for a breath after the release.
  const drift = draw(3, 9);
  for (let step = 0; step < drift; step++) {
    await delayFn(draw(20, 60));
    x += Math.random() * 4;
    y += Math.random() * 6 - 3;
    await page.mouse.move(x, y);
  }
}

/**
 * Clear one challenge: drag the slider, and when it is refused deal a fresh
 * one and try again, for as many attempts as the challenge is given.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {import('puppeteer-core').Frame} frame the challenge frame
 * @param {{attempts: number, handleWaitMs: number, resultWaitMs: number, delayFn: (ms: number) => Promise<void>}} options
 * @returns {Promise<boolean>} whether the challenge ended cleared
 */
async function clearSlider(page, frame, { attempts, handleWaitMs, resultWaitMs, delayFn }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const handle = await frame.waitForSelector('.sliderContainer .slider', { timeout: handleWaitMs }).catch(() => null);
    if (handle == null) {
      if (await isPassed(page, frame)) return true;
      logger.warn('DataDome captcha is not the simple slider; leaving it alone.');
      return false;
    }

    const container = await (await frame.$('.sliderContainer')).boundingBox().catch(() => null);
    const box = await handle.boundingBox().catch(() => null);
    if (container == null || box == null) {
      logger.warn('DataDome slider found but could not be measured.');
      return false;
    }

    // Reading time: a person who has just been challenged does not drag at once.
    await delayFn(draw(1800, 3200));
    await dragHandle(page, box, container.width - box.width, delayFn);

    if (await until(() => isPassed(page, frame), { timeout: resultWaitMs, delayFn })) return true;

    logger.warn(`DataDome slider refused attempt ${attempt} of ${attempts}; dealing a fresh one.`);
    const reload = await frame.$('#captcha__reload__button');
    if (reload != null) await reload.click().catch(() => {});
    await delayFn(draw(1500, 1500));
  }
  return await isPassed(page, frame);
}

/**
 * Read the http status of a navigation, when the caller handed one over.
 *
 * @param {any} response the response `page.goto` resolved with, if it was kept
 * @returns {number|null} the status, or null when there is no response to read
 */
function readStatus(response) {
  try {
    return typeof response?.status === 'function' ? response.status() : null;
  } catch {
    return null;
  }
}

/**
 * Watch for the wall clearing itself.
 *
 * The interstitial DataDome answers a browser with runs its check in the page
 * and reloads on a pass - no slider to drag, only a navigation to wait for. A
 * navigation of the main frame is that reload: the page behind the wall is
 * what arrives on it.
 *
 * The promise always settles on its own, `false` once the window runs out, so
 * a caller that finds a slider and never looks at the watch again leaves
 * nothing dangling behind it.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {number} waitMs how long the reload may take to arrive
 * @returns {Promise<boolean>|null} whether the page reloaded, or null when the wait is too short to watch
 */
function watchSelfClear(page, waitMs) {
  if (waitMs <= 0) return null;
  try {
    return page.waitForNavigation({ timeout: waitMs + SELF_CLEAR_SLACK_MS, waitUntil: 'domcontentloaded' }).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * Give the traffic behind a cleared wall a moment to settle before the document is read.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<void>}
 */
async function settle(page) {
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 10_000 }).catch(() => {});
}

/**
 * Clear a DataDome wall, if one is blocking the page.
 *
 * @param {import('puppeteer-core').Page} page the page whose render is being read
 * @param {{response?: any, attempts?: number, rounds?: number, delayFn?: (ms: number) => Promise<void>,
 *   frameWaitMs?: number, handleWaitMs?: number, resultWaitMs?: number,
 *   resumeWaitMs?: number}} [options] `response` is the navigation's own answer and decides how
 *   long the challenge is waited for: a 403 may be the wall and gets the full window, anything
 *   else is probed briefly. `delayFn` and the wait windows exist for the tests, which run the
 *   walk without sitting through it
 * @returns {Promise<boolean>} true when a wall was cleared and the page behind it held, so the
 *   caller may trust the document it reads next; false when there was nothing to clear or the
 *   wall would not lift
 */
export async function solveCaptcha(page, options = {}) {
  const delayFn = options.delayFn ?? sleep;
  const status = readStatus(options.response);
  const walled = status === 403;
  const frameWaitMs = options.frameWaitMs ?? (status != null && !walled ? CONTENT_PROBE_MS : FRAME_WAIT_MS);
  const resumeWaitMs = options.resumeWaitMs ?? RESUME_WAIT_MS;
  const rounds = options.rounds ?? MAX_ROUNDS;
  const gone = async () => (await challengeFrame(page, { timeout: 0, delayFn })) == null;

  // Only a page that answered as the wall can be one that lifts itself, which
  // is why the watch is armed on the same wait the challenge frame gets.
  const selfClear = walled ? watchSelfClear(page, frameWaitMs) : null;

  let first = true;
  for (let round = 1; round <= rounds; round++) {
    const frame = await challengeFrame(page, { timeout: first ? frameWaitMs : 0, delayFn });
    if (frame == null) {
      // No slider ever came. On a page that answered as the wall that may be
      // the other shape of it: one that runs its check in place and reloads
      // on a pass, which is what the watch is for.
      if (first && selfClear != null && (await selfClear)) {
        logger.info('DataDome lifted its wall on its own; waiting for the page behind it.');
        await settle(page);
        return await gone();
      }
      return !first;
    }
    first = false;
    logger.warn(`DataDome captcha encountered (round ${round}); trying the slider.`);

    const cleared = await clearSlider(page, frame, {
      attempts: options.attempts ?? MAX_ATTEMPTS,
      handleWaitMs: options.handleWaitMs ?? HANDLE_WAIT_MS,
      resultWaitMs: options.resultWaitMs ?? RESULT_WAIT_MS,
      delayFn,
    });
    if (!cleared) return false;

    logger.info('DataDome captcha passed; waiting for the page behind it.');
    // The pass reloads the page out from under the iframe; the document is
    // only worth reading once the challenge is gone from it and the traffic
    // settled. A host that re-challenges the reload answers with a fresh
    // frame, and the loop goes around again.
    await until(gone, { timeout: resumeWaitMs, delayFn });
    await settle(page);
  }
  // Every round was spent on a challenge. The honest answer to "may the
  // document be read now" is whatever is standing in front of the page: a
  // wall that re-armed after its last clear left it blocked, one that did
  // not left it readable.
  return await gone();
}
