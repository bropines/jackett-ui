import "@/index.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { queryClient } from "@/lib/query";
import { applyTheme, readStoredTheme } from "@/lib/theme";
import { ThemeProvider } from "@/lib/theme-provider";
import { createAppRouter } from "@/router";

try {
  applyTheme(readStoredTheme());
} catch {
  /* storage unavailable */
}

const router = createAppRouter(queryClient);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}
