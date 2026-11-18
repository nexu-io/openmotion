import React, { useEffect, useState } from "react";

import { useHostTheme } from "./theme";
import { studio } from "./studio";

type StudioProps = {
  useTabInfo: () => {
    tab: { visible: boolean; navigation: { params?: { projectId?: string } } };
  };
  openWorkspace: () => void;
  closeStudio: () => void;
};

export function StudioWorkspace({
  useTabInfo,
  openWorkspace,
  closeStudio,
}: StudioProps): React.JSX.Element | null {
  const { tab } = useTabInfo();
  const theme = useHostTheme();
  const projectId = tab.navigation.params?.projectId || "project";
  const [focused, setFocused] = useState(
    () => window.matchMedia("(max-width: 960px)").matches,
  );

  // Narrow windows use one usable surface at a time, without squeezing the editor.
  useEffect(() => {
    const viewport = window.matchMedia("(max-width: 960px)");
    function update() {
      setFocused(viewport.matches);
    }
    update();
    viewport.addEventListener("change", update);
    function revealStudio() {
      if (viewport.matches) setFocused(true);
    }
    window.addEventListener("openmotion:reveal-studio", revealStudio);
    return () => {
      viewport.removeEventListener("change", update);
      window.removeEventListener("openmotion:reveal-studio", revealStudio);
    };
  }, []);

  function toggleAgent(): void {
    if (focused && window.innerWidth <= 960) closeStudio();
    else setFocused(!focused);
  }

  if (!tab.visible) return null;

  return (
    <section
      className="omd-studio-seat"
      data-motion-ui
      data-theme={theme}
      data-focused={focused}
    >
      <header className="omd-editor-bar">
        <div className="omd-editor-location">
          <button
            className="ui-button ui-button--ghost ui-button--sm"
            onClick={openWorkspace}
            title="Return to projects and templates"
          >
            ← Workspace
          </button>
          <span className="omd-editor-divider" />
          <img
            alt=""
            src={studio + "/design-system/brand/favicon.svg"}
            width="20"
            height="20"
          />
          <strong>Studio</strong>
        </div>
        <div className="omd-editor-actions">
          <button
            className="ui-button ui-button--ghost ui-button--sm"
            onClick={closeStudio}
          >
            Chat only
          </button>
          <button
            className={
              "ui-button ui-button--sm " +
              (focused ? "ui-button--primary" : "ui-button--ghost")
            }
            aria-pressed={!focused}
            onClick={toggleAgent}
          >
            {focused ? "Show Agent" : "Hide Agent"}
          </button>
        </div>
      </header>
      <iframe
        title="OpenMotion Studio"
        src={
          studio +
          "/?embed=1&hostChrome=1#project/" +
          encodeURIComponent(projectId)
        }
        allow="clipboard-write; fullscreen"
      />
    </section>
  );
}

function AgentHeading() {
  const theme = useHostTheme();
  return (
    <div className="omd-agent-heading" data-motion-ui data-theme={theme}>
      <img
        alt=""
        src={studio + "/design-system/brand/favicon.svg"}
        width="20"
        height="20"
      />
      <strong>Creative assistant</strong>
      <span>Agent</span>
    </div>
  );
}

function AgentIntro() {
  const theme = useHostTheme();
  return (
    <div className="omd-agent-intro" data-motion-ui data-theme={theme}>
      <span className="ui-badge">OpenMotion project</span>
      <h2>Bring your idea to life</h2>
      <p>
        Describe the visuals, pacing or copy you want to change, and continue
        with your agent.
      </p>
      <small>
        Choose and configure a model in the composer before your first request.
      </small>
    </div>
  );
}

export function registerEditingWorkspace(ctx: any): void {
  ctx.slots.inject("sidebar.right.pane.tab", () =>
    ctx.slots.register(
      {
        name: "sidebar.right.pane.tab",
        key: "openmotion.studio",
        inject: () => ({
          openWorkspace: () => ctx.layout.selectPanel("openmotion"),
          closeStudio: () => ctx.sidebarRight.toggleExpanded(),
        }),
      },
      StudioWorkspace,
    ),
  );
  ctx.slots.inject("conversation.header.leading", () =>
    ctx.slots.register(
      {
        name: "conversation.header.leading",
      },
      AgentHeading,
    ),
  );
  ctx.slots.inject("conversation.input.dock", () =>
    ctx.slots.register(
      {
        name: "conversation.input.dock",
        id: "openmotion-intro",
        order: -100,
      },
      AgentIntro,
    ),
  );
}
