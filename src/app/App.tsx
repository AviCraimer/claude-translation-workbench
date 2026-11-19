import { createMemo, onSettled, For, Show } from "solid-js";
import type { Platform } from "./platform";
import { createAppState, type Status } from "./state";
import { createUi } from "./ui";
import { InfoColumn } from "./InfoColumn";
import { EditorColumn } from "./EditorColumn";
import { ChatColumn } from "./ChatColumn";

export function App(props: { platform: Platform }) {
  const app = createAppState(props.platform);
  const ui = createUi(app);
  onSettled(() => { app.subscribe(); app.loadStatic(); });

  const counts = createMemo(() => {
    const c: Record<Status, number> = { untouched: 0, rewritten: 0, finalized: 0, committed: 0, review: 0, conflict: 0 };
    for (const s of app.bundle()?.segments ?? []) c[app.statusOf(s.ref)]++;
    return c;
  });
  const dbLabel = () => app.platform.mode === "local" ? "Local preview (not saved)" : ({ connecting: "Connecting…", live: "Saved to database", slow: "Database not reachable yet", offline: "Database unavailable" })[app.dbState()];

  return (
    <div class="shell">
      <header class="topbar">
        <div class="brand"><span class="mark">◈</span> {app.manifest()?.title ?? "Translation Workbench"}</div>
        <Show when={app.manifest()}>
          {m => (
            <select class="unit-select" value={app.unitId() ?? ""} onChange={e => app.openUnit(e.currentTarget.value)}>
              <For each={m().units}>{u => <option value={u.id}>{u.title}</option>}</For>
            </select>
          )}
        </Show>
        <div class="counts">
          <span class="chip chip-untouched">{counts().untouched} untouched</span>
          <span class="chip chip-rewritten">{counts().rewritten} rewritten</span>
          <span class="chip chip-finalized">{counts().finalized} finalized</span>
          <span class="chip chip-committed">{counts().committed} committed</span>
          <Show when={counts().review}><span class="chip chip-review">{counts().review} need re-review</span></Show>
          <Show when={counts().conflict}><span class="chip chip-conflict">{counts().conflict} repo changed</span></Show>
        </div>
        <span class="spacer" />
        <label class="toggle"><input type="checkbox" checked={ui.ui.showHebrew} onChange={e => ui.setUi(s => { s.showHebrew = e.currentTarget.checked; })} /> Hebrew</label>
        <span class={["db", "db-" + app.dbState()]}>{dbLabel()}</span>
      </header>
      <InfoColumn app={app} ui={ui} />
      <EditorColumn app={app} ui={ui} />
      <ChatColumn app={app} ui={ui} />
    </div>
  );
}
