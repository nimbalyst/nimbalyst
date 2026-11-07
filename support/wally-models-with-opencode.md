# Using Wally models with OpenCode in Nimbalyst

[Wally](https://www.runwally.com) by RunAnywhere serves open-weight models (DeepSeek, GLM, Kimi, MiniMax) through an OpenAI-compatible API. OpenCode ships Wally as a built-in provider, so once OpenCode is signed in to Wally, its models appear in Nimbalyst's OpenCode model picker. Nothing Wally-specific is configured in Nimbalyst.

## Setup

1. In Nimbalyst, open Settings > Agent Providers > OpenCode. If the OpenCode CLI is missing, click **Install OpenCode CLI** (or run `npm i -g opencode-ai`), then turn on **Enable OpenCode**.
2. Create an API key in the [RunAnywhere console](https://console.runanywhere.ai).
3. Sign OpenCode in to Wally from a terminal:

   ```bash
   opencode auth login
   ```

   Pick **Wally** from the provider list and paste the key. OpenCode keeps it in its own credentials file.
4. Open a project, return to Settings > Agent Providers > OpenCode, and click **Discover models**. Wally models appear with ids like `wally/deepseek-v4.1-flash`.
5. Pick a Wally model in the session model picker.

To check the sign-in from a terminal, run `opencode models wally`.

OpenCode also reads a `WALLY_API_KEY` environment variable, but only if it is set in the environment Nimbalyst starts OpenCode with. The key saved by `opencode auth login` works however Nimbalyst is launched.

## Models

The models OpenCode lists come from its provider registry. The current list, context and output limits, and prices are in Wally's live catalog at `https://inference.runanywhere.ai/v1/models` and on the [pricing page](https://www.runwally.com/pricing).

All Wally models support tool calls. Only `deepseek-v4.1-flash`, `deepseek-v4.1-flash-fast`, and `kimi-k3` accept images; the others are text only.
