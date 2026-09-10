import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpDown, Check } from "lucide-react";
import { usePopoverTheme } from "@/lib/usePopoverTheme";

export interface CatalogModeOption<T extends string> {
  value: T;
  label: string;
}

/** One mode picker shared by source-backed and aggregator-backed catalogs. */
export function CatalogModeMenu<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: CatalogModeOption<T>[];
  onChange: (value: T) => void;
}) {
  const popoverTheme = usePopoverTheme();
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];

  if (!selected) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-2 rounded-lg bg-text/[.06] px-3.5 py-2 text-sm font-semibold text-text/80 transition-colors hover:bg-text/[.1]"
      >
        <ArrowUpDown className="h-4 w-4" strokeWidth={2} />
        {selected.label}
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ type: "spring", stiffness: 500, damping: 45 }}
              className="absolute right-0 top-11 z-50 w-52 overflow-hidden rounded-xl border border-border bg-app-popover shadow-2xl"
              style={popoverTheme}
            >
              {options.map((option) => (
                <button
                  key={option.value}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-sm text-text transition-colors hover:bg-text/[.06]"
                >
                  {option.label}
                  {option.value === value && <Check className="h-4 w-4 text-accent-text" strokeWidth={2.5} />}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
