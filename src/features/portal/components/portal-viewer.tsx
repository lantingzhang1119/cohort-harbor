import { PORTAL_CANVAS_SIZES, type PortalElementInput } from "@/features/portal/portal-schemas";

export type PortalLayout = {
  canvasWidth: number;
  canvasHeight: number;
  version: number | null;
  elements: Array<PortalElementInput & { assetUrl: string }>;
};

export type PublishedPortal = PortalLayout & {
  sceneVersion: 0;
  viewport: "DESKTOP" | "MOBILE";
  version: number;
};

export type PublishedScenePortal = {
  sceneVersion: 1;
  version: number;
  scene: unknown;
};

export type EmployeePublishedPortal = PublishedPortal | PublishedScenePortal;

export function PortalViewer({ portal }: { portal: PortalLayout }) {
  const width = portal.canvasWidth || PORTAL_CANVAS_SIZES.DESKTOP.canvasWidth;
  const height = portal.canvasHeight || PORTAL_CANVAS_SIZES.DESKTOP.canvasHeight;
  return <section role="region" className="portal-viewer" aria-label={portal.version === null ? "预览（未发布）" : `四城门户发布版本 ${portal.version}`} style={{ aspectRatio: `${width} / ${height}` }}>
    {[...portal.elements].sort((left, right) => left.zIndex - right.zIndex).map((element) => <div key={element.id} style={{ left: `${(element.x / width) * 100}%`, top: `${(element.y / height) * 100}%`, width: `${(element.width / width) * 100}%`, height: `${(element.height / height) * 100}%`, zIndex: element.zIndex }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={element.assetUrl} alt={element.altText} />
    </div>)}
  </section>;
}
