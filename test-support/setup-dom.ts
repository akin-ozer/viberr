/**
 * Vitest setup: jsdom (29.x) still ships HTMLDialogElement without the
 * showModal()/show()/close() methods the app's native <dialog> modals use.
 * Polyfill just enough for component tests: toggle the `open` attribute and
 * fire the `close` event. No-op under the node environment.
 */
if (typeof window !== "undefined" && typeof window.HTMLDialogElement !== "undefined") {
  const proto = window.HTMLDialogElement.prototype;
  if (typeof proto.showModal !== "function") {
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
