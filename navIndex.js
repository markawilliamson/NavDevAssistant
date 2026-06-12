const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const vscode = require("vscode");

const WATCH_GLOB = "**/*.txt";
const DEFAULT_CONFIG_FILE = ".navdevassistant.json";
const DEFAULT_INCLUDE = ["src/**/*.txt"];
const DEFAULT_EXCLUDE = ["**/{node_modules,.git,out,dist,build,bin,obj,.vscode-test}/**"];
const DEFAULT_MAX_INDEX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_INDEX_CONCURRENCY = 8;
const MAX_DEFINITION_RESULTS = 50;
const MAX_REFERENCE_RESULTS = 500;
const CACHE_VERSION = 7;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;
const KEYWORDS = new Set(
  [
    "and",
    "array",
    "begin",
    "case",
    "code",
    "decimal",
    "do",
    "downto",
    "else",
    "end",
    "false",
    "for",
    "foreach",
    "if",
    "integer",
    "local",
    "of",
    "option",
    "procedure",
    "record",
    "repeat",
    "text",
    "then",
    "to",
    "trigger",
    "true",
    "until",
    "var",
    "while",
    "with"
  ].map((value) => value.toLowerCase())
);

class NavIndexCache {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.cacheDir = undefined;
    this.analysisDir = undefined;
    this.manifestPath = undefined;
    this.manifest = { version: CACHE_VERSION, files: {} };
    this.opened = false;
    this.dirty = false;
    this.flushTimer = undefined;
    this.bulkDepth = 0;
  }

  async open() {
    if (this.opened) {
      return;
    }

    const storageUri = this.context.storageUri || this.context.globalStorageUri;
    await vscode.workspace.fs.createDirectory(storageUri);
    this.cacheDir = path.join(storageUri.fsPath, "nav-index-cache-v2");
    this.analysisDir = path.join(this.cacheDir, "analysis");
    this.manifestPath = path.join(this.cacheDir, "manifest.json");
    await fs.promises.mkdir(this.analysisDir, { recursive: true });
    await this.deleteLegacySqliteCaches(storageUri.fsPath);
    await this.loadManifest();
    this.opened = true;
  }

  async loadManifest() {
    try {
      const text = await fs.promises.readFile(this.manifestPath, "utf8");
      const parsed = JSON.parse(text);
      this.manifest = parsed?.version === CACHE_VERSION && parsed.files
        ? parsed
        : { version: CACHE_VERSION, files: {} };
    } catch {
      this.manifest = { version: CACHE_VERSION, files: {} };
      this.dirty = true;
    }
  }

  async deleteLegacySqliteCaches(storagePath) {
    let entries;
    try {
      entries = await fs.promises.readdir(storagePath);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!/^nav-dev-assistant\.sqlite(?:\.|$)/.test(entry)) {
        continue;
      }

      try {
        const fullPath = path.join(storagePath, entry);
        const stat = await fs.promises.stat(fullPath);
        await fs.promises.unlink(fullPath);
        this.output.appendLine(`Deleted legacy SQLite cache (${Math.round(stat.size / 1024 / 1024)} MB): ${fullPath}`);
      } catch {
        // Legacy cache cleanup is best-effort.
      }
    }
  }

  async loadAll() {
    await this.open();
    if (!this.isEnabled) {
      return [];
    }

    const result = [];
    let corrupt = 0;
    const entries = Object.entries(this.manifest.files || {}).sort((a, b) => {
      return String(a[1].fsPath || "").localeCompare(String(b[1].fsPath || ""));
    });

    for (const [uriString, entry] of entries) {
      try {
        const uri = vscode.Uri.parse(uriString);
        const raw = JSON.parse(await fs.promises.readFile(path.join(this.analysisDir, entry.file), "utf8"));
        result.push({ uri, analysis: hydrateAnalysis(uri, raw.analysis || raw) });
      } catch {
        corrupt += 1;
        delete this.manifest.files[uriString];
        this.dirty = true;
      }
    }

    if (corrupt) {
      this.output.appendLine(`Ignored ${corrupt} unreadable NAV cache file(s).`);
      this.scheduleFlush();
    }

    return result;
  }

  async getFileStat(uri) {
    await this.open();
    if (!this.isEnabled) {
      return undefined;
    }

    const entry = this.manifest.files[uri.toString()];
    return entry ? { mtime: Number(entry.mtime), size: Number(entry.size) } : undefined;
  }

  async save(uri, stat, analysis) {
    await this.open();
    if (!this.isEnabled) {
      return;
    }

    const uriString = uri.toString();
    const file = `${sha256(uriString)}.json`;
    const targetPath = path.join(this.analysisDir, file);
    await writeJsonAtomic(targetPath, {
      uri: uriString,
      fsPath: uri.fsPath,
      mtime: stat.mtime,
      size: stat.size,
      analysis: serializeAnalysis(analysis)
    });

    this.manifest.files[uriString] = {
      fsPath: uri.fsPath,
      mtime: stat.mtime,
      size: stat.size,
      file
    };
    this.markDirty();
  }

  async delete(uri) {
    await this.open();
    if (!this.isEnabled) {
      return;
    }

    const uriString = uri.toString();
    const entry = this.manifest.files[uriString];
    if (entry?.file) {
      try {
        await fs.promises.unlink(path.join(this.analysisDir, entry.file));
      } catch {
        // It is fine if the per-file cache was already gone.
      }
    }
    delete this.manifest.files[uriString];
    this.markDirty();
  }

  async clear() {
    await this.open();
    if (!this.isEnabled) {
      return;
    }

    await this.reset();
  }

  async reset() {
    const wasOpen = this.opened;
    if (!wasOpen) {
      await this.open();
    }

    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    try {
      await fs.promises.rm(this.cacheDir, { recursive: true, force: true });
    } catch {
      // Cache reset is best-effort; recreate below.
    }

    await fs.promises.mkdir(this.analysisDir, { recursive: true });
    this.manifest = { version: CACHE_VERSION, files: {} };
    this.dirty = true;
    this.opened = true;
    await this.flush();
  }

  markDirty() {
    this.dirty = true;
    if (this.bulkDepth > 0) {
      return;
    }
    this.scheduleFlush();
  }

  beginBulk() {
    this.bulkDepth += 1;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  endBulk() {
    this.bulkDepth = Math.max(0, this.bulkDepth - 1);
    if (this.bulkDepth === 0 && this.dirty) {
      this.scheduleFlush();
    }
  }

  rollbackBulk() {
    this.bulkDepth = 0;
  }

  scheduleFlush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flush().catch((error) => this.output.appendLine(`NAV cache flush failed: ${error.message}`));
    }, 1500);
  }

  async flush() {
    await this.open();
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.dirty || !this.manifestPath) {
      return;
    }

    await writeJsonAtomic(this.manifestPath, this.manifest);
    this.dirty = false;
  }

  get isEnabled() {
    return vscode.workspace.getConfiguration("navDevAssistant").get("persistentIndex.enabled", true);
  }
}

class NavWorkspaceIndex {
  constructor(context) {
    this.context = context;
    this.documents = new Map();
    this.documentVersions = new Map();
    this.definitions = new Map();
    this.references = new Map();
    this.workspaceConfigs = new Map();
    this._onDidChangeObjects = new vscode.EventEmitter();
    this._onDidChangeStatus = new vscode.EventEmitter();
    this.onDidChangeObjects = this._onDidChangeObjects.event;
    this.onDidChangeStatus = this._onDidChangeStatus.event;
    this.output = vscode.window.createOutputChannel("NAV Dev Assistant");
    this.cache = new NavIndexCache(context, this.output);
    this.ready = Promise.resolve();
    this.indexOperation = Promise.resolve();
    this.currentOperationLabel = "";
    this.refreshTimer = undefined;
    this.isRebuilding = false;
  }

  start() {
    this.ready = this.refreshFromCache();

    const watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);
    watcher.onDidCreate((uri) => this.queueIndex(uri));
    watcher.onDidChange((uri) => this.queueIndex(uri));
    watcher.onDidDelete((uri) => {
      this.remove(uri);
      this.cache.delete(uri).catch((error) => this.output.appendLine(`NAV cache delete failed: ${error.message}`));
    });
    const configWatcher = vscode.workspace.createFileSystemWatcher(`**/${this.configFileName}`);
    const rebuild = () => {
      this.ready = this.rebuild();
    };
    configWatcher.onDidCreate(rebuild);
    configWatcher.onDidChange(rebuild);
    configWatcher.onDidDelete(rebuild);

    this.context.subscriptions.push(
      watcher,
      configWatcher,
      this._onDidChangeObjects,
      this._onDidChangeStatus,
      this.output,
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.shouldIndexDocument(event.document)) {
          this.queueIndex(event.document.uri);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (!document.isDirty && this.shouldIndexDocument(document)) {
          this.queueIndex(document.uri);
        }
      })
    );

    return this.ready;
  }

  async refreshFromCache(progress, token) {
    return this.runExclusive("startup refresh", () => this.doRefreshFromCache(progress, token));
  }

  async doRefreshFromCache(progress, token) {
    const startedAt = Date.now();
    await this.cache.open();
    this.documents.clear();
    this.documentVersions.clear();
    this.definitions.clear();
    this.references.clear();
    this.workspaceConfigs.clear();

    const cached = await this.cache.loadAll();
    for (const { uri, analysis } of cached) {
      this.indexAnalysis(uri, analysis, { fromCache: true });
    }

    this.output.appendLine(`[${new Date().toLocaleTimeString()}] Loaded ${cached.length} NAV source file(s) from persistent cache.`);
    this._onDidChangeObjects.fire();

    const configs = await this.loadWorkspaceConfigs();
    const uris = await this.discoverSourceUris(configs, token);
    const liveKeys = new Set(uris.map((uri) => uri.toString()));
    let changed = 0;
    let skipped = 0;
    let removed = 0;

    progress?.report({ message: `Checking ${uris.length} NAV source file(s) for changes` });

    this.cache.beginBulk();
    for (const cachedItem of cached) {
      if (!liveKeys.has(cachedItem.uri.toString())) {
        this.remove(cachedItem.uri);
        await this.cache.delete(cachedItem.uri);
        removed += 1;
      }
    }

    await eachLimit(uris, this.indexConcurrency, async (uri) => {
      if (token?.isCancellationRequested) {
        return;
      }

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > this.maxIndexFileBytes) {
          this.remove(uri);
          await this.cache.delete(uri);
          skipped += 1;
          return;
        }

        const cachedStat = await this.cache.getFileStat(uri);
        if (
          cachedStat &&
          cachedStat.mtime === stat.mtime &&
          cachedStat.size === stat.size &&
          this.documents.has(uri.toString())
        ) {
          skipped += 1;
          return;
        }

        const didIndex = await this.indexUri(uri);
        if (didIndex) {
          changed += 1;
        } else {
          skipped += 1;
        }
      } catch {
        this.remove(uri);
        await this.cache.delete(uri);
        removed += 1;
      }
    });

    this.cache.endBulk();
    await this.cache.flush();
    this.output.appendLine(
      `Persistent cache refresh complete: ${changed} changed, ${skipped} unchanged/skipped, ${removed} removed in ${Math.round((Date.now() - startedAt) / 1000)}s.`
    );
    this.output.appendLine(`Object navigator objects: ${this.getObjectCount()}.`);
    this._onDidChangeObjects.fire();
  }

  async rebuild(progress, token) {
    return this.runExclusive("symbol rebuild", () => this.doRebuild(progress, token));
  }

  async clearCacheAndRebuild(progress, token) {
    return this.runExclusive("cache reset", async () => {
      await this.cache.reset();
      await this.doRebuild(progress, token);
    });
  }

  async doRebuild(progress, token) {
    const startedAt = Date.now();
    this.isRebuilding = true;
    this.documents.clear();
    this.documentVersions.clear();
    this.definitions.clear();
    this.references.clear();
    this.workspaceConfigs.clear();

    await this.cache.open();
    this.cache.beginBulk();
    await this.cache.clear();
    const configs = await this.loadWorkspaceConfigs();
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] Rebuilding NAV index for ${configs.length} workspace folder(s).`);
    const uris = await this.discoverSourceUris(configs, token);
    const total = uris.length;
    let indexed = 0;
    let skipped = 0;
    this.output.appendLine(`Matched ${total} NAV source file(s).`);
    progress?.report({ message: `Found ${total} NAV source file(s)` });

    await eachLimit(uris, this.indexConcurrency, async (uri) => {
      if (token?.isCancellationRequested) {
        return;
      }

      const didIndex = await this.indexUri(uri);
      if (didIndex) {
        indexed += 1;
      } else {
        skipped += 1;
      }

      const completed = indexed + skipped;
      if (completed % 25 === 0 || completed === total) {
        progress?.report({
          increment: total ? (25 / total) * 100 : 0,
          message: `${completed}/${total} files (${indexed} indexed, ${skipped} skipped)`
        });
        this.output.appendLine(`Progress: ${completed}/${total} files (${indexed} indexed, ${skipped} skipped).`);
      }
    });

    if (token?.isCancellationRequested) {
      this.output.appendLine(`Index rebuild cancelled after ${Math.round((Date.now() - startedAt) / 1000)}s.`);
      this.cache.rollbackBulk();
      this.isRebuilding = false;
      this._onDidChangeObjects.fire();
      return;
    }

    this.output.appendLine(`Index rebuild complete: ${indexed} indexed, ${skipped} skipped in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
    this.output.appendLine(`Object navigator objects: ${this.getObjectCount()}.`);
    this.cache.endBulk();
    await this.cache.flush();
    this.isRebuilding = false;
    this._onDidChangeObjects.fire();
  }

  async runExclusive(label, operation) {
    const previous = this.indexOperation.catch(() => undefined);
    const next = previous.then(async () => {
      this.currentOperationLabel = label;
      this._onDidChangeStatus.fire(this.status);
      this.output.appendLine(`[${new Date().toLocaleTimeString()}] Starting NAV index ${label}.`);
      try {
        return await operation();
      } finally {
        this.output.appendLine(`[${new Date().toLocaleTimeString()}] Finished NAV index ${label}.`);
        this.currentOperationLabel = "";
        this._onDidChangeStatus.fire(this.status);
      }
    });
    this.indexOperation = next.catch(() => undefined);
    this.ready = this.indexOperation;
    return next;
  }

  async discoverSourceUris(configs, token) {
    const urisByKey = new Map();

    for (const config of configs) {
      const exclude = config.exclude.length ? `{${config.exclude.join(",")}}` : undefined;
      this.output.appendLine(`Folder: ${config.folder.uri.fsPath}`);
      this.output.appendLine(`Includes: ${config.include.join(", ")}`);
      this.output.appendLine(`Excludes: ${config.exclude.join(", ")}`);
      for (const include of config.include) {
        if (token?.isCancellationRequested) {
          this.output.appendLine("Index discovery cancelled.");
          return [];
        }
        const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(config.folder, include), exclude);
        for (const uri of matches) {
          urisByKey.set(uri.toString(), uri);
        }
      }
    }

    return [...urisByKey.values()].filter((uri) => this.shouldIndexUri(uri));
  }

  queueIndex(uri) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      const update = async () => {
        await this.indexOperation.catch(() => undefined);
        await this.indexUri(uri);
      };
      update().catch((error) => this.output.appendLine(`Index update failed: ${error.message}`));
    }, 150);
  }

  async indexUri(uri) {
    try {
      if (!this.shouldIndexUri(uri)) {
        this.remove(uri);
        await this.cache.delete(uri);
        return false;
      }

      const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
      if (openDocument) {
        await this.indexTextDocument(openDocument, { force: true });
        return true;
      }

      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > this.maxIndexFileBytes) {
        this.remove(uri);
        await this.cache.delete(uri);
        this.output.appendLine(`Skipped large file (${Math.round(stat.size / 1024)} KB): ${uri.fsPath}`);
        return false;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      if (!hasNavObjectHeader(text)) {
        this.remove(uri);
        await this.cache.delete(uri);
        return false;
      }

      const analysis = analyzeText(uri, text);
      this.indexAnalysis(uri, analysis);
      await this.cache.save(uri, stat, analysis);
      return true;
    } catch {
      this.remove(uri);
      await this.cache.delete(uri);
      return false;
    }
  }

  async indexTextDocument(document, options = {}) {
    const key = document.uri.toString();
    const previousVersion = this.documentVersions.get(key);
    if (!options.force && previousVersion === document.version) {
      return;
    }

    const text = document.getText();
    if (!hasNavObjectHeader(text)) {
      this.remove(document.uri, { silent: options.silent });
      this.documentVersions.set(key, document.version);
      if (!options.skipCache) {
        await this.cache.delete(document.uri);
      }
      return;
    }

    const analysis = analyzeText(document.uri, text);
    this.indexAnalysis(document.uri, analysis, { silent: options.silent });
    this.documentVersions.set(key, document.version);
    if (options.skipCache) {
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(document.uri);
      await this.cache.save(document.uri, stat, analysis);
    } catch {
      this.cache.scheduleFlush();
    }
  }

  indexAnalysis(uri, analysis, options = {}) {
    this.remove(uri, options);
    const key = uri.toString();
    this.documents.set(key, analysis);

    for (const definition of analysis.definitions) {
      pushMap(this.definitions, definition.key, definition);
    }

    for (const reference of analysis.references) {
      pushMap(this.references, reference.key, reference.location);
    }
    if (!this.isRebuilding && !options.fromCache && !options.silent) {
      this._onDidChangeObjects.fire();
    }
  }

  remove(uri, options = {}) {
    const key = uri.toString();
    const analysis = this.documents.get(key);
    if (!analysis) {
      return;
    }

    for (const definition of analysis.definitions) {
      removeMapItem(this.definitions, definition.key, definition);
    }

    for (const reference of analysis.references) {
      removeMapItem(this.references, reference.key, reference.location);
    }

    this.documents.delete(key);
    this.documentVersions.delete(key);
    if (!this.isRebuilding && !options.silent) {
      this._onDidChangeObjects.fire();
    }
  }

  async findDefinitions(document, position) {
    await settleSoon(this.ready);
    await this.ensureWorkspaceConfigsLoaded();
    if (!this.shouldIndexDocument(document)) {
      return [];
    }
    if (!this.documents.has(document.uri.toString())) {
      const text = document.getText();
      if (!hasNavObjectHeader(text)) {
        return [];
      }

      this.indexAnalysis(document.uri, analyzeText(document.uri, text), { silent: true });
      this.documentVersions.set(document.uri.toString(), document.version);
    }
    const keys = this.getLookupKeys(document, position);
    const definitions = uniqueLocations(keys.flatMap((key) => this.definitions.get(key) || []));
    if (!definitions.length && keys.length) {
      this.output.appendLine(`Definition lookup returned no results for keys: ${keys.join(", ")}`);
    }
    if (definitions.length > MAX_DEFINITION_RESULTS) {
      this.output.appendLine(`Definition lookup capped ${definitions.length} results for keys: ${keys.join(", ")}`);
    }
    return definitions.slice(0, MAX_DEFINITION_RESULTS);
  }

  async findReferences(document, position, includeDeclaration = true) {
    await this.ready;
    await this.ensureWorkspaceConfigsLoaded();
    if (!this.shouldIndexDocument(document)) {
      return [];
    }
    await this.indexTextDocument(document, { skipCache: true, silent: true });
    await this.ready;
    const keys = this.getLookupKeys(document, position);
    const locations = keys.flatMap((key) => this.references.get(key) || []);

    if (includeDeclaration) {
      locations.push(...keys.flatMap((key) => this.definitions.get(key) || []));
    }

    const references = uniqueLocations(locations);
    if (references.length > MAX_REFERENCE_RESULTS) {
      this.output.appendLine(`Reference lookup capped ${references.length} results for keys: ${keys.join(", ")}`);
    }
    return references.slice(0, MAX_REFERENCE_RESULTS);
  }

  async findReferencesByKey(key) {
    await this.ready;
    return uniqueLocations(this.references.get(normalizeKey(key)) || []);
  }

  async findWorkspaceSymbols(query) {
    await this.ready;
    const needle = normalizeKey(query || "");
    const definitions = [];

    for (const items of this.definitions.values()) {
      for (const item of items) {
        if (!needle || item.key.includes(needle)) {
          definitions.push(item);
        }
      }
    }

    return uniqueLocations(definitions)
      .slice(0, 200)
      .map((definition) => {
        const symbol = new vscode.SymbolInformation(
          definition.name,
          definition.kind,
          definition.detail,
          new vscode.Location(definition.uri, definition.range)
        );
        return symbol;
      });
  }

  async findRecordFieldCompletions(document, position) {
    await settleSoon(this.ready);
    await this.ensureWorkspaceConfigsLoaded();
    if (!this.shouldIndexDocument(document)) {
      return [];
    }
    await this.indexTextDocument(document, { skipCache: true, silent: true });

    const analysis = this.documents.get(document.uri.toString());
    const receiver = dottedCompletionReceiverAt(document.lineAt(position.line).text, position.character);
    if (!receiver || !analysis?.recordVariables) {
      return [];
    }

    const tableName = analysis.recordVariables.get(normalizeKey(receiver));
    if (!tableName) {
      return [];
    }

    return this.getFieldsForTable(tableName);
  }

  async getAnalysisForDocument(document, options = {}) {
    await settleSoon(this.ready);
    await this.ensureWorkspaceConfigsLoaded();
    if (!this.shouldIndexDocument(document)) {
      return undefined;
    }

    await this.indexTextDocument(document, { skipCache: true, silent: options.silent !== false });
    return this.documents.get(document.uri.toString());
  }

  async getAnalysisForUri(uri) {
    await settleSoon(this.ready);
    await this.ensureWorkspaceConfigsLoaded();
    if (!this.shouldIndexUri(uri)) {
      return undefined;
    }

    const existing = this.documents.get(uri.toString());
    if (existing) {
      return existing;
    }

    try {
      const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString())
        || await vscode.workspace.openTextDocument(uri);
      return this.getAnalysisForDocument(document);
    } catch {
      return undefined;
    }
  }

  async getWorkspaceAnalyses() {
    await this.ready;
    return [...this.documents.entries()].map(([uriString, analysis]) => ({
      uri: vscode.Uri.parse(uriString),
      analysis
    }));
  }

  async findObject(type, idOrName) {
    const normalizedType = normalizeNavObjectType(type);
    const normalizedNeedle = normalizeKey(idOrName);
    if (!normalizedType || !normalizedNeedle) {
      return undefined;
    }

    const objects = await this.getObjects();
    return objects.find((object) => {
      if (normalizeNavObjectType(object.type) !== normalizedType) {
        return false;
      }

      return normalizedNeedle === normalizeKey(object.id)
        || normalizedNeedle === normalizeKey(object.name)
        || normalizedNeedle === normalizeKey(`${object.id} ${object.name}`)
        || normalizedNeedle === normalizeKey(`${object.type} ${object.id}`)
        || normalizedNeedle === normalizeKey(`${object.type} ${object.name}`)
        || normalizedNeedle === normalizeKey(`${object.type} ${object.id} ${object.name}`);
    });
  }

  async getDependencies() {
    await this.ready;
    const dependencies = [];
    for (const [uriString, analysis] of this.documents.entries()) {
      const uri = vscode.Uri.parse(uriString);
      for (const dependency of analysis.dependencies || []) {
        dependencies.push({
          ...dependency,
          uri
        });
      }
    }
    return dependencies;
  }

  getFieldsForTable(tableName) {
    const tableKey = normalizeKey(tableName);
    const prefix = `${tableKey}.`;
    const fields = new Map();

    for (const [key, definitions] of this.definitions.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      for (const definition of definitions) {
        const fieldName = fieldNameFromDefinitionName(definition.name, tableName);
        const normalizedFieldName = normalizeKey(fieldName);
        if (!fieldName || fields.has(normalizedFieldName)) {
          continue;
        }

        fields.set(normalizedFieldName, {
          name: fieldName,
          detail: definition.detail || `Table ${tableName}`,
          uri: definition.uri,
          range: definition.range
        });
      }
    }

    return [...fields.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  async getIndexedSourceUris(token) {
    await this.ready;
    await this.ensureWorkspaceConfigsLoaded();
    return this.discoverSourceUris([...this.workspaceConfigs.values()], token);
  }

  async getIndexedSourceUrisForFolder(folderUri, token) {
    await this.ready;
    await this.ensureWorkspaceConfigsLoaded();

    const key = folderUri?.toString?.();
    if (!key) {
      return [];
    }

    const configs = [...this.workspaceConfigs.values()].filter((config) => config.folder.uri.toString() === key);
    if (!configs.length) {
      return [];
    }

    return this.discoverSourceUris(configs, token);
  }

  async getObjects() {
    await this.ready;
    const objects = [];
    for (const analysis of this.documents.values()) {
      objects.push(...(analysis.objects || []));
    }
    return sortNavObjects(objects);
  }

  getObjectCount() {
    let count = 0;
    for (const analysis of this.documents.values()) {
      count += (analysis.objects || []).length;
    }
    return count;
  }

  get configFileName() {
    return vscode.workspace.getConfiguration("navDevAssistant").get("configFileName", DEFAULT_CONFIG_FILE);
  }

  get status() {
    return {
      busy: Boolean(this.currentOperationLabel),
      label: this.currentOperationLabel
    };
  }

  async loadWorkspaceConfigs() {
    const folders = vscode.workspace.workspaceFolders || [];
    const configs = [];

    for (const folder of folders) {
      const config = await this.loadWorkspaceConfig(folder);
      if (config) {
        configs.push(config);
        this.workspaceConfigs.set(folder.uri.toString(), config);
      }
    }

    return configs;
  }

  async ensureWorkspaceConfigsLoaded() {
    if (!this.workspaceConfigs.size) {
      await this.loadWorkspaceConfigs();
    }
  }

  async loadWorkspaceConfig(folder) {
    const configUri = vscode.Uri.joinPath(folder.uri, this.configFileName);
    const settings = vscode.workspace.getConfiguration("navDevAssistant", folder.uri);
    const configuredInclude = configuredSettingValue(settings, "source.include");
    const configuredExclude = configuredSettingValue(settings, "source.exclude");
    try {
      const bytes = await vscode.workspace.fs.readFile(configUri);
      const raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
      const include = normalizeStringArray(configuredInclude ?? raw.include, DEFAULT_INCLUDE);
      const exclude = mergeStringArrays(DEFAULT_EXCLUDE, normalizeStringArray(configuredExclude ?? raw.exclude, []));
      const indexTxtFiles = raw.indexTxtFiles !== false;
      const txtInclude = include.filter(isTxtIncludePattern);

      return {
        folder,
        include: indexTxtFiles ? txtInclude : [],
        exclude,
        extensions: extensionsFromIncludes(txtInclude, indexTxtFiles)
      };
    } catch {
      return undefined;
    }
  }

  getWorkspaceConfigForUri(uri) {
    let bestMatch = undefined;

    for (const config of this.workspaceConfigs.values()) {
      const relative = path.relative(config.folder.uri.fsPath, uri.fsPath);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        if (!bestMatch || config.folder.uri.fsPath.length > bestMatch.folder.uri.fsPath.length) {
          bestMatch = config;
        }
      }
    }

    return bestMatch;
  }

  shouldIndexDocument(document) {
    return this.shouldIndexUri(document.uri) && isNavDocument(document);
  }

  shouldIndexUri(uri) {
    if (uri.scheme !== "file") {
      return false;
    }

    const config = this.getWorkspaceConfigForUri(uri);
    if (!config) {
      return false;
    }

    return config.extensions.has(path.extname(uri.fsPath).toLowerCase());
  }

  get maxIndexFileBytes() {
    return vscode.workspace.getConfiguration("navDevAssistant").get("maxIndexFileBytes", DEFAULT_MAX_INDEX_FILE_BYTES);
  }

  get indexConcurrency() {
    return vscode.workspace.getConfiguration("navDevAssistant").get("indexConcurrency", DEFAULT_INDEX_CONCURRENCY);
  }

  getLookupKeys(document, position) {
    const preciseKeys = [];
    const analysis = this.documents.get(document.uri.toString());
    const line = document.lineAt(position.line).text;
    const dotted = dottedNameAt(line, position.character);
    const resolved = resolveDottedRecordField(dotted, analysis?.recordVariables);
    const resolvedRecordProcedure = resolveDottedRecordProcedure(dotted, analysis?.recordVariables);
    const resolvedObjectProcedure = resolveDottedObjectProcedure(dotted, analysis?.objectVariables);
    const recordType = recordTypeAt(line, position.character);
    const definitionKeys = definitionKeysAtPosition(analysis, position);
    const withTable = tableNameForWithScope(analysis, position.line);
    const token = tokenAt(line, position.character);
    const procedureCall = procedureCallAt(line, position.character);

    if (resolved) {
      preciseKeys.unshift(normalizeKey(resolved));
    }

    if (resolvedRecordProcedure) {
      preciseKeys.push(normalizeKey(resolvedRecordProcedure));
    }

    if (resolvedObjectProcedure) {
      preciseKeys.unshift(normalizeKey(resolvedObjectProcedure));
    }

    if (recordType) {
      preciseKeys.unshift(normalizeKey(recordType));
    }

    if (withTable && token && !dotted) {
      preciseKeys.unshift(normalizeKey(`${withTable}.${token.text}`));
    }

    if (procedureCall) {
      preciseKeys.unshift(normalizeKey(procedureCall));
    }

    preciseKeys.unshift(...definitionKeys);

    return [...new Set(preciseKeys)];
  }
}

function extensionsFromIncludes(include, indexTxtFiles) {
  const extensions = new Set();

  for (const pattern of include) {
    const matches = pattern.matchAll(/\*\.([A-Za-z0-9]+)/g);
    for (const match of matches) {
      const extension = `.${match[1].toLowerCase()}`;
      if (extension !== ".txt" || indexTxtFiles) {
        extensions.add(extension);
      }
    }
  }

  if (!extensions.size) {
    if (indexTxtFiles) {
      extensions.add(".txt");
    }
  }

  return extensions;
}

function isTxtIncludePattern(pattern) {
  return String(pattern || "").toLowerCase().includes(".txt");
}

function configuredSettingValue(configuration, key) {
  const inspected = configuration.inspect(key);
  return inspected?.workspaceFolderValue
    ?? inspected?.workspaceValue
    ?? inspected?.globalValue;
}

function normalizeStringArray(value, fallback) {
  return Array.isArray(value) && value.length
    ? value.map((item) => String(item)).filter(Boolean)
    : fallback;
}

function mergeStringArrays(...values) {
  const result = [];
  const seen = new Set();
  for (const value of values.flat()) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    result.push(text);
  }

  return result;
}

function hasNavObjectHeader(text) {
  return /^\uFEFF?\s*OBJECT\s+(Table|Form|Codeunit|Dataport|Report|XMLport|MenuSuite|Query|Page)\s+[0-9]+\s+/im.test(String(text || ""));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function writeJsonAtomic(targetPath, value) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(value)}\n`, "utf8");
  await fs.promises.rename(tempPath, targetPath);
}

function serializeAnalysis(analysis) {
  return {
    definitions: analysis.definitions.map(serializeSymbolLocation),
    references: analysis.references.map((reference) => ({
      key: reference.key,
      location: serializeLocation(reference.location)
    })),
    objects: analysis.objects.map(serializeNavObject),
    properties: (analysis.properties || []).map(serializeNamedRange),
    fields: (analysis.fields || []).map(serializeField),
    variables: (analysis.variables || []).map(serializeVariable),
    codeBlocks: (analysis.codeBlocks || []).map(serializeCodeBlock),
    dependencies: (analysis.dependencies || []).map(serializeDependency),
    recordVariables: [...analysis.recordVariables.entries()],
    objectVariables: [...(analysis.objectVariables || new Map()).entries()],
    withScopes: analysis.withScopes
  };
}

function hydrateAnalysis(defaultUri, raw) {
  return {
    definitions: (raw.definitions || []).map((definition) => hydrateSymbolLocation(defaultUri, definition)),
    references: (raw.references || []).map((reference) => ({
      key: reference.key,
      location: hydrateLocation(defaultUri, reference.location)
    })),
    objects: (raw.objects || []).map((object) => hydrateNavObject(defaultUri, object)),
    properties: (raw.properties || []).map((property) => hydrateNamedRange(property)),
    fields: (raw.fields || []).map((field) => hydrateField(field)),
    variables: (raw.variables || []).map((variable) => hydrateVariable(variable)),
    codeBlocks: (raw.codeBlocks || []).map((block) => hydrateCodeBlock(block)),
    dependencies: (raw.dependencies || []).map((dependency) => hydrateDependency(dependency)),
    recordVariables: new Map(raw.recordVariables || []),
    objectVariables: new Map(raw.objectVariables || []),
    withScopes: raw.withScopes || []
  };
}

function serializeSymbolLocation(item) {
  return {
    key: item.key,
    name: item.name,
    detail: item.detail,
    kind: item.kind,
    uri: item.uri.toString(),
    range: serializeRange(item.range)
  };
}

function hydrateSymbolLocation(defaultUri, raw) {
  return {
    key: raw.key,
    name: raw.name,
    detail: raw.detail || "",
    kind: raw.kind,
    uri: raw.uri ? vscode.Uri.parse(raw.uri) : defaultUri,
    range: hydrateRange(raw.range)
  };
}

function serializeNavObject(object) {
  return {
    type: object.type,
    id: object.id,
    name: object.name,
    versionList: object.versionList,
    date: object.date,
    time: object.time,
    modified: object.modified,
    uri: object.uri.toString(),
    range: serializeRange(object.range)
  };
}

function hydrateNavObject(defaultUri, raw) {
  return {
    type: raw.type,
    id: raw.id,
    name: raw.name,
    versionList: raw.versionList || "",
    date: raw.date || "",
    time: raw.time || "",
    modified: raw.modified || "",
    uri: raw.uri ? vscode.Uri.parse(raw.uri) : defaultUri,
    range: hydrateRange(raw.range)
  };
}

function serializeNamedRange(item) {
  return {
    name: item.name,
    value: item.value,
    range: serializeRange(item.range)
  };
}

function hydrateNamedRange(raw) {
  return {
    name: raw.name,
    value: raw.value,
    range: hydrateRange(raw.range)
  };
}

function serializeField(field) {
  return {
    id: field.id,
    name: field.name,
    dataType: field.dataType,
    range: serializeRange(field.range)
  };
}

function hydrateField(raw) {
  return {
    id: raw.id,
    name: raw.name,
    dataType: raw.dataType,
    range: hydrateRange(raw.range)
  };
}

function serializeVariable(variable) {
  return {
    id: variable.id,
    name: variable.name,
    dataType: variable.dataType,
    subtype: variable.subtype,
    temporary: Boolean(variable.temporary),
    scope: variable.scope,
    range: serializeRange(variable.range)
  };
}

function hydrateVariable(raw) {
  return {
    id: raw.id,
    name: raw.name,
    dataType: raw.dataType,
    subtype: raw.subtype,
    temporary: Boolean(raw.temporary),
    scope: raw.scope,
    range: hydrateRange(raw.range)
  };
}

function serializeCodeBlock(block) {
  return {
    kind: block.kind,
    name: block.name,
    signature: block.signature,
    isLocal: Boolean(block.isLocal),
    range: serializeRange(block.range),
    variables: (block.variables || []).map(serializeVariable)
  };
}

function hydrateCodeBlock(raw) {
  return {
    kind: raw.kind,
    name: raw.name,
    signature: raw.signature,
    isLocal: Boolean(raw.isLocal),
    range: hydrateRange(raw.range),
    variables: (raw.variables || []).map((variable) => hydrateVariable(variable))
  };
}

function serializeDependency(dependency) {
  return {
    sourceObject: dependency.sourceObject,
    targetType: dependency.targetType,
    targetIdOrName: dependency.targetIdOrName,
    kind: dependency.kind,
    sourcePath: dependency.sourcePath,
    range: serializeRange(dependency.range)
  };
}

function hydrateDependency(raw) {
  return {
    sourceObject: raw.sourceObject,
    targetType: raw.targetType,
    targetIdOrName: raw.targetIdOrName,
    kind: raw.kind,
    sourcePath: raw.sourcePath,
    range: hydrateRange(raw.range)
  };
}

function serializeLocation(location) {
  return {
    uri: location.uri.toString(),
    range: serializeRange(location.range)
  };
}

function hydrateLocation(defaultUri, raw) {
  return new vscode.Location(raw?.uri ? vscode.Uri.parse(raw.uri) : defaultUri, hydrateRange(raw?.range));
}

function serializeRange(range) {
  return {
    start: {
      line: range.start.line,
      character: range.start.character
    },
    end: {
      line: range.end.line,
      character: range.end.character
    }
  };
}

function hydrateRange(raw) {
  if (!raw) {
    return new vscode.Range(0, 0, 0, 0);
  }

  return new vscode.Range(
    raw.start?.line || 0,
    raw.start?.character || 0,
    raw.end?.line || 0,
    raw.end?.character || 0
  );
}

function analyzeText(uri, text) {
  const definitions = [];
  const references = [];
  const objects = [];
  const properties = [];
  const fields = [];
  const variables = [];
  const codeBlocks = [];
  const dependencies = [];
  const recordVariables = new Map();
  const objectVariables = new Map();
  const withScopes = [];
  const lines = text.split(/\r?\n/);
  let currentObject = undefined;
  let inFields = false;
  const variableDeclarations = [];

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    const objectMatch = line.match(/^\uFEFF?\s*OBJECT\s+(Table|Form|Codeunit|Dataport|Report|XMLport|MenuSuite|Query|Page)\s+([0-9]+)\s+(.+)$/i);
    if (objectMatch) {
      const [, objectType, objectId, objectName] = objectMatch;
      currentObject = {
        type: objectType,
        id: objectId,
        name: objectName.trim(),
        versionList: "",
        date: "",
        time: "",
        modified: "",
        uri,
        range: new vscode.Range(lineNumber, 0, lineNumber, line.length)
      };
      objects.push(currentObject);
      addDefinition(definitions, uri, lineNumber, line, currentObject.name, vscode.SymbolKind.Class, `${objectType} ${objectId}`);
      addDefinition(definitions, uri, lineNumber, line, `${objectType} ${objectId}`, vscode.SymbolKind.Class, currentObject.name);
      if (objectType.toLowerCase() === "table") {
        addDefinition(definitions, uri, lineNumber, line, objectId, vscode.SymbolKind.Class, currentObject.name);
        registerImplicitRecordVariable(recordVariables, "Rec", currentObject.name);
        registerImplicitRecordVariable(recordVariables, "xRec", currentObject.name);
      }
      continue;
    }

    if (currentObject) {
      const propertyMatch = line.match(/^\s*(Date|Time|Modified|Version List)\s*=\s*(.*?);?\s*$/i);
      if (propertyMatch) {
        const propertyName = propertyMatch[1].toLowerCase();
        const propertyValue = propertyMatch[2].trim();
        properties.push({
          name: propertyMatch[1],
          value: propertyValue,
          range: rangeForText(lineNumber, line, propertyMatch[1], propertyMatch[1])
        });
        if (propertyName === "version list") {
          currentObject.versionList = propertyValue;
        } else if (propertyName === "date") {
          currentObject.date = propertyValue;
        } else if (propertyName === "time") {
          currentObject.time = propertyValue;
        } else if (propertyName === "modified") {
          currentObject.modified = propertyValue;
        }
      }
    }

    const sourceTableMatch = line.match(/\b(SourceTable|DataItemTable)\s*=\s*([^;]+);/i);
    if (sourceTableMatch) {
      const tableName = cleanupTypeName(sourceTableMatch[2]);
      registerImplicitRecordVariable(recordVariables, "Rec", tableName);
      registerImplicitRecordVariable(recordVariables, "xRec", tableName);
      if (currentObject && tableName) {
        dependencies.push({
          sourceObject: selectedObjectLabel(currentObject),
          targetType: "Table",
          targetIdOrName: tableName,
          kind: sourceTableMatch[1],
          sourcePath: uri.fsPath,
          range: rangeForText(lineNumber, line, sourceTableMatch[2], tableName)
        });
      }
    }

    if (/^\s{2}FIELDS\b/i.test(line)) {
      inFields = true;
    } else if (inFields && /^\s{2}\}/.test(line)) {
      inFields = false;
    }

    if (inFields) {
      const fieldMatch = line.match(/^\s*\{\s*([0-9]+)\s*;[A-Za-z0-9]*\s*;([^;]+?)\s*;([A-Za-z][A-Za-z0-9 ]*)/);
      if (fieldMatch) {
        const [, fieldId, fieldName, fieldType] = fieldMatch;
        const cleanFieldName = fieldName.trim();
        const fieldRange = rangeForText(lineNumber, line, fieldName, cleanFieldName);
        addDefinitionAtRange(definitions, uri, fieldRange, cleanFieldName, vscode.SymbolKind.Field, fieldId);
        fields.push({
          id: Number(fieldId),
          name: cleanFieldName,
          dataType: cleanupTypeName(fieldType),
          range: fieldRange
        });
        if (currentObject) {
          addDefinitionAtRange(definitions, uri, fieldRange, `${currentObject.name}.${cleanFieldName}`, vscode.SymbolKind.Field, `${currentObject.type} ${currentObject.id}`);
          addDefinitionAtRange(definitions, uri, fieldRange, `${currentObject.type} ${currentObject.name}.${cleanFieldName}`, vscode.SymbolKind.Field, `${currentObject.type} ${currentObject.id}`);
          addDefinitionAtRange(definitions, uri, fieldRange, `${currentObject.id}.${cleanFieldName}`, vscode.SymbolKind.Field, `${currentObject.type} ${currentObject.name}`);
          addDefinitionAtRange(definitions, uri, fieldRange, `${currentObject.type} ${currentObject.id}.${cleanFieldName}`, vscode.SymbolKind.Field, `${currentObject.type} ${currentObject.name}`);
        }
      }
    }

    const procedureMatch = line.match(/^\s*(?:LOCAL\s+)?PROCEDURE\s+("?[^"(@]+"?|[A-Za-z_][A-Za-z0-9_]*)@?[0-9]*\s*\(/i);
    if (procedureMatch) {
      const procedureName = cleanupName(procedureMatch[1]);
      addDefinition(definitions, uri, lineNumber, line, procedureName, vscode.SymbolKind.Function, currentObjectDetail(currentObject));
      addObjectProcedureDefinitions(definitions, uri, lineNumber, line, procedureName, currentObject);
      registerProcedureParameters(recordVariables, objectVariables, line);
      codeBlocks.push({
        kind: "Procedure",
        name: procedureName,
        signature: procedureSignatureFromLine(line),
        isLocal: /^\s*LOCAL\b/i.test(line),
        startLine: lineNumber,
        range: new vscode.Range(lineNumber, 0, lineNumber, line.length),
        variables: []
      });
    }

    const triggerMatch = line.match(/^\s*(?:trigger\s+)?(On[A-Za-z0-9_]+)@?[0-9]*\s*(?:\(|=)/);
    if (triggerMatch) {
      addDefinition(definitions, uri, lineNumber, line, triggerMatch[1], vscode.SymbolKind.Event, currentObjectDetail(currentObject));
      codeBlocks.push({
        kind: "Trigger",
        name: triggerMatch[1],
        signature: `${triggerMatch[1]}()`,
        isLocal: false,
        startLine: lineNumber,
        range: new vscode.Range(lineNumber, 0, lineNumber, line.length),
        variables: []
      });
    }

    const variableMatch = line.match(/^\s*("?[^"@:;]+"?|[A-Za-z_][A-Za-z0-9_]*)@?([0-9]*)\s*:\s*([^;]+);/);
    if (variableMatch && !/^\s*(OBJECT|Date|Time|Modified|Version List)=/i.test(line)) {
      const variableName = cleanupName(variableMatch[1]);
      const variableType = variableMatch[3].trim();
      addDefinition(definitions, uri, lineNumber, line, variableName, vscode.SymbolKind.Variable, variableType);
      registerRecordVariable(recordVariables, variableName, variableType);
      registerObjectVariable(objectVariables, variableName, variableType);
      variableDeclarations.push({
        lineNumber,
        variable: buildStructuredVariable(lineNumber, line, variableMatch[1], variableMatch[2], variableType)
      });
      if (currentObject) {
        addVariableDependency(dependencies, currentObject, uri, variableDeclarations[variableDeclarations.length - 1].variable);
      }
    }
  }

  finalizeCodeBlocks(lines, codeBlocks, variableDeclarations, variables);

  collectReferencesAndWithScopes(references, withScopes, uri, lines, recordVariables);

  return {
    definitions,
    references,
    objects,
    properties,
    fields,
    variables,
    codeBlocks,
    dependencies,
    recordVariables,
    objectVariables,
    withScopes
  };
}

function procedureSignatureFromLine(line) {
  return String(line || "")
    .replace(/^\s*(?:LOCAL\s+)?PROCEDURE\s+/i, "")
    .replace(/@-?\d+/g, "")
    .replace(/\s*;\s*$/, "")
    .trim();
}

function buildStructuredVariable(lineNumber, line, rawName, rawId, variableType, scope = "global") {
  const variableName = cleanupName(rawName);
  const variableId = rawId ? Number(rawId) : undefined;
  const typeInfo = parseVariableType(variableType);
  const range = rangeForText(lineNumber, line, rawName, variableName);
  return {
    id: variableId,
    name: variableName,
    dataType: typeInfo.dataType,
    subtype: typeInfo.subtype,
    temporary: typeInfo.temporary,
    scope,
    range
  };
}

function finalizeCodeBlocks(lines, codeBlocks, variableDeclarations, globalVariables) {
  for (const block of codeBlocks) {
    block.range = new vscode.Range(
      block.startLine,
      0,
      findCodeBlockEnd(lines, block.startLine),
      lines[findCodeBlockEnd(lines, block.startLine)]?.length || 0
    );
    block.variables.push(...signatureVariables(block.signature, block.startLine, lines[block.startLine]));
  }

  for (const declaration of variableDeclarations) {
    const owner = codeBlocks.find((block) =>
      declaration.lineNumber > block.startLine &&
      declaration.lineNumber <= block.range.end.line);
    if (owner) {
      owner.variables.push({ ...declaration.variable, scope: "local" });
    } else {
      globalVariables.push({ ...declaration.variable, scope: "global" });
    }
  }
}

function signatureVariables(signature, lineNumber, line) {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open < 0 || close <= open) {
    return [];
  }

  const variables = [];
  for (const parameter of splitParameterList(signature.slice(open + 1, close))) {
    const match = parameter.match(/^(?:VAR\s+)?("?[^"@:;]+"?|[A-Za-z_][A-Za-z0-9_]*)@?([0-9]*)\s*:\s*(.+)$/i);
    if (!match) {
      continue;
    }

    variables.push(buildStructuredVariable(lineNumber, line || "", match[1], match[2], match[3], "parameter"));
  }

  return variables;
}

function parseVariableType(variableType) {
  const normalized = String(variableType || "").trim();
  const temporary = /\btemporary\b/i.test(normalized);
  const arrayStripped = normalized.replace(/^ARRAY\s*\[[^\]]+\]\s+OF\s+/i, "").trim();
  const match = arrayStripped.match(/^(Record|Codeunit|Report|Page|Query|XMLport|Form|Dataport)\s+(.+)$/i);
  if (!match) {
    return {
      dataType: cleanupTypeName(arrayStripped) || normalized,
      subtype: undefined,
      temporary
    };
  }

  return {
    dataType: normalizeNavObjectType(match[1]) === "Table" ? "Record" : normalizeNavObjectType(match[1]),
    subtype: cleanupTypeName(match[2]),
    temporary
  };
}

function addVariableDependency(dependencies, currentObject, uri, variable) {
  const targetType = variableSubtypeObjectType(variable.dataType);
  const targetIdOrName = cleanupTypeName(variable.subtype);
  if (!currentObject || !targetType || !targetIdOrName) {
    return;
  }

  dependencies.push({
    sourceObject: selectedObjectLabel(currentObject),
    targetType,
    targetIdOrName,
    kind: variable.scope === "parameter" ? "Parameter" : "Variable",
    sourcePath: uri.fsPath,
    range: variable.range
  });
}

function findCodeBlockEnd(lines, startLine) {
  let depth = 0;
  let bodyStarted = false;

  for (let index = startLine; index < lines.length; index += 1) {
    const line = lines[index];
    const scrubbed = line.replace(/'([^']|'')*'/g, "''");
    if (!bodyStarted && /\bBEGIN\b/i.test(scrubbed)) {
      bodyStarted = true;
    }

    depth += countBlockKeyword(line, "begin");
    depth -= countBlockKeyword(line, "end");
    if (bodyStarted && depth <= 0 && /\bEND\b/i.test(scrubbed)) {
      return index;
    }
  }

  return startLine;
}

function collectReferencesAndWithScopes(references, withScopes, uri, lines, recordVariables) {
  const stack = [];
  let blockDepth = 0;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    const activeWithTable = stack.length ? stack[stack.length - 1].tableName : undefined;
    collectReferences(references, uri, lineNumber, line, recordVariables, activeWithTable);

    const withMatch = line.match(/^\s*WITH\s+("?[^"]+"?|[A-Za-z_][A-Za-z0-9_]*)\s+DO\s+BEGIN\b/i);
    if (withMatch) {
      const variableName = cleanupName(withMatch[1]);
      const tableName = recordVariables.get(normalizeKey(variableName));
      if (tableName) {
        const scope = {
          startLine: lineNumber + 1,
          endLine: lines.length - 1,
          variableName,
          tableName,
          endDepth: blockDepth
        };
        stack.push(scope);
        withScopes.push(scope);
      }
    }

    blockDepth += countBlockKeyword(line, "begin");
    blockDepth -= countBlockKeyword(line, "end");
    if (blockDepth < 0) {
      blockDepth = 0;
    }

    while (stack.length && blockDepth <= stack[stack.length - 1].endDepth) {
      stack.pop().endLine = lineNumber;
    }
  }
}

function addDefinition(definitions, uri, lineNumber, line, rawName, kind, detail) {
  const name = cleanupName(rawName);
  if (!name) {
    return;
  }

  const character = Math.max(0, line.indexOf(rawName.replace(/^"|"$/g, "")));
  const range = new vscode.Range(lineNumber, character, lineNumber, character + name.length);
  addDefinitionAtRange(definitions, uri, range, name, kind, detail);
}

function addDefinitionAtRange(definitions, uri, range, rawName, kind, detail) {
  const name = cleanupName(rawName);
  if (!name) {
    return;
  }

  definitions.push({
    key: normalizeKey(name),
    name,
    detail: detail || "",
    kind,
    uri,
    range
  });
}

function addObjectProcedureDefinitions(definitions, uri, lineNumber, line, procedureName, currentObject) {
  if (!currentObject || !procedureName) {
    return;
  }

  const objectKeys = [
    currentObject.id,
    currentObject.name,
    `${currentObject.type} ${currentObject.id}`,
    `${currentObject.type} ${currentObject.name}`
  ];

  for (const objectKey of objectKeys) {
    addDefinition(definitions, uri, lineNumber, line, `${objectKey}.${procedureName}`, vscode.SymbolKind.Function, currentObjectDetail(currentObject));
  }
}

function rangeForText(lineNumber, line, rawText, fallbackText) {
  const cleanedRaw = cleanupName(rawText);
  const cleanedFallback = cleanupName(fallbackText);
  let character = line.indexOf(rawText);
  if (character < 0) {
    character = line.indexOf(cleanedRaw);
  }
  if (character < 0) {
    character = line.indexOf(cleanedFallback);
  }
  character = Math.max(0, character);
  return new vscode.Range(lineNumber, character, lineNumber, character + cleanedFallback.length);
}

function collectReferences(references, uri, lineNumber, line, recordVariables, activeWithTable) {
  collectRecordTypeReferences(references, uri, lineNumber, line);
  collectDottedRecordReferences(references, uri, lineNumber, line, recordVariables);
  collectProcedureCallReferences(references, uri, lineNumber, line);

  for (const match of line.matchAll(IDENTIFIER)) {
    const text = match[0];
    const key = normalizeKey(text);
    if (!activeWithTable || text.length < 2 || KEYWORDS.has(key) || isDottedIdentifierPart(line, match.index, text.length)) {
      continue;
    }

    const range = new vscode.Range(lineNumber, match.index, lineNumber, match.index + text.length);
    references.push({
      key: normalizeKey(`${activeWithTable}.${text}`),
      location: new vscode.Location(uri, range)
    });
  }
}

function collectRecordTypeReferences(references, uri, lineNumber, line) {
  const recordTypePattern = /\bRecord\s+(?:temporary\s+)?("[^"]+"|[0-9]+|[A-Za-z_][A-Za-z0-9_ ]*?)(?:\s+temporary)?(?=\s*(?:;|\)|,|$))/gi;

  for (const match of line.matchAll(recordTypePattern)) {
    const rawTableName = match[1];
    const tableName = cleanupTypeName(rawTableName);
    const tableStart = match.index + match[0].indexOf(rawTableName);
    const range = new vscode.Range(lineNumber, tableStart, lineNumber, tableStart + rawTableName.length);
    references.push({
      key: normalizeKey(tableName),
      location: new vscode.Location(uri, range)
    });
  }
}

function collectDottedRecordReferences(references, uri, lineNumber, line, recordVariables) {
  const dottedPattern = /("([^"]+)"|[A-Za-z_][A-Za-z0-9_]*)\.("([^"]+)"|[A-Za-z_][A-Za-z0-9_]*)/g;

  for (const match of line.matchAll(dottedPattern)) {
    const variableName = cleanupName(match[2] || match[1]);
    const fieldName = cleanupName(match[4] || match[3]);
    const tableName = recordVariables.get(normalizeKey(variableName));
    if (!tableName) {
      continue;
    }

    const fieldStart = match.index + match[0].lastIndexOf(fieldName);
    const range = new vscode.Range(lineNumber, fieldStart, lineNumber, fieldStart + fieldName.length);
    references.push({
      key: normalizeKey(`${tableName}.${fieldName}`),
      location: new vscode.Location(uri, range)
    });
  }
}

function collectProcedureCallReferences(references, uri, lineNumber, line) {
  const callPattern = /(?<!\.)\b([A-Za-z_][A-Za-z0-9_]*)\b\s*(?=\(|;)|\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\b\s*(?=\(|;)/g;

  for (const match of line.matchAll(callPattern)) {
    const isDotted = Boolean(match[2]);
    const name = isDotted ? match[3] : match[1];
    const receiver = isDotted ? match[2] : undefined;
    const key = normalizeKey(name);
    if (!name || KEYWORDS.has(key) || /^(IF|EXIT|ERROR|MESSAGE|CLEAR)$/i.test(name)) {
      continue;
    }

    const nameStart = match.index + match[0].lastIndexOf(name);
    const range = new vscode.Range(lineNumber, nameStart, lineNumber, nameStart + name.length);
    references.push({
      key,
      location: new vscode.Location(uri, range)
    });

    if (receiver) {
      references.push({
        key: normalizeKey(`${receiver}.${name}`),
        location: new vscode.Location(uri, range)
      });
    }
  }
}

function isDottedIdentifierPart(line, start, length) {
  return line[start - 1] === "." || line[start + length] === ".";
}

function countBlockKeyword(line, keyword) {
  const scrubbed = line.replace(/'([^']|'')*'/g, "''");
  const pattern = new RegExp(`\\b${keyword}\\b`, "gi");
  return [...scrubbed.matchAll(pattern)].length;
}

function getLookupKeys(document, position) {
  const line = document.lineAt(position.line).text;
  const token = tokenAt(line, position.character);
  const keys = token ? [normalizeKey(token.text)] : [];
  const dotted = dottedNameAt(line, position.character);
  if (dotted) {
    keys.unshift(normalizeKey(dotted));
  }
  return [...new Set(keys)];
}

function tokenAt(line, character) {
  const tokenPattern = /"([^"]+)"|[A-Za-z_][A-Za-z0-9_]*|[0-9]+/g;

  for (const match of line.matchAll(tokenPattern)) {
    const rawText = match[0];
    const start = match.index;
    const end = start + rawText.length;
    if (character >= start && character <= end) {
      return {
        text: cleanupName(match[1] || rawText),
        start,
        end
      };
    }
  }

  return undefined;
}

function procedureCallAt(line, character) {
  const token = tokenAt(line, character);
  if (!token || KEYWORDS.has(normalizeKey(token.text))) {
    return undefined;
  }

  const before = line.slice(0, token.start).trimEnd();
  if (before.endsWith(".") || /\b(?:PROCEDURE|LOCAL|IF|THEN|ELSE|WITH|REPEAT|UNTIL)\s*$/i.test(before)) {
    return undefined;
  }

  const after = line.slice(token.end);
  return /^\s*(?:\(|;)/.test(after) ? token.text : undefined;
}

function recordTypeAt(line, character) {
  const recordTypePattern = /\bRecord\s+(?:temporary\s+)?("[^"]+"|[0-9]+|[A-Za-z_][A-Za-z0-9_ ]*?)(?:\s+temporary)?(?=\s*(?:;|\)|,|$))/gi;

  for (const match of line.matchAll(recordTypePattern)) {
    const rawTableName = match[1];
    const tableStart = match.index + match[0].indexOf(rawTableName);
    const tableEnd = tableStart + rawTableName.length;
    if (character >= tableStart && character <= tableEnd) {
      return cleanupTypeName(rawTableName);
    }
  }

  return undefined;
}

function dottedNameAt(line, character) {
  const dottedPattern = /(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*))+/g;
  for (const match of line.matchAll(dottedPattern)) {
    if (character >= match.index && character <= match.index + match[0].length) {
      return match[0];
    }
  }
  return undefined;
}

function dottedCompletionReceiverAt(line, character) {
  const before = line.slice(0, character);
  const match = before.match(/("([^"]+)"|[A-Za-z_][A-Za-z0-9_]*)\.(?:"[^"]*|[A-Za-z_][A-Za-z0-9_]*)?$/);
  if (!match) {
    return undefined;
  }

  return cleanupName(match[2] || match[1]);
}

function fieldNameFromDefinitionName(name, tableName) {
  const cleanName = cleanupName(name);
  const cleanTableName = cleanupName(tableName);
  if (cleanName.toLowerCase().startsWith(`${cleanTableName.toLowerCase()}.`)) {
    return cleanName.slice(cleanTableName.length + 1);
  }

  const dotIndex = cleanName.indexOf(".");
  return dotIndex >= 0 ? cleanName.slice(dotIndex + 1) : cleanName;
}

function registerRecordVariable(recordVariables, variableName, variableType) {
  const tableName = tableNameFromRecordType(variableType);
  if (!tableName) {
    return;
  }

  registerImplicitRecordVariable(recordVariables, variableName, tableName);
}

function registerProcedureParameters(recordVariables, objectVariables, signatureLine) {
  const open = signatureLine.indexOf("(");
  const close = signatureLine.lastIndexOf(")");
  if (open < 0 || close <= open) {
    return;
  }

  for (const parameter of splitParameterList(signatureLine.slice(open + 1, close))) {
    const match = parameter.match(/^(?:VAR\s+)?("?[^"@:;]+"?|[A-Za-z_][A-Za-z0-9_]*)@?[0-9]*\s*:\s*(.+)$/i);
    if (!match) {
      continue;
    }

    const variableName = cleanupName(match[1]);
    const variableType = match[2].trim();
    registerRecordVariable(recordVariables, variableName, variableType);
    registerObjectVariable(objectVariables, variableName, variableType);
  }
}

function splitParameterList(parameterText) {
  const parameters = [];
  let current = "";
  let bracketDepth = 0;

  for (const char of String(parameterText || "")) {
    if (char === "[") {
      bracketDepth += 1;
    } else if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (char === ";" && bracketDepth === 0) {
      if (current.trim()) {
        parameters.push(current.trim());
      }
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    parameters.push(current.trim());
  }

  return parameters;
}

function registerObjectVariable(objectVariables, variableName, variableType) {
  const objectName = objectNameFromVariableType(variableType);
  if (!objectName) {
    return;
  }

  objectVariables.set(normalizeKey(variableName), objectName);
}

function registerImplicitRecordVariable(recordVariables, variableName, tableName) {
  if (!cleanupName(variableName) || !cleanupName(tableName)) {
    return;
  }

  recordVariables.set(normalizeKey(variableName), tableName);
}

function tableNameFromRecordType(variableType) {
  const match = String(variableType || "").match(/^Record(?:\s+(?:temporary\s+)?(.+?))?(?:\s+temporary)?$/i);
  if (!match || !match[1]) {
    return undefined;
  }

  return cleanupTypeName(match[1]);
}

function objectNameFromVariableType(variableType) {
  const text = String(variableType || "").replace(/^ARRAY\s*\[[^\]]+\]\s+OF\s+/i, "").trim();
  const match = text.match(/^(Codeunit|Report|Page|Query|XMLport)\s+(.+)$/i);
  if (!match) {
    return undefined;
  }

  return cleanupTypeName(match[2]);
}

function variableSubtypeObjectType(dataType) {
  switch (String(dataType || "").toLowerCase()) {
    case "record":
      return "Table";
    case "page":
      return "Page";
    case "report":
      return "Report";
    case "codeunit":
      return "Codeunit";
    case "xmlport":
      return "XMLport";
    case "query":
      return "Query";
    case "form":
      return "Page";
    case "dataport":
      return "XMLport";
    default:
      return undefined;
  }
}

function normalizeNavObjectType(value) {
  switch (String(value || "").toLowerCase()) {
    case "record":
    case "table":
      return "Table";
    case "form":
    case "page":
      return "Page";
    case "dataport":
    case "xmlport":
      return "XMLport";
    case "codeunit":
      return "Codeunit";
    case "report":
      return "Report";
    case "query":
      return "Query";
    default:
      return cleanupTypeName(value);
  }
}

function selectedObjectLabel(navObject) {
  if (!navObject) {
    return "";
  }

  return `${navObject.type || ""} ${navObject.id || ""} ${navObject.name || ""}`.trim();
}

function resolveDottedRecordField(dotted, recordVariables) {
  if (!dotted || !recordVariables) {
    return undefined;
  }

  const parts = splitDottedName(dotted);
  if (parts.length !== 2) {
    return undefined;
  }

  const tableName = recordVariables.get(normalizeKey(parts[0]));
  if (!tableName) {
    return undefined;
  }

  return `${tableName}.${parts[1]}`;
}

function resolveDottedRecordProcedure(dotted, recordVariables) {
  if (!dotted || !recordVariables) {
    return undefined;
  }

  const parts = splitDottedName(dotted);
  if (parts.length !== 2) {
    return undefined;
  }

  const tableName = recordVariables.get(normalizeKey(parts[0]));
  if (!tableName) {
    return undefined;
  }

  return `Table ${tableName}.${parts[1]}`;
}

function resolveDottedObjectProcedure(dotted, objectVariables) {
  if (!dotted || !objectVariables) {
    return undefined;
  }

  const parts = splitDottedName(dotted);
  if (parts.length !== 2) {
    return undefined;
  }

  const objectName = objectVariables.get(normalizeKey(parts[0]));
  if (!objectName) {
    return undefined;
  }

  return `${objectName}.${parts[1]}`;
}

function splitDottedName(value) {
  const parts = [];
  const segmentPattern = /"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)/g;

  for (const match of String(value || "").matchAll(segmentPattern)) {
    parts.push(cleanupName(match[1] || match[2]));
  }

  return parts;
}

function cleanupTypeName(value) {
  return cleanupName(
    String(value || "")
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\s+temporary$/i, "")
      .trim()
  );
}

function definitionKeysAtPosition(analysis, position) {
  if (!analysis) {
    return [];
  }

  return analysis.definitions
    .filter((definition) => definition.range.contains(position))
    .map((definition) => definition.key);
}

function tableNameForWithScope(analysis, lineNumber) {
  if (!analysis?.withScopes) {
    return undefined;
  }

  const matchingScopes = analysis.withScopes.filter((scope) => lineNumber >= scope.startLine && lineNumber <= scope.endLine);
  if (!matchingScopes.length) {
    return undefined;
  }

  return matchingScopes[matchingScopes.length - 1].tableName;
}

function isNavDocument(document) {
  return document.languageId === "nav-obj" || /\.txt$/i.test(document.uri.fsPath);
}

function cleanupName(value) {
  return String(value || "").replace(/^"|"$/g, "").trim();
}

function normalizeKey(value) {
  return cleanupName(value).toLowerCase().replace(/\s+/g, " ");
}

function currentObjectDetail(object) {
  return object ? `${object.type} ${object.id} ${object.name}` : "";
}

function pushMap(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}

function removeMapItem(map, key, value) {
  const values = map.get(key);
  if (!values) {
    return;
  }

  const uri = value.uri.toString();
  const range = value.range;
  const filtered = values.filter(
    (item) =>
      item.uri.toString() !== uri ||
      item.range.start.line !== range.start.line ||
      item.range.start.character !== range.start.character
  );

  if (filtered.length) {
    map.set(key, filtered);
  } else {
    map.delete(key);
  }
}

function uniqueLocations(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const uri = item.uri.toString();
    const range = item.range;
    const key = `${uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }

  return result.sort((a, b) => {
    const fileCompare = a.uri.fsPath.localeCompare(b.uri.fsPath);
    if (fileCompare !== 0) {
      return fileCompare;
    }
    return a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
  });
}

const OBJECT_TYPE_ORDER = new Map([
  ["page", 0],
  ["table", 1],
  ["report", 2],
  ["codeunit", 3],
  ["query", 4],
  ["xmlport", 5],
  ["menusuite", 6]
]);

function sortNavObjects(objects) {
  return [...objects].sort((a, b) => {
    const typeCompare = objectTypeRank(a.type) - objectTypeRank(b.type);
    if (typeCompare !== 0) {
      return typeCompare;
    }

    const idCompare = Number(a.id) - Number(b.id);
    if (idCompare !== 0) {
      return idCompare;
    }

    return a.name.localeCompare(b.name);
  });
}

function dedupeNavObjects(objects) {
  const byKey = new Map();
  for (const object of objects) {
    const key = [
      String(object.type || "").toLowerCase(),
      String(object.id || "").toLowerCase(),
      object.uri?.toString() || ""
    ].join("|");
    if (!byKey.has(key)) {
      byKey.set(key, object);
    }
  }

  return [...byKey.values()];
}

function objectTypeRank(type) {
  return OBJECT_TYPE_ORDER.get(String(type || "").toLowerCase()) ?? 99;
}

function settleSoon(promise) {
  return Promise.race([
    promise.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 50))
  ]);
}

async function eachLimit(items, limit, iterator) {
  const workers = [];
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
    workers.push((async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await iterator(item);
      }
    })());
  }

  await Promise.all(workers);
}

module.exports = {
  NavWorkspaceIndex
};
