// SemVer parsing and precedence, shared by the plugin's sqlc-version check and the
// release identity check. Build metadata is parsed and carried but never affects
// precedence, so a caller that must reject it can see that it was there.

export interface SemVer {
  core: [string, string, string];
  prerelease: string[];
  build: string[];
}

export function parseSemVer(value: string): SemVer | undefined {
  const match =
    /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")))
    return undefined;
  return { core: [match[1], match[2], match[3]], prerelease, build: match[5]?.split(".") ?? [] };
}

export function compareSemVer(left: SemVer, right: SemVer): number {
  for (let index = 0; index < 3; index++) {
    const comparison = compareNumericText(left.core[index], right.core[index]);
    if (comparison !== 0) return comparison;
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const comparison = compareNumericText(a, b);
      if (comparison !== 0) return comparison;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else {
      const comparison = compareText(a, b);
      if (comparison !== 0) return comparison;
    }
  }
  return 0;
}

function compareNumericText(left: string, right: string): number {
  return left.length - right.length || compareText(left, right);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
