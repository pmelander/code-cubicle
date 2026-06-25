import * as vscode from "vscode";
import type { ExtToWebMessage, WebToExtMessage, WorkerState } from "./types";

/**
 * Manages the CodeCubicle webview panel lifecycle.
 */
export class CubiclePanel {
  public static readonly viewType = "codeCubicle.office";

  private static instance: CubiclePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg: WebToExtMessage) => this.onMessage(msg),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Show the panel or create it if it doesn't exist. */
  public static createOrShow(extensionUri: vscode.Uri): CubiclePanel {
    const column = vscode.ViewColumn.Beside;

    if (CubiclePanel.instance) {
      CubiclePanel.instance.panel.reveal(column);
      return CubiclePanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      CubiclePanel.viewType,
      "CodeCubicle",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "dist", "webview"),
          vscode.Uri.joinPath(extensionUri, "webview", "sprites"),
        ],
      }
    );

    CubiclePanel.instance = new CubiclePanel(panel, extensionUri);
    return CubiclePanel.instance;
  }

  /** Send a typed message to the webview. */
  public postMessage(message: ExtToWebMessage): void {
    this.panel.webview.postMessage(message);
  }

  /** Send full state sync to webview. */
  public syncState(workers: WorkerState[]): void {
    this.postMessage({ type: "state-sync", payload: workers });
  }

  private onMessage(msg: WebToExtMessage): void {
    switch (msg.type) {
      case "ready":
        // Webview loaded — could send initial state here
        break;
      case "request-state":
        // Webview is asking for current state
        break;
    }
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "renderer.js")
    );
    const spriteUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "webview", "sprites")
    );

    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src ${webview.cspSource} blob: data:;"
  />
  <title>CodeCubicle</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: #1e1e2e;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      width: 100vw;
    }
    canvas {
      /* Backing store is high-res; the renderer keeps pixel art crisp
         internally (imageSmoothingEnabled=false) while text/icons stay
         smooth. Display fit responsively without CSS pixelation. */
      width: auto;
      height: auto;
      max-width: 100vw;
      max-height: 100vh;
    }
  </style>
</head>
<body data-sprite-uri="${spriteUri}">
  <canvas id="office"></canvas>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    CubiclePanel.instance = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
