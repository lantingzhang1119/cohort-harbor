// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pdfMocks = vi.hoisted(() => ({
  renderTasks: [] as Array<{ cancel: ReturnType<typeof vi.fn>; promise: Promise<void> }>,
  renderPage: vi.fn(),
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => {
          const task = { cancel: vi.fn(), promise: new Promise<void>(() => undefined) };
          pdfMocks.renderTasks.push(task);
          pdfMocks.renderPage();
          return task;
        },
      }),
    }),
  }),
}));

import { PolicyViewer } from "@/features/policies/components/policy-viewer";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

let observedClientWidth = 900;

describe("employee policy PDF viewer", () => {
  beforeEach(() => {
    observedClientWidth = 900;
    sessionStorage.clear();
    pdfMocks.renderTasks.length = 0;
    pdfMocks.renderPage.mockClear();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      json: async () => ({
        policies: [{ id: "policy-1", versions: [{ previewFormat: "PDF" }] }],
        watermarkName: "员工甲",
        watermarkOpacity: 0.07,
      }),
    })));
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => observedClientWidth);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("cancels the active PDF.js render before zoom starts another render on the same canvas", async () => {
    render(<PolicyViewer policyId="policy-1" />);
    await waitFor(() => expect(pdfMocks.renderPage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "放大" }));

    await waitFor(() => expect(pdfMocks.renderPage.mock.calls.length).toBeGreaterThan(1));
    expect(pdfMocks.renderTasks[0]?.cancel).toHaveBeenCalledTimes(1);
  });

  it("exposes an accessible toolbar and uses the mobile canvas width", async () => {
    observedClientWidth = 390;
    const { container } = render(<PolicyViewer policyId="policy-1" />);

    expect(await screen.findByRole("toolbar", { name: "预览控制" })).toBeDefined();
    await waitFor(() => expect(pdfMocks.renderPage).toHaveBeenCalledTimes(1));
    expect(container.querySelector("canvas")?.style.width).toBe("378px");
  });
});
