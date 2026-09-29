import { useTranslation } from "react-i18next";
import { CalendarDays } from "lucide-react";
import { ReleaseCalendarPanel } from "@/components/ReleaseCalendarPanel";
import { useReleaseCalendar } from "@/lib/useReleaseCalendar";

// Rendered persistently from __root.tsx instead - see index.tsx for why.
export function CalendarPage() {
  const { t } = useTranslation();
  const { days, loading } = useReleaseCalendar();

  return (
    <div className="min-h-full bg-app-bg px-8 py-8 pb-16">
      <div className="mx-auto max-w-3xl">
        <p className="mb-6 text-sm text-muted">{t("calendar.hint")}</p>
        {days.length > 0 ? (
          <ReleaseCalendarPanel days={days} />
        ) : loading ? (
          <p className="text-sm text-muted">{t("calendar.loading")}</p>
        ) : (
          <div className="flex flex-col items-center gap-3 py-24 text-center text-muted">
            <CalendarDays className="h-9 w-9" strokeWidth={1.5} />
            <p className="max-w-sm text-sm">{t("calendar.empty")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
