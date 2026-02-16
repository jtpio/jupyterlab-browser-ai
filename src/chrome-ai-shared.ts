export const CommandIDs = {
  generateAltText: 'chrome-ai:generate-alt-text',
  generateTranscript: 'chrome-ai:generate-transcript',
  proofreadNotebook: 'chrome-ai:proofread-notebook'
} as const;

/**
 * Utility function to efficiently convert a blob to base64 string.
 * Processes in chunks to avoid call stack overflow with large files.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  let binaryString = '';
  const chunkSize = 8192;
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const chunk = uint8Array.slice(i, i + chunkSize);
    binaryString += String.fromCharCode(...chunk);
  }
  return btoa(binaryString);
}
