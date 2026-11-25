import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  COPY_COMMAND,
  CUT_COMMAND,
  FOCUS_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
} from 'lexical';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  resourceAttachmentKey,
  type SuperAgentPromptSegment,
  type SuperAgentResourceAttachment,
} from '../../../shared/super-agent';
import { $createMentionNode, $isMentionNode, MentionEditorContext, MentionNode } from './MentionNode';

export const COMPOSER_FRAGMENT_MIME = 'application/x-openmotion-mention-fragment+json';

export type ComposerMentionTrigger = {
  active: boolean;
  kind: 'at' | 'slash';
  query: string;
} | null;

export type ComposerSnapshot = {
  text: string;
  segments: SuperAgentPromptSegment[];
  mentions: SuperAgentResourceAttachment[];
};

export type ComposerPromptEditorHandle = {
  focus: () => void;
  clear: () => void;
  clearTrigger: () => void;
  getSnapshot: () => ComposerSnapshot;
  setPlainText: (text: string) => void;
  setStructuredContent: (
    text: string,
    segments?: SuperAgentPromptSegment[],
    attachments?: SuperAgentResourceAttachment[],
  ) => void;
  insertMention: (
    item: SuperAgentResourceAttachment,
    options?: { replaceTrigger?: boolean },
  ) => void;
  removeMentionByKey: (attachmentKey: string) => void;
};

type MenuKeyAction = 'up' | 'down' | 'confirm' | 'escape';

const TRIGGER_RE = /(?:^|[^A-Za-z0-9_])@([^\s@]{0,64})$/;
const SLASH_TRIGGER_RE = /(?:^|\s)\/([^\s/]{0,40})$/;

function pushTextSegment(segments: SuperAgentPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === 'text') {
    last.text += text;
  } else {
    segments.push({ type: 'text', text });
  }
}

export function serializeLexicalEditorState(editorState: EditorState): ComposerSnapshot {
  let result: ComposerSnapshot = { text: '', segments: [], mentions: [] };
  editorState.read(() => {
    const root = $getRoot();
    const paragraphs = root.getChildren();
    const textParts: string[] = [];
    const segments: SuperAgentPromptSegment[] = [];
    const mentionMap = new Map<string, SuperAgentResourceAttachment>();

    paragraphs.forEach((para, paraIdx) => {
      if (paraIdx > 0) {
        textParts.push('\n');
        pushTextSegment(segments, '\n');
      }
      if ($isElementNode(para)) {
        for (const child of para.getChildren()) {
          if ($isMentionNode(child)) {
            const att = child.getAttachment();
            const key = resourceAttachmentKey(att);
            if (!mentionMap.has(key)) mentionMap.set(key, att);
            const tokenText = `@${att.title}`;
            textParts.push(tokenText);
            segments.push({
              type: 'mention',
              attachmentKey: key,
              label: att.title,
              kind: att.kind,
            });
          } else if ($isLineBreakNode(child)) {
            textParts.push('\n');
            pushTextSegment(segments, '\n');
          } else {
            const chunk = child.getTextContent();
            if (chunk) {
              textParts.push(chunk);
              pushTextSegment(segments, chunk);
            }
          }
        }
      } else {
        const chunk = para.getTextContent();
        if (chunk) {
          textParts.push(chunk);
          pushTextSegment(segments, chunk);
        }
      }
    });

    result = {
      text: textParts.join(''),
      segments,
      mentions: [...mentionMap.values()],
    };
  });
  return result;
}

function serializeSelectionSlice(selection: RangeSelection): ComposerSnapshot | null {
  const nodes = selection.getNodes();
  if (!nodes.some(node => $isMentionNode(node))) return null;

  const anchorPoint = selection.isBackward() ? selection.focus : selection.anchor;
  const focusPoint = selection.isBackward() ? selection.anchor : selection.focus;
  const textParts: string[] = [];
  const segments: SuperAgentPromptSegment[] = [];
  const mentionMap = new Map<string, SuperAgentResourceAttachment>();

  let lastParentKey: string | null = null;
  for (const node of nodes) {
    if ($isParagraphNode(node)) {
      if (lastParentKey !== null && lastParentKey !== node.getKey()) {
        textParts.push('\n');
        pushTextSegment(segments, '\n');
      }
      lastParentKey = node.getKey();
      continue;
    }
    const parentKey = node.getParent()?.getKey() ?? null;
    if (lastParentKey !== null && parentKey !== null && parentKey !== lastParentKey) {
      textParts.push('\n');
      pushTextSegment(segments, '\n');
    }
    if (parentKey) lastParentKey = parentKey;

    if ($isMentionNode(node)) {
      const att = node.getAttachment();
      const key = resourceAttachmentKey(att);
      if (!mentionMap.has(key)) mentionMap.set(key, att);
      const tokenText = `@${att.title}`;
      textParts.push(tokenText);
      segments.push({
        type: 'mention',
        attachmentKey: key,
        label: att.title,
        kind: att.kind,
      });
    } else if ($isLineBreakNode(node)) {
      textParts.push('\n');
      pushTextSegment(segments, '\n');
    } else if ($isTextNode(node)) {
      const full = node.getTextContent();
      const start = node.getKey() === anchorPoint.key ? anchorPoint.offset : 0;
      const end = node.getKey() === focusPoint.key ? focusPoint.offset : full.length;
      const chunk = full.slice(Math.min(start, end), Math.max(start, end));
      if (chunk) {
        textParts.push(chunk);
        pushTextSegment(segments, chunk);
      }
    }
  }

  return {
    text: textParts.join(''),
    segments,
    mentions: [...mentionMap.values()],
  };
}

function appendLinesToParagraphs(root: ReturnType<typeof $getRoot>, text: string) {
  const lines = text.split('\n');
  lines.forEach(line => {
    const para = $createParagraphNode();
    if (line) para.append($createTextNode(line));
    root.append(para);
  });
}

function detectTriggerInSelection(): ComposerMentionTrigger {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchorNode = selection.anchor.getNode();
  if (!$isTextNode(anchorNode)) return null;
  const textBefore = anchorNode.getTextContent().slice(0, selection.anchor.offset);
  const atMatched = TRIGGER_RE.exec(textBefore);
  if (atMatched) {
    return { active: true, kind: 'at', query: atMatched[1] ?? '' };
  }
  const slashMatched = SLASH_TRIGGER_RE.exec(textBefore);
  if (slashMatched) {
    return { active: true, kind: 'slash', query: slashMatched[1] ?? '' };
  }
  return null;
}

function extractClipboardFiles(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return [];
  if (clipboardData.files && clipboardData.files.length > 0) {
    return Array.from(clipboardData.files);
  }
  const files: File[] = [];
  if (clipboardData.items) {
    for (const item of Array.from(clipboardData.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  return files;
}

function removeAdjacentMentionOnBackspace(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
  const anchorNode = selection.anchor.getNode();
  if (selection.anchor.type === 'text' && selection.anchor.offset === 0) {
    const prev = anchorNode.getPreviousSibling();
    if ($isMentionNode(prev)) {
      prev.remove();
      return true;
    }
  } else if ($isElementNode(anchorNode) && selection.anchor.offset > 0) {
    const prev = anchorNode.getChildAtIndex(selection.anchor.offset - 1);
    if ($isMentionNode(prev)) {
      prev.remove();
      return true;
    }
  }
  return false;
}

function removeAdjacentMentionOnDelete(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
  const anchorNode = selection.anchor.getNode();
  if ($isTextNode(anchorNode) && selection.anchor.offset === anchorNode.getTextContentSize()) {
    const next = anchorNode.getNextSibling();
    if ($isMentionNode(next)) {
      next.remove();
      return true;
    }
  } else if ($isElementNode(anchorNode)) {
    const next = anchorNode.getChildAtIndex(selection.anchor.offset);
    if ($isMentionNode(next)) {
      next.remove();
      return true;
    }
  }
  return false;
}

function EditorPlugins({
  editorRef,
  disabled,
  mentionMenuOpen,
  onMenuKey,
  onChange,
  onTriggerChange,
  onSubmit,
  onCancelEdit,
  onPasteFiles,
  onRestoreMentions,
  onEmptyChange,
}: {
  editorRef: React.MutableRefObject<LexicalEditor | null>;
  disabled: boolean;
  mentionMenuOpen: boolean;
  onMenuKey?: (action: MenuKeyAction) => void;
  onChange: (snapshot: ComposerSnapshot) => void;
  onTriggerChange: (trigger: ComposerMentionTrigger) => void;
  onSubmit?: (oppositeFollowUp: boolean) => void;
  onCancelEdit?: () => void;
  onPasteFiles?: (files: File[]) => void;
  onRestoreMentions?: (items: SuperAgentResourceAttachment[]) => void;
  onEmptyChange: (empty: boolean) => void;
}) {
  const [editor] = useLexicalComposerContext();
  editorRef.current = editor;

  const mentionMenuOpenRef = useRef(mentionMenuOpen);
  mentionMenuOpenRef.current = mentionMenuOpen;
  const onMenuKeyRef = useRef(onMenuKey);
  onMenuKeyRef.current = onMenuKey;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onTriggerChangeRef = useRef(onTriggerChange);
  onTriggerChangeRef.current = onTriggerChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onCancelEditRef = useRef(onCancelEdit);
  onCancelEditRef.current = onCancelEdit;
  const onPasteFilesRef = useRef(onPasteFiles);
  onPasteFilesRef.current = onPasteFiles;
  const onRestoreMentionsRef = useRef(onRestoreMentions);
  onRestoreMentionsRef.current = onRestoreMentions;
  const onEmptyChangeRef = useRef(onEmptyChange);
  onEmptyChangeRef.current = onEmptyChange;

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  useEffect(() => {
    let lastTriggerJson = '';
    return editor.registerUpdateListener(({ editorState }) => {
      const snap = serializeLexicalEditorState(editorState);
      onEmptyChangeRef.current(snap.text.length === 0 && snap.mentions.length === 0);
      onChangeRef.current(snap);
      editorState.read(() => {
        if (editor.isComposing()) return;
        const trig = detectTriggerInSelection();
        const nextJson = JSON.stringify(trig);
        if (nextJson !== lastTriggerJson) {
          lastTriggerJson = nextJson;
          onTriggerChangeRef.current(trig);
        }
      });
    });
  }, [editor]);

  useEffect(() => {
    const cleanups = [
      editor.registerCommand(
        FOCUS_COMMAND,
        () => {
          if (!$isRangeSelection($getSelection())) {
            $getRoot().selectEnd();
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        event => {
          if (!mentionMenuOpenRef.current) return false;
          event?.preventDefault();
          onMenuKeyRef.current?.('down');
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        event => {
          if (!mentionMenuOpenRef.current) return false;
          event?.preventDefault();
          onMenuKeyRef.current?.('up');
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        event => {
          if (!mentionMenuOpenRef.current) return false;
          event?.preventDefault();
          onMenuKeyRef.current?.('confirm');
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        event => {
          if (event?.isComposing || event?.keyCode === 229) return false;
          if (mentionMenuOpenRef.current) {
            event?.preventDefault();
            onMenuKeyRef.current?.('confirm');
            return true;
          }
          if (!event?.shiftKey) {
            event?.preventDefault();
            onSubmitRef.current?.(Boolean(event?.metaKey || event?.ctrlKey));
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        event => {
          if (mentionMenuOpenRef.current) {
            event?.preventDefault();
            onMenuKeyRef.current?.('escape');
            return true;
          }
          if (onCancelEditRef.current) {
            event?.preventDefault();
            onCancelEditRef.current();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        event => {
          if (removeAdjacentMentionOnBackspace()) {
            event?.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_DELETE_COMMAND,
        event => {
          if (removeAdjacentMentionOnDelete()) {
            event?.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        COPY_COMMAND,
        event => {
          const clipboardData = event && 'clipboardData' in event ? event.clipboardData : null;
          if (!clipboardData) return false;
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;
          const slice = serializeSelectionSlice(selection);
          if (!slice) return false;
          event!.preventDefault();
          clipboardData.setData('text/plain', slice.text);
          clipboardData.setData(
            COMPOSER_FRAGMENT_MIME,
            JSON.stringify({ segments: slice.segments, mentions: slice.mentions }),
          );
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        CUT_COMMAND,
        event => {
          const clipboardData = event && 'clipboardData' in event ? event.clipboardData : null;
          if (!clipboardData) return false;
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;
          const slice = serializeSelectionSlice(selection);
          if (!slice) return false;
          event!.preventDefault();
          clipboardData.setData('text/plain', slice.text);
          clipboardData.setData(
            COMPOSER_FRAGMENT_MIME,
            JSON.stringify({ segments: slice.segments, mentions: slice.mentions }),
          );
          selection.removeText();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        PASTE_COMMAND,
        event => {
          const clipboardData = event && 'clipboardData' in event ? event.clipboardData : null;
          if (!clipboardData) return false;
          const rawFrag = clipboardData.getData(COMPOSER_FRAGMENT_MIME);
          if (rawFrag) {
            try {
              const parsed = JSON.parse(rawFrag) as {
                segments?: SuperAgentPromptSegment[];
                mentions?: SuperAgentResourceAttachment[];
              };
              if (Array.isArray(parsed.segments) && parsed.mentions?.length) {
                event!.preventDefault();
                const byKey = new Map(parsed.mentions.map(m => [resourceAttachmentKey(m), m]));
                let selection = $getSelection();
                if (!$isRangeSelection(selection)) {
                  $getRoot().selectEnd();
                  selection = $getSelection();
                }
                if ($isRangeSelection(selection)) {
                  const nodes: LexicalNode[] = [];
                  for (const seg of parsed.segments) {
                    if (seg.type === 'mention') {
                      const att = byKey.get(seg.attachmentKey);
                      if (att) nodes.push($createMentionNode(att));
                      else nodes.push($createTextNode(`@${seg.label}`));
                    } else if (seg.text) {
                      const lines = seg.text.split('\n');
                      lines.forEach((line, idx) => {
                        if (idx > 0) nodes.push($createLineBreakNode());
                        if (line) nodes.push($createTextNode(line));
                      });
                    }
                  }
                  if (nodes.length) selection.insertNodes(nodes);
                }
                onRestoreMentionsRef.current?.(parsed.mentions);
                return true;
              }
            } catch {
              /* fallback to default paste */
            }
          }

          const files = extractClipboardFiles(clipboardData);
          if (files.length > 0 && onPasteFilesRef.current) {
            event!.preventDefault();
            onPasteFilesRef.current(files);
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];

    return () => {
      for (const unregister of cleanups) unregister();
    };
  }, [editor]);

  return null;
}

export const ComposerPromptEditor = forwardRef<
  ComposerPromptEditorHandle,
  {
    ariaLabel: string;
    placeholder: string;
    disabled?: boolean;
    mentionMenuOpen?: boolean;
    onMenuKey?: (action: MenuKeyAction) => void;
    onChange: (snapshot: ComposerSnapshot) => void;
    onTriggerChange: (trigger: ComposerMentionTrigger) => void;
    onSubmit?: (oppositeFollowUp: boolean) => void;
    onCancelEdit?: () => void;
    onPasteFiles?: (files: File[]) => void;
    onRestoreMentions?: (items: SuperAgentResourceAttachment[]) => void;
    onOpenMention?: (item: SuperAgentResourceAttachment) => void;
  }
>(function ComposerPromptEditor(
  {
    ariaLabel,
    placeholder,
    disabled = false,
    mentionMenuOpen = false,
    onMenuKey,
    onChange,
    onTriggerChange,
    onSubmit,
    onCancelEdit,
    onPasteFiles,
    onRestoreMentions,
    onOpenMention,
  },
  ref,
) {
  const editorRef = useRef<LexicalEditor | null>(null);
  const [isEmpty, setIsEmpty] = useState(true);

  const initialConfig = useMemo(
    () => ({
      namespace: 'OpenMotionSuperAgentComposer',
      nodes: [MentionNode],
      editable: !disabled,
      theme: {
        paragraph: 'om-sa-composer-paragraph',
      },
      onError(error: Error) {
        console.error('SuperAgent Composer Error:', error);
      },
    }),
    [],
  );

  const mentionContextValue = useMemo(
    () => ({ onOpenMention }),
    [onOpenMention],
  );

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        editorRef.current?.focus();
      },
      clear() {
        const editor = editorRef.current;
        if (!editor) return;
        const wasFocused = editor.getRootElement() === document.activeElement;
        editor.update(
          () => {
            const root = $getRoot();
            root.clear();
            const para = $createParagraphNode();
            root.append(para);
            if (wasFocused) para.selectEnd();
            else $setSelection(null);
          },
          { discrete: true },
        );
        editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
        setIsEmpty(true);
      },
      clearTrigger() {
        const editor = editorRef.current;
        if (!editor) return;
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const anchorNode = selection.anchor.getNode();
          if (!$isTextNode(anchorNode)) return;
          const full = anchorNode.getTextContent();
          const offset = selection.anchor.offset;
          const before = full.slice(0, offset);
          const atMatched = /(?:^|([^A-Za-z0-9_]))@([^\s@]{0,64})$/.exec(before);
          const slashMatched = atMatched ? null : /(?:^|(\s))\/([^\s/]{0,40})$/.exec(before);
          const matched = atMatched ?? slashMatched;
          if (!matched) return;
          const tokenStart = matched.index + (matched[1] ? matched[1].length : 0);
          const nextText = full.slice(0, tokenStart) + full.slice(offset);
          anchorNode.setTextContent(nextText);
          anchorNode.select(tokenStart, tokenStart);
        });
      },
      getSnapshot() {
        const editor = editorRef.current;
        if (!editor) return { text: '', segments: [], mentions: [] };
        return serializeLexicalEditorState(editor.getEditorState());
      },
      setPlainText(text: string) {
        const editor = editorRef.current;
        if (!editor) return;
        editor.update(() => {
          const root = $getRoot();
          root.clear();
          appendLinesToParagraphs(root, text);
          root.selectEnd();
        });
      },
      setStructuredContent(text, segments, attachments = []) {
        const editor = editorRef.current;
        if (!editor) return;
        const byKey = new Map(attachments.map(item => [resourceAttachmentKey(item), item]));
        editor.update(() => {
          const root = $getRoot();
          root.clear();
          if (!segments?.length) {
            appendLinesToParagraphs(root, text);
            root.selectEnd();
            return;
          }
          let para = $createParagraphNode();
          root.append(para);
          for (const seg of segments) {
            if (seg.type === 'mention') {
              const att = byKey.get(seg.attachmentKey);
              if (att) {
                para.append($createMentionNode(att));
              } else {
                para.append($createTextNode(`@${seg.label}`));
              }
            } else if (seg.text) {
              const lines = seg.text.split('\n');
              lines.forEach((line, idx) => {
                if (idx > 0) {
                  para = $createParagraphNode();
                  root.append(para);
                }
                if (line) para.append($createTextNode(line));
              });
            }
          }
          para.selectEnd();
        });
      },
      insertMention(item, opts) {
        const editor = editorRef.current;
        if (!editor) return;
        editor.update(() => {
          let selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            $getRoot().selectEnd();
            selection = $getSelection();
          }
          if (!$isRangeSelection(selection)) return;

          if (opts?.replaceTrigger) {
            const anchorNode = selection.anchor.getNode();
            if (selection.isCollapsed() && $isTextNode(anchorNode)) {
              const full = anchorNode.getTextContent();
              const offset = selection.anchor.offset;
              const before = full.slice(0, offset);
              const matched = /(?:^|([^A-Za-z0-9_]))@([^\s@]{0,64})$/.exec(before);
              if (matched) {
                const tokenStart = matched.index + (matched[1] ? matched[1].length : 0);
                const nextText = full.slice(0, tokenStart) + full.slice(offset);
                const beforeText = full.slice(0, tokenStart);
                const afterText = full.slice(offset);
                const mentionNode = $createMentionNode(item);
                const trailingSpace = $createTextNode(afterText.startsWith(' ') ? '' : ' ');

                if (!nextText) {
                  anchorNode.replace(mentionNode);
                  if (trailingSpace.getTextContent()) {
                    mentionNode.insertAfter(trailingSpace);
                    trailingSpace.selectEnd();
                  } else {
                    mentionNode.selectNext();
                  }
                  return;
                }

                anchorNode.setTextContent(beforeText);
                if (beforeText) {
                  anchorNode.insertAfter(mentionNode);
                } else {
                  anchorNode.replace(mentionNode);
                }
                const afterNode = afterText ? $createTextNode(afterText) : null;
                if (trailingSpace.getTextContent()) {
                  mentionNode.insertAfter(trailingSpace);
                  if (afterNode) trailingSpace.insertAfter(afterNode);
                  trailingSpace.selectEnd();
                } else if (afterNode) {
                  mentionNode.insertAfter(afterNode);
                  afterNode.select(0, 0);
                } else {
                  mentionNode.selectNext();
                }
                return;
              }
            }
          }

          const mentionNode = $createMentionNode(item);
          const trailingSpace = $createTextNode(' ');
          selection.insertNodes([mentionNode, trailingSpace]);
          trailingSpace.selectEnd();
        });
      },
      removeMentionByKey(attachmentKey) {
        const editor = editorRef.current;
        if (!editor) return;
        editor.update(() => {
          const visit = (nodes: LexicalNode[]) => {
            for (const node of nodes) {
              if ($isMentionNode(node) && resourceAttachmentKey(node.getAttachment()) === attachmentKey) {
                node.remove();
              } else if ($isElementNode(node)) {
                visit(node.getChildren());
              }
            }
          };
          visit($getRoot().getChildren());
        });
      },
    }),
    [],
  );

  return (
    <MentionEditorContext.Provider value={mentionContextValue}>
      <div className="om-sa-composer-editor-shell" data-empty={isEmpty || undefined} data-disabled={disabled || undefined}>
        <LexicalComposer initialConfig={initialConfig}>
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                className="om-sa-composer-editor"
                aria-label={ariaLabel}
                aria-multiline="true"
                aria-disabled={disabled ? 'true' : undefined}
                data-placeholder={placeholder}
                spellCheck
              />
            }
            placeholder={
              <div className="om-sa-composer-placeholder" aria-hidden="true">
                {placeholder}
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <EditorPlugins
            editorRef={editorRef}
            disabled={disabled}
            mentionMenuOpen={mentionMenuOpen}
            onMenuKey={onMenuKey}
            onChange={onChange}
            onTriggerChange={onTriggerChange}
            onSubmit={onSubmit}
            onCancelEdit={onCancelEdit}
            onPasteFiles={onPasteFiles}
            onRestoreMentions={onRestoreMentions}
            onEmptyChange={setIsEmpty}
          />
        </LexicalComposer>
      </div>
    </MentionEditorContext.Provider>
  );
});
