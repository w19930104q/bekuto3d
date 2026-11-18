/**
 * @vitest-environment jsdom
 */
import JSZip from 'jszip'
import { BoxGeometry, ExtrudeGeometry, Group, Mesh, MeshStandardMaterial, Path, Scene, Shape } from 'three'
import { describe, expect, it } from 'vitest'
import { exportTo3MF } from '../src/index'

/**
 * 3MF inspection helpers: parse `3D/3dmodel.model` back into world-space triangles
 * (item/component transforms applied) and check the orientation convention:
 * watertight, consistent outward normals, positive-determinant transforms.
 * See notes/extrusion-orientation-convention.md.
 */

/** Row-major 3x4 affine matrix: [m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32] */
type Mat = number[]

const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

function parseTransform(text: string | null): Mat {
  if (!text)
    return IDENTITY
  return text.trim().split(/\s+/).map(Number)
}

/** Determinant of the 3x3 linear part; negative means the transform mirrors. */
function determinant(m: Mat): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7])
    - m[1] * (m[3] * m[8] - m[5] * m[6])
    + m[2] * (m[3] * m[7] - m[4] * m[6])
}

/** `compose(a, b)` applies `b` first, then `a`. */
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

interface Inspection {
  entryNames: string[]
  transforms: Mat[]
  /** World-space triangles, 9 numbers each (x1 y1 z1 x2 y2 z2 x3 y3 z3) */
  triangles: number[][]
}

async function exportAndInspect(object: Parameters<typeof exportTo3MF>[0]): Promise<Inspection> {
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

/** Welds vertices by rounded coordinates and counts how many triangles use each undirected edge. */
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

/** Signed volume via the divergence theorem; positive when normals point outward. */
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

/** Extruded 20x20 square with a 5x5 hole, depth 4 — the app's extrusion settings. */
function extrudedShapeWithHole() {
  const shape = new Shape()
  shape.moveTo(0, 0)
  shape.lineTo(20, 0)
  shape.lineTo(20, 20)
  shape.lineTo(0, 20)
  shape.closePath()
  const hole = new Path()
  hole.moveTo(5, 5)
  hole.lineTo(10, 5)
  hole.lineTo(10, 10)
  hole.lineTo(5, 10)
  hole.closePath()
  shape.holes.push(hole)
  return new ExtrudeGeometry(shape, { depth: 4, bevelEnabled: false })
}

/**
 * Concave star outline — a pentagram with its self-intersections already resolved
 * (resolving self-intersecting contours is the app's cleanup stage; the exporter
 * only has to keep the orientation convention for whatever mesh it receives).
 */
function extrudedStar() {
  const outline: Array<[number, number]> = [
    [7.2, 36.09],
    [39.9, 36.09],
    [50, 5],
    [60.1, 36.09],
    [92.8, 36.09],
    [66.35, 55.31],
    [76.45, 86.41],
    [50, 67.19],
    [23.55, 86.41],
    [33.65, 55.31],
  ]
  const star = new Shape()
  star.moveTo(...outline[0])
  outline.slice(1).forEach(p => star.lineTo(...p))
  star.closePath()
  return new ExtrudeGeometry(star, { depth: 2, bevelEnabled: false })
}

describe('orientation convention (watertight, outward normals, positive-determinant transforms)', () => {
  it('bakes a mirrored display transform into the mesh instead of writing it', async () => {
    // Mimics the app's render group: Y-flip mirror scale(s, -s, 1)
    const group = new Group()
    group.scale.set(2, -2, 1)
    const mesh = new Mesh(extrudedShapeWithHole(), new MeshStandardMaterial({ color: 0xE0592A }))
    mesh.position.set(3, -7, 0)
    group.add(mesh)

    const { entryNames, transforms, triangles } = await exportAndInspect(group)

    // zip structure
    expect([...entryNames].sort()).toEqual(EXPECTED_ENTRIES)
    expect(entryNames[0]).not.toBe('[Content_Types].xml')

    // every written transform keeps the orientation
    expect(transforms.length).toBeGreaterThan(0)
    for (const t of transforms)
      expect(determinant(t)).toBeGreaterThan(0)

    // watertight, no degenerate triangles
    const { degenerate, openEdges } = analyzeEdges(triangles)
    expect(degenerate).toBe(0)
    expect(openEdges).toBe(0)

    // consistent outward normals: positive signed volume matching the analytic value
    // (outer 20x20 - hole 5x5) * depth 4 * |det(scale 2, -2, 1)|
    const volume = signedVolume(triangles)
    expect(volume).toBeGreaterThan(0)
    expect(Math.abs(volume - (400 - 25) * 4 * 4)).toBeLessThan(0.01)

    // stable volume across repeated exports
    const again = await exportAndInspect(group)
    expect(signedVolume(again.triangles)).toBe(volume)
  })

  it('rewrites only mirrored items and leaves other items untouched', async () => {
    const scene = new Scene()
    const plain = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0xFF0000 }))
    plain.name = 'Plain'
    plain.position.set(50, 50, 5)
    plain.rotation.z = 0.3
    scene.add(plain)

    const mirrored = new Group()
    mirrored.name = 'Mirrored'
    mirrored.scale.set(1, -1, 1)
    mirrored.add(new Mesh(extrudedShapeWithHole(), new MeshStandardMaterial({ color: 0x00FF00 })))
    scene.add(mirrored)

    const { transforms, triangles } = await exportAndInspect(scene)

    // no negative-determinant transform anywhere
    for (const t of transforms)
      expect(determinant(t)).toBeGreaterThan(0)
    // the plain item keeps its non-identity transform (not rewritten)
    expect(transforms.some(t => Math.abs(t[4] - Math.cos(0.3)) < 1e-5)).toBe(true)

    const { degenerate, openEdges } = analyzeEdges(triangles)
    expect(degenerate).toBe(0)
    expect(openEdges).toBe(0)
    expect(signedVolume(triangles)).toBeGreaterThan(0)
  })

  it('exports a concave star contour watertight and deterministically', async () => {
    const group = new Group()
    group.scale.set(1, -1, 1)
    group.add(new Mesh(extrudedStar(), new MeshStandardMaterial({ color: 0x8E44AD })))

    const first = await exportAndInspect(group)
    const second = await exportAndInspect(group)

    for (const t of first.transforms)
      expect(determinant(t)).toBeGreaterThan(0)

    const { degenerate, openEdges } = analyzeEdges(first.triangles)
    expect(degenerate).toBe(0)
    expect(openEdges).toBe(0)

    const volume = signedVolume(first.triangles)
    expect(volume).toBeGreaterThan(0)
    expect(signedVolume(second.triangles)).toBe(volume)
  })
})
