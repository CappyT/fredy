/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { Button, TimePicker, Checkbox, Input, InputNumber, Select } from '@douyinfe/semi-ui-19';
import { IconAlertTriangle } from '@douyinfe/semi-icons';
import { useOutletContext } from 'react-router';
import { useMemo } from 'react';

import { SegmentPart } from '../../../components/segment/SegmentPart';
import SettingsSaveBar from '../../../components/settingsShell/SettingsSaveBar.jsx';
import AdminField from '../components/AdminField.jsx';
import { useUnsavedWarning } from '../../../hooks/useUnsavedWarning.js';
import { useSelector } from '../../../services/state/store';
import { relativeTime } from '../../../services/time/relativeTime.js';
import { timeZoneOptions } from '../../../services/time/timeService';
import { flagFor } from '../../../services/countryFlags';
import {
  countriesFromProviders,
  randomSessionId,
  readIproyalOptions,
  writeIproyalOptions,
} from '../../../services/proxy/iproyal';
import './ExecutionPage.less';
import './iproyalProxy.less';

/** Country names in the reader's own language; the code itself when the browser has no name for it. */
function countryName(code) {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/**
 * @param {number} ts
 * @returns {string}
 */
function formatFromTimestamp(ts) {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * @param {string|null} time HH:mm as the backend stores it.
 * @returns {number|null}
 */
function formatFromTBackend(time) {
  if (time == null || time.length === 0) {
    return null;
  }
  const date = new Date();
  const split = time.split(':');
  date.setHours(split[0]);
  date.setMinutes(split[1]);
  return date.getTime();
}

/**
 * How often Fredy searches, within which hours, through which proxy, and whether it re-checks
 * prices afterwards.
 *
 * @returns {React.ReactElement}
 */
export default function ExecutionPage() {
  const { t, form, setField, setWorkingHour, executionDirty, savingExecution, saveExecution, discardExecution } =
    useOutletContext();
  const zones = useMemo(() => timeZoneOptions(form.workingHours.timeZone), [form.workingHours.timeZone]);
  const providers = useSelector((state) => state.provider);
  // Read back out of the url on every render rather than held beside it: the field stays the one
  // source of truth, so a password pasted by hand fills these controls in, and a control moved here
  // shows up in the field the operator can still read.
  const iproyal = readIproyalOptions(form.proxyUrl);
  const countryOptions = useMemo(
    () =>
      countriesFromProviders(providers).map((code) => ({
        value: code,
        label: `${flagFor(code)} ${countryName(code)}`,
      })),
    [providers],
  );
  const setIproyal = (patch) => setField('proxyUrl', writeIproyalOptions(form.proxyUrl, { ...iproyal, ...patch }));

  const nextRun = useSelector((state) => state.dashboard.data?.general?.nextRun);

  useUnsavedWarning(executionDirty);

  const summary = useMemo(() => {
    const { from, to, timeZone } = form.workingHours;
    const zone = timeZone ?? t('admin.execution.serverZone');
    const hasFrom = from != null && from !== '';
    const hasTo = to != null && to !== '';
    // One edge alone is not "around the clock": it is a window the save will refuse, and saying
    // otherwise here contradicted the toast that follows.
    if (hasFrom !== hasTo) {
      return t('settings.toastWorkingHoursIncomplete');
    }
    if (!hasFrom) {
      return t('admin.execution.summaryAllDay', { minutes: form.interval || '?' });
    }
    return t('admin.execution.summaryWindow', { minutes: form.interval || '?', from, to, zone });
  }, [form.interval, form.workingHours, t]);

  return (
    <div className="settingsShell__page">
      <SegmentPart
        name={t('admin.execution.searchRun')}
        // The working hours sit in this card too, and theirs is the explanation of what an empty
        // time zone means (the server's, which in Docker is UTC).
        helpText={`${t('settings.searchIntervalHelp')} ${t('settings.workingHoursHelp')}`}
        helpMode="popover"
        action={
          nextRun != null && nextRun !== 0 ? (
            <span className="settingsShell__cardFlag">
              {/* Green only while the promised run is still ahead. Past it, this is the page an
                  admin opens to find out why nothing runs, and a green dot beside "3 h ago" said
                  the opposite of the sidebar's amber one. */}
              <span
                className={`settingsShell__cardFlagDot${nextRun > Date.now() ? ' settingsShell__cardFlagDot--ok' : ''}`}
                aria-hidden="true"
              />
              {t('nav.nextRun', { time: relativeTime(nextRun, t) })}
            </span>
          ) : null
        }
      >
        <div className="executionPage__line">
          <span className="executionPage__caption">{t('admin.execution.every')}</span>
          <span className="adminRow__control">
            <InputNumber
              id="interval"
              min={5}
              max={1440}
              aria-label={t('settings.searchInterval')}
              placeholder={t('settings.searchIntervalPlaceholder')}
              value={form.interval}
              formatter={(value) => `${value}`.replace(/\D/g, '')}
              onChange={(value) => setField('interval', value)}
              suffix={t('settings.searchIntervalSuffix')}
            />
          </span>
        </div>

        <div className="executionPage__line">
          <span className="executionPage__caption">{t('admin.execution.between')}</span>
          <TimePicker
            format={'HH:mm'}
            className="executionPage__time"
            value={formatFromTBackend(form.workingHours.from)}
            placeholder={t('settings.workingHoursFrom')}
            onChange={(val) => setWorkingHour('from', val == null ? null : formatFromTimestamp(val))}
          />
          <span className="executionPage__caption executionPage__caption--inline">{t('admin.execution.and')}</span>
          <TimePicker
            format={'HH:mm'}
            className="executionPage__time"
            value={formatFromTBackend(form.workingHours.to)}
            placeholder={t('settings.workingHoursUntil')}
            onChange={(val) => setWorkingHour('to', val == null ? null : formatFromTimestamp(val))}
          />
        </div>

        <div className="executionPage__line">
          <span className="executionPage__caption">{t('settings.workingHoursTimeZone')}</span>
          <Select
            filter
            showClear
            className="executionPage__zone"
            optionList={zones}
            value={form.workingHours.timeZone ?? undefined}
            placeholder={t('settings.workingHoursTimeZonePlaceholder')}
            aria-label={t('settings.workingHoursTimeZone')}
            onChange={(val) => setWorkingHour('timeZone', val == null || val === '' ? null : val)}
          />
        </div>

        <div className="executionPage__summary">{summary}</div>
      </SegmentPart>

      <SegmentPart name={t('settings.proxyUrl')} helpText={t('settings.proxyUrlHelp')} helpMode="popover">
        <Input
          type="text"
          placeholder={t('settings.proxyUrlPlaceholder')}
          value={form.proxyUrl}
          onChange={(value) => setField('proxyUrl', value)}
        />

        {/*
          Only for IPRoyal, because only IPRoyal reads these out of the password. Another provider
          spells the same wishes differently, or offers them as separate endpoints, so showing the
          controls for one of them next to another provider's url would write a password that
          silently does nothing.
        */}
        {iproyal != null && (
          <>
            <div className="iproyalProxy__controls">
              <Select
                filter
                allowCreate
                showClear
                optionList={countryOptions}
                value={iproyal.country ?? undefined}
                placeholder={t('settings.proxyIproyalCountryAny')}
                insetLabel={t('settings.proxyIproyalCountry')}
                onChange={(value) => setIproyal({ country: value == null || value === '' ? null : value })}
                className="iproyalProxy__country"
              />
              <Select
                optionList={[
                  { value: 'rotating', label: t('settings.proxyIproyalRotating') },
                  { value: 'sticky', label: t('settings.proxyIproyalSticky') },
                ]}
                value={iproyal.sticky ? 'sticky' : 'rotating'}
                insetLabel={t('settings.proxyIproyalRotation')}
                // Five minutes when the operator has never set one: a sticky session with no
                // lifetime is held for IPRoyal's own default, which is not what the field then shows.
                onChange={(value) => setIproyal({ sticky: value === 'sticky', ttlMinutes: iproyal.ttlMinutes ?? 5 })}
                className="iproyalProxy__rotation"
              />
              {iproyal.sticky && (
                <>
                  <InputNumber
                    min={1}
                    max={1440}
                    insetLabel={t('settings.proxyIproyalTtl')}
                    suffix={t('settings.proxyIproyalTtlSuffix')}
                    value={iproyal.ttlMinutes ?? undefined}
                    onChange={(value) => setIproyal({ ttlMinutes: value })}
                    className="iproyalProxy__ttl"
                  />
                  <Button onClick={() => setIproyal({ sessionId: randomSessionId() })}>
                    {t('settings.proxyIproyalNewSession')}
                  </Button>
                </>
              )}
            </div>
            <div className="iproyalProxy__hint">{t('settings.proxyIproyalHint')}</div>
          </>
        )}
      </SegmentPart>

      {/*
        Under the proxy, because it depends on it: capsolver refuses a DataDome task without one, so
        a key on its own solves nothing.
      */}
      <SegmentPart name={t('settings.capsolverApiKey')} helpText={t('settings.capsolverApiKeyHelp')}>
        <Input
          mode="password"
          type="text"
          placeholder={t('settings.capsolverApiKeyPlaceholder')}
          value={form.capsolverApiKey}
          onChange={(value) => setField('capsolverApiKey', value)}
        />
      </SegmentPart>

      <SegmentPart
        name={t('settings.priceTracking')}
        helpText={
          <>
            {t('settings.priceTrackingHelp')}
            <span className="settingsShell__helpWarning">
              <IconAlertTriangle size="small" />
              <span>
                <strong>{t('settings.priceTrackingWarningTitle')}</strong> {t('settings.priceTrackingWarningBody')}{' '}
                {t('settings.priceTrackingWarningDefaults')}
              </span>
            </span>
          </>
        }
      >
        <Checkbox
          checked={form.priceTrackingEnabled}
          onChange={(e) => setField('priceTrackingEnabled', e.target.checked)}
        >
          {t('settings.priceTrackingEnabled')}
        </Checkbox>

        <div
          className={`settingsShell__subSettings${form.priceTrackingEnabled ? '' : ' settingsShell__subSettings--disabled'}`}
        >
          <AdminField
            label={t('settings.priceCheckInterval')}
            help={t('settings.priceCheckIntervalHelp')}
            htmlFor="priceCheckIntervalDays"
          >
            <InputNumber
              id="priceCheckIntervalDays"
              min={1}
              max={30}
              disabled={!form.priceTrackingEnabled}
              value={form.priceCheckIntervalDays}
              formatter={(value) => `${value}`.replace(/\D/g, '')}
              onChange={(value) => setField('priceCheckIntervalDays', value)}
              suffix={t('settings.listingRetentionSuffix')}
            />
          </AdminField>

          <AdminField
            label={t('settings.priceCheckLimit')}
            help={t('settings.priceCheckLimitHelp')}
            htmlFor="priceCheckLimitPerRun"
          >
            <InputNumber
              id="priceCheckLimitPerRun"
              min={1}
              max={500}
              disabled={!form.priceTrackingEnabled}
              value={form.priceCheckLimitPerRun}
              formatter={(value) => `${value}`.replace(/\D/g, '')}
              onChange={(value) => setField('priceCheckLimitPerRun', value)}
            />
          </AdminField>

          <AdminField
            label={t('settings.priceChangeThreshold')}
            help={t('settings.priceChangeThresholdHelp')}
            htmlFor="priceChangeThresholdPercent"
          >
            <InputNumber
              id="priceChangeThresholdPercent"
              min={0}
              max={50}
              step={0.5}
              disabled={!form.priceTrackingEnabled}
              value={form.priceChangeThresholdPercent}
              onChange={(value) => setField('priceChangeThresholdPercent', value)}
              suffix="%"
            />
          </AdminField>
        </div>
      </SegmentPart>

      <SettingsSaveBar
        dirty={executionDirty}
        saving={savingExecution}
        onSave={saveExecution}
        onDiscard={discardExecution}
      />
    </div>
  );
}

ExecutionPage.displayName = 'ExecutionPage';
