import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const TSC = join(import.meta.dirname, "node_modules", "typescript", "bin", "tsc");

const tsc = async (...args: string[]): Promise<void> => {
  await run(process.execPath, [TSC, "-p", "tsconfig.build.json", ...args], {
    cwd: import.meta.dirname,
  });
};

rmSync(join(import.meta.dirname, "dist"), { recursive: true, force: true });
await tsc("--removeComments", "--declaration", "false");
await tsc("--emitDeclarationOnly");
