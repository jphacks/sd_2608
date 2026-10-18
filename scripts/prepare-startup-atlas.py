"""Offline packaging only: pip install Pillow; run from the repository root.

Keep the approved APNG and individual delivery frames unchanged. The runtime
atlas has half-size cells, sufficient for the approximately 323x216 CSS surface.
"""
from pathlib import Path
from PIL import Image

source = Path(__file__).resolve().parents[1] / "public/pet/pochi/startup/run-in-prone.png"
image = Image.open(source)
assert image.n_frames == 107 and image.size == (960, 640)
atlas = Image.new("RGBA", (8 * 480, 14 * 320))
for frame in range(image.n_frames):
    image.seek(frame)
    tile = image.convert("RGBA").resize((480, 320), Image.Resampling.LANCZOS)
    atlas.paste(tile, ((frame % 8) * 480, (frame // 8) * 320))
atlas.save(source.with_name("run-in-prone-atlas.png"), optimize=True)
