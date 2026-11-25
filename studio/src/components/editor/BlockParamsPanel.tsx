import { IconButton } from "open-design-ui/icon-button";
import { OverflowText } from "../ui/OverflowText";
import { previewBlockColor } from "./blockColorDraft";
import { ColorField } from "./propertyPanelColor";
import { FieldInput, NativeSelect } from "../ui/FormField";
import { RemixIcon } from "../../icons/RemixIcons";
import { useI18n } from "../../i18n/I18n";
import { systemMessage } from "../../i18n/systemMessages";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { BlockParam } from "@hyperframes/core/registry";
import { useFileManagerContextOptional } from "../../contexts/FileManagerContext";
import { useStudioPlaybackContext } from "../../contexts/StudioContext";
import { trackBlockParamCommit } from "../../telemetry/events";
import { StudioFileConflictError } from "../../utils/studioSaveDiagnostics";
import { createTypingSave } from "../../utils/typingSave";
import { serializeStudioFileMutation } from "../../utils/studioFileMutationCoordinator";
const loadParameterEditor = () => import("../../../../packages/edit-core/composition-variable");

interface BlockParamsPanelProps {
  blockName: string;
  blockTitle: string;
  params: BlockParam[];
  compositionPath: string;
  previewIframeRef?: React.RefObject<HTMLIFrameElement | null>;
  onClose: () => void;
}

type CommitState = { tone: "idle" | "saving" | "saved" | "error"; message?: string };

export const BlockParamsPanel = memo(function BlockParamsPanel({
  blockName,
  blockTitle,
  params,
  compositionPath,
  previewIframeRef,
  onClose,
}: BlockParamsPanelProps) {
  const { t } = useI18n();
  const fileManager = useFileManagerContextOptional();
  const { setRefreshKey } = useStudioPlaybackContext();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const p of params) {
      initial[p.key] = p.default;
    }
    return initial;
  });
  // Last value actually written to the block file per param — the literal we
  // substitute when the next commit rewrites the file.
  const appliedRef = useRef<Record<string, string>>(
    Object.fromEntries(params.map((p) => [p.key, p.default])),
  );
  const [commitState, setCommitState] = useState<CommitState>({ tone: "idle" });
  const queues = useRef(new Map<string, ReturnType<typeof createTypingSave>>());

  const previewable = useRef(new Set<string>());
  const needsRefresh = useRef(false);
  const drafts = useRef(new Map<string, { submitted: boolean; settle?: (saved: boolean) => void }>());
  const edited = useRef(new Set<string>());
  const read = fileManager?.readProjectFile;
  useEffect(() => {
    if (!read) return;
    let current = true;
    void Promise.all([read(compositionPath), loadParameterEditor()]).then(([content, editor]) => {
      if (!current) return;
      const { values: declared, cssKeys } = editor.readCompositionParameters(content, params.map(param => param.key));
      // Canvas and GPU textures may capture colors once during startup. Rebuild these after saving.
      previewable.current = /<canvas\b/i.test(content) ? new Set() :
        new Set(params.filter(param => param.type === "color" && cssKeys.has(param.key)).map(param => param.key));
      const saved: Record<string, string> = {};
      for (const param of params) {
        const id = editor.declaredParameterId(declared.keys(), param.key);
        if (id && !edited.current.has(param.key)) saved[param.key] = declared.get(id)!;
      }
      Object.assign(appliedRef.current, saved);
      setValues(existing => ({ ...existing, ...saved }));
    }).catch(() => { /* A commit retries the versioned read and reports a failure. */ });
    return () => { current = false; };
  }, [compositionPath, params, read]);

  const commitParamNow = useCallback(
    async (key: string, nextValue: string, isCurrent: () => boolean) => {
      if (!fileManager) return false;
      const previous = appliedRef.current[key];
      if (previous === undefined) return false;
      setCommitState({ tone: "saving" });
      try {
        const [content, editor] = await Promise.all([fileManager.readProjectFile(compositionPath), loadParameterEditor()]);
        const after = editor.setBlockParameter(content, key, nextValue, compositionPath, previous);
        if (after !== content) {
          await fileManager.writeProjectFile(compositionPath, after, content, {
            kind: "setBlockParameter", compositionPath, key, previous, value: nextValue,
          });
        }
        appliedRef.current[key] = nextValue;
        if (isCurrent()) setCommitState({ tone: "saved" });
        trackBlockParamCommit({ tone: "saved", blockName, key });
        return true;
      } catch (error) {
        let confirmed = previous;
        if (error instanceof StudioFileConflictError && error.filePath === compositionPath) {
          try {
            const [source, editor] = await Promise.all([
              error.currentContent ?? fileManager.readProjectFile(compositionPath), loadParameterEditor(),
            ]);
            const values = editor.compositionVariableValues(source, [key]);
            const id = values && editor.declaredParameterId(values.keys(), key);
            if (values && id) confirmed = values.get(id) ?? previous;
          } catch { /* Keep the last known value if the current file is unavailable. */ }
          appliedRef.current[key] = confirmed;
        }
        if (isCurrent()) {
          setValues(drafts => ({ ...drafts, [key]: confirmed }));
          setCommitState({ tone: "error", message: error instanceof Error ? error.message : "Couldn't save the block file. Retry?" });
        }
        trackBlockParamCommit({ tone: "error", blockName, key });
        return false;
      }
    },
    [fileManager, compositionPath, blockName],
  );

  // Commits join the file's queue: two read-modify-writes of one file must not interleave.
  const commitParam = useCallback(
    (key: string, nextValue: string, isCurrent: () => boolean) =>
      fileManager
        ? serializeStudioFileMutation(fileManager.writeProjectFile, compositionPath, () =>
            commitParamNow(key, nextValue, isCurrent),
          )
        : Promise.resolve(),
    [commitParamNow, compositionPath, fileManager],
  );

  const handleChange = (key: string, value: string, composing = false) => {
    edited.current.add(key);
    setValues(prev => ({ ...prev, [key]: value }));
    if (composing) return;
    let queue = queues.current.get(key);
    if (!queue) queues.current.set(key, queue = createTypingSave(300));
    const prior = drafts.current.get(key);
    const draft = { submitted: false, settle: previewable.current.has(key)
      ? previewBlockColor(previewIframeRef?.current, compositionPath, key, value) : undefined };
    drafts.current.set(key, draft);
    if (prior && !prior.submitted) prior.settle?.(false);
    queue.schedule(async () => {
      draft.submitted = true;
      const saved = await commitParam(key, value, () => drafts.current.get(key) === draft);
      draft.settle?.(saved === true);
      if (saved) needsRefresh.current = true;
      if (drafts.current.get(key) !== draft) return;
      drafts.current.delete(key);
      if (needsRefresh.current && !drafts.current.size) {
        needsRefresh.current = false;
        setRefreshKey((k) => k + 1);
      }
    });
  };

  useEffect(() => () => {
    for (const queue of queues.current.values()) void queue.flush();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800">
        <div className="text-[11px] font-semibold text-neutral-200 truncate">{blockTitle}</div>
        <IconButton variant="plain"
          type="button"
          onClick={onClose}
          aria-label={t("Close block parameters")}
          className="p-1.5 -m-1 text-neutral-500 hover:text-neutral-300 active:scale-[0.97] transition-colors"
          icon={<RemixIcon name="close-line" size={14} />}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div className="text-[9px] font-medium text-neutral-500 uppercase tracking-wider">
          {t("Parameters")}</div>
        {params.length === 0 && (
          <div className="text-[10px] text-neutral-500">{t("This block has no editable parameters.")}</div>
        )}
        {!fileManager && params.length > 0 && (
          <div className="text-[10px] text-warning-ink">
            {t("Block params can't be edited here: no project file access.")}</div>
        )}
        {params.map((param) => (
          <ParamControl
            key={param.key}
            param={param}
            value={values[param.key] ?? param.default}
            disabled={!fileManager}
            onChange={(v, composing) => handleChange(param.key, v, composing)}
            onFlush={() => { void queues.current.get(param.key)?.flush(); }}
          />
        ))}
        {commitState.tone === "saving" && (
          <div className="text-[10px] text-neutral-500" role="status">
            {t("Saving…")}</div>
        )}
        {commitState.tone === "saved" && (
          <div className="text-[10px] text-accent-ink" role="status">
            {t("Saved to")}{" "}{compositionPath}
          </div>
        )}
        {commitState.tone === "error" && (
          <div className="text-[10px] text-danger-ink" role="alert">
            {commitState.message && systemMessage(commitState.message, t)}
          </div>
        )}
      </div>
    </div>
  );
});


function ParamControl({
  param,
  value,
  disabled,
  onChange,
  onFlush,
}: {
  param: BlockParam;
  value: string;
  disabled?: boolean;
  onChange: (value: string, composing?: boolean) => void;
  onFlush: () => void;
}) {
  const composing = useRef(false);
  const { t } = useI18n();
  if (param.type === "color") {
    return (
      <ColorField
        label={t(param.label)}
        value={value}
        disabled={disabled}
        allowCssValue
        onCommit={onChange}
      />
    );
  }
  return (
    <div className="space-y-1">
      <OverflowText text={t(param.label)} className="block min-w-0 truncate text-[10px] font-medium text-neutral-400" />

      {param.type === "number" && (
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={param.min ?? 0}
            max={param.max ?? 100}
            step={param.step ?? 1}
            value={value}
            disabled={disabled}
            aria-label={t(param.label)}
            onChange={(e) => onChange(e.target.value)}
            className="flex-1 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span className="text-[10px] text-neutral-400 w-8 text-right tabular-nums">{value}</span>
        </div>
      )}

      {param.type === "text" && (
        <FieldInput
          type="text"
          value={value}
          disabled={disabled}
          aria-label={t(param.label)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(e) => { composing.current = false; onChange(e.currentTarget.value); }}
          onChange={(e) => onChange(e.currentTarget.value, composing.current)}
          onBlur={() => { if (!composing.current) onFlush(); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !composing.current && !e.nativeEvent.isComposing) onFlush(); }}
          className="w-full bg-neutral-900 border border-neutral-800 rounded-sm px-2 py-1 text-[10px] text-neutral-200 focus:outline-hidden focus:border-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
        />
      )}

      {param.type === "select" && param.options && (
        <NativeSelect
          value={value}
          disabled={disabled}
          aria-label={t(param.label)}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-neutral-900 border border-neutral-800 rounded-sm px-2 py-1 text-[10px] text-neutral-200 focus:outline-hidden focus:border-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {param.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.label)}
            </option>
          ))}
        </NativeSelect>
      )}
    </div>
  );
}
