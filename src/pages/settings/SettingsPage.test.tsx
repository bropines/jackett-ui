import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, serverApi, type ServerConfig } from "@/api";
import { TooltipProvider } from "@/components/ui/misc";
import { SettingsPage } from "@/pages/SettingsPage";
import { authState, uiSettings } from "@/test/fixtures/auth";

const cfg: ServerConfig = {
  notices: [],
  port: 9117,
  external: true,
  local_bind_address: "127.0.0.1",
  cors: false,
  api_key: "0123456789abcdef0123456789abcdef",
  blackholedir: null,
  updatedisabled: true,
  prerelease: false,
  password: "",
  logging: false,
  basepathoverride: null,
  baseurloverride: null,
  cache_enabled: true,
  cache_ttl: 2100,
  cache_max_results_per_indexer: 1000,
  flaresolverrurl: null,
  flaresolverr_maxtimeout: 55000,
  omdbkey: null,
  omdburl: null,
  app_version: "v0.24.2994",
  can_run_netcore: false,
  proxy_type: 0,
  proxy_url: "172.17.0.1",
  proxy_port: 56990,
  proxy_username: null,
  proxy_password: null,
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsPage", () => {
  it("saves the whole config and blocks invalid input", async () => {
    vi.spyOn(api, "serverConfig").mockResolvedValue(cfg);
    vi.spyOn(serverApi, "getSettings").mockResolvedValue(uiSettings());
    vi.spyOn(serverApi, "authState").mockResolvedValue(authState());
    const save = vi.spyOn(api, "saveServerConfig").mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap(<SettingsPage />);

    const fs = await screen.findByLabelText("Адрес", { selector: "#cfg-flaresolverrurl" });
    expect(screen.queryByRole("region", { name: "Несохранённые изменения" })).toBeNull();

    await user.type(fs, "flaresolverr:8191");
    expect(await screen.findByText("Адрес вида http://host:8191")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Несохранённые изменения" })).getByRole("button", { name: /^Сохранить$/ })).toBeDisabled();

    await user.clear(fs);
    await user.type(fs, "http://flaresolverr:8191");
    const btn = within(screen.getByRole("region", { name: "Несохранённые изменения" })).getByRole("button", { name: /^Сохранить$/ });
    expect(btn).toBeEnabled();
    await user.click(btn);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toEqual({ ...cfg, flaresolverrurl: "http://flaresolverr:8191" });
  });
});
