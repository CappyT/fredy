/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mockFredy } from './utils.js';
import * as mockStore from './mocks/mockStore.js';
import { getPriceChanges, reset as resetNotification } from './mocks/mockNotification.js';

/**
 * The link-identity check in `_findNew`.
 *
 * A listing's hash is built over the advert id and its price, so an advert that changed its price
 * hashed differently and used to be stored a second time under the link the job already held -
 * notified as a new flat, the stale row left active beside it. The check now recognises the
 * advert by its link and hands it to the price-change lane: one history row, one updated row, one
 * notification about the price, and nothing stored again.
 */
describe('pipeline - an advert the job knows by link is a price change, not a new listing', () => {
  const oldListing = {
    id: 'hash-of-249k',
    title: 'Appartamento via Roma',
    link: 'https://www.immobiliare.it/annunci/132180714/',
    price: 249000,
    job_id: 'job-1',
    provider: 'test-provider',
  };

  /** @returns {Object} a pipeline configuration carrying one listing whose link matches the stored one */
  const configWith = (listing) => ({
    url: 'http://example.com',
    getListings: () => Promise.resolve([listing]),
    normalize: (l) => l,
    filter: () => true,
    requiredFieldNames: ['id', 'title', 'link'],
  });

  const runOnePass = async (providerConfig) => {
    const Fredy = await mockFredy();
    const fredy = new Fredy(
      providerConfig,
      { id: 'job-1', notificationAdapter: [{ id: 'mock-adapter' }] },
      'test-provider',
      { checkAndAddEntry: () => false },
      undefined,
    );
    try {
      await fredy.execute();
    } catch {
      // NoNewListingsWarning is control flow, not an error.
    }
  };

  beforeEach(() => {
    mockStore.resetListings();
    resetNotification();
    mockStore.setUserSettings({ provider_details: [] });
    mockStore.setGeocodeResult(null);
    // A copy: the store moves the stored row onto the new price and hash the way the real table
    // does, and the template above is shared by every case in this suite.
    mockStore.storeListings('job-1', 'test-provider', [{ ...oldListing }]);
  });

  it('moves the new price onto the stored row instead of storing the advert again', async () => {
    await runOnePass(configWith({ id: 'hash-of-239k', title: oldListing.title, link: oldListing.link, price: 239000 }));

    // The stored row is still the one from before, now carrying the price the portal answers with
    // and the hash that price produces.
    expect(mockStore.appliedPriceChanges).toEqual([
      { listingId: 'hash-of-249k', newPrice: 239000, changedAt: expect.any(Number), newHash: 'hash-of-239k' },
    ]);
    expect(mockStore.recordedPriceObservations).toEqual([
      { listingId: 'hash-of-249k', price: 239000, observedAt: expect.any(Number), source: 'scrape' },
    ]);
  });

  it('reports the change through the price-change lane, not as a new flat', async () => {
    await runOnePass(configWith({ id: 'hash-of-239k', title: oldListing.title, link: oldListing.link, price: 239000 }));

    const notifications = getPriceChanges();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].priceChanges).toHaveLength(1);
    // The adapter receives the change already formatted for the job owner's language.
    expect(notifications[0].priceChanges[0]).toMatchObject({
      oldPrice: '249000 €',
      newPrice: '239000 €',
      direction: 'down',
    });
  });

  it('does nothing when the price the portal answers with is the one already stored', async () => {
    await runOnePass(
      configWith({ id: 'hash-of-249k-again', title: oldListing.title, link: oldListing.link, price: 249000 }),
    );

    expect(mockStore.recordedPriceObservations).toEqual([]);
    expect(getPriceChanges()).toEqual([]);
    expect(mockStore.appliedPriceChanges).toEqual([]);
  });

  it('still moves the row onto the new name when only the price probe had moved its price', async () => {
    // The probe reads a detail page and knows no hash, so the row it moved carries the price of one
    // reading and the hash of another. The scrape arrives with both and is told the price has not
    // changed: without the rename the row keeps a name the portal no longer answers with, drops
    // through the link lane on every single run, and loses any later return to its earlier price to
    // the hash lane.
    await runOnePass(
      configWith({ id: 'hash-of-249k-again', title: oldListing.title, link: oldListing.link, price: 249000 }),
    );

    expect(mockStore.renamedHashes).toEqual([{ listingId: 'hash-of-249k', newHash: 'hash-of-249k-again' }]);
    // A rename is not a reading: nothing on the chart, nothing sent to anybody.
    expect(mockStore.recordedPriceObservations).toEqual([]);
    expect(getPriceChanges()).toEqual([]);
  });

  it('stores an advert the job has never seen, whatever its hash', async () => {
    const brandNew = {
      id: 'hash-of-other-flat',
      title: 'Other flat',
      link: 'https://www.immobiliare.it/annunci/2/',
      price: 300000,
    };
    await runOnePass(configWith(brandNew));

    expect(mockStore.appliedPriceChanges).toEqual([]);
    const stored = mockStore.getKnownListingHashesForJob('job-1');
    expect(stored).toContain('hash-of-other-flat');
  });

  it('moves the row onto the new hash, so a return to the old price is a change and not a nothing', async () => {
    await runOnePass(configWith({ id: 'hash-of-239k', title: oldListing.title, link: oldListing.link, price: 239000 }));
    // The portal puts the price back up. Its hash is the one the row used to carry, so a row left
    // on its old hash would have this filtered out by the hash lane before the link lane saw it.
    await runOnePass(configWith({ id: 'hash-of-249k', title: oldListing.title, link: oldListing.link, price: 249000 }));

    expect(mockStore.appliedPriceChanges).toEqual([
      { listingId: 'hash-of-249k', newPrice: 239000, changedAt: expect.any(Number), newHash: 'hash-of-239k' },
      { listingId: 'hash-of-239k', newPrice: 249000, changedAt: expect.any(Number), newHash: 'hash-of-249k' },
    ]);
  });

  it('stores a reposted advert again when the alive-checker had declared the row gone', async () => {
    // Nothing turns is_active back on by itself, so a repost absorbed into the dead row would be
    // announced as a price drop on a listing the view no longer shows, and never stored again.
    mockStore.storeListings('job-1', 'test-provider', [{ ...oldListing, is_active: 0 }]);

    await runOnePass(
      configWith({ id: 'hash-of-repost', title: oldListing.title, link: oldListing.link, price: 239000 }),
    );

    expect(mockStore.appliedPriceChanges).toEqual([]);
    expect(mockStore.getKnownListingHashesForJob('job-1')).toContain('hash-of-repost');
  });

  it('stores a repost that comes back at the very price the dead row carried', async () => {
    // The repost hashes exactly like the row the alive-checker buried. While the hash lane still
    // remembered dead rows this was filtered out before the link lane ever saw it, so the advert
    // was neither stored nor brought back - it simply vanished from the job for good.
    mockStore.storeListings('job-1', 'test-provider', [{ ...oldListing, is_active: 0 }]);

    await runOnePass(configWith({ id: 'hash-of-249k', title: oldListing.title, link: oldListing.link, price: 249000 }));

    expect(mockStore.appliedPriceChanges).toEqual([]);
    expect(mockStore.getKnownListingHashesForJob('job-1')).toContain('hash-of-249k');
  });

  it("reads a return to a dead row's price as a change on the live row, not as nothing", async () => {
    // Two rows carry the link: the corpse at 249k and the row the repost at 239k created. The
    // portal puts the price back to 249k, whose hash is the corpse's - and a hash lane that still
    // remembered the corpse dropped the reading before the link lane could recognise the live row.
    mockStore.storeListings('job-1', 'test-provider', [
      { ...oldListing, is_active: 0, created_at: 1 },
      { ...oldListing, id: 'hash-of-239k', price: 239000, created_at: 2 },
    ]);

    await runOnePass(configWith({ id: 'hash-of-249k', title: oldListing.title, link: oldListing.link, price: 249000 }));

    expect(mockStore.appliedPriceChanges).toEqual([
      { listingId: 'hash-of-239k', newPrice: 249000, changedAt: expect.any(Number), newHash: 'hash-of-249k' },
    ]);
  });

  it('keeps treating a hidden listing as new, so a scrape never moves it', async () => {
    // The only row carrying the link is the one the user hid; the real query leaves it out.
    mockStore.storeListings('job-1', 'test-provider', [{ ...oldListing, manually_deleted: 1 }]);

    await runOnePass(
      configWith({ id: 'hash-of-hidden-flat', title: oldListing.title, link: oldListing.link, price: 239000 }),
    );

    expect(mockStore.appliedPriceChanges).toEqual([]);
    expect(mockStore.getKnownListingHashesForJob('job-1')).toContain('hash-of-hidden-flat');
  });
});
