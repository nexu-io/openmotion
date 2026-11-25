import { useEffect, useMemo, useState } from 'react';
import { summarizeSuperAgentChat, type SuperAgentChat, type SuperAgentChatSummary } from '../../../shared/super-agent';

const STORAGE_PREFIX = 'motion.super-agent.read-result.';

type ResultVersion = Pick<SuperAgentChatSummary, 'state' | 'messageCount' | 'lastTurnId' | 'updatedAt'>;

function hasResult({ state, messageCount }: ResultVersion): boolean {
  return state === 'idle' && messageCount > 0;
}

function sameResult(read: ResultVersion | undefined, result: ResultVersion): boolean {
  if (!read || read.state !== result.state) return false;
  return read.lastTurnId && result.lastTurnId
    ? read.lastTurnId === result.lastTurnId
    : read.messageCount === result.messageCount;
}

function parseResult(value: string | null): ResultVersion | undefined {
  if (!value) return undefined;
  try {
    const result = JSON.parse(value) as ResultVersion | null;
    if (result && hasResult(result) && Number.isInteger(result.messageCount) && Number.isFinite(result.updatedAt)) {
      return result;
    }
  } catch { /* Ignore unreadable browser data. */ }
}

function restoreReadResults(): Map<string, ResultVersion> {
  const results = new Map<string, ResultVersion>();
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      const result = parseResult(localStorage.getItem(key));
      if (result) results.set(key.slice(STORAGE_PREFIX.length), result);
    }
  } catch { /* Reading still works in memory when storage is unavailable. */ }
  return results;
}

export function useReadTaskResults(viewedChat: SuperAgentChat | null): (item: SuperAgentChatSummary) => boolean {
  const [readResults, setReadResults] = useState(restoreReadResults);
  const [visible, setVisible] = useState(() => !document.hidden);

  useEffect(() => {
    const updateVisibility = () => setVisible(!document.hidden);
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return;
      if (event.key === null) {
        setReadResults(new Map());
        return;
      }
      if (!event.key.startsWith(STORAGE_PREFIX)) return;
      const id = event.key.slice(STORAGE_PREFIX.length);
      const result = parseResult(event.newValue);
      setReadResults(previous => {
        const known = previous.get(id);
        if (result && known && known.updatedAt > result.updatedAt) return previous;
        const next = new Map(previous);
        if (result) next.set(id, result);
        else next.delete(id);
        return next;
      });
    };
    document.addEventListener('visibilitychange', updateVisibility);
    window.addEventListener('storage', onStorage);
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const viewedResult = useMemo(() => {
    if (!visible || viewedChat?.state !== 'idle') return null;
    const summary = summarizeSuperAgentChat(viewedChat);
    return hasResult(summary) ? summary : null;
  }, [visible, viewedChat]);

  useEffect(() => {
    if (!viewedResult) return;
    const { id, state, messageCount, lastTurnId, updatedAt } = viewedResult;
    const known = readResults.get(id);
    if (sameResult(known, viewedResult) || (known && known.updatedAt > updatedAt)) return;

    let version: ResultVersion = { state, messageCount, lastTurnId, updatedAt };
    try {
      const key = STORAGE_PREFIX + id;
      const stored = parseResult(localStorage.getItem(key));
      if (stored && (stored.updatedAt > updatedAt || sameResult(stored, version))) {
        version = stored;
      } else {
        localStorage.setItem(key, JSON.stringify(version));
      }
    } catch { /* Keep the read marker for this session. */ }
    setReadResults(previous => new Map(previous).set(id, version));
  }, [readResults, viewedResult]);

  return item => hasResult(item) && (
    (viewedResult?.id === item.id && sameResult(viewedResult, item)) || sameResult(readResults.get(item.id), item)
  );
}
