// @ts-expect-error javy/fs is provided by the Javy runtime.
import { readFileSync, writeFileSync, STDIO } from "javy/fs";

import { runPlugin } from "./plugin";

const result = runPlugin(readFileSync(STDIO.Stdin));
if (result.stderr) {
  const diagnostic = result.ok ? result.stderr : result.stderr.slice(0, -1);
  writeFileSync(STDIO.Stderr, new TextEncoder().encode(diagnostic));
}
if (!result.ok) throw "";
writeFileSync(STDIO.Stdout, result.stdout);
