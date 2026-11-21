import {
  isExtensionOnlyStackText,
  isNoisyCompositionAssetError,
} from "@openmotion/observability/sanitize";

export function errorProps(value: unknown): {
  error_message: string;
  error_name: string | null;
  stack_trace: string | null;
} {
  if (value instanceof Error) {
    return {
      error_message: value.message,
      error_name: value.name,
      stack_trace: value.stack?.slice(0, 4000) ?? null,
    };
  }
  return { error_message: String(value), error_name: null, stack_trace: null };
}

export function isCompositionAssetError(msg: string, name: string | null): boolean {
  return isNoisyCompositionAssetError(msg, name);
}

/** True when every frame is an extension's script: a failure no Studio code took part in. */
export function isExtensionOnlyStack(stack: string | null): boolean {
  return isExtensionOnlyStackText(stack);
}
