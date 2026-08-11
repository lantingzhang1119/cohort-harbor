ALTER TABLE "GuidePortalPublication" ADD COLUMN "sceneVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GuidePortalPublication" ADD COLUMN "scene" JSONB;
ALTER TABLE "GuidePortalPublication" ADD COLUMN "legacyElements" JSONB;

-- Preserve the original legacy array before any future V1 conversion.
UPDATE "GuidePortalPublication"
SET "legacyElements" = "elements"
WHERE json_type("elements") = 'array';

-- Repair V1 rows written by the short-lived object-in-elements implementation.
-- The canonical scene is preserved byte-for-byte before elements is projected.
UPDATE "GuidePortalPublication"
SET
    "sceneVersion" = 1,
    "scene" = "elements"
WHERE json_type("elements") = 'object'
  AND json_extract("elements", '$.sceneVersion') = 1;

UPDATE "GuidePortalPublication"
SET "elements" = COALESCE((
    SELECT json_group_array(json(projected."legacyElement"))
    FROM (
        SELECT json_object(
            'id', json_extract(element.value, '$.id'),
            'kind', 'IMAGE',
            'assetId', json_extract(element.value, '$.assetId'),
            'x', json_extract(element.value, '$.x'),
            'y', json_extract(element.value, '$.y'),
            'width', json_extract(element.value, '$.width'),
            'height', json_extract(element.value, '$.height'),
            'zIndex', row_number() OVER (
                ORDER BY
                    CAST(json_extract(element.value, '$.zIndex') AS INTEGER),
                    CAST(json_extract(element.value, '$.id') AS TEXT)
            ) - 1,
            'altText', json_extract(element.value, '$.altText')
        ) AS "legacyElement"
        FROM json_each("GuidePortalPublication"."scene", '$.elements') AS element
        WHERE json_extract(element.value, '$.type') = 'IMAGE'
          AND COALESCE(json_extract(element.value, '$.hidden'), 0) = 0
          AND COALESCE(json_extract(element.value, '$.opacity'), 1) > 0
        ORDER BY
            CAST(json_extract(element.value, '$.zIndex') AS INTEGER),
            CAST(json_extract(element.value, '$.id') AS TEXT)
    ) AS projected
), json('[]'))
WHERE "sceneVersion" = 1
  AND "scene" IS NOT NULL
  AND json_type("elements") = 'object';

UPDATE "GuidePortalPublication"
SET "legacyElements" = "elements"
WHERE "sceneVersion" = 1
  AND "scene" IS NOT NULL
  AND "legacyElements" IS NULL;
