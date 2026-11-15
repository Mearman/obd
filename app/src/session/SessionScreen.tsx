import { useEffect, useRef, useState, type ReactNode } from "react";
import { CaptureCard } from "../captures/CaptureCard";
import type { BrowserSupport } from "../connect/support";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { SectionBoundary } from "../report";
import { AdvancedSection } from "../screens/scan/AdvancedSection";
import { ReadCard } from "../screens/scan/ReadCard";
import { page } from "../screens/screen.css";
import { ScreenHeading } from "../screens/ScreenHeading";
import { ConnectFirst } from "./ConnectFirst";
import { ConnectionSummary } from "./ConnectionSummary";
import { ConnectPanel } from "./ConnectPanel";
import { LivePanel } from "./LivePanel";
import { SectionNav, sectionElementId } from "./SectionNav";
import {
  SECTION_TITLES,
  defaultSections,
  pressSection,
  showSection,
  type OpenSections,
  type SectionId,
} from "./sections";
import { bar, fullWidth, section as sectionStyle, sectionTitle, sections } from "./session.css";
import { useHeaderOffset } from "./useHeaderOffset";
import { useWideLayout } from "./useWideLayout";

/** Where the Advanced and Read sections tell the person to stop a run that holds the adapter. */
const STOP_RUN_HINT = "Stop it in the Live section.";

/** The gap left between the sticky bar and a section brought into view, in CSS pixels. */
const SCROLL_GAP = 8;

/** Props of {@link SessionScreen}. */
export interface SessionScreenProps {
  readonly support: BrowserSupport;
  /** Called with a capture's id once it is stored, to open it. */
  readonly onCaptured?: (id: string) => void;
  /** Each change shows the Connection section, as when another screen sends the person here to connect. */
  readonly connectRequest?: number;
}

interface Layout {
  readonly connected: boolean;
  readonly wide: boolean;
  readonly connectRequest: number;
  readonly open: OpenSections;
}

/**
 * Session: everything done with one car on one connection, in sections that follow it. Connection chooses the profile and adapter and, once connected, sums the connection up in the sticky bar; Read scans and captures; Live collects; Advanced holds the guarded operations that change the car.
 *
 * Every section stays mounted while it is collapsed, so a scan's results, a typed write request and a run's table survive moving between sections and between screens.
 */
export function SessionScreen({ support, onCaptured, connectRequest = 0 }: SessionScreenProps) {
  const { connection } = useDiagnostics();
  const connected = connection !== undefined;
  const wide = useWideLayout();
  const headerOffset = useHeaderOffset();
  const barRef = useRef<HTMLDivElement>(null);
  const [scrollTo, setScrollTo] = useState<{ readonly section: SectionId } | undefined>(undefined);

  // Adjusted while rendering, as React advises for state derived from a changing input: a new
  // connection or layout starts from the default sections, and a request to connect shows Connection.
  const [layout, setLayout] = useState<Layout>({
    connected,
    wide,
    connectRequest,
    open: defaultSections(connected, wide),
  });
  if (layout.connected !== connected || layout.wide !== wide) {
    setLayout({ connected, wide, connectRequest, open: defaultSections(connected, wide) });
  } else if (layout.connectRequest !== connectRequest) {
    setLayout({ ...layout, connectRequest, open: showSection(layout.open, "connection", wide) });
  }
  const { open } = layout;

  useEffect(() => {
    if (scrollTo === undefined) return;
    const element = document.getElementById(sectionElementId(scrollTo.section));
    if (element === null || barRef.current === null) return;
    const below = headerOffset + barRef.current.offsetHeight + SCROLL_GAP;
    element.style.scrollMarginTop = `${String(below)}px`;
    element.scrollIntoView({ block: "start" });
  }, [scrollTo, headerOffset]);

  function press(section: SectionId): void {
    setLayout({ ...layout, open: pressSection(open, section, wide) });
    setScrollTo({ section });
  }

  function openConnection(): void {
    setLayout({ ...layout, open: showSection(open, "connection", wide) });
    setScrollTo({ section: "connection" });
  }

  function area(
    id: SectionId,
    content: ReactNode,
    options: { readonly needs?: string; readonly full?: boolean } = {},
  ) {
    const titleId = `${sectionElementId(id)}-title`;
    return (
      <section
        id={sectionElementId(id)}
        className={options.full === true ? `${sectionStyle} ${fullWidth}` : sectionStyle}
        aria-labelledby={titleId}
        hidden={!open.has(id)}
      >
        <h2 id={titleId} className={sectionTitle}>
          {SECTION_TITLES[id]}
        </h2>
        <SectionBoundary
          section={id}
          {...(id === "connection" ? {} : { onGoToConnect: openConnection })}
        >
          {!connected && options.needs !== undefined && (
            <ConnectFirst needs={options.needs} onConnect={openConnection} />
          )}
          {content}
        </SectionBoundary>
      </section>
    );
  }

  return (
    <div className={page}>
      <ScreenHeading simulated={connection?.simulated === true}>Session</ScreenHeading>
      <div ref={barRef} className={bar} style={{ top: headerOffset }}>
        <ConnectionSummary />
        <SectionNav open={open} onPress={press} />
      </div>
      <div className={sections}>
        {area("connection", <ConnectPanel support={support} />, { full: true })}
        {area(
          "read",
          <>
            <ReadCard stopRunHint={STOP_RUN_HINT} />
            <CaptureCard {...(onCaptured === undefined ? {} : { onSaved: onCaptured })} />
          </>,
          { needs: "scanning and capturing" },
        )}
        {area("live", <LivePanel />, { needs: "collecting live values" })}
        {area("advanced", <AdvancedSection stopRunHint={STOP_RUN_HINT} />, {
          needs: "changing the car",
          full: true,
        })}
      </div>
    </div>
  );
}
