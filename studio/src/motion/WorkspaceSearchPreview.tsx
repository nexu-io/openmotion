import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useEffect, useRef, useState } from 'react';
import { assetMediaUrl } from '../../../shared/asset-library';
import { isEditableTemplate, type GalleryTemplate } from '../../../shared/catalog';
import { superAgentIntentMeta, type SuperAgentResourceAttachment } from '../../../shared/super-agent';
import { Skeleton } from '../components/ui/Skeleton';
import { ScaledPreviewThumb } from '../design/ScaledPreviewThumb';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { releaseMediaElement } from '../utils/releaseMediaElement';
import { TemplatePoster } from './TemplateGalleryCard';
import { mediaLabels } from './creativeStudios';
import { ModelAvatar } from './settingsPrimitives';
import { facetValues, templateRatio } from './templateDiscovery';
import { formatRelativeSearchTime, designScenarioLabel, type SearchPaletteItem } from './workspaceSearchTypes';

type Props = {
  item: SearchPaletteItem | null;
  creatingDesign?: boolean;
  canAskSuperAgent: boolean;
  onOpenItem: (item: SearchPaletteItem) => void;
  onEditTemplate: (template: GalleryTemplate) => void;
  onCopyTemplatePrompt: (template: GalleryTemplate) => void;
  onCreateDesignFromTemplate?: (resource: SuperAgentResourceAttachment) => void;
  onUseInSuperAgent: (item: SearchPaletteItem) => void;
  onNewAgentChat?: () => void;
};

export function WorkspaceSearchPreview({
  item,
  creatingDesign = false,
  canAskSuperAgent,
  onOpenItem,
  onEditTemplate,
  onCopyTemplatePrompt,
  onCreateDesignFromTemplate,
  onUseInSuperAgent,
  onNewAgentChat,
}: Props) {
  const { t, formatDate } = useI18n();
  const [playingVideo, setPlayingVideo] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [assetMediaFailed, setAssetMediaFailed] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [settledDesignKey, setSettledDesignKey] = useState<string | null>(null);
  const templateVideoRef = useRef<HTMLVideoElement>(null);
  const assetVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setPlayingVideo(false);
    setVideoFailed(false);
    setAssetMediaFailed(false);
    setThumbFailed(false);
    const tplEl = templateVideoRef.current;
    const assetEl = assetVideoRef.current;
    return () => {
      releaseMediaElement(tplEl);
      releaseMediaElement(assetEl);
    };
  }, [item?.key]);

  // Debounce mounting heavy Design preview iframes when scrubbing rapidly through rows
  useEffect(() => {
    if (!item || (item.kind !== 'design-template' && item.kind !== 'design-project')) {
      setSettledDesignKey(null);
      return;
    }
    const timer = window.setTimeout(() => setSettledDesignKey(item.key), 90);
    return () => window.clearTimeout(timer);
  }, [item?.key, item?.kind]);

  useEffect(() => {
    const el = templateVideoRef.current;
    if (!playingVideo || item?.kind !== 'motion-template') {
      releaseMediaElement(el);
      return;
    }
    if (el) {
      el.currentTime = 0;
      void el.play().catch(() => {});
    }
    return () => releaseMediaElement(el);
  }, [playingVideo, item?.kind]);

  if (!item) {
    return (
      <aside className="om-command-preview" aria-label={t('Search results preview')}>
        <div className="om-command-preview-empty">
          <span className="om-creation-icon om-command-preview-emblem" data-tone="agent" aria-hidden="true">
            <RemixIcon name="search-line" size={18} />
          </span>
          <p className="om-muted">
            {t('Select an item to preview details, play templates, or jump straight into editing.')}
          </p>
          {onNewAgentChat && (
            <Button variant="secondary" type="button" size="sm" onClick={onNewAgentChat}>
              <RemixIcon name="sparkling-line" size={15} />
              <span>{t('New Super Agent chat')}</span>
            </Button>
          )}
        </div>
      </aside>
    );
  }

  if (item.kind === 'motion-template' && item.template) {
    const template = item.template;
    const editable = isEditableTemplate(template);
    const tags = [...new Set([...(template.tags ?? []), ...facetValues(template, 'uses'), ...facetValues(template, 'styles')])].slice(0, 6);
    const author = template.authorName || template.author;
    return (
      <aside className="om-command-preview" aria-label={t('Search results preview')}>
        <div className="om-command-preview-content" key={item.key}>
        <div className="om-command-stage" data-aspect="video">
          <TemplatePoster key={template.id} template={template} eager />
          {template.previewUrl && playingVideo && !videoFailed && (
            <video
              ref={templateVideoRef}
              key={template.id}
              src={template.previewUrl}
              muted
              autoPlay
              playsInline
              loop
              preload="metadata"
              onError={() => {
                setVideoFailed(true);
                setPlayingVideo(false);
              }}
            />
          )}
          {template.previewUrl && !videoFailed && (
            <IconButton
              type="button"
              variant="secondary"
              size="sm"
              className="om-command-stage-play"
              aria-label={t(playingVideo ? 'Pause preview' : 'Play preview')}
              onClick={() => setPlayingVideo(current => !current)}
              icon={<RemixIcon name={playingVideo ? 'pause-fill' : 'play-fill'} size={14} />}
            />
          )}
        </div>

        <div className="om-command-preview-body">
          <div className="om-command-preview-badges">
            <span className="om-badge" data-active={editable || undefined}>
              {t(editable ? 'Editable project' : 'Reference creation')}
            </span>
            {template.duration != null && (
              <span className="om-badge">{t('{value}s', { value: Number(template.duration.toFixed(1)) })}</span>
            )}
            {(template.width || template.ratio) && <span className="om-badge">{templateRatio(template)}</span>}
          </div>
          <h3 className="om-command-preview-title">{template.title}</h3>
          {author && <p className="om-command-preview-sub om-muted">{author}</p>}
          {template.description && <p className="om-command-preview-desc">{template.description}</p>}
          {tags.length > 0 && (
            <div className="om-command-preview-tags">
              {tags.map(tag => (
                <span className="om-badge" key={tag}>{t(tag)}</span>
              ))}
            </div>
          )}
        </div>

        <div className="om-command-preview-actions">
          <Button type="button" variant="primary" size="sm" onClick={() => onOpenItem(item)}>
            <RemixIcon name="eye-line" size={14} />
            <span>{t('Open preview')}</span>
          </Button>
          {editable && (
            <Button type="button" variant="secondary" size="sm" onClick={() => onEditTemplate(template)}>
              <RemixIcon name="scissors-line" size={14} />
              <span>{t('Open and edit')}</span>
            </Button>
          )}
          {canAskSuperAgent && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onUseInSuperAgent(item)}>
              <RemixIcon name="sparkling-line" size={14} />
              <span>{t('Ask Super Agent')}</span>
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => onCopyTemplatePrompt(template)}>
            <RemixIcon name="file-copy-line" size={14} />
            <span>{t('Copy prompt')}</span>
          </Button>
        </div>
        </div>
      </aside>
    );
  }

  if ((item.kind === 'design-template' || item.kind === 'design-project') && item.resource) {
    const resource = item.resource;
    const isTemplate = item.kind === 'design-template';
    const scenarioText = resource.scenario ? t(designScenarioLabel(resource.scenario)) : '';
    return (
      <aside className="om-command-preview" aria-label={t('Search results preview')}>
        <div className="om-command-preview-content" key={item.key}>
        {resource.previewUrl ? (
          <div className="om-command-stage" data-aspect="design">
            {settledDesignKey === item.key ? (
              <ScaledPreviewThumb
                key={item.key}
                src={resource.previewUrl}
                title={item.label}
                badge={scenarioText || undefined}
                brandedFallback={isTemplate}
              />
            ) : (
              <Skeleton className="om-design-thumb-skeleton" />
            )}
          </div>
        ) : (
          <div className="om-command-stage om-command-stage-placeholder" data-aspect="design">
            <span className="om-creation-icon" data-tone="image" aria-hidden="true">
              <RemixIcon name="layout-line" size={22} />
            </span>
          </div>
        )}

        <div className="om-command-preview-body">
          <div className="om-command-preview-badges">
            <span className="om-badge">{t(isTemplate ? 'Design templates' : 'Design projects')}</span>
            {scenarioText && <span className="om-badge">{scenarioText}</span>}
          </div>
          <h3 className="om-command-preview-title">{item.label}</h3>
          {item.detail && <p className="om-command-preview-sub om-muted">{item.detail}</p>}
          {item.description && <p className="om-command-preview-desc">{item.description}</p>}
          {resource.tags && resource.tags.length > 0 && (
            <div className="om-command-preview-tags">
              {resource.tags.slice(0, 6).map(tag => (
                <span className="om-badge" key={tag}>{tag}</span>
              ))}
            </div>
          )}
        </div>

        <div className="om-command-preview-actions">
          <Button type="button" variant="primary" size="sm" onClick={() => onOpenItem(item)}>
            <RemixIcon name="layout-line" size={14} />
            <span>{t(isTemplate ? 'Open in Design Studio' : 'Open project')}</span>
          </Button>
          {isTemplate && onCreateDesignFromTemplate && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={creatingDesign}
              onClick={() => onCreateDesignFromTemplate(resource)}
            >
              <RemixIcon name={creatingDesign ? 'loader-4-line' : 'add-line'} size={14} />
              <span>{t(creatingDesign ? 'Creating project…' : 'Create from template')}</span>
            </Button>
          )}
          {canAskSuperAgent && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onUseInSuperAgent(item)}>
              <RemixIcon name="sparkling-line" size={14} />
              <span>{t('Ask Super Agent')}</span>
            </Button>
          )}
        </div>
        </div>
      </aside>
    );
  }

  if (item.kind === 'chat' && item.chat) {
    const chat = item.chat;
    const intent = superAgentIntentMeta(chat.intent);
    const stateLabel = chat.state === 'running' ? 'Running' : chat.state === 'waiting' ? 'Waiting' : 'Ready';
    return (
      <aside className="om-command-preview" aria-label={t('Search results preview')}>
        <div className="om-command-preview-content" key={item.key}>
        <div className="om-command-preview-head">
          <span className="om-creation-icon" data-tone={intent.tone === 'coding' || intent.tone === 'neutral' ? 'agent' : intent.tone} aria-hidden="true">
            <RemixIcon name={intent.icon} size={18} />
          </span>
          <div className="om-command-preview-badges">
            <span className="om-badge" data-active={chat.state === 'running' || undefined}>{t(stateLabel)}</span>
            {chat.pinned && <span className="om-badge">{t('Pinned chat')}</span>}
            <span className="om-badge">{t(intent.label)}</span>
            {chat.engine && <span className="om-badge">{chat.engine}</span>}
          </div>
        </div>

        <div className="om-command-preview-body">
          <h3 className="om-command-preview-title">{item.label}</h3>
          <dl className="om-command-meta-list">
            <div>
              <dt>{t('Chat preview')}</dt>
              <dd>{t('{count} messages', { count: chat.messageCount })}</dd>
            </div>
            <div>
              <dt>{t('Artifacts')}</dt>
              <dd>{t('{count} artifacts', { count: chat.artifactCount })}</dd>
            </div>
            <div>
              <dt>{formatRelativeSearchTime(chat.updatedAt, t)}</dt>
              <dd>{formatDate(chat.updatedAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd>
            </div>
          </dl>
        </div>

        <div className="om-command-preview-actions">
          <Button type="button" variant="primary" size="sm" onClick={() => onOpenItem(item)}>
            <RemixIcon name="chat-1-line" size={14} />
            <span>{t('Open chat')}</span>
          </Button>
          {onNewAgentChat && (
            <Button type="button" variant="secondary" size="sm" onClick={onNewAgentChat}>
              <RemixIcon name="add-line" size={14} />
              <span>{t('New Super Agent chat')}</span>
            </Button>
          )}
        </div>
        </div>
      </aside>
    );
  }

  if (item.kind === 'asset' && item.asset) {
    const asset = item.asset;
    const mediaUrl = assetMediaUrl(asset.id, asset.currentVersionId);
    return (
      <aside className="om-command-preview" aria-label={t('Search results preview')}>
        <div className="om-command-preview-content" key={item.key}>
        <div className="om-command-stage om-command-stage-asset" data-aspect="video">
          {asset.modality === 'image' && !assetMediaFailed ? (
            <img src={mediaUrl} alt={asset.name} onError={() => setAssetMediaFailed(true)} />
          ) : asset.modality === 'video' && !assetMediaFailed ? (
            <video
              ref={assetVideoRef}
              key={item.key}
              src={mediaUrl}
              controls
              muted
              playsInline
              preload="metadata"
              onError={() => setAssetMediaFailed(true)}
            />
          ) : (
            <div className="om-command-stage-placeholder">
              <span className="om-creation-icon" data-tone={asset.modality} aria-hidden="true">
                <RemixIcon name={asset.modality === 'audio' ? 'music-2-line' : 'image-line'} size={22} />
              </span>
            </div>
          )}
        </div>

        <div className="om-command-preview-body">
          <div className="om-command-preview-badges">
            <span className="om-badge" data-tone={asset.modality}>{t(mediaLabels[asset.modality])}</span>
          </div>
          <h3 className="om-command-preview-title">{asset.name}</h3>
          {item.detail && <p className="om-command-preview-sub om-muted">{item.detail}</p>}
        </div>

        <div className="om-command-preview-actions">
          <Button type="button" variant="primary" size="sm" onClick={() => onOpenItem(item)}>
            <RemixIcon name="folder-open-line" size={14} />
            <span>{t('Open in Assets')}</span>
          </Button>
          {canAskSuperAgent && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onUseInSuperAgent(item)}>
              <RemixIcon name="sparkling-line" size={14} />
              <span>{t('Ask Super Agent')}</span>
            </Button>
          )}
        </div>
        </div>
      </aside>
    );
  }

  if (item.kind === 'brand-kit') {
    const swatches = item.swatches ?? [];
    return (
      <aside className="om-command-preview" aria-label={t('Search results preview')}>
        <div className="om-command-preview-content" key={item.key}>
        {((item.thumbUrl && !thumbFailed) || swatches.length > 0) && (
          <div className="om-command-stage" data-aspect="design">
            {item.thumbUrl && !thumbFailed ? (
              <img src={item.thumbUrl} alt={item.label} onError={() => setThumbFailed(true)} />
            ) : (
              <div className="om-command-stage-placeholder">
                <span className="om-creation-icon" data-tone="image" aria-hidden="true">
                  <RemixIcon name="palette-line" size={22} />
                </span>
              </div>
            )}
            {swatches.length > 0 && (
              <div className="om-command-swatches" aria-hidden="true">
                {swatches.slice(0, 5).map((color, idx) => (
                  <span key={`${color}-${idx}`} style={{ backgroundColor: color }} />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="om-command-preview-body">
          <div className="om-command-preview-badges">
            <span className="om-badge">{t('Brand Kit')}</span>
          </div>
          <h3 className="om-command-preview-title">{item.label}</h3>
          {item.detail && <p className="om-command-preview-sub om-muted">{item.detail}</p>}
          {item.description && <p className="om-command-preview-desc">{item.description}</p>}
          {item.tags && item.tags.length > 0 && (
            <div className="om-command-preview-tags">
              {item.tags.slice(0, 6).map(tag => (
                <span className="om-badge" key={tag}>{tag}</span>
              ))}
            </div>
          )}
        </div>

        <div className="om-command-preview-actions">
          <Button type="button" variant="primary" size="sm" onClick={() => onOpenItem(item)}>
            <RemixIcon name="palette-line" size={14} />
            <span>{t('Open Brand Kit')}</span>
          </Button>
          {canAskSuperAgent && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onUseInSuperAgent(item)}>
              <RemixIcon name="sparkling-line" size={14} />
              <span>{t('Ask Super Agent')}</span>
            </Button>
          )}
        </div>
        </div>
      </aside>
    );
  }

  const primaryLabel =
    item.kind === 'action' ? t('Run action')
      : item.kind === 'workflow' ? t('Open workflow')
      : item.kind === 'studio' || item.kind === 'scene' ? t('Open Studio')
      : item.kind === 'skill' || item.kind === 'design-skill' ? t('Open Skill')
      : item.kind === 'model' ? t('Use model')
      : item.kind === 'game-project' ? t('Open in Game Studio')
      : item.kind === 'motion-project' ? t('Open in Motion Studio')
      : item.kind === 'community' ? t('Browse collection')
      : t('Open');

  const supportsAgentHandoff = canAskSuperAgent && (
    item.kind === 'workflow'
    || item.kind === 'skill'
    || item.kind === 'design-skill'
    || item.kind === 'model'
    || item.kind === 'motion-project'
    || item.kind === 'game-project'
  );

  return (
    <aside className="om-command-preview" aria-label={t('Search results preview')}>
      <div className="om-command-preview-content" key={item.key}>
      {item.thumbUrl && item.kind === 'game-project' && (
        <div className="om-command-stage" data-aspect="design">
          {!thumbFailed ? (
            <img src={item.thumbUrl} alt={item.label} onError={() => setThumbFailed(true)} />
          ) : (
            <div className="om-command-stage-placeholder">
              <span className="om-creation-icon" data-tone="agent" aria-hidden="true">
                <RemixIcon name="gamepad-line" size={22} />
              </span>
            </div>
          )}
        </div>
      )}

      <div className="om-command-preview-head">
        {item.kind === 'model' && item.model ? (
          <ModelAvatar
            name={item.model.label}
            modelId={item.model.modelId}
            provider={{ id: item.model.provider, custom: false }}
          />
        ) : (
          item.icon
        )}
        <div className="om-command-preview-badges">
          {item.modality && (
            <span className="om-badge" data-tone={item.modality}>{t(mediaLabels[item.modality])}</span>
          )}
          {item.badge && <span className="om-badge">{item.badge}</span>}
          {item.meta && <span className="om-badge">{item.meta}</span>}
        </div>
      </div>

      <div className="om-command-preview-body">
        <h3 className="om-command-preview-title">{item.label}</h3>
        {item.detail && <p className="om-command-preview-sub om-muted">{item.detail}</p>}
        {item.description && item.description !== item.detail && (
          <p className="om-command-preview-desc">{item.description}</p>
        )}
        {item.tags && item.tags.length > 0 && (
          <div className="om-command-preview-tags">
            {item.tags.slice(0, 6).map(tag => (
              <span className="om-badge" key={tag}>{tag}</span>
            ))}
          </div>
        )}
      </div>

      <div className="om-command-preview-actions">
        <Button type="button" variant="primary" size="sm" onClick={() => onOpenItem(item)}>
          <span>{primaryLabel}</span>
          <RemixIcon name="arrow-right-line" size={14} />
        </Button>
        {supportsAgentHandoff && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onUseInSuperAgent(item)}>
            <RemixIcon name="sparkling-line" size={14} />
            <span>{t('Ask Super Agent')}</span>
          </Button>
        )}
      </div>
      </div>
    </aside>
  );
}
