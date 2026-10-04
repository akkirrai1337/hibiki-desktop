import { Capacitor, registerPlugin } from "@capacitor/core";

export interface NativeResponse {
  status: number;
  url: string;
  headers: Record<string, string[]>;
  body: string;
}

export interface HibikiNetPlugin {
  request(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    followRedirects?: boolean;
    timeoutMs?: number;
  }): Promise<NativeResponse>;
  /** Headers the stream proxy will add to every request made under the returned session id. */
  registerStream(options: { headers: Record<string, string> }): Promise<{ sid: string }>;
  /** Releases a worker blocked in a synchronous XHR on /_hibiki/bridge/<id> (the "xhr" transport). */
  bridgeResolve(options: { id: string; body: string }): Promise<void>;
}

export interface HibikiBrowserPlugin {
  open(options: { key: string; url: string; headers?: Record<string, string>; clearOrigin?: boolean }): Promise<void>;
  eval(options: { key: string; js: string }): Promise<{ value: string }>;
  cookies(options: { url: string }): Promise<{ value: string }>;
  userAgent(): Promise<{ value: string }>;
  close(options: { key: string }): Promise<void>;
}

export const HibikiNet = registerPlugin<HibikiNetPlugin>("HibikiNet");
export const HibikiBrowser = registerPlugin<HibikiBrowserPlugin>("HibikiBrowser");
export const isNative = Capacitor.isNativePlatform();
