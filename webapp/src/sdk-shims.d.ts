declare module '../../../jeejio-bubble/sdk/WebApp.js' {
  export class BubbleWebApp {
    constructor(options?: Record<string, unknown>);
    ble?: unknown;
    getDevice?(options?: Record<string, unknown>): Promise<unknown>;
    getDevices(): Promise<unknown[]>;
    request(type: string, payload?: unknown, options?: Record<string, unknown>): Promise<unknown>;
    callDevice(device: unknown, payload: unknown, options?: Record<string, unknown>): Promise<unknown>;
    subscribeDeviceEvents(device: unknown): Promise<unknown>;
    onDeviceEvent(handler: (event: unknown) => void): void;
  }
}

declare module '../../../jeejio-bubble/sdk/BleAppClient.js' {
  export class BleAppClient {
    constructor(bridge: unknown, options?: Record<string, unknown>);
    state: { connection: string; message?: string; lastError?: string };
    ensureConnected(device: unknown, options?: Record<string, unknown>): Promise<unknown>;
    reconnect(options?: Record<string, unknown>): Promise<unknown>;
    send(device: unknown, payload: unknown, options?: Record<string, unknown>): Promise<unknown>;
    sendRealtime(channel: string, data?: unknown, options?: Record<string, unknown>): Promise<unknown>;
    on(name: string, handler: (event: any) => void): void;
    off(name: string, handler: (event: any) => void): void;
  }
}
