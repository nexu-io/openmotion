function copyWithSelection(text: string): boolean {
  if (typeof document === "undefined" || !document.body || !document.execCommand) {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.padding = "0";
  textarea.style.border = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";

  const openDialogs = document.querySelectorAll("dialog[open]");
  const mountTarget = openDialogs.length > 0 ? openDialogs[openDialogs.length - 1] : document.body;
  const previousFocus = document.activeElement as { isConnected?: boolean; focus?: (options?: { preventScroll?: boolean }) => void } | null;

  mountTarget.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function") {
      previousFocus.focus({ preventScroll: true });
    }
  }
}

function shouldCopyWithSelectionFirst(): boolean {
  if (typeof navigator === "undefined") return false;

  const userAgent = navigator.userAgent;
  return /Safari/i.test(userAgent) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR/i.test(userAgent);
}

export type CopyMethod = "clipboard_api" | "exec_command";

export async function copyTextWithMethod(text: string): Promise<CopyMethod | false> {
  const useSelectionFirst = shouldCopyWithSelectionFirst();
  if (useSelectionFirst && copyWithSelection(text)) {
    return "exec_command";
  }

  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return "clipboard_api";
    } catch {
      // Fall back below when the browser still allows synchronous copy.
    }
  }

  return !useSelectionFirst && copyWithSelection(text) ? "exec_command" : false;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  return Boolean(await copyTextWithMethod(text));
}
