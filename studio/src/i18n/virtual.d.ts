declare module 'virtual:openmotion-i18n/meta' {
  export const knownKeyHashes: readonly string[];
  export const legacyZhReverse: Readonly<Record<string, string>>;
}

declare module 'virtual:openmotion-i18n/locale/*' {
  import type { Message } from './manifest';
  const dictionary: Readonly<Record<string, Message>>;
  export default dictionary;
}
