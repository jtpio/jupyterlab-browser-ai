import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { Notification } from '@jupyterlab/apputils';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { textEditorIcon } from '@jupyterlab/ui-components';

import { browserAI, doesBrowserSupportBrowserAI } from '@browser-ai/core';

import { streamText } from 'ai';

import { blobToBase64, CommandIDs } from './chrome-ai-shared';

class ChromeAITranscriptGenerator {
  async generateTranscript(audioSrc: string): Promise<string> {
    try {
      const response = await fetch(audioSrc);
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

/**
 * Helper function to check if a file is an audio file based on its extension.
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
 * Helper function to check if exactly one audio file is selected in the file browser.
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
export const chromeAIAudioPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-browser-ai:audio-transcript-generator',
  description: 'Chrome AI Audio Transcript Generator',
  autoStart: true,
  requires: [IFileBrowserFactory],
  activate: (app: JupyterFrontEnd, fileBrowserFactory: IFileBrowserFactory) => {
    if (!doesBrowserSupportBrowserAI()) {
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

          // Create transcript filename.
          const baseName = selectedItem.name.replace(/\.[^/.]+$/, '');
          const transcriptFileName = `${baseName}_transcript.txt`;
          const transcriptPath = audioPath.replace(
            selectedItem.name,
            transcriptFileName
          );

          // Save transcript to file.
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

          // Refresh the file browser to show the new file.
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

    // Add context menu item for audio files in file browser.
    app.contextMenu.addItem({
      command: CommandIDs.generateTranscript,
      selector: '.jp-DirListing-item[data-file-type]',
      rank: 2
    });
  }
};
