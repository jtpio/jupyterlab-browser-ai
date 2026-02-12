import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { Notification } from '@jupyterlab/apputils';
import { MarkdownCell } from '@jupyterlab/cells';
import { INotebookTracker } from '@jupyterlab/notebook';
import { imageIcon } from '@jupyterlab/ui-components';

import { browserAI, doesBrowserSupportBrowserAI } from '@browser-ai/core';

import { streamText } from 'ai';

import { blobToBase64, CommandIDs } from './chrome-ai-shared';

class ChromeAIAltTextGenerator {
  async generateAltText(imageSrc: string): Promise<string> {
    try {
      const response = await fetch(imageSrc);
      const blob = await response.blob();
      const base64 = await blobToBase64(blob);

      const result = streamText({
        model: browserAI(),
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

    // Check if we have an active markdown cell.
    if (!activeCell || activeCell.model.type !== 'markdown') {
      // Try to find the cell containing the image by looking at all cells.
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

      // Set the target cell as active.
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
        // Replace the first image that has empty alt text, or if there's only one image, replace it.
        if (!foundMatch && (altTextMatch.trim() === '' || matchCount === 1)) {
          foundMatch = true;
          return `![${altText}](${imageUrl})`;
        }

        return match;
      }
    );

    // Only update if we actually made changes.
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
export const chromeAIImagePlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-browser-ai:alt-text-generator',
  description: 'Chrome AI Alt Text Generator Context Menu',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, notebookTracker: INotebookTracker) => {
    if (!doesBrowserSupportBrowserAI()) {
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

          // Try to find and update the markdown cell containing this image.
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

          // Copy alt text to clipboard as fallback.
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
