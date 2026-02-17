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

import {
  webLLM,
  doesBrowserSupportWebLLM,
  type WebLLMLanguageModel
} from '@browser-ai/web-llm';

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
const WEBLLM_CUSTOM_MODELS_SETTING = 'webLLMModels';
const TRANSFORMERS_CUSTOM_MODELS_SETTING = 'transformersJsModels';
const WEBLLM_PROVIDER_DESCRIPTION =
  'On-device browser models accelerated with WebGPU. Configure model IDs in the "webLLMModels" setting.';
const TRANSFORMERS_PROVIDER_DESCRIPTION =
  'Small on-device models accelerated with WebGPU when available. Configure model IDs in the "transformersJsModels" setting.';
const TRANSFORMERS_NO_WEBGPU_WARNING_MESSAGE =
  'WebGPU is not available. Transformers.js will run on CPU and may be slower.';
const MODEL_PRELOAD_NOTIFICATION_DELAY_MS = 1200;
const FACTORY_INIT_NOTIFICATION_DELAY_MS = 2000;

const webLLMModels = new Map<string, WebLLMLanguageModel>();
const webLLMModelInitialization = new Map<string, Promise<void>>();
const modelExecutionQueue = new WeakMap<object, Promise<void>>();

type SerializableInferenceModel = {
  doGenerate: (...args: any[]) => Promise<any>;
  doStream: (...args: any[]) => Promise<{ stream: ReadableStream<any> }>;
};

async function acquireModelExecutionSlot(model: object): Promise<() => void> {
  const previous = modelExecutionQueue.get(model) ?? Promise.resolve();

  let releaseCurrentSlot: (() => void) | null = null;
  const current = new Promise<void>(resolve => {
    releaseCurrentSlot = resolve;
  });

  const queueTail = previous.catch(() => undefined).then(() => current);
  modelExecutionQueue.set(model, queueTail);

  await previous.catch(() => undefined);

  let released = false;
  return () => {
    if (released) {
      return;
    }

    released = true;
    releaseCurrentSlot?.();

    if (modelExecutionQueue.get(model) === queueTail) {
      modelExecutionQueue.delete(model);
    }
  };
}

function wrapSerializedStream<T>(
  source: ReadableStream<T>,
  releaseExecutionSlot: () => void
): ReadableStream<T> {
  const reader = source.getReader();
  let released = false;

  const release = () => {
    if (released) {
      return;
    }

    released = true;
    releaseExecutionSlot();
  };

  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    }
  });
}

function createSerializedInferenceProxy<
  TModel extends SerializableInferenceModel & object
>(model: TModel): TModel {
  const originalDoGenerate = model.doGenerate.bind(model);
  const originalDoStream = model.doStream.bind(model);

  const serializedDoGenerate = async (
    ...args: Parameters<TModel['doGenerate']>
  ) => {
    const releaseExecutionSlot = await acquireModelExecutionSlot(model);
    try {
      return await originalDoGenerate(...args);
    } finally {
      releaseExecutionSlot();
    }
  };

  const serializedDoStream = async (
    ...args: Parameters<TModel['doStream']>
  ) => {
    const releaseExecutionSlot = await acquireModelExecutionSlot(model);

    try {
      const streamResult = await originalDoStream(...args);
      return {
        ...streamResult,
        stream: wrapSerializedStream(streamResult.stream, releaseExecutionSlot)
      } as Awaited<ReturnType<TModel['doStream']>>;
    } catch (error) {
      releaseExecutionSlot();
      throw error;
    }
  };

  return new Proxy(model, {
    get(target, property) {
      if (property === 'doGenerate') {
        return serializedDoGenerate;
      }

      if (property === 'doStream') {
        return serializedDoStream;
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    }
  });
}

function getOrCreateWebLLMModel(modelName: string): WebLLMLanguageModel {
  let model = webLLMModels.get(modelName);
  if (!model) {
    let notificationId: string | null = null;

    model = webLLM(modelName, {
      worker: new Worker(new URL('./webllm-worker.js', import.meta.url), {
        type: 'module'
      }),
      initProgressCallback: report => {
        const clampedProgress = Math.max(0, Math.min(1, report.progress));
        const percentage = Math.round(clampedProgress * 100);
        const progressMessage =
          report.text ?? getWebLLMProgressMessage(modelName, percentage);

        if (notificationId === null) {
          notificationId = Notification.emit(progressMessage, 'in-progress', {
            progress: clampedProgress,
            autoClose: false
          });
        } else if (percentage === 100) {
          Notification.update({
            id: notificationId,
            message: `${modelName} ready`,
            type: 'success',
            progress: 1,
            autoClose: 3000
          });
        } else {
          Notification.update({
            id: notificationId,
            message: progressMessage,
            progress: clampedProgress
          });
        }
      }
    });

    model = createSerializedInferenceProxy(model);
    webLLMModels.set(modelName, model);
  }

  return model;
}

function getWebLLMProgressMessage(
  modelName: string,
  percentage: number
): string {
  if (percentage <= 0) {
    return `Preparing ${modelName}...`;
  }

  return `Downloading ${modelName}... ${percentage}%`;
}

function getWebLLMInitializationErrorMessage(
  modelName: string,
  error: unknown
): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const trimmedRawMessage = rawMessage.trim();

  if (/^\d+$/.test(trimmedRawMessage)) {
    return `Failed to prepare ${modelName}: worker runtime error (${trimmedRawMessage}). Try another model.`;
  }

  return `Failed to prepare ${modelName}: ${trimmedRawMessage || 'Unknown error'}`;
}

async function initializeWebLLMModel(modelName: string): Promise<void> {
  const existingInitialization = webLLMModelInitialization.get(modelName);
  if (existingInitialization) {
    return existingInitialization;
  }

  const model = getOrCreateWebLLMModel(modelName);

  const initializationPromise = (async () => {
    const availability = await model.availability();
    if (availability === 'available') {
      return;
    }
    if (availability === 'unavailable') {
      throw new Error(`Model "${modelName}" is unavailable`);
    }

    try {
      await model.createSessionWithProgress();
    } catch (error) {
      const errorMessage = getWebLLMInitializationErrorMessage(
        modelName,
        error
      );
      Notification.emit(errorMessage, 'error', { autoClose: 5000 });
      throw error;
    }
  })();

  webLLMModelInitialization.set(modelName, initializationPromise);

  initializationPromise.finally(() => {
    webLLMModelInitialization.delete(modelName);
  });

  return initializationPromise;
}

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

let hasShownTransformersNoWebGPUWarning = false;

function maybeWarnOnTransformersWithoutWebGPU(): void {
  if (hasShownTransformersNoWebGPUWarning || doesBrowserSupportWebLLM()) {
    return;
  }

  hasShownTransformersNoWebGPUWarning = true;
  Notification.emit(TRANSFORMERS_NO_WEBGPU_WARNING_MESSAGE, 'warning', {
    autoClose: 5000
  });
}

function normalizeModelName(modelName: unknown): string | null {
  if (typeof modelName !== 'string') {
    return null;
  }

  const normalizedModelName = modelName.trim();
  if (normalizedModelName === '') {
    return null;
  }

  return normalizedModelName;
}

function getConfiguredProviderModelNames(
  settingsModel: IAISettingsModelLike,
  providerId: string
): string[] {
  const modelNames = new Set<string>();

  for (const provider of settingsModel.providers) {
    if (provider.provider !== providerId) {
      continue;
    }

    const modelName = normalizeModelName(provider.model);
    if (modelName) {
      modelNames.add(modelName);
    }
  }

  return [...modelNames];
}

function getConfiguredTransformersModelNames(
  settingsModel: IAISettingsModelLike
): string[] {
  return getConfiguredProviderModelNames(settingsModel, 'transformers-js');
}

function getConfiguredWebLLMModelNames(
  settingsModel: IAISettingsModelLike
): string[] {
  return getConfiguredProviderModelNames(settingsModel, 'web-llm');
}

function getUserConfiguredModelNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const modelNames = new Set<string>();

  for (const entry of value) {
    const modelName = normalizeModelName(entry);
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
    maybeWarnOnTransformersWithoutWebGPU();

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
    model = createSerializedInferenceProxy(model);
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

function preloadConfiguredWebLLMModels(
  settingsModel: IAISettingsModelLike
): void {
  const modelNames = getConfiguredWebLLMModelNames(settingsModel);

  for (const modelName of modelNames) {
    void initializeWebLLMModel(modelName).catch(error => {
      console.error(`Failed to initialize WebLLM model "${modelName}"`, error);
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
    let configuredWebLLMModels: string[] = [];
    let refreshWebLLMDefaultModels: (() => void) | null = null;
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
      const registerWebLLMProvider = () => {
        const webLLMInfo: IProviderInfo = {
          id: 'web-llm',
          name: 'WebLLM',
          apiKeyRequirement: 'none',
          defaultModels: [...configuredWebLLMModels],
          description: WEBLLM_PROVIDER_DESCRIPTION,
          supportsBaseURL: false,
          supportsHeaders: false,
          supportsToolCalling: true,
          factory: (options: { model?: string }) => {
            const modelName = options.model ?? configuredWebLLMModels[0];
            if (!modelName) {
              throw new Error(
                'No WebLLM model configured. Set "webLLMModels" in jupyterlab-browser-ai settings.'
              );
            }

            const model = getOrCreateWebLLMModel(modelName);

            // Pre-initialize when a model instance is created (e.g. restored chats)
            // so first user message is less likely to block on model load.
            void initializeWebLLMModel(modelName).catch(error => {
              console.error(
                `Failed to initialize WebLLM model "${modelName}"`,
                error
              );
            });

            return model;
          }
        };
        providerRegistry.registerProvider(webLLMInfo);

        refreshWebLLMDefaultModels = () => {
          const providerInfo = providerRegistry.getProviderInfo('web-llm');
          if (!providerInfo) {
            return;
          }

          providerInfo.defaultModels.splice(
            0,
            providerInfo.defaultModels.length,
            ...configuredWebLLMModels
          );
        };

        refreshWebLLMDefaultModels();
      };

      if (settingRegistry) {
        void settingRegistry
          .load(PLUGIN_ID)
          .then(settings => {
            const updateConfiguredWebLLMModels = () => {
              const composite = settings.composite as Record<string, unknown>;
              configuredWebLLMModels = getUserConfiguredModelNames(
                composite[WEBLLM_CUSTOM_MODELS_SETTING]
              );
              refreshWebLLMDefaultModels?.();
            };

            updateConfiguredWebLLMModels();
            registerWebLLMProvider();
            settings.changed.connect(() => {
              updateConfiguredWebLLMModels();
            });
          })
          .catch(reason => {
            console.error(
              'Failed to load WebLLM settings for jupyterlab-browser-ai.',
              reason
            );
            registerWebLLMProvider();
          });
      } else {
        registerWebLLMProvider();
      }
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
              configuredTransformersModels = getUserConfiguredModelNames(
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
    }

    if (settingsModel) {
      let appLayoutRestored = false;

      void app.restored.then(() => {
        appLayoutRestored = true;

        // Preload models already configured in providers on startup so
        // initialization/download notifications show before first chat message.
        if (doesBrowserSupportWebLLM()) {
          preloadConfiguredWebLLMModels(settingsModel);
        }

        if (doesBrowserSupportTransformersJS()) {
          preloadConfiguredTransformersModels(settingsModel);
        }
      });

      settingsModel.stateChanged.connect(() => {
        // Ignore initial settings hydration on startup. Only preload when
        // users update provider configuration in the UI.
        if (!appLayoutRestored) {
          return;
        }

        if (doesBrowserSupportWebLLM()) {
          preloadConfiguredWebLLMModels(settingsModel);
        }

        if (doesBrowserSupportTransformersJS()) {
          preloadConfiguredTransformersModels(settingsModel);
        }
      });
    }
  }
};
