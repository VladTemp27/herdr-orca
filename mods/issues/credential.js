import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { closeOverlay, exec, notify, theme } from "herdr";
import { credentialTarget } from "./settings.js";

export class CredentialPrompt {
  constructor(settings, overlay) {
    this.settings = settings;
    this.overlay = overlay;
    this.input = InputState.new({ placeholder: "Paste API token" });
    this.input.set_masked(true);
    this.input.on("submit", (_event, cx) => this.save(cx));
  }

  close() {
    this.input.set_value("");
    closeOverlay(this.overlay);
  }

  async save(cx) {
    const token = this.input.value().trim();
    if (this.saving) return;
    if (!token) { this.error = "Enter an API token."; cx.notify(); return; }
    this.saving = true;
    this.error = null;
    this.input.set_loading(true);
    cx.notify();
    const target = credentialTarget(this.settings);
    try {
      // shortcut: security receives the token in a short-lived argv; replace with stdin support if Herdr exec adds it.
      const result = await exec("security", [
        "add-generic-password", "-U", "-a", target.account, "-s", target.service, "-w", token,
      ], { timeout: 10000 });
      if (result.code !== 0) throw new Error("Keychain rejected the token.");
      this.input.set_value("");
      closeOverlay(this.overlay);
      notify({ title: "Jira connected", body: "Token saved to macOS Keychain. Refresh Issues to load Jira issues." });
    } catch {
      this.error = "Could not save the token to macOS Keychain.";
    } finally {
      this.saving = false;
      this.input.set_loading(false);
      cx.notify();
    }
  }

  render() {
    const t = theme();
    const button = (id, label, primary, action) => h_flex().id(id).h(34).px(12).flex_none().items_center().justify_center()
      .rounded(8).border_1().border_color(primary ? t.foreground : t.border)
      .bg(primary ? t.foreground : t.background).text_color(primary ? t.background : t.foreground)
      .text_size(13).cursor_pointer().hover((s) => s.bg(primary ? t.foreground : t.hover))
      .on_click((_event, cx) => { cx.stop_propagation(); action(cx); }).child(label);
    return v_flex().id("issue-credential").size_full().p(18).gap(12).rounded(12).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(32).gap(8).items_center()
        .child(div().font_semibold().child(this.settings.provider === "jira" ? "Connect Jira" : "Connect Linear"))
        .child(div().flex_1())
        .child(div().id("credential-close").size(28).flex().items_center().justify_center().rounded(7).cursor_pointer()
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_event, cx) => { cx.stop_propagation(); this.close(); }).child("×")))
      .child(div().text_size(12).text_color(t.muted)
        .child("Enter your API token. It will be stored in macOS Keychain, not Mod settings."))
      .child(h_flex().h(38).px(10).items_center().rounded(8).border_1().border_color(t.border).bg(t.chrome)
        .child(Input.new(this.input).flex_1().h(34).text_size(13).text_color(t.foreground)))
      .when(Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(h_flex().flex_1().items_end().justify_end().gap(8)
        .child(button("credential-cancel", "Cancel", false, () => this.close()))
        .child(button("credential-save", this.saving ? "Saving…" : "Save to Keychain", true, (cx) => this.save(cx))));
  }
}
