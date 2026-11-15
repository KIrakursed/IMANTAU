#!/usr/bin/env bash
# IMANTAU — download the open geodata used to build the real-location scene.
#   bash tools/geo_fetch.sh && python tools/geo_prepare.py
# Sources (all open):
#   * Terrain Tiles (Terrarium PNG, SRTM-based) — AWS Open Data, https://registry.opendata.aws/terrain-tiles/
#   * Sentinel-2 cloudless 2016 by EOX IT Services GmbH — CC BY 4.0, https://s2maps.eu
#   * OpenStreetMap via Overpass API — ODbL, © OpenStreetMap contributors
set -euo pipefail
cd "$(dirname "$0")/../work/geo"
mkdir -p raw/dem raw/sat
UA="IMANTAU-museum-build/1.0 (educational site generator)"
# Area: z14 tiles x 11292..11306, y 5330..5345 (~22 x 23 km around Lake Imantau and Mount Imantau)
for x in $(seq 5646 5653); do for y in $(seq 2665 2672); do
  f=raw/dem/13_${x}_${y}.png; [ -s "$f" ] || curl -sf -A "$UA" -o "$f" "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/13/$x/$y.png"
done; done
for x in $(seq 11292 11306); do for y in $(seq 5330 5345); do
  f=raw/sat/14_${x}_${y}.jpg; [ -s "$f" ] || { curl -sf -A "$UA" -o "$f" "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/14/$y/$x.jpg"; sleep 0.05; }
done; done
BBOX="52.8823912222619,68.115234375,53.09402405506326,68.44482421875"
curl -s -A "$UA" --data-urlencode "data=[out:json][timeout:90];(way[\"natural\"=\"water\"]($BBOX);relation[\"natural\"=\"water\"]($BBOX);way[\"building\"]($BBOX);way[\"highway\"~\"^(primary|secondary|tertiary|unclassified|residential|track)$\"]($BBOX););out geom;" https://overpass-api.de/api/interpreter -o raw/osm.json
curl -s -A "$UA" --data-urlencode "data=[out:json][timeout:25];node[\"place\"]($BBOX);out;" https://overpass-api.de/api/interpreter -o raw/osm_places.json
echo "done: $(ls raw/dem | wc -l) DEM tiles, $(ls raw/sat | wc -l) imagery tiles"
