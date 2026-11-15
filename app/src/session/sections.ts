/** The Session page's sections, in the order they are shown. */
export const SECTIONS = ["connection", "read", "live", "advanced"] as const;

/** One section of the Session page. */
export type SectionId = (typeof SECTIONS)[number];

/** Each section's title, in the section navigation and as its heading. */
export const SECTION_TITLES: Readonly<Record<SectionId, string>> = {
  connection: "Connection",
  read: "Read",
  live: "Live",
  advanced: "Advanced",
};

/** Which sections are expanded. */
export type OpenSections = ReadonlySet<SectionId>;

/**
 * The sections expanded when the page opens or the connection changes: Connection until there is a connection, then Read; on a wide screen Live too. Advanced is always collapsed until asked for.
 */
export function defaultSections(connected: boolean, wide: boolean): OpenSections {
  const first: SectionId = connected ? "read" : "connection";
  return new Set<SectionId>(wide ? [first, "read", "live"] : [first]);
}

/**
 * The sections expanded after the person presses one in the section navigation.
 *
 * On a narrow screen one section is in view at a time, so pressing a section shows it alone. On a wide screen each press shows or hides that section and leaves the others.
 */
export function pressSection(open: OpenSections, section: SectionId, wide: boolean): OpenSections {
  if (!wide) return new Set([section]);
  const next = new Set(open);
  if (next.has(section)) next.delete(section);
  else next.add(section);
  return next;
}

/** The sections expanded once `section` is brought into view by something other than its own button, such as a "Connect first" note: it is shown, alone on a narrow screen. */
export function showSection(open: OpenSections, section: SectionId, wide: boolean): OpenSections {
  return wide ? new Set([...open, section]) : new Set([section]);
}
