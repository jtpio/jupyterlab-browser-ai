import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Notification, ICommandPalette } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { MarkdownCell } from '@jupyterlab/cells';
import { imageIcon, textEditorIcon } from '@jupyterlab/ui-components';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';

import { IProviderRegistry, IProviderInfo } from '@jupyterlite/ai';

import { builtInAI, doesBrowserSupportBuiltInAI } from '@built-in-ai/core';

import { webLLM, doesBrowserSupportWebLLM } from '@built-in-ai/web-llm';

import { streamText } from 'ai';

/**
 * Utility function to efficiently convert a blob to base64 string
 * Processes in chunks to avoid call stack overflow with large files
 */
async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  // Process in chunks to avoid call stack overflow with large files
  let binaryString = '';
  const chunkSize = 8192; // Process 8KB at a time
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const chunk = uint8Array.slice(i, i + chunkSize);
    binaryString += String.fromCharCode(...chunk);
  }
  return btoa(binaryString);
}

/**
 * Initialization data for the jupyterlab-browser-ai extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-browser-ai:plugin',
  description: 'In-browser AI in JupyterLab and Jupyter Notebook',
  autoStart: true,
  requires: [IProviderRegistry],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    providerRegistry: IProviderRegistry,
    settingRegistry: ISettingRegistry | null
  ) => {
    if (doesBrowserSupportBuiltInAI()) {
      const chromeAIInfo: IProviderInfo = {
        id: 'chrome-ai',
        name: 'Chrome Built-in AI',
        apiKeyRequirement: 'none',
        defaultModels: ['chrome-ai'],
        supportsBaseURL: false,
        supportsHeaders: false,
        supportsToolCalling: true,
        factory: () => {
          return builtInAI('text');
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
          const modelName =
            options.model ?? 'Qwen3-0.6B-q4f16_1-MLC';

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
  export const generateTranscript = 'chrome-ai:generate-transcript';
  export const proofreadNotebook = 'chrome-ai:proofread-notebook';
}

/**
 * Check if the Proofreader API is available
 */
function doesBrowserSupportProofreader(): boolean {
  return typeof window !== 'undefined' && 'Proofreader' in window;
}

/**
 * Check if the Summarizer API is available
 */
function doesBrowserSupportSummarizer(): boolean {
  return typeof window !== 'undefined' && 'Summarizer' in window;
}

class ChromeAIAltTextGenerator {
  async generateAltText(imageSrc: string): Promise<string> {
    try {
      const response = await fetch(imageSrc);
      const blob = await response.blob();
      const base64 = await blobToBase64(blob);

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

class ChromeAITranscriptGenerator {
  async generateTranscript(audioSrc: string): Promise<string> {
    try {
      const response = await fetch(audioSrc);
      const blob = await response.blob();
      const base64 = await blobToBase64(blob);

      const result = streamText({
        model: builtInAI(),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Please transcribe this audio file. Provide only the transcribed text without any additional commentary or formatting.'
              },
              {
                type: 'file',
                mediaType: blob.type || 'audio/mp3',
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

      return fullResponse.trim();
    } catch (error) {
      console.error('Failed to generate transcript:', error);
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

/**
 * Helper function to check if a file is an audio file based on its extension
 */
function isAudioFile(fileName: string): boolean {
  const audioExtensions = [
    '.mp3',
    '.wav',
    '.ogg',
    '.m4a',
    '.aac',
    '.flac',
    '.opus'
  ];

  return audioExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
}

/**
 * Helper function to check if exactly one audio file is selected in the file browser
 */
function isSingleAudioFileSelected(
  fileBrowserFactory: IFileBrowserFactory
): boolean {
  const fileBrowser = fileBrowserFactory.tracker.currentWidget;
  if (!fileBrowser) {
    return false;
  }

  const selectedItems = Array.from(fileBrowser.selectedItems());
  if (selectedItems.length !== 1) {
    return false;
  }

  const selectedItem = selectedItems[0];
  return isAudioFile(selectedItem.name);
}

/**
 * A plugin providing a context menu item to generate transcripts for audio files using Chrome Built-in AI.
 */
const chromeAIAudioPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-browser-ai:audio-transcript-generator',
  description: 'Chrome AI Audio Transcript Generator',
  autoStart: true,
  requires: [IFileBrowserFactory],
  activate: (app: JupyterFrontEnd, fileBrowserFactory: IFileBrowserFactory) => {
    if (!doesBrowserSupportBuiltInAI()) {
      console.log('Chrome Built-in AI not supported in this browser');
      return;
    }

    const transcriptGenerator = new ChromeAITranscriptGenerator();

    const { serviceManager } = app;

    app.commands.addCommand(CommandIDs.generateTranscript, {
      label: 'Generate Transcript with ChromeAI',
      icon: textEditorIcon,
      isVisible: () => {
        return isSingleAudioFileSelected(fileBrowserFactory);
      },
      execute: async () => {
        const fileBrowser = fileBrowserFactory.tracker.currentWidget;
        if (!fileBrowser) {
          Notification.emit('No file browser available', 'warning');
          return;
        }

        const selectedItems = Array.from(fileBrowser.selectedItems());
        if (selectedItems.length !== 1) {
          Notification.emit('Please select a single audio file', 'warning');
          return;
        }

        const selectedItem = selectedItems[0];

        if (!isAudioFile(selectedItem.name)) {
          Notification.emit('Selected file is not an audio file', 'warning');
          return;
        }

        const audioPath = selectedItem.path;
        const audioUrl =
          await serviceManager.contents.getDownloadUrl(audioPath);

        const notificationId = Notification.emit(
          'Generating transcript with ChromeAI...',
          'in-progress',
          { autoClose: false }
        );

        try {
          const transcript =
            await transcriptGenerator.generateTranscript(audioUrl);

          // Create transcript filename
          const baseName = selectedItem.name.replace(/\.[^/.]+$/, '');
          const transcriptFileName = `${baseName}_transcript.txt`;
          const transcriptPath = audioPath.replace(
            selectedItem.name,
            transcriptFileName
          );

          // Save transcript to file
          await serviceManager.contents.save(transcriptPath, {
            type: 'file',
            format: 'text',
            content: transcript
          });

          Notification.update({
            id: notificationId,
            message: `Transcript saved as ${transcriptFileName}`,
            type: 'success',
            autoClose: 3000,
            actions: [
              {
                label: 'Open',
                callback: async () => {
                  await app.commands.execute('docmanager:open', {
                    path: transcriptPath
                  });
                }
              }
            ]
          });

          // Refresh the file browser to show the new file
          await fileBrowser.model.refresh();
        } catch (error) {
          console.error('ChromeAI Transcript Generation Error:', error);
          Notification.update({
            id: notificationId,
            message: `Failed to generate transcript: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`,
            type: 'error',
            autoClose: 5000
          });
        }
      }
    });

    // Add context menu item for audio files in file browser
    app.contextMenu.addItem({
      command: CommandIDs.generateTranscript,
      selector: '.jp-DirListing-item[data-file-type]',
      rank: 2
    });
  }
};

class ChromeAISummarizer {
  async summarizeNotebook(
    notebookPath: string,
    app: JupyterFrontEnd
  ): Promise<string> {
    const content = await app.serviceManager.contents.get(notebookPath, {
      content: true
    });

    if (content.type !== 'notebook') {
      throw new Error('Not a notebook file');
    }

    const notebookContent = content.content;
    const cells = notebookContent.cells || [];

    const cellTexts: string[] = [];

    for (const cell of cells) {
      const source =
        typeof cell.source === 'string'
          ? cell.source
          : (cell.source || []).join('');

      if (cell.cell_type === 'markdown' && source.trim()) {
        cellTexts.push(`[Markdown]\n${source}`);
      } else if (cell.cell_type === 'code' && source.trim()) {
        cellTexts.push(`[Code]\n${source}`);
        if (cell.outputs && cell.outputs.length > 0) {
          const outputTexts = cell.outputs
            .filter((out: any) => out.text || out.data?.['text/plain'])
            .map((out: any) => out.text || out.data?.['text/plain'])
            .join('\n');
          if (outputTexts) {
            cellTexts.push(`[Output]\n${outputTexts}`);
          }
        }
      }
    }

    const combinedText = cellTexts.join('\n\n');

    if (!combinedText.trim()) {
      return 'No summary available: notebook is empty';
    }

    if (!('Summarizer' in window)) {
      throw new Error('Summarizer API not available');
    }

    const availability = await Summarizer.availability();

    if (availability === 'unavailable') {
      throw new Error('Summarizer API is not available');
    }

    const summarizer = await Summarizer.create({
      type: 'tldr',
      format: 'plain-text',
      length: 'medium',
      sharedContext: 'en'
    });

    const summary = await summarizer.summarize(combinedText);

    summarizer.destroy();

    return summary;
  }

  async summarizeTextFile(
    filePath: string,
    app: JupyterFrontEnd
  ): Promise<string> {
    const content = await app.serviceManager.contents.get(filePath, {
      content: true
    });

    if (content.type !== 'file') {
      throw new Error('Not a file');
    }

    const text = content.content as string;

    if (!text.trim()) {
      return 'Empty file';
    }

    if (!('Summarizer' in window)) {
      throw new Error('Summarizer API not available');
    }

    const availability = await Summarizer.availability();

    if (availability === 'unavailable') {
      throw new Error('Summarizer API is not available');
    }

    const summarizer = await Summarizer.create({
      type: 'tldr',
      format: 'plain-text',
      length: 'short',
      sharedContext: 'en'
    });

    const summary = await summarizer.summarize(text);

    summarizer.destroy();

    return summary;
  }
}

/**
 * A plugin providing a toolbar button to proofread all markdown cells in a notebook.
 */
const chromeAIProofreaderPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-browser-ai:notebook-proofreader',
  description: 'Chrome AI Notebook Proofreader',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ICommandPalette],
  activate: (
    app: JupyterFrontEnd,
    notebookTracker: INotebookTracker,
    palette: ICommandPalette | null
  ) => {
    if (!doesBrowserSupportProofreader()) {
      console.log('Chrome Proofreader API not supported in this browser');
      return;
    }

    app.commands.addCommand(CommandIDs.proofreadNotebook, {
      label: 'Proofread Notebook',
      caption: 'Proofread all markdown cells in the notebook',
      icon: textEditorIcon,
      execute: async () => {
        const currentWidget = notebookTracker.currentWidget;
        if (!currentWidget) {
          Notification.emit('No notebook open', 'warning');
          return;
        }

        const notebook = currentWidget.content;
        const markdownCells: MarkdownCell[] = [];

        // Collect all markdown cells
        for (let i = 0; i < notebook.widgets.length; i++) {
          const cell = notebook.widgets[i];
          if (cell.model.type === 'markdown') {
            markdownCells.push(cell as MarkdownCell);
          }
        }

        if (markdownCells.length === 0) {
          Notification.emit('No markdown cells found', 'info');
          return;
        }

        const notificationId = Notification.emit(
          'Proofreading notebook...',
          'in-progress',
          { autoClose: false }
        );

        try {
          // Create proofreader instance
          const proofreader = await Proofreader.create({
            expectedInputLanguages: ['en']
          });

          let totalCorrections = 0;
          let cellsWithCorrections = 0;

          // Process each markdown cell
          for (const cell of markdownCells) {
            const cellModel = cell.model;
            const sharedModel = cellModel.sharedModel;
            const currentContent = sharedModel.getSource();

            if (currentContent.trim() === '') {
              continue;
            }

            // Proofread the cell content
            const result = await proofreader.proofread(currentContent);

            // If corrections were made, update the cell
            if (
              result.corrections.length > 0 &&
              result.correctedInput !== currentContent
            ) {
              sharedModel.setSource(result.correctedInput);
              totalCorrections += result.corrections.length;
              cellsWithCorrections++;
            }
          }

          // Clean up
          proofreader.destroy();

          if (totalCorrections === 0) {
            Notification.update({
              id: notificationId,
              message: 'No corrections needed',
              type: 'success',
              autoClose: 3000
            });
          } else {
            Notification.update({
              id: notificationId,
              message: `✓ Made ${totalCorrections} correction${totalCorrections > 1 ? 's' : ''} across ${cellsWithCorrections} cell${cellsWithCorrections > 1 ? 's' : ''}`,
              type: 'success',
              autoClose: 5000
            });
          }
        } catch (error) {
          console.error('Proofreading Error:', error);
          Notification.update({
            id: notificationId,
            message: `Failed to proofread: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`,
            type: 'error',
            autoClose: 5000
          });
        }
      }
    });

    // Add command to palette
    if (palette) {
      palette.addItem({
        command: CommandIDs.proofreadNotebook,
        category: 'Notebook Operations'
      });
    }
  }
};

/**
 * A plugin that adds clickable AI summary badges to files in the file browser
 */
const chromeAISummarizerPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-browser-ai:file-summarizer',
  description: 'Chrome AI File Summarizer with Inline Badges',
  autoStart: true,
  requires: [IFileBrowserFactory],
  activate: (app: JupyterFrontEnd, fileBrowserFactory: IFileBrowserFactory) => {
    if (!doesBrowserSupportSummarizer()) {
      console.log('Chrome Summarizer API not supported in this browser');
      return;
    }

    const summarizer = new ChromeAISummarizer();
    const summaryCache = new Map<string, string>();
    const badgeMap = new WeakMap<Element, HTMLSpanElement>();
    let tooltipElement: HTMLDivElement | null = null;
    let currentHoverPath: string | null = null;
    let hoverTimeout: number | null = null;

    app.serviceManager.contents.fileChanged.connect((sender, change) => {
      if (change.type === 'save' && change.newValue) {
        const changedPath = change.newValue.path;
        if (changedPath && summaryCache.has(changedPath)) {
          console.log(`Invalidating cache for modified file: ${changedPath}`);
          summaryCache.delete(changedPath);
        }
      }
    });

    const createTooltip = () => {
      if (!tooltipElement) {
        tooltipElement = document.createElement('div');
        tooltipElement.className = 'jp-ai-summary-tooltip';
        tooltipElement.style.position = 'fixed';
        tooltipElement.style.backgroundColor = 'var(--jp-layout-color1)';
        tooltipElement.style.border = '1px solid var(--jp-border-color1)';
        tooltipElement.style.borderRadius = '4px';
        tooltipElement.style.padding = '8px 12px';
        tooltipElement.style.maxWidth = '400px';
        tooltipElement.style.fontSize = '12px';
        tooltipElement.style.lineHeight = '1.4';
        tooltipElement.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.15)';
        tooltipElement.style.zIndex = '10000';
        tooltipElement.style.pointerEvents = 'auto';
        tooltipElement.style.display = 'none';
        tooltipElement.style.color = 'var(--jp-ui-font-color1)';
        tooltipElement.style.cursor = 'default';
        document.body.appendChild(tooltipElement);

        document.addEventListener('click', (e: MouseEvent) => {
          if (tooltipElement && tooltipElement.style.display !== 'none') {
            const target = e.target as HTMLElement;
            if (
              !tooltipElement.contains(target) &&
              !target.classList.contains('jp-ai-summary-badge')
            ) {
              hideTooltip();
            }
          }
        });
      }
      return tooltipElement;
    };

    const showTooltip = (text: string, x: number, y: number) => {
      const tooltip = createTooltip();
      tooltip.textContent = text;
      tooltip.style.display = 'block';
      tooltip.style.left = `${x + 10}px`;
      tooltip.style.top = `${y + 10}px`;
    };

    const hideTooltip = () => {
      if (tooltipElement) {
        tooltipElement.style.display = 'none';
      }
      currentHoverPath = null;
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
      }
    };

    const shouldSummarize = (
      fileName: string,
      isDirectory: boolean
    ): boolean => {
      if (isDirectory) {
        return false;
      }
      return (
        fileName.endsWith('.ipynb') ||
        fileName.endsWith('.md') ||
        fileName.endsWith('.txt') ||
        fileName.endsWith('.py') ||
        fileName.endsWith('.js') ||
        fileName.endsWith('.ts')
      );
    };

    const createBadge = (
      fileItem: Element,
      fileName: string,
      filePath: string,
      isDirectory: boolean
    ): HTMLSpanElement => {
      const badge = document.createElement('span');
      badge.className = 'jp-ai-summary-badge';
      badge.textContent = '✨';
      badge.title = 'Click to view AI summary';
      badge.style.cursor = 'pointer';
      badge.style.marginLeft = '6px';
      badge.style.opacity = '0.7';
      badge.style.fontSize = '14px';
      badge.style.transition = 'opacity 0.2s';

      badge.addEventListener('mouseenter', () => {
        badge.style.opacity = '1';
      });

      badge.addEventListener('mouseleave', () => {
        badge.style.opacity = '0.7';
      });

      badge.addEventListener('click', async (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();

        currentHoverPath = filePath;

        const badgeRect = badge.getBoundingClientRect();
        const anchorX = badgeRect.right;
        const anchorY = badgeRect.bottom;

        showTooltip('Loading summary...', anchorX, anchorY);

        try {
          let summary: string;

          if (summaryCache.has(filePath)) {
            summary = summaryCache.get(filePath)!;
            showTooltip(summary, anchorX, anchorY);
          } else {
            if (fileName.endsWith('.ipynb')) {
              summary = await summarizer.summarizeNotebook(filePath, app);
            } else {
              summary = await summarizer.summarizeTextFile(filePath, app);
            }

            summaryCache.set(filePath, summary);

            if (currentHoverPath === filePath) {
              showTooltip(summary, anchorX, anchorY);
            }
          }
        } catch (error) {
          console.error('Failed to generate summary:', error);
          if (currentHoverPath === filePath) {
            showTooltip('Failed to generate summary', anchorX, anchorY);
          }
        }
      });

      return badge;
    };

    const addBadgesToFiles = () => {
      const fileBrowser = fileBrowserFactory.tracker.currentWidget;
      if (!fileBrowser) {
        return;
      }

      const listing = fileBrowser.node.querySelector('.jp-DirListing-content');
      if (!listing) {
        return;
      }

      const fileItems = listing.querySelectorAll('.jp-DirListing-item');
      fileItems.forEach(fileItem => {
        if (badgeMap.has(fileItem)) {
          return;
        }

        const itemText = fileItem.querySelector('.jp-DirListing-itemText');
        if (!itemText) {
          return;
        }

        const fileName = itemText.textContent || '';
        const isDirectory = fileItem.querySelector('.jp-FolderIcon') !== null;

        if (!shouldSummarize(fileName, isDirectory)) {
          return;
        }

        const filePath = fileBrowser.model.path
          ? `${fileBrowser.model.path}/${fileName}`
          : fileName;

        const badge = createBadge(fileItem, fileName, filePath, isDirectory);
        itemText.appendChild(badge);
        badgeMap.set(fileItem, badge);
      });
    };

    const setupFileBrowserListeners = () => {
      const fileBrowser = fileBrowserFactory.tracker.currentWidget;
      if (!fileBrowser) {
        return;
      }

      fileBrowser.model.fileChanged.connect(() => {
        addBadgesToFiles();
      });

      fileBrowser.model.pathChanged.connect(() => {
        addBadgesToFiles();
      });

      fileBrowser.model.refreshed.connect(() => {
        addBadgesToFiles();
      });

      addBadgesToFiles();
    };

    app.restored.then(() => {
      setupFileBrowserListeners();

      fileBrowserFactory.tracker.currentChanged.connect(() => {
        setupFileBrowserListeners();
      });
    });
  }
};

export default [
  plugin,
  chromeAIImagePlugin,
  chromeAIAudioPlugin,
  chromeAIProofreaderPlugin,
  chromeAISummarizerPlugin
];
