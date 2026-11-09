# Changes in this copy

This mod is Better Sidebar 3.0.0 from [munza/herdr-mods](https://github.com/munza/herdr-mods)
(Apache-2.0, see `licenses/` and `THIRD_PARTY.md` at the repository root), modified for the Orca layout.

Modified files:

- `main.js`: registers the `card` and `groups` views.
- `views/spaces.js`: issue badges beside PR badges, both opening the issues mod's viewer;
  a live-ports plug icon on the branch line; the hover card; repo-row hover buttons
  (fold worktrees, menu, new worktree); one section per machine (bold bar, green dot while connected, a
  rule between machines); folders (`views/groups.js`): any space or repo can be filed, by dragging
  it onto a folder header, beside a row in another folder, onto the take-out or new-folder targets
  shown while dragging, or from the space menu's "Move to folder…"; folders are shared by every
  machine but show under a machine only when they hold its spaces, fold per machine, sum their
  agents when folded, and a drag never leaves its machine; going to a space opens its machine,
  folder and repo; the space menu is `my-menu`;
  agents and their sub-agent trees drawn under each space (header "Agents" switch, which
  hides the Agents panel), the fold chevron hides a space's worktrees and agents together;
  a moon and "Asleep" on a space the hibernate mod put to sleep; every + (Spaces, a machine's
  header, "New space there") starts the space in its machine's home, not the focused folder.
  It shares its drawn space order, and `agent.next` / `agent.prev` follow that order.
  The list scrolls itself (wheel, a draggable thumb) so it can follow the active space's row.
- `views/panel-toggle.js`: also takes `next-space` / `prev-space`, stepping through spaces in the list's order,
  and `next-agent` / `prev-agent`, stepping through agents as the list draws them (sub-agents under their parent).
- `views/find-node.js`: `hasSpacesView`.
- `views/ui.js`: exports `RADIUS`.
- `views/footer.js`: adapted to this layout; "N agents · N need you" while agents show in spaces.
- `views/agents.js`: sets agent order only when the layout has no spaces list; exports its helpers (status mark, icon, labels, durations) for the spaces list;
  a sub-agent kept as a pane shows only nested under its parent (not also
  as its own row), and clicking it focuses its pane instead of peeking.
- `git/pr-status.js`: finds each checkout's issue (git-config link, PR closing references,
  "Closes #N", or a branch number checked against GitHub) and carries it with the PRs.
- `mod.json`: settings for this layout.

Added files: `views/card.js`, `views/groups.js`, `views/space-agents.js`, `views/space-nav.js`, `git/project-icons.js`, and icons
(`bot`, `moon`, `copy`, `ellipsis`, `external`, `folder`, `folder-plus`, `github`, `issue`, `issue-closed`,
`panel-bottom`, `plug`). Removed: `mod.schema.json`, `icons/sliders.svg`.
