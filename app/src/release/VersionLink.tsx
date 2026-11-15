import { button } from "../ui/Button.css";
import { APP_VERSION, releaseUrl } from "./release";

/**
 * The app's version as a link to its GitHub release. It opens in a new tab: the page is a
 * standalone app, and the release page cannot load offline, so leaving it open behind is kinder.
 */
export function VersionLink({ version = APP_VERSION }: { readonly version?: string }) {
  return (
    <a
      className={button({ variant: "ghost" })}
      href={releaseUrl(version)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Release notes for version ${version}`}
    >
      v{version}
    </a>
  );
}
