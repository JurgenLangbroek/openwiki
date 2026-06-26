# OpenWiki

![OpenWiki](https://raw.githubusercontent.com/langchain-ai/openwiki/main/static/openwiki.png)

OpenWiki is a CLI that writes and maintains agent documentation for your codebase.

## Install

```sh
npm install -g openwiki
```

## Usage

```sh
# Start the interactive CLI
openwiki

# Run a single command and exit
openwiki "Please generate documentation for this repository"
openwiki -p "Summarize what you can do"
openwiki --init
openwiki --update

openwiki --help
```

`openwiki` creates initial documentation in `openwiki/` when no wiki exists. If `openwiki/` already exists, it refreshes that documentation from repository changes. By default, the CLI stays open after each run so you can send follow-up messages. Use `-p` or `--print` for a one-shot non-interactive run that prints the final assistant output.

On the first interactive run, OpenWiki asks for an OpenRouter API key, lets you pick a default model, and saves both to `~/.openwiki/.env`. A LangSmith API key can also be provided optionally to enable tracing your OpenWiki runs.

See [`examples/openwiki-update.yml`](./examples/openwiki-update.yml) for a GitHub Actions workflow you can copy into a repository for scheduled updates.

## Customizing

OpenWiki runs on OpenRouter models, meaning you can use any model that OpenRouter supports (although we suggest using models with good reasoning and agentic capabilities).
You can pick what model to use by running `/model` in the CLI, and selecting from the list of available models, or setting your own custom model ID.
