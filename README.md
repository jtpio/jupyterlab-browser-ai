# jupyterlab_browser_ai

[![Github Actions Status](https://github.com/jtpio/jupyterlab-browser-ai/workflows/Build/badge.svg)](https://github.com/jtpio/jupyterlab-browser-ai/actions/workflows/build.yml)

In-browser AI in JupyterLab and Jupyter Notebook

## Requirements

- JupyterLab >= 4.0.0

## Install

To install the extension, execute:

```bash
pip install jupyterlab_browser_ai
```

## Chrome AI

This extension provides several features powered by
[Chrome's built-in AI APIs](https://developer.chrome.com/docs/ai/built-in-apis).
These features require no API key and run fully on-device. They are
automatically enabled when the browser supports the corresponding API and
gracefully disabled otherwise.

### Chat provider

Chrome Built-in AI is registered as a chat provider (provider ID `chrome-ai`).
Select it in the JupyterLab AI provider dropdown to chat with the on-device
model — no API key or model download required.

### Alt text generation

Right-click any image in a notebook markdown cell and select
**Generate Alt Text with ChromeAI**. The extension sends the image to Chrome's
Prompt API, generates a concise alt text description, and updates the markdown
source. The alt text is also copied to the clipboard as a fallback.

### Audio transcription

Right-click an audio file (`.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac`, `.flac`,
`.opus`) in the file browser and select **Generate Transcript with ChromeAI**.
The transcript is saved as `<filename>_transcript.txt` in the same directory.

### Notebook proofreader

Open a notebook and run the **Proofread Notebook** command from the command
palette (or the toolbar button). The extension uses Chrome's Proofreader API to
check grammar and spelling in all markdown cells and applies corrections
in-place.

### File summarizer

When Chrome's Summarizer API is available, files in the file browser
(`.ipynb`, `.md`, `.txt`, `.py`, `.js`, `.ts`) display a sparkle badge. Click
the badge to generate a TL;DR summary shown in a tooltip. Summaries are cached
and automatically invalidated when the file is saved.

## Transformers.js models

Transformers.js model IDs can be discovered on Hugging Face:

- https://huggingface.co/models?library=transformers.js&pipeline_tag=text-generation&sort=downloads

By default, this extension uses:

- `onnx-community/Qwen2.5-Coder-0.5B-Instruct`
- `onnx-community/Qwen2.5-0.5B-Instruct`
- `HuggingFaceTB/SmolLM2-360M-Instruct`

The `transformersJsModels` setting for `jupyterlab-browser-ai` controls the
full dropdown list. If you set it, your list replaces the defaults.

For example:

```json
{
  "transformersJsModels": [
    "onnx-community/Qwen3-0.6B-ONNX",
    "your-org/your-custom-model",
    "HuggingFaceTB/SmolLM2-360M-Instruct"
  ]
}
```

## WebLLM models

WebLLM model IDs can be discovered in the WebLLM prebuilt model config:

- https://github.com/mlc-ai/web-llm/blob/main/src/config.ts (look for `prebuiltAppConfig.model_list[].model_id`)
- https://webllm.mlc.ai/docs/user/basic_usage.html#model-records-in-webllm (official WebLLM docs)

To print the model IDs from the exact `@mlc-ai/web-llm` version installed in this project:

```bash
node -e "import('@mlc-ai/web-llm').then(w => console.log(w.prebuiltAppConfig.model_list.map(m => m.model_id).join('\n')))"
```

By default, this extension uses:

- `Llama-3.2-3B-Instruct-q4f16_1-MLC`
- `Llama-3.2-1B-Instruct-q4f16_1-MLC`
- `Phi-3.5-mini-instruct-q4f16_1-MLC`
- `gemma-2-2b-it-q4f16_1-MLC`
- `Qwen3-0.6B-q4f16_1-MLC`

The `webLLMModels` setting in `jupyterlab-browser-ai` controls the full
WebLLM model dropdown list. If you set it, your list replaces the defaults.

For example:

```json
{
  "webLLMModels": [
    "Qwen3-0.6B-q4f16_1-MLC",
    "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    "gemma-2-2b-it-q4f16_1-MLC"
  ]
}
```

## Uninstall

To remove the extension, execute:

```bash
pip uninstall jupyterlab_browser_ai
```

## Contributing

### Development install

Note: You will need NodeJS to build the extension package.

The `jlpm` command is JupyterLab's pinned version of
[yarn](https://yarnpkg.com/) that is installed with JupyterLab. You may use
`yarn` or `npm` in lieu of `jlpm` below.

```bash
# Clone the repo to your local environment
# Change directory to the jupyterlab_browser_ai directory
# Install package in development mode
pip install -e "."
# Link your development version of the extension with JupyterLab
jupyter labextension develop . --overwrite
# Rebuild extension Typescript source after making changes
jlpm build
```

You can watch the source directory and run JupyterLab at the same time in different terminals to watch for changes in the extension's source and automatically rebuild the extension.

```bash
# Watch the source directory in one terminal, automatically rebuilding when needed
jlpm watch
# Run JupyterLab in another terminal
jupyter lab
```

With the watch command running, every saved change will immediately be built locally and available in your running JupyterLab. Refresh JupyterLab to load the change in your browser (you may need to wait several seconds for the extension to be rebuilt).

By default, the `jlpm build` command generates the source maps for this extension to make it easier to debug using the browser dev tools. To also generate source maps for the JupyterLab core extensions, you can run the following command:

```bash
jupyter lab build --minimize=False
```

### Development uninstall

```bash
pip uninstall jupyterlab_browser_ai
```

In development mode, you will also need to remove the symlink created by `jupyter labextension develop`
command. To find its location, you can run `jupyter labextension list` to figure out where the `labextensions`
folder is located. Then you can remove the symlink named `jupyterlab-browser-ai` within that folder.

### Packaging the extension

See [RELEASE](RELEASE.md)
