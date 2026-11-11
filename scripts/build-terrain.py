"""Builds resources/terrain.bin.gz: the highest ground and whether it is water, for every 1/12 degree cell.

Sources (both public domain):
  GMTED2010 30 arc-second maximum elevation (mx30_grd), USGS EROS:
    https://edcintl.cr.usgs.gov/downloads/sciweb1/shared/topo/downloads/GMTED/Grid_ZipFiles/mx30_grd.zip
  Natural Earth 10m land and lakes: https://www.naturalearthdata.com/

Needs: rasterio, numpy, pyshp.
Usage: python build-terrain.py <mx30_grd dir> <ne_10m_land.shp> <ne_10m_lakes.shp> <output .bin.gz>
"""

import gzip
import struct
import sys

import numpy as np
import rasterio
import shapefile
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.windows import Window

CELLS_PER_DEGREE = 12
COLS, ROWS = 360 * CELLS_PER_DEGREE, 180 * CELLS_PER_DEGREE
METRES_TO_FEET = 3.28084


def highest_ground(path: str) -> np.ndarray:
    grid = np.zeros((ROWS, COLS), dtype=np.int16)
    with rasterio.open(path) as src:
        factor = round((1 / CELLS_PER_DEGREE) / src.res[0])
        top_row = round((90 - src.bounds.top) * CELLS_PER_DEGREE)
        band_rows = factor * 60
        for start in range(0, src.height, band_rows):
            rows = min(band_rows, src.height - start)
            band = src.read(1, window=Window(0, start, src.width, rows)).astype(np.int32)
            band[band == src.nodata] = 0
            usable = (rows // factor) * factor
            reduced = band[:usable].reshape(usable // factor, factor, src.width // factor, factor).max(axis=(1, 3))
            feet = np.clip(np.round(np.maximum(reduced, 0) * METRES_TO_FEET), 0, 32767).astype(np.int16)
            out = top_row + start // factor
            grid[out : out + feet.shape[0]] = feet
            print(f"elevation rows {start + rows}/{src.height}", end="\r")
    print()
    return grid


def shapes(path: str):
    return [record.shape.__geo_interface__ for record in shapefile.Reader(path).iterShapeRecords()]


def water(land_path: str, lakes_path: str) -> np.ndarray:
    transform = from_origin(-180, 90, 1 / CELLS_PER_DEGREE, 1 / CELLS_PER_DEGREE)
    land = rasterize(shapes(land_path), out_shape=(ROWS, COLS), transform=transform, fill=0, default_value=1, dtype=np.uint8)
    lakes = rasterize(shapes(lakes_path), out_shape=(ROWS, COLS), transform=transform, fill=0, default_value=1, dtype=np.uint8)
    return (land == 0) | (lakes == 1)


def main(grid_path: str, land_path: str, lakes_path: str, output: str) -> None:
    elevations = highest_ground(grid_path)
    is_water = water(land_path, lakes_path)
    bits = np.packbits(is_water.reshape(-1), bitorder="little")
    with gzip.open(output, "wb", compresslevel=9) as out:
        out.write(b"JTR1" + struct.pack("<III", COLS, ROWS, 0))
        out.write(elevations.astype("<i2").tobytes())
        out.write(bits.tobytes())
    print(f"highest cell {elevations.max()} ft, water {is_water.mean():.1%} of cells")


if __name__ == "__main__":
    main(*sys.argv[1:5])
