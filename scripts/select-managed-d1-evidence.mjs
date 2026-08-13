#!/usr/bin/env node
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseRunArtifactList, selectPassingManagedEvidence } from "./github-run-artifacts.mjs";
import { validateManagedD1Evidence } from "./managed-d1-contract.mjs";
import { loadCompatibilityConfig } from "./compatibility-config.mjs";
function args(argv) { const out = {}; for (let i=0;i<argv.length;i+=2) out[argv[i].replace(/^--/,"")] = argv[i+1]; return out; }
async function cli() {
  const values=args(process.argv.slice(2)), token=process.env.GITHUB_TOKEN, artifacts=parseRunArtifactList(await readFile(resolve(values.artifacts),"utf8")), [owner,repo]=values.repository.split("/"), config=await loadCompatibilityConfig();
  const selection=await selectPassingManagedEvidence(artifacts, async (artifact) => { const dir=await mkdtemp(resolve(tmpdir(),"managed-evidence-")); try { const response=await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${artifact.id}/zip`,{headers:{authorization:`Bearer ${token}`}}); if(!response.ok)return null; const zip=resolve(dir,"artifact.zip"); await writeFile(zip,Buffer.from(await response.arrayBuffer())); const { execFileSync }=await import("node:child_process"); execFileSync("unzip",["-q",zip,"-d",dir]); const evidence=await validateManagedD1Evidence({path:resolve(dir,"managed-d1-evidence.json"),candidateSha256:values.sha256,sourceCommit:values["source-commit"],runId:values["run-id"],runUrl:`https://github.com/${values.repository}/actions/runs/${values["run-id"]}`,trigger:values.trigger,config,requirePassing:true}); return {remoteDate:evidence.run.remoteDate}; } catch { return null; } finally { await rm(dir,{recursive:true,force:true}); } });
  await writeFile(resolve(values.output),`${JSON.stringify(selection,null,2)}\n`); if(values["github-output"]) await appendFile(resolve(values["github-output"]),`mode=${selection.mode}\nartifact-id=${selection.artifactId??""}\nremote-date=${selection.remoteDate??""}\n`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void cli().catch(error=>{console.error(error.message);process.exitCode=1});
