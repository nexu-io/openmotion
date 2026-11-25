import { describe, expect, it } from 'vitest';
import { readSuperAgentPromptLink, withoutSuperAgentPromptLink } from './superAgentPromptLink';

describe('Super Agent prompt link', () => {
  it('reads a prefilled new-chat handoff that is never auto-sent', () => {
    expect(readSuperAgentPromptLink('?prompt=Remix%20this&mode=game')).toEqual({
      prompt: 'Remix this', mode: 'game', newChat: true, autoSend: false,
    });
  });
  it('ignores empty prompts and unknown modes', () => {
    expect(readSuperAgentPromptLink('?prompt=%20%20')).toBeNull();
    expect(readSuperAgentPromptLink('')).toBeNull();
    expect(readSuperAgentPromptLink('?prompt=x&mode=shell')).toEqual({ prompt: 'x', newChat: true, autoSend: false });
  });
  it('caps the prompt length', () => {
    expect(readSuperAgentPromptLink(`?prompt=${'a'.repeat(9000)}`)?.prompt).toHaveLength(8000);
  });
  it('strips only the one-shot parameters', () => {
    expect(withoutSuperAgentPromptLink('http://127.0.0.1:5/agent?prompt=x&mode=game&lang=zh#a')).toBe('/agent?lang=zh#a');
  });
});
