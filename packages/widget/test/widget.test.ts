// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Quay } from "../src/index";

describe("Quay Widget SDK", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Quay.close();
  });

  it("exposes expected Quay SDK API methods", () => {
    expect(typeof Quay.open).toBe("function");
    expect(typeof Quay.close).toBe("function");
    expect(typeof Quay.init).toBe("function");
    expect(typeof Quay.on).toBe("function");
  });

  it("opens modal and appends overlay element to body", () => {
    Quay.open("lnk_test_123");

    const modal = document.getElementById("quay-checkout-modal");
    expect(modal).not.toBeNull();
    expect(modal?.getAttribute("role")).toBe("dialog");

    const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.src).toContain("/pay/lnk_test_123?embed=true");
  });

  it("closes modal on Quay.close() call", () => {
    Quay.open("lnk_test_123");
    expect(document.getElementById("quay-checkout-modal")).not.toBeNull();

    Quay.close();
    expect(document.getElementById("quay-checkout-modal")).toBeNull();
  });

  it("binds click listener to [data-quay-link] button", () => {
    document.body.innerHTML = `<button id="pay-btn" data-quay-link="lnk_btn_456" data-quay-label="Pay $10">Pay</button>`;
    
    Quay.init();

    const btn = document.getElementById("pay-btn")!;
    expect(btn.textContent).toBe("Pay $10");

    btn.click();

    const modal = document.getElementById("quay-checkout-modal");
    expect(modal).not.toBeNull();
    const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
    expect(iframe.src).toContain("/pay/lnk_btn_456?embed=true");
  });

  it("subscribes to events with Quay.on()", () => {
    const onPaid = vi.fn();
    const unsubscribe = Quay.on("quay:paid", onPaid);

    Quay.open("lnk_test_123");

    const event = new MessageEvent("message", {
      data: { type: "quay:paid", linkId: "lnk_test_123", link: { id: "lnk_test_123" } },
      origin: window.location.origin,
    });
    window.dispatchEvent(event);

    expect(onPaid).toHaveBeenCalledWith({
      type: "quay:paid",
      linkId: "lnk_test_123",
      link: { id: "lnk_test_123" },
    });

    unsubscribe();
  });
});
