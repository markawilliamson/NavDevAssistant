# NAV Dev Assistant

NAV Dev Assistant helps you work with legacy Microsoft Dynamics NAV C/AL source that has been exported as `.txt` object files. It makes those files easier to read, easier to browse, and easier to understand inside Visual Studio Code.

## What You Get

- Syntax highlighting for NAV object exports, embedded C/AL sections, and NAV RDL layout content.
- A NAV Object Navigator sidebar for browsing tables, pages, reports, codeunits, queries, XMLports, MenuSuites, and more.
- Workspace indexing for symbol lookup, references, search, and faster navigation across large NAV source dumps.
- AI-assisted code explanations for a selection or the current file using OpenAI or a local model.
- Dependency and structured-search tools to help trace relationships between objects and code blocks.

## Installation

Install NAV Dev Assistant from the Extensions view in Visual Studio Code.

If you are using a private build instead of the Marketplace version, you can also install the provided `.vsix` file from `Extensions: Install from VSIX...`.

## Quick Start

1. Open the folder that contains your exported NAV `.txt` object files.
2. Run `NAV: Activate Extension in Workspace`.
3. Open the NAV view from the activity bar to browse objects.
4. Use the command palette or editor context menu to explain code, search the workspace, and jump to related objects.

`NAV: Activate Extension in Workspace` creates a small `.navdevassistant.json` marker file and applies workspace-only settings that help VS Code recognize common NAV object exports.

## Recommended Workspace Layout

NAV Dev Assistant works best when each NAV object has been split into its own `.txt` file under a `src` folder.

```text
Your NAV Workspace
  .navdevassistant.json
  src
    Table
    Page
    Report
    Codeunit
    Query
    XMLport
    MenuSuite
```

If your source is stored elsewhere, update `navDevAssistant.source.include` in VS Code settings to match your layout.

## Everyday Commands

- `NAV: Focus Object Navigator` opens the sidebar for browsing objects by type.
- `NAV: Rebuild Symbol Index` refreshes the workspace index after major file changes.
- `NAV: Where Is` looks up symbols across indexed NAV source.
- `NAV: Structured Search` finds procedures, triggers, and calls using indexed workspace data.
- `/explain NAV: Explain Selected Code` explains the current selection in plain language.
- `Explain NAV: Ask About This Code` lets you ask a direct question about selected code.

## AI Setup

### OpenAI

Set the following VS Code settings:

- `navDevAssistant.provider`: `openai`
- `navDevAssistant.openai.apiKey`: your API key
- `navDevAssistant.openai.model`: optional model override

The default OpenAI model is `gpt-4o-mini`.

### Local Model

Set the following VS Code settings:

- `navDevAssistant.provider`: `local`
- `navDevAssistant.local.endpoint`: your local or private OpenAI-compatible endpoint
- `navDevAssistant.local.model`: the model name exposed by that server
- `navDevAssistant.local.apiKey`: optional bearer token for private endpoints

Common endpoint examples:

- LM Studio: `http://127.0.0.1:1234/v1/chat/completions`
- Ollama OpenAI-compatible endpoint: `http://localhost:11434/v1/chat/completions`
- Ollama native chat endpoint: `http://localhost:11434/api/chat`

## Privacy

When you use OpenAI, the selected code or current file is sent to the configured endpoint for explanation. When you use local mode, requests stay on the machine or server you control.

## Notes

- NAV Dev Assistant is built for legacy NAV exported `.txt` object files, not Business Central `.al` projects.
- Workspace indexing only runs in folders that contain `.navdevassistant.json`.
- Large files may be skipped to keep the editor responsive. If navigation or search results look stale, run `NAV: Rebuild Symbol Index`.
- Standard TextMate syntax highlighting works out of the box. Optional semantic token overlays are available in settings if you want deeper workspace-analysis coloring.

## Build from source

npm run package