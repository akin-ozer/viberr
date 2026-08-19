/**
 * Vitest setup: jsdom still ships HTMLDialogElement without the
 * showModal()/show()/close() methods the app's native <dialog> modals use.
 * Polyfill just enough for component tests: toggle the `open` attribute and
 * fire the `close` event. No-op under the node environment.
 *
 * Both probes below ask whether the HOST actually provides the API. `Object.hasOwn`
 * rather than `in` for the two NEGATIVE probes on purpose: lib.dom declares both
 * members, so `!(… in …)` narrows the very branch that installs the polyfill to
 * `never` — the declaration is a promise lib.dom makes and jsdom does not keep,
 * which is the whole reason this file exists.
 */
if ("window" in globalThis && "HTMLDialogElement" in window) {
  const proto = window.HTMLDialogElement.prototype;
  if (!Object.hasOwn(proto, "showModal")) {
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    proto.show = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    proto.close = function (this: HTMLDialogElement, returnValue?: string) {
      if (returnValue !== undefined) this.returnValue = returnValue;
      this.removeAttribute("open");
      this.dispatchEvent(new window.Event("close"));
    };
  }
}

/**
 * jsdom has no ResizeObserver; dnd-kit (board drag-and-drop) references it on
 * import. Component tests never exercise real geometry, so an inert stub is
 * the honest shape.
 */
if ("window" in globalThis && !Object.hasOwn(window, "ResizeObserver")) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver = ResizeObserverStub;
}
