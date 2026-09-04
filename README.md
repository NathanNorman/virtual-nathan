# Virtual Nathan

A static GitHub Pages prototype that runs a tiny language model in Chrome and speaks its answers through an animated portrait.

**Live site:** https://nathannorman.github.io/virtual-nathan/

**Repository:** https://github.com/NathanNorman/virtual-nathan

Opening the page automatically downloads and starts Qwen2.5 0.5B through WebGPU. The model generates a fresh, goofy Virtual Nathan greeting and Chrome's built-in speech system reads it aloud while the portrait animates. After the greeting, type in the blank prompt field and press Enter or the arrow button to ask a question.

During one page session, the app retains the three most recent visitor prompt/response pairs. It includes that context when a new message appears to be a follow-up, while standalone prompts run without old turns so the tiny model does not confuse them with earlier requests. The automatic greeting does not count toward the limit, and reloading the page clears the history.

By design, Virtual Nathan answers technical questions with confident, fabricated nonsense. The persona delivers its humor in character instead of announcing or explaining the joke. It is a comedy persona, not a technical reference.

## What stays local

- Prompt processing and language-model generation happen in the visitor's browser tab.
- There is no application backend, account, API key, extension, or install.
- The page does not send prompts to a remote inference API.
- Model runtime and weight files are downloaded from remote hosting on first use and cached by Chrome.
- Speech uses Chrome's Web Speech API. The selected voice may be device-local or provider-backed.

## Browser requirements

- Recent Chrome with WebGPU enabled on supported hardware.
- HTTPS in production. GitHub Pages provides it automatically.
- Serve the files over HTTP for local development; WebGPU will not run from `file://`.

The page automatically chooses:

- `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` when the GPU supports `shader-f16` (about 945 MB of GPU memory), or
- `Qwen2.5-0.5B-Instruct-q4f32_1-MLC` as the broader compatibility option (about 1.06 GB of GPU memory).

The first model load transfers roughly 276 MiB. Later visits in the same Chrome profile should normally reuse the browser cache. Generation speed depends on the visitor's GPU.

Some browser configurations may decline speech that starts without a click. If that happens, the replay icon appears after the greeting is generated.

## Run locally

From this repository:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/` in Chrome.

## Deploy to GitHub Pages

This repository has no build step. Configure GitHub Pages to deploy from the `main` branch and the repository root.

## Assets and branding

The portrait and mouth-frame assets were created for Nathan Norman's prototypes. This repository does not add a license or make broader reuse claims.

The visual treatment follows Toast's brand system and includes the Toast slice and mosaic assets from the Toast brand kit. It is an experimental visual prototype, not an official Toast product.
