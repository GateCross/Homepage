import type { JSX } from "react";

import { ErrorBoundary } from "@/components/error";
import { ThemeProvider } from "@/components/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DashboardPage } from "@/pages/DashboardPage";

export function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <TooltipProvider>
          <DashboardPage />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
