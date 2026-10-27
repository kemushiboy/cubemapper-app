// プロジェクションマッピングの描画（編集画面のプレビューとプロジェクター出力ウィンドウで共用）
// 各シェイプは「入力映像上の四角形 src」を「出力上の四角形 dst」へ射影変換で貼る（Kantan Mapper の Quad と同じ考え方）
(function (root) {
	'use strict';

	const G = root.HexGeom;

	const VS = `#version 300 es
	in vec2 aPos;
	void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

	const FS = `#version 300 es
	precision highp float;
	uniform sampler2D uSrc;
	uniform vec2 uSrcRes;
	uniform vec2 uOutRes;
	uniform mat3 uDstInv;   // 出力画素 → シェイプ内の (u,v)
	uniform mat3 uSrcH;     // (u,v) → 入力映像の画素
	uniform float uOpacity;
	uniform float uSoft;    // ソフトエッジ幅（シェイプの辺長に対する割合）
	uniform int uMode;      // 0=映像 1=テストパターン
	uniform vec3 uColor;
	uniform float uHasSrc;
	out vec4 fragColor;

	float gridLine(vec2 t, float w) {
		vec2 fw = max(fwidth(t), vec2(1e-5));
		vec2 g = abs(fract(t - 0.5) - 0.5) / fw;
		return 1.0 - clamp(min(g.x, g.y) / w, 0.0, 1.0);
	}

	void main() {
		vec2 p = vec2(gl_FragCoord.x, uOutRes.y - gl_FragCoord.y);
		vec3 h = uDstInv * vec3(p, 1.0);
		vec2 uv = h.xy / h.z;
		if (h.z <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;

		vec3 col;
		if (uMode == 1) {
			// 位置合わせ用：面の色＋8分割グリッド＋太い外枠＋対角線
			col = uColor * 0.35;
			col = mix(col, vec3(1.0), gridLine(uv * 8.0, 1.2) * 0.8);
			float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
			vec2 fw = fwidth(uv);
			col = mix(col, uColor, 1.0 - clamp(edge / (max(fw.x, fw.y) * 4.0), 0.0, 1.0));
			float diag = min(abs(uv.x - uv.y), abs(uv.x + uv.y - 1.0)) / max(fw.x, fw.y);
			col = mix(col, vec3(1.0), (1.0 - clamp(diag / 1.2, 0.0, 1.0)) * 0.5);
		} else {
			vec3 s = uSrcH * vec3(uv, 1.0);
			vec2 st = s.xy / s.z / uSrcRes;
			col = uHasSrc > 0.5 ? textureLod(uSrc, clamp(st, 0.0, 1.0), 0.0).rgb : uColor * 0.25;
		}

		float a = uOpacity;
		if (uSoft > 0.0) {
			float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
			a *= smoothstep(0.0, uSoft, e);
		}
		fragColor = vec4(col * a, a);
	}`;

	// 3x3 行列（行優先 9 要素）の逆行列
	function inv3(m) {
		const [a, b, c, d, e, f, g, h, i] = m;
		const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
		const det = a * A + b * B + c * C;
		return [
			A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
			B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
			C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
		];
	}

	// 四角形の4隅 [p00,p10,p11,p01] → 射影変換行列（行優先 9 要素）
	function quadH(q) {
		const h = G.sq2quad(q[0], q[1], q[2], q[3]);
		return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
	}

	// 行優先 → GLSL の列優先
	function colMajor(m) {
		return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
	}

	function hexColor(hex) {
		const n = parseInt(hex.slice(1), 16);
		return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
	}

	class MapRenderer {
		constructor(canvas) {
			this.canvas = canvas;
			const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
			this.gl = gl;

			const compile = (type, src) => {
				const s = gl.createShader(type);
				gl.shaderSource(s, src);
				gl.compileShader(s);
				if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
				return s;
			};
			const prog = gl.createProgram();
			gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
			gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
			gl.linkProgram(prog);
			if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
			gl.useProgram(prog);
			this.prog = prog;

			const buf = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, buf);
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
			const aPos = gl.getAttribLocation(prog, 'aPos');
			gl.enableVertexAttribArray(aPos);
			gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

			this.tex = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, this.tex);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

			this.U = {};
			for (const n of ['uSrc', 'uSrcRes', 'uOutRes', 'uDstInv', 'uSrcH', 'uOpacity', 'uSoft', 'uMode', 'uColor', 'uHasSrc']) {
				this.U[n] = gl.getUniformLocation(prog, n);
			}
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		}

		// state: { output:{width,height}, shapes:[...], testPattern, blackout }
		// video: HTMLVideoElement（フレームがなければ null）, srcW/srcH: 入力映像の大きさ
		render(state, video, srcW, srcH) {
			const gl = this.gl, U = this.U;
			const W = state.output.width, H = state.output.height;
			if (this.canvas.width !== W || this.canvas.height !== H) {
				this.canvas.width = W;
				this.canvas.height = H;
			}
			gl.viewport(0, 0, W, H);
			gl.clearColor(0, 0, 0, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			if (state.blackout) return;

			gl.bindTexture(gl.TEXTURE_2D, this.tex);
			if (video) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
			gl.uniform1i(U.uSrc, 0);
			gl.uniform2f(U.uSrcRes, srcW || 1, srcH || 1);
			gl.uniform2f(U.uOutRes, W, H);
			gl.uniform1i(U.uMode, state.testPattern ? 1 : 0);
			gl.uniform1f(U.uHasSrc, video ? 1 : 0);

			for (const s of state.shapes) {
				if (!s.visible) continue;
				gl.uniformMatrix3fv(U.uDstInv, false, colMajor(inv3(quadH(s.dst))));
				gl.uniformMatrix3fv(U.uSrcH, false, colMajor(quadH(s.src)));
				gl.uniform1f(U.uOpacity, s.opacity);
				gl.uniform1f(U.uSoft, s.soft);
				gl.uniform3fv(U.uColor, hexColor(s.color));
				gl.drawArrays(gl.TRIANGLES, 0, 3);
			}
		}
	}

	root.MapRenderer = MapRenderer;
})(window);
