import * as assert from "assert";
import * as vscode from "vscode";

/**
 * Activation-level checks.
 *
 * These run inside a real extension host, so they verify what the manifest
 * actually registered. Everything about parsing and statistics lives in
 * `core.test.ts`, which needs no `vscode` and runs far faster.
 */
suite("Extension activation", () => {
  const EXTENSION_ID = "subh-tools.npy-viewer";

  test("the extension is present and activates", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} was not found`);

    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });

  test("registers every command the manifest declares", async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const command of [
      "npy-viewer.openWith",
      "npy-viewer.reload",
      "npy-viewer.selectPython",
      "npy-viewer.showBackendInfo",
    ]) {
      assert.ok(registered.has(command), `${command} is not registered`);
    }
  });

  test("claims .npy as the default custom editor", () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const editors = extension?.packageJSON?.contributes?.customEditors ?? [];
    const editor = editors[0];

    assert.strictEqual(editor?.viewType, "npyViewer.arrayEditor");
    assert.strictEqual(editor?.priority, "default");
    assert.deepStrictEqual(editor?.selector, [{ filenamePattern: "*.npy" }]);
  });

  test("exposes its settings under a single namespace", () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const properties =
      extension?.packageJSON?.contributes?.configuration?.properties ?? {};

    const keys = Object.keys(properties);
    assert.ok(keys.length > 0, "no configuration properties declared");
    for (const key of keys) {
      assert.ok(
        key.startsWith("npyViewer."),
        `${key} is outside the npyViewer namespace`,
      );
    }

    // Every declared setting must have a default, or reads fall back to
    // undefined and the viewer has to guess.
    for (const [key, value] of Object.entries<{ default?: unknown }>(
      properties,
    )) {
      assert.notStrictEqual(value.default, undefined, `${key} has no default`);
    }
  });
});
