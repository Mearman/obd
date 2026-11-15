/** What the page's browser can do for the web transports. */
export interface Capabilities {
  /** `navigator.serial` exists: USB serial and paired classic Bluetooth SPP adapters. */
  readonly webSerial: boolean;
  /** `navigator.bluetooth` exists: Bluetooth LE adapters. */
  readonly webBluetooth: boolean;
  /** The page is a secure context (HTTPS or localhost), which both APIs require. */
  readonly secureContext: boolean;
  /** Whether at least one transport can be used here. */
  readonly usable: boolean;
  /** Plain-language reasons a transport is missing, for the interface to show. */
  readonly issues: readonly string[];
}

/** The globals {@link capabilities} inspects, injectable for tests. */
export interface CapabilityEnvironment {
  readonly navigator: object | undefined;
  readonly isSecureContext: boolean | undefined;
}

/** The globals of the running page. */
export function browserCapabilityEnvironment(): CapabilityEnvironment {
  return {
    navigator: typeof navigator === "undefined" ? undefined : navigator,
    isSecureContext: typeof isSecureContext === "undefined" ? undefined : isSecureContext,
  };
}

/**
 * Reports whether Web Serial and Web Bluetooth exist and whether the page is a secure context.
 *
 * Presence of an API is not permission: the user must still choose a device in a prompt. The
 * `issues` text names the limit that applies (Safari and Firefox implement neither API, and every
 * iOS browser uses Safari's engine), so the interface can explain why a button is disabled.
 */
export function capabilities(
  environment: CapabilityEnvironment = browserCapabilityEnvironment(),
): Capabilities {
  const nav = environment.navigator;
  const webSerial = nav !== undefined && "serial" in nav;
  const webBluetooth = nav !== undefined && "bluetooth" in nav;
  const secureContext = environment.isSecureContext === true;
  const issues: string[] = [];
  if (!secureContext) {
    issues.push(
      "Open the page over HTTPS or from localhost: browsers hide Bluetooth and serial access on other pages.",
    );
  }
  if (!webSerial) {
    issues.push(
      "Web Serial is not available: it needs Chrome or Edge on desktop or Android (Safari, Firefox and every iOS browser lack it).",
    );
  }
  if (!webBluetooth) {
    issues.push(
      "Web Bluetooth is not available: it needs Chrome or Edge on desktop or Android (Safari, Firefox and every iOS browser lack it).",
    );
  }
  return {
    webSerial,
    webBluetooth,
    secureContext,
    usable: secureContext && (webSerial || webBluetooth),
    issues,
  };
}
