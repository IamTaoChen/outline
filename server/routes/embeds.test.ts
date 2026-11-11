// @vitest-isolate true
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import Koa from "koa";
import { IntegrationService, IntegrationType } from "@shared/types";
import { Integration, Team } from "@server/models";
import * as passport from "@server/utils/passport";
import { renderEmbed } from "./embeds";

function createEmbedContext(url: string) {
  const request = new IncomingMessage(new Socket());
  request.url = `/embeds/gitlab?url=${encodeURIComponent(url)}`;
  request.headers.host = "app.outline.dev";
  return new Koa().createContext(request, new ServerResponse(request));
}

describe("GitLab snippet embeds", () => {
  const team = Team.build({ id: "12345678-1234-4234-8234-123456789abc" });

  const findIntegrations = vi.fn<typeof Integration.findAll>();
  const getTeam = vi.fn<typeof passport.getTeamFromContext>();

  beforeEach(() => {
    findIntegrations.mockReset().mockResolvedValue([]);
    getTeam.mockReset().mockResolvedValue(team);
    vi.spyOn(passport, "getTeamFromContext").mockImplementation(getTeam);
    vi.spyOn(Integration, "findAll").mockImplementation(findIntegrations);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders gitlab.com without looking up a workspace", async () => {
    const ctx = createEmbedContext("https://gitlab.com/-/snippets/123");
    const next = vi.fn();
    await renderEmbed(ctx, next);

    expect(ctx.body).toContain('src="https://gitlab.com/-/snippets/123.js"');
    expect(getTeam).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("only loads embed integrations for the request workspace", async () => {
    findIntegrations.mockResolvedValue([
      Integration.build({
        settings: { gitlab: { url: "https://gitlab.example:8443" } },
      }),
    ]);
    const ctx = createEmbedContext(
      "https://gitlab.example:8443/-/snippets/123"
    );
    const next = vi.fn();
    await renderEmbed(ctx, next);

    expect(getTeam).toHaveBeenCalledWith(ctx, {
      includeOAuthState: false,
    });
    expect(findIntegrations).toHaveBeenCalledWith({
      where: {
        service: IntegrationService.GitLab,
        type: IntegrationType.Embed,
        teamId: team.id,
      },
    });
    expect(ctx.body).toContain(
      'src="https://gitlab.example:8443/-/snippets/123.js"'
    );
    expect(ctx.state.cspScriptSrc).toEqual(["gitlab.example:8443"]);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "invalid",
    "http://gitlab.example",
    "https://other.example",
  ])(
    "rejects hosts not backed by a valid HTTPS integration: %s",
    async (url) => {
      findIntegrations.mockResolvedValue([
        Integration.build({ settings: { gitlab: { url } } }),
      ]);
      const ctx = createEmbedContext("https://gitlab.example/-/snippets/123");
      const next = vi.fn();
      await renderEmbed(ctx, next);

      expect(next).toHaveBeenCalledOnce();
      expect(ctx.body).toBeUndefined();
    }
  );

  it("rejects self-hosted snippets without a workspace", async () => {
    getTeam.mockResolvedValue(undefined);
    const ctx = createEmbedContext("https://gitlab.example/-/snippets/123");
    const next = vi.fn();
    await renderEmbed(ctx, next);

    expect(findIntegrations).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
