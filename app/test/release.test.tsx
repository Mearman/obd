import { readFileSync } from "node:fs";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readRootVersion } from "../app-version";
import { App } from "../src/App";
import { REPOSITORY_URL, releaseUrl } from "../src/release/release";
import { renderApp } from "./render";

describe("the version in the top bar", () => {
  it("links the injected version to its GitHub release", () => {
    renderApp(<App />);
    const link = screen.getByRole("link", { name: "Release notes for version 9.8.7-test" });
    expect(link).toHaveTextContent("v9.8.7-test");
    expect(link).toHaveAttribute("href", "https://github.com/Mearman/obd/releases/tag/v9.8.7-test");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("is inside the header", () => {
    renderApp(<App />);
    expect(screen.getByRole("banner")).toContainElement(screen.getByRole("link"));
  });
});

describe("releaseUrl", () => {
  it("derives from the repository address and tags the version with a v", () => {
    expect(releaseUrl("1.2.3")).toBe(`${REPOSITORY_URL}/releases/tag/v1.2.3`);
  });
});

describe("readRootVersion", () => {
  it("reads the root package version, which the app package matches", () => {
    const parsed: unknown = JSON.parse(readFileSync("package.json", "utf8"));
    expect(parsed).toMatchObject({ version: readRootVersion() });
  });
});
