/**
 * K9 — Terminal Confirmation Prompt for Web Connect Script & One-Shot CLI.
 *
 * Formats shell-computed HostConfirmationRequest facts (Program, File, URL,
 * Component, Credential) into clear plain terminal output and asks the user
 * for explicit `[y/N]` approval before any host mutation occurs.
 */

import { createInterface } from 'node:readline/promises';
import type {
  ConfirmationFactKind,
  HostConfirmationRequest,
} from '../../shared/desktop-contract.ts';

export type ConfirmFn = (request: HostConfirmationRequest) => Promise<boolean>;

export const CONFIRMATION_FACT_KIND_LABELS: Record<ConfirmationFactKind, string> = {
  exec_program: 'Program',
  modify_file: 'File',
  connect_url: 'URL',
  install_component: 'Component',
  store_credential: 'Credential',
};

export type TerminalConfirmOptions = {
  /**
   * Auto-approve without prompting ONLY when the user explicitly passes `--yes`
   * to the CLI. Facts are still written to output for auditability.
   */
  yes?: boolean;
  /** Injectable readable stream for tests (defaults to `process.stdin`). */
  input?: NodeJS.ReadableStream;
  /** Injectable writable stream for tests (defaults to `process.stdout`). */
  output?: NodeJS.WritableStream;
  /** Optional custom question prompt function for deterministic tests. */
  ask?: (promptText: string) => Promise<string>;
};

/**
 * Formats a shell-computed confirmation request into plain terminal text
 * listing every audited fact with its canonical kind label.
 */
export function formatConfirmationRequest(request: HostConfirmationRequest): string {
  const lines: string[] = [
    `Confirmation required: ${request.featureTitle} (${request.featureId}@${request.featureVersion})`,
  ];

  if (request.facts.length === 0) {
    lines.push('  - (no host changes declared)');
  } else {
    for (const fact of request.facts) {
      const kindLabel = CONFIRMATION_FACT_KIND_LABELS[fact.kind];
      const detailLabel = fact.label.trim();
      const prefix =
        detailLabel.length > 0 && detailLabel.toLowerCase() !== kindLabel.toLowerCase()
          ? `${kindLabel} (${detailLabel})`
          : kindLabel;
      lines.push(`  - ${prefix}: ${fact.value}`);
    }
  }

  return lines.join('\n');
}

function isAffirmativeAnswer(rawAnswer: string): boolean {
  const normalized = rawAnswer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

/**
 * Creates a `ConfirmFn` backed by plain terminal I/O.
 * Defaults to fail-closed (`false`) on empty input, `n`, invalid input, or EOF.
 */
export function createTerminalConfirm(options: TerminalConfirmOptions = {}): ConfirmFn {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const promptText = 'Proceed? [y/N] ';

  return async (request: HostConfirmationRequest): Promise<boolean> => {
    const formatted = formatConfirmationRequest(request);
    output.write(`${formatted}\n`);

    if (options.yes === true) {
      output.write('Auto-confirmed (--yes).\n');
      return true;
    }

    if (options.ask) {
      try {
        const answer = await options.ask(promptText);
        return isAffirmativeAnswer(answer);
      } catch {
        return false;
      }
    }

    const rl = createInterface({
      input,
      output,
      terminal: Boolean((output as NodeJS.WriteStream).isTTY),
    });

    try {
      const answer = await rl.question(promptText);
      return isAffirmativeAnswer(answer);
    } catch {
      return false;
    } finally {
      rl.close();
    }
  };
}

/**
 * Convenience helper for a single terminal confirmation prompt.
 */
export function confirmInTerminal(
  request: HostConfirmationRequest,
  options?: TerminalConfirmOptions,
): Promise<boolean> {
  return createTerminalConfirm(options)(request);
}
