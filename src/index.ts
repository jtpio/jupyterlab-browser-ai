import { providerRegistryPlugin } from './provider-registry';
import { chromeAIImagePlugin } from './chrome-ai-alt-text';
import { chromeAIAudioPlugin } from './chrome-ai-audio-transcript';
import { chromeAIProofreaderPlugin } from './chrome-ai-proofreader';
import { chromeAISummarizerPlugin } from './chrome-ai-file-summarizer';

export default [
  providerRegistryPlugin,
  chromeAIImagePlugin,
  chromeAIAudioPlugin,
  chromeAIProofreaderPlugin,
  chromeAISummarizerPlugin
];
