import path from "node:path";

export interface WorkspaceProps {
  name: string;
  location: string;
  scripts?: Record<string, string>;
  isRoot?: boolean;
}

export class Workspace {
  readonly name: string;
  readonly location: string;
  readonly scripts: Record<string, string>;
  readonly isRoot: boolean;

  constructor(props: WorkspaceProps) {
    this.name = props.name;
    this.location = normalizePath(props.location || ".");
    this.scripts = { ...(props.scripts ?? {}) };
    this.isRoot = Boolean(props.isRoot);
  }

  static create(props: WorkspaceProps) {
    return new Workspace(props);
  }

  hasScript(name: string) {
    return Object.prototype.hasOwnProperty.call(this.scripts, name);
  }

  firstScript(candidates: readonly string[]) {
    for (const candidate of candidates) {
      if (this.hasScript(candidate)) return candidate;
    }
    return "";
  }

  listScriptsMatching(predicate: (scriptName: string) => boolean) {
    return Object.keys(this.scripts).filter(predicate);
  }

  ownsFile(filePath: string) {
    if (this.isRoot) return true;
    const normalized = normalizePath(filePath);
    const prefix = this.location.endsWith("/") ? this.location : `${this.location}/`;
    return normalized.startsWith(prefix);
  }

  toJSON(): WorkspaceProps {
    return {
      name: this.name,
      location: this.location,
      scripts: { ...this.scripts },
      isRoot: this.isRoot,
    };
  }
}

function normalizePath(p: string) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/\/+/g, "/");
}
