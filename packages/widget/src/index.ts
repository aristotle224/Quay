import { addEventListener, bindButtons, closeModal, openModal } from "./modal";
import type { QuayEventHandler, QuayEventType, QuayOpenOptions, QuaySDK } from "./types";

export const Quay: QuaySDK = {
  open: (linkIdOrOpts: string | QuayOpenOptions, opts?: Partial<QuayOpenOptions>) => openModal(linkIdOrOpts, opts),
  close: () => closeModal(),
  init: () => bindButtons(),
  on: (event: QuayEventType, handler: QuayEventHandler) => addEventListener(event, handler),
};

// Backwards compatibility alias
export const StellarCheckout = Quay;

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).Quay = Quay;
  (window as unknown as Record<string, unknown>).StellarCheckout = Quay;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindButtons);
  } else {
    bindButtons();
  }
}

export * from "./types";
export default Quay;
