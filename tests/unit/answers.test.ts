import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPushAnswers } from "../../src/lib/answers";
import { createTempDir } from "../support";

describe("loadPushAnswers", () => {
  it("parses nested YAML push nodes", async () => {
    const dir = await createTempDir();
    const file = path.join(dir, "pan.answers.yaml");
    const yaml = `push:
  branch:
    prefix: feat
    name: sample-refactor
  commit:
    subject: 'chore: hydrate'
    body: |-
      add more tests
      and keep coverage high
`;

    await writeFile(file, yaml, "utf8");

    const answers = await loadPushAnswers(file);
    expect(answers).toMatchObject({
      sourcePath: file,
      branchPrefix: "feat",
      branchName: "sample-refactor",
      commitFirstLine: "chore: hydrate",
      commitBody: "add more tests\nand keep coverage high",
    });
  });

  it("falls back to top-level properties", async () => {
    const dir = await createTempDir();
    const file = path.join(dir, "answers.json");
    await writeFile(
      file,
      JSON.stringify({
        branchPrefix: "docs",
        branchName: "update-readme",
        commitFirstLine: "docs: refresh readme",
      }),
      "utf8"
    );

    const answers = await loadPushAnswers(file);
    expect(answers).toMatchObject({
      branchPrefix: "docs",
      branchName: "update-readme",
      commitFirstLine: "docs: refresh readme",
      commitBody: undefined,
    });
  });

  it("throws a descriptive error when the file is missing", async () => {
    await expect(loadPushAnswers("./does-not-exist.yaml"))
      .rejects.toThrow(/Answers file not found/);
  });
});
