import { describe, expect, it } from "vitest";
import { FFYC_COMMAND, listToolkitCommands, resolveCommand } from "../../src/lib/commands";

describe("commands registry", () => {
  it("resolves a toolkit command alias with defaults", () => {
    const instance = resolveCommand("gfo");
    expect(instance.command).toBe("git fetch origin --prune");
    expect(instance.label).toBe("git fetch origin --prune");
    expect(instance.toolkit).toBe(true);
  });

  it("applies context overrides when resolving commands", () => {
    const instance = resolveCommand("grb", { target: "origin/main", autostash: false });
    expect(instance.command).toBe("git rebase origin/main");
    expect(instance.label).toBe("git rebase origin/main");
  });

  it("returns toolkit definitions sorted alphabetically", () => {
    const aliases = listToolkitCommands().map(entry => entry.alias);
    const sorted = [...aliases].sort();
    expect(aliases).toEqual(sorted);
  });

  it("exposes helper builders for deep-clean command", () => {
    const instance = resolveCommand("ffyc");
    expect(instance.command).toBe(FFYC_COMMAND);
  });

  it("throws when the alias is unknown", () => {
    expect(() => resolveCommand("not-a-command" as any)).toThrow(/Unknown command alias/);
  });
});
