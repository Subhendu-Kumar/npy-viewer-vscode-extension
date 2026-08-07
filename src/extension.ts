import * as vscode from "vscode";

import { PythonBackend } from "./python/backend";
import { NpyEditorProvider } from "./editor/provider";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("NPY Viewer");
  context.subscriptions.push(log);

  const scriptPath = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "npy_load.py",
  ).fsPath;
  const python = new PythonBackend(scriptPath, log);
  const provider = new NpyEditorProvider(context, python, log);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      NpyEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "npy-viewer.openWith",
      async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
          void vscode.window.showWarningMessage("Select a .npy file first.");
          return;
        }
        await vscode.commands.executeCommand(
          "vscode.openWith",
          target,
          NpyEditorProvider.viewType,
        );
      },
    ),

    vscode.commands.registerCommand("npy-viewer.reload", async () => {
      await vscode.commands.executeCommand(
        "workbench.action.webview.reloadWebviewAction",
      );
    }),

    vscode.commands.registerCommand("npy-viewer.selectPython", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: "Use this interpreter",
        title: "Select a Python interpreter with NumPy installed",
      });
      if (!picked?.[0]) {
        return;
      }
      await vscode.workspace
        .getConfiguration("npyViewer")
        .update(
          "python.path",
          picked[0].fsPath,
          vscode.ConfigurationTarget.Global,
        );
      python.reset();

      const probe = await python.probe();
      if (probe) {
        void vscode.window.showInformationMessage(
          `NPY Viewer will use Python ${probe.pythonVersion} with NumPy ${probe.numpyVersion}. Reopen any open .npy files to apply.`,
        );
      } else {
        void vscode.window.showErrorMessage(
          `That interpreter is unusable: ${python.failureReason ?? "unknown reason"}`,
        );
      }
    }),

    vscode.commands.registerCommand("npy-viewer.showBackendInfo", async () => {
      const probe = await python.probe();
      if (probe) {
        void vscode.window.showInformationMessage(
          `NumPy backend active — Python ${probe.pythonVersion}, NumPy ${probe.numpyVersion} (${probe.origin}: ${probe.command}).`,
        );
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Using the built-in parser. ${python.failureReason ?? "No Python interpreter with NumPy was found."}`,
        "Select interpreter",
        "Install Python",
      );
      if (choice === "Select interpreter") {
        await vscode.commands.executeCommand("npy-viewer.selectPython");
      } else if (choice === "Install Python") {
        await vscode.env.openExternal(
          vscode.Uri.parse("https://www.python.org/downloads/"),
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("npyViewer.python.path") ||
        event.affectsConfiguration("npyViewer.python.enabled")
      ) {
        python.reset();
      }
    }),

    // The backend caches "no interpreter" for the session, so granting trust
    // mid-session has to clear that or Python stays off until a reload.
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      python.reset();
      log.appendLine("[trust] workspace trusted — re-detecting Python");
    }),
  );
}

export function deactivate(): void {
  // Documents close their own file handles via CustomDocument.dispose().
}
