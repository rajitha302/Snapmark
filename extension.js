'use strict';

const vscode = require('vscode');
const { execFile, execFileSync, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execFileP = promisify(execFile);

let statusBarItem;
let currentPanel = null;
let linuxBannerShown = false;
let linuxToolCache; // undefined = not detected yet
let winProbe = null;
let outputChannel = null;

const POLL_INTERVAL_MS = 2500;
const COPIED_FLASH_MS = 3000;
let pollTimer = null;
let clipboardArmed = false;
let copiedUntil = 0;
let copiedTimer = null;
let lastSignature = null;

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
    ], { windowsHide: true });
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
    ], { windowsHide: true });
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

// Cached so the 2.5s poll doesn't run `which` synchronously on the extension
// host. annotateCommand clears it, so installing a tool takes effect on the
// next annotate.
function linuxTool() {
  if (linuxToolCache !== undefined) return linuxToolCache;
  const isWayland = !!process.env.WAYLAND_DISPLAY;
  const hasWl = () => hasCmd('wl-paste') && hasCmd('wl-copy');
  if (isWayland && hasWl()) linuxToolCache = 'wl';
  else if (hasCmd('xclip')) linuxToolCache = 'xclip';
  else if (hasWl()) linuxToolCache = 'wl';
  else linuxToolCache = null;
  return linuxToolCache;
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
  let snap;
  try {
    snap = await probeClipboardSnapshot();
  } catch (err) {
    log(`probe error: ${err && err.message}`);
    snap = { hasImage: false, signature: 'err' };
  }
  if (!shouldPoll()) return;
  if (lastSignature === null) {
    lastSignature = snap.signature;
    setArmed(false);
    return;
  }
  if (snap.signature === lastSignature) return;
  lastSignature = snap.signature;
  setArmed(snap.hasImage);
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
    statusBarItem.text = `$(check) Copied. ${pasteKey} to paste`;
    statusBarItem.tooltip = 'Snapmark: annotated image copied to clipboard';
    statusBarItem.color = new vscode.ThemeColor('debugIcon.startForeground');
    statusBarItem.backgroundColor = undefined;
    return;
  }
  if (clipboardArmed) {
    statusBarItem.text = '$(pencil) Annotate';
    statusBarItem.tooltip = `Snapmark: new image on clipboard. Click to annotate (${shortcut})`;
    statusBarItem.color = new vscode.ThemeColor('notificationsWarningIcon.foreground');
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(pencil)';
    statusBarItem.tooltip = `Snapmark: annotate clipboard image (${shortcut})`;
    statusBarItem.color = undefined;
    statusBarItem.backgroundColor = undefined;
  }
}

function maybeShowIntro(context) {
  const KEY = 'snapmark.introSeen';
  if (context.globalState.get(KEY)) return;
  const shortcut = process.platform === 'darwin' ? '⌘⇧A' : 'Ctrl+Shift+A';
  const message = `Snapmark is ready. Copy an image, then click the pencil in the status bar (or press ${shortcut}) to annotate before pasting.`;
  vscode.window
    .showInformationMessage(message, 'Got it')
    .then(() => context.globalState.update(KEY, true));
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

async function probeClipboardSnapshot() {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP('osascript', ['-e', 'clipboard info']);
      const sig = (stdout || '').trim();
      const hasImage = /«class (PNGf|TIFF|JPEG|GIFf)»/i.test(sig);
      return { hasImage, signature: hasImage ? sig : 'no-image' };
    } catch {
      return { hasImage: false, signature: 'err' };
    }
  }
  if (process.platform === 'win32') {
    try {
      const [sig, has] = (await winProbeRequest()).split('|');
      if (!sig || sig === 'err') return { hasImage: false, signature: 'err' };
      return { hasImage: has === 'True', signature: sig };
    } catch {
      return { hasImage: false, signature: 'err' };
    }
  }
  if (process.platform === 'linux') {
    const tool = linuxTool();
    if (!tool) return { hasImage: false, signature: 'no-tool' };
    try {
      let targets = '';
      if (tool === 'xclip') {
        const { stdout } = await execFileP('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']);
        targets = stdout || '';
      } else {
        const { stdout } = await execFileP('wl-paste', ['--list-types']);
        targets = stdout || '';
      }
      const hasImage = /image\/png/i.test(targets);
      if (!hasImage) return { hasImage: false, signature: 'no-image' };
      const buf = await readCmdBuffer(
        tool === 'xclip' ? 'xclip' : 'wl-paste',
        tool === 'xclip' ? ['-selection', 'clipboard', '-t', 'image/png', '-o'] : ['--type', 'image/png']
      );
      if (!buf) return { hasImage: false, signature: 'no-image' };
      const sample = buf.slice(0, Math.min(2048, buf.length));
      const hash = require('crypto').createHash('md5').update(sample).digest('hex');
      return { hasImage: true, signature: buf.length + ':' + hash };
    } catch {
      return { hasImage: false, signature: 'err' };
    }
  }
  return { hasImage: false, signature: 'unsupported' };
}

// Windows probe: one long-lived PowerShell reading commands from stdin.
// Spawning powershell.exe and compiling the P/Invoke type on every poll costs
// hundreds of ms of CPU; this pays it once. Each probe writes one command and
// reads back one `snapmark:` line, so responses match requests in FIFO order.
const WIN_PROBE_PREFIX = 'snapmark:';
const WIN_PROBE_TIMEOUT_MS = 10000;
const WIN_PROBE_SETUP = [
  'Add-Type -AssemblyName System.Windows.Forms',
  `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();' -Name SnapmarkClip -Namespace Win32`,
];
const WIN_PROBE_CMD =
  `try { Write-Output ('${WIN_PROBE_PREFIX}' + [Win32.SnapmarkClip]::GetClipboardSequenceNumber() + '|' + [System.Windows.Forms.Clipboard]::ContainsImage()) } catch { Write-Output '${WIN_PROBE_PREFIX}err' }`;

function startWinProbe() {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-Command', '-',
  ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const probe = { child, pending: [], buf: '' };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    probe.buf += chunk;
    let i;
    while ((i = probe.buf.indexOf('\n')) >= 0) {
      const line = probe.buf.slice(0, i).trim();
      probe.buf = probe.buf.slice(i + 1);
      if (!line.startsWith(WIN_PROBE_PREFIX)) continue;
      const cb = probe.pending.shift();
      if (cb) cb(null, line.slice(WIN_PROBE_PREFIX.length));
    }
  });
  child.on('error', (err) => stopWinProbe(probe, err));
  child.on('exit', () => stopWinProbe(probe, new Error('probe exited')));
  child.stdin.on('error', () => {}); // EPIPE after the process dies; 'exit' handles it
  child.stdin.write(WIN_PROBE_SETUP.join('\n') + '\n');
  log('windows probe started');
  return probe;
}

function stopWinProbe(probe, err) {
  if (winProbe === probe) winProbe = null;
  probe.child.kill();
  probe.pending.splice(0).forEach((cb) => cb(err || new Error('probe stopped')));
}

function winProbeRequest() {
  if (!winProbe) winProbe = startWinProbe();
  const probe = winProbe;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => stopWinProbe(probe, new Error('probe timeout')),
      WIN_PROBE_TIMEOUT_MS
    );
    probe.pending.push((err, line) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(line);
    });
    probe.child.stdin.write(WIN_PROBE_CMD + '\n');
  });
}

// -----------------------------------------------------------------------------
// Command
// -----------------------------------------------------------------------------

async function annotateCommand(context) {
  if (!platformSupported()) {
    vscode.window.showErrorMessage('Snapmark: unsupported platform ' + process.platform);
    return;
  }

  linuxToolCache = undefined;

  // Mark the current clipboard content as handled so reopening the editor
  // or closing without Copy doesn't re-arm the same image.
  const prevSignature = lastSignature;
  const snap = await probeClipboardSnapshot();
  lastSignature = snap.signature;

  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    // Polling is off while the panel is open, so prevSignature is the
    // clipboard as of the last load. Only replace the in-progress
    // annotations if a different image has been copied since.
    if (!snap.hasImage || snap.signature === prevSignature) return;
    const buf = await readClipboardPng();
    if (buf) {
      currentPanel.webview.postMessage({
        type: 'loadImage',
        dataUrl: 'data:image/png;base64,' + buf.toString('base64'),
      });
    }
    return;
  }

  const pngBuffer = await readClipboardPng();
  const dataUrl = pngBuffer
    ? 'data:image/png;base64,' + pngBuffer.toString('base64')
    : null;

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
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'Logo.png');
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
        try {
          const snap = await probeClipboardSnapshot();
          lastSignature = snap.signature;
        } catch {}
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
    if (e.affectsConfiguration('snapmark.clipboardDetection')) {
      stopPolling();
      if (!detectionEnabled()) {
        setArmed(false);
      } else {
        startPolling();
      }
    }
    if (e.affectsConfiguration('snapmark.maxDimension') && currentPanel) {
      const maxDimension = vscode.workspace
        .getConfiguration('snapmark')
        .get('maxDimension', 1920);
      currentPanel.webview.postMessage({ type: 'config', maxDimension });
    }
  });

  startPolling();
  maybeShowIntro(context);

  context.subscriptions.push(
    statusBarItem,
    cmd,
    cfgDisp,
    outputChannel,
    { dispose: stopPolling },
    { dispose: () => winProbe && stopWinProbe(winProbe) }
  );
}

function deactivate() {
  stopPolling();
  if (winProbe) stopWinProbe(winProbe);
  if (currentPanel) currentPanel.dispose();
}

module.exports = { activate, deactivate };
