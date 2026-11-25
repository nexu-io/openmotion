import openaiLogo from '../../../packages/design-system/providers/openai.svg';
import claudeCodeLogo from '../../../packages/design-system/providers/claudecode-color.svg';
import deepseekLogo from '../../../packages/design-system/providers/deepseek-color.svg';
import geminiLogo from '../../../packages/design-system/providers/gemini-color.svg';
import qwenLogo from '../../../packages/design-system/providers/qwen-color.svg';
import kimiLogo from '../../../packages/design-system/providers/kimi-color.svg';
import zaiLogo from '../../../packages/design-system/providers/zai.svg';
import minimaxLogo from '../../../packages/design-system/providers/minimax-color.svg';
import doubaoLogo from '../../../packages/design-system/providers/doubao-color.svg';
import mistralLogo from '../../../packages/design-system/providers/mistral-color.svg';
import grokLogo from '../../../packages/design-system/providers/grok.svg';
import bytedanceLogo from '../../../packages/design-system/providers/models/bytedance-color.svg';
import fluxLogo from '../../../packages/design-system/providers/models/flux.svg';
import sunoLogo from '../../../packages/design-system/providers/models/suno.svg';
import elevenlabsLogo from '../../../packages/design-system/providers/models/elevenlabs.svg';
import nanoBananaLogo from '../../../packages/design-system/providers/models/nano-banana-color.svg';

export interface ModelLogoAsset {
  id: string;
  label: string;
  src: string;
}

export const MODEL_LOGO_ASSETS: readonly ModelLogoAsset[] = [
  { id: 'openai', label: 'GPT', src: openaiLogo },
  { id: 'claude', label: 'Claude', src: claudeCodeLogo },
  { id: 'gemini', label: 'Gemini 4', src: geminiLogo },
  { id: 'deepseek', label: 'DeepSeek', src: deepseekLogo },
  { id: 'qwen', label: 'Qwen', src: qwenLogo },
  { id: 'kimi', label: 'Kimi', src: kimiLogo },
  { id: 'zai', label: 'Z.ai', src: zaiLogo },
  { id: 'minimax', label: 'MiniMax', src: minimaxLogo },
  { id: 'doubao', label: 'Seedance', src: doubaoLogo },
  { id: 'flux', label: 'FLUX', src: fluxLogo },
  { id: 'suno', label: 'Suno', src: sunoLogo },
  { id: 'elevenlabs', label: 'ElevenLabs', src: elevenlabsLogo },
  { id: 'nano-banana', label: 'Nano Banana', src: nanoBananaLogo },
  { id: 'mistral', label: 'Mistral', src: mistralLogo },
  { id: 'bytedance', label: 'ByteDance', src: bytedanceLogo },
  { id: 'grok', label: 'Grok', src: grokLogo },
];
