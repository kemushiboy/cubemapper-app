// プロジェクター出力ウィンドウ。編集画面から送られるマッピングと再生位置に従って描画する
// 音は編集画面側で鳴らすので、こちらの映像は消音
(function () {
	'use strict';

	const api = window.cubemapper;
	const canvas = document.getElementById('out');
	const video = document.getElementById('video');
	const mapper = new window.MapRenderer(canvas);

	let state = null;
	let transport = null;
	let loadedPath = null;
	let dirty = true;

	function fit() {
		if (!state) return;
		const W = state.output.width, H = state.output.height;
		const s = Math.min(window.innerWidth / W, window.innerHeight / H);
		canvas.style.width = Math.floor(W * s) + 'px';
		canvas.style.height = Math.floor(H * s) + 'px';
	}

	async function ensureVideo(path) {
		if (!path || path === loadedPath) return;
		loadedPath = path;
		video.src = api.fileUrl(path);
		await new Promise((res) => video.addEventListener('loadeddata', res, { once: true }));
		applyTransport();
	}

	// 編集画面の再生位置に合わせる。ずれが 0.1 秒を超えたら合わせ直す
	function applyTransport() {
		const t = transport;
		if (!t || video.readyState < 1) return;
		video.loop = t.loop;
		let target = t.time + (t.playing ? (Date.now() - t.sentAt) / 1000 : 0);
		if (t.loop && video.duration) target %= video.duration;
		if (Math.abs(video.currentTime - target) > 0.1) video.currentTime = target;
		if (t.playing && video.paused) video.play().catch(() => {});
		if (!t.playing && !video.paused) video.pause();
		dirty = true;
	}

	api.onState((s) => {
		const sizeChanged = !state || state.output.width !== s.output.width || state.output.height !== s.output.height;
		state = s;
		if (sizeChanged) fit();
		dirty = true;
	});

	api.onTransport((t) => {
		transport = t;
		if (t.path !== loadedPath) ensureVideo(t.path);
		else applyTransport();
	});

	video.addEventListener('seeked', () => { dirty = true; });

	function loop() {
		if (state && (dirty || !video.paused)) {
			const ok = video.readyState >= 2;
			mapper.render(state, ok ? video : null, state.srcW, state.srcH);
			dirty = false;
		}
		requestAnimationFrame(loop);
	}

	window.addEventListener('resize', () => { fit(); dirty = true; });
	window.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.outputEscape(); });

	requestAnimationFrame(loop);
	api.outputReady();
})();
