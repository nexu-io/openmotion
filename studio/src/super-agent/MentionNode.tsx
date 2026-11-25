import { Button } from 'open-design-ui/button';
import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { createContext, useContext, type ReactElement } from 'react';
import {
  formatAttachmentBytes,
  resourceAttachmentKey,
  type SuperAgentResourceAttachment,
  type SuperAgentResourceKind,
} from '../../../shared/super-agent';
import { Tooltip } from '../components/ui/Tooltip';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { formatTimeShort } from '../motion/superAgentMotionBridge';
import {
  ResourceThumbImage,
  resourceDisplaySubtitle,
  resourceDisplayTitle,
  resourceIcon,
  resourceImagePreviewUrl,
} from './ResourcePickerDialog';

export type MentionEditorContextValue = {
  onOpenMention?: (attachment: SuperAgentResourceAttachment) => void;
};

export const MentionEditorContext = createContext<MentionEditorContextValue>({});

export function middleTruncateLabel(label: string, maxLen = 36): string {
  if (label.length <= maxLen) return label;
  const keepStart = Math.ceil((maxLen - 1) * 0.62);
  const keepEnd = Math.max(4, maxLen - 1 - keepStart);
  return `${label.slice(0, keepStart)}…${label.slice(-keepEnd)}`;
}

export function mentionToneForKind(kind: SuperAgentResourceKind): string {
  switch (kind) {
    case 'file':
    case 'folder':
      return 'file';
    case 'chat':
      return 'chat';
    case 'brand-kit':
      return 'brand';
    case 'skill':
    case 'design-skill':
    case 'workflow':
      return 'skill';
    case 'design-template':
    case 'design-project':
      return 'design';
    case 'motion-template':
    case 'motion-project':
    case 'game-project':
      return 'agent';
    case 'asset':
      return 'image';
    case 'browser-annotation':
      return 'annotation';
    default:
      return 'neutral';
  }
}

export function mentionTooltipText(
  attachment: SuperAgentResourceAttachment,
  t: (text: string, vars?: Record<string, string | number>) => string,
): string {
  if (attachment.kind === 'browser-annotation') {
    const annot = attachment.annotation;
    const linePart = annot?.lineRange
      ? `L${annot.lineRange.start}${annot.lineRange.end !== annot.lineRange.start ? `–L${annot.lineRange.end}` : ''}`
      : undefined;
    const timePart = annot?.timeRange
      ? `${formatTimeShort(annot.timeRange.start)}–${formatTimeShort(annot.timeRange.end)}`
      : typeof annot?.timeSec === 'number'
        ? formatTimeShort(annot.timeSec)
        : undefined;
    const clipPart = annot?.timelineClips?.length ? `${annot.timelineClips.length} clip(s)` : undefined;
    const slidePart = typeof annot?.slideIndex === 'number' ? `Slide ${annot.slideIndex + 1}` : undefined;
    return [
      annot?.element?.componentName,
      annot?.element?.selector,
      annot?.compositionPath || annot?.filePath,
      linePart,
      timePart,
      clipPart,
      slidePart,
      annot?.pageUrl || attachment.subtitle,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (attachment.kind === 'file') {
    const size = formatAttachmentBytes(attachment.sizeBytes);
    const pathLabel = attachment.filePath && attachment.rootKey !== 'upload'
      ? attachment.filePath
      : attachment.title;
    return [pathLabel, size].filter(Boolean).join(' · ');
  }
  if (attachment.kind === 'folder') {
    return attachment.filePath || attachment.subtitle || attachment.title;
  }
  if (attachment.kind === 'chat') {
    const base = resourceDisplaySubtitle(attachment, t);
    return base ? `${t('Conversation')}: ${attachment.title} · ${base}` : `${t('Conversation')}: ${attachment.title}`;
  }
  const sub = resourceDisplaySubtitle(attachment, t);
  return sub ? `${attachment.title} · ${sub}` : attachment.title;
}

export function InlineMentionChip({
  attachment,
  onOpen,
  inEditor = false,
}: {
  attachment: SuperAgentResourceAttachment;
  onOpen?: (attachment: SuperAgentResourceAttachment) => void;
  inEditor?: boolean;
}) {
  const { t } = useI18n();
  const displayTitle = middleTruncateLabel(resourceDisplayTitle(attachment, t));
  const tooltip = mentionTooltipText(attachment, t);
  const thumbUrl = resourceImagePreviewUrl(attachment);
  const showSwatches = attachment.kind === 'brand-kit' && Boolean(attachment.swatches?.length);

  const chip = (
    <Button
      variant="plain"
      type="button"
      className="om-sa-inline-mention"
      data-kind={attachment.kind}
      data-tone={mentionToneForKind(attachment.kind)}
      data-clickable={Boolean(onOpen) || undefined}
      onMouseDown={inEditor ? event => event.preventDefault() : undefined}
      onClick={event => {
        if (!onOpen) return;
        event.preventDefault();
        event.stopPropagation();
        onOpen(attachment);
      }}
    >
      {thumbUrl ? (
        <ResourceThumbImage
          className="om-sa-inline-mention-thumb"
          src={thumbUrl}
          fallback={
            <span className="om-sa-inline-mention-icon" aria-hidden="true">
              <RemixIcon name={resourceIcon(attachment)} size={13} />
            </span>
          }
        />
      ) : showSwatches ? (
        <span className="om-sa-inline-mention-swatches" aria-hidden="true">
          {attachment.swatches!.slice(0, 3).map((swatch, idx) => (
            <span key={idx} style={{ background: swatch }} />
          ))}
        </span>
      ) : (
        <span className="om-sa-inline-mention-icon" aria-hidden="true">
          <RemixIcon name={resourceIcon(attachment)} size={13} />
        </span>
      )}
      <span className="om-sa-inline-mention-label">{displayTitle}</span>
    </Button>
  );

  return tooltip ? <Tooltip label={tooltip}>{chip}</Tooltip> : chip;
}

function MentionDecoratorView({ attachment }: { attachment: SuperAgentResourceAttachment }) {
  const { onOpenMention } = useContext(MentionEditorContext);
  return <InlineMentionChip attachment={attachment} onOpen={onOpenMention} inEditor />;
}

export type SerializedMentionNode = Spread<
  {
    attachment: SuperAgentResourceAttachment;
  },
  SerializedLexicalNode
>;

export class MentionNode extends DecoratorNode<ReactElement> {
  __attachment: SuperAgentResourceAttachment;

  static getType(): string {
    return 'sa-mention';
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__attachment, node.__key);
  }

  static importJSON(serializedNode: SerializedMentionNode): MentionNode {
    return $createMentionNode(serializedNode.attachment);
  }

  constructor(attachment: SuperAgentResourceAttachment, key?: NodeKey) {
    super(key);
    this.__attachment = attachment;
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      type: 'sa-mention',
      version: 1,
      attachment: this.__attachment,
    };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement('span');
    dom.className = 'om-sa-mention-slot';
    dom.setAttribute('data-mention-key', resourceAttachmentKey(this.__attachment));
    return dom;
  }

  updateDOM(): false {
    return false;
  }

  exportDOM(): DOMExportOutput {
    const span = document.createElement('span');
    span.setAttribute('data-mention-key', resourceAttachmentKey(this.__attachment));
    span.textContent = `@${this.__attachment.title}`;
    return { element: span };
  }

  getAttachment(): SuperAgentResourceAttachment {
    return this.getLatest().__attachment;
  }

  getTextContent(): string {
    return `@${this.__attachment.title}`;
  }

  isInline(): true {
    return true;
  }

  isIsolated(): true {
    return true;
  }

  decorate(): ReactElement {
    return <MentionDecoratorView attachment={this.__attachment} />;
  }
}

export function $createMentionNode(attachment: SuperAgentResourceAttachment): MentionNode {
  return $applyNodeReplacement(new MentionNode(attachment));
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}
