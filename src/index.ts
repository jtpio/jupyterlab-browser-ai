import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Notification } from '@jupyterlab/apputils';

import { IChatProviderRegistry, IChatProviderInfo } from '@jupyterlite/ai';

import { builtInAI, doesBrowserSupportBuiltInAI } from '@built-in-ai/core';
import { webLLM, doesBrowserSupportWebLLM } from '@built-in-ai/web-llm';

import { aisdk } from '@openai/agents-extensions';

/**
 * Initialization data for the jupyterlab-browser-ai extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-browser-ai:plugin',
  description: 'In-browser AI in JupyterLab and Jupyter Notebook',
  autoStart: true,
  requires: [IChatProviderRegistry],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    chatProviderRegistry: IChatProviderRegistry,
    settingRegistry: ISettingRegistry | null
  ) => {
    if (doesBrowserSupportBuiltInAI()) {
      const chromeAIInfo: IChatProviderInfo = {
        id: 'chrome-ai',
        name: 'Chrome Built-in AI',
        requiresApiKey: false,
        defaultModels: ['chrome-ai'],
        supportsBaseURL: false,
        supportsHeaders: false,
        supportsToolCalling: false,
        factory: () => {
          return aisdk(builtInAI('text'));
        }
      };

      chatProviderRegistry.registerProvider(chromeAIInfo);
    }

    if (doesBrowserSupportWebLLM()) {
      const webLLMInfo: IChatProviderInfo = {
        id: 'web-llm',
        name: 'WebLLM',
        requiresApiKey: false,
        defaultModels: [
          'Llama-3.2-3B-Instruct-q4f16_1-MLC',
          'Llama-3.2-1B-Instruct-q4f16_1-MLC',
          'Phi-3.5-mini-instruct-q4f16_1-MLC',
          'gemma-2-2b-it-q4f16_1-MLC',
          'Qwen3-0.6B-q4f16_1-MLC'
        ],
        supportsBaseURL: false,
        supportsHeaders: false,
        supportsToolCalling: false,
        factory: (options: { model?: string }) => {
          const modelName =
            options.model ?? 'Llama-3.2-3B-Instruct-q4f16_1-MLC';

          let notificationId: string | null = null;

          const model = webLLM(modelName, {
            worker: new Worker(new URL('./webllm-worker.js', import.meta.url), {
              type: 'module'
            }),
            initProgressCallback: report => {
              const percentage = Math.round(report.progress * 100);

              if (notificationId === null) {
                notificationId = Notification.emit(
                  report.text ?? `Downloading ${modelName}...`,
                  'in-progress',
                  {
                    progress: 0,
                    autoClose: false
                  }
                );
              } else if (percentage === 100) {
                if (notificationId) {
                  Notification.update({
                    id: notificationId,
                    message: `${modelName} ready`,
                    type: 'success',
                    progress: 1,
                    autoClose: 3000
                  });
                }
              } else {
                if (notificationId) {
                  Notification.update({
                    id: notificationId,
                    message: `Downloading ${modelName}... ${percentage}%`,
                    progress: report.progress
                  });
                }
              }
            }
          });

          return aisdk(model);
        }
      };
      chatProviderRegistry.registerProvider(webLLMInfo);
    }

    if (settingRegistry) {
      settingRegistry
        .load(plugin.id)
        .then(settings => {
          console.log(
            'jupyterlab-browser-ai settings loaded:',
            settings.composite
          );
        })
        .catch(reason => {
          console.error(
            'Failed to load settings for jupyterlab-browser-ai.',
            reason
          );
        });
    }
  }
};

export default plugin;
