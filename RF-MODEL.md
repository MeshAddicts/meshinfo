# MeshInfo Coverage / Scan RF Model

This is the propagation model behind the **Coverage** and **Best Neighbors (Scan)** tools on the map. It predicts how far a given Meshtastic node can reach in a specific terrain — the output is the colored coverage bubble around an origin pin and the per-target reach classification in the scan tool.

## Executive summary

For each receiver pixel (or scan target), MeshInfo computes:

```
RSSI = TX_power + TX_gain + RX_gain
       − path_loss_ITM        ← terrain diffraction (Longley-Rice)
       − clutter_loss         ← buildings + vegetation (ITU-R)
       − cable_loss
margin = RSSI − sensitivity − fade_margin
```

Pixels with positive margin are reachable; pixels with margin ≥ 15 dB are reliable. The model is **terrain-aware** (real elevation everywhere) and **per-pixel land-cover-aware** (real building / forest classification at every sample). It's calibrated to ITU-R recommendations, not invented numbers.

## The three components

### 1. Path loss — ITM / Longley-Rice (ITU-R P.526 family)

The Irregular Terrain Model is the industry standard for predicting how a radio wave bends, diffracts, and scatters over real terrain. MeshInfo runs the canonical ITM v1.4 implementation as WebAssembly per pixel, sampling real elevations from USGS 3DEP / Tilezen along each propagation path.

ITM models terrain diffraction over **bare earth** and produces a basic transmission loss in dB. It does not model anything above the ground — no buildings, no trees, no rooftops. That's where the next two components come in.

### 2. Endpoint clutter loss — ITU-R P.452-17 §4.5.4

Each end of the path (TX and RX) has a height-gain correction based on:

- The **antenna's height above local terrain** (h)
- The **nominal clutter height** at that location (hₐ — e.g. 20 m for evergreen forest, 25 m for dense urban)
- The **nominal distance** from antenna to the clutter (dₖ — typically 20–100 m)
- **Frequency** (915 MHz for US Meshtastic)

The formula:

```
A_h = 10.25 · F_fc · exp(−d_k) · {1 − tanh[6 · (h/h_a − 0.625)]} − 0.33   [dB]
```

At 915 MHz, F_fc ≈ 1. The shape: **antenna inside clutter ≈ 19 dB loss; antenna above clutter ≈ 0 dB**, smooth transition through h ≈ 0.625 · hₐ.

Worked examples:

| Class | hₐ | dₖ | h | Aₕ |
|---|---|---|---|---|
| Dense urban | 25 m | 0.02 km | 2 m (handheld) | 19.7 dB |
| Dense urban | 25 m | 0.02 km | 30 m (tower) | ≈ 0 dB |
| Suburban | 9 m | 0.025 km | 2 m | 19.5 dB |
| Suburban | 9 m | 0.025 km | 10 m | ≈ 0 dB |
| Evergreen forest | 20 m | 0.05 km | 2 m | 19.1 dB |
| Evergreen forest | 20 m | 0.05 km | 25 m | ≈ 0 dB |
| Open water | — | — | any | 0 dB |

This explains why a handheld inside trees barely gets a kilometer, but the same node 5 m above the canopy reaches 30+ km — the model captures both regimes correctly.

### 3. Path-traversed vegetation — ITU-R P.833-9 §4.1 (modified exponential decay)

For path segments that pass *through* foliage (between the endpoint zones), the model accumulates additional attenuation:

```
L = A · {1 − exp[−γ · d / A]}   [dB]
```

Where `γ` is the per-metre specific attenuation (dB/m) and `A` is the saturation ceiling (dB) for the class. Properties:

- Linear in distance for short grazes (10 m of evergreen → ~6 dB)
- Saturates for long penetration (1000 m of evergreen → ~27 dB, doesn't grow further)

Per-class accumulation: a path crossing 200 m of deciduous forest then 200 m of evergreen forest computes both losses separately and sums them.

### Avoiding double-counting

P.452 endpoint clutter handles "antenna immersed in nearby clutter" (within ~50 m). P.833 path-integration handles "ray traveling through canopy beyond that zone." MeshInfo skips the first/last `dₖ` km of profile from MED accumulation so the same metre of clutter isn't counted twice.

## Where the land cover comes from

The per-pixel classification uses **USGS NLCD** (National Land Cover Database) — public domain, 30 m native resolution, 16 standard classes for CONUS, well-validated by EPA / USGS / MRLC.

Classes the model uses:

| ID | Class | Penetrable? |
|---|---|---|
| 11 | Open Water | — |
| 12 | Perennial Ice/Snow | — |
| 21 | Developed, Open Space | — |
| 22 | Developed, Low Intensity | — |
| 23 | Developed, Medium Intensity | — |
| 24 | Developed, High Intensity | — |
| 31 | Barren Land | — |
| 41 | Deciduous Forest | yes |
| 42 | Evergreen Forest | yes |
| 43 | Mixed Forest | yes |
| 52 | Shrub/Scrub | yes |
| 71 | Grassland/Herbaceous | — |
| 81 | Pasture/Hay | — |
| 82 | Cultivated Crops | yes |
| 90 | Woody Wetlands | yes |
| 95 | Emergent Herbaceous Wetlands | yes |

The full per-class P.452 (hₐ, dₖ) and P.833 (γ, A) parameters are visible in the **class legend** popover inside the Coverage and Scan settings panels — click "Show class legend" to see the dB at 2 m AGL for every class.

Outside the United States (or anywhere the NLCD bake doesn't cover), the model falls back to **Mixed Forest** as a conservative default for every pixel. Future work tracks adding ESA WorldCover as a global fallback.

## Per-pixel canopy heights — ETH 10 m (optional)

NLCD tells the model *what kind* of canopy is at a pixel; class-nominal heights from P.452 Table 4 (15 m deciduous, 20 m evergreen, 15 m mixed, 10 m woody-wetland, 2 m emergent-wetland) tell it *how tall* that canopy is. Real canopy varies — a 50 m redwood next to a 5 m madrone in the same NLCD "Evergreen Forest" pixel both got coded as 20 m without measurement.

When canopy tiles are baked from **ETH Global Canopy Height 2020** (Lang et al. 2023, 10 m global, CC BY 4.0), the P.833 MED loop uses the measured height per sample instead of the class-nominal:

- The path-integral gate `zPath < terrain + canopyHeight` evaluates against measured canopy at every profile sample.
- Where the measured value is 0 (clearings, fire scars, recent logging), MED contributes nothing for that sample — the path is above any canopy.
- Where the bake doesn't cover a pixel (out-of-bbox / ocean adjacency), the loop falls back to the class-nominal value silently.
- Endpoint clutter (P.452) still uses class-nominal heights — Tier 3 only refines the path-integrated MED. Endpoint heights are a Tier-2 (per-pixel building heights) refinement.

If the bake includes the optional standard-deviation file (`scripts/canopy_tiles.py --include-stddev`), pixels with σ ≥ height are blended 50/50 with the class-nominal so a single noisy ETH pixel can't dominate the integral.

The "Canopy heights" toggle in the Coverage and Scan settings panels lets operators turn the refinement off (e.g. to compare measured-vs-nominal predictions, or to validate the older behavior). Default is on.

**Operator runbook for the canopy bake:** [scripts/README-canopy.md](scripts/README-canopy.md).

## Setup — running the bake

NLCD data is not bundled with MeshInfo (it's ~2 GB). Operators run a one-shot bake script after deploying:

```bash
pip install -r scripts/requirements-landcover.txt
# Download NLCD source from MRLC and extract, then:
python scripts/landcover_tiles.py --source /path/to/nlcd_*.tif --out output/landcover
```

CONUS at full resolution takes 15–90 min depending on CPU. Tiles are bind-mounted into the meshinfo container automatically, no extra config needed.

**Full operator runbook:** [scripts/README-landcover.md](scripts/README-landcover.md)

Once tiles exist, the API mounts them at `/tiles/landcover/{z}/{x}/{y}.png` and the frontend fetches them on every coverage compute. The "Land cover: USGS NLCD" status chip in the Coverage panel shows whether tiles are healthy or the model is using the fallback class.

For the optional canopy-height refinement, run the canopy bake separately:

```bash
docker compose --profile bake run --rm canopy-bake     # CONUS default; --scope global also supported
```

CONUS canopy bake is ~30 GB of source COGs + ~1–2 GB of output tiles. Time: 1–4 hours depending on the ETH file server and CPU. Without this bake, the model uses class-nominal canopy heights — the coverage tool still works.

## The aggression scaler

Inside the Coverage and Scan panels, the **Clutter** control is a 3-stop slider:

| Stop | Multiplier | When to use |
|---|---|---|
| Conservative | 0.7× | Predictions are pessimistic — measured links beat what the model says |
| **Calibrated** | **1.0×** | **Default. ITU baseline. Use this unless you have measured-link data** |
| Aggressive | 1.3× | Predictions are optimistic — measured links fall short. Heavier obstruction than published averages |

The scaler multiplies the final `(A_h_TX + A_h_RX + L_v)` clutter-loss sum. ITM path loss and free-space loss are unaffected.

The default (1.0×) reflects ITU-R P.452 / P.833 published values. Don't sit at 0.7× or 1.3× without a reason — the calibrated baseline is the most accurate prediction. The slider exists because:

- Real-world obstruction varies: a Sierra-foothills canopy is denser than the published "evergreen forest" averages; a Mojave Desert "shrub/scrub" is thinner than the averages
- Operators with measured links can tune to match observations
- The same calibration won't be perfect everywhere on Earth

## What the model does *not* do

These are scope limits that affect prediction accuracy in specific scenarios:

- **Indoor receivers (ITU-R P.2109)** — RX inside a building gets +10–20 dB additional loss not modeled. Outdoor-to-outdoor only.
- **Per-building height** — uses class-nominal heights (4 / 9 / 15 / 25 m for the four NLCD developed-intensity classes); a single tall office tower next to your antenna isn't picked up. Per-pixel canopy heights from ETH 10 m **are** modeled when the canopy bake is in place — that lifts the per-tree limitation for forest classes; per-building heights are tracked as Tier 2 follow-up.
- **Seasonal foliage** — deciduous classes assume leaf-on (summer) at 0.5 dB/m. Out-of-leaf is ~0.15 dB/m; not modeled. Future work.
- **Frequencies other than 915 MHz** — the P.833 specific-attenuation values are calibrated at 915 MHz. Adding 868 MHz (EU) or 433 MHz would need a per-band lookup.
- **Polarization-dependent vegetation loss** — uses unpolarized averages (the slight per-polarization difference is in the noise floor here).
- **Atmospheric refractivity** — fixed at N=301 (Continental Temperate, NA Meshtastic default). Maritime / arid regions are slightly different.

## References

- ITU-R Rec. **P.526** — diffraction-related propagation
- ITU-R Rec. **P.452-17** — terrestrial interference; §4.5.4 is the clutter formula
- ITU-R Rec. **P.833-9** — vegetation attenuation; §4.1 is the MED model
- ITU-R Rec. **P.2108** — newer clutter-loss recommendation (future migration target)
- ITU-R Rec. **P.2109** — building entry loss (indoor RX, deferred)
- USGS NLCD: <https://www.mrlc.gov/data>
- ETH Global Canopy Height 2020 (Lang et al. 2023): <https://langnico.github.io/globalcanopyheight/>
- ITM v1.4: <https://github.com/NTIA/itm>

## How to validate

The right way to know if the model is accurate for *your* mesh: pick known links with measured RSSI/SNR and predicted distance, run them through the Best Neighbors / Coverage tools, compare predicted vs. measured. The aggression slider exists for exactly this tuning step.

A formal validation harness (feed N known links → publish RMSE) is on the roadmap but depends on a corpus of validated link data appearing.
