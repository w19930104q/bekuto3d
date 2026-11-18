import { readFileSync } from 'node:fs'
import JSZip from 'jszip'
import { ExtrudeGeometry, Group, Mesh, MeshStandardMaterial, ShapeUtils } from 'three'
import { exportTo3MF } from 'three-3mf-exporter'
import { describe, expect, it } from 'vitest'
import { useSvgLoader } from '../src/composables/useSvgLoader'

/**
 * End-to-end orientation convention test: SVG fixture → contour cleanup
 * (normalizePathDirections) → toShapes classification → ExtrudeGeometry triangulation
 * → mirrored display group → 3MF export. The parsed 3MF output must be watertight
 * with consistent outward normals. See notes/extrusion-orientation-convention.md.
 */

/** Row-major 3x4 affine matrix: [m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32] */
type Mat = number[]

const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

function parseTransform(text: string | null): Mat {
  if (!text)
    return IDENTITY
  return text.trim().split(/\s+/).map(Number)
}

function determinant(m: Mat): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7])
    - m[1] * (m[3] * m[8] - m[5] * m[6])
    + m[2] * (m[3] * m[7] - m[4] * m[6])
}

function compose(a: Mat, b: Mat): Mat {
  const r: Mat = Array.from({ length: 12 })
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++)
      r[row * 3 + col] = a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col]
    r[9 + row] = a[row * 3] * b[9] + a[row * 3 + 1] * b[10] + a[row * 3 + 2] * b[11] + a[9 + row]
  }
  return r
}

function applyMat(m: Mat, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[9],
    m[3] * x + m[4] * y + m[5] * z + m[10],
    m[6] * x + m[7] * y + m[8] * z + m[11],
  ]
}

async function exportAndInspect(object: Group) {
  const blob = await exportTo3MF(object)
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  const entryNames = Object.keys(zip.files).filter(n => !zip.files[n].dir)
  const xml = await zip.file('3D/3dmodel.model')!.async('string')
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)

  const transforms: Mat[] = []
  for (const tag of ['item', 'component']) {
    for (const el of Array.from(doc.getElementsByTagName(tag)))
      transforms.push(parseTransform(el.getAttribute('transform')))
  }

  const objects = new Map<string, Element>()
  for (const el of Array.from(doc.getElementsByTagName('object')))
    objects.set(el.getAttribute('id')!, el)

  const triangles: number[][] = []
  const walk = (id: string, m: Mat) => {
    const obj = objects.get(id)
    if (!obj)
      throw new Error(`missing object ${id}`)
    const meshes = obj.getElementsByTagName('mesh')
    if (meshes.length > 0) {
      const verts: number[][] = []
      for (const v of Array.from(meshes[0].getElementsByTagName('vertex')))
        verts.push([Number(v.getAttribute('x')), Number(v.getAttribute('y')), Number(v.getAttribute('z'))])
      for (const t of Array.from(meshes[0].getElementsByTagName('triangle'))) {
        const tri: number[] = []
        for (const attr of ['v1', 'v2', 'v3']) {
          const [x, y, z] = verts[Number(t.getAttribute(attr))]
          tri.push(...applyMat(m, x, y, z))
        }
        triangles.push(tri)
      }
      return
    }
    for (const c of Array.from(obj.getElementsByTagName('component')))
      walk(c.getAttribute('objectid')!, compose(m, parseTransform(c.getAttribute('transform'))))
  }
  for (const item of Array.from(doc.getElementsByTagName('item')))
    walk(item.getAttribute('objectid')!, parseTransform(item.getAttribute('transform')))

  return { entryNames, transforms, triangles }
}

function analyzeEdges(triangles: number[][]) {
  const ids = new Map<string, number>()
  const vertId = (x: number, y: number, z: number) => {
    const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`
    let id = ids.get(key)
    if (id === undefined) {
      id = ids.size
      ids.set(key, id)
    }
    return id
  }
  const edgeCount = new Map<string, number>()
  let degenerate = 0
  for (const t of triangles) {
    const v = [vertId(t[0], t[1], t[2]), vertId(t[3], t[4], t[5]), vertId(t[6], t[7], t[8])]
    if (v[0] === v[1] || v[1] === v[2] || v[2] === v[0]) {
      degenerate++
      continue
    }
    for (let e = 0; e < 3; e++) {
      const [a, b] = [v[e], v[(e + 1) % 3]]
      const key = a < b ? `${a}_${b}` : `${b}_${a}`
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1)
    }
  }
  const openEdges = [...edgeCount.values()].filter(c => c !== 2).length
  return { degenerate, openEdges }
}

function signedVolume(triangles: number[][]): number {
  let volume = 0
  for (const t of triangles) {
    const [x1, y1, z1, x2, y2, z2, x3, y3, z3] = t
    volume += (x1 * (y2 * z3 - y3 * z2) - y1 * (x2 * z3 - x3 * z2) + z1 * (x2 * y3 - x3 * y2)) / 6
  }
  return volume
}

const EXPECTED_ENTRIES = [
  '[Content_Types].xml',
  '3D/3dmodel.model',
  'Metadata/model_settings.config',
  'Metadata/project_settings.config',
  '_rels/.rels',
].sort()

const SCALE = 2
const DEPTH = 3

/** Builds the same scene the renderer displays: extruded meshes in a Y-flipped group. */
function buildExportGroup(svgMarkup: string) {
  const { createShapesWithColor } = useSvgLoader()
  const shapes = createShapesWithColor(svgMarkup, { defaultDepth: DEPTH })
  expect(shapes.length).toBeGreaterThan(0)

  // Analytic fill area at the same curve resolution the extrusion samples with,
  // so the exported volume can be checked against `area * depth * scale²`.
  let expectedArea = 0
  for (const item of shapes) {
    const { shape: contour, holes } = item.shape.extractPoints(12)
    expectedArea += Math.abs(ShapeUtils.area(contour))
    for (const hole of holes)
      expectedArea -= Math.abs(ShapeUtils.area(hole))
  }

  const group = new Group()
  group.scale.set(SCALE, -SCALE, 1)
  for (const item of shapes) {
    const geometry = new ExtrudeGeometry(item.shape, {
      depth: item.depth,
      bevelEnabled: false,
      curveSegments: 12,
    })
    const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: item.color }))
    mesh.position.set(-10, -10, item.startZ)
    group.add(mesh)
  }
  return { group, expectedArea }
}

function loadFixture(name: string) {
  // vitest's jsdom environment rewrites import.meta.url to an http URL, so resolve from cwd
  return readFileSync(`test/fixtures/${name}`, 'utf-8')
}

describe('extrusion orientation convention (SVG → 3MF)', () => {
  it('exports a holed, curve-approximated SVG watertight with outward normals', async () => {
    const { group, expectedArea } = buildExportGroup(loadFixture('hole.svg'))
    const { entryNames, transforms, triangles } = await exportAndInspect(group)

    // zip structure
    expect([...entryNames].sort()).toEqual(EXPECTED_ENTRIES)
    expect(entryNames[0]).not.toBe('[Content_Types].xml')

    // only positive-determinant transforms are written
    expect(transforms.length).toBeGreaterThan(0)
    for (const t of transforms)
      expect(determinant(t)).toBeGreaterThan(0)

    // watertight, no degenerate triangles
    const { degenerate, openEdges } = analyzeEdges(triangles)
    expect(degenerate).toBe(0)
    expect(openEdges).toBe(0)

    // consistent outward normals and stable, correct volume: fill area * depth * scale²
    const volume = signedVolume(triangles)
    expect(volume).toBeGreaterThan(0)
    expect(Math.abs(volume - expectedArea * DEPTH * SCALE ** 2)).toBeLessThan(0.5)

    // repeated export is identical
    const again = await exportAndInspect(buildExportGroup(loadFixture('hole.svg')).group)
    expect(signedVolume(again.triangles)).toBe(volume)
  })

  it('exports a self-intersecting SVG deterministically', async () => {
    const { group } = buildExportGroup(loadFixture('self-intersecting.svg'))
    const { entryNames, transforms, triangles } = await exportAndInspect(group)

    expect([...entryNames].sort()).toEqual(EXPECTED_ENTRIES)
    for (const t of transforms)
      expect(determinant(t)).toBeGreaterThan(0)

    // earcut preserves contour edges, so the welded mesh is still combinatorially closed
    const { degenerate, openEdges } = analyzeEdges(triangles)
    expect(degenerate).toBe(0)
    expect(openEdges).toBe(0)

    const volume = signedVolume(triangles)
    expect(volume).toBeGreaterThan(0)

    const again = await exportAndInspect(buildExportGroup(loadFixture('self-intersecting.svg')).group)
    expect(signedVolume(again.triangles)).toBe(volume)
  })
})
