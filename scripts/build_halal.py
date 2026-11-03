#!/usr/bin/env python
"""
NZ Masjid Finder - halal directory builder.

Pulls every business in New Zealand tagged halal in OpenStreetMap
(diet:halal=yes|only, halal butchers, halal cuisine) and writes
data/halal.json for the Halal tab.

Honest labelling: OSM halal tags are community-maintained and NOT certified.
The app shows "OSM community tag - confirm before eating" unless a business
has been verified in the app's own verification store.

Usage:
    python scripts/build_halal.py
    python scripts/build_halal.py --input data/cache-halal.json
"""

import argparse
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
USER_AGENT = "NZMasjidFinder/0.1 (open-source halal directory)"

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

QUERY = """
[out:json][timeout:180];
area["ISO3166-1"="NZ"]->.a;
(
  nwr["diet:halal"="yes"](area.a);
  nwr["diet:halal"="only"](area.a);
  nwr["shop"="butcher"]["diet:halal"](area.a);
  nwr["cuisine"~"halal",i](area.a);
);
out center tags;
"""

REGIONS = [
    ("Northland", -36.6, -34.0, 172.0, 175.0),
    ("Auckland", -37.5, -36.0, 174.0, 175.6),
    ("Waikato", -39.0, -36.8, 174.0, 176.5),
    ("Bay of Plenty", -38.8, -37.2, 175.8, 178.5),
    ("Gisborne", -39.0, -37.4, 177.0, 178.6),
    ("Hawke's Bay", -40.6, -38.6, 175.5, 178.0),
    ("Taranaki", -39.9, -38.4, 173.6, 175.2),
    ("Manawatu-Whanganui", -41.0, -38.8, 173.5, 176.5),
    ("Wellington", -41.7, -40.4, 174.4, 176.5),
    ("Tasman", -42.0, -40.4, 172.0, 173.2),
    ("Nelson", -41.4, -41.1, 173.1, 173.5),
    ("Marlborough", -42.7, -40.9, 172.6, 174.4),
    ("West Coast", -44.5, -40.8, 170.5, 172.8),
    ("Canterbury", -45.0, -42.0, 170.5, 173.5),
    ("Otago", -46.6, -44.0, 168.0, 171.5),
    ("Southland", -47.5, -44.5, 166.0, 170.0),
]

CATEGORY = {
    "restaurant": "Restaurant",
    "fast_food": "Fast food",
    "cafe": "Cafe",
    "ice_cream": "Ice cream",
    "butcher": "Butcher",
    "supermarket": "Supermarket",
    "bakery": "Bakery",
    "convenience": "Convenience store",
    "beverages": "Drinks",
}


def log(*a):
    print(*a, file=sys.stderr)


def clean(v):
    if v is None:
        return None
    v = re.sub(r"\s+", " ", str(v)).strip()
    return v or None


def region_for(lat, lon):
    for name, s, n, w, e in REGIONS:
        if s <= lat <= n and w <= lon <= e:
            return name
    return "New Zealand"


def fetch():
    payload = urllib.parse.urlencode({"data": QUERY}).encode()
    last = None
    for attempt in range(3):
        for ep in ENDPOINTS:
            try:
                req = urllib.request.Request(ep, data=payload, headers={
                    "User-Agent": USER_AGENT, "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded"})
                with urllib.request.urlopen(req, timeout=240) as r:
                    raw = r.read().decode("utf-8")
                if not raw.lstrip().startswith("{"):
                    raise ValueError("non-JSON from " + ep)
                doc = json.loads(raw)
                if str(doc.get("remark", "")).startswith("runtime error"):
                    raise ValueError(doc["remark"])
                log("fetched %d elements from %s" % (len(doc.get("elements", [])), ep))
                return doc
            except Exception as e:  # noqa: BLE001
                last = e
                log("  %s failed: %s" % (ep, e))
        time.sleep(8)
    raise SystemExit("Overpass failed: %s" % last)


def category_of(tags):
    for key in ("amenity", "shop"):
        v = tags.get(key)
        if v in CATEGORY:
            return CATEGORY[v]
    return "Halal business"


def build(doc):
    out, seen = [], set()
    for el in doc.get("elements", []):
        tags = el.get("tags", {})
        name = clean(tags.get("name")) or clean(tags.get("brand"))
        if not name:
            continue
        lat, lon = el.get("lat"), el.get("lon")
        if lat is None and el.get("center"):
            lat, lon = el["center"]["lat"], el["center"]["lon"]
        if lat is None:
            continue
        rid = "%s/%s" % (el["type"], el["id"])
        if rid in seen:
            continue
        seen.add(rid)
        addr_parts = [
            " ".join(x for x in [clean(tags.get("addr:housenumber")), clean(tags.get("addr:street"))] if x) or None,
            clean(tags.get("addr:suburb")),
            clean(tags.get("addr:city")),
            clean(tags.get("addr:postcode")),
        ]
        out.append({
            "id": rid,
            "name": name,
            "category": category_of(tags),
            "cuisine": clean(tags.get("cuisine")),
            "halal_tag": clean(tags.get("diet:halal")) or ("cuisine" if "halal" in (tags.get("cuisine") or "").lower() else None),
            "address": ", ".join([p for p in addr_parts if p]) or None,
            "city": clean(tags.get("addr:city")),
            "postcode": clean(tags.get("addr:postcode")),
            "lat": round(float(lat), 7),
            "lon": round(float(lon), 7),
            "region": region_for(float(lat), float(lon)),
            "phone": clean(tags.get("phone")) or clean(tags.get("contact:phone")),
            "website": clean(tags.get("website")) or clean(tags.get("contact:website")),
            "opening_hours": clean(tags.get("opening_hours")),
            "verified": False,   # OSM tag != certification; the app can verify later
            "certification": None,
            "sources": [{"type": "OpenStreetMap",
                         "url": "https://www.openstreetmap.org/%s/%s" % (el["type"], el["id"])}],
        })
    out.sort(key=lambda r: (r["region"], r["category"], r["name"].lower()))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input")
    args = ap.parse_args()
    if args.input:
        with io.open(args.input, encoding="utf-8") as f:
            doc = json.load(f)
    else:
        doc = fetch()
    rows = build(doc)
    meta = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "OpenStreetMap contributors (ODbL)",
        "attribution": {
            "text": "© OpenStreetMap contributors",
            "licence": "Open Database License (ODbL) 1.0",
            "url": "https://www.openstreetmap.org/copyright",
        },
        "provenance": {
            "method": "Overpass API: diet:halal=yes|only, halal butchers, halal cuisine, nationwide",
            "osm_query": QUERY.strip(),
            "tag_counts": {},
        },
        "note": "Halal status is a community OSM tag, not a certificate. Confirm before eating.",
        "count": len(rows),
    }
    counts = {}
    for r in rows:
        k = r.get("halal_tag") or "cuisine"
        counts[k] = counts.get(k, 0) + 1
    meta["provenance"]["tag_counts"] = counts
    with io.open(os.path.join(DATA_DIR, "halal.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "businesses": rows}, f, ensure_ascii=False, indent=1)
    log("wrote %d halal businesses -> data/halal.json" % len(rows))


if __name__ == "__main__":
    main()
