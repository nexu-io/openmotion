// @vitest-environment happy-dom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuperAgentResourceAttachment } from '../../../shared/super-agent';
import { I18nProvider } from '../i18n/I18n';
import {
  COMPOSER_FRAGMENT_MIME,
  ComposerPromptEditor,
  type ComposerMentionTrigger,
  type ComposerPromptEditorHandle,
  type ComposerSnapshot,
} from './ComposerPromptEditor';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

async function setDomEditableText(editable: HTMLElement, ref: React.RefObject<ComposerPromptEditorHandle | null>, text: string) {
  ref.current?.clear();
  ref.current?.focus();
  await Promise.resolve();
  editable.dispatchEvent(
    new InputEvent('input', {
      inputType: 'insertText',
      data: text,
      bubbles: true,
    }),
  );
}

function renderEditor(props: Partial<React.ComponentProps<typeof ComposerPromptEditor>> & { ref?: React.Ref<ComposerPromptEditorHandle> } = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const snapshots: ComposerSnapshot[] = [];
  const triggers: ComposerMentionTrigger[] = [];
  const defaultRef = createRef<ComposerPromptEditorHandle>();

  const ref = props.ref ?? defaultRef;
  act(() => {
    root!.render(
      <I18nProvider>
        <ComposerPromptEditor
          ref={ref}
          ariaLabel="Message Super Agent"
          placeholder="Ask Super Agent…"
          onChange={snap => {
            snapshots.push(snap);
            props.onChange?.(snap);
          }}
          onTriggerChange={trig => {
            triggers.push(trig);
            props.onTriggerChange?.(trig);
          }}
          {...(props.mentionMenuOpen !== undefined ? { mentionMenuOpen: props.mentionMenuOpen } : {})}
          {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
          {...(props.onMenuKey ? { onMenuKey: props.onMenuKey } : {})}
          {...(props.onSubmit ? { onSubmit: props.onSubmit } : {})}
          {...(props.onCancelEdit ? { onCancelEdit: props.onCancelEdit } : {})}
          {...(props.onPasteFiles ? { onPasteFiles: props.onPasteFiles } : {})}
          {...(props.onRestoreMentions ? { onRestoreMentions: props.onRestoreMentions } : {})}
          {...(props.onOpenMention ? { onOpenMention: props.onOpenMention } : {})}
        />
      </I18nProvider>,
    );
  });

  const editable = container.querySelector<HTMLElement>('.om-sa-composer-editor')!;
  return { ref, editable, snapshots, triggers };
}

describe('ComposerPromptEditor', () => {
  it('sets placeholder & disabled attributes cleanly and serializes plain text', async () => {
    const { ref, editable } = renderEditor({ disabled: true });
    expect(editable.getAttribute('aria-label')).toBe('Message Super Agent');
    expect(editable.getAttribute('aria-disabled')).toBe('true');
    expect(editable.getAttribute('data-placeholder')).toBe('Ask Super Agent…');

    await act(async () => {
      ref.current!.setPlainText('Build a clean prototype');
    });
    expect(ref.current!.getSnapshot().text).toBe('Build a clean prototype');
  });

  it('detects @ triggers for ASCII & CJK while ignoring email addresses', async () => {
    const triggers: ComposerMentionTrigger[] = [];
    const { ref, editable } = renderEditor({
      onTriggerChange: trig => triggers.push(trig),
    });

    await act(async () => {
      await setDomEditableText(editable, ref, 'Inspect @brief');
      await new Promise(r => setTimeout(r, 10));
    });
    expect(triggers.at(-1)).toEqual({ active: true, kind: 'at', query: 'brief' });

    await act(async () => {
      await setDomEditableText(editable, ref, '查看 @产品');
      await new Promise(r => setTimeout(r, 10));
    });
    expect(triggers.at(-1)).toEqual({ active: true, kind: 'at', query: '产品' });

    await act(async () => {
      await setDomEditableText(editable, ref, '/compact');
      await new Promise(r => setTimeout(r, 10));
    });
    expect(triggers.at(-1)).toEqual({ active: true, kind: 'slash', query: 'compact' });

    await act(async () => {
      await setDomEditableText(editable, ref, 'Email user@example.com');
      await new Promise(r => setTimeout(r, 10));
    });
    expect(triggers.at(-1)).toBeNull();
  });

  it('inserts heterogeneous inline MentionNodes, clicks to open, and removes via removeMentionByKey & setStructuredContent', async () => {
    const onOpenMention = vi.fn();
    const { ref } = renderEditor({ onOpenMention });

    const fileAtt: SuperAgentResourceAttachment = {
      id: 'custom:AGENTS.md',
      kind: 'file',
      title: 'AGENTS.md',
      filePath: 'AGENTS.md',
      rootKey: 'custom',
      sizeBytes: 2048,
      mimeType: 'text/markdown',
    };
    const chatAtt: SuperAgentResourceAttachment = {
      id: 'chat-prev-1',
      chatId: 'chat-prev-1',
      kind: 'chat',
      title: 'Design Kickoff',
      subtitle: '6 messages',
    };
    const brandAtt: SuperAgentResourceAttachment = {
      id: 'kit-1',
      kind: 'brand-kit',
      title: 'Editorial Neo',
      swatches: ['#111111', '#ff5500', '#f4f0ea'],
    };

    await act(async () => {
      await setDomEditableText(container!.querySelector('.om-sa-composer-editor')!, ref, 'Compare @AGE');
      await new Promise(r => setTimeout(r, 10));
    });
    await act(async () => {
      ref.current!.insertMention(fileAtt, { replaceTrigger: true });
    });
    await act(async () => {
      ref.current!.insertMention(chatAtt, { replaceTrigger: false });
    });
    await act(async () => {
      ref.current!.insertMention(brandAtt, { replaceTrigger: false });
    });

    const snap = ref.current!.getSnapshot();
    expect(snap.text).toContain('Compare ');
    expect(snap.text).toContain('@AGENTS.md');
    expect(snap.text).toContain('@Design Kickoff');
    expect(snap.text).toContain('@Editorial Neo');
    expect(snap.mentions).toHaveLength(3);
    expect(snap.segments.filter(s => s.type === 'mention')).toHaveLength(3);

    const chips = container!.querySelectorAll<HTMLButtonElement>('.om-sa-inline-mention');
    expect(chips).toHaveLength(3);
    await act(async () => {
      chips[0].click();
    });
    expect(onOpenMention).toHaveBeenCalledWith(expect.objectContaining({ id: 'custom:AGENTS.md', kind: 'file' }));

    await act(async () => {
      ref.current!.removeMentionByKey(`chat:${chatAtt.id}:`);
    });
    expect(ref.current!.getSnapshot().mentions).toHaveLength(2);

    await act(async () => {
      ref.current!.setStructuredContent(snap.text, snap.segments, [fileAtt, chatAtt, brandAtt]);
    });
    expect(ref.current!.getSnapshot().mentions).toHaveLength(3);
  });

  it('invokes onPasteFiles when files are pasted and restores serialized mention fragments on paste', async () => {
    const onPasteFiles = vi.fn();
    const onRestoreMentions = vi.fn();
    const { ref, editable } = renderEditor({ onPasteFiles, onRestoreMentions });

    const sampleAtt: SuperAgentResourceAttachment = {
      id: 'upload-99',
      kind: 'file',
      title: 'spec.json',
      rootKey: 'upload',
      mimeType: 'application/json',
    };

    // Paste custom serialized fragment
    const fragPayload = JSON.stringify({
      segments: [
        { type: 'text', text: 'Inspect ' },
        { type: 'mention', attachmentKey: `file:${sampleAtt.id}:`, label: 'spec.json', kind: 'file' },
      ],
      mentions: [sampleAtt],
    });
    await act(async () => {
      const pasteEv = new Event('paste', { bubbles: true, cancelable: true }) as unknown as ClipboardEvent;
      Object.defineProperty(pasteEv, 'clipboardData', {
        value: {
          getData: (mime: string) => (mime === COMPOSER_FRAGMENT_MIME ? fragPayload : ''),
          files: [],
          items: [],
        },
      });
      editable.dispatchEvent(pasteEv);
      await new Promise(r => setTimeout(r, 10));
    });
    expect(ref.current!.getSnapshot().mentions.some(m => m.id === 'upload-99')).toBe(true);
    expect(onRestoreMentions).toHaveBeenCalledWith([expect.objectContaining({ id: 'upload-99' })]);

    // Paste file upload
    const pastedFile = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    await act(async () => {
      const filePasteEv = new Event('paste', { bubbles: true, cancelable: true }) as unknown as ClipboardEvent;
      Object.defineProperty(filePasteEv, 'clipboardData', {
        value: {
          getData: () => '',
          files: [pastedFile],
          items: [{ kind: 'file', getAsFile: () => pastedFile }],
        },
      });
      editable.dispatchEvent(filePasteEv);
      await new Promise(r => setTimeout(r, 10));
    });
    expect(onPasteFiles).toHaveBeenCalledWith([pastedFile]);
  });

  it('forwards menu keyboard shortcuts when mentionMenuOpen and submits on Enter otherwise', async () => {
    const onMenuKey = vi.fn();
    const onSubmit = vi.fn();
    const { ref, editable } = renderEditor({
      mentionMenuOpen: true,
      onMenuKey,
      onSubmit,
    });

    await act(async () => {
      ref.current!.focus();
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onMenuKey.mock.calls.map(c => c[0])).toEqual(['down', 'up', 'confirm', 'escape']);
    expect(onSubmit).not.toHaveBeenCalled();

    // Re-render with menu closed and verify Enter submits
    await act(async () => {
      root!.render(
        <I18nProvider>
          <ComposerPromptEditor
            ref={ref}
            ariaLabel="Message Super Agent"
            placeholder="Ask Super Agent…"
            mentionMenuOpen={false}
            onChange={() => {}}
            onTriggerChange={() => {}}
            onSubmit={onSubmit}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      ref.current!.focus();
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith(false);
  });

  it('synchronously clears DOM content, snapshot, and empty state on clear()', async () => {
    const { ref, editable } = renderEditor({});
    await act(async () => {
      ref.current!.setPlainText('Clear me synchronously');
    });
    expect(ref.current!.getSnapshot().text).toBe('Clear me synchronously');
    expect(editable.textContent).toBe('Clear me synchronously');
    expect(container!.querySelector('.om-sa-composer-editor-shell')?.getAttribute('data-empty')).toBeNull();

    await act(async () => {
      ref.current!.clear();
    });
    expect(ref.current!.getSnapshot().text).toBe('');
    expect(editable.textContent).toBe('');
    expect(container!.querySelector('.om-sa-composer-editor-shell')?.getAttribute('data-empty')).toBe('true');
  });
});
