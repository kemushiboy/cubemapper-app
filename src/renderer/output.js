// プロジェクター出力ウィンドウ。編集画面から送られるマッピングと再生位置に従って描画する
// 音は編集画面側で鳴らすので、こちらの映像は消音
(function () {
	'use strict';

	const api = window.cubemapper;
	const canvas = document.getElementById('out');
	const video = document.getElementById('video');
	const mapper = new window.MapRenderer(canvas);

	// シークすると直前のキーフレームから復号し直すため、キーフレームが少ない映像では数秒止まる。
	// 再生中の小さなずれは再生速度の微調整で吸収し、シークは明示的な指示か大きなずれのときだけにする
	const SEEK_DRIFT = 1.0;     // これ以上ずれたらシークする（秒）
	const NUDGE_DEADBAND = 0.03; // これ以下のずれは無視する（秒）
	const NUDGE_MAX = 0.05;      // 再生速度の調整幅（±5%）

	let state = null;
	let transport = null;
	let loadedPath = null;
	let dirty = true;
	const stats = { frames: 0, seeks: 0 };

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
		applyTransport(true);
	}

	function seekTo(time) {
		video.currentTime = time;
		stats.seeks++;
	}

	// 編集画面の再生位置に合わせる
	function applyTransport(force = false) {
		const t = transport;
		if (!t || video.readyState < 1) return;
		video.loop = t.loop;
		const dur = video.duration || 0;
		let target = t.time + (t.playing ? (Date.now() - t.sentAt) / 1000 : 0);
		if (t.loop && dur) target %= dur;
		let diff = target - video.currentTime;
		// ループの継ぎ目をまたいだときは近い方向のずれとして扱う
		if (t.loop && dur && Math.abs(diff) > dur / 2) diff -= Math.sign(diff) * dur;

		if (force || t.seek || !t.playing || Math.abs(diff) > SEEK_DRIFT) {
			if (Math.abs(diff) > (t.playing ? 0.04 : 0.005)) seekTo(target);
			video.playbackRate = 1;
		} else {
			const r = Math.abs(diff) < NUDGE_DEADBAND ? 1 : 1 + Math.max(-NUDGE_MAX, Math.min(NUDGE_MAX, diff * 0.5));
			if (video.playbackRate !== r) video.playbackRate = r;
		}
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

	// 新しいコマが来たときだけ描く
	const onFrame = () => {
		dirty = true;
		stats.frames++;
		video.requestVideoFrameCallback(onFrame);
	};
	video.requestVideoFrameCallback(onFrame);

	function loop() {
		if (state && dirty) {
			const ok = video.readyState >= 2;
			mapper.render(state, ok ? video : null, state.srcW, state.srcH);
			dirty = false;
		}
		requestAnimationFrame(loop);
	}

	// 動作確認用：表示されたコマ数とシーク回数を送る
	if (api.selftest.playtest) {
		setInterval(() => api.selftest.stats({
			win: 'output', ...stats, time: +video.currentTime.toFixed(2), rate: video.playbackRate,
		}), 1000);
	}

	window.addEventListener('resize', () => { fit(); dirty = true; });
	window.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.outputEscape(); });

	requestAnimationFrame(loop);
	api.outputReady();
})();
