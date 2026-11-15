import { SECTIONS, SECTION_TITLES, type OpenSections, type SectionId } from "./sections";
import { nav, navButton } from "./session.css";

/** The id of a section's element, which the navigation's buttons control. */
export function sectionElementId(section: SectionId): string {
  return `session-${section}`;
}

/** A button per Session section, each showing whether its section is expanded and expanding or collapsing it. */
export function SectionNav({
  open,
  onPress,
}: {
  readonly open: OpenSections;
  readonly onPress: (section: SectionId) => void;
}) {
  return (
    <nav className={nav} aria-label="Session sections">
      {SECTIONS.map((section) => (
        <button
          key={section}
          type="button"
          className={navButton}
          aria-expanded={open.has(section)}
          aria-controls={sectionElementId(section)}
          onClick={() => {
            onPress(section);
          }}
        >
          {SECTION_TITLES[section]}
        </button>
      ))}
    </nav>
  );
}
