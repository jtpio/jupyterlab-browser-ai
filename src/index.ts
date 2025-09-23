import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Notification } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { MarkdownCell } from '@jupyterlab/cells';
import { imageIcon } from '@jupyterlab/ui-components';

import { IChatProviderRegistry, IChatProviderInfo } from '@jupyterlite/ai';

import { builtInAI, doesBrowserSupportBuiltInAI } from '@built-in-ai/core';

import { webLLM, doesBrowserSupportWebLLM } from '@built-in-ai/web-llm';

import { aisdk } from '@openai/agents-extensions';

import { streamText } from 'ai';

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

namespace CommandIDs {
  export const generateAltText = 'chrome-ai:generate-alt-text';
}

class ChromeAIAltTextGenerator {
  async generateAltText(imageSrc: string): Promise<string> {
    try {
      const response = await fetch(imageSrc);
      const blob = await response.blob();

      // Convert blob to base64 efficiently for large images
      const arrayBuffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // Process in chunks to avoid call stack overflow with large images
      let binaryString = '';
      const chunkSize = 8192; // Process 8KB at a time
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.slice(i, i + chunkSize);
        binaryString += String.fromCharCode(...chunk);
      }
      const base64 = btoa(binaryString);

      const result = streamText({
        model: builtInAI(),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Generate a concise alt text description for this image. Focus on the most important visual elements and keep it under 125 characters. Do not include phrases like "an image of" or "a picture showing".'
              },
              {
                type: 'file',
                mediaType: blob.type || 'image/png',
                data: base64
              }
            ]
          }
        ]
      });

      let fullResponse = '';
      for await (const chunk of result.textStream) {
        fullResponse += chunk;
      }

      return fullResponse;
    } catch (error) {
      console.error('Failed to generate alt text:', error);
      throw error;
    }
  }
}

async function updateImageAltText(
  imageElement: HTMLImageElement,
  altText: string,
  notebookTracker: INotebookTracker
): Promise<boolean> {
  try {
    const currentWidget = notebookTracker.currentWidget;
    if (!currentWidget) {
      return false;
    }

    const notebook = currentWidget.content;
    let activeCell = notebook.activeCell;

    // Check if we have an active markdown cell
    if (!activeCell || activeCell.model.type !== 'markdown') {
      // Try to find the cell containing the image by looking at all cells
      let targetCell: MarkdownCell | null = null;
      let targetCellIndex = -1;

      for (let i = 0; i < notebook.widgets.length; i++) {
        const cell = notebook.widgets[i];
        if (cell.model.type === 'markdown') {
          const cellElement = cell.node;
          const images = cellElement.querySelectorAll('img');
          for (const img of images) {
            if ((img as HTMLImageElement).src === imageElement.src) {
              targetCell = cell as MarkdownCell;
              targetCellIndex = i;
              break;
            }
          }
        }
        if (targetCell) {
          break;
        }
      }

      if (!targetCell) {
        return false;
      }

      // Set the target cell as active
      notebook.activeCellIndex = targetCellIndex;
      activeCell = targetCell;
    }

    const cellModel = activeCell.model;
    const sharedModel = cellModel.sharedModel;

    const currentContent = sharedModel.getSource();

    // Find all markdown images: ![alt text](url)
    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let matchCount = 0;
    let foundMatch = false;

    const updatedContent = currentContent.replace(
      imageRegex,
      (match: string, altTextMatch: string, imageUrl: string) => {
        matchCount++;
        // Replace the first image that has empty alt text, or if there's only one image, replace it
        if (!foundMatch && (altTextMatch.trim() === '' || matchCount === 1)) {
          foundMatch = true;
          return `![${altText}](${imageUrl})`;
        }

        return match;
      }
    );

    // Only update if we actually made changes
    if (updatedContent !== currentContent) {
      sharedModel.setSource(updatedContent);
      return true;
    }

    return false;
  } catch (error) {
    console.error('Failed to update image alt text:', error);
    return false;
  }
}

/**
 * A plugin providing a context menu item to generate alt text for images using Chrome Built-in AI.
 */
const chromeAIImagePlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-browser-ai:alt-text-generator',
  description: 'Chrome AI Alt Text Generator Context Menu',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, notebookTracker: INotebookTracker) => {
    if (!doesBrowserSupportBuiltInAI()) {
      console.log('Chrome Built-in AI not supported in this browser');
      return;
    }

    const altTextGenerator = new ChromeAIAltTextGenerator();

    const isImage = (node: HTMLElement) => node.tagName === 'IMG';

    app.commands.addCommand(CommandIDs.generateAltText, {
      label: 'Generate Alt Text with ChromeAI',
      icon: imageIcon,
      execute: async () => {
        const node = app.contextMenuHitTest(isImage);
        if (!node) {
          return;
        }

        const imageSrc = (node as HTMLImageElement).src;

        const notificationId = Notification.emit(
          'Generating alt text with ChromeAI...',
          'in-progress',
          { autoClose: false }
        );

        try {
          const altText = await altTextGenerator.generateAltText(imageSrc);

          // Try to find and update the markdown cell containing this image
          const updatedCell = await updateImageAltText(
            node as HTMLImageElement,
            altText,
            notebookTracker
          );

          Notification.update({
            id: notificationId,
            message: updatedCell
              ? 'Alt text generated and applied to markdown cell'
              : 'Alt text generated - copied to clipboard',
            type: 'success',
            autoClose: 3000
          });

          // Copy alt text to clipboard as fallback
          if (navigator.clipboard) {
            await navigator.clipboard.writeText(altText);
          }
        } catch (error) {
          console.error('ChromeAI Alt Text Generation Error:', error);
          Notification.update({
            id: notificationId,
            message: `Failed to generate alt text: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`,
            type: 'error',
            autoClose: 5000
          });
        }
      },
      describedBy: {
        args: {
          type: 'object',
          properties: {}
        }
      }
    });

    const options = { selector: 'img', rank: 1 };
    app.contextMenu.addItem({
      command: CommandIDs.generateAltText,
      ...options
    });
  }
};

export default [plugin, chromeAIImagePlugin];
