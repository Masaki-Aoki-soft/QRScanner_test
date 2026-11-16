"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readBarcodes, type ReaderOptions } from "zxing-wasm/reader";

type Mode = "fallback" | "zxing" | "wechat";
type Engine = "zxing" | "wechat";
type WechatState = "none" | "loading" | "ready" | "error";
type WechatModule = typeof import("qr-scanner-wechat");

// ---- 調整用パラメータ ----
const FALLBACK_AFTER_MS = 2000; // fallback モードで zxing が何ms読めなければ WeChat を使い始めるか
const WECHAT_EVERY_N = 3; // fallback 時、WeChat は何フレームに1回回すか（重いため）
const ROI_RATIO = 0.7; // 映像中央の何割を切り出して解析するか

const ZXING_OPTS: ReaderOptions = {
  formats: ["QRCode"],
  tryHarder: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 1,
};

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export default function Scanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(false);
  const wechatRef = useRef<WechatModule | null>(null);
  const wechatPromiseRef = useRef<Promise<WechatModule> | null>(null);

  const [mode, setMode] = useState<Mode>("fallback");
  const modeRef = useRef<Mode>(mode);
  const [cameraOn, setCameraOn] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<{ engine: Engine; text: string; ms: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [wechatState, setWechatState] = useState<WechatState>("none");
  const [portrait, setPortrait] = useState(true);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- WeChat（OpenCV WASM, 約6MB）の遅延ロード ----
  const loadWechat = useCallback(() => {
    if (!wechatPromiseRef.current) {
      setWechatState("loading");
      wechatPromiseRef.current = import("qr-scanner-wechat")
        .then(async (m) => {
          await m.ready();
          wechatRef.current = m;
          setWechatState("ready");
          return m;
        })
        .catch((e) => {
          console.error(e);
          wechatPromiseRef.current = null;
          setWechatState("error");
          throw e;
        });
    }
    return wechatPromiseRef.current;
  }, []);

  useEffect(() => {
    modeRef.current = mode;
    if (mode === "wechat") loadWechat().catch(() => {});
  }, [mode, loadWechat]);

  // ---- スキャンループ ----
  const scanLoop = useCallback(async () => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const startedAt = performance.now();
    let frame = 0;
    let lastUi = 0;

    while (runningRef.current) {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) {
        await nextFrame();
        continue;
      }

      // 中央の正方形をフル解像度のまま切り出す
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const size = Math.floor(Math.min(vw, vh) * ROI_RATIO);
      canvas.width = size;
      canvas.height = size;
      ctx.drawImage(video, (vw - size) / 2, (vh - size) / 2, size, size, 0, 0, size, size);

      const ms = performance.now() - startedAt;
      if (ms - lastUi > 100) {
        setElapsed(ms);
        lastUi = ms;
      }

      const m = modeRef.current;
      let hit: { engine: Engine; text: string } | null = null;

      // ① zxing（毎フレーム）
      if (m !== "wechat") {
        try {
          const img = ctx.getImageData(0, 0, size, size);
          const [r] = await readBarcodes(img, ZXING_OPTS);
          if (r?.isValid && r.text) hit = { engine: "zxing", text: r.text };
        } catch (e) {
          console.error("zxing error", e);
        }
      }

      // ② WeChat（wechat モード: 毎フレーム / fallback モード: 一定時間後に N フレームに1回）
      const useWechat = m === "wechat" || (m === "fallback" && ms > FALLBACK_AFTER_MS);
      if (!hit && useWechat) {
        if (!wechatRef.current) {
          loadWechat().catch(() => {});
        } else if (m === "wechat" || frame % WECHAT_EVERY_N === 0) {
          try {
            const r = await wechatRef.current.scan(canvas);
            if (r.text) hit = { engine: "wechat", text: r.text };
          } catch {
            // 未検出時に例外になることがあるので無視
          }
        }
      }

      frame++;

      if (hit) {
        runningRef.current = false;
        setResult({ ...hit, ms });
        setScanning(false);
        navigator.vibrate?.(100);
        break;
      }
      await nextFrame();
    }
  }, [loadWechat]);

  const startScan = useCallback(() => {
    setResult(null);
    setElapsed(0);
    setScanning(true);
    runningRef.current = true;
    void scanLoop();
  }, [scanLoop]);

  // ---- カメラ起動 ----
  const startCamera = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("カメラAPIが使えません。HTTPS（または localhost）で開いてください。");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      setPortrait(video.videoHeight >= video.videoWidth);

      const track = stream.getVideoTracks()[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const caps: any = track.getCapabilities?.() ?? {};
      if (caps.focusMode?.includes("continuous")) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as any] }).catch(() => {});
      }
      setTorchSupported(!!caps.torch);

      setCameraOn(true);
      startScan();
    } catch (e) {
      setError(`カメラを起動できませんでした: ${(e as Error).message}`);
    }
  }, [startScan]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as any] });
      setTorchOn(!torchOn);
    } catch {
      setTorchSupported(false);
    }
  }, [torchOn]);

  useEffect(() => {
    return () => {
      runningRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ---- 表示 ----
  const success = !!result;
  const statusColor = success ? "#16a34a" : scanning ? "#b91c1c" : "#374151";
  const statusText = success ? "✅ 読み取れた" : scanning ? "❌ 未検出" : "待機中";

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: 12 }}>
      <h1 style={{ fontSize: 18, margin: "4px 0 12px" }}>QR読み取りテスト</h1>

      <div
        style={{
          background: statusColor,
          borderRadius: 12,
          padding: "16px 12px",
          textAlign: "center",
          marginBottom: 12,
          transition: "background 0.2s",
        }}
      >
        <div style={{ fontSize: 32, fontWeight: 700 }}>{statusText}</div>
        <div style={{ fontSize: 14, marginTop: 6, opacity: 0.9 }}>
          {success
            ? `エンジン: ${result.engine} ／ ${(result.ms / 1000).toFixed(1)}秒`
            : scanning
              ? `経過 ${(elapsed / 1000).toFixed(1)}秒`
              : "「カメラ開始」を押してください"}
        </div>
        {success && (
          <div style={{ fontSize: 12, marginTop: 6, opacity: 0.8, wordBreak: "break-all" }}>{result.text}</div>
        )}
      </div>

      <div style={{ position: "relative", background: "#000", borderRadius: 12, overflow: "hidden" }}>
        <video ref={videoRef} playsInline muted style={{ width: "100%", display: "block" }} />
        {cameraOn && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              aspectRatio: "1 / 1",
              ...(portrait ? { width: `${ROI_RATIO * 100}%` } : { height: `${ROI_RATIO * 100}%` }),
              border: `3px solid ${success ? "#22c55e" : "#fff"}`,
              borderRadius: 8,
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        {!cameraOn ? (
          <button onClick={startCamera} style={btn}>カメラ開始</button>
        ) : (
          <button onClick={startScan} disabled={scanning} style={{ ...btn, opacity: scanning ? 0.5 : 1 }}>
            もう一度
          </button>
        )}
        {torchSupported && (
          <button onClick={toggleTorch} style={btn}>ライト {torchOn ? "OFF" : "ON"}</button>
        )}
      </div>

      <fieldset style={{ marginTop: 12, border: "1px solid #444", borderRadius: 8 }}>
        <legend style={{ fontSize: 13 }}>エンジン</legend>
        {(
          [
            ["fallback", `zxing → ${FALLBACK_AFTER_MS / 1000}秒後に WeChat 併用`],
            ["zxing", "zxing のみ"],
            ["wechat", "WeChat のみ"],
          ] as const
        ).map(([v, label]) => (
          <label key={v} style={{ display: "block", fontSize: 14, padding: "4px 0" }}>
            <input type="radio" name="mode" checked={mode === v} onChange={() => setMode(v)} /> {label}
          </label>
        ))}
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
          WeChat: {{ none: "未ロード", loading: "読み込み中…", ready: "準備完了", error: "読み込み失敗" }[wechatState]}
        </div>
      </fieldset>

      {error && <p style={{ color: "#f87171", fontSize: 14 }}>{error}</p>}
    </main>
  );
}

const btn: React.CSSProperties = {
  flex: 1,
  padding: "12px 16px",
  fontSize: 16,
  borderRadius: 8,
  border: "none",
  background: "#2563eb",
  color: "#fff",
};
