const path = require("path");
const vscode = require("vscode");

const OBJECT_GROUPS = ["Page", "Table", "Report", "Codeunit", "Query", "XMLport", "MenuSuite", "All"];

class NavObjectNavigatorProvider {
  constructor(navIndex) {
    this.navIndex = navIndex;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.disposable = navIndex.onDidChangeObjects(() => this.refresh());
    this.cachedObjects = [];
    this.versionTagFilter = "";
  }

  dispose() {
    this.disposable.dispose();
    this._onDidChangeTreeData.dispose();
  }

  refresh() {
    this.cachedObjects = [];
    this._onDidChangeTreeData.fire();
  }

  setVersionTagFilter(versionTag) {
    this.versionTagFilter = String(versionTag || "").trim();
    this._onDidChangeTreeData.fire();
  }

  clearVersionTagFilter() {
    this.setVersionTagFilter("");
  }

  getVersionTagFilter() {
    return this.versionTagFilter;
  }

  getTreeItem(element) {
    if (element.kind === "group") {
      const item = new vscode.TreeItem(
        `${element.type} (${element.count})${this.versionTagFilter ? ` - ${this.versionTagFilter}` : ""}`,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.contextValue = "navObjectGroup";
      item.iconPath = new vscode.ThemeIcon(groupIconForType(element.type));
      return item;
    }

    const navObject = element.object;
    const item = new vscode.TreeItem(
      `${navObject.type} ${navObject.id}  ${navObject.name}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = [lastVersionTag(navObject.versionList), navObject.date].filter(Boolean).join("  ");
    item.tooltip = objectTooltip(navObject);
    item.contextValue = "navObject";
    item.iconPath = new vscode.ThemeIcon(iconForType(navObject.type));
    item.resourceUri = navObject.uri;
    item.command = {
      command: "navDevAssistant.openObject",
      title: "Open NAV Object",
      arguments: [navObject]
    };
    return item;
  }

  async getChildren(element) {
    if (!element) {
      this.cachedObjects = this.filterObjectsByVersionTag(await this.navIndex.getObjects());
      return OBJECT_GROUPS
        .map((type) => ({
          kind: "group",
          type,
          count: type === "All"
            ? this.cachedObjects.length
            : this.cachedObjects.filter((object) => object.type.toLowerCase() === type.toLowerCase()).length
        }))
        .filter((group) => group.type === "All" || group.count > 0);
    }

    if (element.kind !== "group") {
      return [];
    }

    const objects = this.filterObjectsByVersionTag(await this.navIndex.getObjects());
    const filtered = element.type === "All"
      ? objects
      : objects.filter((object) => object.type.toLowerCase() === element.type.toLowerCase());

    return filtered.map((object) => ({ kind: "object", object }));
  }

  filterObjectsByVersionTag(objects) {
    if (!this.versionTagFilter) {
      return objects;
    }

    return objects.filter((object) => versionListContainsTag(object.versionList, this.versionTagFilter));
  }
}

async function openNavObject(navObject) {
  if (navObject?.kind === "object") {
    navObject = navObject.object;
  }

  if (!navObject?.uri) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(navObject.uri);
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Active
  });
  if (navObject.range) {
    editor.selection = new vscode.Selection(navObject.range.start, navObject.range.start);
    editor.revealRange(navObject.range, vscode.TextEditorRevealType.InCenter);
  }
}

function objectTooltip(navObject) {
  const parts = [
    `**${navObject.type} ${navObject.id} ${navObject.name}**`,
    "",
    navObject.versionList ? `Version List: ${navObject.versionList}` : undefined,
    navObject.date ? `Date: ${navObject.date}` : undefined,
    navObject.time ? `Time: ${navObject.time}` : undefined,
    navObject.modified ? `Modified: ${navObject.modified}` : undefined,
    "",
    path.basename(navObject.uri.fsPath)
  ].filter((part) => part !== undefined);

  return new vscode.MarkdownString(parts.join("\n\n"));
}

function lastVersionTag(versionList) {
  const tags = String(versionList || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length ? tags[tags.length - 1] : "";
}

function versionListContainsTag(versionList, versionTag) {
  const normalizedTag = String(versionTag || "").trim().toLowerCase();
  if (!normalizedTag) {
    return true;
  }

  const normalizedVersionList = String(versionList || "").toLowerCase();
  if (!normalizedVersionList) {
    return false;
  }

  return normalizedVersionList
    .split(",")
    .some((tag) => tag.trim().toLowerCase() === normalizedTag)
    || normalizedVersionList.includes(normalizedTag);
}

function iconForType(type) {
  switch (String(type || "").toLowerCase()) {
    case "page":
      return "layout";
    case "table":
      return "table";
    case "report":
      return "graph";
    case "codeunit":
      return "symbol-method";
    case "query":
      return "search";
    case "xmlport":
      return "file-code";
    case "menusuite":
      return "list-tree";
    default:
      return "symbol-class";
  }
}

function groupIconForType(type) {
  return type === "All" ? "list-unordered" : iconForType(type);
}

module.exports = {
  NavObjectNavigatorProvider,
  openNavObject
};
