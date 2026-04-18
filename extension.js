'use strict';

const vscode = require('vscode');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execFileP = promisify(execFile);

let statusBarItem;
let currentPanel = null;
let linuxBannerShown = false;
let outputChannel = null;

const POLL_INTERVAL_MS = 2500;
const COPIED_FLASH_MS = 3000;
let pollTimer = null;
let clipboardArmed = false;
let copiedUntil = 0;
let copiedTimer = null;

function log(msg) {
  if (outputChannel) outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

// -----------------------------------------------------------------------------
// Platform dispatcher
// -----------------------------------------------------------------------------

async function readClipboardPng() {
  if (process.platform === 'darwin') return readMacos();
  if (process.platform === 'win32') return readWindows();
  if (process.platform === 'linux') return readLinux();
  return null;
}

async function writeClipboardPng(buf) {
  if (process.platform === 'darwin') return writeMacos(buf);
  if (process.platform === 'win32') return writeWindows(buf);
  if (process.platform === 'linux') return writeLinux(buf);
  throw new Error('Unsupported platform: ' + process.platform);
}

function platformSupported() {
  return ['darwin', 'win32', 'linux'].includes(process.platform);
}

// -----------------------------------------------------------------------------
// macOS — osascript (ships with every Mac)
// -----------------------------------------------------------------------------

const MACOS_READ_SCRIPT = (outPath) => `
try
  set imgData to (the clipboard as «class PNGf»)
  set f to open for access POSIX file ${JSON.stringify(outPath)} with write permission
  set eof of f to 0
  write imgData to f
  close access f
  return "ok"
on error errMsg
  try
    close access f
  end try
  return "err:" & errMsg
end try
`.trim();

async function readMacos() {
  const tmp = tempPath('read', 'png');
  try {
    const { stdout } = await execFileP('osascript', ['-e', MACOS_READ_SCRIPT(tmp)]);
    if (!stdout || !stdout.trim().startsWith('ok')) return null;
    const buf = await fs.promises.readFile(tmp);
    return buf && buf.length > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

async function writeMacos(buf) {
  const tmp = tempPath('write', 'png');
  await fs.promises.writeFile(tmp, buf);
  try {
    await execFileP('osascript', [
      '-e',
      `set the clipboard to (read (POSIX file ${JSON.stringify(tmp)}) as «class PNGf»)`,
    ]);
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

// -----------------------------------------------------------------------------
// Windows — PowerShell (ships with every Windows since Vista)
// -----------------------------------------------------------------------------

const WINDOWS_READ_SCRIPT = (outPath) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) { Write-Output 'noimage'; exit 0 }
$img.Save(${psQuote(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)
$img.Dispose()
Write-Output 'ok'
`.trim();

const WINDOWS_WRITE_SCRIPT = (inPath) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile(${psQuote(inPath)})
try {
  $ms = New-Object System.IO.MemoryStream
  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $ms.Position = 0
  $data = New-Object System.Windows.Forms.DataObject
  $data.SetData('PNG', $ms)
  $data.SetImage($img)
  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
} finally {
  $img.Dispose()
}
Write-Output 'ok'
`.trim();

function psQuote(p) {
  return "'" + p.replace(/'/g, "''") + "'";
}

async function readWindows() {
  const tmp = tempPath('read', 'png');
  const scriptPath = tempPath('read', 'ps1');
  await fs.promises.writeFile(scriptPath, WINDOWS_READ_SCRIPT(tmp));
  try {
    const { stdout } = await execFileP('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ]);
    if (!stdout || !stdout.trim().startsWith('ok')) return null;
    const buf = await fs.promises.readFile(tmp);
    return buf && buf.length > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
    fs.promises.unlink(scriptPath).catch(() => {});
  }
}

async function writeWindows(buf) {
  const tmp = tempPath('write', 'png');
  const scriptPath = tempPath('write', 'ps1');
  await fs.promises.writeFile(tmp, buf);
  await fs.promises.writeFile(scriptPath, WINDOWS_WRITE_SCRIPT(tmp));
  try {
    await execFileP('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ]);
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
    fs.promises.unlink(scriptPath).catch(() => {});
  }
}

// -----------------------------------------------------------------------------
// Linux — xclip (X11) or wl-clipboard (Wayland)
// -----------------------------------------------------------------------------

function hasCmd(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function linuxTool() {
  const isWayland = !!process.env.WAYLAND_DISPLAY;
  if (isWayland && hasCmd('wl-paste') && hasCmd('wl-copy')) return 'wl';
  if (hasCmd('xclip')) return 'xclip';
  if (hasCmd('wl-paste') && hasCmd('wl-copy')) return 'wl';
  return null;
}

function showLinuxBanner() {
  if (linuxBannerShown) return;
  linuxBannerShown = true;
  const isWayland = !!process.env.WAYLAND_DISPLAY;
  const tool = isWayland ? 'wl-clipboard' : 'xclip';
  const install = isWayland
    ? 'sudo apt install wl-clipboard    # or: sudo dnf install wl-clipboard'
    : 'sudo apt install xclip    # or: sudo dnf install xclip';
  vscode.window
    .showWarningMessage(
      `Snapmark needs \`${tool}\` to access the clipboard on Linux. Install with: ${install}`,
      'Copy install command',
      'Dismiss'
    )
    .then((choice) => {
      if (choice === 'Copy install command') {
        vscode.env.clipboard.writeText(install.split('#')[0].trim());
        vscode.window.setStatusBarMessage('$(clippy) Copied install command', 2500);
      }
    });
}

function readCmdBuffer(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout || stdout.length === 0) return resolve(null);
      resolve(stdout);
    });
  });
}

async function readLinux() {
  const tool = linuxTool();
  if (!tool) { showLinuxBanner(); return null; }
  if (tool === 'xclip') {
    return readCmdBuffer('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']);
  }
  return readCmdBuffer('wl-paste', ['--type', 'image/png']);
}

async function writeLinux(buf) {
  const tool = linuxTool();
  if (!tool) { showLinuxBanner(); throw new Error('No Linux clipboard tool available'); }
  const tmp = tempPath('write', 'png');
  await fs.promises.writeFile(tmp, buf);
  try {
    if (tool === 'xclip') {
      await new Promise((resolve, reject) => {
        const child = execFile('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', tmp],
          (err) => (err ? reject(err) : resolve()));
        child.on('error', reject);
      });
    } else {
      // wl-copy reads from stdin; pipe the file
      await new Promise((resolve, reject) => {
        const child = execFile('wl-copy', ['--type', 'image/png'], (err) => (err ? reject(err) : resolve()));
        child.on('error', reject);
        fs.createReadStream(tmp).pipe(child.stdin);
      });
    }
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

// -----------------------------------------------------------------------------
// Common helpers
// -----------------------------------------------------------------------------

function tempPath(tag, ext) {
  return path.join(os.tmpdir(), `snapmark-${tag}-${Date.now()}-${process.pid}.${ext}`);
}

function nonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function getWebviewHtml(panel, extensionUri) {
  const webview = panel.webview;
  const n = nonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'editor.js'));
  const fabricUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'fabric.min.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'editor.css'));
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${n}' ${webview.cspSource}`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  const htmlPath = vscode.Uri.joinPath(extensionUri, 'media', 'editor.html').fsPath;
  let html = fs.readFileSync(htmlPath, 'utf8');
  return html
    .replace(/\{\{csp\}\}/g, csp)
    .replace(/\{\{nonce\}\}/g, n)
    .replace(/\{\{scriptUri\}\}/g, scriptUri.toString())
    .replace(/\{\{fabricUri\}\}/g, fabricUri.toString())
    .replace(/\{\{styleUri\}\}/g, styleUri.toString());
}

// -----------------------------------------------------------------------------
// Clipboard detection — cheap platform-native probes, no pixel transfer
// -----------------------------------------------------------------------------

function detectionEnabled() {
  return vscode.workspace.getConfiguration('snapmark').get('clipboardDetection', true);
}

function shouldPoll() {
  return detectionEnabled() && !currentPanel && platformSupported();
}

function startPolling() {
  if (pollTimer) return;
  if (!shouldPoll()) {
    log(`startPolling skipped: enabled=${detectionEnabled()} panel=${!!currentPanel} platform=${platformSupported()}`);
    return;
  }
  log('polling started');
  probeOnce();
  pollTimer = setInterval(probeOnce, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log('polling stopped');
  }
}

async function probeOnce() {
  if (!shouldPoll()) { stopPolling(); return; }
  let hasImage = false;
  try {
    hasImage = await probeClipboardImage();
  } catch (err) {
    log(`probe error: ${err && err.message}`);
    hasImage = false;
  }
  if (!shouldPoll()) return;
  setArmed(hasImage);
}

function setArmed(armed) {
  if (armed === clipboardArmed) return;
  clipboardArmed = armed;
  log(`armed=${armed}`);
  renderStatusBar();
}

function renderStatusBar() {
  if (!statusBarItem) return;
  const shortcut = process.platform === 'darwin' ? '⌘⇧A' : 'Ctrl+Shift+A';
  const pasteKey = process.platform === 'darwin' ? '⌘V' : 'Ctrl+V';
  if (copiedUntil > Date.now()) {
    statusBarItem.text = `$(check) Copied — ${pasteKey} to paste`;
    statusBarItem.tooltip = 'Snapmark — Annotated image copied to clipboard';
    statusBarItem.color = new vscode.ThemeColor('debugIcon.startForeground');
    statusBarItem.backgroundColor = undefined;
    return;
  }
  if (clipboardArmed) {
    statusBarItem.text = '$(pencil) Annotate';
    statusBarItem.tooltip = `Snapmark — Screenshot on clipboard, click to annotate (${shortcut})`;
    statusBarItem.color = new vscode.ThemeColor('notificationsWarningIcon.foreground');
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(pencil)';
    statusBarItem.tooltip = `Snapmark — Annotate clipboard image (${shortcut})`;
    statusBarItem.color = undefined;
    statusBarItem.backgroundColor = undefined;
  }
}

function flashCopied() {
  copiedUntil = Date.now() + COPIED_FLASH_MS;
  renderStatusBar();
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedUntil = 0;
    copiedTimer = null;
    renderStatusBar();
  }, COPIED_FLASH_MS);
}

async function probeClipboardImage() {
  if (process.platform === 'darwin') {
    const { stdout } = await execFileP('osascript', ['-e', 'clipboard info']);
    return /«class (PNGf|TIFF|JPEG|GIFf)»/i.test(stdout || '');
  }
  if (process.platform === 'win32') {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "if ([System.Windows.Forms.Clipboard]::ContainsImage()) { Write-Output '1' } else { Write-Output '0' }";
    const { stdout } = await execFileP('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ]);
    return (stdout || '').trim() === '1';
  }
  if (process.platform === 'linux') {
    const tool = linuxTool();
    if (!tool) return false;
    if (tool === 'xclip') {
      const { stdout } = await execFileP('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']);
      return /image\/png/i.test(stdout || '');
    }
    const { stdout } = await execFileP('wl-paste', ['--list-types']);
    return /image\/png/i.test(stdout || '');
  }
  return false;
}

// -----------------------------------------------------------------------------
// Command
// -----------------------------------------------------------------------------

async function annotateCommand(context) {
  if (!platformSupported()) {
    vscode.window.showErrorMessage('Snapmark: unsupported platform ' + process.platform);
    return;
  }

  const pngBuffer = await readClipboardPng();
  if (!pngBuffer) {
    vscode.window.setStatusBarMessage('$(warning) Snapmark: No image on clipboard', 2500);
    return;
  }

  const dataUrl = 'data:image/png;base64,' + pngBuffer.toString('base64');

  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    currentPanel.webview.postMessage({ type: 'loadImage', dataUrl });
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'snapmark.editor',
    'Snapmark — Annotate',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    }
  );
  currentPanel = panel;
  stopPolling();
  setArmed(false);
  panel.webview.html = getWebviewHtml(panel, context.extensionUri);

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      if (msg.type === 'ready') {
        const maxDimension = vscode.workspace
          .getConfiguration('snapmark')
          .get('maxDimension', 1920);
        panel.webview.postMessage({ type: 'config', maxDimension });
        panel.webview.postMessage({ type: 'loadImage', dataUrl });
      } else if (msg.type === 'done') {
        const base64 = String(msg.dataUrl || '').replace(/^data:image\/png;base64,/, '');
        if (!base64) {
          vscode.window.showErrorMessage('Snapmark: empty image from editor');
          return;
        }
        const buf = Buffer.from(base64, 'base64');
        await writeClipboardPng(buf);
        flashCopied();
        panel.dispose();
      } else if (msg.type === 'cancel') {
        panel.dispose();
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        'Snapmark: ' + (err && err.message ? err.message : String(err))
      );
    }
  });

  panel.onDidDispose(() => {
    if (currentPanel === panel) currentPanel = null;
    startPolling();
  });
}

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Snapmark');
  log(`activate — platform=${process.platform} focused=${vscode.window.state.focused}`);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBarItem.command = 'snapmark.annotate';
  renderStatusBar();
  statusBarItem.show();

  const cmd = vscode.commands.registerCommand('snapmark.annotate', () =>
    annotateCommand(context)
  );

  const cfgDisp = vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('snapmark.clipboardDetection')) return;
    stopPolling();
    if (!detectionEnabled()) {
      setArmed(false);
      return;
    }
    startPolling();
  });

  startPolling();

  context.subscriptions.push(
    statusBarItem,
    cmd,
    cfgDisp,
    outputChannel,
    { dispose: stopPolling }
  );
}

function deactivate() {
  stopPolling();
  if (currentPanel) currentPanel.dispose();
}

module.exports = { activate, deactivate };
