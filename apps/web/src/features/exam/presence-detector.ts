/**
 * The face detector itself: MediaPipe BlazeFace (short range), running in WebAssembly on the student's device.
 * Loaded only for exams with the camera presence check on, so the main bundle stays small. The WASM runtime and the
 * model are served from this site — nothing is fetched from a third party during an exam, and no frame ever leaves
 * the device: the only output is a face count and a brightness value.
 */
import { FaceDetector } from '@mediapipe/tasks-vision';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import { installSameOriginFetchGuard } from '@/lib/same-origin-guard';

export const MODEL_URL = '/models/blaze_face_short_range.tflite';

export interface FrameAnalyser {
  analyse(video: HTMLVideoElement, at: number): { faces: number; luminance: number };
  close(): void;
}

export async function createFrameAnalyser(): Promise<FrameAnalyser> {
  // MediaPipe sends usage telemetry to a Google endpoint every minute; nothing leaves a student's device during an exam.
  installSameOriginFetchGuard();
  const detector = await FaceDetector.createFromOptions({ wasmLoaderPath, wasmBinaryPath }, { baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' }, runningMode: 'VIDEO', minDetectionConfidence: 0.6 });
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 24;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    analyse(video, at) {
      const faces = detector.detectForVideo(video, at).detections.length;
      let luminance = 1;
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
        luminance = sum / (px.length / 4) / 255;
      }
      return { faces, luminance };
    },
    close: () => detector.close(),
  };
}
