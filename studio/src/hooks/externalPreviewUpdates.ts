/** Files still owed to this preview. A newer update can cover the same file independently. */
export class ExternalPreviewUpdates {
  private pending = new Map<string, symbol>();

  clear(): void {
    this.pending.clear();
  }

  track(
    files: readonly string[] | undefined,
    inPlace: Promise<boolean> | void,
    reload: (path: string | readonly string[]) => void,
  ): void {
    const ticket = Symbol();
    // A reconnect with unknown scope cannot be satisfied by an update to a known file.
    const keys = files?.length ? files : ["."];
    for (const key of keys) this.pending.set(key, ticket);

    const settle = (applied: boolean) => {
      const owed = keys.filter(key => this.pending.get(key) === ticket);
      for (const key of owed) this.pending.delete(key);
      if (applied || !owed.length) return;
      // Other paths may still acknowledge an in-place change; their recovery is independent.
      if (owed.includes(".")) reload(".");
      else reload(owed.length === 1 ? owed[0]! : owed);
    };
    if (inPlace) void inPlace.then(settle, () => settle(false));
    else settle(false);
  }
}
