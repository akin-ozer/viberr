/**
 * An `EventSource` a test drives by hand (stub it as the global): it records
 * every source the page opens and hands what the test emits to the listeners
 * for that event name. A test that reads `instances` resets it first.
 */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState: number = FakeEventSource.OPEN;
  /** The page closed it. */
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  removeEventListener(): void {}

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** The browser FAILING the connection: a non-200 answer (an expired session
   *  401s), which it never retries. */
  fail(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }

  /** One event, its `data` as the wire carries it. */
  emit(name: string, lastEventId = "", data = "{}"): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(new MessageEvent<string>(name, { data, lastEventId }));
    }
  }

  /** The source opened last. */
  static last(): FakeEventSource {
    return FakeEventSource.instances.at(-1)!;
  }

  /** The sources the page has not closed. */
  static open(): FakeEventSource[] {
    return FakeEventSource.instances.filter((source) => !source.closed);
  }
}
