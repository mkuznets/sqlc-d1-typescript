// @ts-expect-error javy/fs is provided by the Javy runtime.
import { readFileSync, writeFileSync, STDIO } from "javy/fs";

import { GenerateRequest } from "./gen/plugin/codegen_pb";
import { generate } from "./generator";

const input = GenerateRequest.fromBinary(readFileSync(STDIO.Stdin));
const output = generate(input);
writeFileSync(STDIO.Stdout, new Uint8Array(output.toBinary()));
