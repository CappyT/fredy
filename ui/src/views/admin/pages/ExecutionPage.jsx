/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { TimePicker, Button, Checkbox, Input, InputNumber, Banner, Select } from '@douyinfe/semi-ui-19';
import { IconSave } from '@douyinfe/semi-icons';
import { useOutletContext } from 'react-router';
import { useMemo } from 'react';

import { SegmentPart } from '../../../components/segment/SegmentPart';
import { timeZoneOptions } from '../../../services/time/timeService';
import { useSelector } from '../../../services/state/store';
import { flagFor } from '../../../services/countryFlags';
import {
  countriesFromProviders,
  randomSessionId,
  readIproyalOptions,
  writeIproyalOptions,
} from '../../../services/proxy/iproyal';

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
  const { t, form, setField, setWorkingHour, executionDirty, savingExecution, saveExecution } = useOutletContext();
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

  return (
    <div className="settingsShell__page">
      <SegmentPart name={t('settings.searchInterval')} helpText={t('settings.searchIntervalHelp')}>
        <InputNumber
          min={5}
          max={1440}
          placeholder={t('settings.searchIntervalPlaceholder')}
          value={form.interval}
          formatter={(value) => `${value}`.replace(/\D/g, '')}
          onChange={(value) => setField('interval', value)}
          suffix={t('settings.searchIntervalSuffix')}
          style={{ maxWidth: 200 }}
        />
      </SegmentPart>

      <SegmentPart name={t('settings.workingHours')} helpText={t('settings.workingHoursHelp')}>
        <div className="settingsShell__timePickerContainer">
          <TimePicker
            format={'HH:mm'}
            insetLabel={t('settings.workingHoursFrom')}
            value={formatFromTBackend(form.workingHours.from)}
            placeholder=""
            onChange={(val) => setWorkingHour('from', val == null ? null : formatFromTimestamp(val))}
          />
          <TimePicker
            format={'HH:mm'}
            insetLabel={t('settings.workingHoursUntil')}
            value={formatFromTBackend(form.workingHours.to)}
            placeholder=""
            onChange={(val) => setWorkingHour('to', val == null ? null : formatFromTimestamp(val))}
          />
          {/*
            Searchable rather than a plain list: there are well over four hundred zones, and an
            operator knows the name of theirs. Clearable because an empty value is a real state -
            it means the window follows the server's own zone, which is what every installation did
            before this setting existed.
          */}
          <Select
            filter
            showClear
            optionList={zones}
            value={form.workingHours.timeZone ?? undefined}
            placeholder={t('settings.workingHoursTimeZonePlaceholder')}
            insetLabel={t('settings.workingHoursTimeZone')}
            onChange={(val) => setWorkingHour('timeZone', val == null || val === '' ? null : val)}
            style={{ minWidth: 260 }}
          />
        </div>
      </SegmentPart>

      <SegmentPart name={t('settings.proxyUrl')} helpText={t('settings.proxyUrlHelp')}>
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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
              <Select
                filter
                allowCreate
                showClear
                optionList={countryOptions}
                value={iproyal.country ?? undefined}
                placeholder={t('settings.proxyIproyalCountryAny')}
                insetLabel={t('settings.proxyIproyalCountry')}
                onChange={(value) => setIproyal({ country: value == null || value === '' ? null : value })}
                style={{ minWidth: 220 }}
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
                style={{ minWidth: 200 }}
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
                    style={{ maxWidth: 220 }}
                  />
                  <Button onClick={() => setIproyal({ sessionId: randomSessionId() })}>
                    {t('settings.proxyIproyalNewSession')}
                  </Button>
                </>
              )}
            </div>
            <div style={{ marginTop: 8, opacity: 0.7 }}>{t('settings.proxyIproyalHint')}</div>
          </>
        )}
      </SegmentPart>

      {/*
        One block rather than four. The three dials are meaningless on their own - they only
        describe how the sweep behaves once it exists - so presenting them as peers of the switch
        invited reading them as four independent knobs. They stay visible while disabled so an
        operator can see what turning the feature on would commit them to.
      */}
      <SegmentPart name={t('settings.priceTracking')} helpText={t('settings.priceTrackingHelp')}>
        {/*
          Above the switch, not below it. Turning this on is the moment the operator takes on the
          risk, so the warning has to be in front of them beforehand, not revealed as a consequence.
        */}
        <Banner
          fullMode={false}
          type="warning"
          closeIcon={null}
          style={{ marginBottom: '12px' }}
          title={t('settings.priceTrackingWarningTitle')}
          description={
            <>
              <p style={{ margin: '0 0 8px' }}>{t('settings.priceTrackingWarningBody')}</p>
              <p style={{ margin: 0 }}>{t('settings.priceTrackingWarningDefaults')}</p>
            </>
          }
        />

        <Checkbox
          checked={form.priceTrackingEnabled}
          onChange={(e) => setField('priceTrackingEnabled', e.target.checked)}
        >
          {t('settings.priceTrackingEnabled')}
        </Checkbox>

        <div
          className={`settingsShell__subSettings${form.priceTrackingEnabled ? '' : ' settingsShell__subSettings--disabled'}`}
        >
          <div className="settingsShell__subSetting">
            <label className="settingsShell__subSetting__label" htmlFor="priceCheckIntervalDays">
              {t('settings.priceCheckInterval')}
            </label>
            <p className="settingsShell__subSetting__help">{t('settings.priceCheckIntervalHelp')}</p>
            <InputNumber
              id="priceCheckIntervalDays"
              min={1}
              max={30}
              disabled={!form.priceTrackingEnabled}
              value={form.priceCheckIntervalDays}
              formatter={(value) => `${value}`.replace(/\D/g, '')}
              onChange={(value) => setField('priceCheckIntervalDays', value)}
              suffix={t('settings.listingRetentionSuffix')}
              style={{ maxWidth: 200 }}
            />
          </div>

          <div className="settingsShell__subSetting">
            <label className="settingsShell__subSetting__label" htmlFor="priceCheckLimitPerRun">
              {t('settings.priceCheckLimit')}
            </label>
            <p className="settingsShell__subSetting__help">{t('settings.priceCheckLimitHelp')}</p>
            <InputNumber
              id="priceCheckLimitPerRun"
              min={1}
              max={500}
              disabled={!form.priceTrackingEnabled}
              value={form.priceCheckLimitPerRun}
              formatter={(value) => `${value}`.replace(/\D/g, '')}
              onChange={(value) => setField('priceCheckLimitPerRun', value)}
              style={{ maxWidth: 200 }}
            />
          </div>

          <div className="settingsShell__subSetting">
            <label className="settingsShell__subSetting__label" htmlFor="priceChangeThresholdPercent">
              {t('settings.priceChangeThreshold')}
            </label>
            <p className="settingsShell__subSetting__help">{t('settings.priceChangeThresholdHelp')}</p>
            <InputNumber
              id="priceChangeThresholdPercent"
              min={0}
              max={50}
              step={0.5}
              disabled={!form.priceTrackingEnabled}
              value={form.priceChangeThresholdPercent}
              onChange={(value) => setField('priceChangeThresholdPercent', value)}
              suffix="%"
              style={{ maxWidth: 200 }}
            />
          </div>
        </div>
      </SegmentPart>

      <div className="settingsShell__saveRow">
        <Button
          type="primary"
          theme="solid"
          onClick={saveExecution}
          disabled={!executionDirty}
          loading={savingExecution}
          icon={<IconSave />}
        >
          {t('settings.save')}
        </Button>
      </div>
    </div>
  );
}

ExecutionPage.displayName = 'ExecutionPage';
