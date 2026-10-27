// cubemapper 編集画面
// シェイプ = { id, name, color, src[4], dst[4], cornerNames[4], visible, opacity, soft, preset }
//   src: 入力映像上の四角形（映像の画素・左上原点）、dst: 出力上の四角形（出力の画素・左上原点）
//   4隅は (u,v)=(0,0),(1,0),(1,1),(0,1) の順。src[i] が dst[i] に貼られる
(function () {
	'use strict';

	const G = window.HexGeom;
	const api = window.cubemapper;
	const $ = (id) => document.getElementById(id);
	const S3 = Math.sqrt(3) / 2;

	const FACE_COLORS = { top: '#33d9ff', left: '#ff5a5a', right: '#ffe633' };
	const EXTRA_COLORS = ['#7cff6b', '#c77dff', '#ff9a3c', '#4dd0e1', '#f06292'];
	const STORE_KEY = 'cubemapper.project.v1';
	const FRAME = 1001 / 30000;

	const DEFAULTS = {
		videoPath: '',
		output: { width: 1920, height: 1080 },
		displayId: null,
		fullscreen: true,
		shapes: [],
		testPattern: false,
		blackout: false,
		linkCorners: true,
		loop: true,
		mute: false,
		hex: null,     // { cx, cy, r } 入力映像上の正六角形
	};

	function clone(o) { return JSON.parse(JSON.stringify(o)); }

	function loadStored() {
		try {
			const s = JSON.parse(localStorage.getItem(STORE_KEY));
			if (s && Array.isArray(s.shapes)) return { ...clone(DEFAULTS), ...s };
		} catch (e) { /* 保存がなければ初期値 */ }
		return clone(DEFAULTS);
	}

	let st = loadStored();
	let nextId = st.shapes.reduce((m, s) => Math.max(m, s.id), 0) + 1;
	let selId = null;          // 選択中のシェイプ
	let selCorner = null;      // 選択中の角 0..3
	let activeKind = 'dst';    // 矢印キーで動かす対象（'src' か 'dst'）
	let outputOpen = false;

	const video = $('video');
	let videoW = 0, videoH = 0;

	// ---------------------------------------------------------------- 保存・出力ウィンドウへの送信
	let saveTimer = null;
	function save() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch (e) { /* 保存できなくても動作は続ける */ }
		}, 200);
	}

	let stateDirty = true;
	function outputState() {
		return {
			output: st.output,
			shapes: st.shapes,
			testPattern: st.testPattern,
			blackout: st.blackout,
			srcW: videoW,
			srcH: videoH,
		};
	}

	function sendTransport() {
		if (!outputOpen) return;
		api.sendTransport({
			path: st.videoPath,
			playing: !video.paused,
			time: video.currentTime,
			loop: st.loop,
			sentAt: Date.now(),
		});
	}

	// 変更のたびに呼ぶ
	function changed({ list = false, props = false } = {}) {
		save();
		stateDirty = true;
		needsDraw = true;
		if (list) renderList();
		if (props) renderProps();
		else updatePropValues();
	}

	// ---------------------------------------------------------------- 元に戻す / やり直し
	const undoStack = [];
	const redoStack = [];
	function snapshot() { return JSON.stringify(st.shapes); }
	function pushUndo() {
		undoStack.push(snapshot());
		if (undoStack.length > 200) undoStack.shift();
		redoStack.length = 0;
	}
	function restore(from, to) {
		if (!from.length) return;
		to.push(snapshot());
		st.shapes = JSON.parse(from.pop());
		if (!shapeById(selId)) { selId = null; selCorner = null; }
		changed({ list: true, props: true });
	}

	// ---------------------------------------------------------------- シェイプ
	function shapeById(id) { return st.shapes.find((s) => s.id === id) || null; }
	function selShape() { return shapeById(selId); }

	function hexDefault() {
		const w = videoW || 1920, h = videoH || 1080;
		return { cx: w / 2, cy: h / 2, r: 486 * h / 1080 };
	}

	function hexVerts(hx) {
		const s = hx.r * S3;
		return {
			C: [hx.cx, hx.cy], T: [hx.cx, hx.cy - hx.r],
			R: [hx.cx + s, hx.cy - hx.r / 2], BR: [hx.cx + s, hx.cy + hx.r / 2],
			B: [hx.cx, hx.cy + hx.r], BL: [hx.cx - s, hx.cy + hx.r / 2], L: [hx.cx - s, hx.cy - hx.r / 2],
		};
	}

	function presetSrc(preset) {
		if (preset === 'full') {
			const w = videoW || 1920, h = videoH || 1080;
			return { src: [[0, 0], [w, 0], [w, h], [0, h]], names: null };
		}
		const face = G.FACES.find((f) => f.name === preset);
		const v = hexVerts(st.hex || hexDefault());
		return { src: face.corners.map((k) => v[k].slice()), names: face.corners.slice() };
	}

	// 入力映像の座標 → 出力の座標（映像全体を出力に収めたときの位置）
	function srcToOut(p) {
		const w = videoW || 1920, h = videoH || 1080;
		const s = Math.min(st.output.width / w, st.output.height / h);
		const ox = (st.output.width - w * s) / 2, oy = (st.output.height - h * s) / 2;
		return [Math.round((p[0] * s + ox) * 10) / 10, Math.round((p[1] * s + oy) * 10) / 10];
	}

	function makeShape(name, color, preset) {
		const { src, names } = presetSrc(preset);
		return {
			id: nextId++,
			name,
			color,
			preset,
			src,
			dst: src.map(srcToOut),
			cornerNames: names,
			visible: true,
			opacity: 1,
			soft: 0,
		};
	}

	function createCube() {
		pushUndo();
		const faces = G.FACES.map((f) => makeShape(f.label, FACE_COLORS[f.name], f.name));
		st.shapes = st.shapes.filter((s) => !['top', 'left', 'right'].includes(s.preset)).concat(faces);
		selId = faces[0].id;
		selCorner = null;
		changed({ list: true, props: true });
	}

	function addQuad() {
		pushUndo();
		const n = st.shapes.length;
		const s = makeShape(`Quad ${n + 1}`, EXTRA_COLORS[n % EXTRA_COLORS.length], 'full');
		// 映像全体を出力の中央に小さめに置く
		const W = st.output.width, H = st.output.height;
		const w = W * 0.35, h = w * (videoH || 1080) / (videoW || 1920);
		s.dst = [[W / 2 - w / 2, H / 2 - h / 2], [W / 2 + w / 2, H / 2 - h / 2], [W / 2 + w / 2, H / 2 + h / 2], [W / 2 - w / 2, H / 2 + h / 2]];
		st.shapes.push(s);
		selId = s.id;
		selCorner = null;
		changed({ list: true, props: true });
	}

	function duplicateSel() {
		const s = selShape();
		if (!s) return;
		pushUndo();
		const d = clone(s);
		d.id = nextId++;
		d.name = s.name + ' のコピー';
		d.dst = d.dst.map(([x, y]) => [x + 30, y + 30]);
		d.preset = null;
		st.shapes.splice(st.shapes.indexOf(s) + 1, 0, d);
		selId = d.id;
		changed({ list: true, props: true });
	}

	function deleteSel() {
		const s = selShape();
		if (!s) return;
		pushUndo();
		st.shapes.splice(st.shapes.indexOf(s), 1);
		selId = null;
		selCorner = null;
		changed({ list: true, props: true });
	}

	function moveOrder(dir) {
		const s = selShape();
		if (!s) return;
		const i = st.shapes.indexOf(s), j = i + dir;
		if (j < 0 || j >= st.shapes.length) return;
		pushUndo();
		st.shapes.splice(i, 1);
		st.shapes.splice(j, 0, s);
		changed({ list: true });
	}

	function select(id, corner = null) {
		selId = id;
		selCorner = corner;
		renderList();
		renderProps();
		needsDraw = true;
	}

	// ---------------------------------------------------------------- 角の移動（重なっている角を連動）
	function linkedTargets(kind, shape, idx, useLink) {
		const p = shape[kind][idx];
		const out = [{ shape, idx }];
		if (!useLink) return out;
		for (const s of st.shapes) {
			s[kind].forEach((q, j) => {
				if ((s !== shape || j !== idx) && Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.75) out.push({ shape: s, idx: j });
			});
		}
		return out;
	}

	function moveTargets(kind, targets, dx, dy) {
		for (const t of targets) {
			const q = t.shape[kind][t.idx];
			t.shape[kind][t.idx] = [Math.round((q[0] + dx) * 10) / 10, Math.round((q[1] + dy) * 10) / 10];
		}
		if (kind === 'src') for (const t of targets) t.shape.preset = null;
	}

	// ---------------------------------------------------------------- 表示（入力ビュー・出力ビュー）
	const srcCanvas = $('srcCanvas');
	const s2 = srcCanvas.getContext('2d');
	const outCanvas = $('outCanvas');
	const overlay = $('outOverlay');
	const o2 = overlay.getContext('2d');
	const mapper = new window.MapRenderer(outCanvas);

	function fitWrap(wrap, stage, w, h) {
		const r = stage.getBoundingClientRect();
		const s = Math.min((r.width - 2) / w, (r.height - 2) / h);
		wrap.style.width = Math.max(1, Math.floor(w * s)) + 'px';
		wrap.style.height = Math.max(1, Math.floor(h * s)) + 'px';
	}

	function layout() {
		fitWrap($('srcWrap'), $('srcStage'), videoW || 1920, videoH || 1080);
		fitWrap($('outWrap'), $('outStage'), st.output.width, st.output.height);
		needsDraw = true;
	}

	function frameReady() { return videoW > 0 && video.readyState >= 2; }

	// キャンバスの 1 CSS px が何画素か
	function pxPerCss(canvas) { return canvas.width / Math.max(canvas.getBoundingClientRect().width, 1); }

	function polyPath(ctx, pts) {
		ctx.beginPath();
		pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
		ctx.closePath();
	}

	function hexToRgba(hex, a) {
		const n = parseInt(hex.slice(1), 16);
		return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
	}

	function drawHandles(ctx, s, kind, k, editable) {
		const pts = s[kind];
		pts.forEach((p, i) => {
			const sel = s.id === selId && i === selCorner && kind === activeKind;
			const r = (sel ? 7 : 5) * k;
			ctx.beginPath();
			ctx.arc(p[0], p[1], r + 1.5 * k, 0, Math.PI * 2);
			ctx.fillStyle = '#000';
			ctx.fill();
			ctx.beginPath();
			ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
			ctx.fillStyle = editable ? s.color : hexToRgba(s.color, 0.5);
			ctx.fill();
			if (sel) {
				ctx.strokeStyle = '#fff';
				ctx.lineWidth = 1.5 * k;
				ctx.beginPath();
				ctx.arc(p[0], p[1], r + 5 * k, 0, Math.PI * 2);
				ctx.stroke();
			}
			if (editable && s.cornerNames) {
				ctx.font = `${11 * k}px "Yu Gothic UI", sans-serif`;
				ctx.lineWidth = 3 * k;
				ctx.strokeStyle = '#000';
				ctx.strokeText(s.cornerNames[i], p[0] + 9 * k, p[1] - 9 * k);
				ctx.fillStyle = '#fff';
				ctx.fillText(s.cornerNames[i], p[0] + 9 * k, p[1] - 9 * k);
			}
		});
	}

	function drawShapeLabel(ctx, s, pts, k) {
		const c = pts.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
		ctx.font = `600 ${13 * k}px "Yu Gothic UI", sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.lineWidth = 4 * k;
		ctx.strokeStyle = 'rgba(0,0,0,0.8)';
		ctx.strokeText(s.name, c[0], c[1]);
		ctx.fillStyle = s.color;
		ctx.fillText(s.name, c[0], c[1]);
		ctx.textAlign = 'start';
		ctx.textBaseline = 'alphabetic';
	}

	function drawSrc() {
		const w = videoW || 1920, h = videoH || 1080;
		if (srcCanvas.width !== w || srcCanvas.height !== h) { srcCanvas.width = w; srcCanvas.height = h; }
		s2.fillStyle = '#000';
		s2.fillRect(0, 0, w, h);
		if (frameReady()) s2.drawImage(video, 0, 0, w, h);
		const k = pxPerCss(srcCanvas);

		for (const s of st.shapes) {
			const isSel = s.id === selId;
			polyPath(s2, s.src);
			s2.fillStyle = hexToRgba(s.color, isSel ? 0.18 : 0.07);
			s2.fill();
			s2.lineWidth = (isSel ? 2 : 1) * k;
			s2.strokeStyle = hexToRgba(s.color, isSel ? 1 : 0.55);
			s2.stroke();
		}
		const sel = selShape();
		if (sel) {
			drawShapeLabel(s2, sel, sel.src, k);
			drawHandles(s2, sel, 'src', k, true);
		}
	}

	function drawOut() {
		const vOk = frameReady();
		mapper.render(st, vOk ? video : null, videoW, videoH);

		const W = st.output.width, H = st.output.height;
		if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
		o2.clearRect(0, 0, W, H);
		const k = pxPerCss(overlay);
		for (const s of st.shapes) {
			if (!s.visible) continue;
			const isSel = s.id === selId;
			polyPath(o2, s.dst);
			o2.lineWidth = (isSel ? 2 : 1) * k;
			o2.strokeStyle = hexToRgba(s.color, isSel ? 1 : 0.6);
			o2.setLineDash(isSel ? [] : [6 * k, 4 * k]);
			o2.stroke();
			o2.setLineDash([]);
		}
		for (const s of st.shapes) {
			if (!s.visible) continue;
			drawHandles(o2, s, 'dst', k, s.id === selId);
			if (s.id === selId) drawShapeLabel(o2, s, s.dst, k);
		}
	}

	// ---------------------------------------------------------------- 描画ループ
	let needsDraw = true;
	let lastTransport = 0;
	function loop() {
		const playing = videoW > 0 && !video.paused;
		if (needsDraw || playing) {
			drawSrc();
			drawOut();
			updateTransport();
			needsDraw = false;
		}
		if (stateDirty && outputOpen) {
			api.sendState(outputState());
			stateDirty = false;
		}
		if (playing && performance.now() - lastTransport > 1000) {
			lastTransport = performance.now();
			sendTransport();
		}
		requestAnimationFrame(loop);
	}

	// ---------------------------------------------------------------- マウス操作
	function eventToPx(canvas, ev) {
		const r = canvas.getBoundingClientRect();
		return [(ev.clientX - r.left) * canvas.width / r.width, (ev.clientY - r.top) * canvas.height / r.height];
	}

	function pointInPoly(p, poly) {
		let inside = false;
		for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
			const [xi, yi] = poly[i], [xj, yj] = poly[j];
			if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
		}
		return inside;
	}

	// 角・シェイプの当たり判定。選択中のシェイプを優先し、残りは手前（リストの後ろ）から
	function hitTest(kind, canvas, p) {
		const lim = 12 * pxPerCss(canvas);
		const order = st.shapes.filter((s) => s.visible || kind === 'src').slice().reverse();
		const sel = selShape();
		const candidates = kind === 'src' ? (sel ? [sel] : []) : (sel ? [sel, ...order.filter((s) => s !== sel)] : order);
		for (const s of candidates) {
			let best = -1, bestD = lim;
			s[kind].forEach((q, i) => {
				const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
				if (d < bestD) { bestD = d; best = i; }
			});
			if (best >= 0) return { shape: s, corner: best };
		}
		for (const s of order) if (pointInPoly(p, s[kind])) return { shape: s, corner: null };
		return null;
	}

	let drag = null;
	function attachDrag(canvas, kind) {
		canvas.addEventListener('pointerdown', (ev) => {
			if (ev.button !== 0) return;
			const p = eventToPx(canvas, ev);
			const hit = hitTest(kind, canvas, p);
			activeKind = kind;
			if (!hit) { select(null); return; }
			select(hit.shape.id, hit.corner);
			const targets = hit.corner !== null
				? linkedTargets(kind, hit.shape, hit.corner, st.linkCorners && !ev.altKey)
				: [0, 1, 2, 3].map((idx) => ({ shape: hit.shape, idx }));
			drag = { kind, targets, last: p, before: snapshot(), moved: false };
			canvas.setPointerCapture(ev.pointerId);
		});
		canvas.addEventListener('pointermove', (ev) => {
			if (!drag || drag.kind !== kind) {
				const hit = hitTest(kind, canvas, eventToPx(canvas, ev));
				canvas.style.cursor = hit ? (hit.corner !== null ? 'grab' : 'move') : '';
				return;
			}
			const p = eventToPx(canvas, ev);
			const f = ev.shiftKey ? 0.25 : 1;
			const dx = (p[0] - drag.last[0]) * f, dy = (p[1] - drag.last[1]) * f;
			drag.last = p;
			if (dx || dy) {
				if (!drag.moved) { undoStack.push(drag.before); redoStack.length = 0; drag.moved = true; }
				moveTargets(kind, drag.targets, dx, dy);
				changed();
			}
		});
		const end = () => { drag = null; needsDraw = true; };
		canvas.addEventListener('pointerup', end);
		canvas.addEventListener('pointercancel', end);
	}
	attachDrag(srcCanvas, 'src');
	attachDrag(overlay, 'dst');

	// ---------------------------------------------------------------- キー操作
	let lastNudge = 0;
	window.addEventListener('keydown', (ev) => {
		const a = document.activeElement;
		if (a && (a.tagName === 'SELECT' || (a.tagName === 'INPUT' && !['range', 'checkbox'].includes(a.type)))) return;
		const ctrl = ev.ctrlKey || ev.metaKey;
		const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
		const s = selShape();

		if (ctrl && ev.key.toLowerCase() === 'z') { restore(ev.shiftKey ? redoStack : undoStack, ev.shiftKey ? undoStack : redoStack); ev.preventDefault(); return; }
		if (ctrl && ev.key.toLowerCase() === 'y') { restore(redoStack, undoStack); ev.preventDefault(); return; }
		if (ctrl && ev.key.toLowerCase() === 'd') { duplicateSel(); ev.preventDefault(); return; }

		if (arrows[ev.key] && s) {
			const step = ev.shiftKey ? 10 : 1;
			const [dx, dy] = arrows[ev.key];
			if (performance.now() - lastNudge > 700) pushUndo();
			lastNudge = performance.now();
			const targets = selCorner !== null
				? linkedTargets(activeKind, s, selCorner, st.linkCorners && !ev.altKey)
				: [0, 1, 2, 3].map((idx) => ({ shape: s, idx }));
			moveTargets(activeKind, targets, dx * step, dy * step);
			changed();
			ev.preventDefault();
		} else if (arrows[ev.key] && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
			stepFrame(ev.key === 'ArrowLeft' ? -1 : 1);
			ev.preventDefault();
		} else if (ev.key === 'Tab' && s) {
			selCorner = selCorner === null ? 0 : (selCorner + (ev.shiftKey ? 3 : 1)) % 4;
			renderProps();
			needsDraw = true;
			ev.preventDefault();
		} else if (ev.key === 'Escape') {
			if (selCorner !== null) selCorner = null; else selId = null;
			renderList();
			renderProps();
			needsDraw = true;
		} else if (ev.key === 'Delete' || ev.key === 'Backspace') {
			deleteSel();
		} else if (ev.key === ' ') {
			togglePlay();
			ev.preventDefault();
		} else if (ev.key.toLowerCase() === 't' && !ctrl) {
			$('testPattern').click();
		} else if (ev.key.toLowerCase() === 'b' && !ctrl) {
			$('blackout').click();
		}
	});

	// ---------------------------------------------------------------- シェイプ一覧・プロパティ
	function renderList() {
		const box = $('shapeList');
		box.innerHTML = '';
		if (!st.shapes.length) {
			const n = document.createElement('div');
			n.className = 'note';
			n.textContent = 'シェイプがありません。「キューブ3面を作成」で、六角形の3つの面を貼る Quad を作ります。';
			box.append(n);
		}
		// 手前（後ろに描くもの）を上に表示する
		for (const s of st.shapes.slice().reverse()) {
			const row = document.createElement('div');
			row.className = 'shape-row' + (s.id === selId ? ' selected' : '') + (s.visible ? '' : ' hidden-shape');
			const vis = document.createElement('input');
			vis.type = 'checkbox';
			vis.checked = s.visible;
			vis.title = '表示';
			vis.addEventListener('click', (e) => e.stopPropagation());
			vis.addEventListener('change', () => { pushUndo(); s.visible = vis.checked; changed({ list: true }); });
			const dot = document.createElement('span');
			dot.className = 'dot';
			dot.style.background = s.color;
			const name = document.createElement('span');
			name.className = 'name';
			name.textContent = s.name;
			const meta = document.createElement('span');
			meta.className = 'meta';
			meta.textContent = s.opacity < 1 ? `${Math.round(s.opacity * 100)}%` : '';
			row.append(vis, dot, name, meta);
			row.addEventListener('click', () => { activeKind = 'dst'; select(s.id); });
			box.append(row);
		}
	}

	const dstInputs = [];
	function renderProps() {
		const s = selShape();
		$('noSel').hidden = !!s;
		$('props').hidden = !s;
		if (!s) return;
		$('shName').value = s.name;
		$('shSrcPreset').value = s.preset && s.preset !== 'full' ? s.preset : (s.preset === 'full' ? 'full' : '');
		const box = $('dstRows');
		box.innerHTML = '';
		dstInputs.length = 0;
		s.dst.forEach((p, i) => {
			const row = document.createElement('div');
			row.className = 'corner-row' + (i === selCorner && activeKind === 'dst' ? ' selected' : '');
			const label = document.createElement('span');
			label.textContent = s.cornerNames ? `${s.cornerNames[i]}　${G.POINT_LABELS[s.cornerNames[i]]}` : `角 ${i + 1}`;
			const x = document.createElement('input');
			const y = document.createElement('input');
			for (const [inp, axis] of [[x, 0], [y, 1]]) {
				inp.type = 'number';
				inp.step = '0.5';
				inp.addEventListener('focus', () => { selCorner = i; activeKind = 'dst'; pushUndo(); needsDraw = true; });
				inp.addEventListener('input', () => {
					const v = parseFloat(inp.value);
					if (isNaN(v)) return;
					const cur = s.dst[i];
					const targets = linkedTargets('dst', s, i, st.linkCorners);
					moveTargets('dst', targets, axis === 0 ? v - cur[0] : 0, axis === 1 ? v - cur[1] : 0);
					changed();
				});
			}
			row.append(label, x, y);
			box.append(row);
			dstInputs.push([x, y]);
		});
		updatePropValues();
	}

	function updatePropValues() {
		const s = selShape();
		if (!s) return;
		$('shOpacity').value = s.opacity;
		$('shOpacityN').value = s.opacity;
		$('shSoft').value = s.soft;
		$('shSoftN').value = s.soft;
		s.dst.forEach((p, i) => {
			const [x, y] = dstInputs[i] || [];
			if (x && document.activeElement !== x) x.value = p[0];
			if (y && document.activeElement !== y) y.value = p[1];
		});
	}

	$('shName').addEventListener('input', () => {
		const s = selShape();
		if (s) { s.name = $('shName').value; changed({ list: true }); }
	});

	function linkShapeRange(key, rangeId, numId) {
		const r = $(rangeId), n = $(numId);
		let pushed = false;
		const set = (v) => {
			const s = selShape();
			if (!s || isNaN(v)) return;
			if (!pushed) { pushUndo(); pushed = true; }
			s[key] = v;
			changed({ list: key === 'opacity' });
		};
		r.addEventListener('input', () => set(parseFloat(r.value)));
		n.addEventListener('input', () => set(parseFloat(n.value)));
		for (const el of [r, n]) el.addEventListener('change', () => { pushed = false; });
	}
	linkShapeRange('opacity', 'shOpacity', 'shOpacityN');
	linkShapeRange('soft', 'shSoft', 'shSoftN');

	$('shSrcPreset').addEventListener('change', () => {
		const s = selShape();
		const v = $('shSrcPreset').value;
		if (!s || !v) return;
		pushUndo();
		const { src, names } = presetSrc(v);
		s.src = src;
		s.cornerNames = names;
		s.preset = v;
		changed({ props: true });
	});

	$('btnResetDst').addEventListener('click', () => {
		const s = selShape();
		if (!s) return;
		pushUndo();
		s.dst = s.src.map(srcToOut);
		changed();
	});

	$('btnCube').addEventListener('click', createCube);
	$('btnAdd').addEventListener('click', addQuad);
	$('btnDup').addEventListener('click', duplicateSel);
	$('btnDel').addEventListener('click', deleteSel);
	$('btnUp').addEventListener('click', () => moveOrder(1));
	$('btnDown').addEventListener('click', () => moveOrder(-1));
	$('linkCorners').addEventListener('change', () => { st.linkCorners = $('linkCorners').checked; save(); });

	// ---------------------------------------------------------------- 六角形の位置（キューブ3面の入力範囲）
	function linkHex(key, rangeId, numId) {
		const r = $(rangeId), n = $(numId);
		const set = (v, from) => {
			if (isNaN(v)) return;
			st.hex = { ...(st.hex || hexDefault()), [key]: v };
			if (from !== r) r.value = v;
			if (from !== n) n.value = v;
			// 六角形プリセットのままのシェイプは入力範囲を追従させる
			for (const s of st.shapes) {
				if (['top', 'left', 'right'].includes(s.preset)) s.src = presetSrc(s.preset).src;
			}
			changed();
		};
		r.addEventListener('input', () => set(parseFloat(r.value), r));
		n.addEventListener('input', () => set(parseFloat(n.value), n));
	}
	linkHex('cx', 'hexCx', 'hexCxN');
	linkHex('cy', 'hexCy', 'hexCyN');
	linkHex('r', 'hexR', 'hexRN');

	function refreshHexInputs() {
		const h = st.hex || hexDefault();
		$('hexCx').value = $('hexCxN').value = Math.round(h.cx * 10) / 10;
		$('hexCy').value = $('hexCyN').value = Math.round(h.cy * 10) / 10;
		$('hexR').value = $('hexRN').value = Math.round(h.r * 10) / 10;
	}
	$('btnHexReset').addEventListener('click', () => {
		st.hex = hexDefault();
		for (const s of st.shapes) if (['top', 'left', 'right'].includes(s.preset)) s.src = presetSrc(s.preset).src;
		refreshHexInputs();
		changed();
	});

	// ---------------------------------------------------------------- 出力の設定・出力ウィンドウ
	function evenSize(v) { return Math.max(64, Math.round(v)); }
	$('outW').addEventListener('change', () => { st.output.width = evenSize(+$('outW').value); $('outW').value = st.output.width; layout(); changed(); });
	$('outH').addEventListener('change', () => { st.output.height = evenSize(+$('outH').value); $('outH').value = st.output.height; layout(); changed(); });
	$('testPattern').addEventListener('change', () => { st.testPattern = $('testPattern').checked; changed(); });
	$('blackout').addEventListener('change', () => { st.blackout = $('blackout').checked; changed(); });
	$('fullscreen').addEventListener('change', () => { st.fullscreen = $('fullscreen').checked; save(); });
	$('display').addEventListener('change', () => { st.displayId = Number($('display').value); save(); });

	async function refreshDisplays() {
		const list = await api.listDisplays();
		const sel = $('display');
		sel.innerHTML = '';
		for (const d of list) {
			const o = document.createElement('option');
			o.value = d.id;
			o.textContent = d.label;
			sel.append(o);
		}
		const keep = list.find((d) => d.id === st.displayId);
		const pick = keep || list.find((d) => !d.primary) || list[0];
		if (pick) sel.value = pick.id;
		st.displayId = pick ? pick.id : null;
	}
	api.onDisplaysChanged(refreshDisplays);

	function setOutputOpen(on) {
		outputOpen = on;
		$('btnOutput').textContent = on ? '出力中（クリックで閉じる）' : '出力ウィンドウを開く';
		$('btnOutput').classList.toggle('live', on);
	}

	$('btnOutput').addEventListener('click', async () => {
		if (outputOpen) {
			await api.closeOutput();
			return;
		}
		await api.openOutput({ displayId: st.displayId, fullscreen: st.fullscreen });
		setOutputOpen(true);
	});
	api.onOutputClosed(() => setOutputOpen(false));
	api.onOutputRequestState(() => {
		outputOpenRequested();
	});
	function outputOpenRequested() {
		setOutputOpen(true);
		api.sendState(outputState());
		sendTransport();
		stateDirty = false;
	}

	// ---------------------------------------------------------------- 映像・再生
	function fmtTime(t) {
		if (!isFinite(t)) t = 0;
		const m = Math.floor(t / 60);
		return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
	}

	function updateTransport() {
		if (!videoW) return;
		const seek = $('seek');
		if (!seek.matches(':active')) seek.value = Math.round(video.currentTime / (video.duration || 1) * 1000);
		$('timecode').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
		$('btnPlay').textContent = video.paused ? '▶︎' : '❚❚';
	}

	function baseName(p) { return p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1); }

	async function loadVideo(path, quiet = false) {
		if (!path) return;
		if (!(await api.fileExists(path))) {
			if (!quiet) alert('映像が見つかりません:\n' + path);
			return;
		}
		video.src = api.fileUrl(path);
		try {
			await new Promise((res, rej) => {
				video.addEventListener('loadeddata', res, { once: true });
				video.addEventListener('error', () => rej(new Error('この映像は再生できません')), { once: true });
			});
		} catch (e) {
			if (!quiet) alert(e.message);
			return;
		}
		const sizeChanged = videoW !== video.videoWidth || videoH !== video.videoHeight;
		videoW = video.videoWidth;
		videoH = video.videoHeight;
		st.videoPath = path;
		if (!st.hex || (sizeChanged && st.shapes.length === 0)) st.hex = hexDefault();
		refreshHexInputs();
		$('fileInfo').textContent = `${baseName(path)}　${videoW}×${videoH}　${fmtTime(video.duration)}`;
		$('fileInfo').title = path;
		layout();
		changed();
		sendTransport();
	}

	function togglePlay() {
		if (!videoW) return;
		if (video.paused) video.play(); else video.pause();
	}

	function stepFrame(n) {
		if (!videoW) return;
		video.pause();
		video.currentTime = Math.min(Math.max(video.currentTime + n * FRAME, 0), video.duration);
	}

	video.addEventListener('play', () => { needsDraw = true; sendTransport(); });
	video.addEventListener('pause', () => { needsDraw = true; sendTransport(); });
	video.addEventListener('seeked', () => { needsDraw = true; sendTransport(); });
	video.addEventListener('ended', () => { needsDraw = true; });
	$('btnPlay').addEventListener('click', togglePlay);
	$('btnPrev').addEventListener('click', () => stepFrame(-1));
	$('btnNext').addEventListener('click', () => stepFrame(1));
	$('seek').addEventListener('input', () => {
		if (videoW) video.currentTime = $('seek').value / 1000 * video.duration;
	});
	$('loop').addEventListener('change', () => { st.loop = video.loop = $('loop').checked; save(); sendTransport(); });
	$('mute').addEventListener('change', () => { st.mute = video.muted = $('mute').checked; save(); });

	$('btnOpen').addEventListener('click', async () => {
		const p = await api.openVideo();
		if (p) loadVideo(p);
	});

	window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragover'); });
	window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragover'); });
	window.addEventListener('drop', async (e) => {
		e.preventDefault();
		document.body.classList.remove('dragover');
		const f = e.dataTransfer.files[0];
		if (!f) return;
		const p = api.pathForFile(f);
		if (/\.json$/i.test(p)) return;
		loadVideo(p);
	});

	// ---------------------------------------------------------------- プロジェクトの保存・読み込み
	$('btnSave').addEventListener('click', async () => {
		const def = st.videoPath ? st.videoPath.replace(/\.[^.]+$/, '') + '_mapping.json' : 'mapping.json';
		await api.saveProject({ app: 'cubemapper', version: 1, ...st }, def);
	});

	$('btnLoad').addEventListener('click', async () => {
		const data = await api.loadProject();
		if (!data || !Array.isArray(data.shapes)) return;
		pushUndo();
		st = { ...clone(DEFAULTS), ...data };
		delete st.app;
		delete st.version;
		nextId = st.shapes.reduce((m, s) => Math.max(m, s.id), 0) + 1;
		selId = null;
		selCorner = null;
		refreshControls();
		await refreshDisplays();
		if (st.videoPath) await loadVideo(st.videoPath);
		layout();
		changed({ list: true, props: true });
	});

	function refreshControls() {
		$('outW').value = st.output.width;
		$('outH').value = st.output.height;
		$('testPattern').checked = st.testPattern;
		$('blackout').checked = st.blackout;
		$('fullscreen').checked = st.fullscreen;
		$('linkCorners').checked = st.linkCorners;
		$('loop').checked = video.loop = st.loop;
		$('mute').checked = video.muted = st.mute;
		refreshHexInputs();
	}

	// ---------------------------------------------------------------- 起動
	refreshControls();
	renderList();
	renderProps();
	refreshDisplays();
	window.addEventListener('resize', layout);
	new ResizeObserver(layout).observe($('outStage'));
	layout();
	requestAnimationFrame(loop);

	(async () => {
		const t = api.selftest;
		if (t.video) {
			st = clone(DEFAULTS);
			st.mute = true;
			refreshControls();
			await loadVideo(t.video);
			createCube();
			if (t.drag) {
				// 実物のキューブを想定して、出力側の角をいくつか動かす（共有された角が連動するかの確認）
				const top = st.shapes.find((s) => s.preset === 'top');
				const move = (shape, i, dx, dy) => moveTargets('dst', linkedTargets('dst', shape, i, true), dx, dy);
				move(top, 0, 40, 60);     // C
				move(top, 2, -20, -30);   // T
				move(top, 1, 70, 10);     // R
				const left = st.shapes.find((s) => s.preset === 'left');
				move(left, 2, -50, 20);   // BL
				activeKind = 'dst';
				select(top.id, 0);
				changed();
			}
			if (t.seek) {
				video.currentTime = t.seek;
				await new Promise((res) => video.addEventListener('seeked', res, { once: true }));
			}
			if (t.output) {
				await api.openOutput({ displayId: null, fullscreen: false, primary: true });
				await new Promise((r) => setTimeout(r, 1500));
			}
			needsDraw = true;
			setTimeout(() => t.ready(), 500);
		} else if (st.videoPath) {
			loadVideo(st.videoPath, true);
		}
	})();
})();
