import { Fragment, useMemo, type ReactNode } from 'react';
import { IconButton } from 'open-design-ui/icon-button';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';

type Block =
  | { type: 'code'; lang: string; code: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'paragraph'; text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim(),
      });
      i++;
      continue;
    }

    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ type: 'quote', lines: quoteLines });
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const items: string[] = [];
      while (i < lines.length) {
        const match = ordered ? lines[i].match(/^\s*\d+\.\s+(.+)$/) : lines[i].match(/^\s*[-*]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length
      && lines[i].trim()
      && !lines[i].startsWith('```')
      && !/^#{1,3}\s+/.test(lines[i])
      && !lines[i].startsWith('> ')
      && !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
    }
  }
  return blocks;
}

function safeHref(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function renderInline(text: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) tokens.push(text.slice(last, match.index));
    const full = match[0];
    if (full.startsWith('`')) {
      tokens.push(<code key={key++} className="om-sa-inline-code">{full.slice(1, -1)}</code>);
    } else if (full.startsWith('**')) {
      tokens.push(<strong key={key++}>{full.slice(2, -2)}</strong>);
    } else if (full.startsWith('*')) {
      tokens.push(<em key={key++}>{full.slice(1, -1)}</em>);
    } else if (full.startsWith('[')) {
      const labelEnd = full.indexOf('](');
      const label = full.slice(1, labelEnd);
      const href = safeHref(match[2]);
      if (href) {
        tokens.push(
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer" className="om-sa-link">
            {label}
          </a>,
        );
      } else {
        tokens.push(full);
      }
    }
    last = match.index + full.length;
  }
  if (last < text.length) tokens.push(text.slice(last));
  return tokens;
}

export function SimpleMarkdown({ content, onCopyCode }: { content: string; onCopyCode?: (code: string) => void }) {
  const { t } = useI18n();
  const blocks = useMemo(() => parseBlocks(content), [content]);

  return (
    <div className="om-sa-markdown">
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return (
            <div key={index} className="om-sa-code-card">
              <div className="om-sa-code-head">
                <span>{block.lang || 'text'}</span>
                {onCopyCode && (
                  <IconButton
                    variant="ghost"
                    className="motion-icon-button"
                    aria-label={t('Copy code')}
                    onClick={() => onCopyCode(block.code)}
                    icon={<RemixIcon name="file-copy-line" size={14} />}
                  />
                )}
              </div>
              <pre className="om-sa-code-pre">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }
        if (block.type === 'heading') {
          const Tag = block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5';
          return <Tag key={index} className="om-sa-md-heading">{renderInline(block.text)}</Tag>;
        }
        if (block.type === 'quote') {
          return (
            <blockquote key={index} className="om-sa-md-quote">
              {block.lines.map((line, i) => (
                <Fragment key={i}>
                  {i > 0 && <br />}
                  {renderInline(line)}
                </Fragment>
              ))}
            </blockquote>
          );
        }
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={index} className="om-sa-md-list">
              {block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
            </ListTag>
          );
        }
        return (
          <p key={index} className="om-sa-md-para">
            {block.text.split('\n').map((line, i) => (
              <Fragment key={i}>
                {i > 0 && <br />}
                {renderInline(line)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
