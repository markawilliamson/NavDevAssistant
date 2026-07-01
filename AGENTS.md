# Repository Maintenance Instructions

This repository contains a VS Code extension for legacy Microsoft Dynamics NAV C/AL `.txt` object files. Keep changes focused on extension behavior, parser/index correctness, syntax grammar quality, and documentation that helps maintain those areas.

## Working Practices

- Prefer small, scoped changes that match the existing CommonJS style.
- Use `rg` for code searches and inspect surrounding parser/index code before changing NAV analysis behavior.
- Do not rewrite generated, vendored, or packaged artifacts unless the task explicitly requires it.
- Be careful with persistent index changes in `navIndex.js`; bump `CACHE_VERSION` whenever cached JSON analysis shape changes.
- Preserve compatibility with NAV exported `.txt` object syntax. Avoid assuming Business Central `.al` project structure unless explicitly requested.
- Keep syntax grammar changes in `syntaxes/` aligned with language configuration files and snippets when relevant.

## Validation

- Run `npm test` before finishing code changes.
- For parser/index changes, add or run a focused smoke test when practical, especially for multi-line NAV object constructs.
- For UI-facing extension behavior, verify the visible result in VS Code when the change cannot be covered by syntax checks alone.

## Changelog

- Maintain `CHANGELOG.md` for user-visible changes.
- Add a concise entry when behavior, commands, parsing/indexing, diagnostics, completions, hovers, syntax highlighting, packaging, or documentation changes in a way users should know about.
- Keep entries factual and grouped under the relevant version or an `Unreleased` section when no release version has been chosen yet.
