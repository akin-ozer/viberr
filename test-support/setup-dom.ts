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

/**
 * jsdom implements no 2D canvas: `getContext` reports "not implemented" through
 * the virtual console's error channel and returns null. The run console's wait
 * row mounts a `thinking-orbs` canvas (ruling 366), which returns early on a
 * null context — so the honest stub answers null quietly, and a panel test's
 * output is not an error the code under test never raised.
 */
if ("window" in globalThis && "HTMLCanvasElement" in window) {
  window.HTMLCanvasElement.prototype.getContext = () => null;
}

/**
 * jsdom has no AnimationEvent. React picks, once as it loads, the event name
 * its `onAnimationEnd` listens for: with no AnimationEvent it falls back to the
 * prefixed `webkitAnimationEnd`, a name no current browser fires, so a test's
 * `fireEvent.animationEnd` never reached a handler (ruling 451(g) records a
 * refusal's shake as played at its `animationend`). Installed before any test
 * imports react-dom, the shim gives React the browsers' unprefixed wiring.
 */
if ("window" in globalThis && !Object.hasOwn(window, "AnimationEvent")) {
  class AnimationEventShim extends window.Event {
    readonly animationName: string;
    readonly elapsedTime: number;
    readonly pseudoElement: string;
    constructor(type: string, init: AnimationEventInit = {}) {
      super(type, init);
      this.animationName = init.animationName ?? "";
      this.elapsedTime = init.elapsedTime ?? 0;
      this.pseudoElement = init.pseudoElement ?? "";
    }
  }
  Object.defineProperty(window, "AnimationEvent", { value: AnimationEventShim, configurable: true, writable: true });
}

/**
 * jsdom's Range has no `getBoundingClientRect` (it lays nothing out). Lexical
 * calls it on the DOM selection's range whenever it commits an update while the
 * editor holds the focus with a collapsed caret in text, to scroll the caret
 * into view, so a composer test whose editor had just taken the focus (an
 * @mention inserted, a prefill) could end in an uncaught TypeError from a
 * commit that landed before its cleanup. An empty rect is the honest answer
 * from a host with no layout; `Element.prototype` already answers the same.
 */
if ("window" in globalThis && !Object.hasOwn(window.Range.prototype, "getBoundingClientRect")) {
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 0, 0);
}
