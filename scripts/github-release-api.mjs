#!/usr/bin/env node
// The GitHub Releases verbs publication needs, and nothing else. This module knows
// nothing about R2 or ordering; it exists to absorb two traps that would otherwise be
// rediscovered in production: asset downloads redirect to a host that rejects a
// forwarded Authorization header, and an annotated tag ref points at a tag object
// rather than at a commit.
import { redactSecrets, redactedExcerpt } from "./publication-contract.mjs";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const VERSION = "2022-11-28";
const PAGE_LIMIT = 100;

function apiError(message) {
  const error = new Error(message);
  error.exitCode = 1;
  return error;
}

function assertRepository(repository) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(repository ?? ""))) throw apiError("a repository as owner/name is required");
  return repository;
}

async function excerpt(response, token) {
  try {
    return redactedExcerpt(await response.text(), [token]);
  } catch {
    return "<response body unavailable>";
  }
}

// Release and asset IDs are opaque decimal strings. Quote numeric `id` tokens before
// parsing so an ID beyond JavaScript's safe-integer range is never rounded.
function parseIdSafeJson(source) {
  try {
    return JSON.parse(source.replace(/("id"\s*:\s*)(\d+)/g, '$1"$2"'));
  } catch {
    throw apiError("GitHub returned malformed JSON");
  }
}

async function call({
  method = "GET",
  url,
  token,
  body,
  fetchImpl = fetch,
  signal,
  accept = "application/vnd.github+json",
}) {
  if (!token) throw apiError("a GitHub token is required");
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        "x-github-api-version": VERSION,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw apiError(`GitHub ${method} ${url} could not be reached: ${redactSecrets(error?.message ?? error, [token])}`);
  }
  return response;
}

async function json({ action, ...options }) {
  const response = await call(options);
  if (!response.ok)
    throw apiError(`${action} failed with HTTP ${response.status}: ${await excerpt(response, options.token)}`);
  return parseIdSafeJson(await response.text());
}

// Tri-state, because "unreadable" is not "disabled". Reading this setting needs the
// Administration permission, which a job-scoped GITHUB_TOKEN cannot hold — Actions has
// no such permission scope to request — so a 403 is the normal answer from inside a
// workflow and the manual audit checklist is what covers it.
export async function getImmutableReleases({ repository, token, fetchImpl, signal }) {
  assertRepository(repository);
  const response = await call({ url: `${API}/repos/${repository}/immutable-releases`, token, fetchImpl, signal });
  if (response.status === 403 || response.status === 404)
    return { enabled: false, enforced_by_owner: false, readable: false };
  if (!response.ok)
    throw apiError(
      `reading the immutable-releases setting failed with HTTP ${response.status}: ${await excerpt(response, token)}`,
    );
  const value = parseIdSafeJson(await response.text());
  if (typeof value?.enabled !== "boolean") throw apiError("the immutable-releases setting was malformed");
  return { enabled: value.enabled, enforced_by_owner: value.enforced_by_owner === true, readable: true };
}

async function listPaged({ action, url, token, fetchImpl, signal }) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const separator = url.includes("?") ? "&" : "?";
    const body = await json({
      action,
      url: `${url}${separator}per_page=${PAGE_LIMIT}&page=${page}`,
      token,
      fetchImpl,
      signal,
    });
    if (!Array.isArray(body)) throw apiError(`${action} did not return a list`);
    items.push(...body);
    if (body.length < PAGE_LIMIT) return items;
  }
  throw apiError(`${action} exceeded the pagination limit`);
}

// Drafts are invisible to `GET /releases/tags/:tag`, so a draft is found by listing.
export async function findDraftRelease({ repository, tagName, token, fetchImpl, signal }) {
  assertRepository(repository);
  const releases = await listPaged({
    action: "listing releases",
    url: `${API}/repos/${repository}/releases`,
    token,
    fetchImpl,
    signal,
  });
  const matching = releases.filter((release) => release?.tag_name === tagName);
  if (matching.length > 1) throw apiError(`GitHub holds ${matching.length} releases for tag ${tagName}`);
  return matching[0] ?? null;
}

export async function getRelease({ repository, releaseId, token, fetchImpl, signal }) {
  assertRepository(repository);
  return json({
    action: `reading release ${releaseId}`,
    url: `${API}/repos/${repository}/releases/${releaseId}`,
    token,
    fetchImpl,
    signal,
  });
}

export async function createDraftRelease({
  repository,
  tagName,
  targetCommitish,
  name,
  body,
  prerelease = false,
  token,
  fetchImpl,
  signal,
}) {
  assertRepository(repository);
  return json({
    action: `creating the draft release for ${tagName}`,
    method: "POST",
    url: `${API}/repos/${repository}/releases`,
    token,
    fetchImpl,
    signal,
    body: { tag_name: tagName, target_commitish: targetCommitish, name, body, draft: true, prerelease },
  });
}

export async function listReleaseAssets({ repository, releaseId, token, fetchImpl, signal }) {
  assertRepository(repository);
  return listPaged({
    action: `listing assets of release ${releaseId}`,
    url: `${API}/repos/${repository}/releases/${releaseId}/assets`,
    token,
    fetchImpl,
    signal,
  });
}

export async function uploadReleaseAsset({
  repository,
  releaseId,
  name,
  contentType,
  bytes,
  token,
  fetchImpl = fetch,
  signal,
}) {
  assertRepository(repository);
  const url = `${UPLOADS}/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": contentType,
        "x-github-api-version": VERSION,
      },
      body: bytes,
      signal,
    });
  } catch (error) {
    throw apiError(`uploading asset ${name} could not be reached: ${redactSecrets(error?.message ?? error, [token])}`);
  }
  if (!response.ok)
    throw apiError(`uploading asset ${name} failed with HTTP ${response.status}: ${await excerpt(response, token)}`);
  return parseIdSafeJson(await response.text());
}

// The asset endpoint answers 302 to objects.githubusercontent.com, which rejects a
// forwarded Authorization header. Follow the hop by hand, unauthenticated.
export async function downloadReleaseAsset({ repository, assetId, token, fetchImpl = fetch, signal }) {
  assertRepository(repository);
  const url = `${API}/repos/${repository}/releases/assets/${assetId}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/octet-stream",
        authorization: `Bearer ${token}`,
        "x-github-api-version": VERSION,
      },
      redirect: "manual",
      signal,
    });
  } catch (error) {
    throw apiError(
      `downloading asset ${assetId} could not be reached: ${redactSecrets(error?.message ?? error, [token])}`,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw apiError(`downloading asset ${assetId} redirected without a location header`);
    let followed;
    try {
      followed = await fetchImpl(location, { method: "GET", signal });
    } catch (error) {
      throw apiError(
        `downloading asset ${assetId} from storage could not be reached: ${redactSecrets(error?.message ?? error, [token])}`,
      );
    }
    if (!followed.ok)
      throw apiError(
        `downloading asset ${assetId} from storage failed with HTTP ${followed.status}: ${await excerpt(followed, token)}`,
      );
    return Buffer.from(await followed.arrayBuffer());
  }
  if (!response.ok)
    throw apiError(
      `downloading asset ${assetId} failed with HTTP ${response.status}: ${await excerpt(response, token)}`,
    );
  return Buffer.from(await response.arrayBuffer());
}

export async function deleteReleaseAsset({ repository, assetId, token, fetchImpl, signal }) {
  assertRepository(repository);
  const response = await call({
    method: "DELETE",
    url: `${API}/repos/${repository}/releases/assets/${assetId}`,
    token,
    fetchImpl,
    signal,
  });
  if (!response.ok && response.status !== 404)
    throw apiError(`deleting asset ${assetId} failed with HTTP ${response.status}: ${await excerpt(response, token)}`);
  return { status: response.status };
}

export async function publishRelease({ repository, releaseId, makeLatest = "true", token, fetchImpl, signal }) {
  assertRepository(repository);
  return json({
    action: `publishing release ${releaseId}`,
    method: "PATCH",
    url: `${API}/repos/${repository}/releases/${releaseId}`,
    token,
    fetchImpl,
    signal,
    body: { draft: false, make_latest: makeLatest },
  });
}

export async function deleteRelease({ repository, releaseId, token, fetchImpl, signal }) {
  assertRepository(repository);
  const response = await call({
    method: "DELETE",
    url: `${API}/repos/${repository}/releases/${releaseId}`,
    token,
    fetchImpl,
    signal,
  });
  if (!response.ok && response.status !== 404)
    throw apiError(
      `deleting release ${releaseId} failed with HTTP ${response.status}: ${await excerpt(response, token)}`,
    );
  return { status: response.status };
}

// An annotated tag ref points at a tag object; only its dereferenced target is
// comparable with the source commit the gate verified.
export async function resolveTagCommit({ repository, tagName, token, fetchImpl, signal }) {
  assertRepository(repository);
  const response = await call({
    url: `${API}/repos/${repository}/git/ref/tags/${encodeURIComponent(tagName)}`,
    token,
    fetchImpl,
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw apiError(`reading tag ${tagName} failed with HTTP ${response.status}: ${await excerpt(response, token)}`);
  const ref = parseIdSafeJson(await response.text());
  const object = ref?.object;
  if (typeof object?.sha !== "string") throw apiError(`the ref for tag ${tagName} was malformed`);
  if (object.type !== "tag") return object.sha;
  const annotated = await json({
    action: `dereferencing annotated tag ${tagName}`,
    url: `${API}/repos/${repository}/git/tags/${object.sha}`,
    token,
    fetchImpl,
    signal,
  });
  if (typeof annotated?.object?.sha !== "string") throw apiError(`the annotated tag ${tagName} was malformed`);
  return annotated.object.sha;
}
