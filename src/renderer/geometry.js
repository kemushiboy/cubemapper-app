// hexcube の幾何計算。プレビュー（WebGL）と書き出し（ffmpeg remap 用の対応表）の両方がこれを使う。
// TouchDesigner 版 hexcube_pixel.glsl と同じ計算だが、座標は「ソース映像の画素・左上原点」。
//
//        T
//   L         R          上面 = C-R-T-L
//        C               左面 = C-L-BL-B
//   BL        BR         右面 = C-R-BR-B
//        B
(function (root) {
	'use strict';

	const S3 = Math.sqrt(3) / 2;

	const POINT_KEYS = ['T', 'L', 'C', 'R', 'BL', 'B', 'BR'];

	const POINT_LABELS = {
		T: '上', L: '左上', C: '中央（手前）', R: '右上', BL: '左下', B: '下', BR: '右下',
	};

	// 元映像（1280x720）で計測した初期値。左上原点
	const DEFAULT_POINTS = {
		T: [631, 180], L: [385, 254], C: [638, 361], R: [889, 261],
		BL: [411, 587], B: [634, 706], BR: [860, 587],
	};

	// 面ごとの (u,v)=(0,0),(1,0),(1,1),(0,1) に対応するキューブの角
	const FACES = [
		{ name: 'top', label: '上面', corners: ['C', 'R', 'T', 'L'] },
		{ name: 'left', label: '左面', corners: ['C', 'L', 'BL', 'B'] },
		{ name: 'right', label: '右面', corners: ['C', 'R', 'BR', 'B'] },
	];

	// 出力側：正六角形を3つの菱形に分けたときの各面の基底（y 上向き）
	const E_R = [S3, 0.5], E_L = [-S3, 0.5], E_D = [0, -1];
	const FACE_BASIS = [[E_R, E_L], [E_L, E_D], [E_R, E_D]];

	function inv2(a, b) {
		// 列ベクトル a, b からなる 2x2 行列の逆行列 [m00, m01, m10, m11]
		const det = a[0] * b[1] - b[0] * a[1];
		return [b[1] / det, -b[0] / det, -a[1] / det, a[0] / det];
	}
	const FACE_BASIS_INV = FACE_BASIS.map(([a, b]) => inv2(a, b));

	// 単位正方形 (u,v) → 四角形 への射影変換 (Heckbert)
	// 返り値 [a,b,c,d,e,f,g,h]： x = (a u + b v + c)/(g u + h v + 1), y = (d u + e v + f)/(...)
	function sq2quad(p00, p10, p11, p01) {
		const sx = p00[0] - p10[0] + p11[0] - p01[0];
		const sy = p00[1] - p10[1] + p11[1] - p01[1];
		const dx1 = p10[0] - p11[0], dy1 = p10[1] - p11[1];
		const dx2 = p01[0] - p11[0], dy2 = p01[1] - p11[1];
		const det = dx1 * dy2 - dx2 * dy1;
		const g = (sx * dy2 - dx2 * sy) / det;
		const h = (dx1 * sy - sx * dy1) / det;
		return [
			p10[0] - p00[0] + g * p10[0], p01[0] - p00[0] + h * p01[0], p00[0],
			p10[1] - p00[1] + g * p10[1], p01[1] - p00[1] + h * p01[1], p00[1],
			g, h,
		];
	}

	function faceHomographies(points) {
		return FACES.map((f) => sq2quad(...f.corners.map((k) => points[k])));
	}

	function applyH(H, u, v) {
		const w = H[6] * u + H[7] * v + 1;
		return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w, w];
	}

	// 面の内側で負、外側で正（面の辺長単位）
	function boxDist(a, b) {
		return Math.max(Math.max(-a, a - 1), Math.max(-b, b - 1));
	}

	// 出力画素 (px,py)（左上原点）→ どの面の (a,b) か。最も近い面を返す
	function outputToFace(px, py, hex) {
		const qx = (px - hex.cx) / hex.radius;
		const qy = -(py - hex.cy) / hex.radius;
		let best = 0, bestD = Infinity, bestA = 0, bestB = 0;
		for (let i = 0; i < 3; i++) {
			const m = FACE_BASIS_INV[i];
			const a = m[0] * qx + m[1] * qy;
			const b = m[2] * qx + m[3] * qy;
			const d = boxDist(a, b);
			if (d < bestD) { bestD = d; best = i; bestA = a; bestB = b; }
		}
		return { face: best, a: bestA, b: bestB, dist: bestD };
	}

	// 出力画素 → ソース座標（左上原点・画素）。範囲外なら null
	function outputToSource(px, py, hex, H, srcW, srcH) {
		const f = outputToFace(px, py, hex);
		if (f.dist > hex.bleed) return null;
		const s = applyH(H[f.face], f.a, f.b);
		if (s[2] <= 0 || s[0] < 0 || s[1] < 0 || s[0] >= srcW || s[1] >= srcH) return null;
		return s;
	}

	// 設定から六角形の中心・半径を求める
	function hexFromSettings(st) {
		return {
			cx: st.outW / 2 + st.offsetX,
			cy: st.outH / 2 + st.offsetY,
			radius: st.radius,
			bleed: st.bleed,
		};
	}

	// ffmpeg remap 用の対応表。ソースを upscale 倍に拡大した画像の画素番号を入れる
	// （拡大してから最近傍で引くことで、補間に近い画質にする）。範囲外は 65535（fill 色になる）
	function buildRemap(st, points, srcW, srcH, upscale) {
		const w = st.outW, h = st.outH;
		const hex = hexFromSettings(st);
		const H = faceHomographies(points);
		const xmap = new Uint16Array(w * h);
		const ymap = new Uint16Array(w * h);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = y * w + x;
				const s = outputToSource(x + 0.5, y + 0.5, hex, H, srcW, srcH);
				if (s) {
					xmap[i] = Math.min(Math.floor(s[0] * upscale), srcW * upscale - 1);
					ymap[i] = Math.min(Math.floor(s[1] * upscale), srcH * upscale - 1);
				} else {
					xmap[i] = 65535;
					ymap[i] = 65535;
				}
			}
		}
		return { xmap, ymap };
	}

	// 16bit PGM（ビッグエンディアン）にする
	function toPGM16(data, w, h) {
		const header = new TextEncoder().encode(`P5\n${w} ${h}\n65535\n`);
		const out = new Uint8Array(header.length + data.length * 2);
		out.set(header, 0);
		const dv = new DataView(out.buffer, header.length);
		for (let i = 0; i < data.length; i++) dv.setUint16(i * 2, data[i], false);
		return out;
	}

	const api = {
		POINT_KEYS, POINT_LABELS, DEFAULT_POINTS, FACES,
		sq2quad, faceHomographies, applyH, boxDist,
		outputToFace, outputToSource, hexFromSettings, buildRemap, toPGM16,
	};

	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else root.HexGeom = api;
})(typeof window !== 'undefined' ? window : globalThis);
