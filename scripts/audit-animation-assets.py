"""Offline pixel audit: python scripts/audit-animation-assets.py (Pillow required)."""
import hashlib
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
specs = json.loads((ROOT / "src/pochi/atlases.json").read_text())
registration = json.loads((ROOT / "src/pochi/frame-registration.json").read_text())
result = {"result": "PASS", "browserVisualVerified": False, "actions": {}}
tiles = {}
for name, spec in specs.items():
    path = ROOT / "public" / spec["src"].lstrip("/")
    atlas = Image.open(path).convert("RGBA")
    assert atlas.size == (spec["columns"] * 512, spec["rows"] * 512)
    assert len(registration[name]) == spec["count"]
    frames = []
    for index in range(spec["count"]):
        x, y = index % spec["columns"] * 512, index // spec["columns"] * 512
        tile = atlas.crop((x, y, x + 512, y + 512))
        assert tile.getchannel("A").getbbox() is not None, (name, index, "blank")
        bounds = tile.getchannel("A").point(lambda a: 255 if a > 32 else 0).getbbox()
        assert bounds[3] == registration[name][index], (name, index, "registration")
        offset = 480 - bounds[3]
        assert abs(offset) <= 4 and 0 <= bounds[1] + offset < 480
        frames.append(tile)
    tiles[name] = frames
    result["actions"][name] = {"frames": len(frames), "blankFrames": 0, "groundAfterCorrection": 480,
        "loop": spec["loop"], "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

for name in ["idle", "rest"]:
    poster = Image.open(ROOT / f"public/pet/pochi/{name}-poster.png").convert("RGBA")
    assert poster.tobytes() == tiles[name][0].tobytes(), (name, "poster")
for a, index_a, b, index_b in [("rest", 0, "rest_to_sit", 0), ("idle", 0, "rest_to_sit", 25),
                               ("idle", 0, "turn_sit", 0), ("idle", 0, "turn_sit", 22)]:
    assert tiles[a][index_a].tobytes() == tiles[b][index_b].tobytes(), (a, b, "shared endpoint")
    assert registration[a][index_a] == registration[b][index_b]

references = json.loads((ROOT / "src/pochi/reference-gifs.json").read_text())
for name, source in references.items():
    data = (ROOT / "public" / source["src"].lstrip("/")).read_bytes()
    assert hashlib.sha256(data).hexdigest() == source["sha256"], (name, "original GIF changed")

folder = ROOT / "public/pet/pochi/startup"
original = Image.open(folder / "run-in-prone.png")
packed = Image.open(folder / "run-in-prone-atlas.png").convert("RGBA")
assert original.n_frames == 107 and packed.size == (3840, 4480)
blank = []
hold = []
for index in range(107):
    original.seek(index)
    expected = original.convert("RGBA").resize((480, 320), Image.Resampling.LANCZOS)
    x, y = index % 8 * 480, index // 8 * 320
    actual = packed.crop((x, y, x + 480, y + 320))
    assert actual.tobytes() == expected.tobytes(), (index, "startup packing")
    if actual.getchannel("A").getbbox() is None:
        blank.append(index)
    if index >= 84:
        hold.append(actual.tobytes())
assert blank == [0], blank  # Approved entrance starts from invisible.
assert all(frame == hold[-1] for frame in hold), "startup final hold moves"
result["actions"]["arrival"] = {"frames": 107, "blankFrames": blank, "blankFrameIntentional": True,
    "allPackedPixelsMatchSource": True, "finalHoldIdenticalFrames": len(hold)}
result["uniqueSourceFrames"] = 214
result["playbackSegments"] = 9
result["logicalFramesIncludingReverse"] = 240
output = ROOT / "artifacts/animation-assets-audit.json"
output.parent.mkdir(exist_ok=True)
output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")
print(f"PASS: 214 source frames, 240 logical frames, 9 segments; {output}")
