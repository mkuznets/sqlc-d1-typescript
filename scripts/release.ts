#!/usr/bin/env node
// The release contract: what a valid release identity is, and what the published
// manifest says about the artifact. A release is a SemVer `v*` tag pushed on
// default-branch lineage; there is no rehearsal mode.
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { parseArguments, runAsCli, usageError } from "./candidate-utils.ts";
import { MINIMUM_SQLC_VERSION, TESTED_SQLC_VERSION } from "../src/compatibility.ts";
import { parseSemVer } from "../src/semver.ts";

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const PUBLIC_ORIGIN = "https://sqlc.mkuznets.com/plugins";

export interface ReleaseIntent {
  version: string;
  tag: string;
  sourceCommit: string;
  workflowUrl: string;
}

export interface ResolvedReleaseIntent extends ReleaseIntent {
  isPrerelease: boolean;
}

export interface ReleaseManifest {
  artifact: { filename: string; sha256: string; size: number; url: string };
  source_commit: string;
  tag: string;
  tested_versions: { sqlc: { floor: string; ceiling: string } };
  version: string;
  workflow_url: string;
}

export function parseSemver(value: unknown, { prefixed = false }: { prefixed?: boolean } = {}): string {
  const shape = `${prefixed ? "v" : ""}MAJOR.MINOR.PATCH with an optional SemVer prerelease and no build metadata`;
  if (typeof value !== "string" || (prefixed ? !value.startsWith("v") : value.startsWith("v")))
    throw usageError(`rejected version ${JSON.stringify(value)}; expected ${shape}`);
  const version = prefixed ? value.slice(1) : value;
  // The shared parser takes an optional `v` and keeps build metadata; a release identity
  // allows neither, because two tags would otherwise name the same published artifact.
  const parsed = version.startsWith("v") ? undefined : parseSemVer(version);
  if (!parsed || parsed.build.length > 0)
    throw usageError(`rejected version ${JSON.stringify(value)}; expected ${shape}`);
  return version;
}

export function canonicalWasmFilename(version: string): string {
  return `sqlc-gen-d1-typescript_${parseSemver(version)}.wasm`;
}

export function canonicalManifestFilename(version: string): string {
  return `sqlc-gen-d1-typescript_${parseSemver(version)}.manifest.json`;
}

export function stableJson(value: unknown): string {
  const sort = (item: any): any =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sort(item[key])]),
          )
        : item;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export interface ResolveIntentOptions {
  eventName?: string;
  refType?: string;
  refName?: string;
  sourceCommit?: string;
  defaultBranch?: string;
  workflowRunId?: string;
  serverUrl?: string;
  repository?: string;
  isAncestor: (source: string, branch: string) => Promise<boolean>;
}

export async function resolveReleaseIntent({
  eventName,
  refType,
  refName,
  sourceCommit,
  defaultBranch,
  workflowRunId,
  serverUrl = "https://github.com",
  repository,
  isAncestor,
}: ResolveIntentOptions): Promise<ResolvedReleaseIntent> {
  if (!SOURCE_SHA.test(sourceCommit ?? "")) throw usageError("sourceCommit must be a full 40-character lowercase SHA");
  if (!/^\d+$/.test(workflowRunId ?? "")) throw usageError("workflowRunId must be a decimal string");
  if (!defaultBranch || !repository) throw usageError("defaultBranch and repository are required");
  if (eventName !== "push") throw usageError(`unsupported release event ${eventName}`);
  if (refType !== "tag") throw usageError("release push must use a tag ref");

  const version = parseSemver(refName, { prefixed: true });
  if (!(await isAncestor(sourceCommit!, defaultBranch)))
    throw usageError(`source commit ${sourceCommit} is not reachable from default branch ${defaultBranch}`);

  return {
    version,
    tag: refName!,
    sourceCommit: sourceCommit!,
    workflowUrl: `${serverUrl.replace(/\/$/, "")}/${repository}/actions/runs/${workflowRunId}`,
    isPrerelease: (parseSemVer(version)?.prerelease.length ?? 0) > 0,
  };
}

export function createReleaseManifest({
  intent,
  bytes,
}: {
  intent: ReleaseIntent;
  bytes: Uint8Array;
}): ReleaseManifest {
  const filename = canonicalWasmFilename(intent.version);
  if (parseSemver(intent.tag, { prefixed: true }) !== intent.version)
    throw usageError(`tag ${intent.tag} does not name version ${intent.version}`);
  return {
    artifact: {
      filename,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      url: `${PUBLIC_ORIGIN}/${filename}`,
    },
    source_commit: intent.sourceCommit,
    tag: intent.tag,
    tested_versions: { sqlc: { floor: MINIMUM_SQLC_VERSION, ceiling: TESTED_SQLC_VERSION } },
    version: intent.version,
    workflow_url: intent.workflowUrl,
  };
}

export interface RenderNotesOptions {
  manifest: ReleaseManifest;
  previousTag?: string;
  commits: readonly string[]; // already formatted "- subject (abcdef1)" lines
  repository: string;
  serverUrl?: string;
}

// The release body is generated in full: the manifest is the only source of the facts it
// states, so the advertised URL and digest cannot drift from the bytes R2 receives.
export function renderReleaseNotes({
  manifest,
  previousTag,
  commits,
  repository,
  serverUrl = "https://github.com",
}: RenderNotesOptions): string {
  const configuration = [
    "## Configuration",
    "",
    "```yaml",
    'version: "2"',
    "plugins:",
    "  - name: d1-ts",
    "    wasm:",
    `      url: ${manifest.artifact.url}`,
    `      sha256: ${manifest.artifact.sha256}`,
    "```",
  ].join("\n");

  const noChangesLine = previousTag ? `- No changes since ${previousTag}.` : "- No changes.";
  const changes = [
    previousTag ? "## Changes" : "## Initial release",
    "",
    commits.length > 0 ? commits.join("\n") : noChangesLine,
  ].join("\n");

  const sections = [configuration, changes];
  if (previousTag)
    sections.push(
      `**Full changelog**: ${serverUrl.replace(/\/$/, "")}/${repository}/compare/${previousTag}...${manifest.tag}`,
    );
  return `${sections.join("\n\n")}\n`;
}

function git(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((ok, fail) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", fail);
    child.on("exit", (code) => ok({ code: code ?? 1, stdout, stderr }));
  });
}

// The only two failures that mean "there is no earlier tag". Every other non-zero exit —
// a bad ref, an unreadable object, no repository — is a real failure, and silently
// reading it as a first release would replay the whole history into the notes.
const NO_EARLIER_TAG = /No names found|No tags can describe/;

// Describes from the tag's own commit while excluding the tag itself: a tag on a root
// commit has no `^`, and a tag landing on an already-tagged commit still resolves to that
// tag, which is what renders an empty range as "no changes" rather than replaying commits
// that already shipped.
async function previousReleaseTag(tag: string): Promise<string | undefined> {
  const { code, stdout, stderr } = await git(["describe", "--tags", "--abbrev=0", `--exclude=${tag}`, tag]);
  if (code === 0) return stdout.trim() || undefined;
  if (NO_EARLIER_TAG.test(stderr)) return undefined;
  throw new Error(`git describe ${tag} exited ${code}: ${stderr.trim()}`);
}

async function changelogLines(tag: string, previousTag: string | undefined): Promise<string[]> {
  const range = previousTag ? `${previousTag}..${tag}` : tag;
  const { code, stdout, stderr } = await git(["log", "--no-merges", "--pretty=- %s (%h)", range]);
  if (code !== 0) throw new Error(`git log ${range} exited ${code}: ${stderr.trim()}`);
  return stdout.split("\n").filter((line) => line.length > 0);
}

async function gitAncestor(source: string, branch: string): Promise<boolean> {
  const { code, stderr } = await git(["merge-base", "--is-ancestor", source, `origin/${branch}`]);
  if (code > 1) throw new Error(`git merge-base exited ${code}: ${stderr.trim()}`);
  return code === 0;
}

async function writeStepOutputs(outputs: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(outputs)) console.log(`    ${key}=${value}`);
  const target = process.env.GITHUB_OUTPUT;
  if (target)
    await appendFile(
      target,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
}

async function cli(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "intent") {
    const values = parseArguments(
      rest,
      ["event", "ref-type", "ref-name", "sha", "default-branch", "run-id"],
      ["event", "ref-type", "ref-name", "sha", "default-branch", "run-id", "server-url", "repository"],
    );
    const intent = await resolveReleaseIntent({
      eventName: values.event,
      refType: values["ref-type"],
      refName: values["ref-name"],
      sourceCommit: values.sha,
      defaultBranch: values["default-branch"],
      workflowRunId: values["run-id"],
      serverUrl: values["server-url"],
      repository: values.repository,
      isAncestor: gitAncestor,
    });
    console.log(`==> Releasing tag ${intent.tag} as version ${intent.version}`);
    await writeStepOutputs({
      version: intent.version,
      tag: intent.tag,
      "source-commit": intent.sourceCommit,
      "workflow-url": intent.workflowUrl,
      "wasm-filename": canonicalWasmFilename(intent.version),
      "manifest-filename": canonicalManifestFilename(intent.version),
      "is-prerelease": String(intent.isPrerelease),
    });
  } else if (command === "manifest") {
    const values = parseArguments(
      rest,
      ["wasm", "version", "tag", "source-commit", "workflow-url", "output"],
      ["wasm", "version", "tag", "source-commit", "workflow-url", "output"],
    );
    const bytes = await readFile(resolve(values.wasm));
    const manifest = createReleaseManifest({
      intent: {
        version: parseSemver(values.version),
        tag: values.tag,
        sourceCommit: values["source-commit"],
        workflowUrl: values["workflow-url"],
      },
      bytes,
    });
    const expected = canonicalManifestFilename(manifest.version);
    if (!values.output.endsWith(expected)) throw usageError(`manifest filename must be ${expected}`);
    await writeFile(resolve(values.output), stableJson(manifest));
    console.log(`==> Wrote ${expected}`);
    console.log(`    sha256 ${manifest.artifact.sha256}`);
    console.log(`    size   ${manifest.artifact.size} bytes`);
  } else if (command === "notes") {
    const values = parseArguments(
      rest,
      ["manifest", "repository", "output"],
      ["manifest", "repository", "output", "server-url"],
    );
    const manifest = JSON.parse(await readFile(resolve(values.manifest), "utf8")) as ReleaseManifest;
    const previousTag = await previousReleaseTag(manifest.tag);
    const commits = await changelogLines(manifest.tag, previousTag);
    await writeFile(
      resolve(values.output),
      renderReleaseNotes({
        manifest,
        previousTag,
        commits,
        repository: values.repository,
        serverUrl: values["server-url"],
      }),
    );
    console.log(`==> Wrote ${values.output} for ${manifest.tag}`);
    console.log(`    previous tag ${previousTag ?? "none (first release)"}`);
    console.log(`    commits      ${commits.length}`);
  } else throw usageError(`unknown release command ${command}`);
}

runAsCli(import.meta.url, cli);
