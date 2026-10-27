const { contextBridge, ipcRenderer, webUtils } = require('electron');

// サンドボックス化されたプリロードでは url モジュールが使えないので自前で変換する
function fileUrl(p) {
	const norm = p.replace(/\\/g, '/');
	const encoded = norm.split('/').map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
	return 'file:///' + encoded.replace(/^\/+/, '');
}

contextBridge.exposeInMainWorld('cubemapper', {
	// 編集画面
	openVideo: () => ipcRenderer.invoke('open-video'),
	saveProject: (data, defaultPath) => ipcRenderer.invoke('save-project', data, defaultPath),
	loadProject: () => ipcRenderer.invoke('load-project'),
	fileExists: (p) => ipcRenderer.invoke('file-exists', p),
	listDisplays: () => ipcRenderer.invoke('list-displays'),
	openOutput: (opts) => ipcRenderer.invoke('output-open', opts),
	closeOutput: () => ipcRenderer.invoke('output-close'),
	sendState: (s) => ipcRenderer.send('map-state', s),
	sendTransport: (t) => ipcRenderer.send('map-transport', t),
	onOutputClosed: (cb) => ipcRenderer.on('output-closed', () => cb()),
	onOutputRequestState: (cb) => ipcRenderer.on('output-request-state', () => cb()),
	onDisplaysChanged: (cb) => ipcRenderer.on('displays-changed', () => cb()),

	// 出力ウィンドウ
	outputReady: () => ipcRenderer.send('output-ready'),
	outputEscape: () => ipcRenderer.send('output-escape'),
	onState: (cb) => ipcRenderer.on('map-state', (_e, s) => cb(s)),
	onTransport: (cb) => ipcRenderer.on('map-transport', (_e, t) => cb(t)),

	fileUrl,
	pathForFile: (file) => webUtils.getPathForFile(file),
	selftest: {
		video: process.env.CUBEMAPPER_VIDEO || null,
		capture: !!process.env.CUBEMAPPER_CAPTURE,
		output: !!process.env.CUBEMAPPER_CAPTURE_OUT,
		seek: Number(process.env.CUBEMAPPER_SEEK || 0),
		drag: !!process.env.CUBEMAPPER_DRAG,
		ready: () => ipcRenderer.send('selftest-ready'),
	},
});
