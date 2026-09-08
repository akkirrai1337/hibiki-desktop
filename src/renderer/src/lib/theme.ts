// Backs the accent-color picker in Settings (see routes/settings.tsx) - the app's actual default
// pink, kept here (not just in globals.css) so a "Reset to default" control and the preset swatch
// row both have a single source of truth for it instead of a second hardcoded copy drifting from
// the CSS one over time.
export const DEFAULT_ACCENT = "#ec4899";

// A handful of ready-made options, Discord-picker style, alongside the free-form custom swatch -
// covers the common picks without forcing everyone through the OS color dialog for a simple swap.
// White and black lead the row - the plainest, most requested options, ahead of the color wheel.
export const ACCENT_PRESETS = ["#ffffff", "#000000", "#ec4899", "#8b5cf6", "#3b82f6", "#06b6d4", "#22c55e", "#eab308", "#f97316", "#ef4444"];

function hexToRgbTriplet(hex: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const int = Number.parseInt(match[1], 16);
  return `${(int >> 16) & 255} ${(int >> 8) & 255} ${int & 255}`;
}

// Relative luminance via the sRGB->linear formula, thresholded the same way most contrast-picker
// implementations do - the accent is now user-chosen and can land anywhere from near-white yellow
// to near-black indigo, so a single fixed "text on accent" color can't be assumed legible anymore.
function isLight(triplet: string): boolean {
  const [r, g, b] = triplet.split(" ").map((c) => Number(c) / 255);
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance > 0.5;
}

const ACCENT_FG_DARK = "29 12 21"; // near-black, matches the app's original #1d0c15 on-pink text
const ACCENT_FG_LIGHT = "255 255 255";

// Sets --color-accent (and its matching --color-accent-fg/--color-accent-text) directly on the
// root element, overriding whatever globals.css's light/dark block gave them - `null` removes the
// inline override so the CSS-defined defaults (which already themselves differ slightly between
// light and dark, see globals.css) take back over.
//
// `theme` is needed for --color-accent-text specifically: white and black were added as accent
// presets (see ACCENT_PRESETS) on top of the colorful ones this already handled fine, but a white
// accent in the light theme (or black in dark) has the same lightness classification as the page's
// own background - `text-accent` badges/labels sitting directly on that background (not on a solid
// accent fill, which --color-accent-fg already covers) went essentially invisible: a white badge
// tint over an already near-white page, with white text on top of that. Falling back to the
// theme's own primary text color in exactly that case keeps those badges legible - a plain neutral
// label instead of a colored one, which is the honest outcome for an accent with no real hue to
// begin with, rather than trying to manufacture contrast that isn't there.
export function applyAccentColor(color: string | null, theme: "light" | "dark"): void {
  const root = document.documentElement;
  const triplet = color ? hexToRgbTriplet(color) : null;
  if (triplet) {
    root.style.setProperty("--color-accent", triplet);
    const accentIsLight = isLight(triplet);
    root.style.setProperty("--color-accent-fg", accentIsLight ? ACCENT_FG_DARK : ACCENT_FG_LIGHT);
    root.style.setProperty("--color-accent-text", accentIsLight === (theme === "light") ? "var(--color-text)" : triplet);
  } else {
    root.style.removeProperty("--color-accent");
    root.style.removeProperty("--color-accent-fg");
    root.style.removeProperty("--color-accent-text");
  }
}

export interface BackgroundThemePreset {
  id: string;
  gradient: string;
}

// Discord-picker style once again (see its own profile "Preview Theme" panel) - a diagonal
// gradient painted behind the whole window (see the fixed layer in __root.tsx), with the
// Sidebar/TitleBar/page backgrounds turned translucent + blurred (bg-app-bg/bg-app-surface, see
// globals.css) so it actually shows through the chrome instead of being fully hidden behind it.
export const BACKGROUND_THEME_PRESETS: BackgroundThemePreset[] = [
  { id: "sunset", gradient: "linear-gradient(135deg, #f97316, #ec4899)" },
  { id: "candy", gradient: "linear-gradient(135deg, #f472b6, #a78bfa)" },
  { id: "violet", gradient: "linear-gradient(135deg, #8b5cf6, #6366f1)" },
  { id: "ocean", gradient: "linear-gradient(135deg, #06b6d4, #3b82f6)" },
  { id: "aurora", gradient: "linear-gradient(135deg, #22d3ee, #6366f1, #ec4899)" },
  { id: "forest", gradient: "linear-gradient(135deg, #22c55e, #14b8a6)" },
  { id: "gold", gradient: "linear-gradient(135deg, #f59e0b, #ef4444)" },
  { id: "midnight", gradient: "linear-gradient(135deg, #334155, #0f172a)" },
];

// How much of the Sidebar/TitleBar the gradient layer behind them is allowed to bleed through once
// a background theme is active - translucent enough to actually read as "the gradient is back
// there", blurred enough that text sitting directly on these panels (nav labels, ...) stays
// legible over whatever colors happen to be behind it at that point.
const APP_SURFACE_ALPHA = "0.66";
const APP_SURFACE_BLUR = "28px";
// Page translucency is defined by .bg-theme-active .bg-app-bg in globals.css.
export function applyBackgroundTheme(id: string | null): void {
  const root = document.documentElement;
  const preset = id ? BACKGROUND_THEME_PRESETS.find((p) => p.id === id) : undefined;
  // The class enables page translucency and the chrome's separate backdrop blur.
  root.classList.toggle("bg-theme-active", !!preset);
  root.style.removeProperty("--app-bg-alpha"); // Clear values left by older versions.
  if (preset) {
    root.style.setProperty("--app-theme-gradient", preset.gradient);
    root.style.setProperty("--app-surface-alpha", APP_SURFACE_ALPHA);
    root.style.setProperty("--app-surface-blur", APP_SURFACE_BLUR);
  } else {
    root.style.removeProperty("--app-theme-gradient");
    root.style.removeProperty("--app-surface-alpha");
    root.style.removeProperty("--app-surface-blur");
  }
}
