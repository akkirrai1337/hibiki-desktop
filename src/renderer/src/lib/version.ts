/** Basic-semver (x.y.z) comparison; a non-matching string never triggers an update prompt. */
export function isExtensionVersionNewer(remoteVersion: string, installedVersion: string): boolean {
  // Guarded rather than trusted, despite the types. These strings come from manifest JSON on disk
  // or from a third-party repository index, so a missing "version" arrives here as undefined and
  // used to throw on .trim() - taking the whole Sources screen down with it. An empty string got
  // through the filter below as well, since Number("") is 0, not NaN: it read as "0.0.0" and had
  // every source permanently offering an update, which is the opposite of what the line above
  // promises.
  if (typeof remoteVersion !== "string" || typeof installedVersion !== "string") return false;
  if (remoteVersion.trim() === "" || installedVersion.trim() === "") return false;
  const remote = remoteVersion.trim().split(".").map(Number).filter((n) => !Number.isNaN(n));
  const installed = installedVersion.trim().split(".").map(Number).filter((n) => !Number.isNaN(n));
  if (remote.length === 0 || installed.length === 0) return false;
  for (let i = 0; i < Math.max(remote.length, installed.length); i++) {
    const comparison = (remote[i] ?? 0) - (installed[i] ?? 0);
    if (comparison !== 0) return comparison > 0;
  }
  return false;
}

export interface UpdatableExtension {
  id: string;
  version: string;
  type?: string;
  resolverDependencies?: string[];
}

/**
 * Whether an installed source has an update waiting - which includes one of its *resolvers* having
 * one, not just the source itself.
 *
 * Resolvers (kodik, alloha, sibnet, ...) are hidden dependencies: they're fetched only as a side
 * effect of installing the source that declares them, and they never appear in the sources list.
 * So without this, a resolver-only fix could be published and no installed app would ever pick it
 * up - the source's own version hadn't changed, nothing offered an update, and the only way to get
 * it was to uninstall and reinstall the source. Mirrors the Android app's isUpdateAvailable(),
 * which has always counted resolver versions this way.
 */
export function isExtensionUpdateAvailable(
  extension: UpdatableExtension,
  installedVersions: Map<string, string>,
  installedResolverVersions: Record<string, string>,
  allExtensions: UpdatableExtension[],
): boolean {
  const installed = installedVersions.get(extension.id);
  if (installed === undefined) return false;
  if (isExtensionVersionNewer(extension.version, installed)) return true;

  return (extension.resolverDependencies ?? []).some((resolverId) => {
    // Not installed at all is not an update: resolver installs are best-effort, and a source whose
    // resolver never landed shouldn't sit permanently marked as updatable.
    const installedResolver = installedResolverVersions[resolverId];
    if (installedResolver === undefined) return false;
    const available = allExtensions.find((e) => e.id === resolverId && e.type === "player-resolver");
    return available !== undefined && isExtensionVersionNewer(available.version, installedResolver);
  });
}
