#!/usr/bin/env python
"""
NZ Masjid Finder - data builder.

Fetches every mosque / masjid / Islamic centre / musalla in New Zealand from
OpenStreetMap via the Overpass API, normalises the records, flags likely
duplicates, and writes:

    data/masjids.json   - the app's dataset (served statically)
    data/report.json    - build report (counts, issues, duplicate pairs)

Nothing is invented: every field comes straight from OSM tags (or from a
curated override file, data/overrides.json, which is maintained by hand and
only ever *adds* verified information). Jumu'ah / prayer times are NEVER
generated here - they only appear if a human has verified them.

Usage:
    python scripts/build_data.py
    python scripts/build_data.py --input cached_overpass.json   # offline rebuild
"""

import argparse
import io
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")

USER_AGENT = "NZMasjidFinder/0.1 (open-source mosque discovery; contact: app owner)"
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
]

# Nationwide Overpass query. Kept deliberately tight so the free public
# endpoints answer quickly: religion-tagged places of worship, mosque
# buildings, and anything with a mosque-ish name.
OVERPASS_QUERY = """
[out:json][timeout:180];
area["ISO3166-1"="NZ"]->.a;
(
  nwr["amenity"="place_of_worship"]["religion"="muslim"](area.a);
  nwr["amenity"="place_of_worship"]["religion"="islamic"](area.a);
  nwr["building"="mosque"](area.a);
  nwr["community_centre"="muslim"](area.a);
  nwr["name"~"[Mm]asjid|[Mm]osque|[Mm]usall?ah|[Ii]slamic [Cc]ent",i](area.a);
  nwr["religion"="muslim"]["name"](area.a);
);
out center tags;
"""

# NZ regions (regional council areas) with rough bounding boxes, used to label
# each listing even when OSM has no addr:city / addr:suburb.
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
    ("Chatham Islands", -44.5, -43.5, -177.0, -176.0),
]

DROP_AMENITIES = {"parking", "school", "kindergarten", "bus_station", "fuel"}


def log(*a):
    print(*a, file=sys.stderr)


def fetch_overpass():
    payload = urllib.parse.urlencode({"data": OVERPASS_QUERY}).encode()
    last_err = None
    for attempt in range(3):
        for ep in OVERPASS_ENDPOINTS:
            try:
                req = urllib.request.Request(
                    ep,
                    data=payload,
                    headers={
                        "User-Agent": USER_AGENT,
                        "Accept": "application/json",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                )
                with urllib.request.urlopen(req, timeout=240) as r:
                    raw = r.read().decode("utf-8")
                if not raw.lstrip().startswith("{"):
                    raise ValueError("non-JSON response from %s" % ep)
                doc = json.loads(raw)
                if doc.get("remark", "").startswith("runtime error"):
                    raise ValueError("overpass runtime error: " + doc["remark"])
                log("fetched %d elements from %s" % (len(doc.get("elements", [])), ep))
                return doc
            except Exception as e:  # noqa: BLE001
                last_err = e
                log("  endpoint failed (%s): %s" % (ep, e))
        time.sleep(10)
    raise SystemExit("Could not fetch OSM data: %s" % last_err)


# ---------------------------------------------------------------- helpers

def clean(v):
    if v is None:
        return None
    v = re.sub(r"\s+", " ", str(v)).strip()
    return v or None


def first_phone(*vals):
    out = []
    for v in vals:
        if not v:
            continue
        for part in re.split(r"[;,/]", v):
            p = clean(part)
            if p and p not in out:
                out.append(p)
    return out or None


def norm_phone(p):
    d = re.sub(r"[^\d+]", "", p or "")
    if d.startswith("+64"):
        d = "0" + d[3:]
    elif d.startswith("64"):
        d = "0" + d[2:]
    return d


def norm_name(n):
    n = (n or "").lower()
    n = re.sub(r"\(.*?\)", " ", n)
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    stop = {
        "masjid", "mosque", "musalla", "musallah", "islamic", "centre", "center",
        "trust", "the", "of", "and", "nz", "new", "zealand", "inc", "society",
        "association", "community", "muslim", "muslims", "prayer", "room", "hall",
        "jamia", "e", "al", "el",
    }
    words = [w for w in n.split() if w not in stop and len(w) > 1]
    return " ".join(sorted(words))


def distance_m(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


# Town -> region, used when a bounding box would guess wrong (e.g. Gisborne city
# sits inside the Bay of Plenty box because of the region's shape).
TOWN_REGION = {
    "gisborne": "Gisborne", "wairoa": "Hawke's Bay", "napier": "Hawke's Bay",
    "hastings": "Hawke's Bay", "taupo": "Waikato", "rotorua": "Bay of Plenty",
    "tauranga": "Bay of Plenty", "whakatane": "Bay of Plenty", "gisborne district": "Gisborne",
    "whangarei": "Northland", "kerikeri": "Northland", "kaikohe": "Northland",
    "dargaville": "Northland", "wellsford": "Auckland", "warkworth": "Auckland",
    "nelson": "Nelson", "richmond": "Tasman", "motueka": "Tasman",
    "blenheim": "Marlborough", "kaikoura": "Marlborough", "picton": "Marlborough",
    "greymouth": "West Coast", "hokitika": "West Coast", "westport": "West Coast",
    "timaru": "Canterbury", "ashburton": "Canterbury", "christchurch": "Canterbury",
    "queenstown": "Otago", "dunedin": "Otago", "oamaru": "Otago", "cromwell": "Otago",
    "invercargill": "Southland", "queens park": "Southland",
    "new plymouth": "Taranaki", "hawera": "Taranaki", "stratford": "Taranaki",
    "palmerston north": "Manawatu-Whanganui", "whanganui": "Manawatu-Whanganui",
    "levin": "Manawatu-Whanganui", "taumarunui": "Manawatu-Whanganui",
}


def region_for(lat, lon, city=None):
    """Prefer the town name from OSM, then the regional bounding box."""
    key = (city or "").strip().lower()
    if key in TOWN_REGION:
        return TOWN_REGION[key]
    # exact box match first, then the nearest box centre (boxes overlap)
    hits = [r for r in REGIONS if r[1] <= lat <= r[2] and r[3] <= lon <= r[4]]
    if len(hits) == 1:
        return hits[0][0]
    if hits:
        def d(r):
            clat = (r[1] + r[2]) / 2
            clon = (r[3] + r[4]) / 2
            return (lat - clat) ** 2 + (lon - clon) ** 2
        return min(hits, key=d)[0]
    return "New Zealand"


def pick_kind(tags):
    """Classify: mosque | musalla | centre | other."""
    text = " ".join(
        filter(None, [tags.get("name"), tags.get("name:en"), tags.get("alt_name"),
                      tags.get("description"), tags.get("note")])
    ).lower()
    if "musall" in text or "prayer room" in text or "prayer hall" in text:
        return "musalla"
    if tags.get("building") == "mosque" or "masjid" in text or "mosque" in text:
        return "mosque"
    if "islamic" in text or "centre" in text or "center" in text:
        return "centre"
    return "other"


def is_relevant(tags):
    amenity = tags.get("amenity")
    name = tags.get("name") or ""
    if amenity in DROP_AMENITIES:
        return False
    if amenity == "school" and not re.search(r"masjid|mosque|musall", name, re.I):
        return False
    if tags.get("religion") in ("muslim", "islamic"):
        return True
    if tags.get("building") == "mosque":
        return True
    if tags.get("community_centre") == "muslim":
        return True
    if re.search(r"masjid|mosque|musall?ah", name, re.I):
        return True
    # "Islamic Centre" names, but not "Former Site of ..." style historic notes
    if re.search(r"islamic\s+cent(re|er)", name, re.I):
        return True
    return False


def build_address(tags):
    num = clean(tags.get("addr:housenumber"))
    street = clean(tags.get("addr:street"))
    suburb = clean(tags.get("addr:suburb"))
    city = clean(tags.get("addr:city"))
    postcode = clean(tags.get("addr:postcode"))
    line1 = " ".join(x for x in [num, street] if x) or None
    parts = [p for p in [line1, suburb, city, postcode] if p]
    return {
        "line1": line1,
        "suburb": suburb,
        "city": city,
        "postcode": postcode,
        "formatted": ", ".join(parts) if parts else None,
    }


def normalise(el, idx):
    tags = el.get("tags", {})
    lat = el.get("lat")
    lon = el.get("lon")
    if lat is None and el.get("center"):
        lat, lon = el["center"]["lat"], el["center"]["lon"]
    if lat is None:
        return None

    name = clean(tags.get("name")) or clean(tags.get("name:en")) or "Unnamed Islamic place"
    addr = build_address(tags)
    phones = first_phone(tags.get("phone"), tags.get("contact:phone"), tags.get("mobile"),
                         tags.get("phone:NZ"))
    email = clean(tags.get("email")) or clean(tags.get("contact:email"))
    website = clean(tags.get("website")) or clean(tags.get("contact:website"))
    if website and not re.match(r"^https?://", website):
        website = "https://" + website

    notes = [x for x in [clean(tags.get("note")), clean(tags.get("description"))] if x]
    alt = [x for x in [clean(tags.get("alt_name")), clean(tags.get("name:en")),
                       clean(tags.get("name:mi")), clean(tags.get("name:ar"))] if x]

    osm_type = el["type"]
    osm_id = el["id"]

    rec = {
        "id": "%s/%s" % (osm_type, osm_id),
        "osm": {"type": osm_type, "id": osm_id},
        "name": name,
        "alt_names": alt,
        "kind": pick_kind(tags),
        "denomination": clean(tags.get("denomination")),
        "address": addr,
        "lat": round(float(lat), 7),
        "lon": round(float(lon), 7),
        "region": region_for(float(lat), float(lon), addr.get("city") or addr.get("suburb")),
        "phones": phones,
        "email": email,
        "website": website,
        "facebook": clean(tags.get("contact:facebook")),
        "wheelchair": clean(tags.get("wheelchair")),
        "capacity": clean(tags.get("capacity")),
        "notes": " ".join(notes) if notes else None,
        "opening_hours": clean(tags.get("opening_hours")),
        # Verified-only fields. These stay null unless a human confirms them.
        "jummah_times": None,
        "prayer_times": None,
        "verified": False,
        "verified_by": None,
        "verified_at": None,
        "status": "unverified",
        "last_checked": None,
        "sources": [
            {
                "type": "OpenStreetMap",
                "url": "https://www.openstreetmap.org/%s/%s" % (osm_type, osm_id),
            }
        ],
        "raw_tags": {k: v for k, v in tags.items()
                     if k.startswith(("addr:", "contact:", "name:", "alt_name"))},
    }
    return rec


def apply_overrides(records, overrides):
    """Overrides may only add/adjust verified human-supplied data, keyed by OSM id
    (e.g. 'node/3683039850') or by slug of the name."""
    by_id = {r["id"]: r for r in records}
    by_slug = {slug(r["name"]): r for r in records}
    applied = 0
    for key, patch in overrides.items():
        rec = by_id.get(key) or by_slug.get(key)
        if not rec:
            continue
        for k, v in patch.items():
            if k == "sources" and v:
                rec["sources"] = rec["sources"] + [s for s in v if s not in rec["sources"]]
            else:
                rec[k] = v
        applied += 1
    return applied


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def find_duplicates(records):
    """Same-name + within 300 m, or same phone, or same website -> duplicate pair."""
    pairs = []
    for i, a in enumerate(records):
        for b in records[i + 1:]:
            d = distance_m((a["lat"], a["lon"]), (b["lat"], b["lon"]))
            if d > 1500:
                continue
            na, nb = norm_name(a["name"]), norm_name(b["name"])
            same_name = na and na == nb
            shared_phone = bool(
                {norm_phone(p) for p in (a["phones"] or [])}
                & {norm_phone(p) for p in (b["phones"] or [])}
            )
            shared_site = bool(a["website"] and b["website"] and
                               a["website"].rstrip("/") == b["website"].rstrip("/"))
            close = d < 300
            if (same_name and close) or shared_phone or shared_site:
                reason = []
                if same_name:
                    reason.append("same name")
                if shared_phone:
                    reason.append("same phone")
                if shared_site:
                    reason.append("same website")
                if close:
                    reason.append("%d m apart" % round(d))
                pairs.append({
                    "a": a["id"], "b": b["id"],
                    "a_name": a["name"], "b_name": b["name"],
                    "distance_m": round(d),
                    "reason": ", ".join(reason),
                })
    return pairs


def completeness(r):
    score = 0
    checks = [
        r["address"].get("line1"),
        r["address"].get("suburb") or r["address"].get("city"),
        r["address"].get("postcode"),
        r["phones"],
        r["website"],
        r["email"],
    ]
    for c in checks:
        if c:
            score += 1
    return round(score / len(checks) * 100)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", help="use a cached Overpass JSON file instead of fetching")
    args = ap.parse_args()

    if args.input:
        with io.open(args.input, encoding="utf-8") as f:
            doc = json.load(f)
        log("loaded %d elements from %s" % (len(doc.get("elements", [])), args.input))
    else:
        doc = fetch_overpass()

    records, skipped = [], 0
    for el in doc.get("elements", []):
        if not is_relevant(el.get("tags", {})):
            skipped += 1
            continue
        rec = normalise(el, len(records))
        if rec:
            records.append(rec)

    # de-dup identical OSM entities (a way + its node, etc.)
    seen = set()
    uniq = []
    for r in records:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        uniq.append(r)
    records = uniq

    overrides_path = os.path.join(DATA_DIR, "overrides.json")
    applied = 0
    if os.path.exists(overrides_path):
        with io.open(overrides_path, encoding="utf-8") as f:
            overrides = json.load(f)
        applied = apply_overrides(records, overrides)

    records.sort(key=lambda r: (r["region"], r["name"].lower()))
    dups = find_duplicates(records)

    for r in records:
        r["completeness"] = completeness(r)
        r["slug"] = slug(r["name"]) + "-" + r["id"].replace("/", "-")

    meta = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "osm_timestamp": doc.get("osm3s", {}).get("timestamp_osm_base"),
        "source": "OpenStreetMap contributors (ODbL)",
        "attribution": {
            "text": "© OpenStreetMap contributors",
            "licence": "Open Database License (ODbL) 1.0",
            "url": "https://www.openstreetmap.org/copyright",
            "required": "Attribution must stay visible wherever this data is shown.",
        },
        "provenance": {
            "method": "Overpass API query on the NZ relation, tags copied verbatim",
            "osm_query": OVERPASS_QUERY.strip(),
            "per_record": "every record carries sources[0].url pointing at its OSM element",
            "human_verified": "verified/verified_by/jummah_times are only set by the app's verification flow",
        },
        "count": len(records),
    }

    os.makedirs(DATA_DIR, exist_ok=True)
    out = {"meta": meta, "masjids": records}
    with io.open(os.path.join(DATA_DIR, "masjids.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    by_region = {}
    for r in records:
        by_region[r["region"]] = by_region.get(r["region"], 0) + 1
    no_addr = [r["id"] for r in records if not r["address"]["formatted"]]
    no_contact = [r["id"] for r in records if not (r["phones"] or r["website"] or r["email"])]
    stale = [r["id"] for r in records if r["raw_tags"].get("source") == "survey"
             or r["status"] == "outdated"]

    report = {
        "meta": meta,
        "counts": {
            "total": len(records),
            "skipped_irrelevant": skipped,
            "overrides_applied": applied,
            "with_address": len(records) - len(no_addr),
            "with_contact": len(records) - len(no_contact),
            "by_region": dict(sorted(by_region.items(), key=lambda kv: -kv[1])),
        },
        "issues": {
            "missing_address": no_addr,
            "missing_contact": no_contact,
            "needs_review": stale,
            "duplicate_candidates": dups,
        },
    }
    with io.open(os.path.join(DATA_DIR, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)

    log("wrote %d masjids -> data/masjids.json" % len(records))
    log("regions: %s" % report["counts"]["by_region"])
    log("duplicate candidates: %d" % len(dups))


if __name__ == "__main__":
    main()
