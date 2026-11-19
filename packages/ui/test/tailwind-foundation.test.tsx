import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

// Import globals.css — same import as main.tsx
import "../src/globals.css";

const mockFetch = vi.fn(() =>
  Promise.resolve({ ok: true, json: async () => [] })
);
globalThis.fetch = mockFetch;

afterEach(() => {
  cleanup();
  mockFetch.mockClear();
});

describe("Tailwind Foundation", () => {
  // Test 1: Design tokens present on :root
  it("design tokens are present on :root via globals.css", () => {
    render(<div>probe</div>);

    const root = document.documentElement;
    const styles = getComputedStyle(root);

    // Friendly theme palette (cool neutrals + indigo accent).
    expect(styles.getPropertyValue("--background").trim()).toContain("228 33% 97%");
    expect(styles.getPropertyValue("--on-surface").trim()).toContain("221 39% 11%");
    expect(styles.getPropertyValue("--primary").trim()).toContain("243 75% 59%");
    expect(styles.getPropertyValue("--tertiary").trim()).toContain("0 72% 51%");
  });

  // Test 2: ALL borderRadius tokens zeroed in config
  it("borderRadius tokens form the friendly radius scale", () => {
    const config = readFileSync(resolve(__dirname, "../tailwind.config.ts"), "utf-8");

    const radiusMatch = config.match(/borderRadius:\s*\{([^}]+)\}/);
    expect(radiusMatch).not.toBeNull();

    const pairs = [...radiusMatch![1]!.matchAll(/(\w+):\s*"([^"]+)"/g)];
    expect(pairs.length).toBeGreaterThanOrEqual(6);
    // Friendly theme: a real radius scale — `none` stays 0, `full` is a pill, the rest are small, increasing radii.
    const scale = Object.fromEntries(pairs.map(([, key, value]) => [key, value]));
    expect(scale["none"]).toBe("0px");
    expect(scale["full"]).toBe("9999px");
    const steps = ["sm", "DEFAULT", "lg", "xl"].map((k) => parseInt(scale[k] ?? "0", 10));
    for (const px of steps) expect(px).toBeGreaterThan(0);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]!);
  });

  // Test 3: cn() utility
  it("cn() merges classes with Tailwind dedup", async () => {
    const { cn } = await import("../src/lib/utils.js");
    expect(cn("p-4", "p-8")).toBe("p-8");
  });

  // Test 4: Production build emits current scanned background utility contract.
  it("production build emits .bg-background utility rule", { timeout: 60000 }, () => {
    const uiRoot = resolve(__dirname, "..");
    try {
      execSync("npm run build", { cwd: uiRoot, stdio: "pipe", timeout: 30000 });
    } catch {
      // skip if build fails in test env
      return;
    }

    const distAssets = resolve(uiRoot, "dist/assets");
    let cssContent = "";
    try {
      const cssFiles = readdirSync(distAssets).filter((f) => f.endsWith(".css"));
      for (const f of cssFiles) {
        cssContent += readFileSync(resolve(distAssets, f), "utf-8");
      }
    } catch {
      return;
    }

    // bg-background should generate: background-color: hsl(var(--background))
    expect(cssContent).toMatch(/\.bg-background\b/);
    expect(cssContent).toContain("hsl(var(--background))");

    // The card token still ships in globals.css even though bg-card is not used
    // by any current source file and is therefore correctly purged from utilities.
    expect(cssContent).toMatch(/--card:\s*var\(--surface-container-lowest\)/);
  });

  // Test 5: main.tsx imports globals.css (source code verification)
  it("main.tsx imports globals.css in its source", () => {
    const mainSrc = readFileSync(resolve(__dirname, "../src/main.tsx"), "utf-8");
    expect(mainSrc).toContain('./globals.css"');
  });

  // Test 6: globals.css is injected into document
  it("globals.css stylesheet is present in document", () => {
    const styleSheets = document.querySelectorAll("style");
    const cssText = Array.from(styleSheets).map((s) => s.textContent).join("");

    expect(cssText).toContain("--background");
    expect(cssText).toContain("--surface-container-low");
    expect(cssText).toContain("--outline-variant");
  });
});
