# dsh-agnes-image

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) plugin that adds one host tool, `agnes_image`, for image generation and image editing with Agnes Image 2.5 Flash.

It is deliberately dependency-free: it imports only Node builtins and uses the injected Cordis context (`ctx.tools`, `ctx.credentials`, `ctx.attachments`, `ctx.workingDirectory`). There is no build step and no `@deepseek-ai/*` peer dependency, so a git install works without any `allowBuilds` approval.

## Install

```sh
dsh plugin --profile demo add github:foolfu86/dsh-agnes-image
dsh --profile demo --dump-config     # expect a "# == dsh-agnes-image" layer
dsh --profile demo

# remove
dsh plugin --profile demo remove dsh-agnes-image
```

## Credentials

The plugin needs an Agnes API key. It looks up the credential reference `AGNES_API_KEY` at runtime (first `process.env`, then the profile's credential store). Configure **your own** key, for example:

```sh
export AGNES_API_KEY=your_key_here
```

or add it to `~/.dsh/.credentials.yaml`. No key is stored in this repository.

## What the tool does

`agnes_image` calls the Agnes images endpoint, saves the result into the Session working directory (default `agnes-images/`), registers it as an attachment so the image shows inline in the conversation, and returns the durable file path.

Defaults (all overridable per call):

| Option | Default |
|---|---|
| `model` | `agnes-image-2.5-flash` (also `2.1-flash`, `2.0-flash`) |
| `size` | `1K` (`2K`, `3K`, `4K`) |
| `ratio` | `1:1` (plus the common 3:4 / 4:3 / 16:9 / 9:16 / 2:3 / 3:2 / 21:9) |
| `baseURL` | `https://apihub.agnes-ai.com/v1` |
| `apiKeyEnv` | `AGNES_API_KEY` |
| `outputDir` | `agnes-images` |

Local reference images (png / jpg / jpeg / webp / gif) can be passed for editing and multi-image composition.

## Layout

```
package.json        # declares dsh.bundle.patch
cordis.patch.yml    # inserts this bundle into the profile layer stack
index.js            # the agnes_image tool
```

## License

MIT
