#!/usr/bin/env python3
"""
render_car.py - render the Sideways sedan mesh from any camera angle, in the Sideways
look: dark translucent panels with bright hairline edges, a soft ground shadow and
optional lamp glows.

Why: both EDZCO apps want a hero car in their centre column, but each needs a *different*
view - Lights wants the front (headlights, DRL, fogs, grille), Pop-Bang wants the rear
(diffuser and exhaust tips). Cropping one screenshot gives neither. So we load the real
geometry and point a camera at it.

Source mesh: _refs_new/sideways/assets/models/sedan.js
             (MIT, Copyright 2026 idrive-labs - github.com/idrive-labs/sideways)
             V = Int16 positions /1000 m, N = Int8 normals /127, F = triangle indices,
             M = per-triangle material id. x forward, y lateral, z up.
             Shell triangles are [0, intStart); the rest is the cabin interior.

The wheels are NOT in the mesh (Sideways draws its own so they can spin and steer), so we
build four cylinders at the meta wheel centres and merge them in before rendering, which
also gets them into the z-buffer for correct occlusion.

Run:  python docs/render_car.py
Out:  docs/car-front.png   (for Lights)
      docs/car-rear.png    (for Pop-Bang)
      + copies into the preview folder
"""
from __future__ import annotations

import base64
import json
import math
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PROJECT = ROOT.parent
MODEL_JS = PROJECT / "_refs_new" / "sideways" / "assets" / "models" / "sedan.js"
PREVIEW_DIR = PROJECT / "apps" / "custom_popbang" / "preview" / "edzco"

# ---------------------------------------------------------------- materials
# from sideways/car/body.js
MAT = dict(PAINT=0, GLASS=1, TOP=2, TRIM=3, TIRE=4, RIM=5, RIMDARK=6, TAIL=7, HEAD=8,
           CHROME=9, PLATE=10, GRILLE=11, WELL=12, DIFF=13, CALIPER=14, ROOF=15,
           BLUR=16, INT=17, INTLIGHT=18, SEAT=19, LENS=20, TAILLENS=21, DISC=22)

# Surface tone per material, as (r, g, b) in 0..1. Kept dark and desaturated so the
# bright edges carry the shape, exactly as the Sideways render reads.
SURFACE = {
    MAT["PAINT"]:   (0.150, 0.158, 0.175),
    MAT["GLASS"]:   (0.085, 0.098, 0.122),
    MAT["TOP"]:     (0.120, 0.126, 0.140),
    MAT["TRIM"]:    (0.095, 0.100, 0.110),
    MAT["TIRE"]:    (0.050, 0.052, 0.058),
    MAT["RIM"]:     (0.230, 0.240, 0.260),
    MAT["RIMDARK"]: (0.105, 0.110, 0.122),
    MAT["TAIL"]:    (0.420, 0.070, 0.095),
    MAT["TAILLENS"]:(0.480, 0.080, 0.100),
    MAT["HEAD"]:    (0.480, 0.530, 0.610),
    MAT["LENS"]:    (0.440, 0.490, 0.570),
    MAT["CHROME"]:  (0.260, 0.272, 0.295),
    MAT["PLATE"]:   (0.300, 0.310, 0.325),
    MAT["GRILLE"]:  (0.070, 0.075, 0.086),
    MAT["WELL"]:    (0.035, 0.037, 0.043),
    MAT["DIFF"]:    (0.082, 0.086, 0.098),
    MAT["CALIPER"]: (0.290, 0.090, 0.098),
    MAT["ROOF"]:    (0.124, 0.130, 0.145),
    MAT["DISC"]:    (0.175, 0.182, 0.196),
}
DEFAULT_SURFACE = (0.130, 0.136, 0.152)

# Materials whose boundary against a neighbour is always worth an edge line - these are
# the panel gaps and lamp outlines that make the render read as a car.
FEATURE_MATS = {MAT["GLASS"], MAT["HEAD"], MAT["LENS"], MAT["TAIL"], MAT["TAILLENS"],
                MAT["GRILLE"], MAT["DIFF"], MAT["PLATE"], MAT["CHROME"], MAT["WELL"]}


# ---------------------------------------------------------------- mesh load
def load_sedan():
    src = MODEL_JS.read_text(encoding="utf-8")

    def grab(key):
        m = re.search(r'"%s"\s*:\s*"([A-Za-z0-9+/=]+)"' % key, src)
        if not m:
            raise SystemExit(f"could not find {key} in {MODEL_JS.name}")
        return base64.b64decode(m.group(1))

    meta = json.loads(re.search(r'"meta"\s*:\s*(\{.*?\})\s*,\s*"V"', src, re.S).group(1))
    f32 = '"F32"' in src and re.search(r'"F32"\s*:\s*true', src)

    V = np.frombuffer(grab("V"), dtype="<i2").astype(np.float64).reshape(-1, 3) / 1000.0
    N = np.frombuffer(grab("N"), dtype="i1").astype(np.float64).reshape(-1, 3) / 127.0
    F = np.frombuffer(grab("F"), dtype="<u4" if f32 else "<u2").astype(np.int64).reshape(-1, 3)
    M = np.frombuffer(grab("M"), dtype="u1").astype(np.int64)
    return meta, V, N, F, M


def wheel_mesh(cx, cy, cz, radius, width, segments=28):
    """A road wheel as a short cylinder: tyre wall rings + a rim disc each side.
    Returns (verts, tris, mats). The wheel axis is y (lateral)."""
    verts, tris, mats = [], [], []
    y0, y1 = cy - width / 2.0, cy + width / 2.0
    rim_r = radius * 0.70

    def add(p):
        verts.append(p)
        return len(verts) - 1

    outer0 = [add((cx + radius * math.cos(a), y0, cz + radius * math.sin(a)))
              for a in (k / segments * 2 * math.pi for k in range(segments))]
    outer1 = [add((cx + radius * math.cos(a), y1, cz + radius * math.sin(a)))
              for a in (k / segments * 2 * math.pi for k in range(segments))]
    rim0 = [add((cx + rim_r * math.cos(a), y0, cz + rim_r * math.sin(a)))
            for a in (k / segments * 2 * math.pi for k in range(segments))]
    rim1 = [add((cx + rim_r * math.cos(a), y1, cz + rim_r * math.sin(a)))
            for a in (k / segments * 2 * math.pi for k in range(segments))]
    hub0, hub1 = add((cx, y0, cz)), add((cx, y1, cz))

    for k in range(segments):
        n = (k + 1) % segments
        # tread band
        tris += [(outer0[k], outer1[k], outer1[n]), (outer0[k], outer1[n], outer0[n])]
        mats += [MAT["TIRE"]] * 2
        # sidewalls (tyre face between tread and rim)
        tris += [(outer0[k], rim0[n], rim0[k]), (outer0[k], outer0[n], rim0[n])]
        mats += [MAT["TIRE"]] * 2
        tris += [(outer1[k], rim1[k], rim1[n]), (outer1[k], rim1[n], outer1[n])]
        mats += [MAT["TIRE"]] * 2
        # rim discs
        tris += [(rim0[k], rim0[n], hub0)]
        mats += [MAT["RIM"]]
        tris += [(rim1[n], rim1[k], hub1)]
        mats += [MAT["RIM"]]
    return np.array(verts, dtype=np.float64), np.array(tris, dtype=np.int64), np.array(mats, dtype=np.int64)


def build_scene():
    """Shell triangles plus four wheels; the cabin interior is dropped (it only shows
    through the glass and muddies the silhouette at these angles)."""
    meta, V, N, F, M = load_sedan()
    shell_end = int(meta["intStart"])
    F, M = F[:shell_end], M[:shell_end]

    verts = [V]
    tris = [F]
    mats = [M]
    offset = len(V)
    for w in meta["wheels"]:
        wv, wt, wm = wheel_mesh(w["x"], w["y"], w["z"], w["r"], w["w"])
        verts.append(wv)
        tris.append(wt + offset)
        mats.append(wm)
        offset += len(wv)

    return meta, np.vstack(verts), np.vstack(tris), np.concatenate(mats)


# ---------------------------------------------------------------- camera
def look_at(eye, target, up=(0.0, 0.0, 1.0)):
    eye, target, up = np.array(eye, float), np.array(target, float), np.array(up, float)
    f = target - eye
    f /= np.linalg.norm(f)
    s = np.cross(f, up)
    s /= np.linalg.norm(s)
    u = np.cross(s, f)
    m = np.eye(4)
    m[0, :3], m[1, :3], m[2, :3] = s, u, -f
    m[:3, 3] = -m[:3, :3] @ eye
    return m


def orbit_eye(target, distance, azimuth_deg, elevation_deg):
    """azimuth 0 looks at the car's nose from straight ahead; +90 swings to the driver
    side; 180 is straight behind. elevation lifts the camera."""
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    x = math.cos(el) * math.cos(az)
    y = math.cos(el) * math.sin(az)
    z = math.sin(el)
    return np.array(target, float) + np.array([x, y, z]) * distance


def project(verts, view, fov_deg, width, height, near=0.05):
    """World -> clip -> screen. Returns (screen_xy, view_depth, behind_mask)."""
    n = len(verts)
    homo = np.hstack([verts, np.ones((n, 1))])
    cam = (view @ homo.T).T              # camera space; looking down -z
    depth = -cam[:, 2]                    # positive in front of the camera
    behind = depth < near
    safe = np.where(behind, near, depth)

    f = 1.0 / math.tan(math.radians(fov_deg) / 2.0)
    aspect = width / height
    ndc_x = (f / aspect) * cam[:, 0] / safe
    ndc_y = f * cam[:, 1] / safe

    sx = (ndc_x * 0.5 + 0.5) * width
    sy = (1.0 - (ndc_y * 0.5 + 0.5)) * height
    return np.stack([sx, sy], axis=1), depth, behind


# ---------------------------------------------------------------- raster
def rasterize(screen, depth, tris, mats, width, height, light_dir, verts):
    """Z-buffered triangle fill. Returns (colour HxWx3 float, zbuf HxW, covered HxW bool)."""
    zbuf = np.full((height, width), np.inf)
    colour = np.zeros((height, width, 3), dtype=np.float64)
    covered = np.zeros((height, width), dtype=bool)

    p = screen[tris]                      # (nt, 3, 2)
    d = depth[tris]                       # (nt, 3)

    # geometric normal per triangle, for shading and back-face culling
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    fn = np.cross(b - a, c - a)
    ln = np.linalg.norm(fn, axis=1, keepdims=True)
    ln[ln == 0] = 1.0
    fn = fn / ln

    ld = np.array(light_dir, float)
    ld /= np.linalg.norm(ld)
    lam = np.clip(fn @ ld, 0.0, 1.0)
    # A soft wrap term keeps the shadow side readable instead of going flat black.
    shade = 0.45 + 0.55 * (0.35 + 0.65 * lam)

    # screen-space winding; after projection a front-facing triangle has one sign
    area2 = ((p[:, 1, 0] - p[:, 0, 0]) * (p[:, 2, 1] - p[:, 0, 1])
             - (p[:, 2, 0] - p[:, 0, 0]) * (p[:, 1, 1] - p[:, 0, 1]))

    order = np.argsort(-d.mean(axis=1))   # far to near; the z-buffer settles the rest
    for t in order:
        if not np.isfinite(d[t]).all() or (d[t] <= 0).any():
            continue
        if abs(area2[t]) < 1e-9:
            continue
        x0 = max(int(np.floor(p[t, :, 0].min())), 0)
        x1 = min(int(np.ceil(p[t, :, 0].max())) + 1, width)
        y0 = max(int(np.floor(p[t, :, 1].min())), 0)
        y1 = min(int(np.ceil(p[t, :, 1].max())) + 1, height)
        if x0 >= x1 or y0 >= y1:
            continue

        xs = np.arange(x0, x1) + 0.5
        ys = np.arange(y0, y1) + 0.5
        gx, gy = np.meshgrid(xs, ys)

        (ax, ay), (bx, by), (cx, cy) = p[t, 0], p[t, 1], p[t, 2]
        inv = 1.0 / area2[t]
        w0 = ((bx - gx) * (cy - gy) - (cx - gx) * (by - gy)) * inv
        w1 = ((cx - gx) * (ay - gy) - (ax - gx) * (cy - gy)) * inv
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not inside.any():
            continue

        z = w0 * d[t, 0] + w1 * d[t, 1] + w2 * d[t, 2]
        sub = zbuf[y0:y1, x0:x1]
        win = inside & (z < sub)
        if not win.any():
            continue
        sub[win] = z[win]
        base = np.array(SURFACE.get(int(mats[t]), DEFAULT_SURFACE))
        colour[y0:y1, x0:x1][win] = base * shade[t]
        covered[y0:y1, x0:x1][win] = True

    return colour, zbuf, covered


# ---------------------------------------------------------------- edges
def build_edges(verts, tris, mats):
    """Collect every edge with the (up to two) triangles that share it, joining vertices
    by rounded position the way sideways/car/model.js does, because crease normals split
    vertices that sit on the same point."""
    key = np.round(verts * 1000).astype(np.int64)
    _, inverse = np.unique(key, axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)

    table: dict[tuple[int, int], list] = {}
    for t, tri in enumerate(tris):
        for e in range(3):
            a, b = tri[e], tri[(e + 1) % 3]
            ka, kb = int(inverse[a]), int(inverse[b])
            k = (ka, kb) if ka < kb else (kb, ka)
            rec = table.get(k)
            if rec is None:
                table[k] = [a, b, t, -1]
            elif rec[3] == -1:
                rec[3] = t
    return table


def select_edges(verts, tris, mats, table, crease_deg=28.0):
    """Keep silhouette-capable edges: boundaries, creases past the threshold, and every
    material change touching a feature material (lamps, glass, grille, diffuser)."""
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    fn = np.cross(b - a, c - a)
    ln = np.linalg.norm(fn, axis=1, keepdims=True)
    ln[ln == 0] = 1.0
    fn = fn / ln

    cos_thr = math.cos(math.radians(crease_deg))
    out = []
    for (va, vb, t0, t1) in table.values():
        if t1 == -1:
            out.append((va, vb, t0, t1, 1.0))          # open boundary: always draw
            continue
        m0, m1 = int(mats[t0]), int(mats[t1])
        if m0 != m1 and (m0 in FEATURE_MATS or m1 in FEATURE_MATS):
            out.append((va, vb, t0, t1, 1.0))          # lamp / glass / grille outline
            continue
        if float(fn[t0] @ fn[t1]) < cos_thr:
            out.append((va, vb, t0, t1, 0.85))         # body crease
    return out, fn


def draw_edges(img, screen, depth, zbuf, edges, fn, verts, view_eye, width, height,
               colour=(0.90, 0.94, 1.0), bias=0.012, thickness=1):
    """Draw the visible part of each edge. An edge is a silhouette when its two triangles
    disagree about facing the camera - those get full weight; the rest are only drawn
    where the z-buffer says nothing nearer covers them.

    `thickness` is the stamp radius in supersampled pixels: a 1-pixel line disappears in
    the downsample, so each sample paints a small falloff disc instead."""
    acc = np.zeros((height, width), dtype=np.float64)

    # offsets of the stamp disc, with a soft falloff so the downsampled line keeps a core
    stamp = []
    for dy in range(-thickness, thickness + 1):
        for dx in range(-thickness, thickness + 1):
            r = math.hypot(dx, dy)
            if r <= thickness + 0.25:
                stamp.append((dx, dy, max(0.35, 1.0 - (r / (thickness + 1.0)) ** 2)))

    for (va, vb, t0, t1, weight) in edges:
        if depth[va] <= 0 or depth[vb] <= 0:
            continue
        pa, pb = screen[va], screen[vb]
        if not (np.isfinite(pa).all() and np.isfinite(pb).all()):
            continue

        if t1 != -1:
            mid = (verts[va] + verts[vb]) * 0.5
            to_eye = view_eye - mid
            f0 = float(fn[t0] @ to_eye) > 0
            f1 = float(fn[t1] @ to_eye) > 0
            silhouette = f0 != f1
            if not (f0 or f1):
                continue                                # edge of a fully back-facing pair
        else:
            silhouette = True

        length = float(np.hypot(*(pb - pa)))
        if length < 0.5:
            continue
        steps = max(int(length * 1.6), 2)
        ts = np.linspace(0.0, 1.0, steps)
        xs = pa[0] + (pb[0] - pa[0]) * ts
        ys = pa[1] + (pb[1] - pa[1]) * ts
        zs = depth[va] + (depth[vb] - depth[va]) * ts

        ix = np.clip(np.round(xs).astype(int), 0, width - 1)
        iy = np.clip(np.round(ys).astype(int), 0, height - 1)
        inb = (xs >= 0) & (xs < width) & (ys >= 0) & (ys < height)
        if not inb.any():
            continue

        zb = zbuf[iy, ix]
        vis = inb & (zs <= zb * (1.0 + bias) + bias)
        if silhouette:
            # a silhouette can sit just outside the filled shape, so accept a near miss
            vis |= inb & ~np.isfinite(zb)
        if not vis.any():
            continue

        w = weight * (1.0 if silhouette else 0.70)
        vy, vx = iy[vis], ix[vis]
        for dx, dy, falloff in stamp:
            sy = np.clip(vy + dy, 0, height - 1)
            sx = np.clip(vx + dx, 0, width - 1)
            np.maximum.at(acc, (sy, sx), w * falloff)

    col = np.array(colour, float)
    img += acc[..., None] * col[None, None, :]
    return img


# ---------------------------------------------------------------- lamp glow
def lamp_glow(img, screen, depth, zbuf, tris, mats, which, rgb, width, height, strength=1.0):
    """A soft bloom at the centroid of each lit group, split left/right, so the headlights
    and tail lights read as emitters instead of flat panels."""
    sel = np.isin(mats, which)
    if not sel.any():
        return img
    layer = np.zeros((height, width), dtype=np.float64)
    for side in (1, -1):
        pts = []
        for t in np.nonzero(sel)[0]:
            v = tris[t, 0]
            if depth[v] <= 0:
                continue
            pts.append(screen[v])
        if not pts:
            continue
    # centroid per connected lamp is overkill; sample every lit vertex instead
    lit_verts = np.unique(tris[sel].reshape(-1))
    for v in lit_verts:
        if depth[v] <= 0:
            continue
        x, y = screen[v]
        if not (0 <= x < width and 0 <= y < height):
            continue
        ix, iy = int(x), int(y)
        if depth[v] > zbuf[iy, ix] * 1.02 + 0.02:
            continue                                    # the lamp is hidden at this angle
        layer[iy, ix] = max(layer[iy, ix], 1.0)

    if layer.max() <= 0:
        return img
    blurred = np.array(Image.fromarray((layer * 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(6))) / 255.0
    core = np.array(Image.fromarray((layer * 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(1.6))) / 255.0
    glow = np.clip(blurred * 1.5 + core * 1.2, 0, 1.6) * strength
    img += glow[..., None] * np.array(rgb, float)[None, None, :]
    return img


# ---------------------------------------------------------------- lamp anchors
def lamp_anchors(meta, V, F, M):
    """Work out a 3D point for every lamp the apps address, so the previews can place
    their dots on the render instead of eyeballing them off a screenshot.

    Anchors that exist as geometry (headlights, tail lights, exhaust tips) are the
    centroid of that material's triangles on that side, optionally biased up/down or
    in/out to separate the functions that share one housing - a BMW headlight carries
    both the DRL and the indicator, a tail light both the indicator and the reversing
    lamp. The front fogs are not modelled as their own material, so they get a point in
    the lower bumper directly under each headlight.
    """
    cent = V[F].mean(axis=1)

    def cluster(materials, side=None):
        sel = np.isin(M, materials)
        if side is not None:
            sel &= (cent[:, 1] > 0) if side > 0 else (cent[:, 1] < 0)
        pts = cent[sel]
        if not len(pts):
            return None
        return pts

    def blend(pts, z_frac=0.5, x_frac=0.5, y_frac=0.5):
        """Pick a point inside a cluster's bounds: 0 = min, 1 = max on each axis, with
        the cluster's own centroid as the base so the point stays on the part."""
        lo, hi = pts.min(axis=0), pts.max(axis=0)
        return np.array([
            lo[0] + (hi[0] - lo[0]) * x_frac,
            lo[1] + (hi[1] - lo[1]) * y_frac,
            lo[2] + (hi[2] - lo[2]) * z_frac,
        ])

    head_l = cluster([MAT["HEAD"], MAT["LENS"]], side=+1)
    head_r = cluster([MAT["HEAD"], MAT["LENS"]], side=-1)
    tail_l = cluster([MAT["TAIL"], MAT["TAILLENS"]], side=+1)
    tail_r = cluster([MAT["TAIL"], MAT["TAILLENS"]], side=-1)
    pipe_l = cluster([MAT["CHROME"]], side=+1)
    pipe_r = cluster([MAT["CHROME"]], side=-1)

    out = {}
    if head_l is not None:
        # DRL sits along the top of the housing, the indicator lower and outboard, and the
        # high beam is the inboard projector - so it biases toward the car's centreline
        out["drl_l"] = blend(head_l, z_frac=0.82, x_frac=0.60, y_frac=0.55)
        out["turn_fl"] = blend(head_l, z_frac=0.25, x_frac=0.55, y_frac=0.85)
        out["high_beam_l"] = blend(head_l, z_frac=0.50, x_frac=0.50, y_frac=0.22)
        # front fog: under the headlight, in the lower bumper (not its own material)
        fl = blend(head_l, z_frac=0.5, x_frac=0.75, y_frac=0.70)
        out["fog_front_l"] = np.array([fl[0] - 0.08, fl[1] * 0.92, 0.40])
    if head_r is not None:
        out["drl_r"] = blend(head_r, z_frac=0.82, x_frac=0.60, y_frac=0.45)
        out["turn_fr"] = blend(head_r, z_frac=0.25, x_frac=0.55, y_frac=0.15)
        out["high_beam_r"] = blend(head_r, z_frac=0.50, x_frac=0.50, y_frac=0.78)
        fr = blend(head_r, z_frac=0.5, x_frac=0.75, y_frac=0.30)
        out["fog_front_r"] = np.array([fr[0] - 0.08, fr[1] * 0.92, 0.40])
    if tail_l is not None:
        out["turn_rl"] = blend(tail_l, z_frac=0.60, x_frac=0.45, y_frac=0.85)
        out["reverse_l"] = blend(tail_l, z_frac=0.30, x_frac=0.55, y_frac=0.25)
    if tail_r is not None:
        out["turn_rr"] = blend(tail_r, z_frac=0.60, x_frac=0.45, y_frac=0.15)
        out["reverse_r"] = blend(tail_r, z_frac=0.30, x_frac=0.55, y_frac=0.75)
    if tail_l is not None and tail_r is not None:
        # rear fog: low and inboard, under the bumper between the tail lights
        lo = np.minimum(tail_l.min(axis=0), tail_r.min(axis=0))
        out["fog_rear"] = np.array([lo[0] - 0.05, -0.30, 0.42])
    if pipe_l is not None:
        out["exhaust_l"] = pipe_l.mean(axis=0)
    if pipe_r is not None:
        out["exhaust_r"] = pipe_r.mean(axis=0)
    return out


def project_anchors(anchors, view, fov, width, height, zbuf=None, depth_bias=1.06):
    """Project each anchor to a percentage of the output frame. `visible` says whether the
    z-buffer agrees the point is on a surface facing us (used to grey out lamps that are
    on the far side of the car at this angle)."""
    if not anchors:
        return {}
    ids = list(anchors)
    pts = np.array([anchors[k] for k in ids], dtype=np.float64)
    screen, depth, _ = project(pts, view, fov, width, height)

    out = {}
    for i, k in enumerate(ids):
        x, y = screen[i]
        d = depth[i]
        visible = d > 0
        if visible and zbuf is not None:
            ix = int(np.clip(round(x), 0, width - 1))
            iy = int(np.clip(round(y), 0, height - 1))
            zb = zbuf[iy, ix]
            visible = (not np.isfinite(zb)) or (d <= zb * depth_bias + 0.05)
        out[k] = {
            "x": round(float(x) / width * 100.0, 2),
            "y": round(float(y) / height * 100.0, 2),
            "visible": bool(visible),
        }
    return out


# ---------------------------------------------------------------- compose
def render(view_name, azimuth, elevation, distance, fov=26.0, out_size=(1000, 620),
           supersample=3, lamps="head", target_shift=(0.0, 0.0, 0.0)):
    meta, verts, tris, mats = build_scene()

    width, height = out_size[0] * supersample, out_size[1] * supersample
    centre = np.array([
        (meta["xf"] - meta["xr"]) * 0.5 + meta["xr"],
        0.0,
        meta["H"] * 0.46,
    ]) + np.array(target_shift, float)

    eye = orbit_eye(centre, distance, azimuth, elevation)
    view = look_at(eye, centre)

    screen, depth, _ = project(verts, view, fov, width, height)
    light = np.array([0.35, 0.55, 0.78])                 # key light from above / off-side
    colour, zbuf, covered = rasterize(screen, depth, tris, mats, width, height, light, verts)

    table = build_edges(verts, tris, mats)
    edges, fn = select_edges(verts, tris, mats, table)
    colour = draw_edges(colour, screen, depth, zbuf, edges, fn, verts, eye, width, height,
                        thickness=max(1, supersample - 1))

    if lamps == "head":
        colour = lamp_glow(colour, screen, depth, zbuf, tris, mats,
                           [MAT["HEAD"], MAT["LENS"]], (0.72, 0.80, 0.95), width, height, 0.85)
    elif lamps == "tail":
        colour = lamp_glow(colour, screen, depth, zbuf, tris, mats,
                           [MAT["TAIL"], MAT["TAILLENS"]], (0.95, 0.18, 0.26), width, height, 0.8)

    # alpha: anything the body covered, plus whatever the edges and glow lit up
    lum = colour.max(axis=2)
    alpha = np.clip(np.maximum(covered.astype(np.float64) * 0.92, lum * 2.2), 0, 1)

    # ground shadow, an ellipse under the footprint, composited beneath everything
    shadow = np.zeros((height, width), dtype=np.float64)
    foot = []
    for w in meta["wheels"]:
        p, dep, _ = project(np.array([[w["x"], w["y"], 0.0]]), view, fov, width, height)
        if dep[0] > 0:
            foot.append(p[0])
    if len(foot) == 4:
        foot = np.array(foot)
        cx, cy = foot[:, 0].mean(), foot[:, 1].mean()
        rx = (foot[:, 0].max() - foot[:, 0].min()) * 0.78 + width * 0.04
        ry = (foot[:, 1].max() - foot[:, 1].min()) * 0.78 + height * 0.025
        gy, gx = np.mgrid[0:height, 0:width]
        r = ((gx - cx) / max(rx, 1.0)) ** 2 + ((gy - cy) / max(ry, 1.0)) ** 2
        shadow = np.clip(1.0 - r, 0, 1) ** 1.6
        shadow = np.array(Image.fromarray((shadow * 255).astype(np.uint8)).filter(
            ImageFilter.GaussianBlur(width * 0.012))) / 255.0

    out_rgb = np.clip(colour, 0, 1)
    out_a = np.clip(np.maximum(alpha, shadow * 0.42), 0, 1)
    # keep the shadow dark rather than tinting it with the body colour
    shadow_only = np.clip(shadow * 0.42 - alpha, 0, 1)
    out_rgb = out_rgb * (1 - shadow_only[..., None]) + np.array([0.02, 0.02, 0.025]) * shadow_only[..., None]

    rgba = np.dstack([out_rgb, out_a])
    img = Image.fromarray((np.clip(rgba, 0, 1) * 255).astype(np.uint8), mode="RGBA")
    img = img.resize(out_size, Image.LANCZOS)

    out = HERE / f"car-{view_name}.png"
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out.name}  {out_size[0]}x{out_size[1]}  {out.stat().st_size // 1024} KB")

    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    (PREVIEW_DIR / out.name).write_bytes(out.read_bytes())

    # lamp anchors for this exact camera, as percentages of the frame
    meta_m, Vm, _Nm, Fm, Mm = load_sedan()
    shell_end = int(meta_m["intStart"])
    anchors = lamp_anchors(meta_m, Vm, Fm[:shell_end], Mm[:shell_end])
    placed = project_anchors(anchors, view, fov, width, height, zbuf)
    return out, placed


def main():
    views = {}

    # Lights: look at the nose from the driver's front corner - headlights, DRL strip,
    # the kidney grille and the front fogs all face the camera. A low elevation keeps the
    # face of the car toward the viewer instead of showing mostly bonnet.
    _, views["front"] = render("front", azimuth=34.0, elevation=8.0, distance=8.4,
                               fov=27.0, lamps="head")

    # Pop-Bang: swing behind to the other corner - the rear bumper, diffuser and the
    # exhaust tips are the subject, with the tail lights lit. Slightly lower still, so the
    # quad tips sit on the silhouette rather than under it.
    _, views["rear"] = render("rear", azimuth=212.0, elevation=7.0, distance=8.4,
                              fov=27.0, lamps="tail")

    out = HERE / "car-lamps.json"
    out.write_text(json.dumps(views, indent=2), encoding="utf-8")
    print(f"wrote {out.name}")
    for view, lamps in views.items():
        print(f"\n  {view}:")
        for lid, p in sorted(lamps.items()):
            mark = " " if p["visible"] else " (hidden)"
            print(f"    {lid:<14} left:{p['x']:6.2f}%  top:{p['y']:6.2f}%{mark}")


if __name__ == "__main__":
    main()
