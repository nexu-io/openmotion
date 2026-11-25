import { Button } from 'open-design-ui/button';
import { Slider } from 'open-design-ui/slider';
import { useEffect, useState } from 'react';
import type { Modality, Model } from '../../../shared/gateway';
import { compatibleImageResolutions, type GenerationOption } from '../../../shared/generation-options';
import { Popover } from '../components/ui/Popover';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import {
  applyModelParamChange,
  effectiveFieldValue,
  formatParamDisplayValue,
  resolveSubmittedMediaParameters,
} from './modelParams';

export type ModelParamMenuKey = 'param-geometry' | 'param-duration' | 'param-all';

function ratioPreviewBox(label: string): { width: number; height: number } | null {
  const match = label.match(/(\d+):(\d+)/);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!w || !h) return null;
  const ratio = w / h;
  return {
    width: Math.round(14 * Math.min(ratio, 1)),
    height: Math.round(14 / Math.max(ratio, 1)),
  };
}

export function ModelParameterPills({
  modality,
  model,
  values,
  hasInputImage = false,
  audioType,
  openMenu,
  disabled,
  onOpenMenuChange,
  onChange,
}: {
  modality: Modality;
  model: Model | undefined;
  values: Record<string, unknown>;
  hasInputImage?: boolean;
  audioType?: 'music' | 'voiceover' | 'sfx';
  openMenu: string | null;
  disabled?: boolean;
  onOpenMenuChange: (menu: ModelParamMenuKey | null) => void;
  onChange: (nextValues: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();

  const {
    schema,
    wireParameters,
    activeAdvancedCount,
  } = resolveSubmittedMediaParameters(model, values, modality, hasInputImage, audioType);

  // Featured top-bar pills pulled straight from SSOT primary tier fields
  const geometryField = modality !== 'audio'
    ? schema.primaryFields.find(f =>
        f.standardKey === 'aspectRatio' || f.presentation === 'ratio' || f.standardKey === 'size')
    : undefined;
  const durationField = modality === 'video'
    ? schema.primaryFields.find(f => f.standardKey === 'duration')
    : undefined;
  const audioLeadField = modality === 'audio'
    ? (schema.primaryFields.find(f => f.standardKey === 'voice')
      ?? schema.primaryFields.find(f => f.standardKey === 'duration'))
    : undefined;

  const featuredKeys = new Set(
    [geometryField?.key, durationField?.key, audioLeadField?.key].filter((k): k is string => Boolean(k)),
  );
  const remainingPrimary = schema.primaryFields.filter(f => !featuredKeys.has(f.key));
  const defaultAdvancedOpen = remainingPrimary.length === 0 && !schema.alwaysOnAudio;
  const [advancedOpen, setAdvancedOpen] = useState(() => defaultAdvancedOpen);

  useEffect(() => {
    setAdvancedOpen(defaultAdvancedOpen);
  }, [model?.id, modality, defaultAdvancedOpen]);

  // Track active sibling requirements across current effective values
  const activeConstraints: Record<string, string | number> = {};
  for (const field of schema.fields) {
    const val = effectiveFieldValue(model, field, values, hasInputImage);
    const matched = field.choices?.find(c => c.value === val);
    if (matched?.requires) {
      Object.assign(activeConstraints, matched.requires);
    }
  }

  const updateField = (field: GenerationOption, nextVal: unknown) => {
    onChange(applyModelParamChange(model, values, field, nextVal, hasInputImage));
  };

  const renderDynamicField = (field: GenerationOption, options?: { hideHeader?: boolean; autoClose?: boolean }) => {
    const rawOverride = values[field.key];
    const currentVal = effectiveFieldValue(model, field, values, hasInputImage);
    const hasOverride = rawOverride !== undefined && rawOverride !== '';

    const renderHeader = !options?.hideHeader && (
      <div className="om-sa-param-field-head">
        <span className="om-sa-popover-label" title={field.description ? t(field.description) : undefined}>
          {t(field.label)}
        </span>
        {hasOverride && (
          <Button
            variant="plain"
            type="button"
            className="om-sa-param-clear-btn"
            onClick={() => updateField(field, undefined)}
          >
            {t('Reset')}
          </Button>
        )}
      </div>
    );

    if (field.kind === 'choice') {
      const rawChoices = field.choices ?? [];
      const activeAspectRatio = values.aspect_ratio ?? model?.defaults?.aspect_ratio;
      const allowedRes = field.key === 'resolution' && model
        ? compatibleImageResolutions(model, activeAspectRatio, hasInputImage)
        : undefined;
      const visibleChoices = allowedRes
        ? rawChoices.filter(c => allowedRes.includes(String(c.value)) || c.value === currentVal)
        : rawChoices;
      const isRatioTiles = field.presentation === 'ratio';

      return (
        <div key={field.key} className="om-sa-mode-field">
          {renderHeader}
          <div className={isRatioTiles ? 'om-sa-popover-pills om-sa-ratio-pills' : 'om-sa-popover-pills'}>
            {visibleChoices.map(option => {
              const activeOption = currentVal === option.value;
              const blockedByReq = activeConstraints[field.key] !== undefined && activeConstraints[field.key] !== option.value;
              const rawLabel = option.label ?? String(option.value);
              const box = isRatioTiles ? ratioPreviewBox(rawLabel) : null;
              return (
                <Button
                  key={String(option.value)}
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={activeOption}
                  data-active={activeOption || undefined}
                  disabled={blockedByReq}
                  onClick={() => {
                    updateField(field, option.value);
                    if (options?.autoClose) onOpenMenuChange(null);
                  }}
                >
                  {box && (
                    <span
                      className="om-sa-ratio-mini"
                      style={{ width: `${box.width}px`, height: `${box.height}px` }}
                      aria-hidden="true"
                    />
                  )}
                  <span>
                    {option.value === -1 ? t('Auto') : formatParamDisplayValue(field, option.value, t)}
                  </span>
                </Button>
              );
            })}
          </div>
          {field.allowCustom && (
            <input
              type="text"
              className="om-sa-mode-url-input"
              aria-label={`${t(field.label)} (${t('Custom value')})`}
              value={typeof rawOverride === 'string' && !visibleChoices.some(c => c.value === rawOverride) ? rawOverride : ''}
              placeholder={t('Custom value')}
              onChange={event => updateField(field, event.target.value)}
            />
          )}
        </div>
      );
    }

    if (field.kind === 'boolean') {
      const boolVal = typeof currentVal === 'boolean' ? currentVal : undefined;
      return (
        <div key={field.key} className="om-sa-mode-field">
          {renderHeader}
          <div className="om-sa-popover-pills">
            {([true, false] as const).map(flag => (
              <Button
                key={String(flag)}
                variant="plain"
                type="button"
                className="om-sa-popover-pill"
                aria-pressed={boolVal === flag}
                data-active={boolVal === flag || undefined}
                onClick={() => updateField(field, flag)}
              >
                {t(flag ? 'On' : 'Off')}
              </Button>
            ))}
          </div>
        </div>
      );
    }

    if (field.kind === 'number') {
      const hasBounds = field.min !== undefined && field.max !== undefined
        && Number.isFinite(field.min) && Number.isFinite(field.max) && field.max > field.min;
      const numericCurrent = typeof currentVal === 'number' && Number.isFinite(currentVal)
        ? currentVal
        : (typeof field.default === 'number' ? field.default : field.min ?? 0);

      return (
        <div key={field.key} className="om-sa-mode-field">
          {renderHeader}
          <div className="om-sa-param-slider-row">
            {hasBounds && (
              <div className="om-sa-param-slider-wrap">
                <Slider
                  label={t(field.label)}
                  min={field.min!}
                  max={field.max!}
                  step={field.step ?? 1}
                  value={Math.min(field.max!, Math.max(field.min!, numericCurrent))}
                  onCommit={next => updateField(field, next)}
                />
              </div>
            )}
            <input
              type="number"
              className={hasBounds ? 'om-sa-mode-url-input om-sa-param-number-input' : 'om-sa-mode-url-input'}
              aria-label={t(field.label)}
              min={field.min}
              max={field.max}
              step={field.step ?? 1}
              placeholder={field.default !== undefined ? String(field.default) : t('Auto')}
              value={typeof rawOverride === 'number' ? rawOverride : ''}
              onChange={event => {
                const raw = event.target.value;
                if (raw === '') {
                  updateField(field, undefined);
                  return;
                }
                const parsed = Number(raw);
                if (Number.isFinite(parsed)) {
                  updateField(field, parsed);
                }
              }}
              onBlur={() => {
                if (typeof rawOverride !== 'number' || !Number.isFinite(rawOverride)) return;
                let next = rawOverride;
                if ((field.step ?? 1) === 1) next = Math.round(next);
                if (field.min !== undefined) next = Math.max(field.min, next);
                if (field.max !== undefined) next = Math.min(field.max, next);
                if (next !== rawOverride) updateField(field, next);
              }}
            />
          </div>
        </div>
      );
    }

    return (
      <div key={field.key} className="om-sa-mode-field">
        {renderHeader}
        <input
          type="text"
          className="om-sa-mode-url-input"
          aria-label={t(field.label)}
          placeholder={field.description ? t(field.description) : t(field.label)}
          value={typeof rawOverride === 'string' ? rawOverride : ''}
          onChange={event => updateField(field, event.target.value)}
        />
      </div>
    );
  };

  // Summary for the unified "Parameters" pill covering remaining primary + active advanced overrides
  const summaryParts: string[] = [];
  for (const field of remainingPrimary) {
    const val = effectiveFieldValue(model, field, values, hasInputImage);
    if (val === undefined || val === '') continue;
    if (field.standardKey === 'count') {
      summaryParts.push(`${val}×`);
    } else if (field.standardKey === 'generateAudio') {
      if (val === true) summaryParts.push(t('Audio'));
    } else if (field.kind === 'boolean') {
      if (val === true) summaryParts.push(t(field.label));
    } else {
      summaryParts.push(formatParamDisplayValue(field, val, t));
    }
  }
  const hasAnyOverride = Object.keys(wireParameters).length > 0;
  const remainingPrimaryOverrides = remainingPrimary.some(f => values[f.key] !== undefined && values[f.key] !== '');
  const showAllPill = remainingPrimary.length > 0 || schema.advancedFields.length > 0 || schema.alwaysOnAudio;
  const allPillLabel = summaryParts.length > 0
    ? summaryParts.slice(0, 2).join(' · ')
    : t('Parameters');

  const renderLeadFieldPill = (
    menuKey: ModelParamMenuKey,
    field: GenerationOption,
    icon: string,
    autoClose: boolean,
  ) => {
    const currentVal = effectiveFieldValue(model, field, values, hasInputImage);
    const hasOverride = values[field.key] !== undefined && values[field.key] !== '';
    const displayText = currentVal !== undefined && currentVal !== ''
      ? formatParamDisplayValue(field, currentVal, t)
      : t(field.label);

    return (
      <Popover
        open={openMenu === menuKey}
        onOpenChange={next => onOpenMenuChange(next ? menuKey : null)}
        side="top"
        align="start"
        initialFocus={field.kind === 'text' ? undefined : false}
        aria-label={t(field.label)}
        className="om-sa-mode-popover om-sa-ssot-popover"
        trigger={
          <Button
            variant="plain"
            type="button"
            className="om-sa-composer-top-pill"
            data-active={hasOverride || openMenu === menuKey || undefined}
            data-open={openMenu === menuKey || undefined}
            disabled={disabled}
          >
            <RemixIcon name={icon} size={13} />
            <span className="om-sa-composer-top-pill-label">{displayText}</span>
            <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
          </Button>
        }
      >
        <div className="om-sa-mode-menu">
          {renderDynamicField(field, { autoClose })}
        </div>
      </Popover>
    );
  };

  return (
    <>
      {modality === 'video' && schema.inputImageRatioLocked ? (
        <span
          className="om-sa-composer-top-pill om-sa-param-lock-pill"
          data-active
          title={t('First-frame video follows the input image ratio')}
        >
          <RemixIcon name="image-line" size={13} />
          <span className="om-sa-composer-top-pill-label">{t('Follows first frame')}</span>
        </span>
      ) : (
        geometryField && renderLeadFieldPill(
          'param-geometry',
          geometryField,
          'layout-line',
          geometryField.kind === 'choice' && !geometryField.allowCustom,
        )
      )}

      {durationField && renderLeadFieldPill(
        'param-duration',
        durationField,
        'time-line',
        durationField.kind === 'choice',
      )}

      {audioLeadField && renderLeadFieldPill(
        audioLeadField.standardKey === 'duration' ? 'param-duration' : 'param-geometry',
        audioLeadField,
        audioLeadField.standardKey === 'duration' ? 'time-line' : 'voiceprint-line',
        audioLeadField.kind === 'choice' && !audioLeadField.allowCustom,
      )}

      {showAllPill && (
        <Popover
          open={openMenu === 'param-all'}
          onOpenChange={next => onOpenMenuChange(next ? 'param-all' : null)}
          side="top"
          align="start"
          initialFocus={false}
          aria-label={t('Parameters')}
          className="om-sa-mode-popover om-sa-ssot-popover om-sa-params-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={remainingPrimaryOverrides || activeAdvancedCount > 0 || openMenu === 'param-all' || undefined}
              data-open={openMenu === 'param-all' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="equalizer-line" size={13} />
              <span className="om-sa-composer-top-pill-label">{allPillLabel}</span>
              {activeAdvancedCount > 0 && (
                <span className="om-sa-param-badge">+{activeAdvancedCount}</span>
              )}
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-menu-head">
              <span className="om-sa-popover-label">
                {model ? `${model.label} · ${t('Parameters')}` : t('Parameters')}
              </span>
              {hasAnyOverride && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-param-clear-btn"
                  onClick={() => onChange({})}
                >
                  {t('Reset to defaults')}
                </Button>
              )}
            </div>

            {schema.alwaysOnAudio && (
              <div className="om-sa-param-note-row">
                <RemixIcon name="volume-up-line" size={14} />
                <span>{t('Native audio · On')}</span>
              </div>
            )}

            {remainingPrimary.map(field => renderDynamicField(field))}

            {schema.advancedFields.length > 0 && (
              <details
                className="om-sa-adv-params"
                open={advancedOpen}
                onToggle={event => setAdvancedOpen(event.currentTarget.open)}
              >
                <summary className="om-sa-adv-summary">
                  <span className="om-sa-adv-summary-title">
                    <RemixIcon name="arrow-right-s-line" size={14} className="om-sa-adv-chevron" />
                    <span>{t('Advanced parameters')}</span>
                  </span>
                  <span className="om-sa-mode-menu-count">
                    {activeAdvancedCount > 0
                      ? `${activeAdvancedCount}/${schema.advancedFields.length}`
                      : schema.advancedFields.length}
                  </span>
                </summary>
                <div className="om-sa-adv-body">
                  {schema.advancedFields.map(field => renderDynamicField(field))}
                </div>
              </details>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}
