#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { usageError } from "./candidate-utils.mjs";

const ID = /^\d+$/;
function apiError(message) { return usageError(`Actions artifact lookup failed: ${message}`); }
function validatePage(value) {
  if (!value || !Array.isArray(value.artifacts) || !Number.isSafeInteger(value.total_count) || value.total_count < 0) throw apiError("GitHub returned malformed JSON");
  for (const artifact of value.artifacts) if (!artifact || !ID.test(String(artifact.id ?? "")) || typeof artifact.name !== "string" || typeof artifact.expired !== "boolean") throw apiError("GitHub returned a malformed artifact record");
}
export async function listRunArtifacts({ owner, repo, runId, name, prefix, token, fetchImpl = fetch, signal } = {}) {
  if (!owner || !repo || !ID.test(runId ?? "") || (!name && !prefix) || (name && prefix) || !token) throw apiError("owner, repo, decimal run ID, exactly one name/prefix selector, and token are required");
  const artifacts = []; let page = 1; let total;
  do {
    const filter = name ? `name=${encodeURIComponent(name)}&` : ""; const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/artifacts?${filter}per_page=100&page=${page}`;
    let response; try { response = await fetchImpl(endpoint, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" }, signal }); } catch (error) { throw apiError(error instanceof Error ? error.message.replaceAll(token, "[REDACTED]") : "request failed"); }
    if (!response?.ok) throw apiError(`GitHub returned HTTP ${response?.status ?? "unknown"}`);
    let body; try {
      // Artifact IDs are opaque decimal strings. Quote numeric JSON tokens before
      // parsing so IDs beyond JavaScript's safe-integer range are never rounded.
      const source = await response.text(); body = JSON.parse(source.replace(/("id"\s*:\s*)(\d+)/g, '$1"$2"'));
    } catch { throw apiError("GitHub returned malformed JSON"); }
    validatePage(body); total ??= body.total_count; if (total !== body.total_count) throw apiError("pagination total changed during lookup"); artifacts.push(...body.artifacts); page++;
    if (page > 1000) throw apiError("pagination limit exceeded");
  } while (artifacts.length < total);
  if (artifacts.length !== total) throw apiError("pagination result count mismatch");
  return prefix ? artifacts.filter((artifact) => artifact.name.startsWith(prefix)) : artifacts;
}
export async function selectPassingManagedEvidence(artifacts, validateArtifact) {
  if (typeof validateArtifact !== "function") throw apiError("managed evidence validator is required");
  const ordered = artifacts.filter(({ expired }) => !expired).sort((left, right) => Number(right.name.match(/-(\d+)$/)?.[1] ?? 0) - Number(left.name.match(/-(\d+)$/)?.[1] ?? 0));
  for (const artifact of ordered) { const valid = await validateArtifact(artifact); if (valid) return { mode: "reuse", artifactId: String(artifact.id), name: artifact.name, remoteDate: valid.remoteDate }; }
  return { mode: "create" };
}
export function selectExactRunArtifact(artifacts, name, { allowCreate = true } = {}) {
  const exact = artifacts.filter((artifact) => artifact.name === name);
  if (exact.length === 0) {
    if (!allowCreate) throw apiError(`artifact ${name} is missing; start a new workflow run`);
    return { mode: "create" };
  }
  if (exact.length > 1) throw apiError(`duplicate artifacts named ${name}`);
  if (exact[0].expired) throw apiError(`artifact ${name} is expired; start a new workflow run`);
  return { mode: "reuse", artifactId: String(exact[0].id), name };
}
export function parseRunArtifactList(source) { let value; try { value = JSON.parse(source); } catch { throw apiError("artifact list is malformed JSON"); } if (!Array.isArray(value)) throw apiError("artifact list must be an array"); validatePage({ artifacts: value, total_count: value.length }); return value; }
function argumentsOf(argv) { const out = {}; for (let i = 0; i < argv.length; i += 2) { if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) throw usageError("arguments must be --name value pairs"); out[argv[i].slice(2)] = argv[i + 1]; } return out; }
async function cli() {
  const values = argumentsOf(process.argv.slice(2)); const token = process.env.GITHUB_TOKEN; const [owner, repo] = (values.repository ?? "").split("/");
  const allowCreate = values["allow-create"] === undefined ? true : values["allow-create"] === "true" ? true : values["allow-create"] === "false" ? false : (() => { throw usageError("--allow-create must be true or false"); })();
  const artifacts = await listRunArtifacts({ owner, repo, runId: values["run-id"], name: values.name, prefix: values.prefix, token });
  if (values.prefix) {
    const json = `${JSON.stringify(artifacts, null, 2)}\n`; if (values.output) await writeFile(resolve(values.output), json, { mode: 0o600 }); else process.stdout.write(json);
    return;
  }
  const selected = selectExactRunArtifact(artifacts, values.name, { allowCreate });
  const json = `${JSON.stringify(selected, null, 2)}\n`; if (values.output) await writeFile(resolve(values.output), json, { mode: 0o600 }); else process.stdout.write(json);
  if (values["github-output"]) await appendFile(resolve(values["github-output"]), `mode=${selected.mode}\nartifact-id=${selected.artifactId ?? ""}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void cli().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = error?.exitCode ?? 1; });
