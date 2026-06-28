const vscode = require("vscode");
const http = require("http");
const https = require("https");
const path = require("path");
const { NavWorkspaceIndex } = require("./navIndex");
const { NavObjectNavigatorProvider, openNavObject } = require("./navObjectNavigator");

const DEFAULT_NAV_CONFIG = {
  include: [
    "src/**/*.txt"
  ],
  exclude: [
    "**/{node_modules,.git,out,dist,build,bin,obj,.vscode-test}/**",
    "**/backup/**",
    "**/archive/**"
  ],
  indexTxtFiles: true
};

const DEFAULT_NAV_CONFIG_FILE = ".navdevassistant.json";
const NAV_REPO_CONTEXT = "navDevAssistant.isNavRepo";
const OBJECT_NAVIGATOR_VERSION_FILTER_CONTEXT = "navDevAssistant.hasObjectNavigatorVersionFilter";
const NAV_SEMANTIC_TOKEN_TYPES = ["keyword", "property", "variable", "function", "type", "number", "string"];
const NAV_SEMANTIC_TOKEN_LEGEND = new vscode.SemanticTokensLegend(NAV_SEMANTIC_TOKEN_TYPES, []);
const BUILT_IN_RECORD_METHODS = [
  "ADDLINK",
  "ASCENDING",
  "CALCFIELDS",
  "CALCSUMS",
  "CHANGECOMPANY",
  "CLEARMARKS",
  "CONSISTENT",
  "COPY",
  "COPYFILTER",
  "COPYFILTERS",
  "COPYLINKS",
  "COUNT",
  "CURRENTCOMPANY",
  "CURRENTKEY",
  "DELETE",
  "DELETEALL",
  "DELETELINKS",
  "FIELDERROR",
  "FIELDCAPTION",
  "FIELDNAME",
  "FIELDNO",
  "FILTERGROUP",
  "FIND",
  "FINDFIRST",
  "FINDLAST",
  "FINDSET",
  "GET",
  "GETFILTER",
  "GETFILTERS",
  "GETPOSITION",
  "GETRANGEMAX",
  "GETRANGEMIN",
  "GETVIEW",
  "HASLINKS",
  "HASFILTER",
  "INIT",
  "INSERT",
  "ISEMPTY",
  "ISTEMPORARY",
  "LOCKTABLE",
  "MARK",
  "MARKEDONLY",
  "MODIFY",
  "MODIFYALL",
  "NEXT",
  "READPERMISSION",
  "RECORDID",
  "RENAME",
  "RESET",
  "SETAUTOCALCFIELDS",
  "SETASCENDING",
  "SETCURRENTKEY",
  "SETFILTER",
  "SETPERMISSIONFILTER",
  "SETPOSITION",
  "SETRANGE",
  "SETRECFILTER",
  "SETVIEW",
  "TABLECAPTION",
  "TABLENAME",
  "TESTFIELD",
  "TRANSFERFIELDS",
  "VALIDATE",
  "WRITEPERMISSION"
];
const BUILT_IN_OBJECT_METHODS = [
  "CLEAR",
  "GETRECORD",
  "LOOKUPMODE",
  "RUN",
  "RUNMODAL",
  "SAVEASEXCEL",
  "SAVEASHTML",
  "SAVEASPDF",
  "SAVEASWORD",
  "SAVEASXML",
  "SETRECORD",
  "SETSELECTIONFILTER",
  "SETTABLEVIEW",
  "UPDATE"
];
const FIELD_ARGUMENT_METHODS = new Set([
  "calcfields",
  "fieldcaption",
  "fielderror",
  "fieldname",
  "fieldno",
  "getfilter",
  "getrangemax",
  "getrangemin",
  "setautocalcfields",
  "setcurrentkey",
  "setfilter",
  "setrange",
  "testfield",
  "validate"
]);

const DEFAULT_FILE_ASSOCIATIONS = {
  "**/src/Table/*.txt": "nav-obj",
  "**/src/Page/*.txt": "nav-obj",
  "**/src/Codeunit/*.txt": "nav-obj",
  "**/src/Report/*.txt": "nav-obj",
  "**/src/XMLport/*.txt": "nav-obj",
  "**/src/Query/*.txt": "nav-obj"
};

function activate(context) {
  const navIndex = new NavWorkspaceIndex(context);
  navIndex.start();
  const analysisDiagnostics = vscode.languages.createDiagnosticCollection("NAV Analysis");
  const navRepoContext = watchNavRepoContext();
  const objectNavigator = new NavObjectNavigatorProvider(navIndex);
  const dependencyProvider = new NavDependencyProvider(navIndex);
  updateObjectNavigatorVersionFilterContext(objectNavigator);

  const explain = vscode.commands.registerCommand(
    "navDevAssistant.explain",
    () => explainActiveEditor(navIndex, "auto")
  );
  const explainSelection = vscode.commands.registerCommand(
    "navDevAssistant.explainSelection",
    () => explainActiveEditor(navIndex, "selection")
  );
  const explainFile = vscode.commands.registerCommand(
    "navDevAssistant.explainFile",
    () => explainActiveEditor(navIndex, "file")
  );
  const askAboutSelection = vscode.commands.registerCommand(
    "navDevAssistant.askAboutSelection",
    () => explainActiveEditor(navIndex, "question")
  );
  const activateWorkspace = vscode.commands.registerCommand(
    "navDevAssistant.activateWorkspace",
    async () => {
      const folder = await pickWorkspaceFolder();
      if (!folder) {
        return;
      }

      await initializeWorkspaceConfig(folder);
      await setActiveTxtDocumentLanguage(folder);
      await updateNavRepoContext();
      await navIndex.rebuild();
      vscode.window.showInformationMessage(
        "NAV Dev Assistant: activated for this workspace. NAV .txt object folders are enabled."
      );
    }
  );
  const initializeWorkspace = vscode.commands.registerCommand(
    "navDevAssistant.initializeWorkspace",
    async () => {
      const folder = await pickWorkspaceFolder();
      if (!folder) {
        return;
      }

      await initializeWorkspaceConfig(folder);
      await updateNavRepoContext();
      await navIndex.rebuild();
      vscode.window.showInformationMessage("NAV Dev Assistant: workspace config initialized and index rebuilt.");
    }
  );
  const focusObjectNavigator = vscode.commands.registerCommand(
    "navDevAssistant.focusObjectNavigator",
    async () => {
      await vscode.commands.executeCommand("workbench.view.extension.navDevAssistant");
      await vscode.commands.executeCommand("navDevAssistant.objectNavigator.focus");
    }
  );
  const refreshObjectNavigator = vscode.commands.registerCommand(
    "navDevAssistant.refreshObjectNavigator",
    () => objectNavigator.refresh()
  );
  const filterObjectNavigatorByVersion = vscode.commands.registerCommand(
    "navDevAssistant.filterObjectNavigatorByVersion",
    async () => {
      const versionTag = await vscode.window.showInputBox({
        title: "Filter NAV Object Navigator by Version List tag",
        prompt: "Enter a Version List tag. Leave empty to clear the filter.",
        placeHolder: "Example: NAVW111.00",
        value: objectNavigator.getVersionTagFilter()
      });
      if (versionTag === undefined) {
        return;
      }

      objectNavigator.setVersionTagFilter(versionTag);
      await updateObjectNavigatorVersionFilterContext(objectNavigator);
    }
  );
  const clearObjectNavigatorVersionFilter = vscode.commands.registerCommand(
    "navDevAssistant.clearObjectNavigatorVersionFilter",
    async () => {
      objectNavigator.clearVersionTagFilter();
      await updateObjectNavigatorVersionFilterContext(objectNavigator);
    }
  );
  const openObject = vscode.commands.registerCommand(
    "navDevAssistant.openObject",
    openNavObject
  );
  const rebuildIndex = vscode.commands.registerCommand(
    "navDevAssistant.rebuildIndex",
    async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "NAV Dev Assistant: rebuilding symbol index...",
          cancellable: true
        },
        (progress, token) => navIndex.rebuild(progress, token)
      );
      vscode.window.showInformationMessage("NAV Dev Assistant: symbol index rebuilt.");
    }
  );
  const clearIndexCache = vscode.commands.registerCommand(
    "navDevAssistant.clearIndexCache",
    async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "NAV Dev Assistant: clearing symbol cache...",
          cancellable: true
        },
        (progress, token) => navIndex.clearCacheAndRebuild(progress, token)
      );
      vscode.window.showInformationMessage("NAV Dev Assistant: symbol cache cleared and index rebuilt.");
    }
  );
  const whereIs = vscode.commands.registerCommand(
    "navDevAssistant.whereIs",
    () => whereIsNav(navIndex)
  );
  const findInCurrentDocument = vscode.commands.registerCommand(
    "navDevAssistant.findInCurrentDocument",
    findNavInCurrentDocument
  );
  const runParserDiagnostics = vscode.commands.registerCommand(
    "navDevAssistant.runParserDiagnostics",
    () => updateIndexDiagnostics(navIndex, analysisDiagnostics, "default")
  );
  const runParserUpgradeDiagnostics = vscode.commands.registerCommand(
    "navDevAssistant.runParserUpgradeDiagnostics",
    () => updateIndexDiagnostics(navIndex, analysisDiagnostics, "upgrade")
  );
  const refreshDependencies = vscode.commands.registerCommand(
    "navDevAssistant.refreshDependencies",
    () => dependencyProvider.refresh()
  );
  const filterDependencies = vscode.commands.registerCommand(
    "navDevAssistant.filterDependencies",
    async () => {
      const filterText = await vscode.window.showInputBox({
        title: "Filter NAV Dependencies",
        prompt: "Filter by source object, target object, target id/name, dependency kind, or source path. Leave empty to clear.",
        placeHolder: "Examples: Table 36, Codeunit 80, Sales Header, Permission",
        value: dependencyProvider.getFilterText()
      });
      if (filterText === undefined) {
        return;
      }

      dependencyProvider.setFilterText(filterText);
    }
  );
  const clearDependencyFilter = vscode.commands.registerCommand(
    "navDevAssistant.clearDependencyFilter",
    () => dependencyProvider.clearFilter()
  );
  const structuredSearch = vscode.commands.registerCommand(
    "navDevAssistant.structuredSearch",
    () => runStructuredSearch(navIndex)
  );

  const navSelector = [
    { scheme: "file", language: "nav-obj" }
  ];

  const definitionProvider = vscode.languages.registerDefinitionProvider(navSelector, {
    async provideDefinition(document, position) {
      try {
        const definitions = await navIndex.findDefinitions(document, position);
        return dedupeVsCodeLocations(definitions.map((definition) => new vscode.Location(definition.uri, definition.range)));
      } catch (error) {
        navIndex.output?.appendLine(`Definition provider failed: ${error.message}`);
        return [];
      }
    }
  });

  const referenceProvider = vscode.languages.registerReferenceProvider(navSelector, {
    async provideReferences(document, position, context) {
      try {
        const references = await navIndex.findReferences(document, position, context.includeDeclaration);
        return dedupeVsCodeLocations(references.map((reference) => new vscode.Location(reference.uri, reference.range)));
      } catch (error) {
        navIndex.output?.appendLine(`Reference provider failed: ${error.message}`);
        return [];
      }
    }
  });

  const completionProvider = vscode.languages.registerCompletionItemProvider(navSelector, {
    async provideCompletionItems(document, position) {
      try {
        return completionItemsAtPosition(navIndex, document, position);
      } catch (error) {
        navIndex.output?.appendLine(`Completion provider failed: ${error.message}`);
        return [];
      }
    }
  }, ".");

  const signatureHelpProvider = vscode.languages.registerSignatureHelpProvider(navSelector, {
    async provideSignatureHelp(document, position) {
      try {
        return signatureHelpAtPosition(navIndex, document, position);
      } catch (error) {
        navIndex.output?.appendLine(`Signature help failed: ${error.message}`);
        return undefined;
      }
    }
  }, "(", ",");

  const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider(navSelector, {
    async provideDocumentSymbols(document) {
      try {
        return documentSymbolsForDocument(navIndex, document);
      } catch (error) {
        navIndex.output?.appendLine(`Document symbol provider failed: ${error.message}`);
        return [];
      }
    }
  });

  const hoverProvider = vscode.languages.registerHoverProvider(navSelector, {
    async provideHover(document, position) {
      try {
        return hoverAtPosition(navIndex, document, position);
      } catch {
        return undefined;
      }
    }
  });

  const semanticTokensProvider = vscode.languages.registerDocumentSemanticTokensProvider(navSelector, {
    async provideDocumentSemanticTokens(document) {
      try {
        const semanticConfig = vscode.workspace.getConfiguration("navDevAssistant", document.uri);
        if (!semanticConfig.get("parser.semanticTokens.enabled", false)) {
          return new vscode.SemanticTokensBuilder(NAV_SEMANTIC_TOKEN_LEGEND).build();
        }

        return semanticTokensForDocument(navIndex, document);
      } catch (error) {
        navIndex.output?.appendLine(`Semantic token provider failed: ${error.message}`);
        return new vscode.SemanticTokensBuilder(NAV_SEMANTIC_TOKEN_LEGEND).build();
      }
    }
  }, NAV_SEMANTIC_TOKEN_LEGEND);

  const workspaceSymbolProvider = vscode.languages.registerWorkspaceSymbolProvider({
    async provideWorkspaceSymbols(query) {
      return navIndex.findWorkspaceSymbols(query);
    }
  });
  const objectNavigatorView = vscode.window.createTreeView("navDevAssistant.objectNavigator", {
    treeDataProvider: objectNavigator,
    showCollapseAll: true
  });
  const dependencyView = vscode.window.createTreeView("navDevAssistant.dependencies", {
    treeDataProvider: dependencyProvider,
    showCollapseAll: true
  });
  const dependencySelection = objectNavigatorView.onDidChangeSelection((event) => {
    const selected = event.selection?.[0];
    dependencyProvider.setSelectedObject(selected?.kind === "object" ? selected.object : undefined);
  });
  const updateObjectPropertiesOnSave = vscode.workspace.onWillSaveTextDocument((event) => {
    const edits = navObjectDateTimeEdits(event.document);
    if (edits.length) {
      event.waitUntil(Promise.resolve(edits));
    }
  });
  const onSaveDiagnostics = vscode.workspace.onDidSaveTextDocument((document) => {
    scheduleIndexDiagnosticsForDocument(navIndex, analysisDiagnostics, document);
  });

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = "$(sparkle) /explain NAV";
  statusBar.tooltip = "Explain the current NAV, C/AL, or AL file";
  statusBar.command = "navDevAssistant.explain";
  statusBar.show();
  const indexStatusSubscription = navIndex.onDidChangeStatus((status) => {
    if (status.busy) {
      statusBar.text = "$(sync~spin) NAV index";
      statusBar.tooltip = `NAV Dev Assistant: ${status.label}`;
      statusBar.command = "navDevAssistant.rebuildIndex";
    } else {
      statusBar.text = "$(sparkle) /explain NAV";
      statusBar.tooltip = "Explain the current NAV, C/AL, or AL file";
      statusBar.command = "navDevAssistant.explain";
    }
  });

  context.subscriptions.push(
    explain,
    explainSelection,
    explainFile,
    askAboutSelection,
    activateWorkspace,
    initializeWorkspace,
    navRepoContext,
    focusObjectNavigator,
    refreshObjectNavigator,
    filterObjectNavigatorByVersion,
    clearObjectNavigatorVersionFilter,
    openObject,
    rebuildIndex,
    clearIndexCache,
    whereIs,
    findInCurrentDocument,
    runParserDiagnostics,
    runParserUpgradeDiagnostics,
    refreshDependencies,
    filterDependencies,
    clearDependencyFilter,
    structuredSearch,
    definitionProvider,
    referenceProvider,
    completionProvider,
    signatureHelpProvider,
    documentSymbolProvider,
    hoverProvider,
    semanticTokensProvider,
    workspaceSymbolProvider,
    analysisDiagnostics,
    objectNavigator,
    objectNavigatorView,
    dependencyProvider,
    dependencyView,
    dependencySelection,
    updateObjectPropertiesOnSave,
    onSaveDiagnostics,
    indexStatusSubscription,
    statusBar
  );
}

function watchNavRepoContext() {
  updateNavRepoContext();

  const configWatcher = vscode.workspace.createFileSystemWatcher(`**/${getNavConfigFileName()}`);
  const update = () => updateNavRepoContext();
  const refresh = () => {
    update();
  };
  configWatcher.onDidCreate(refresh);
  configWatcher.onDidChange(refresh);
  configWatcher.onDidDelete(refresh);

  const workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders(update);
  const configurationWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("navDevAssistant.configFileName")) {
      updateNavRepoContext();
    }
  });

  const disposable = vscode.Disposable.from(configWatcher, workspaceWatcher, configurationWatcher);
  return disposable;
}

async function updateNavRepoContext() {
  const folders = vscode.workspace.workspaceFolders || [];
  const markerChecks = await Promise.all(
    folders.map((folder) => fileExists(vscode.Uri.joinPath(folder.uri, getNavConfigFileName(folder.uri))))
  );
  const hasNavRepo = markerChecks.some(Boolean);

  await vscode.commands.executeCommand("setContext", NAV_REPO_CONTEXT, hasNavRepo);
}

function getNavConfigFileName(scope) {
  return vscode.workspace.getConfiguration("navDevAssistant", scope).get("configFileName", DEFAULT_NAV_CONFIG_FILE);
}

async function updateObjectNavigatorVersionFilterContext(objectNavigator) {
  await vscode.commands.executeCommand(
    "setContext",
    OBJECT_NAVIGATOR_VERSION_FILTER_CONTEXT,
    Boolean(objectNavigator.getVersionTagFilter())
  );
}

async function pickWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    vscode.window.showErrorMessage("NAV Dev Assistant: open a workspace folder first.");
    return undefined;
  }

  if (folders.length === 1) {
    return folders[0];
  }

  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { title: "Initialize NAV config in which workspace folder?" }
  );
  return picked?.folder;
}

async function initializeWorkspaceConfig(folder, options = {}) {
  const config = vscode.workspace.getConfiguration("navDevAssistant", folder.uri);
  const configFileName = getNavConfigFileName(folder.uri);
  const navConfigUri = vscode.Uri.joinPath(folder.uri, configFileName);

  if (await fileExists(navConfigUri)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${configFileName} already exists in ${folder.name}. Replace it with the default NAV config?`,
      { modal: true },
      "Keep Existing",
      "Replace"
    );
    if (overwrite === "Replace") {
      await writeJsonFile(navConfigUri, DEFAULT_NAV_CONFIG);
    }
  } else {
    await writeJsonFile(navConfigUri, DEFAULT_NAV_CONFIG);
  }

  const filesConfig = vscode.workspace.getConfiguration("files", folder.uri);
  const currentAssociations = filesConfig.get("associations", {});
  const fileAssociations = options.fileAssociations || DEFAULT_FILE_ASSOCIATIONS;
  await filesConfig.update(
    "associations",
    {
      ...currentAssociations,
      ...fileAssociations
    },
    vscode.ConfigurationTarget.WorkspaceFolder
  );

  await config.update("provider", "local", vscode.ConfigurationTarget.WorkspaceFolder);
  await config.update("local.endpoint", config.get("local.endpoint") || "http://127.0.0.1:1234/v1/chat/completions", vscode.ConfigurationTarget.WorkspaceFolder);
  await config.update("local.model", config.get("local.model") || "qwen2.5-coder-3b-instruct-mlx", vscode.ConfigurationTarget.WorkspaceFolder);
  await config.update("indexConcurrency", config.get("indexConcurrency") || 4, vscode.ConfigurationTarget.WorkspaceFolder);
  await config.update("maxIndexFileBytes", config.get("maxIndexFileBytes") || 2097152, vscode.ConfigurationTarget.WorkspaceFolder);
  await config.update("maxOutputTokens", config.get("maxOutputTokens") || 700, vscode.ConfigurationTarget.WorkspaceFolder);
}

async function setActiveTxtDocumentLanguage(folder) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    return;
  }

  if (!isUriInsideFolder(editor.document.uri, folder.uri) || !/\.txt$/i.test(editor.document.uri.fsPath)) {
    return;
  }

  if (!hasNavObjectHeader(editor.document.getText())) {
    return;
  }

  await vscode.languages.setTextDocumentLanguage(editor.document, "nav-obj");
}

function hasNavObjectHeader(text) {
  return /^\uFEFF?\s*OBJECT\s+(Table|Form|Codeunit|Dataport|Report|XMLport|MenuSuite|Query|Page)\s+[0-9]+\s+/im.test(String(text || ""));
}

function navObjectDateTimeEdits(document) {
  const config = vscode.workspace.getConfiguration("navDevAssistant", document.uri);
  if (!config.get("objectProperties.updateDateTimeOnSave", false) || !isNavTextDocument(document)) {
    return [];
  }

  const now = new Date();
  const dateValue = formatNavObjectDate(now);
  const timeValue = formatNavObjectTime(now);
  const objectPropertiesRange = findObjectPropertiesLineRange(document);
  if (!objectPropertiesRange) {
    return [];
  }

  const edits = [];
  for (let lineNumber = objectPropertiesRange.startLine; lineNumber <= objectPropertiesRange.endLine; lineNumber += 1) {
    const line = document.lineAt(lineNumber).text;
    const dateMatch = /^(\s*Date=)([^;]*)(;\s*)$/i.exec(line);
    if (dateMatch && dateMatch[2] !== dateValue) {
      edits.push(vscode.TextEdit.replace(
        new vscode.Range(lineNumber, 0, lineNumber, line.length),
        `${dateMatch[1]}${dateValue}${dateMatch[3]}`
      ));
      continue;
    }

    const timeMatch = /^(\s*Time=)([^;]*)(;\s*)$/i.exec(line);
    if (timeMatch && timeMatch[2] !== timeValue) {
      edits.push(vscode.TextEdit.replace(
        new vscode.Range(lineNumber, 0, lineNumber, line.length),
        `${timeMatch[1]}${timeValue}${timeMatch[3]}`
      ));
    }
  }

  return edits;
}

function findObjectPropertiesLineRange(document) {
  let sectionLine = -1;
  for (let lineNumber = 0; lineNumber < Math.min(document.lineCount, 200); lineNumber += 1) {
    if (/^\s*OBJECT-PROPERTIES\b/i.test(document.lineAt(lineNumber).text)) {
      sectionLine = lineNumber;
      break;
    }
  }

  if (sectionLine < 0) {
    return undefined;
  }

  let openBraceLine = -1;
  for (let lineNumber = sectionLine + 1; lineNumber < Math.min(document.lineCount, sectionLine + 10); lineNumber += 1) {
    if (/^\s*\{\s*$/.test(document.lineAt(lineNumber).text)) {
      openBraceLine = lineNumber;
      break;
    }
  }

  if (openBraceLine < 0) {
    return undefined;
  }

  for (let lineNumber = openBraceLine + 1; lineNumber < Math.min(document.lineCount, openBraceLine + 40); lineNumber += 1) {
    if (/^\s*}\s*$/.test(document.lineAt(lineNumber).text)) {
      return { startLine: openBraceLine + 1, endLine: lineNumber - 1 };
    }
  }

  return undefined;
}

function formatNavObjectDate(value) {
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const year = String(value.getFullYear() % 100).padStart(2, "0");
  return `${month}/${day}/${year}`;
}

function formatNavObjectTime(value) {
  let hours = value.getHours();
  const suffix = hours >= 12 ? "PM" : "AM";
  hours %= 12;
  if (hours === 0) {
    hours = 12;
  }

  const minutes = String(value.getMinutes()).padStart(2, "0");
  const seconds = String(value.getSeconds()).padStart(2, "0");
  return `${String(hours).padStart(2, "0")}:${minutes}:${seconds} ${suffix}`;
}

function isUriInsideFolder(uri, folderUri) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  return workspaceFolder?.uri.toString() === folderUri.toString();
}

async function fileExists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonFile(uri, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await vscode.workspace.fs.writeFile(uri, bytes);
}

class NavDependencyProvider {
  constructor(navIndex) {
    this.navIndex = navIndex;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.dependencies = [];
    this.objects = [];
    this.groups = [];
    this.filterText = "";
    this.selectedObject = undefined;
    this.loaded = false;
  }

  refresh() {
    this.load().catch((error) => {
      vscode.window.showErrorMessage(`NAV Dev Assistant: dependency refresh failed: ${error.message}`);
    });
  }

  async load() {
    const dependencies = await this.navIndex.getDependencies();
    this.dependencies = dependencies;
    this.objects = await this.navIndex.getObjects();
    this.loaded = true;
    this.applyViewState();
    vscode.window.showInformationMessage(`NAV Dev Assistant: ${dependencies.length} dependency edge(s) loaded from workspace analysis.`);
  }

  getFilterText() {
    return this.filterText;
  }

  setFilterText(value) {
    this.filterText = String(value || "").trim();
    this.applyViewState();
  }

  clearFilter() {
    this.setFilterText("");
  }

  setSelectedObject(navObject) {
    this.selectedObject = navObject;
    if (navObject && !this.loaded) {
      this.refresh();
      return;
    }
    this.applyViewState();
  }

  applyViewState() {
    if (!this.selectedObject) {
      this.groups = [];
      this._onDidChangeTreeData.fire();
      return;
    }

    const filter = this.filterText.toLowerCase();
    const dependsOn = [];
    const usedBy = [];

    for (const dependency of this.dependencies) {
      const matchesSelectedSource = dependencySourceMatchesObject(dependency, this.selectedObject);
      const matchesSelectedTarget = dependencyTargetMatchesObject(dependency, this.selectedObject);
      if (!matchesSelectedSource && !matchesSelectedTarget) {
        continue;
      }

      const searchable = dependencySearchText(
        dependency,
        this.selectedObject,
        resolveDependencyTargetObject(dependency, this.objects)
      );
      if (filter && !searchable.includes(filter)) {
        continue;
      }

      if (matchesSelectedSource) {
        dependsOn.push(dependency);
      }
      if (matchesSelectedTarget) {
        usedBy.push(dependency);
      }
    }

    this.groups = [
      {
        kind: "group",
        groupKind: "dependsOn",
        label: "Depends On",
        items: dependsOn.sort(compareDependency)
      },
      {
        kind: "group",
        groupKind: "usedBy",
        label: "Used By",
        items: usedBy.sort(compareDependency)
      }
    ];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    if (element.kind === "group") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${element.items.length} edge(s)`;
      item.tooltip = `${selectedObjectLabel(this.selectedObject)}${this.filterText ? `\nFilter: ${this.filterText}` : ""}`;
      item.iconPath = new vscode.ThemeIcon(element.groupKind === "usedBy" ? "arrow-left" : "arrow-right");
      return item;
    }

    const item = new vscode.TreeItem(
      element.groupKind === "usedBy"
        ? element.sourceObject
        : element.targetLabel,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = element.groupKind === "usedBy"
      ? `${element.dependencyKind} -> ${element.targetLabel}`
      : element.dependencyKind;
    item.tooltip = `${element.sourceObject}\n${element.targetLabel}\n${element.dependencyKind}\n${element.sourcePath}`;
    item.iconPath = new vscode.ThemeIcon("references");
    item.command = {
      command: "vscode.open",
      title: "Open Dependency Source",
      arguments: [element.uri, { selection: element.range }]
    };
    return item;
  }

  getChildren(element) {
    if (!element) {
      return this.groups;
    }

    return element.items.map((dependency) => {
      return {
        kind: "dependency",
        sourceObject: dependency.sourceObject,
        targetType: dependency.targetType,
        targetIdOrName: dependency.targetIdOrName,
        targetLabel: dependencyTargetLabel(dependency, resolveDependencyTargetObject(dependency, this.objects)),
        dependencyKind: dependency.kind,
        groupKind: element.groupKind,
        sourcePath: dependency.sourcePath || dependency.uri?.fsPath || "",
        uri: dependency.uri,
        range: dependency.range
      };
    });
  }

  dispose() {
    this._onDidChangeTreeData.dispose();
  }
}

function compareDependency(a, b) {
  return `${a.sourceObject} ${dependencyTargetLabel(a)} ${a.kind}`.localeCompare(
    `${b.sourceObject} ${dependencyTargetLabel(b)} ${b.kind}`,
    undefined,
    { sensitivity: "base" }
  );
}

function dependencyTargetLabel(dependency, targetObject) {
  if (targetObject) {
    return selectedObjectLabel(targetObject);
  }

  return `${dependency.targetType || "Object"} ${dependency.targetIdOrName || ""}`.trim();
}

function dependencySearchText(dependency, selectedObject, targetObject) {
  return [
    selectedObjectLabel(selectedObject),
    dependency.sourceObject,
    dependencyTargetLabel(dependency, targetObject),
    dependency.targetType,
    dependency.targetIdOrName,
    dependency.kind,
    dependency.sourcePath
  ].join(" ").toLowerCase();
}

function dependencySourceMatchesObject(dependency, navObject) {
  return normalizeDependencyKey(dependency.sourceObject) === normalizeDependencyKey(selectedObjectLabel(navObject));
}

function dependencyTargetMatchesObject(dependency, navObject) {
  if (!navObject) {
    return false;
  }

  const targetType = normalizeDependencyKey(dependency.targetType);
  const objectType = normalizeDependencyKey(navObject.type);
  if (targetType && objectType && targetType !== objectType) {
    return false;
  }

  const target = normalizeDependencyKey(dependency.targetIdOrName);
  return target === normalizeDependencyKey(navObject.id)
    || target === normalizeDependencyKey(navObject.name)
    || target === normalizeDependencyKey(`${navObject.id} ${navObject.name}`)
    || target === normalizeDependencyKey(selectedObjectLabel(navObject));
}

function resolveDependencyTargetObject(dependency, objects) {
  const targetType = normalizeDependencyKey(dependency.targetType);
  const target = normalizeDependencyKey(dependency.targetIdOrName);
  if (!targetType || !target) {
    return undefined;
  }

  return (objects || []).find((object) => {
    if (normalizeDependencyKey(object.type) !== targetType) {
      return false;
    }

    return target === normalizeDependencyKey(object.id)
      || target === normalizeDependencyKey(object.name)
      || target === normalizeDependencyKey(`${object.id} ${object.name}`)
      || target === normalizeDependencyKey(selectedObjectLabel(object));
  });
}

function selectedObjectLabel(navObject) {
  if (!navObject) {
    return "";
  }

  return `${navObject.type || ""} ${navObject.id || ""} ${navObject.name || ""}`.trim();
}

function normalizeDependencyKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function findNavInCurrentDocument() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("NAV Dev Assistant: open a file first.");
    return;
  }

  const target = getSelectedTextOrWord(editor);
  if (!target?.text) {
    vscode.window.showErrorMessage("NAV Dev Assistant: select text or place the cursor on a word.");
    return;
  }

  if (target.range) {
    editor.selection = new vscode.Selection(target.range.start, target.range.end);
    editor.revealRange(target.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  await vscode.commands.executeCommand("editor.actions.findWithArgs", {
    searchString: target.text,
    isRegex: false,
    matchCase: false,
    wholeWord: false,
    findInSelection: false
  });
}

function getSelectedTextOrWord(editor) {
  const selected = editor.document.getText(editor.selection);
  if (selected) {
    return { text: selected.trim(), range: editor.selection };
  }

  const range = editor.document.getWordRangeAtPosition(
    editor.selection.active,
    /"[^"\r\n]+"|[A-Za-z_][A-Za-z0-9_]*/
  );
  return range ? { text: editor.document.getText(range).trim(), range } : undefined;
}

async function whereIsNav(navIndex) {
  const editor = vscode.window.activeTextEditor;
  const selected = editor ? editor.document.getText(editor.selection).trim() : "";
  const query = await vscode.window.showInputBox({
    title: "NAV: Where Is",
    prompt: "Find text in indexed NAV source files",
    value: selected && selected.length <= 120 ? selected.replace(/^"|"$/g, "") : "",
    ignoreFocusOut: true
  });

  if (!query) {
    return;
  }

  const maxResults = 500;
  const results = [];
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `NAV: where is ${query}`,
      cancellable: true
    },
    async (progress, token) => {
      const uris = await navIndex.getIndexedSourceUris(token);
      const needle = query.toLowerCase();
      let checked = 0;

      for (const uri of uris) {
        if (token.isCancellationRequested || results.length >= maxResults) {
          break;
        }

        checked += 1;
        if (checked % 100 === 0) {
          progress.report({ message: `${checked}/${uris.length} files, ${results.length} hit(s)` });
        }

        const document = await openNavSearchDocument(uri);
        if (!document) {
          continue;
        }

        for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
          const text = document.lineAt(lineNumber).text;
          const character = text.toLowerCase().indexOf(needle);
          if (character < 0) {
            continue;
          }

          results.push({
            uri,
            file: navSearchDisplayName(uri),
            line: lineNumber + 1,
            character: character + 1,
            text: text.trim().replace(/\s+/g, " ")
          });

          if (results.length >= maxResults) {
            break;
          }
        }
      }
    }
  );

  await showWhereIsResults(query, results, maxResults);
}

async function openNavSearchDocument(uri) {
  try {
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
    return openDocument || await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined;
  }
}

function navSearchDisplayName(uri) {
  const parts = uri.fsPath.split(/[\\/]/).filter(Boolean);
  const file = parts[parts.length - 1] || uri.fsPath;
  const parent = parts[parts.length - 2] || "";
  return parent && isNavObjectFolder(parent) ? `${parent} ${file}` : file;
}

function isNavObjectFolder(value) {
  return /^(Table|Page|Report|Codeunit|Query|XMLport|MenuSuite|Form|Dataport)$/i.test(value);
}

function fieldNameInsertText(fieldName) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName)
    ? fieldName
    : `"${String(fieldName).replace(/"/g, '""')}"`;
}

async function completionItemsAtPosition(navIndex, document, position) {
  const receiver = memberReceiverForCompletion(document, position);
  if (receiver) {
    const objectDocument = await getIndexedObjectDocument(navIndex, document);
    if (!objectDocument) {
      return [];
    }

    let targetType;
    let targetDocument;
    let targetObject;

    if (/^(rec|xrec)$/i.test(receiver) && String(objectDocument.objectType || "").toLowerCase() === "table") {
      targetType = "Table";
      targetDocument = objectDocument;
      targetObject = objectIdentity(objectDocument);
    } else {
      const variable = findVisibleVariable(objectDocument, receiver, position.line + 1);
      if (!variable) {
        return [];
      }

      targetType = variableSubtypeObjectType(variable.dataType);
      if (!targetType) {
        return [];
      }

      targetObject = await resolveVariableSubtypeObject(navIndex, document, variable);
      if (targetObject?.uri) {
        targetDocument = await getIndexedObjectDocumentByUri(navIndex, targetObject.uri);
      }
    }

    const items = buildParserMemberCompletionItems(targetType, targetObject, targetDocument);
    if (items.length) {
      return items;
    }
  }

  const fields = await navIndex.findRecordFieldCompletions(document, position);
  return fields.map((field) => {
    const item = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Field);
    item.insertText = fieldNameInsertText(field.name);
    item.detail = field.detail;
    item.documentation = new vscode.MarkdownString(`NAV table field \`${field.name}\``);
    return item;
  });
}

function memberReceiverForCompletion(document, position) {
  const line = document.lineAt(position.line).text.slice(0, position.character);
  const match = /(?:^|[^A-Za-z0-9_"])(?<receiver>"[^"\r\n]+"|[A-Za-z_][A-Za-z0-9_]*)\.\s*(?:"[^"\r\n]*|[A-Za-z_][A-Za-z0-9_]*)?$/.exec(line);
  return match?.groups?.receiver?.replace(/^"|"$/g, "").trim();
}

function buildParserMemberCompletionItems(targetType, targetObject, targetDocument) {
  const items = new Map();
  const normalizedType = String(targetType || "").toLowerCase();

  if (normalizedType === "table") {
    for (const field of targetDocument?.fields || []) {
      addCompletionItem(items, field.name, vscode.CompletionItemKind.Field, {
        insertText: fieldNameInsertText(field.name),
        detail: targetObjectDisplay(targetObject, targetDocument, "field"),
        documentation: `NAV table field ${field.name}${field.dataType ? ` : ${field.dataType}` : ""}`,
        sortPrefix: "1"
      });
    }

    for (const block of nonLocalProcedures(targetDocument)) {
      addCompletionItem(items, block.name, vscode.CompletionItemKind.Method, {
        detail: targetObjectDisplay(targetObject, targetDocument, "procedure"),
        documentation: block.signature || `NAV table procedure ${block.name}`,
        sortPrefix: "2"
      });
    }

    for (const method of BUILT_IN_RECORD_METHODS) {
      addCompletionItem(items, method, vscode.CompletionItemKind.Method, {
        detail: "Built-in C/AL record method",
        documentation: `Built-in C/AL record method ${method}`,
        sortPrefix: "3"
      });
    }
  } else if (normalizedType === "codeunit") {
    for (const block of nonLocalProcedures(targetDocument)) {
      addCompletionItem(items, block.name, vscode.CompletionItemKind.Method, {
        detail: targetObjectDisplay(targetObject, targetDocument, "procedure"),
        documentation: block.signature || `NAV codeunit procedure ${block.name}`,
        sortPrefix: "1"
      });
    }
  }

  if (normalizedType && normalizedType !== "table") {
    for (const method of BUILT_IN_OBJECT_METHODS) {
      addCompletionItem(items, method, vscode.CompletionItemKind.Method, {
        detail: "Built-in C/AL object method",
        documentation: `Built-in C/AL object method ${method}`,
        sortPrefix: "3"
      });
    }
  }

  return [...items.values()];
}

function addCompletionItem(items, label, kind, options = {}) {
  const key = String(label || "").toLowerCase();
  if (!label || items.has(key)) {
    return;
  }

  const item = new vscode.CompletionItem(label, kind);
  item.insertText = options.insertText || label;
  item.detail = options.detail;
  item.documentation = options.documentation;
  item.sortText = `${options.sortPrefix || "9"}_${label}`;
  items.set(key, item);
}

function nonLocalProcedures(objectDocument) {
  return (objectDocument?.codeBlocks || [])
    .filter((block) =>
      /^(procedure|trigger)$/i.test(String(block.kind || "")) &&
      !block.isLocal &&
      block.name);
}

function targetObjectDisplay(targetObject, targetDocument, suffix) {
  const objectType = targetObject?.objectType || targetDocument?.objectType || "Object";
  const objectId = targetObject?.objectId ?? targetDocument?.objectId;
  const objectName = targetObject?.objectName || targetDocument?.objectName || "";
  return [
    objectType,
    objectId !== undefined && objectId !== null ? objectId : undefined,
    objectName || undefined,
    suffix || undefined
  ].filter((part) => part !== undefined && part !== "").join(" ");
}

function objectIdentity(objectDocument) {
  return {
    objectType: objectDocument.objectType,
    objectId: objectDocument.objectId,
    objectName: objectDocument.objectName,
    uri: objectDocument.uri
  };
}

async function showWhereIsResults(query, results, maxResults) {
  const content = [
    `# NAV Where Is: ${query}`,
    "",
    `${results.length}${results.length >= maxResults ? "+" : ""} result(s)`,
    "",
    ...results.map((result) => `- [\`${result.file}:${result.line}\`](${vscodeFileLink(result.uri, result.line, result.character)}) ${result.text}`),
    ""
  ].join("\n");

  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content
  });
  await vscode.window.showTextDocument(document, {
    preview: true,
    viewColumn: vscode.ViewColumn.Active
  });
}

async function explainActiveEditor(navIndex, mode) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("NAV Dev Assistant: open a file first.");
    return;
  }

  const document = editor.document;
  const config = getConfig();
  const target = getExplainTarget(editor, mode);

  if (!target.text.trim()) {
    vscode.window.showErrorMessage("NAV Dev Assistant: select some code first.");
    return;
  }

  const userQuestion =
    mode === "question"
      ? await vscode.window.showInputBox({
          title: "/explain NAV",
          prompt: "What would you like to know about this selected code?",
          ignoreFocusOut: true
        })
      : undefined;

  if (mode === "question" && !userQuestion) {
    return;
  }

  const input = trimToLimit(target.text, config.maxInputCharacters);
  const callerContext = await getKnownCallers(navIndex, document, input.text);
  const symbolContext = await buildExplainSymbolContext(navIndex, document, input.text, target.range);
  const localExplanation = mode !== "question" ? explainSimpleNavProcedure(input.text) : undefined;
  if (localExplanation) {
    await showMarkdownAnswer(localExplanation, {
      provider: "local-rule",
      model: "simple-nav-procedure",
      source: target.source,
      fileName: document.fileName,
      callersMarkdown: callerContext.markdown
    });
    return;
  }

  const prompt = buildPrompt({
    fileName: document.fileName,
    languageId: document.languageId,
    mode,
    source: target.source,
    question: userQuestion,
    code: input.text,
    callerContext: callerContext.prompt,
    symbolContext,
    glossary: await loadWorkspaceGlossary(document.uri),
    wasTruncated: input.wasTruncated
  });

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "NAV Dev Assistant: asking the model...",
      cancellable: false
    },
    async () => {
      try {
        const answer = await callChatCompletion(config, prompt);
        await showMarkdownAnswer(answer, {
          provider: config.provider,
          model: config.model,
          source: target.source,
          fileName: document.fileName,
          callersMarkdown: callerContext.markdown
        });
      } catch (error) {
        vscode.window.showErrorMessage(`NAV Dev Assistant: ${error.message}`);
      }
    }
  );
}

function getExplainTarget(editor, mode) {
  const document = editor.document;
  const selectedText = document.getText(editor.selection);
  const hasSelection = Boolean(selectedText.trim());

  if (mode === "selection" || mode === "question" || (mode === "auto" && hasSelection)) {
    if (mode !== "question" && isSingleIdentifierSelection(selectedText)) {
      const block = getCurrentNavBlock(document, editor.selection.active.line);
      if (block?.text && blockContainsProcedureName(block.text, selectedText.trim())) {
        return { text: block.text, source: "selected procedure name expanded to current block", range: block.range };
      }
    }
    return { text: selectedText, source: "selection", range: editor.selection };
  }

  if (mode === "auto") {
    const block = getCurrentNavBlock(document, editor.selection.active.line);
    if (block?.text) {
      return { text: block.text, source: block.source, range: block.range };
    }
  }

  return { text: document.getText(), source: "file", range: new vscode.Range(0, 0, document.lineCount, 0) };
}

function getCurrentNavBlock(document, activeLine) {
  const lines = [];
  for (let index = 0; index < document.lineCount; index += 1) {
    lines.push(document.lineAt(index).text);
  }

  const start = findNavBlockStart(lines, activeLine);
  if (start === undefined) {
    return undefined;
  }

  const end = findNavBlockEnd(lines, start);
  const context = getNavObjectContext(lines);
  const block = lines.slice(start, end + 1).join("\n");
  return {
    text: context ? `${context}\n\n${block}` : block,
    source: context ? "current block with object context" : "current block",
    range: new vscode.Range(start, 0, end, lines[end]?.length || 0)
  };
}

function isSingleIdentifierSelection(text) {
  return /^"?[A-Za-z_][A-Za-z0-9_]*"?$/.test(text.trim());
}

function blockContainsProcedureName(blockText, selectedText) {
  const name = cleanupNavName(selectedText);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:LOCAL\\s+)?PROCEDURE\\s+"?${escapedName}"?(?:@?[0-9]*)?\\s*\\(`, "im").test(blockText);
}

async function getKnownCallers(navIndex, document, code) {
  const procedureName = getNavProcedureName(code);
  if (!procedureName) {
    return { prompt: "", markdown: "" };
  }

  const references = await navIndex.findReferencesByKey(procedureName);
  const callers = [];
  const seen = new Set();

  for (const reference of references) {
    const key = `${reference.uri.toString()}:${reference.range.start.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const lineText = await getLineText(reference.uri, reference.range.start.line, document);
    if (!lineText || isProcedureDeclarationLine(lineText, procedureName)) {
      continue;
    }

    callers.push({
      file: reference.uri.fsPath.split(/[\\/]/).pop(),
      uri: reference.uri,
      line: reference.range.start.line + 1,
      character: reference.range.start.character + 1,
      text: lineText.trim().replace(/\s+/g, " ")
    });

    if (callers.length >= 12) {
      break;
    }
  }

  if (!callers.length) {
    return {
      prompt: `Known callers from workspace index for ${procedureName}: none found.`,
      markdown: `## Known Callers\n\nNo callers found in the current index for \`${procedureName}\`.\n`
    };
  }

  const rows = callers.map((caller) => `- ${caller.file}:${caller.line}: ${caller.text}`);
  return {
    prompt: `Known callers from workspace index for ${procedureName}:\n${rows.join("\n")}`,
    markdown: [
      "## Known Callers",
      "",
      ...callers.map((caller) => `- [\`${caller.file}:${caller.line}\`](${vscodeFileLink(caller.uri, caller.line, caller.character)}) ${caller.text}`),
      ""
    ].join("\n")
  };
}

function vscodeFileLink(uri, line, character) {
  const fsPath = uri.fsPath.replace(/\\/g, "/");
  const normalizedPath = fsPath.startsWith("/") ? fsPath : `/${fsPath}`;
  return `vscode://file${encodeURI(normalizedPath)}:${line}:${character}`;
}

function getNavProcedureName(code) {
  const cleanCode = stripNavObjectContext(code);
  const signature = cleanCode.match(/^\s*(?:LOCAL\s+)?PROCEDURE\s+("?[^"(@]+"?|[A-Za-z_][A-Za-z0-9_]*)@?[0-9]*\s*\(/im);
  return signature ? cleanupNavName(signature[1]) : undefined;
}

function isProcedureDeclarationLine(lineText, procedureName) {
  const escapedName = procedureName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:LOCAL\\s+)?PROCEDURE\\s+"?${escapedName}"?(?:@?[0-9]*)?\\s*\\(`, "i").test(lineText);
}

async function getLineText(uri, lineNumber, activeDocument) {
  try {
    const document = activeDocument.uri.toString() === uri.toString()
      ? activeDocument
      : await vscode.workspace.openTextDocument(uri);
    if (lineNumber < 0 || lineNumber >= document.lineCount) {
      return "";
    }
    return document.lineAt(lineNumber).text;
  } catch {
    return "";
  }
}

function getNavObjectContext(lines) {
  const context = [];
  const objectHeader = lines.find((line) => /^\uFEFF?\s*OBJECT\s+(Table|Form|Codeunit|Dataport|Report|XMLport|MenuSuite|Query|Page)\s+/i.test(line));
  if (objectHeader) {
    context.push(objectHeader);
  }

  for (const line of lines) {
    const sourceTableMatch = line.match(/\b(?:SourceTable|DataItemTable)\s*=\s*([^;]+);/i);
    if (sourceTableMatch) {
      context.push(line.trim());
    }
  }

  return context.length ? `NAV object context:\n${context.join("\n")}` : "";
}

function findNavBlockStart(lines, activeLine) {
  for (let lineNumber = activeLine; lineNumber >= 0; lineNumber -= 1) {
    if (isNavBlockStart(lines[lineNumber])) {
      return lineNumber;
    }
  }
  return undefined;
}

function findNavBlockEnd(lines, startLine) {
  for (let lineNumber = startLine + 1; lineNumber < lines.length; lineNumber += 1) {
    if (isNavBlockStart(lines[lineNumber])) {
      return lineNumber - 1;
    }

    if (/^\s{2}[A-Z0-9-]+\s*$/.test(lines[lineNumber]) && lineNumber > startLine + 1) {
      return lineNumber - 1;
    }
  }

  return lines.length - 1;
}

function isNavBlockStart(line) {
  return (
    /^\s*(?:LOCAL\s+)?PROCEDURE\s+/i.test(line) ||
    /^\s*(?:trigger\s+)?On[A-Za-z0-9_]+@?[0-9]*\s*(?:\(|=)/.test(line)
  );
}

function getConfig() {
  const workspaceConfig = vscode.workspace.getConfiguration("navDevAssistant");
  const provider = workspaceConfig.get("provider", "openai");
  const providerConfig = workspaceConfig.get(provider, {});
  return {
    provider,
    endpoint: providerConfig.endpoint || defaultEndpoint(provider),
    apiKey: providerConfig.apiKey || "",
    model: providerConfig.model || (provider === "openai" ? "gpt-4o-mini" : "llama3.1"),
    maxInputCharacters: workspaceConfig.get("maxInputCharacters", 24000),
    maxOutputTokens: workspaceConfig.get("maxOutputTokens", 700),
    temperature: workspaceConfig.get("temperature", 0.2)
  };
}

function defaultEndpoint(provider) {
  return provider === "openai"
    ? "https://api.openai.com/v1/chat/completions"
    : "http://localhost:11434/v1/chat/completions";
}

async function buildExplainSymbolContext(navIndex, document, code, range) {
  const empty = {
    entries: [],
    labelsBySymbol: new Map(),
    promptBlock: ""
  };

  try {
    const analysis = await navIndex.getAnalysisForDocument(document, { silent: true });
    if (!analysis) {
      return empty;
    }

    const usedSymbols = collectExplainSymbolNames(code);
    const candidates = collectExplainVariableCandidates(analysis, range);
    const entriesBySymbol = new Map();

    for (const candidate of candidates) {
      const symbol = cleanupNavName(candidate.name);
      const symbolKey = explainSymbolKey(symbol);
      if (!symbolKey || !usedSymbols.has(symbolKey)) {
        continue;
      }

      const objectType = variableSubtypeObjectType(candidate.dataType);
      const subtype = cleanNavSubtype(candidate.subtype);
      if (!objectType || !subtype) {
        continue;
      }

      const resolvedObject = await navIndex.findObject(objectType, subtype);
      const objectId = resolvedObject?.id ?? (/^\d+$/.test(subtype) ? subtype : undefined);
      const objectName = resolvedObject?.name ?? (/^\d+$/.test(subtype) ? undefined : subtype);
      const resolvedType = resolvedObject?.type || objectType;
      const objectLabel = explainObjectLabel(resolvedType, objectId, objectName);
      if (!objectLabel) {
        continue;
      }

      const entry = {
        symbol,
        objectLabel,
        objectType: resolvedType,
        objectId,
        objectName,
        dataType: candidate.dataType,
        subtype,
        temporary: Boolean(candidate.temporary),
        scope: candidate.scope || ""
      };

      const existing = entriesBySymbol.get(symbolKey);
      if (!existing || explainSymbolEntryScore(entry) > explainSymbolEntryScore(existing)) {
        entriesBySymbol.set(symbolKey, entry);
      }
    }

    const entries = [...entriesBySymbol.values()]
      .sort((a, b) => a.symbol.localeCompare(b.symbol, undefined, { sensitivity: "base" }))
      .slice(0, 30);
    if (!entries.length) {
      return empty;
    }

    const labelsBySymbol = new Map(entries.map((entry) => [explainSymbolKey(entry.symbol), entry.objectLabel]));
    const promptBlock = [
      "",
      "",
      "Symbol lookup from workspace index. Treat this as stronger evidence than variable names. When a listed symbol is dereferenced with .FIELD or .METHOD, describe it as Object Name (ID), not only the variable name. Do not infer business behavior from object names beyond identifying the object:",
      ...entries.map((entry) => `- ${entry.symbol} -> ${entry.objectLabel} [${entry.objectType}${entry.temporary ? " temporary" : ""}; ${entry.dataType}${entry.subtype ? ` ${entry.subtype}` : ""}${entry.scope ? `; ${entry.scope}` : ""}]`)
    ].join("\n");

    return {
      entries,
      labelsBySymbol,
      promptBlock
    };
  } catch {
    return empty;
  }
}

function collectExplainVariableCandidates(analysis, range) {
  const candidates = [];
  const activeBlocks = (analysis.codeBlocks || []).filter((block) => explainRangeIntersects(range, block.range));
  const blocks = activeBlocks.length ? activeBlocks : (analysis.codeBlocks || []);

  for (const variable of analysis.variables || []) {
    candidates.push(variable);
  }

  for (const block of blocks) {
    for (const variable of block.variables || []) {
      candidates.push(variable);
    }
  }

  if (analysis.recordVariables instanceof Map) {
    for (const [symbol, tableName] of analysis.recordVariables.entries()) {
      candidates.push({
        name: symbol,
        dataType: "Record",
        subtype: tableName,
        temporary: false,
        scope: "implicit"
      });
    }
  }

  return candidates;
}

function explainRangeIntersects(targetRange, blockRange) {
  if (!targetRange || !blockRange) {
    return false;
  }

  const targetStart = Number(targetRange.start?.line || 0);
  const targetEnd = Number(targetRange.end?.line || targetStart);
  const blockStart = Number(blockRange.start?.line || 0);
  const blockEnd = Number(blockRange.end?.line || blockStart);
  return targetStart <= blockEnd && targetEnd >= blockStart;
}

function collectExplainSymbolNames(code) {
  const names = new Set();
  const text = stripNavComments(stripNavObjectContext(code));

  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    names.add(explainSymbolKey(match[1]));
  }

  for (const match of text.matchAll(/"([^"\r\n]+)"\s*\./g)) {
    names.add(explainSymbolKey(match[1]));
  }

  return names;
}

function explainSymbolKey(value) {
  return cleanupNavName(value).toLowerCase();
}

function explainObjectLabel(objectType, objectId, objectName) {
  const name = cleanupNavName(objectName);
  const id = objectId !== undefined && objectId !== null ? String(objectId).trim() : "";
  if (name && id) {
    return `${name} (${id})`;
  }
  if (name) {
    return name;
  }
  if (objectType && id) {
    return `${objectType} ${id}`;
  }
  return "";
}

function explainSymbolEntryScore(entry) {
  let score = 0;
  if (entry.objectName) {
    score += 4;
  }
  if (entry.objectId !== undefined && entry.objectId !== null) {
    score += 4;
  }
  if (entry.scope === "parameter") {
    score += 3;
  } else if (entry.scope === "local") {
    score += 2;
  } else if (entry.scope === "global") {
    score += 1;
  }
  return score;
}

function buildPrompt({ fileName, languageId, mode, source, question, code, callerContext, symbolContext, glossary, wasTruncated }) {
  const isSmallProcedure = code.length < 1600 && looksLikeNavProcedureOrTrigger(code);
  const navFacts = extractNavFacts(code, symbolContext);
  const task =
    mode === "question"
      ? question
      : isSmallProcedure
        ? "Explain this NAV/C/AL procedure or trigger briefly. First read the procedure signature, parameters, and assignment statements carefully. If it is just assignment or delegation, say that directly and do not add speculative risks."
      : "Explain what this NAV/C/AL code does. Focus on observable behavior from the supplied code: filters, reads, writes/deletes, assignments, and procedure calls. Do not perform a broad risk audit.";

  const truncationNote = wasTruncated
    ? "\nThe code was truncated to fit the configured input limit, so say when context may be missing."
    : "";
  const responseShape = isSmallProcedure
    ? "\nKeep the answer under 120 words. Use exactly these sections: Summary, NAV details, Side effects. Ignore commented-out code in // line comments and { ... } block comments. Mention each parameter by name and type if present. For := assignments, state what source variable is copied into what target variable. If there are no meaningful risks, do not add a risks section. For DELETE or DELETEALL, say only the deletion proven by the exact statement and current filters."
    : "\nKeep the answer under 350 words. Use exactly these sections: Summary, Reads and filters, Writes and side effects, Calls. Ignore commented-out code in // line comments and { ... } block comments; do not list assignments, comparisons, or commented-out examples as calls. Do not include Open Questions or Likely Risks sections. If something is unknown, say it inline only when necessary and do not frame it as a bug. Only mention a warning when it is directly proven by the code, such as DELETEALL, COMMIT, MODIFY, INSERT, DELETE, or VALIDATE. DELETE deletes the current record in that record variable; DELETEALL deletes only the current filtered set for that record variable. Do not say DELETEALL truncates, clears, purges, archives, cascades, deletes related records, or deletes every row in the table unless the supplied code proves that exact scope. When describing totals, name the exact expression or field being added, such as Total += Record.Field; do not replace it with a nearby business concept. Do not describe Boolean arguments as likely/default flags unless the called procedure name or parameter names prove that meaning. Do not mention SQL injection for SETFILTER placeholders. For Record.GET(...), say it retrieves by primary key using the supplied argument(s), not that it is likely a lookup key. Do not invent sums, totals, or aggregation unless the code shows +=, CALCSUMS, SUM, or an accumulator loop. Do not say a procedure call is inside EXIT(...) unless the exact syntax wraps that call in EXIT(. For IF/THEN EXIT(SomeCall(...)), say that branch returns SomeCall(...); do not say it skips processing. If this procedure delegates to a called procedure named Post*, say writes are delegated to that call unless the writes are visible here. For long positional procedure calls, read arguments in order and preserve which arguments are passed through from the current procedure parameters versus which arguments are literals, defaults, or record fields. Do not summarize the whole call from a later literal/default argument. Do not say quantities are zero unless the quantity argument positions themselves are literal 0; if quantity arguments are named parameters like QtyToBeShipped or QtyToBeInvoiced, say they are passed through.";

  const factsBlock = navFacts.length
    ? `\n\nExtracted NAV facts. Treat these as stronger evidence than object names or guesses:\n${navFacts.map((fact) => `- ${fact}`).join("\n")}`
    : "\n\nNo deterministic NAV facts were extracted. Avoid guessing beyond the supplied code.";
  const callersBlock = callerContext
    ? `\n\nKnown callers from workspace index. Use these as call context, but do not invent behavior from them:\n${callerContext}`
    : "";
  const symbolBlock = symbolContext?.promptBlock || "";
  const glossaryBlock = buildGlossaryBlock(glossary, code);

  return [
    {
      role: "system",
      content:
        "You are a senior Microsoft Dynamics NAV Classic C/AL. Treat the code as Dynamics NAV object text/C/AL unless the language is clearly AL. Do not explain it as JavaScript, C#, generic Pascal, or SQL. Ignore commented-out code in // line comments and { ... } block comments; comments can explain intent, but they are not executable behavior and must not create calls, reads, writes, assignments, deletes, or risks. Know NAV semantics: := assignment, Record variables, implicit Rec/xRec, WITH record scopes, FlowFields, SETRANGE/SETFILTER/FIND/FINDSET/MODIFY/INSERT/DELETE/DELETEALL/VALIDATE/CALCFIELDS/COMMIT, table triggers, codeunit procedures, pages, reports, and posting routines. In exported C/AL, @ numbers on procedures/variables are symbol IDs and carry no business meaning. FIND('-') positions a record using existing filters/key; it does not imply RESET. SETFILTER placeholders like %1 are normal NAV syntax and are not a risk by themselves. DELETE deletes the current record in the record variable. DELETEALL deletes the current filtered set for the record variable; active filters and temporary status determine scope. Do not infer truncate, cascade, archive, purge, related-record deletion, or whole-table deletion unless the supplied code proves it. Be direct and concise. Do not pad simple procedures. Do not invent business rules, risks, validations, database writes, totals, record types, or callers that are not visible in the supplied code. Treat containing object names as weak metadata only; NAV objects named Functions, Management, Utilities, Common, or similar are often generic containers and do not prove business intent. Prefer evidence from the procedure signature, record types, field names, assignments, database calls, filters, and called procedures. Use the supplied symbol lookup to name dereferenced records/objects as Object Name (ID), such as Sales Line (37), instead of only the variable name. If a total is accumulated, identify the exact right-hand expression from the assignment. If required context is missing, say what is missing instead of guessing."
    },
    {
      role: "user",
      content: `${task}${responseShape}\n\nFile: ${fileName}\nLanguage: ${languageId}\nSource: ${source || "unknown"}${truncationNote}${glossaryBlock}${callersBlock}${symbolBlock}${factsBlock}\n\nCode:\n\`\`\`\n${code}\n\`\`\``
    }
  ];
}

async function loadWorkspaceGlossary(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return {};
  }

  const configFileName = vscode.workspace.getConfiguration("navDevAssistant").get("configFileName", ".navdevassistant.json");
  const configUri = vscode.Uri.joinPath(folder.uri, configFileName);
  try {
    const bytes = await vscode.workspace.fs.readFile(configUri);
    const config = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return config.glossary && typeof config.glossary === "object" ? config.glossary : {};
  } catch {
    return {};
  }
}

function buildGlossaryBlock(glossary, code) {
  const entries = Object.entries(glossary || {}).filter(([term]) => codeIncludesTerm(code, term));
  if (!entries.length) {
    return "";
  }

  return `\n\nRepo glossary. Use these meanings for this codebase and do not replace them with generic software meanings:\n${entries.map(([term, meaning]) => `- ${term}: ${meaning}`).join("\n")}`;
}

function codeIncludesTerm(code, term) {
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, "i").test(code);
}

function looksLikeNavProcedureOrTrigger(code) {
  return (
    /^\s*(?:LOCAL\s+)?PROCEDURE\s+/im.test(code) ||
    /^\s*(?:trigger\s+)?On[A-Za-z0-9_]+@?[0-9]*\s*(?:\(|=)/m.test(code)
  );
}

function extractNavFacts(code, symbolContext) {
  const cleanCode = stripNavComments(stripNavObjectContext(code));
  const facts = [];
  const signature = cleanCode.match(/^\s*(?:LOCAL\s+)?PROCEDURE\s+("?[^"(@]+"?|[A-Za-z_][A-Za-z0-9_]*)@?[0-9]*\s*\(([^)]*)\)\s*;?/im);
  if (signature) {
    const procedureName = cleanupNavName(signature[1]);
    const parameters = parseNavParameters(signature[2]);
    facts.push(`Procedure name: ${procedureName}.`);
    if (parameters.length) {
      facts.push(`Parameters: ${parameters.map((parameter) => `${parameter.name}: ${parameter.type}`).join("; ")}.`);
    } else {
      facts.push("Parameters: none visible in the signature.");
    }
  }

  const trigger = cleanCode.match(/^\s*(?:trigger\s+)?(On[A-Za-z0-9_]+)@?[0-9]*\s*(?:\(|=)/m);
  if (trigger) {
    facts.push(`Trigger name: ${trigger[1]}.`);
  }

  for (const assignment of cleanCode.matchAll(/^\s*([^:=;\n]+?)\s*:=\s*([^;\n]+);/gm)) {
    facts.push(`Assignment: ${cleanupNavExpression(assignment[2])} is assigned to ${cleanupNavExpression(assignment[1])}.`);
  }

  for (const validate of cleanCode.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*|"[^"]+")\.VALIDATE\s*\(\s*([^,\)]+)(?:,\s*([^\)]+))?\)/gi)) {
    const record = explainNavSymbolReference(validate[1], symbolContext);
    const field = cleanupNavExpression(validate[2]);
    const value = validate[3] ? cleanupNavExpression(validate[3]) : undefined;
    facts.push(value
      ? `VALIDATE: ${record}.${field} is validated with value ${value}; NAV runs field validation logic/triggers for that field.`
      : `VALIDATE: ${record}.${field} is validated; NAV runs field validation logic/triggers for that field.`);
  }

  for (const modify of cleanCode.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*|"[^"]+")\.(MODIFY|INSERT|DELETE)\s*(?:\(\s*(TRUE|FALSE)?\s*\))?/gi)) {
    const record = explainNavSymbolReference(modify[1], symbolContext);
    const operation = modify[2].toUpperCase();
    const runTrigger = modify[3] ? modify[3].toUpperCase() : undefined;
    const triggerNote = runTrigger === "TRUE"
      ? " with triggers enabled"
      : runTrigger === "FALSE"
        ? " with triggers disabled"
        : "";
    const scopeNote = operation === "DELETE"
      ? " deletes the current record in that record variable"
      : "";
    facts.push(`Database write: ${record}.${operation}${scopeNote}${triggerNote}.`);
  }

  for (const deleteAll of cleanCode.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*|"[^"]+")\.DELETEALL\s*(?:\(\s*(TRUE|FALSE)?\s*\))?/gi)) {
    const record = explainNavSymbolReference(deleteAll[1], symbolContext);
    const runTrigger = deleteAll[2] ? deleteAll[2].toUpperCase() : undefined;
    const triggerNote = runTrigger === "TRUE"
      ? " with delete triggers enabled"
      : runTrigger === "FALSE"
        ? " with delete triggers disabled"
        : "";
    facts.push(`Database write: ${record}.DELETEALL deletes only the current filtered set for that record variable${triggerNote}.`);
  }

  for (const reset of cleanCode.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*|"[^"]+")\.RESET\s*\(\s*\)/gi)) {
    facts.push(`Record state: ${explainNavSymbolReference(reset[1], symbolContext)}.RESET clears filters, marks, and key selection on that record variable.`);
  }

  for (const key of cleanCode.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*|"[^"]+")\.SETCURRENTKEY\s*\(([^\)]*)\)/gi)) {
    facts.push(`Key selection: ${explainNavSymbolReference(key[1], symbolContext)}.SETCURRENTKEY selects key fields ${cleanupNavExpression(key[2])}.`);
  }

  for (const filter of cleanCode.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*|"[^"]+")\.(SETRANGE|SETFILTER)\s*\(\s*([^,\)]+)(?:,\s*([^\)]*))?\)/gi)) {
    const record = explainNavSymbolReference(filter[1], symbolContext);
    const operation = filter[2].toUpperCase();
    const field = cleanupNavExpression(filter[3]);
    const value = filter[4] ? cleanupNavExpression(filter[4]) : undefined;
    facts.push(value
      ? `Filter: ${record}.${operation} applies a filter on ${field} using ${value}.`
      : `Filter: ${record}.${operation} applies a filter on ${field}.`);
    if (operation === "SETFILTER" && value && /%[0-9]+/.test(value)) {
      facts.push(`Filter syntax: ${record}.SETFILTER uses NAV placeholder substitution; the % placeholder is normal NAV syntax.`);
    }
  }

  for (const find of cleanCode.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*|"[^"]+")\.(FINDSET|FINDFIRST|FINDLAST|FIND)\s*(?:\(([^\)]*)\))?/gi)) {
    const record = explainNavSymbolReference(find[1], symbolContext);
    const argument = find[3] ? cleanupNavExpression(find[3]) : undefined;
    facts.push(argument
      ? `Record read: ${record}.${find[2].toUpperCase()}(${argument}) searches/positions records using the current filters/key; it does not clear filters by itself.`
      : `Record read: ${record}.${find[2].toUpperCase()} searches/positions records using the current filters/key; it does not clear filters by itself.`);
  }

  for (const calc of cleanCode.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*|"[^"]+")\.(CALCFIELDS|CALCSUMS)\s*\(([^\)]*)\)/gi)) {
    facts.push(`${calc[2].toUpperCase()}: ${explainNavSymbolReference(calc[1], symbolContext)} calculates ${cleanupNavExpression(calc[3])}.`);
  }

  const knownRecordMethods = new Set([
    "CALCFIELDS",
    "CALCSUMS",
    "DELETE",
    "DELETEALL",
    "FIND",
    "FINDFIRST",
    "FINDLAST",
    "FINDSET",
    "INSERT",
    "MODIFY",
    "RESET",
    "SETCURRENTKEY",
    "SETFILTER",
    "SETRANGE",
    "VALIDATE"
  ]);
  for (const dottedCall of cleanCode.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*|"[^"]+")\.([A-Za-z_][A-Za-z0-9_]*)\s*\(([^\)]*)\)/gi)) {
    if (!isExecutableCallStatement(cleanCode, dottedCall.index)) {
      continue;
    }

    const methodName = dottedCall[2].toUpperCase();
    if (knownRecordMethods.has(methodName)) {
      continue;
    }

    const receiver = cleanupNavExpression(dottedCall[1]);
    const resolvedReceiver = explainNavSymbolReference(receiver, symbolContext);
    if (resolvedReceiver !== receiver) {
      facts.push(`Object call: ${resolvedReceiver}.${dottedCall[2]}(${cleanupNavExpression(dottedCall[3])}).`);
    }
  }

  if (/\bCOMMIT\s*;?/i.test(cleanCode)) {
    facts.push("Transaction: COMMIT is called, which commits the current database transaction.");
  }

  for (const exitCall of extractExitProcedureCalls(cleanCode)) {
    facts.push(`EXIT call: returns ${exitCall.name}(${summarizeNavArguments(exitCall.args)}).`);
  }

  for (const line of cleanCode.split(/\r?\n/)) {
    const call = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)(?:@?[0-9]*)?\s*\((.*)\)\s*;?\s*$/);
    if (!call || /[:=<>]/.test(call[2])) {
      continue;
    }

    const name = call[1];
    if (!["IF", "WHILE", "REPEAT", "CASE", "WITH", "UNTIL", "EXIT"].includes(name.toUpperCase())) {
      facts.push(`Procedure call: ${name}(${cleanupNavExpression(call[2])}).`);
    }
  }

  return [...new Set(facts)].slice(0, 40);
}

function extractExitProcedureCalls(code) {
  const calls = [];
  const pattern = /\bEXIT\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;

  for (const match of code.matchAll(pattern)) {
    const name = match[1];
    const argsStart = match.index + match[0].length;
    const argsEnd = findMatchingParen(code, argsStart - 1);
    if (argsEnd < 0) {
      continue;
    }
    const exitEnd = findMatchingParen(code, argsEnd + 1);
    if (exitEnd < 0) {
      continue;
    }
    calls.push({
      name,
      args: splitNavArguments(code.slice(argsStart, argsEnd))
    });
  }

  return calls;
}

function findMatchingParen(text, openIndex) {
  let depth = 0;
  let inString = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "'") {
      if (inString && next === "'") {
        index += 1;
      } else {
        inString = !inString;
      }
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function splitNavArguments(text) {
  const args = [];
  let current = "";
  let depth = 0;
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "'") {
      current += char;
      if (inString && next === "'") {
        current += next;
        index += 1;
      } else {
        inString = !inString;
      }
      continue;
    }
    if (!inString) {
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
      } else if (char === "," && depth === 0) {
        args.push(cleanupNavExpression(current));
        current = "";
        continue;
      }
    }
    current += char;
  }

  if (current.trim()) {
    args.push(cleanupNavExpression(current));
  }

  return args;
}

function summarizeNavArguments(args) {
  return args
    .slice(0, 18)
    .map((arg, index) => `${index + 1}:${arg}`)
    .join("; ");
}

function explainSimpleNavProcedure(code) {
  const cleanCode = stripNavObjectContext(code);
  const signature = cleanCode.match(/^\s*(?:LOCAL\s+)?PROCEDURE\s+("?[^"(@]+"?|[A-Za-z_][A-Za-z0-9_]*)@?[0-9]*\s*\(([^)]*)\)\s*;?/im);
  if (!signature) {
    return undefined;
  }

  const bodyMatch = cleanCode.match(/\bBEGIN\b([\s\S]*?)\bEND\s*;?\s*$/i);
  if (!bodyMatch) {
    return undefined;
  }

  const statements = bodyMatch[1]
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  if (statements.length !== 1) {
    return undefined;
  }

  const assignment = statements[0].match(/^(.+?)\s*:=\s*(.+)$/);
  if (!assignment) {
    return undefined;
  }

  const procedureName = cleanupNavName(signature[1]);
  const parameters = parseNavParameters(signature[2]);
  const target = cleanupNavExpression(assignment[1]);
  const source = cleanupNavExpression(assignment[2]);
  const sourceParameter = parameters.find((parameter) => parameter.name.toLowerCase() === source.toLowerCase());

  return [
    "## Summary",
    "",
    `${procedureName} copies ${source} into ${target}.`,
    "",
    "## NAV details",
    "",
    sourceParameter
      ? `${source} is a ${sourceParameter.type} parameter. The C/AL \`:=\` assignment copies that record variable value into ${target}.`
      : `The C/AL \`:=\` assignment copies ${source} into ${target}.`,
    "",
    "## Side effects",
    "",
    `No database write occurs here. This only changes the in-memory ${target} variable for this object.`
  ].join("\n");
}

function stripNavObjectContext(code) {
  return String(code || "").replace(/^NAV object context:[\s\S]*?\n\n/, "");
}

function stripNavComments(code) {
  const text = String(code || "");
  let result = "";
  let inString = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inBlockComment) {
      if (char === "}") {
        inBlockComment = false;
      }
      result += char === "\n" || char === "\r" ? char : " ";
      continue;
    }

    if (inString) {
      result += char;
      if (char === "'" && next === "'") {
        result += next;
        index += 1;
      } else if (char === "'") {
        inString = false;
      }
      continue;
    }

    if (char === "'") {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") {
        result += " ";
        index += 1;
      }
      index -= 1;
      continue;
    }

    if (char === "{") {
      inBlockComment = true;
      result += " ";
      continue;
    }

    result += char;
  }

  return result;
}

function isExecutableCallStatement(code, index) {
  const lineStart = Math.max(code.lastIndexOf("\n", index), code.lastIndexOf("\r", index)) + 1;
  const prefix = code.slice(lineStart, index).trim();
  if (!prefix) {
    return true;
  }

  return /^(?:IF|THEN|ELSE|REPEAT|UNTIL|WHILE|DO|BEGIN)\b/i.test(prefix);
}

function parseNavParameters(parameterText) {
  if (!parameterText.trim()) {
    return [];
  }

  return parameterText
    .split(";")
    .map((parameter) => parameter.trim())
    .filter(Boolean)
    .map((parameter) => {
      const match = parameter.match(/^("?[^"@:;]+"?|[A-Za-z_][A-Za-z0-9_]*)@?[0-9]*\s*:\s*(.+)$/);
      if (!match) {
        return undefined;
      }
      return {
        name: cleanupNavName(match[1]),
        type: match[2].trim()
      };
    })
    .filter(Boolean);
}

function cleanupNavExpression(value) {
  return cleanupNavName(String(value || "").trim());
}

function cleanupNavName(value) {
  return String(value || "").replace(/^"|"$/g, "").trim();
}

function explainNavSymbolReference(value, symbolContext) {
  const symbol = cleanupNavExpression(value);
  return symbolContext?.labelsBySymbol?.get?.(explainSymbolKey(symbol)) || symbol;
}

async function callChatCompletion(config, messages) {
  if (config.provider === "openai" && !config.apiKey) {
    await offerOpenSettings("Set navDevAssistant.openai.apiKey or switch navDevAssistant.provider to local.");
    throw new Error("missing OpenAI API key.");
  }

  const endpoint = new URL(config.endpoint);
  const usesOllamaChat = endpoint.pathname.endsWith("/api/chat");
  const body = usesOllamaChat
    ? {
        model: config.model,
        messages,
        stream: false,
        options: {
          temperature: config.temperature,
          num_predict: config.maxOutputTokens
        }
      }
    : {
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
        stream: false
      };

  const headers = {
    "content-type": "application/json"
  };

  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }

  const response = await postJson(endpoint, body, headers);
  const content =
    response?.choices?.[0]?.message?.content ||
    response?.message?.content ||
    response?.response;

  if (!content) {
    throw new Error("the model response did not include explainable text.");
  }

  return content;
}

function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...headers,
          "content-length": data.length
        }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = text ? JSON.parse(text) : {};
          } catch (error) {
            reject(new Error(`invalid JSON response from ${url.host}: ${text.slice(0, 300)}`));
            return;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            const message = json?.error?.message || json?.error || text || response.statusMessage;
            reject(new Error(`request failed (${response.statusCode}): ${message}`));
            return;
          }

          resolve(json);
        });
      }
    );

    request.on("error", reject);
    request.write(data);
    request.end();
  });
}

async function showMarkdownAnswer(answer, details) {
  const basename = details.fileName.split(/[\\/]/).pop();
  const content = [
    `# NAV Explanation`,
    "",
    `Source: ${basename} (${details.source})`,
    `Model: ${details.provider}/${details.model}`,
    "",
    details.callersMarkdown || "",
    answer.trim(),
    ""
  ].filter((part) => part !== "").join("\n");

  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content
  });
  await vscode.window.showTextDocument(document, {
    preview: true,
    viewColumn: vscode.ViewColumn.Active
  });
}

function trimToLimit(text, maxCharacters) {
  if (text.length <= maxCharacters) {
    return { text, wasTruncated: false };
  }

  return {
    text: text.slice(0, maxCharacters),
    wasTruncated: true
  };
}

async function offerOpenSettings(message) {
  const action = await vscode.window.showWarningMessage(`NAV Dev Assistant: ${message}`, "Open Settings");
  if (action === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "navDevAssistant");
  }
}

async function runStructuredSearch(navIndex) {
  const folder = await pickWorkspaceFolder();
  if (!folder) {
    return;
  }

  const query = await vscode.window.showInputBox({
    title: "NAV: Structured Search",
    prompt: "Examples: calls:COMMIT, procedure:Post, trigger:OnRun calls:VALIDATE",
    placeHolder: "calls:COMMIT",
    ignoreFocusOut: true
  });
  if (!query) {
    return;
  }

  const rawResults = await structuredSearchResults(navIndex, folder, query);
  const results = rawResults.slice(0, 500);
  if (!results.length) {
    vscode.window.showInformationMessage(`NAV Dev Assistant: no structured search results for ${query}.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    results.map((result) => ({
      label: `${result.objectName}${result.containerName ? ` / ${result.containerName}` : ""}`,
      description: `${path.basename(result.uri.fsPath)}:${result.range.start.line + 1}`,
      detail: result.snippet,
      result
    })),
    { title: `NAV structured search: ${query}`, matchOnDescription: true, matchOnDetail: true }
  );

  if (picked) {
    await openLocation(picked.result.uri, picked.result.range);
  }
}

async function structuredSearchResults(navIndex, folder, query) {
  const parsed = parseStructuredSearchQuery(query);
  const analyses = await navIndex.getWorkspaceAnalyses();
  const results = [];

  for (const entry of analyses) {
    if (!isUriInsideFolder(entry.uri, folder.uri)) {
      continue;
    }

    const { uri, analysis } = entry;
    const objectName = analysis.objects?.[0]?.name || path.basename(uri.fsPath);

    if (parsed.procedure) {
      for (const block of analysis.codeBlocks || []) {
        if (!/^procedure$/i.test(block.kind) || !block.name.toLowerCase().includes(parsed.procedure)) {
          continue;
        }
        results.push(await buildStructuredSearchResult(uri, analysis, block.range, objectName, block.name));
      }
    }

    if (parsed.trigger) {
      for (const block of analysis.codeBlocks || []) {
        if (!/^trigger$/i.test(block.kind) || !block.name.toLowerCase().includes(parsed.trigger)) {
          continue;
        }
        results.push(await buildStructuredSearchResult(uri, analysis, block.range, objectName, block.name));
      }
    }

    if (parsed.calls) {
      for (const reference of analysis.references || []) {
        if (reference.key !== parsed.calls) {
          continue;
        }
        results.push(await buildStructuredSearchResult(uri, analysis, reference.location.range, objectName, "call"));
      }
    }

    if (parsed.text) {
      const document = await openNavSearchDocument(uri);
      if (!document) {
        continue;
      }

      for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
        const line = document.lineAt(lineNumber).text;
        if (!line.toLowerCase().includes(parsed.text)) {
          continue;
        }

        results.push({
          uri,
          objectName,
          containerName: "text",
          snippet: line.trim(),
          range: new vscode.Range(lineNumber, Math.max(0, line.toLowerCase().indexOf(parsed.text)), lineNumber, line.length)
        });
      }
    }
  }

  return dedupeStructuredSearchResults(results);
}

async function buildStructuredSearchResult(uri, analysis, range, objectName, containerName) {
  const snippet = (await getLineText(uri, range.start.line, vscode.window.activeTextEditor?.document || await vscode.workspace.openTextDocument(uri)))
    .trim()
    .replace(/\s+/g, " ");
  return {
    uri,
    objectName,
    containerName,
    snippet,
    range
  };
}

function parseStructuredSearchQuery(query) {
  const text = String(query || "").trim().toLowerCase();
  const result = {
    calls: undefined,
    procedure: undefined,
    trigger: undefined,
    text: undefined
  };

  for (const token of text.split(/\s+/)) {
    if (token.startsWith("calls:")) {
      result.calls = token.slice(6).trim();
    } else if (token.startsWith("procedure:")) {
      result.procedure = token.slice(10).trim();
    } else if (token.startsWith("trigger:")) {
      result.trigger = token.slice(8).trim();
    }
  }

  if (!result.calls && !result.procedure && !result.trigger) {
    result.text = text;
  }

  return result;
}

function dedupeStructuredSearchResults(items) {
  const result = [];
  const seen = new Set();

  for (const item of items) {
    const key = `${item.uri.toString()}:${item.range.start.line}:${item.range.start.character}:${item.containerName || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }

  return result;
}

async function documentSymbolsForDocument(navIndex, document) {
  const analysis = await navIndex.getAnalysisForDocument(document);
  if (!analysis?.objects?.length) {
    return [];
  }

  const navObject = analysis.objects[0];
  const children = [];

  if (analysis.properties?.length) {
    children.push(groupDocumentSymbol("Object Properties", "Group", analysis.properties.map((property) =>
      new vscode.DocumentSymbol(
        property.name,
        property.value || "",
        vscode.SymbolKind.Property,
        property.range,
        property.range
      ))));
  }

  if (analysis.fields?.length) {
    children.push(groupDocumentSymbol("Fields", "Group", analysis.fields.map((field) =>
      new vscode.DocumentSymbol(
        field.name,
        field.dataType || "",
        vscode.SymbolKind.Field,
        field.range,
        field.range
      ))));
  }

  if (analysis.codeBlocks?.length) {
    children.push(groupDocumentSymbol("Code", "Group", analysis.codeBlocks.map((block) => {
      const blockChildren = (block.variables || []).map((variable) => new vscode.DocumentSymbol(
        variable.name,
        variableTypeDisplay(variable),
        vscode.SymbolKind.Variable,
        variable.range,
        variable.range
      ));
      return new vscode.DocumentSymbol(
        block.name,
        block.signature || block.kind,
        symbolKind(block.kind),
        expandRangeToChildren(block.range, blockChildren),
        block.range,
        blockChildren
      );
    })));
  }

  const range = expandRangeToChildren(navObject.range, children);
  return [
    new vscode.DocumentSymbol(
      `${navObject.type} ${navObject.id} ${navObject.name}`,
      navObject.versionList || "",
      symbolKind(navObject.type),
      range,
      navObject.range,
      children
    )
  ];
}

function expandRangeToChildren(range, children) {
  let start = range.start;
  let end = range.end;

  for (const child of children) {
    if (comparePositions(child.range.start, start) < 0) {
      start = child.range.start;
    }
    if (comparePositions(child.range.end, end) > 0) {
      end = child.range.end;
    }
  }

  return new vscode.Range(start, end);
}

function groupDocumentSymbol(name, detail, children) {
  const range = children.length
    ? expandRangeToChildren(children[0].range, children)
    : new vscode.Range(0, 0, 0, 0);
  return new vscode.DocumentSymbol(name, detail, vscode.SymbolKind.Module, range, range, children);
}

function comparePositions(left, right) {
  if (left.line !== right.line) {
    return left.line - right.line;
  }

  return left.character - right.character;
}

async function hoverAtPosition(navIndex, document, position) {
  const objectDocument = await getIndexedObjectDocument(navIndex, document);
  if (!objectDocument) {
    return undefined;
  }

  const fieldMatch = await findFieldForHover(navIndex, document, position, objectDocument);
  if (fieldMatch) {
    return new vscode.Hover(fieldHoverMarkdown(fieldMatch.field, fieldMatch.owner || objectDocument), fieldMatch.range);
  }

  const procedureMatch = await findProcedureForHover(navIndex, document, position, objectDocument);
  if (procedureMatch) {
    return new vscode.Hover(procedureHoverMarkdown(procedureMatch), procedureMatch.range);
  }

  const variableMatch = findVariableForHover(document, position, objectDocument);
  if (!variableMatch) {
    return undefined;
  }

  const targetObject = await resolveVariableSubtypeObject(navIndex, document, variableMatch.variable);
  const markdown = variableHoverMarkdown(variableMatch.variable, targetObject);
  return new vscode.Hover(markdown, variableMatch.range);
}

async function getIndexedObjectDocument(navIndex, document) {
  const analysis = await navIndex.getAnalysisForDocument(document);
  if (!analysis?.objects?.length) {
    return undefined;
  }

  return analysisToObjectDocument(document.uri, analysis);
}

async function getIndexedObjectDocumentByUri(navIndex, uri) {
  const analysis = await navIndex.getAnalysisForUri(uri);
  if (!analysis?.objects?.length) {
    return undefined;
  }

  return analysisToObjectDocument(uri, analysis);
}

function analysisToObjectDocument(uri, analysis) {
  const navObject = analysis.objects?.[0];
  if (!navObject) {
    return undefined;
  }

  return {
    uri,
    sourcePath: uri.fsPath,
    objectType: normalizeNavObjectType(navObject.type),
    objectId: navObject.id,
    objectName: navObject.name,
    fields: analysis.fields || [],
    variables: analysis.variables || [],
    codeBlocks: analysis.codeBlocks || [],
    properties: analysis.properties || [],
    recordVariables: analysis.recordVariables || new Map(),
    objectVariables: analysis.objectVariables || new Map(),
    withScopes: analysis.withScopes || [],
    range: navObject.range
  };
}

function findVariableForHover(document, position, objectDocument) {
  const variables = allObjectVariables(objectDocument);
  if (!variables.length) {
    const token = hoverTokenAtPosition(document, position);
    if (!token || /^\d+$/.test(token.text)) {
      return undefined;
    }

    const variable = findVisibleVariable(objectDocument, token.text, position.line + 1);
    return variable ? { variable, range: token.range } : undefined;
  }

  const declaration = variableDeclarationAtPosition(document, position, variables);
  if (declaration) {
    return declaration;
  }

  const token = hoverTokenAtPosition(document, position);
  if (!token || /^\d+$/.test(token.text)) {
    return undefined;
  }

  const variable = findVisibleVariable(objectDocument, token.text, position.line + 1);
  if (!variable) {
    return undefined;
  }

  return { variable, range: token.range };
}

async function findFieldForHover(navIndex, document, position, objectDocument) {
  const fields = Array.isArray(objectDocument?.fields) ? objectDocument.fields : [];

  const declaredField = fields.find?.((field) => field.range.contains(position));
  if (declaredField) {
    return { field: declaredField, range: declaredField.range };
  }

  const token = fieldTokenAtPosition(document, position);
  if (!token) {
    return undefined;
  }

  const fieldArgumentMatch = await findRecordMethodFieldArgumentHover(navIndex, document, position, objectDocument, token);
  if (fieldArgumentMatch) {
    return fieldArgumentMatch;
  }

  const currentObjectField = fields.find?.((candidate) => String(candidate.name || "").toLowerCase() === token.text.toLowerCase());
  if (currentObjectField && isCurrentObjectFieldReference(document, position, token)) {
    return { field: currentObjectField, range: token.range, owner: objectDocument };
  }

  const withScopeField = await findWithScopeFieldForHover(navIndex, document, position, objectDocument, token);
  if (withScopeField) {
    return withScopeField;
  }

  return findVariableFieldForHover(navIndex, document, position, objectDocument, token);
}

async function findRecordMethodFieldArgumentHover(navIndex, document, position, objectDocument, token) {
  const context = fieldArgumentCallContext(document, token);
  if (!context || context.activeParameter !== 0 || !FIELD_ARGUMENT_METHODS.has(context.name.toLowerCase())) {
    return undefined;
  }

  let targetDocument;

  if (context.receiver) {
    if (/^(rec|xrec)$/i.test(context.receiver) && String(objectDocument.objectType || "").toLowerCase() === "table") {
      targetDocument = objectDocument;
    } else {
      const variable = findVisibleVariable(objectDocument, context.receiver, position.line + 1);
      if (!variable || String(variable.dataType || "").toLowerCase() !== "record") {
        return undefined;
      }

      const targetObject = await resolveVariableSubtypeObject(navIndex, document, variable);
      if (!targetObject?.uri) {
        return undefined;
      }

      targetDocument = await getIndexedObjectDocumentByUri(navIndex, targetObject.uri);
    }
  } else {
    const withScopeTable = tableNameForHoverScope(objectDocument, position.line);
    if (withScopeTable) {
      const targetObject = await navIndex.findObject("Table", withScopeTable);
      if (!targetObject?.uri) {
        return undefined;
      }
      targetDocument = await getIndexedObjectDocumentByUri(navIndex, targetObject.uri);
    } else if (String(objectDocument.objectType || "").toLowerCase() === "table") {
      targetDocument = objectDocument;
    }
  }

  if (!targetDocument) {
    return undefined;
  }

  const field = (targetDocument.fields || []).find((candidate) => String(candidate.name || "").toLowerCase() === token.text.toLowerCase());
  return field ? { field, range: token.range, owner: targetDocument } : undefined;
}

async function findWithScopeFieldForHover(navIndex, document, position, objectDocument, token) {
  const tableName = tableNameForHoverScope(objectDocument, position.line);
  if (!tableName) {
    return undefined;
  }

  const targetObject = await navIndex.findObject("Table", tableName);
  if (!targetObject?.uri) {
    return undefined;
  }

  const targetDocument = await getIndexedObjectDocumentByUri(navIndex, targetObject.uri);
  const field = (targetDocument?.fields || []).find((candidate) => String(candidate.name || "").toLowerCase() === token.text.toLowerCase());
  return field ? { field, range: token.range, owner: targetDocument } : undefined;
}

async function findVariableFieldForHover(navIndex, document, position, objectDocument, token) {
  const receiver = memberReceiverBeforeToken(document, token);
  if (!receiver) {
    return undefined;
  }

  if (String(objectDocument.objectType || "").toLowerCase() === "table" && /^(rec|xrec)$/i.test(receiver)) {
    const field = (objectDocument.fields || []).find((candidate) => String(candidate.name || "").toLowerCase() === token.text.toLowerCase());
    return field ? { field, range: token.range, owner: objectDocument } : undefined;
  }

  const variable = findVisibleVariable(objectDocument, receiver, position.line + 1);
  if (!variable || String(variable.dataType || "").toLowerCase() !== "record") {
    return undefined;
  }

  const targetObject = await resolveVariableSubtypeObject(navIndex, document, variable);
  if (!targetObject?.uri) {
    return undefined;
  }

  const targetDocument = await getIndexedObjectDocumentByUri(navIndex, targetObject.uri);
  const field = (targetDocument?.fields || []).find((candidate) => String(candidate.name || "").toLowerCase() === token.text.toLowerCase());
  return field ? { field, range: token.range, owner: targetDocument } : undefined;
}

async function findProcedureForHover(navIndex, document, position, objectDocument) {
  const token = hoverTokenAtPosition(document, position);
  if (!token || /^\d+$/.test(token.text)) {
    return undefined;
  }

  const receiver = memberReceiverBeforeToken(document, token);
  if (receiver) {
    return resolveMemberProcedure(navIndex, document, objectDocument, receiver, token.text, position.line + 1, token.range);
  }

  if (!isProcedureTokenContext(document, token)) {
    return undefined;
  }

  const block = (objectDocument.codeBlocks || []).find((candidate) =>
    String(candidate.name || "").toLowerCase() === token.text.toLowerCase());
  if (!block) {
    return undefined;
  }

  return {
    kind: block.kind || "Procedure",
    name: block.name,
    signature: normalizeProcedureSignature(block.signature || block.name),
    owner: `${objectDocument.objectType} ${objectDocument.objectId} ${objectDocument.objectName}`,
    range: token.range,
    parameters: signatureParameters(block.signature),
    definitionRange: block.range,
    definitionUri: document.uri
  };
}

async function resolveMemberProcedure(navIndex, document, objectDocument, receiver, memberName, oneBasedLine, range) {
  let targetType;
  let targetObject;
  let targetDocument;

  if (/^(rec|xrec)$/i.test(receiver) && String(objectDocument.objectType || "").toLowerCase() === "table") {
    targetType = "Table";
    targetDocument = objectDocument;
    targetObject = objectIdentity(objectDocument);
  } else {
    const variable = findVisibleVariable(objectDocument, receiver, oneBasedLine);
    if (!variable) {
      return undefined;
    }

    targetType = variableSubtypeObjectType(variable.dataType);
    if (!targetType) {
      return undefined;
    }

    targetObject = await resolveVariableSubtypeObject(navIndex, document, variable);
    if (targetObject?.uri) {
      targetDocument = await getIndexedObjectDocumentByUri(navIndex, targetObject.uri);
    }
  }

  const block = nonLocalProcedures(targetDocument).find((candidate) =>
    String(candidate.name || "").toLowerCase() === String(memberName || "").toLowerCase());
  if (block) {
    return {
      kind: "Procedure",
      name: block.name,
      signature: normalizeProcedureSignature(block.signature || block.name),
      owner: targetObjectDisplay(targetObject, targetDocument),
      range,
      receiver,
      parameters: signatureParameters(block.signature),
      definitionRange: block.range,
      definitionUri: targetDocument?.uri || document.uri
    };
  }

  if (String(targetType || "").toLowerCase() === "table" && BUILT_IN_RECORD_METHODS.some((method) => method.toLowerCase() === String(memberName || "").toLowerCase())) {
    return {
      kind: "Built-in Record Method",
      name: String(memberName || "").toUpperCase(),
      signature: `${String(memberName || "").toUpperCase()}(...)`,
      owner: targetObjectDisplay(targetObject, targetDocument),
      range,
      receiver,
      parameters: []
    };
  }

  if (BUILT_IN_OBJECT_METHODS.some((method) => method.toLowerCase() === String(memberName || "").toLowerCase())) {
    return {
      kind: "Built-in Object Method",
      name: String(memberName || "").toUpperCase(),
      signature: `${String(memberName || "").toUpperCase()}(...)`,
      owner: targetObjectDisplay(targetObject, targetDocument),
      range,
      receiver,
      parameters: []
    };
  }

  return undefined;
}

function isProcedureTokenContext(document, token) {
  const line = document.lineAt(token.range.start.line).text;
  const before = line.slice(0, token.range.start.character);
  const after = line.slice(token.range.end.character);
  return /\bPROCEDURE\s+$/i.test(before)
    || /^\s*(?:@\d+)?\s*\(/.test(after)
    || /^\s*\(/.test(after);
}

function memberReceiverBeforeToken(document, token) {
  const line = document.lineAt(token.range.start.line).text;
  const before = line.slice(0, token.range.start.character);
  const match = /(?:^|[^A-Za-z0-9_"])(?<receiver>"[^"\r\n]+"|[A-Za-z_][A-Za-z0-9_]*)\.\s*$/.exec(before);
  return match?.groups?.receiver?.replace(/^"|"$/g, "").trim();
}

function isCurrentObjectFieldReference(document, position, token) {
  const line = document.lineAt(position.line).text;
  const before = line.slice(0, token.range.start.character);
  const explicitReceiver = /(?:^|[^A-Za-z0-9_"])(Rec|xRec)\.\s*$/i.test(before);
  if (explicitReceiver) {
    return true;
  }

  const dotBefore = /\.\s*$/.test(before);
  const dotAfter = /^\s*\./.test(line.slice(token.range.end.character));
  if (dotBefore || dotAfter) {
    return false;
  }

  return true;
}

function variableDeclarationAtPosition(document, position, variables) {
  const declaration = parseVariableDeclarationLine(document.lineAt(position.line).text);
  if (!declaration) {
    return undefined;
  }

  const character = position.character;
  const isOnName = character >= declaration.nameStart && character <= declaration.nameEnd;
  const isOnType = character >= declaration.typeTextStart && character <= declaration.typeTextEnd;
  if (!isOnName && !isOnType) {
    return undefined;
  }

  const lineNumber = position.line + 1;
  const variable = variables.find((candidate) =>
    candidate.name === declaration.name && Number(candidate.range?.start.line || 0) + 1 === lineNumber);
  if (!variable) {
    return undefined;
  }

  const range = new vscode.Range(
    position.line,
    isOnName ? declaration.nameStart : declaration.typeTextStart,
    position.line,
    isOnName ? declaration.nameEnd : declaration.typeTextEnd
  );
  return { variable, range };
}

function parseVariableDeclarationLine(line) {
  const match = /^(\s*)("[^"\r\n]+"|[A-Za-z_][A-Za-z0-9_]*)(?:@(\d+))?\s*:\s*([^;]+);?/.exec(line);
  if (!match) {
    return undefined;
  }

  const fullMatch = match[0];
  const nameText = match[2];
  const typeText = match[4];
  const nameStart = match[1].length;
  const nameEnd = nameStart + nameText.length;
  const typeTextStart = fullMatch.indexOf(typeText);
  const typeTextEnd = typeTextStart + typeText.length;

  return {
    name: nameText.replace(/^"|"$/g, ""),
    nameStart,
    nameEnd,
    typeTextStart,
    typeTextEnd
  };
}

function findVisibleVariable(objectDocument, name, oneBasedLine) {
  const normalizedName = String(name || "").toLowerCase();
  const codeBlock = (objectDocument.codeBlocks || []).find((block) =>
    oneBasedLine >= Number(block.range?.start.line || 0) + 1 &&
    oneBasedLine <= Number(block.range?.end.line || 0) + 1);

  const localVariable = codeBlock?.variables?.find((variable) =>
    String(variable.name || "").toLowerCase() === normalizedName);
  if (localVariable) {
    return localVariable;
  }

  const declared = (objectDocument.variables || []).find((variable) =>
    String(variable.name || "").toLowerCase() === normalizedName &&
    String(variable.scope || "").toLowerCase() === "global")
    || (objectDocument.variables || []).find((variable) =>
      String(variable.name || "").toLowerCase() === normalizedName);
  if (declared) {
    return declared;
  }

  const implicitRecordSubtype = objectDocument.recordVariables?.get?.(normalizedName);
  if (implicitRecordSubtype) {
    return {
      name,
      dataType: "Record",
      subtype: implicitRecordSubtype,
      temporary: false,
      scope: "implicit",
      range: new vscode.Range(Math.max(0, oneBasedLine - 1), 0, Math.max(0, oneBasedLine - 1), 0)
    };
  }

  return undefined;
}

function allObjectVariables(objectDocument) {
  return [
    ...(objectDocument?.variables || []),
    ...((objectDocument?.codeBlocks || []).flatMap((block) => block.variables || []))
  ];
}

function tableNameForHoverScope(objectDocument, lineNumber) {
  const scopes = objectDocument?.withScopes || [];
  if (!scopes.length) {
    return undefined;
  }

  const matching = scopes.filter((scope) => lineNumber >= scope.startLine && lineNumber <= scope.endLine);
  if (!matching.length) {
    return undefined;
  }

  return matching[matching.length - 1].tableName;
}

async function resolveVariableSubtypeObject(navIndex, document, variable) {
  const targetType = variableSubtypeObjectType(variable?.dataType);
  const subtype = cleanNavSubtype(variable?.subtype);
  if (!targetType || !subtype) {
    return undefined;
  }

  const numericSubtype = /^\d+$/.test(subtype) ? Number(subtype) : undefined;
  const target = await navIndex.findObject(targetType, subtype);

  if (!target) {
    return { objectType: targetType, objectId: numericSubtype, objectName: undefined };
  }

  return {
    objectType: target.type,
    objectId: target.id,
    objectName: target.name,
    uri: target.uri
  };
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

function cleanNavSubtype(subtype) {
  return String(subtype || "")
    .replace(/^\[|\]$/g, "")
    .replace(/^"|"$/g, "")
    .trim();
}

function variableHoverMarkdown(variable, targetObject) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = false;

  const typeDisplay = variableTypeDisplay(variable);
  markdown.appendMarkdown("**Variable**\n\n");
  markdown.appendCodeblock(`${variable.name} : ${typeDisplay}`, "text");

  if (targetObject) {
    const objectLabel = targetObject.objectId !== undefined && targetObject.objectId !== null
      ? `${targetObject.objectType} ${targetObject.objectId}`
      : targetObject.objectType;
    const objectName = targetObject.objectName ? ` \`${targetObject.objectName}\`` : "";
    markdown.appendMarkdown(`\n${objectLabel}${objectName}`);
  }

  if (variable.scope) {
    markdown.appendMarkdown(`\n\nScope: \`${variable.scope}\``);
  }

  if (variable.id !== undefined && variable.id !== null) {
    markdown.appendMarkdown(`\n\nSymbol ID: \`${variable.id}\``);
  }

  return markdown;
}

function fieldHoverMarkdown(field, objectDocument) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = false;

  markdown.appendMarkdown("**Field**\n\n");
  markdown.appendCodeblock(`${field.name} : ${field.dataType || "Unknown"}`, "text");
  markdown.appendMarkdown(`\n${objectDocument.objectType} ${objectDocument.objectId} \`${objectDocument.objectName}\``);

  if (field.id !== undefined && field.id !== null) {
    markdown.appendMarkdown(`\n\nField ID: \`${field.id}\``);
  }

  return markdown;
}

function procedureHoverMarkdown(match) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = false;
  markdown.appendMarkdown(`**${match.kind || "Procedure"}**\n\n`);
  markdown.appendCodeblock(match.receiver ? `${match.receiver}.${match.signature}` : match.signature, "text");
  if (match.owner) {
    markdown.appendMarkdown(`\n${match.owner}`);
  }
  return markdown;
}

async function signatureHelpAtPosition(navIndex, document, position) {
  const context = callContextAtPosition(document, position);
  if (!context) {
    return undefined;
  }

  const objectDocument = await getIndexedObjectDocument(navIndex, document);
  if (!objectDocument) {
    return undefined;
  }

  let match;
  if (context.receiver) {
    match = await resolveMemberProcedure(navIndex, document, objectDocument, context.receiver, context.name, position.line + 1, new vscode.Range(position, position));
  } else {
    const block = (objectDocument.codeBlocks || []).find((candidate) =>
      String(candidate.name || "").toLowerCase() === context.name.toLowerCase());
    if (block) {
      match = {
        kind: block.kind || "Procedure",
        name: block.name,
        signature: normalizeProcedureSignature(block.signature || block.name),
        owner: `${objectDocument.objectType} ${objectDocument.objectId} ${objectDocument.objectName}`,
        parameters: signatureParameters(block.signature)
      };
    }
  }

  if (!match) {
    return undefined;
  }

  const help = new vscode.SignatureHelp();
  const signature = new vscode.SignatureInformation(
    match.receiver ? `${match.receiver}.${match.signature}` : match.signature,
    match.owner || ""
  );
  signature.parameters = (match.parameters || []).map((parameter) => new vscode.ParameterInformation(parameter));
  help.signatures = [signature];
  help.activeSignature = 0;
  help.activeParameter = Math.min(context.activeParameter, Math.max(0, signature.parameters.length - 1));
  return help;
}

function callContextAtPosition(document, position) {
  const before = document.lineAt(position.line).text.slice(0, position.character);
  const openIndex = findActiveCallOpenParen(before);
  if (openIndex < 0) {
    return undefined;
  }

  const callee = before.slice(0, openIndex).trimEnd();
  const member = /(?<receiver>"[^"\r\n]+"|[A-Za-z_][A-Za-z0-9_]*)\.\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)$/.exec(callee);
  const bare = /(?<name>[A-Za-z_][A-Za-z0-9_]*)$/.exec(callee);
  const activeParameter = countCallArguments(before.slice(openIndex + 1));

  if (member?.groups?.name) {
    return {
      receiver: member.groups.receiver.replace(/^"|"$/g, ""),
      name: member.groups.name,
      activeParameter
    };
  }

  if (bare?.groups?.name) {
    return {
      name: bare.groups.name,
      activeParameter
    };
  }

  return undefined;
}

function findActiveCallOpenParen(text) {
  let depth = 0;
  let inString = false;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === "'") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === ")") {
      depth += 1;
      continue;
    }
    if (char === "(") {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    }
  }
  return -1;
}

function countCallArguments(text) {
  let count = 0;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")" && depth > 0) {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      count += 1;
    }
  }
  return count;
}

function fieldArgumentCallContext(document, token) {
  const before = document.lineAt(token.range.start.line).text.slice(0, token.range.start.character);
  const openIndex = findActiveCallOpenParen(before);
  if (openIndex < 0) {
    return undefined;
  }

  const callee = before.slice(0, openIndex).trimEnd();
  const member = /(?<receiver>"[^"\r\n]+"|[A-Za-z_][A-Za-z0-9_]*)\.\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)$/.exec(callee);
  const bare = /(?<name>[A-Za-z_][A-Za-z0-9_]*)$/.exec(callee);
  const activeParameter = countCallArguments(before.slice(openIndex + 1));

  if (member?.groups?.name) {
    return {
      receiver: member.groups.receiver.replace(/^"|"$/g, ""),
      name: member.groups.name,
      activeParameter
    };
  }

  if (bare?.groups?.name) {
    return {
      name: bare.groups.name,
      activeParameter
    };
  }

  return undefined;
}

function normalizeProcedureSignature(signature) {
  return String(signature || "")
    .replace(/@-?\d+/g, "")
    .replace(/\s*;\s*$/, "")
    .trim();
}

function signatureParameters(signature) {
  const text = normalizeProcedureSignature(signature);
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close <= open) {
    return [];
  }

  return text.slice(open + 1, close)
    .split(";")
    .map((parameter) => parameter.trim())
    .filter(Boolean);
}

function variableTypeDisplay(variable) {
  const parts = [];
  if (variable.temporary) {
    parts.push("TEMPORARY");
  }

  parts.push(variable.dataType || "Unknown");
  if (variable.subtype) {
    parts.push(cleanNavSubtype(variable.subtype));
  }

  return parts.join(" ");
}

async function semanticTokensForDocument(navIndex, document) {
  const analysis = await navIndex.getAnalysisForDocument(document);
  const builder = new vscode.SemanticTokensBuilder(NAV_SEMANTIC_TOKEN_LEGEND);
  for (const property of analysis?.properties || []) {
    pushSemanticToken(builder, property.range, "property");
  }
  for (const field of analysis?.fields || []) {
    pushSemanticToken(builder, field.range, "property");
  }
  for (const variable of analysis?.variables || []) {
    pushSemanticToken(builder, variable.range, "variable");
  }
  for (const block of analysis?.codeBlocks || []) {
    pushSemanticToken(builder, block.range, /^trigger$/i.test(String(block.kind || "")) ? "function" : "function");
    for (const variable of block.variables || []) {
      pushSemanticToken(builder, variable.range, "variable");
    }
  }

  return builder.build();
}

function pushSemanticToken(builder, range, tokenType) {
  if (!range || range.isEmpty || !tokenType || range.start.line !== range.end.line) {
    return;
  }

  builder.push(range, tokenType);
}

function semanticTokenType(kind) {
  switch (String(kind || "").toLowerCase()) {
    case "property":
    case "objectmetadata":
      return "property";
    case "variable":
      return "variable";
    case "procedureortrigger":
    case "function":
      return "function";
    case "datatype":
      return "type";
    default:
      return undefined;
  }
}

function symbolKind(kind) {
  switch (String(kind || "").toLowerCase()) {
    case "field":
      return vscode.SymbolKind.Field;
    case "key":
      return vscode.SymbolKind.Key;
    case "procedure":
    case "function":
      return vscode.SymbolKind.Function;
    case "trigger":
      return vscode.SymbolKind.Event;
    case "variable":
      return vscode.SymbolKind.Variable;
    case "group":
      return vscode.SymbolKind.Module;
    case "table":
    case "page":
    case "report":
    case "codeunit":
      return vscode.SymbolKind.Class;
    default:
      return vscode.SymbolKind.Symbol;
  }
}

function tokenAtPosition(document, position) {
  const range = document.getWordRangeAtPosition(position, /"[^"\r\n]+"|[A-Za-z_][A-Za-z0-9_]*/);
  if (!range) {
    return undefined;
  }

  return document.getText(range).replace(/^"|"$/g, "").trim();
}

function referenceQueriesAtPosition(document, position) {
  const range = document.getWordRangeAtPosition(position, /"[^"\r\n]+"|[A-Za-z_][A-Za-z0-9_]*|\d+/);
  if (!range) {
    return [];
  }

  const token = document.getText(range).replace(/^"|"$/g, "").trim();
  const line = document.lineAt(position.line).text;
  const queries = [];

  const objectHeader = line.match(/^\uFEFF?\s*OBJECT\s+(Table|Form|Codeunit|Dataport|Report|XMLport|MenuSuite|Query|Page)\s+(\d+)\s+(.+)$/i);
  if (objectHeader && range.start.character >= line.indexOf(objectHeader[1])) {
    const objectType = objectHeader[1];
    const objectId = objectHeader[2];
    const objectName = objectHeader[3].trim();
    queries.push(`${objectType} ${objectId}`, objectName, objectId);
  }

  const beforeToken = line.slice(0, range.start.character);
  const typeReference = beforeToken.match(/\b(Record|Table|Page|Report|Codeunit|Query|XMLport|Form|Dataport)\s+$/i);
  if (typeReference) {
    queries.push(`${normalizeNavObjectType(typeReference[1])} ${token}`);
  }

  return [...new Set(queries.filter(Boolean))];
}

function objectReferencesAtPosition(document, position) {
  const range = document.getWordRangeAtPosition(position, /"[^"\r\n]+"|[A-Za-z_][A-Za-z0-9_]*|\d+/);
  if (!range) {
    return [];
  }

  const token = document.getText(range).replace(/^"|"$/g, "").trim();
  const line = document.lineAt(position.line).text;
  const references = [];

  const objectHeader = line.match(/^\uFEFF?\s*OBJECT\s+(Table|Form|Codeunit|Dataport|Report|XMLport|MenuSuite|Query|Page)\s+(\d+)\s+(.+)$/i);
  if (objectHeader && range.start.character >= line.indexOf(objectHeader[1])) {
    references.push({
      type: normalizeNavObjectType(objectHeader[1]),
      id: Number(objectHeader[2]),
      name: objectHeader[3].trim()
    });
  }

  const beforeToken = line.slice(0, range.start.character);
  const typeReference = beforeToken.match(/\b(Record|Table|Page|Report|Codeunit|Query|XMLport|Form|Dataport)\s+$/i);
  if (typeReference) {
    references.push({
      type: normalizeNavObjectType(typeReference[1]),
      id: /^\d+$/.test(token) ? Number(token) : undefined,
      name: /^\d+$/.test(token) ? undefined : token
    });
  }

  return references.filter((reference) => reference.type && (reference.id !== undefined || reference.name));
}

function matchesObjectReference(reference, object) {
  if (normalizeNavObjectType(reference.type) !== normalizeNavObjectType(object.objectType)) {
    return false;
  }

  if (reference.id !== undefined && Number(object.objectId) !== Number(reference.id)) {
    return false;
  }

  if (reference.name && String(object.objectName || "").toLowerCase() !== String(reference.name).toLowerCase()) {
    return false;
  }

  return true;
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
      return value;
  }
}

function fieldTokenAtPosition(document, position) {
  const range = document.getWordRangeAtPosition(position, /"[^"\r\n]+"|[A-Za-z_][A-Za-z0-9_]*/);
  if (!range) {
    return undefined;
  }

  return {
    text: document.getText(range).replace(/^"|"$/g, "").trim(),
    range
  };
}

function hoverTokenAtPosition(document, position) {
  const range = document.getWordRangeAtPosition(position, /"[^"\r\n]+"|[A-Za-z_][A-Za-z0-9_]*|\d+/);
  if (!range) {
    return undefined;
  }

  return {
    text: document.getText(range).replace(/^"|"$/g, "").trim(),
    range
  };
}

function dedupeVsCodeLocations(locations) {
  const unique = [];
  const seen = new Set();

  for (const location of locations || []) {
    if (!location?.uri || !location?.range) {
      continue;
    }

    const key = `${location.uri.toString()}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(location);
  }

  return unique;
}

async function openLocation(uri, range) {
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

const analysisDiagnosticsTimers = new Map();

function scheduleIndexDiagnosticsForDocument(navIndex, diagnosticCollection, document) {
  const config = vscode.workspace.getConfiguration("navDevAssistant");
  if (!config.get("parser.diagnostics.runOnSave", false) || !isNavTextDocument(document)) {
    return;
  }

  const key = document.uri.toString();
  clearTimeout(analysisDiagnosticsTimers.get(key));
  analysisDiagnosticsTimers.set(key, setTimeout(async () => {
    analysisDiagnosticsTimers.delete(key);
    const scope = config.get("parser.diagnostics.scope", "file");
    try {
      if (scope === "workspace") {
        await updateIndexDiagnostics(navIndex, diagnosticCollection, config.get("parser.diagnostics.profile", "default"), { quiet: true });
      } else {
        await updateIndexDiagnosticsForDocument(navIndex, diagnosticCollection, document, { quiet: true });
      }
    } catch {
      // On-save diagnostics should never interrupt editing.
    }
  }, 400));
}

async function updateIndexDiagnosticsForDocument(navIndex, diagnosticCollection, document, options = {}) {
  diagnosticCollection.delete(document.uri);
  const analysis = await navIndex.getAnalysisForDocument(document);
  const diagnostics = await diagnosticsForDocument(navIndex, document.uri, analysis, await navIndex.getObjects());
  diagnosticCollection.set(document.uri, diagnostics);

  if (!options.quiet) {
    vscode.window.showInformationMessage(`NAV Dev Assistant: ${diagnostics.length} workspace analysis diagnostic(s) shown.`);
  }
}

function isNavTextDocument(document) {
  return document?.uri?.scheme === "file"
    && (document.languageId === "nav-obj" || /\.txt$/i.test(document.uri.fsPath))
    && hasNavObjectHeader(document.getText());
}

async function updateIndexDiagnostics(navIndex, diagnosticCollection, profile, options = {}) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    vscode.window.showErrorMessage("NAV Dev Assistant: open a workspace folder first.");
    return;
  }

  diagnosticCollection.clear();
  let count = 0;
  const objects = await navIndex.getObjects();
  const analyses = await navIndex.getWorkspaceAnalyses();

  const runner = async () => {
    for (const entry of analyses) {
      const diagnostics = await diagnosticsForDocument(navIndex, entry.uri, entry.analysis, objects);
      if (diagnostics.length) {
        diagnosticCollection.set(entry.uri, diagnostics);
      }
      count += diagnostics.length;
    }
  };

  if (options.quiet) {
    await runner();
  } else {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `NAV Dev Assistant: running ${profile === "upgrade" ? "upgrade " : ""}workspace diagnostics...`,
      cancellable: false
    }, runner);
  }

  if (!options.quiet) {
    vscode.window.showInformationMessage(`NAV Dev Assistant: ${count} workspace analysis diagnostic(s) shown.`);
  }
}

async function diagnosticsForDocument(navIndex, uri, analysis, objects) {
  const diagnostics = [];
  const navObject = analysis?.objects?.[0];
  if (!navObject) {
    return diagnostics;
  }

  const duplicateIdMatches = (objects || []).filter((item) =>
    !sameDocumentUri(item.uri, uri)
    && normalizeDependencyKey(item.type) === normalizeDependencyKey(navObject.type)
    && normalizeDependencyKey(item.id) === normalizeDependencyKey(navObject.id));
  if (duplicateIdMatches.length) {
    diagnostics.push(new vscode.Diagnostic(
      navObject.range,
      `Duplicate ${navObject.type} object id ${navObject.id} found in workspace.`,
      vscode.DiagnosticSeverity.Error
    ));
  }

  const duplicateNameMatches = (objects || []).filter((item) =>
    !sameDocumentUri(item.uri, uri)
    && normalizeDependencyKey(item.type) === normalizeDependencyKey(navObject.type)
    && normalizeDependencyKey(item.name) === normalizeDependencyKey(navObject.name));
  if (duplicateNameMatches.length) {
    diagnostics.push(new vscode.Diagnostic(
      navObject.range,
      `Duplicate ${navObject.type} object name '${navObject.name}' found in workspace.`,
      vscode.DiagnosticSeverity.Warning
    ));
  }

  const document = await openNavSearchDocument(uri);
  if (document) {
    const blockBalance = analyzeNavBlockBalance(document);
    if (!blockBalance.balanced) {
      diagnostics.push(new vscode.Diagnostic(
        blockBalance.range,
        blockBalance.message,
        vscode.DiagnosticSeverity.Warning
      ));
    }
  }

  for (const block of analysis?.codeBlocks || []) {
    if (block.range.start.line === block.range.end.line) {
      diagnostics.push(new vscode.Diagnostic(
        block.range,
        `${block.kind} ${block.name} could not be fully scoped by workspace analysis.`,
        vscode.DiagnosticSeverity.Information
      ));
    }
  }

  return diagnostics;
}

function sameDocumentUri(left, right) {
  if (!left || !right) {
    return false;
  }

  if (left.toString() === right.toString()) {
    return true;
  }

  if (!left.fsPath || !right.fsPath) {
    return false;
  }

  return normalizeFsPath(left.fsPath) === normalizeFsPath(right.fsPath);
}

function normalizeFsPath(value) {
  const normalized = path.normalize(String(value || ""));
  return process.platform === "linux" ? normalized : normalized.toLowerCase();
}

function analyzeNavBlockBalance(document) {
  const stack = [];
  let unmatchedEnd = undefined;
  let openerCount = 0;
  let endCount = 0;

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
    const line = document.lineAt(lineNumber).text;
    for (const token of navBlockTokens(line)) {
      if (token.kind === "begin" || token.kind === "case") {
        stack.push({ ...token, lineNumber });
        openerCount += 1;
        continue;
      }

      endCount += 1;
      if (stack.length) {
        stack.pop();
      } else if (!unmatchedEnd) {
        unmatchedEnd = { ...token, lineNumber };
      }
    }
  }

  if (!unmatchedEnd && !stack.length) {
    return { balanced: true };
  }

  const problem = unmatchedEnd || stack[stack.length - 1];
  const line = document.lineAt(problem.lineNumber);
  const keywordLength = problem.kind.length;
  const range = new vscode.Range(
    problem.lineNumber,
    problem.character,
    problem.lineNumber,
    Math.min(line.text.length, problem.character + keywordLength)
  );

  return {
    balanced: false,
    range,
    message: `Unbalanced C/AL block keywords (${openerCount} BEGIN/CASE, ${endCount} END).`
  };
}

function navBlockTokens(line) {
  const scrubbed = scrubNavLineForKeywordScan(line);
  const tokens = [];
  const pattern = /\b(BEGIN|CASE|END)\b/gi;
  for (const match of scrubbed.matchAll(pattern)) {
    tokens.push({
      kind: match[1].toLowerCase(),
      character: match.index || 0
    });
  }
  return tokens;
}

function scrubNavLineForKeywordScan(line) {
  const text = String(line || "");
  let result = "";
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inString) {
      if (char === "'" && next === "'") {
        result += "  ";
        index += 1;
        continue;
      }
      if (char === "'") {
        inString = false;
      }
      result += " ";
      continue;
    }

    if (char === "/" && next === "/") {
      result += " ".repeat(text.length - index);
      break;
    }

    if (char === "'") {
      inString = true;
      result += " ";
      continue;
    }

    result += char;
  }

  return result;
}

function diagnosticSeverity(severity) {
  switch (String(severity || "").toLowerCase()) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "information":
    case "info":
      return vscode.DiagnosticSeverity.Information;
    case "hint":
      return vscode.DiagnosticSeverity.Hint;
    default:
      return vscode.DiagnosticSeverity.Warning;
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
