import { createGlobalThemeContract } from "@vanilla-extract/css";

/**
 * The design tokens every style reads. Colour tokens differ between the light and dark themes (see
 * `themes.css.ts`); the rest are shared. Components reference tokens through this contract and
 * never use a literal colour, size or radius.
 */
export const vars = createGlobalThemeContract(
  {
    color: {
      background: null,
      surface: null,
      surfaceRaised: null,
      border: null,
      text: null,
      textMuted: null,
      accent: null,
      accentHover: null,
      accentText: null,
      accentSubtle: null,
      success: null,
      successSubtle: null,
      warning: null,
      warningSubtle: null,
      danger: null,
      dangerSubtle: null,
      simulated: null,
      simulatedSubtle: null,
      focusRing: null,
      overlay: null,
    },
    space: {
      "1": null,
      "2": null,
      "3": null,
      "4": null,
      "5": null,
      "6": null,
      "8": null,
    },
    fontSize: {
      small: null,
      body: null,
      large: null,
      title: null,
      display: null,
    },
    lineHeight: { tight: null, normal: null },
    radius: { small: null, medium: null, large: null, round: null },
    size: { touch: null, contentMax: null },
    fontFamily: { body: null, mono: null },
    shadow: { raised: null },
  },
  (_value, path) => `obd-${path.join("-")}`,
);
