export class CommandAliasRegistry {
  private readonly aliases: Record<string, string>;

  constructor(aliases: Record<string, string>) {
    this.aliases = { ...aliases };
  }

  resolve(alias: string): string | undefined {
    return this.aliases[alias];
  }

  getAll(): Record<string, string> {
    return { ...this.aliases };
  }
}
