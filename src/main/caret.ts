// Text-caret tracking via AT-SPI (the accessibility bus) so the popup can
// open where the paste will actually land ("Cursor" position mode).
//
// How it works: we connect to the a11y bus, register interest in
// object:text-caret-moved and object:state-changed:focused (registration is
// what makes toolkits emit them at all), and cache the most recent caret
// event from the currently focused application. When the popup opens we
// query that object's live caret rectangle.
//
// Coordinates are best-effort: Qt apps on native Wayland report the caret's
// "screen" position without the window origin (observed with Konsole), so if
// the caret rect falls outside the widget's own extents we re-add the widget
// origin; anything that still doesn't land on a real display is rejected and
// the caller falls back to mouse placement.

import * as dbus from 'dbus-next';
import { screen } from 'electron';

interface CaretSource {
  sender: string;
  path: string;
  offset: number;
  at: number;
}

export interface CaretPoint {
  x: number;
  y: number; // bottom edge of the caret — popup goes just below this
}

const EVENT_INTERFACE = 'org.a11y.atspi.Event.Object';
const TEXT_INTERFACE = 'org.a11y.atspi.Text';
const COMPONENT_INTERFACE = 'org.a11y.atspi.Component';
const COORD_SCREEN = 0;

export class CaretTracker {
  private bus: dbus.MessageBus | null = null;
  // Recent distinct caret sources, newest first. Hidden widgets (e.g. a
  // background terminal tab whose cursor still blinks) report zero extents
  // and get rejected, so we keep a few candidates to fall back through.
  private caretHistory: CaretSource[] = [];
  private focusedSender: string | null = null;
  // App names whose caret we must never track (our own popup's search box
  // would otherwise become the anchor once our Chromium exposes a11y).
  private static readonly OWN_APP_NAMES = new Set(['ctrlc', 'electron']);
  private senderNames = new Map<string, string>();

  /** Connect to the a11y bus and start tracking. Never throws. */
  async start(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    try {
      const session = dbus.sessionBus();
      const a11yObj = await session.getProxyObject('org.a11y.Bus', '/org/a11y/bus');
      const address = await a11yObj.getInterface('org.a11y.Bus').GetAddress();
      session.disconnect();

      this.bus = dbus.sessionBus({ busAddress: address });

      // Toolkits only emit events someone has registered for.
      await this.registerEvent('object:text-caret-moved');
      await this.registerEvent('object:state-changed:focused');

      for (const member of ['TextCaretMoved', 'StateChanged']) {
        await this.bus.call(new dbus.Message({
          destination: 'org.freedesktop.DBus',
          path: '/org/freedesktop/DBus',
          interface: 'org.freedesktop.DBus',
          member: 'AddMatch',
          signature: 's',
          body: [`type='signal',interface='${EVENT_INTERFACE}',member='${member}'`],
        }));
      }

      this.bus.on('message', (msg: dbus.Message) => this.onMessage(msg));
      this.bus.on('error', () => { /* connection lost — getCaretPoint degrades to null */ });
      console.log('[CaretTracker] Listening for caret events on the a11y bus');
      return true;
    } catch (err) {
      console.warn('[CaretTracker] AT-SPI unavailable:', (err as Error).message);
      this.bus = null;
      return false;
    }
  }

  stop(): void {
    try {
      this.bus?.disconnect();
    } catch {
      // already gone
    }
    this.bus = null;
  }

  private async registerEvent(event: string): Promise<void> {
    // at-spi2 >= 2.46 wants (s as s); older daemons take a bare (s).
    const attempt = (signature: string, body: unknown[]) =>
      this.bus!.call(new dbus.Message({
        destination: 'org.a11y.atspi.Registry',
        path: '/org/a11y/atspi/registry',
        interface: 'org.a11y.atspi.Registry',
        member: 'RegisterEvent',
        signature,
        body,
      }));
    try {
      await attempt('sass', [event, [], '']);
    } catch {
      await attempt('s', [event]);
    }
  }

  private onMessage(msg: dbus.Message): void {
    if (process.env.CTRLC_DEBUG_CARET) {
      console.log('[CaretTracker] msg:', msg.type, msg.interface, msg.member, msg.sender);
    }
    if (msg.member === 'StateChanged') {
      const [state, gained] = (msg.body || []) as [string, number];
      if (state === 'focused' && gained === 1 && msg.sender) {
        this.focusedSender = msg.sender;
      }
      return;
    }
    if (msg.member === 'TextCaretMoved') {
      // Ignore background apps (e.g. an unfocused terminal's blinking cursor
      // emits caret events forever) and our own windows.
      if (this.focusedSender && msg.sender !== this.focusedSender) return;
      const src: CaretSource = {
        sender: msg.sender || '',
        path: msg.path || '',
        offset: ((msg.body || [])[1] as number) ?? 0,
        at: Date.now(),
      };
      this.caretHistory = [
        src,
        ...this.caretHistory.filter((c) => c.sender !== src.sender || c.path !== src.path),
      ].slice(0, 4);
    }
  }

  /**
   * Live caret position of the focused text field, or null when unknown /
   * untrustworthy (caller should fall back to mouse placement).
   */
  async getCaretPoint(): Promise<CaretPoint | null> {
    if (!this.bus) return null;
    if (this.caretHistory.length === 0) {
      if (process.env.CTRLC_DEBUG_CARET) {
        console.log(`[CaretTracker] no caret events yet (focusedSender=${this.focusedSender})`);
      }
      return null;
    }
    for (const src of this.caretHistory) {
      const point = await this.resolveCaretPoint(src);
      if (point) return point;
    }
    return null;
  }

  private async resolveCaretPoint(src: CaretSource): Promise<CaretPoint | null> {
    const debug = (why: string): null => {
      if (process.env.CTRLC_DEBUG_CARET) {
        console.log(`[CaretTracker] rejected ${src.sender}${src.path.slice(-12)}:`, why);
      }
      return null;
    };
    try {
      const appName = (await this.senderName(src.sender)).toLowerCase();
      if (CaretTracker.OWN_APP_NAMES.has(appName)) return debug(`own app (${appName})`);
      // The event's offset goes stale the moment the text changes (e.g. a
      // terminal printing output), so ask for the current caret offset.
      const offset = (await this.liveCaretOffset(src)) ?? src.offset;
      const caret = await this.callRect(src, TEXT_INTERFACE, 'GetCharacterExtents', 'iu', [offset, COORD_SCREEN]);
      if (!caret || caret[3] <= 0) return debug(`bad caret rect ${JSON.stringify(caret)} (offset=${offset})`);

      let [x, y, , h] = caret;

      if (!this.onAnyDisplay(x, y)) return debug(`off-display (${x},${y})`);

      // Wayland-Qt quirk: caret "screen" coords missing the window origin.
      // If the caret isn't inside its own widget's rect, re-add the origin.
      const widget = await this.callRect(src, COMPONENT_INTERFACE, 'GetExtents', 'u', [COORD_SCREEN]);
      if (widget && !this.inside(x, y, widget)) {
        const fixedX = x + widget[0];
        const fixedY = y + widget[1];
        if (this.inside(fixedX, fixedY, widget) && this.onAnyDisplay(fixedX, fixedY)) {
          x = fixedX;
          y = fixedY;
        } else {
          return debug(`origin fix-up failed caret=(${x},${y}) widget=${JSON.stringify(widget)}`);
        }
      }

      return { x, y: y + h };
    } catch (err) {
      return debug(`exception: ${(err as Error).message}`);
    }
  }

  /** Current caret offset of the tracked text object, or null. */
  private async liveCaretOffset(src: CaretSource): Promise<number | null> {
    try {
      const reply = await this.bus!.call(new dbus.Message({
        destination: src.sender,
        path: src.path,
        interface: 'org.freedesktop.DBus.Properties',
        member: 'Get',
        signature: 'ss',
        body: [TEXT_INTERFACE, 'CaretOffset'],
      }));
      const variant = reply?.body?.[0];
      const value = typeof variant?.value === 'number' ? variant.value : Number(variant?.value);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** Resolve (and cache) the application name behind a bus sender. */
  private async senderName(sender: string): Promise<string> {
    const cached = this.senderNames.get(sender);
    if (cached !== undefined) return cached;
    let name = '';
    try {
      const reply = await this.bus!.call(new dbus.Message({
        destination: sender,
        path: '/org/a11y/atspi/accessible/root',
        interface: 'org.freedesktop.DBus.Properties',
        member: 'Get',
        signature: 'ss',
        body: ['org.a11y.atspi.Accessible', 'Name'],
      }));
      const variant = reply?.body?.[0];
      name = typeof variant?.value === 'string' ? variant.value : '';
    } catch {
      // unknown app — treat as foreign
    }
    this.senderNames.set(sender, name);
    return name;
  }

  private async callRect(
    src: CaretSource,
    iface: string,
    member: string,
    signature: string,
    body: unknown[],
  ): Promise<[number, number, number, number] | null> {
    const reply = await this.bus!.call(new dbus.Message({
      destination: src.sender,
      path: src.path,
      interface: iface,
      member,
      signature,
      body,
    }));
    const out = reply?.body;
    // GetCharacterExtents returns four bare ints (iiii); GetExtents returns
    // one (iiii) struct — normalize both shapes.
    if (Array.isArray(out) && out.length === 4 && typeof out[0] === 'number') {
      return out as [number, number, number, number];
    }
    if (Array.isArray(out) && Array.isArray(out[0]) && out[0].length === 4) {
      return out[0] as [number, number, number, number];
    }
    return null;
  }

  private inside(x: number, y: number, rect: [number, number, number, number]): boolean {
    return x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3];
  }

  private onAnyDisplay(x: number, y: number): boolean {
    return screen.getAllDisplays().some((d) => {
      const b = d.bounds;
      return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
    });
  }
}
