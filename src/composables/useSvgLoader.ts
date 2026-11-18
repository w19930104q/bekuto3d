import type { ShapeWithColor } from '~/types/three-types'
import fixPathDirections from 'fix-path-directions'
import polygonClipping from 'polygon-clipping'
import { Color, Path, Shape, Vector2 } from 'three'
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js'

const { getFixedPathDataString } = fixPathDirections as {
  getFixedPathDataString: (d: string, options?: { toClockwise?: boolean }) => string
}

const hasDomParser = typeof globalThis !== 'undefined' && typeof (globalThis as any).DOMParser !== 'undefined'
const hasXmlSerializer = typeof globalThis !== 'undefined' && typeof (globalThis as any).XMLSerializer !== 'undefined'

export function normalizePathDirections(svgMarkup: string) {
  if (!hasDomParser)
    return svgMarkup

  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(svgMarkup, 'image/svg+xml')
    if (doc.querySelector('parsererror'))
      return svgMarkup

    let modified = false
    const paths = doc.querySelectorAll('path[d]')

    paths.forEach((path) => {
      const d = path.getAttribute('d')
      if (!d)
        return

      try {
        const fixed = getFixedPathDataString(d, { toClockwise: true })
        if (fixed && fixed !== d) {
          path.setAttribute('d', fixed)
          modified = true
        }
      }
      catch (error) {
        if (import.meta.env.DEV)
          console.warn('[useSvgLoader] Failed to normalize path direction', error)
      }
    })

    if (!modified)
      return svgMarkup

    if (!hasXmlSerializer)
      return svgMarkup

    const serializer = new XMLSerializer()
    return serializer.serializeToString(doc.documentElement)
  }
  catch (error) {
    if (import.meta.env.DEV)
      console.warn('[useSvgLoader] Failed to preprocess SVG paths', error)
    return svgMarkup
  }
}

/** Curve sampling resolution used to detect and resolve self-intersecting contours. */
const CLEANUP_CURVE_SEGMENTS = 24

/**
 * Resolves self-intersecting contours into simple polygons.
 * earcut (via ExtrudeGeometry) cannot triangulate a self-intersecting contour: it drops
 * cap area and leaves the extruded mesh open. When a flattened ring crosses itself or
 * another ring of the same shape, the whole shape is flattened and rebuilt from a
 * boolean self-union, which yields simple rings (outer CCW, holes CW).
 * Shapes without intersections are returned unchanged and keep their curves, so the
 * renderer's curveSegments setting still applies; cleaned shapes are already flat.
 */
export function resolveSelfIntersections(shape: Shape): Shape[] {
  const { shape: contour, holes } = shape.extractPoints(CLEANUP_CURVE_SEGMENTS)
  const rings = [contour, ...holes]
    .map(dedupePoints)
    .filter(ring => ring.length >= 3)
  if (rings.length === 0 || !ringsIntersect(rings))
    return [shape]

  const closedRings = rings.map(ring => [...ring, ring[0]].map(p => [p.x, p.y] as [number, number]))
  const multiPolygon = polygonClipping.union([closedRings])
  const cleaned = multiPolygon.map((polygon) => {
    const [outer, ...holeRings] = polygon
    const simple = new Shape(outer.slice(0, -1).map(([x, y]) => new Vector2(x, y)))
    simple.holes = holeRings.map(ring => new Path(ring.slice(0, -1).map(([x, y]) => new Vector2(x, y))))
    return simple
  })
  return cleaned.length > 0 ? cleaned : [shape]
}

/** Drops consecutive duplicate points (zero-length segments break ring adjacency). */
function dedupePoints(points: Vector2[]): Vector2[] {
  const result: Vector2[] = []
  for (const p of points) {
    const last = result[result.length - 1]
    if (!last || last.x !== p.x || last.y !== p.y)
      result.push(p)
  }
  // the closing point may duplicate the first one
  while (result.length > 1) {
    const first = result[0]
    const last = result[result.length - 1]
    if (first.x !== last.x || first.y !== last.y)
      break
    result.pop()
  }
  return result
}

interface Segment {
  ax: number
  ay: number
  bx: number
  by: number
  minX: number
  maxX: number
  minY: number
  maxY: number
  ring: number
  index: number
}

/**
 * Detects crossings between ring segments (non-adjacent within a ring, or across rings).
 * An x-sweep limits pair tests to x-overlapping segments, so typical outlines cost ~O(n).
 */
function ringsIntersect(rings: Vector2[][]): boolean {
  const segments: Segment[] = []
  const ringSizes: number[] = []
  rings.forEach((points, ring) => {
    ringSizes[ring] = points.length
    for (let i = 0; i < points.length; i++) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      segments.push({
        ax: a.x,
        ay: a.y,
        bx: b.x,
        by: b.y,
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
        ring,
        index: i,
      })
    }
  })
  segments.sort((s, t) => s.minX - t.minX)

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    for (let j = i + 1; j < segments.length && segments[j].minX <= s.maxX; j++) {
      const t = segments[j]
      if (s.ring === t.ring) {
        // adjacent segments of one ring legitimately share an endpoint
        const gap = Math.abs(s.index - t.index)
        if (gap <= 1 || gap === ringSizes[s.ring] - 1)
          continue
      }
      if (t.minY > s.maxY || t.maxY < s.minY)
        continue
      if (segmentsIntersect(s, t))
        return true
    }
  }
  return false
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

function onSegment(s: Segment, px: number, py: number) {
  return px >= s.minX && px <= s.maxX && py >= s.minY && py <= s.maxY
}

/** Proper crossing or touching; callers exclude adjacent segments of the same ring. */
function segmentsIntersect(s: Segment, t: Segment): boolean {
  const d1 = orient(s.ax, s.ay, s.bx, s.by, t.ax, t.ay)
  const d2 = orient(s.ax, s.ay, s.bx, s.by, t.bx, t.by)
  const d3 = orient(t.ax, t.ay, t.bx, t.by, s.ax, s.ay)
  const d4 = orient(t.ax, t.ay, t.bx, t.by, s.bx, s.by)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true
  return (d1 === 0 && onSegment(s, t.ax, t.ay))
    || (d2 === 0 && onSegment(s, t.bx, t.by))
    || (d3 === 0 && onSegment(t, s.ax, s.ay))
    || (d4 === 0 && onSegment(t, s.bx, s.by))
}

export interface SvgLoaderOptions {
  defaultColor?: string
  defaultDepth?: number
  defaultStartZ?: number
  drawStrokes?: boolean
  drawFillShapes?: boolean
  customShapes?: (shapes: ShapeWithColor[], index: number) => ShapeWithColor[]
}

export function useSvgLoader() {
  const loader = new SVGLoader()

  function createShapesWithColor(svgData: string, options: SvgLoaderOptions = {}) {
    const {
      defaultColor = '#FFA500',
      defaultDepth = 2,
      defaultStartZ = 0,
      // drawStrokes = true,
      drawFillShapes = true,
      customShapes,
    } = options

    const svgParsed = loader.parse(normalizePathDirections(svgData))
    const shapes: ShapeWithColor[] = []

    svgParsed.paths.forEach((path) => {
      // 处理填充形状
      if (drawFillShapes) {
        const style = path.userData?.style as { fill?: string, fillOpacity?: number } | undefined
        const fillColor = style?.fill || defaultColor
        const fillOpacity = style?.fillOpacity ?? 1

        if (fillColor !== undefined && fillColor !== 'none') {
          const pathShapes = path.toShapes()
          pathShapes.forEach((shape) => {
            resolveSelfIntersections(shape).forEach((cleaned) => {
              shapes.push({
                shape: markRaw(cleaned),
                color: markRaw(new Color().setStyle(fillColor)),
                startZ: defaultStartZ,
                depth: defaultDepth,
                opacity: fillOpacity,
                polygonOffset: 0,
              })
            })
          })
        }
      }

      // TODO 描边处理
      // 描边处理
      // if (drawStrokes) {
      //   const strokeColor = path.userData?.style?.stroke
      //   if (strokeColor && strokeColor !== 'none') {
      //     const strokeOpacity = path.userData?.style?.strokeOpacity ?? 1
      //     // const strokeWidth = path.userData?.style?.strokeWidth ?? 1

      //     path.subPaths.forEach((subPath) => {
      //       if (!subPath || !subPath.getPoints || typeof subPath.getPoints !== 'function') return

      //       const output: number[] = []
      //       SVGLoader.pointsToStrokeWithBuffers(
      //         subPath.getPoints(),
      //         path.userData?.style,
      //         undefined, undefined, output, [], []
      //       )

      //       if (output.length) {
      //         const shape = new Shape()
      //         for (let t = 0, T = output.length / 9; t < T; ++t) {
      //           shape.moveTo(output[t * 9 + 0], output[t * 9 + 1]);
      //           shape.lineTo(output[t * 9 + 3], output[t * 9 + 4]);
      //           shape.lineTo(output[t * 9 + 6], output[t * 9 + 7]);
      //           shape.lineTo(output[t * 9 + 0], output[t * 9 + 1]);
      //         }

      //         shapes.push({
      //           shape: markRaw(shape),
      //           color: markRaw(new Color().setStyle(strokeColor)),
      //           startZ: defaultStartZ,
      //           depth: defaultDepth,
      //           opacity: strokeOpacity,
      //           polygonOffset: 0,
      //         })
      //       }
      //     })
      //   }
      // }
    })

    return customShapes ? customShapes(shapes, 0) : shapes
  }

  return {
    createShapesWithColor,
  }
}
