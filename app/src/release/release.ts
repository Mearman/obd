/** The repository the app is built from: the one place its address is written. */
export const REPOSITORY_URL = "https://github.com/Mearman/obd";

/** The version the app was built from. */
export const APP_VERSION: string = __APP_VERSION__;

/**
 * The address of the GitHub release for a version, which the release workflow tags `v<version>`.
 *
 * @param version A version without a leading `v`.
 * @returns The release page's URL.
 */
export function releaseUrl(version: string): string {
  return `${REPOSITORY_URL}/releases/tag/v${version}`;
}
