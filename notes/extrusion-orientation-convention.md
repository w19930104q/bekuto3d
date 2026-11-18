# Extrusion orientation convention (SVG → extrude → 3MF)

Goal: 2D contour cleanup, triangulation, and 3MF writing share one orientation
convention, so exported solids are watertight with consistent outward normals
(printable) even for shapes with holes, self-intersecting contours, and
curve-approximated outlines.

## Key locations

- `src/composables/useSvgLoader.ts` — `normalizePathDirections` (direction cleanup),
  `resolveSelfIntersections` (geometry cleanup), `createShapesWithColor`
  (SVGLoader → `Shape[]`)
- `src/components/ModelRenderer.vue` — `TresExtrudeGeometry` (triangulation) and the
  display mirror `scale: [scale, -scale, 1]`
- `packages/three-3mf-exporter/src/index.ts` — `exportTo3MF`,
  `bakeNegativeDeterminantTransforms` (orientation normalization boundary)
- `test/extrusion-orientation.test.ts` + `test/fixtures/*.svg` — end-to-end fixtures
- `packages/three-3mf-exporter/test/orientation.test.ts` — exporter-level guarantees

## The shared convention

**Stage 1 — SVG source (y-down coordinates).** `normalizePathDirections` rewrites
every `<path>` so outer subpaths wind clockwise and inner ones counter-clockwise
(`fix-path-directions`, `toClockwise: true`). Three.js `ShapePath.toShapes()`
classifies solids vs holes by winding _number_ under the nonzero fill rule, so
consistent input directions make the classification match user intent (outer =
solid, inner = hole). After classification, `resolveSelfIntersections` flattens
any shape whose rings cross (x-sweep segment test) and rebuilds it from a boolean
self-union (`polygon-clipping`), because earcut cannot triangulate
self-intersecting contours (see watch items). Shapes without crossings keep their
curves, so the renderer's `curveSegments` setting still applies to them; cleaned
shapes are already flat (sampled at `CLEANUP_CURVE_SEGMENTS = 24`).

**Stage 2 — three.js shape space.** Shapes keep SVG's y-down coordinates.
`ExtrudeGeometry` normalizes winding itself (contour → clockwise per
`ShapeUtils.isClockWise`, holes → counter-clockwise) and always emits
outward-facing triangles in local space: bottom cap at z=0 facing −Z, top cap at
z=depth facing +Z, walls facing outward. So the app never fixes winding itself —
what matters is that stage 1 got the solid/hole _classification_ right.

**Stage 3 — 3MF (right-handed, millimeters).** Triangles must wind
counter-clockwise seen from outside, and only **positive-determinant transforms**
may be written. A mirrored transform (negative determinant — e.g. the renderer's
Y-flip `scale(s, -s, 1)`) inverts the winding of every mesh it references,
producing an inside-out solid in any slicer that trusts triangle orientation.
Since no triangle reordering can cancel a mirrored _transform_, `exportTo3MF`
rewrites any build item whose accumulated transform chain contains a negative
determinant: the full chain is baked into new mesh components (reversing triangle
winding on mirrored leaves) and the item is re-referenced with an identity
transform. Items without mirrors serialize exactly as before (pinned by
`output-compat.test.ts`).

## Non-obvious decisions / watch items

- The display mirror stays in `ModelRenderer`; the 3MF exporter is the single
  normalization boundary. STL/glTF exports still carry the mirror (STL normals
  come out inverted; slicers usually auto-repair). If that ever needs fixing,
  bake at the same boundary instead of touching the render transform.
- Watertightness relies on `collectMeshData` welding identical coordinates:
  `ExtrudeGeometry` emits caps and walls with separate but coincident vertices,
  which weld into a closed edge-manifold mesh. Degenerate triangles from
  zero-length contour segments (duplicate consecutive points) would break edge
  parity — never emit paths with duplicate consecutive points.
- earcut **cannot** triangulate self-intersecting contours: on a pentagram it
  silently drops cap area (5-gon cap → 2 triangles instead of 3), leaving open
  edges in the extruded mesh. Never feed a self-crossing ring to
  `ExtrudeGeometry` — route it through `resolveSelfIntersections` first. The
  boolean union also defines the fill semantics of self-overlapping contours
  (pentagram → solid star outline).
- Transform serialization order (`e0 e1 e2 e4 …`) matches the 3MF spec only for
  symmetric matrices (scale/translate, which is all the app produces); rotated
  assemblies may be transposed relative to the spec. Pinned by the output-compat
  snapshot — verify against real slicers before changing.
- `[Content_Types].xml` must not be the first zip entry (breaks decompression in
  some consumers); the zip entry order is asserted by the orientation tests.

## Test strategy

Fixtures (`test/fixtures/`): `hole.svg` (rect with rect hole + arc circle, covers
holes and curve approximation; the hole subpath deliberately winds the same way as
the outer shell to exercise direction cleanup), `self-intersecting.svg`
(pentagram, exercises `resolveSelfIntersections`).

Both the app-level test and the exporter-level test check, on the _parsed 3MF
output_ (transforms applied to vertices):

- **watertight** — every welded undirected edge is shared by exactly 2 triangles
- **consistent normals** — signed volume (divergence theorem) is positive
- **stable volume** — repeated exports give identical volume, and the volume
  matches `fill area × depth × scale²` derived from the loaded shapes
- **zip structure** — expected entry set, `[Content_Types].xml` not first
- **transforms** — every written `transform` has positive determinant
