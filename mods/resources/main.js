// Resource meter: a status-bar button with CPU and memory of everything in Herdr,
// and, with props.view "popup", the per-space breakdown it opens.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, terminals, theme, run, props, exec, shared, setShared, settings, window, openOverlay, closeOverlay } from "herdr";
import { Meter } from "./measure.js";

const TICK_MS = 5000;
const IDLE_TICKS = 6; // window inactive: measure every 30s
// Fixed row heights let the bar place the popup exactly above its button.
const SIZE = { width: 420, head: 40, row: 46, term: 30, foot: 30, max: 460 };
const icon = (name, size = 13) => svg(`mods/resources/${name}.svg`).size(size).flex_none();
const mono = () => settings().font_family ?? "JetBrains Mono";
const sleeping = () => shared("hibernate.sleeping") ?? {};
const hasRemote = () => spaces().some((s) => s.machine);

const fmtMem = (kb) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);
const fmtCpu = (p) => (p < 0.05 ? "0%" : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`);
// 0 ok, 1 warn, 2 high
const cpuLevel = (p) => (p >= 60 ? 2 : p >= 30 ? 1 : 0);
const memLevel = (kb, ram) => (!ram ? 0 : kb >= ram * 0.5 ? 2 : kb >= ram * 0.3 ? 1 : 0);
const levelColor = (t, l, base) => (l === 2 ? t.ansi1 : l === 1 ? t.ansi3 : base);

// Measured spaces plus sleeping ones with nothing running.
function rowsOf(snap) {
  const rows = (snap?.spaces ?? []).map((s) => ({ ...s, asleep: Boolean(sleeping()[s.id]) }));
  for (const [id, v] of Object.entries(sleeping())) {
    if (!v || rows.some((r) => r.id === id)) continue;
    const s = spaces().find((x) => x.id === id);
    rows.push({ id, name: s?.name ?? v.name ?? id, cpu: 0, rss: 0, top: null, terms: [], asleep: true });
  }
  return rows;
}

function popupHeight(snap) {
  const body = Math.max(1, rowsOf(snap).length) * SIZE.row;
  return SIZE.head + Math.min(SIZE.max, body) + SIZE.row + SIZE.foot;
}

export default class Resources extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.popup = p.view === "popup" || Boolean(p.overlay);
    this.snap = p.snap ?? null;
    this.ram = p.ram ?? 0;
    this.cores = p.cores ?? 1;
    this.meter = new Meter(p.cache);
    this.expanded = new Set();
    this.ticks = 0;
    cx.spawn(async (cx) => {
      if (!this.ram) {
        // Both print RAM bytes, then logical cores.
        const r = await (window()?.platform === "windows"
          ? exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; [Environment]::ProcessorCount"])
          : exec("sysctl", ["-n", "hw.memsize", "hw.ncpu"])).catch(() => null);
        const [mem, ncpu] = (r?.stdout ?? "").trim().split(/\s+/).map(Number);
        this.ram = (mem || 0) / 1024;
        this.cores = ncpu || 1;
      }
      this.refresh(cx);
    });
    cx.timer.every(TICK_MS, (cx) => {
      this.ticks++;
      if (window().active || this.ticks % IDLE_TICKS === 0) this.refresh(cx);
    });
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const next = await this.meter.measure(terminals(), spaces(), this.cores);
        const changed = this.popup || this.label(next) !== this.label(this.snap);
        this.snap = next;
        if (changed) cx.notify(); // the bar redraws only when its text changes
      } catch (e) {
        console.warn(`resources: measure failed: ${e}`);
      }
      this.busy = false;
    });
  }

  label(snap) {
    return snap ? `${fmtCpu(snap.total.cpu)}|${fmtMem(snap.total.rss)}|${cpuLevel(snap.total.cpu)}${memLevel(snap.total.rss, this.ram)}` : "";
  }

  render(cx) {
    return this.popup ? this.renderPopup(cx) : this.renderButton(cx);
  }

  renderButton() {
    const t = theme();
    const s = this.snap;
    this.viewport = globalThis.window?.viewport_size?.();
    const cl = s ? cpuLevel(s.total.cpu) : 0;
    const ml = s ? memLevel(s.total.rss, this.ram) : 0;
    const tip = s
      ? `Herdr on this computer: CPU ${fmtCpu(s.total.cpu)} of ${this.cores} cores · ${fmtMem(s.total.rss)} of ${fmtMem(this.ram)} RAM`
      : "Measuring…";
    return h_flex().size_full().justify_end().px(4).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().id("resources-button").h(20).px(7).gap(5).items_center().rounded(5)
        .text_size(11.8).text_color(t.muted).whitespace_nowrap()
        .cursor_pointer().hover((st) => st.bg(t.hover))
        .tooltip(tip)
        .on_mouse_move((e) => { this.anchor = e.bounds; })
        .on_mouse_down("left", (e) => { this.anchor = e.bounds ?? this.anchor; })
        .on_click(() => this.open())
        .child(icon("activity").text_color(levelColor(t, Math.max(cl, ml), t.muted)))
        .when(!s, (el) => el.child("—"))
        .when(Boolean(s), (el) => el
          .child(div().text_color(levelColor(t, cl, t.muted)).child(`CPU ${fmtCpu(s.total.cpu)}`))
          .child(div().text_color(t.dim).child("·"))
          .child(div().text_color(levelColor(t, ml, t.muted)).child(fmtMem(s.total.rss)))));
  }

  // Bottom edge 6px above the button, right edges aligned.
  open() {
    const height = popupHeight(this.snap);
    const zoom = settings().zoom ?? 1;
    const v = this.viewport;
    const b = this.anchor ?? (v && { x: v.width - 300, y: v.height - 24, width: 140, height: 20 });
    const at = b ? { x: Math.max(8, b.x + b.width - SIZE.width * zoom), y: Math.max(8, b.y - height * zoom - 6) } : "pointer";
    openOverlay({
      mod: "resources", kind: "popup", at, width: SIZE.width, height,
      props: { view: "popup", height, snap: this.snap, cache: this.meter.cache(), ram: this.ram, cores: this.cores },
    });
  }

  renderPopup() {
    const t = theme();
    const s = this.snap;
    const rows = rowsOf(s);
    return v_flex().w_full().h(props()?.height ?? popupHeight(s)).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().h(SIZE.head).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(icon("activity", 14).text_color(t.muted))
        .child(div().font_medium().child("Resources"))
        .child(div().flex_1())
        .when(Boolean(s), (el) => el.child(div().text_size(12).text_color(t.muted)
          .child(`CPU ${fmtCpu(s.total.cpu)} · ${fmtMem(s.total.rss)} of ${fmtMem(this.ram)}`))))
      .child(v_flex().id("resources-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(!s, (el) => el.child(div().h(SIZE.row).flex_none().px(14).flex().items_center().text_size(12).text_color(t.dim).child("Measuring…")))
        .children(rows.flatMap((r) => [this.spaceRow(r, t), ...(this.expanded.has(r.id) ? r.terms.map((x) => this.termRow(x, t)) : [])])))
      .when(Boolean(s), (el) => el.child(this.appRow(s.app, t)))
      .child(h_flex().h(SIZE.foot).flex_none().px(14).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim)
        .child(div().flex_1().child(hasRemote() ? "This computer only" : "CPU is a share of all cores"))
        .child(div().font_family(mono()).child(`${this.cores} cores · ${fmtMem(this.ram)}`)));
  }

  nums(cpu, rss, t, dim = false) {
    return [
      div().w(52).flex_none().text_right().font_family(mono()).text_size(12).text_color(levelColor(t, cpuLevel(cpu), dim ? t.muted : t.foreground)).child(fmtCpu(cpu)),
      div().w(66).flex_none().text_right().font_family(mono()).text_size(12).text_color(dim ? t.muted : t.foreground).child(fmtMem(rss)),
    ];
  }

  spaceRow(r, t) {
    const open = this.expanded.has(r.id);
    const sub = r.asleep ? "Sleeping" : r.top ? `${r.top.name} ${fmtMem(r.top.rss)} · ${r.terms.length} terminal${r.terms.length === 1 ? "" : "s"}` : "";
    return h_flex().id(`space-${r.id}`).h(SIZE.row).flex_none().px(14).gap(10).items_center()
      .border_b(1).border_color(t.border).hover((st) => st.bg(t.hover))
      .when(r.terms.length > 0, (el) => el.cursor_pointer()
        .on_click((_e, cx) => { open ? this.expanded.delete(r.id) : this.expanded.add(r.id); cx.notify(); }))
      .child(div().w(10).flex_none().text_color(t.dim).text_size(11).child(r.terms.length ? (open ? "▾" : "▸") : ""))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_color(r.asleep ? t.muted : t.foreground).child(r.name))
        .child(h_flex().gap(4).items_center().text_size(11.5).text_color(t.dim)
          .when(r.asleep, (el) => el.child(icon("moon", 11)))
          .child(div().truncate().child(sub))))
      .when(!r.asleep, (el) => el.children(this.nums(r.cpu, r.rss, t)))
      .child(this.sleepButton(r, t));
  }

  sleepButton(r, t) {
    const action = r.asleep ? "wake" : "sleep";
    return div().id(`${action}-${r.id}`).w(56).h(24).flex_none().flex().items_center().justify_center().rounded(5)
      .border_1().border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer()
      .tooltip(r.asleep ? "Wake this space" : "Put this space to sleep: its terminals stop, and come back on Wake")
      .hover((st) => st.bg(t.raised).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        setShared("hibernate.request", { nonce: Date.now(), action, space: r.id });
      })
      .child(r.asleep ? "Wake" : "Sleep");
  }

  termRow(x, t) {
    return h_flex().id(`term-${x.address}`).h(SIZE.term).flex_none().pl(38).pr(14).gap(10).items_center()
      .border_b(1).border_color(t.border).bg(t.raised).text_size(12).cursor_pointer().hover((st) => st.bg(t.hover))
      .tooltip(`Go to ${x.address}`)
      .on_click(() => { run("pane.focus", { terminal: x.address }); closeOverlay(props().overlay); })
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_none().text_color(t.muted).child(x.top && x.top.name !== x.fg && x.top.name.toLowerCase() !== x.name.toLowerCase() ? `${x.name} · ${x.top.name}` : x.name))
        .child(div().min_w(0).truncate().text_color(t.dim).child(x.where ?? x.address)))
      .children(this.nums(x.cpu, x.rss, t, true))
      .child(div().w(56).flex_none());
  }

  appRow(a, t) {
    return h_flex().id("herdr-own").h(SIZE.row).flex_none().px(14).gap(10).items_center().bg(t.raised).border_t(1).border_color(t.border)
      .child(div().w(10).flex_none())
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_color(t.muted).child("Herdr"))
        .child(div().truncate().text_size(11.5).text_color(t.dim).child("The window and herdr-core")))
      .children(this.nums(a.cpu, a.rss, t, true))
      .child(div().w(56).flex_none());
  }
}
