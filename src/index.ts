import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { IChatProviderRegistry, IChatProviderInfo } from '@jupyterlite/ai';

import { builtInAI } from '@built-in-ai/core';

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
