export interface MockRunResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  code?: number;
}

export interface MockShellInvocation {
  command: string;
  label: string;
}

type ResponseFactory = () => MockRunResult | Promise<MockRunResult>;

type Response = MockRunResult | ResponseFactory;

export class MockShellExecutor {
  private readonly responses = new Map<string, Response>();
  private readonly invocations: MockShellInvocation[] = [];

  when(command: string, response: Response) {
    this.responses.set(command, response);
    return this;
  }

  async run(command: string, label = command): Promise<MockRunResult> {
    this.invocations.push({ command, label });
    const response = this.responses.get(command);
    if (!response) {
      return { ok: true, stdout: "", stderr: "" };
    }
    return typeof response === "function" ? await (response as ResponseFactory)() : response;
  }

  calls() {
    return [...this.invocations];
  }

  clear() {
    this.responses.clear();
    this.invocations.splice(0, this.invocations.length);
  }

  static ok(overrides: Partial<MockRunResult> = {}): MockRunResult {
    return {
      ok: true,
      stdout: "",
      stderr: "",
      code: 0,
      ...overrides,
    };
  }

  static fail(overrides: Partial<MockRunResult> = {}): MockRunResult {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      code: overrides.code ?? 1,
      ...overrides,
    };
  }
}
