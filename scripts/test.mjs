import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

// 既存の TypeScript と Node 標準テストだけを使う。追加依存・ソース横への生成物は不要。
const root = path.resolve(import.meta.dirname, "..");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "sd2608-tests-"));
try {
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options, noEmit: false, allowImportingTsExtensions: false,
    outDir: output, rootDir: path.join(root, "src"), incremental: false, composite: false,
  });
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => "\n",
    }));
    process.exitCode = 1;
  } else {
    const emitted = program.emit();
    if (emitted.emitSkipped) throw new Error("TypeScript の出力に失敗しました。");
    fs.writeFileSync(path.join(output, "package.json"), JSON.stringify({ type: "module" }));
    const tests = fs.readdirSync(path.join(root, "tests")).filter(name => name.endsWith(".test.mjs")).sort();
    if (!tests.length) throw new Error("テストファイルがありません。");
    const result = spawnSync(process.execPath, ["--test", ...tests.map(name => path.join(root, "tests", name))], {
      cwd: root, stdio: "inherit", env: { ...process.env, SD2608_TEST_BUILD: output },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} finally {
  const resolved = path.resolve(output);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("sd2608-tests-"))
    throw new Error("一時出力先が想定外です。");
  fs.rmSync(resolved, { recursive: true, force: true });
}
