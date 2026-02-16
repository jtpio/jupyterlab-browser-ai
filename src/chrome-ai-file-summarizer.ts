import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { IFileBrowserFactory } from '@jupyterlab/filebrowser';

/**
 * Check if the Summarizer API is available.
 */
function doesBrowserSupportSummarizer(): boolean {
  return typeof window !== 'undefined' && 'Summarizer' in window;
}

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
 * A plugin that adds clickable AI summary badges to files in the file browser.
 */
export const chromeAISummarizerPlugin: JupyterFrontEndPlugin<void> = {
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
