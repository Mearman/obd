import { expect, test, type Page } from "@playwright/test";
import {
  FAULT_SIGNALS,
  PLAN_PHASE_SIGNAL,
  PLAN_SIGNAL,
  canonicalJson,
  decodeShare,
  encodeShare,
  faultSampleValue,
  fragmentOfLink,
  runShareEnvelope,
  type Sample,
} from "obd-read";
import { loadBuiltinPlan } from "obd-read/plans";
import { streamShareCodec } from "obd-read/web";

const VIEWPORTS = [
  { name: "narrow", width: 320, height: 640 },
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const SCHEMES = ["light", "dark"] as const;

/** The smallest touch target, in CSS pixels. */
const MIN_TARGET = 44;

const INTERACTIVE =
  'button, a[href], [role="tab"], [role="switch"], [role="slider"], summary, select, textarea, input:not([hidden]):not([type="hidden"]), label:has(> input[type="checkbox"])';

/** A wider font than any the app is likely to fall back to, so a layout that fits only with this machine's fonts fails here, not on another system. */
const WIDE_FONT =
  "* { font-family: Verdana, sans-serif !important; letter-spacing: 0.08em !important; }";

/** Checks the page fits, then checks it again with {@link WIDE_FONT}. */
async function fitsWithAnyFont(page: Page, what: string): Promise<void> {
  await fits(page, what);
  const tag = await page.addStyleTag({ content: WIDE_FONT });
  await fits(page, `${what} with a wide font`);
  await tag.evaluate((element) => {
    element.parentNode?.removeChild(element);
  });
}

async function fits(page: Page, what: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${what} overflows horizontally`).toBeLessThanOrEqual(0);
  const small = await page.evaluate(
    ({ selector, min }) =>
      [...document.querySelectorAll<HTMLElement>(selector)]
        .filter((element) => element.getClientRects().length > 0)
        // A checkbox inside its label is reached through the label, whose whole row is the target.
        .filter((element) => !(element instanceof HTMLInputElement && element.type === "checkbox"))
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width < min || box.height < min)
        .map(
          ({ element, box }) =>
            `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent).trim().slice(0, 30)}" ${String(Math.round(box.width))}x${String(Math.round(box.height))}`,
        ),
    { selector: INTERACTIVE, min: MIN_TARGET },
  );
  expect(small, `${what} has targets under ${String(MIN_TARGET)} px`).toEqual([]);
}

/** A results link made in Node from a recorded run of the shipped idle-then-rev plan, for the layout checks. */
async function resultsLink(): Promise<string> {
  const plan = loadBuiltinPlan("idle-then-rev");
  const start = 1_700_000_000_000;
  const runId = "r";
  const samples: Sample[] = [
    { runId, signal: PLAN_SIGNAL, unit: "", timestamp: start, value: canonicalJson(plan) },
    {
      runId,
      signal: FAULT_SIGNALS.stored,
      unit: "",
      timestamp: start,
      value: faultSampleValue([]),
    },
  ];
  let at = 0;
  for (const phase of plan.phases) {
    samples.push({
      runId,
      signal: PLAN_PHASE_SIGNAL,
      unit: "",
      timestamp: start + at,
      value: JSON.stringify({
        phase: phase.id,
        title: phase.title,
        iteration: 1,
        startedAt: start + at,
        endedAt: start + at + 20_000,
        outcome: "completed",
        reads: [],
      }),
    });
    at += 20_000;
  }
  for (let index = 0; index < at / 500; index++) {
    for (const [signal, unit, base] of [
      ["engine speed", "rpm", 800],
      ["coolant temperature", "°C", 80],
    ] as const) {
      samples.push({
        runId,
        signal,
        unit,
        timestamp: start + index * 500,
        value: base + ((index * 37) % 200),
      });
    }
  }
  const envelope = runShareEnvelope(
    {
      profile: "generic",
      adapter: "simulator",
      startedAt: start,
      stoppedAt: start + at,
      notes: "",
    },
    samples,
    start,
  );
  const encoded = await encodeShare(envelope, streamShareCodec, { redactVin: true });
  if (!encoded.ok) throw new Error(encoded.error.message);
  return `/#${encoded.value.fragment}`;
}

test("a plan made in the editor is shared, recorded elsewhere and its results come back", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // The person who makes the plan.
  const maker = await browser.newContext();
  const makerPage = await maker.newPage();
  await makerPage.goto("/");
  await makerPage.getByRole("tab", { name: "Guide" }).click();
  await makerPage.getByRole("button", { name: "New plan" }).click();
  await makerPage.getByLabel("Name (lower case letters, digits and hyphens)").fill("pedal-check");
  await makerPage.getByLabel("Title", { exact: true }).fill("Accelerator pedal check");
  await makerPage.getByLabel("Phase 1: title").fill("Press the pedal");
  await makerPage
    .getByLabel("Phase 1: instruction")
    .fill("Parked, handbrake on: press the pedal slowly to the floor, then release it.");
  await makerPage.getByLabel("Phase 1 end condition: seconds").fill("2");
  await expect(makerPage.getByRole("status", { name: "Plan version" })).toHaveText(
    /^Valid\. Saves as revision 1, /,
  );
  await makerPage.getByRole("button", { name: "Save the plan" }).click();
  const kept = makerPage.getByRole("list", { name: "My plans" });
  await expect(kept.getByText("Accelerator pedal check", { exact: true })).toBeVisible();
  await kept.getByRole("button", { name: "Share link" }).click();
  const shareDialog = makerPage.getByRole("dialog", { name: "Share Accelerator pedal check" });
  await expect(shareDialog.getByText(/characters$/)).toBeVisible();
  const planLink = await shareDialog.getByLabel("Link", { exact: true }).innerText();
  expect(planLink).toContain("#share=2.");
  await maker.close();

  // The person who records it, in a fresh context with nothing stored.
  const recorder = await browser.newContext();
  const page = await recorder.newPage();
  await page.goto(planLink);
  await expect(page.getByText("From a link, not your adapter")).toBeVisible();
  await expect(page.getByText("Parked, handbrake on: press the pedal slowly")).toBeVisible();
  await page.getByRole("button", { name: "Open in Guide" }).click();
  await expect(
    page.getByRole("button", { name: "Record Accelerator pedal check" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("tab", { name: "Connect" }).click();
  await page.getByRole("button", { name: /connect with the simulator/i }).click();
  await expect(page.getByText("Connected to Simulator")).toBeVisible();
  await page.getByRole("tab", { name: "Guide" }).click();
  await expect(
    page.getByRole("button", { name: "Record Accelerator pedal check" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Start the plan" }).click();
  await expect(page.getByText("The plan finished.")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Send results back" }).click();
  const sendDialog = page.getByRole("dialog", { name: "Send the results back" });
  await expect(sendDialog.getByRole("switch")).toBeChecked();
  await expect(sendDialog.getByText(/characters$/)).toBeVisible();
  const resultLink = await sendDialog.getByLabel("Link", { exact: true }).innerText();
  await recorder.close();
  const fragment = fragmentOfLink(resultLink);
  if (fragment === undefined) throw new Error("no share fragment");
  const carried = await decodeShare(fragment, streamShareCodec);
  if (!carried.ok || carried.value.kind !== "plan-result") throw new Error("not a plan result");
  expect(carried.value.data.plan.name).toBe("pedal-check");
  expect(carried.value.data.phases.map((pass) => pass.outcome)).toEqual(["completed"]);
  console.info(
    `plan link ${String(planLink.length)} characters, results link ${String(resultLink.length)} characters`,
  );

  // A third context with no plan kept opens the results and sees the plan, phases and graphs.
  const third = await browser.newContext();
  const viewer = await third.newPage();
  await viewer.goto(resultLink);
  await expect(viewer.getByText("Results of Accelerator pedal check")).toBeVisible();
  await expect(viewer.getByText(/Plan pedal-check, revision 1, [0-9a-f]{12}/)).toBeVisible();
  const phases = viewer.getByRole("table", { name: "Phases of the shared result" });
  await expect(phases.getByText("Press the pedal")).toBeVisible();
  await expect(viewer.getByRole("figure").first()).toBeVisible();
  await expect(viewer.getByRole("figure").first()).toContainText("Press the pedal");
  await viewer.getByRole("button", { name: "Show the plan" }).click();
  await expect(viewer.getByText("Parked, handbrake on: press the pedal slowly")).toBeVisible();
  await third.close();
});

for (const viewport of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`${viewport.name} ${scheme}`, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });

      test("the plan editor fits and every target is large enough", async ({ page }) => {
        await page.goto("/");
        await page.getByRole("tab", { name: "Guide" }).click();
        await page.getByRole("button", { name: "New plan" }).click();
        await page.getByLabel("Phase 1 end condition: kind").selectOption("any");
        await page.getByLabel("Phase 1 end condition, part 1: kind").selectOption("between");
        await page.getByRole("button", { name: "Add a phase" }).click();
        await page.getByText("Values the plan reads:").click();
        await fitsWithAnyFont(page, "the plan editor");
        await page.screenshot({
          path: `screenshots/${viewport.name}-${scheme}-plan-editor.png`,
          fullPage: true,
        });
        await page.getByRole("tab", { name: "Preview" }).click();
        await fits(page, "the plan preview");
        await page.getByRole("tab", { name: "JSON" }).click();
        await fits(page, "the plan JSON");
      });

      test("a results link fits and every target is large enough", async ({ page }) => {
        await page.goto(await resultsLink());
        await expect(page.getByText("Results of Idle, hold revs, idle, blips")).toBeVisible();
        await page.getByRole("button", { name: "Show the plan" }).click();
        await fitsWithAnyFont(page, "the results view");
        await page.screenshot({
          path: `screenshots/${viewport.name}-${scheme}-plan-results.png`,
          fullPage: true,
        });
      });
    });
  }
}
