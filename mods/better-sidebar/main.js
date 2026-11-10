// Better Sidebar: spaces, agents, a footer and a right panel toggle. A layout puts
// one copy per block, and `view` in its props picks which part it draws.
import { View } from "gpui-kit";
import { props } from "herdr";
import { Spaces } from "./views/spaces.js";
import { Agents } from "./views/agents.js";
import { Footer } from "./views/footer.js";
import { PanelToggle } from "./views/panel-toggle.js";
import { Card } from "./views/card.js";
import { Groups } from "./views/groups.js";
import { Note } from "./views/notes.js";

const PARTS = { agents: Agents, footer: Footer, "panel-toggle": PanelToggle, card: Card, groups: Groups, note: Note };

export default class BetterSidebar extends View {
  init(given, cx) {
    const Part = PARTS[props()?.view] ?? Spaces;
    this.part = new Part();
    this.part.init(given, cx);
  }

  render(cx) {
    return this.part.render(cx);
  }
}
