const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');

let editor = null;
let output = null;

const PRELOAD = path.join(__dirname, 'preload.js');

function createEditor() {
	editor = new BrowserWindow({
		width: 1600,
		height: 980,
		minWidth: 1100,
		minHeight: 700,
		backgroundColor: '#16181c',
		title: 'cubemapper',
		webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
	});
	editor.setMenuBarVisibility(false);
	editor.loadFile(path.join(__dirname, 'renderer', 'index.html'));
	editor.on('closed', () => {
		editor = null;
		if (output) output.close();
	});

	// 動作確認用：CUBEMAPPER_CAPTURE=保存先.png で起動すると、準備完了後に画面を保存して終了する
	if (process.env.CUBEMAPPER_CAPTURE) {
		ipcMain.once('selftest-ready', async () => {
			await new Promise((r) => setTimeout(r, 600));
			fs.writeFileSync(process.env.CUBEMAPPER_CAPTURE, (await editor.capturePage()).toPNG());
			if (output && process.env.CUBEMAPPER_CAPTURE_OUT) {
				fs.writeFileSync(process.env.CUBEMAPPER_CAPTURE_OUT, (await output.capturePage()).toPNG());
			}
			app.quit();
		});
	}
}

function displayList() {
	const primary = screen.getPrimaryDisplay().id;
	return screen.getAllDisplays().map((d, i) => ({
		id: d.id,
		label: `ディスプレイ ${i + 1}：${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}` +
			(d.id === primary ? '（メイン）' : ''),
		primary: d.id === primary,
	}));
}

function openOutput({ displayId, fullscreen, primary }) {
	const displays = screen.getAllDisplays();
	const d = (primary && screen.getPrimaryDisplay()) ||
		displays.find((x) => x.id === displayId) ||
		displays.find((x) => x.id !== screen.getPrimaryDisplay().id) ||
		screen.getPrimaryDisplay();
	const b = d.bounds;

	if (output) {
		output.setFullScreen(false);
		output.setBounds(fullscreen ? b : { x: b.x + 60, y: b.y + 60, width: 960, height: 540 });
		if (fullscreen) output.setFullScreen(true);
		output.focus();
		return;
	}

	output = new BrowserWindow({
		x: fullscreen ? b.x : b.x + 60,
		y: fullscreen ? b.y : b.y + 60,
		width: fullscreen ? b.width : 960,
		height: fullscreen ? b.height : 540,
		frame: !fullscreen,
		backgroundColor: '#000000',
		title: 'cubemapper 出力',
		webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
	});
	output.setMenuBarVisibility(false);
	output.loadFile(path.join(__dirname, 'renderer', 'output.html'));
	if (fullscreen) output.setFullScreen(true);
	output.on('closed', () => {
		output = null;
		if (editor) editor.webContents.send('output-closed');
	});
}

ipcMain.handle('list-displays', () => displayList());
ipcMain.handle('output-open', (_e, opts) => openOutput(opts));
ipcMain.handle('output-close', () => { if (output) output.close(); });

// 編集画面 → 出力ウィンドウへ中継
ipcMain.on('map-state', (_e, s) => { if (output) output.webContents.send('map-state', s); });
ipcMain.on('map-transport', (_e, t) => { if (output) output.webContents.send('map-transport', t); });
ipcMain.on('output-ready', () => { if (editor) editor.webContents.send('output-request-state'); });
ipcMain.on('output-escape', () => { if (output) output.close(); });

ipcMain.handle('open-video', async () => {
	const r = await dialog.showOpenDialog(editor, {
		title: '映像を開く',
		properties: ['openFile'],
		filters: [{ name: '動画', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }],
	});
	return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('save-project', async (_e, data, defaultPath) => {
	const r = await dialog.showSaveDialog(editor, {
		title: 'マッピングを保存',
		defaultPath,
		filters: [{ name: 'cubemapper プロジェクト', extensions: ['json'] }],
	});
	if (r.canceled) return null;
	fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf-8');
	return r.filePath;
});

ipcMain.handle('load-project', async () => {
	const r = await dialog.showOpenDialog(editor, {
		title: 'マッピングを読み込む',
		properties: ['openFile'],
		filters: [{ name: 'cubemapper プロジェクト', extensions: ['json'] }],
	});
	if (r.canceled) return null;
	return JSON.parse(fs.readFileSync(r.filePaths[0], 'utf-8'));
});

ipcMain.handle('file-exists', (_e, p) => !!p && fs.existsSync(p));

app.whenReady().then(() => {
	createEditor();
	screen.on('display-added', () => editor && editor.webContents.send('displays-changed'));
	screen.on('display-removed', () => editor && editor.webContents.send('displays-changed'));
});
app.on('window-all-closed', () => app.quit());
