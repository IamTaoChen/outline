import "~/stores";
import { runInAction } from "mobx";
import { MobXProviderContext, observer } from "mobx-react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import embeds, { type EmbedDescriptor } from "@shared/editor/embeds";
import { IntegrationService, IntegrationType } from "@shared/types";
import RootStore from "~/stores/RootStore";
import useEmbeds from "./useEmbeds";

describe("useEmbeds GitLab snippets", () => {
  let store: RootStore;
  let root: Root;
  let container: HTMLDivElement;
  let patterns: RegExp[];
  let descriptors: EmbedDescriptor[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    store = new RootStore();
    container = document.createElement("div");
    root = createRoot(container);
    patterns = [];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  async function renderEmbeds() {
    const Harness = observer(function Harness() {
      descriptors = useEmbeds();
      patterns =
        descriptors.find((embed) => embed.id === "gitlab-snippet")
          ?.regexMatch ?? [];
      return null;
    });

    await act(async () => {
      root.render(
        createElement(
          MobXProviderContext.Provider,
          { value: { rootStore: store } },
          createElement(Harness)
        )
      );
    });
  }

  function addGitLab(id: string, url?: string) {
    return store.integrations.add({
      id,
      type: IntegrationType.Embed,
      service: IntegrationService.GitLab,
      settings: { gitlab: { url } },
    });
  }

  function matches(url: string) {
    return patterns.some((pattern) => pattern.test(url));
  }

  it("supports gitlab.com with no integrations", async () => {
    await renderEmbeds();

    expect(patterns).toHaveLength(1);
    expect(matches("https://gitlab.com/-/snippets/123")).toBe(true);
    expect(matches("https://other.example/-/snippets/123")).toBe(false);
  });

  it("normalizes and deduplicates self-hosted origins, ignoring invalid and missing URLs", async () => {
    addGitLab("self-hosted", "https://gitlab.example:8443/group/project");
    addGitLab("duplicate", "https://gitlab.example:8443/other");
    addGitLab("default", "https://gitlab.com/group");
    addGitLab("invalid", "not a URL");
    addGitLab("missing");
    store.integrations.add({
      id: "github",
      service: IntegrationService.GitHub,
      type: IntegrationType.Embed,
      settings: { gitlab: { url: "https://unrelated.example" } },
    });

    await renderEmbeds();

    expect(patterns).toHaveLength(2);
    expect(matches("https://gitlab.com/-/snippets/123")).toBe(true);
    expect(matches("https://gitlab.example:8443/group/-/snippets/456")).toBe(
      true
    );
    expect(matches("https://gitlabXexample:8443/-/snippets/456")).toBe(false);
    expect(matches("https://unrelated.example/-/snippets/123")).toBe(false);
  });

  it("ignores HTTP origins that the snippet renderer cannot serve", async () => {
    addGitLab("http", "http://gitlab.example");
    await renderEmbeds();

    expect(patterns).toHaveLength(1);
    expect(matches("http://gitlab.example/-/snippets/123")).toBe(false);
  });

  it("keeps shared descriptors unchanged and preserves matcher methods", async () => {
    const sharedSnippet = embeds.find((embed) => embed.id === "gitlab-snippet");
    const sharedPatterns = sharedSnippet?.regexMatch;
    addGitLab("self-hosted", "https://isolated.example");
    await renderEmbeds();

    const snippet = descriptors.find((embed) => embed.id === "gitlab-snippet");
    expect(snippet).not.toBe(sharedSnippet);
    expect(sharedSnippet?.regexMatch).toBe(sharedPatterns);
    expect(
      sharedSnippet?.matcher("https://isolated.example/-/snippets/123")
    ).toBe(false);
    expect(
      snippet?.matcher("https://isolated.example/-/snippets/123")
    ).toBeTruthy();
  });

  it("recalculates when integrations are added or removed", async () => {
    await renderEmbeds();

    await act(async () => {
      addGitLab("added", "https://gitlab.example");
    });
    expect(matches("https://gitlab.example/-/snippets/123")).toBe(true);

    await act(async () => {
      runInAction(() => store.integrations.data.delete("added"));
    });
    expect(patterns).toHaveLength(1);
    expect(matches("https://gitlab.example/-/snippets/123")).toBe(false);
    expect(matches("https://gitlab.com/-/snippets/123")).toBe(true);
  });

  it("recalculates when an existing integration URL changes without changing the list", async () => {
    const integration = addGitLab("updated", "https://old.example");
    await renderEmbeds();
    const orderedData = store.integrations.orderedData;
    expect(matches("https://old.example/-/snippets/123")).toBe(true);

    await act(async () => {
      runInAction(() => {
        integration.settings = { gitlab: { url: "https://new.example" } };
      });
    });

    expect(store.integrations.orderedData).toBe(orderedData);
    expect(matches("https://old.example/-/snippets/123")).toBe(false);
    expect(matches("https://new.example/-/snippets/123")).toBe(true);
    expect(matches("https://gitlab.com/-/snippets/123")).toBe(true);
  });
});
