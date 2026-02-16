import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Notification } from '@jupyterlab/apputils';

import {
  IProviderRegistry,
  IProviderInfo,
  IAISettingsModel
} from '@jupyterlite/ai';

import { browserAI, doesBrowserSupportBrowserAI } from '@browser-ai/core';

import { webLLM, doesBrowserSupportWebLLM } from '@browser-ai/web-llm';

import {
  transformersJS,
  doesBrowserSupportTransformersJS,
  type TransformersJSLanguageModel
} from '@browser-ai/transformers-js';

interface IAISettingsModelLike {
  providers: Array<{
    id: string;
    provider: string;
    model: string;
  }>;
  stateChanged: {
    connect: (
      slot: (sender: unknown, args: void) => void,
      thisArg?: unknown
    ) => void;
  };
}

const PLUGIN_ID = 'jupyterlab-browser-ai:plugin';
const TRANSFORMERS_CUSTOM_MODELS_SETTING = 'transformersJsModels';
const TRANSFORMERS_PROVIDER_DESCRIPTION =
  'Small on-device models for notebook and code workflows. Configure model IDs in the "transformersJsModels" setting.';
const MODEL_PRELOAD_NOTIFICATION_DELAY_MS = 1200;
const FACTORY_INIT_NOTIFICATION_DELAY_MS = 2000;

type TransformersModelSettings = NonNullable<
  Parameters<typeof transformersJS>[1]
>;

const TRANSFORMERS_MODEL_SETTINGS_BY_ID: Record<
  string,
  Partial<Pick<TransformersModelSettings, 'dtype' | 'device'>>
> = {
  // ONNX community model cards recommend q4 for Qwen2.5 coder/instruct.
  'onnx-community/Qwen2.5-Coder-0.5B-Instruct': { dtype: 'q4' },
  'onnx-community/Qwen2.5-0.5B-Instruct': { dtype: 'q4' },
  // Qwen3 ONNX cards recommend q4f16 for browser usage.
  'onnx-community/Qwen3-0.6B-ONNX': { dtype: 'q4f16' }
};

function normalizeTransformersModelName(modelName: unknown): string | null {
  if (typeof modelName !== 'string') {
    return null;
  }

  const normalizedModelName = modelName.trim();
  if (normalizedModelName === '') {
    return null;
  }

  return normalizedModelName;
}

function getConfiguredTransformersModelNames(
  settingsModel: IAISettingsModelLike
): string[] {
  const modelNames = new Set<string>();

  for (const provider of settingsModel.providers) {
    if (provider.provider !== 'transformers-js') {
      continue;
    }

    const modelName = normalizeTransformersModelName(provider.model);
    if (modelName) {
      modelNames.add(modelName);
    }
  }

  return [...modelNames];
}

function getUserConfiguredTransformersModelNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const modelNames = new Set<string>();

  for (const entry of value) {
    const modelName = normalizeTransformersModelName(entry);
    if (modelName) {
      modelNames.add(modelName);
    }
  }

  return [...modelNames];
}

const transformersModels = new Map<string, TransformersJSLanguageModel>();
const transformersModelInitialization = new Map<string, Promise<void>>();

function getOrCreateTransformersModel(
  modelName: string
): TransformersJSLanguageModel {
  let model = transformersModels.get(modelName);
  if (!model) {
    const modelSettings = TRANSFORMERS_MODEL_SETTINGS_BY_ID[modelName] ?? {};
    model = transformersJS(modelName, {
      ...modelSettings,
      worker: new Worker(
        new URL('./transformersjs-worker.js', import.meta.url),
        {
          type: 'module'
        }
      )
    });
    transformersModels.set(modelName, model);
  }
  return model;
}

function getTransformersProgressMessage(
  modelName: string,
  percentage: number
): string {
  if (percentage <= 0) {
    return `Preparing ${modelName}...`;
  }

  return `Loading ${modelName}... ${percentage}%`;
}

function getTransformersInitializationErrorMessage(
  modelName: string,
  error: unknown
): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const trimmedRawMessage = rawMessage.trim();

  // Some worker/runtime failures surface as numeric abort codes.
  if (/^\d+$/.test(trimmedRawMessage)) {
    return `Failed to prepare ${modelName}: worker runtime error (${trimmedRawMessage}). Try another model.`;
  }

  return `Failed to prepare ${modelName}: ${trimmedRawMessage || 'Unknown error'}`;
}

async function initializeTransformersModel(
  modelName: string,
  notificationDelayMs = MODEL_PRELOAD_NOTIFICATION_DELAY_MS
): Promise<void> {
  const existingInitialization = transformersModelInitialization.get(modelName);
  if (existingInitialization) {
    return existingInitialization;
  }

  const model = getOrCreateTransformersModel(modelName);

  const initializationPromise = (async () => {
    const availability = await model.availability();
    if (availability === 'available') {
      return;
    }
    if (availability === 'unavailable') {
      throw new Error(`Model "${modelName}" is unavailable`);
    }

    let notificationId: string | null = null;
    let latestProgress = 0;
    let notificationDelayTimeout: number | null = null;

    const ensureNotification = () => {
      if (notificationId !== null) {
        return;
      }

      const percentage = Math.round(latestProgress * 100);
      notificationId = Notification.emit(
        getTransformersProgressMessage(modelName, percentage),
        'in-progress',
        {
          progress: latestProgress,
          autoClose: false
        }
      );
    };

    notificationDelayTimeout = window.setTimeout(
      () => ensureNotification(),
      notificationDelayMs
    );

    try {
      await model.createSessionWithProgress(progress => {
        const clampedProgress = Math.max(0, Math.min(1, progress));
        latestProgress = clampedProgress;

        if (notificationId !== null) {
          const percentage = Math.round(clampedProgress * 100);
          Notification.update({
            id: notificationId,
            message: getTransformersProgressMessage(modelName, percentage),
            progress: clampedProgress
          });
        }
      });

      if (notificationDelayTimeout !== null) {
        clearTimeout(notificationDelayTimeout);
        notificationDelayTimeout = null;
      }

      if (notificationId !== null) {
        Notification.update({
          id: notificationId,
          message: `${modelName} ready`,
          type: 'success',
          progress: 1,
          autoClose: 3000
        });
      }
    } catch (error) {
      if (notificationDelayTimeout !== null) {
        clearTimeout(notificationDelayTimeout);
        notificationDelayTimeout = null;
      }

      const errorMessage = getTransformersInitializationErrorMessage(
        modelName,
        error
      );

      if (notificationId !== null) {
        Notification.update({
          id: notificationId,
          message: errorMessage,
          type: 'error',
          autoClose: 5000
        });
      } else {
        Notification.emit(errorMessage, 'error', { autoClose: 5000 });
      }

      throw error;
    }
  })();

  transformersModelInitialization.set(modelName, initializationPromise);

  initializationPromise.finally(() => {
    transformersModelInitialization.delete(modelName);
  });

  return initializationPromise;
}

function preloadConfiguredTransformersModels(
  settingsModel: IAISettingsModelLike
): void {
  const modelNames = getConfiguredTransformersModelNames(settingsModel);

  for (const modelName of modelNames) {
    void initializeTransformersModel(modelName).catch(error => {
      console.error(
        `Failed to initialize Transformers.js model "${modelName}"`,
        error
      );
    });
  }
}

/**
 * Initialization data for the jupyterlab-browser-ai extension.
 */
export const providerRegistryPlugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'In-browser AI in JupyterLab and Jupyter Notebook',
  autoStart: true,
  requires: [IProviderRegistry],
  optional: [ISettingRegistry, IAISettingsModel],
  activate: (
    app: JupyterFrontEnd,
    providerRegistry: IProviderRegistry,
    settingRegistry: ISettingRegistry | null,
    settingsModel: IAISettingsModelLike | null
  ) => {
    let configuredTransformersModels: string[] = [];
    let refreshTransformersDefaultModels: (() => void) | null = null;

    if (doesBrowserSupportBrowserAI()) {
      const chromeAIInfo: IProviderInfo = {
        id: 'chrome-ai',
        name: 'Chrome Built-in AI',
        apiKeyRequirement: 'none',
        defaultModels: ['chrome-ai'],
        supportsBaseURL: false,
        supportsHeaders: false,
        supportsToolCalling: true,
        factory: () => {
          return browserAI('text');
        }
      };

      providerRegistry.registerProvider(chromeAIInfo);
    }

    if (doesBrowserSupportWebLLM()) {
      const webLLMInfo: IProviderInfo = {
        id: 'web-llm',
        name: 'WebLLM',
        apiKeyRequirement: 'none',
        defaultModels: [
          'Llama-3.2-3B-Instruct-q4f16_1-MLC',
          'Llama-3.2-1B-Instruct-q4f16_1-MLC',
          'Phi-3.5-mini-instruct-q4f16_1-MLC',
          'gemma-2-2b-it-q4f16_1-MLC',
          'Qwen3-0.6B-q4f16_1-MLC'
        ],
        supportsBaseURL: false,
        supportsHeaders: false,
        supportsToolCalling: true,
        factory: (options: { model?: string }) => {
          const modelName = options.model ?? 'Qwen3-0.6B-q4f16_1-MLC';

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

          return model;
        }
      };
      providerRegistry.registerProvider(webLLMInfo);
    }

    if (doesBrowserSupportTransformersJS()) {
      const registerTransformersProvider = () => {
        const transformersInfo: IProviderInfo = {
          id: 'transformers-js',
          name: 'Transformers.js',
          apiKeyRequirement: 'none',
          defaultModels: [...configuredTransformersModels],
          description: TRANSFORMERS_PROVIDER_DESCRIPTION,
          supportsBaseURL: false,
          supportsHeaders: false,
          supportsToolCalling: true,
          factory: (options: { model?: string }) => {
            const modelName = options.model ?? configuredTransformersModels[0];
            if (!modelName) {
              throw new Error(
                'No Transformers.js model configured. Set "transformersJsModels" in jupyterlab-browser-ai settings.'
              );
            }
            const model = getOrCreateTransformersModel(modelName);

            // Pre-initialize when a model instance is created (e.g. restored chats)
            // so first user message is less likely to block on model load.
            void initializeTransformersModel(
              modelName,
              FACTORY_INIT_NOTIFICATION_DELAY_MS
            ).catch(error => {
              console.error(
                `Failed to initialize Transformers.js model "${modelName}"`,
                error
              );
            });

            return model;
          }
        };
        providerRegistry.registerProvider(transformersInfo);

        refreshTransformersDefaultModels = () => {
          const providerInfo =
            providerRegistry.getProviderInfo('transformers-js');
          if (!providerInfo) {
            return;
          }

          providerInfo.defaultModels.splice(
            0,
            providerInfo.defaultModels.length,
            ...configuredTransformersModels
          );
        };

        refreshTransformersDefaultModels();
      };

      if (settingRegistry) {
        void settingRegistry
          .load(PLUGIN_ID)
          .then(settings => {
            const updateConfiguredTransformersModels = () => {
              const composite = settings.composite as Record<string, unknown>;
              configuredTransformersModels =
                getUserConfiguredTransformersModelNames(
                  composite[TRANSFORMERS_CUSTOM_MODELS_SETTING]
                );
              refreshTransformersDefaultModels?.();
            };

            updateConfiguredTransformersModels();
            registerTransformersProvider();
            settings.changed.connect(() => {
              updateConfiguredTransformersModels();
            });
          })
          .catch(reason => {
            console.error(
              'Failed to load settings for jupyterlab-browser-ai.',
              reason
            );
            registerTransformersProvider();
          });
      } else {
        registerTransformersProvider();
      }

      if (settingsModel) {
        let appLayoutRestored = false;

        void app.restored.then(() => {
          appLayoutRestored = true;
        });

        settingsModel.stateChanged.connect(() => {
          // Ignore initial settings hydration on startup. Only preload when
          // users update provider configuration in the UI.
          if (!appLayoutRestored) {
            return;
          }
          preloadConfiguredTransformersModels(settingsModel);
        });
      }
    }
  }
};
