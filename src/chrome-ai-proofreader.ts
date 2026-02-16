import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { Notification, ICommandPalette } from '@jupyterlab/apputils';
import { MarkdownCell } from '@jupyterlab/cells';
import { INotebookTracker } from '@jupyterlab/notebook';
import { textEditorIcon } from '@jupyterlab/ui-components';

import { CommandIDs } from './chrome-ai-shared';

/**
 * Check if the Proofreader API is available.
 */
function doesBrowserSupportProofreader(): boolean {
  return typeof window !== 'undefined' && 'Proofreader' in window;
}

/**
 * A plugin providing a toolbar button to proofread all markdown cells in a notebook.
 */
export const chromeAIProofreaderPlugin: JupyterFrontEndPlugin<void> = {
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

        // Collect all markdown cells.
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
          // Create proofreader instance.
          const proofreader = await Proofreader.create({
            expectedInputLanguages: ['en']
          });

          let totalCorrections = 0;
          let cellsWithCorrections = 0;

          // Process each markdown cell.
          for (const cell of markdownCells) {
            const cellModel = cell.model;
            const sharedModel = cellModel.sharedModel;
            const currentContent = sharedModel.getSource();

            if (currentContent.trim() === '') {
              continue;
            }

            // Proofread the cell content.
            const result = await proofreader.proofread(currentContent);

            // If corrections were made, update the cell.
            if (
              result.corrections.length > 0 &&
              result.correctedInput !== currentContent
            ) {
              sharedModel.setSource(result.correctedInput);
              totalCorrections += result.corrections.length;
              cellsWithCorrections++;
            }
          }

          // Clean up.
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

    // Add command to palette.
    if (palette) {
      palette.addItem({
        command: CommandIDs.proofreadNotebook,
        category: 'Notebook Operations'
      });
    }
  }
};
