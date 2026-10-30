/**
 * jsdom (26) has no PointerEvent and no pointer capture. The whiteboard relies
 * on Pointer Events so one code path serves mouse, trackpad, touch and stylus;
 * this shim lets Testing Library's fireEvent.pointerDown/Move/Up reach it.
 */
if (typeof window !== 'undefined' && !('PointerEvent' in window)) {
  class PointerEventShim extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly pressure: number;
    readonly width: number;
    readonly height: number;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? '';
      this.pressure = init.pressure ?? 0;
      this.width = init.width ?? 1;
      this.height = init.height ?? 1;
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventShim, configurable: true, writable: true });
}
if (typeof Element !== 'undefined') {
  const proto = Element.prototype as Element & { setPointerCapture?: unknown; releasePointerCapture?: unknown; hasPointerCapture?: unknown };
  if (typeof proto.setPointerCapture !== 'function') proto.setPointerCapture = () => undefined;
  if (typeof proto.releasePointerCapture !== 'function') proto.releasePointerCapture = () => undefined;
  if (typeof proto.hasPointerCapture !== 'function') proto.hasPointerCapture = () => false;
}
