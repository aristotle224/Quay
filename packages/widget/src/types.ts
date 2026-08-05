export type QuayEventType = "quay:paid" | "quay:closed" | "quay:error";

export interface QuayEventData {
  type: QuayEventType;
  linkId?: string;
  link?: Record<string, unknown>;
  error?: string;
}

export type QuayEventHandler = (data: QuayEventData) => void;

export interface QuayOpenOptions {
  linkId: string;
  host?: string;
  onPaid?: QuayEventHandler;
  onClosed?: QuayEventHandler;
  onError?: QuayEventHandler;
}

export interface QuaySDK {
  open: (linkId: string | QuayOpenOptions, opts?: Partial<QuayOpenOptions>) => void;
  close: () => void;
  init: () => void;
  on: (event: QuayEventType, handler: QuayEventHandler) => () => void;
}
