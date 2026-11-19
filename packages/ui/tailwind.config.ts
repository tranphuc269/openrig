import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}", "./index.html"],
  // OPR.0.4.3.29 — Tailwind v3.4 selector strategy so `dark:` utilities key off
  // the `.dark` class on <html>. The general theme applies via the token cascade
  // (globals.css `.dark {}`), not per-utility; this enables `dark:` where used.
  darkMode: "selector",
  theme: {
    // Friendly theme: a real radius scale (the old "tactical" theme forced every radius to 0).
    borderRadius: {
      none: "0px",
      sm: "6px",
      DEFAULT: "8px",
      md: "8px",
      lg: "10px",
      xl: "14px",
      "2xl": "18px",
      "3xl": "24px",
      full: "9999px",
    },
    extend: {
      colors: {
        /* Paper surfaces */
        background: "hsl(var(--background))",
        "surface-lowest": "hsl(var(--surface-container-lowest))",
        "surface-low": "hsl(var(--surface-container-low))",
        "surface-mid": "hsl(var(--surface-container))",
        "surface-high": "hsl(var(--surface-container-high))",
        "surface-highest": "hsl(var(--surface-container-highest))",

        /* Ink */
        foreground: {
          DEFAULT: "hsl(var(--on-surface))",
          muted: "hsl(var(--on-surface-variant))",
        },
        "foreground-muted": "hsl(var(--on-surface-variant))",
        "on-surface": "hsl(var(--on-surface))",
        "on-surface-variant": "hsl(var(--on-surface-variant))",

        /* Technical */
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          container: "hsl(var(--secondary-container))",
        },

        /* Alert red */
        tertiary: "hsl(var(--tertiary))",
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        error: "hsl(var(--error))",

        /* Interactive */
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--background))",
        },
        "inverse-surface": "hsl(var(--inverse-surface))",

        /* Borders */
        outline: {
          DEFAULT: "hsl(var(--outline))",
          variant: "hsl(var(--outline-variant))",
        },

        /* Status */
        success: "hsl(var(--success))",
        warning: "hsl(var(--warning))",
        accent: "hsl(var(--secondary))",

        /* shadcn compat */
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
      },
      fontFamily: {
        // Friendly theme: UI text is Inter everywhere. `font-mono` was used for most UI labels,
        // so it now maps to Inter too; real code uses `font-code` (and <code>/<pre> in CSS).
        headline: ["Inter", "system-ui", "sans-serif"],
        body: ["Inter", "system-ui", "sans-serif"],
        mono: ["Inter", "system-ui", "sans-serif"],
        code: ["JetBrains Mono Variable", "JetBrains Mono", "ui-monospace", "monospace"],
        /* Legacy aliases */
        inter: ["Inter", "system-ui", "sans-serif"],
        grotesk: ["Space Grotesk Variable", "Space Grotesk", "sans-serif"],
      },
      spacing: {
        "spacing-1": "4px",
        "spacing-2": "8px",
        "spacing-3": "12px",
        "spacing-4": "16px",
        "spacing-6": "24px",
        "spacing-8": "32px",
        "spacing-12": "48px",
        "spacing-16": "64px",
        "spacing-24": "96px",
      },
      fontSize: {
        "display-lg": ["3.5rem", { lineHeight: "1.1", fontWeight: "900", letterSpacing: "-0.02em" }],
        "headline-lg": ["2rem", { lineHeight: "1.2", fontWeight: "700", letterSpacing: "-0.02em" }],
        "headline-md": ["1.5rem", { lineHeight: "1.3", fontWeight: "700", letterSpacing: "-0.02em" }],
        "body-lg": ["1.125rem", { lineHeight: "1.5", fontWeight: "400" }],
        "body-md": ["1rem", { lineHeight: "1.5", fontWeight: "400" }],
        "body-sm": ["0.875rem", { lineHeight: "1.5", fontWeight: "400" }],
        "label-lg": ["0.875rem", { lineHeight: "1.3", fontWeight: "700", letterSpacing: "0.02em" }],
        "label-md": ["0.75rem", { lineHeight: "1.3", fontWeight: "500", letterSpacing: "0.04em" }],
        "label-sm": ["0.625rem", { lineHeight: "1.3", fontWeight: "400", letterSpacing: "0.06em" }],
      },
      transitionTimingFunction: {
        tactical: "cubic-bezier(0.2, 0, 0, 1)",
      },
    },
  },
  // Friendly theme: no ALL-CAPS labels and no wide letter-spacing anywhere. Disabling the
  // plugins drops every uppercase/tracking-* utility (arbitrary values included) at build time.
  corePlugins: {
    textTransform: false,
    letterSpacing: false,
  },
  plugins: [],
};

export default config;
