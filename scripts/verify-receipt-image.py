"""Verify a freshly retrieved attachment without changing either image.

FlowAccount re-encodes JPEG uploads. Accept only identical bytes/pixels or an
exactly reproducible JPEG encoding of the original, with no resize and quality
at least 90. Similar-looking images and perceptual thresholds are not accepted.
"""
import hashlib
import io
import json
import sys
from pathlib import Path
from PIL import Image, JpegImagePlugin


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(original, saved):
    original, saved = Path(original).read_bytes(), Path(saved).read_bytes()
    result = {"originalSha256": digest(original), "savedSha256": digest(saved)}
    if original == saved:
        return {**result, "verified": True, "method": "bytes"}
    if max(len(original), len(saved)) > 3 * 1024 * 1024:
        raise ValueError("Image exceeds intake bound")
    a, b = Image.open(io.BytesIO(original)), Image.open(io.BytesIO(saved))
    if a.size != b.size or a.mode != b.mode or a.mode != "RGB":
        raise ValueError("Image dimensions or color mode changed")
    if a.info.get("icc_profile") != b.info.get("icc_profile"):
        raise ValueError("Image color profile changed")
    if a.getexif().get(274, 1) != b.getexif().get(274, 1):
        raise ValueError("Image orientation changed")
    target_pixels = b.tobytes()
    if a.tobytes() == target_pixels:
        return {**result, "verified": True, "method": "pixels"}
    if a.format != "JPEG" or b.format != "JPEG":
        raise ValueError("Saved image differs from original")
    quality90 = io.BytesIO()
    a.save(quality90, format="JPEG", quality=90)
    upper = Image.open(io.BytesIO(quality90.getvalue())).quantization
    if set(b.quantization) != set(upper) or any(
        q < 1 or q > limit
        for key, table in b.quantization.items()
        for q, limit in zip(table, upper[key])
    ):
        raise ValueError("JPEG quality below verified bound")
    sampling = JpegImagePlugin.get_sampling(b)
    if sampling != JpegImagePlugin.get_sampling(a):
        raise ValueError("JPEG chroma sampling changed")
    encoded = io.BytesIO()
    a.save(encoded, format="JPEG", qtables=b.quantization, subsampling=sampling)
    expected = Image.open(io.BytesIO(encoded.getvalue())).tobytes()
    if expected != target_pixels:
        raise ValueError("JPEG is not an exact re-encoding of the original")
    return {**result, "verified": True, "method": "exact_jpeg_reencode",
            "pixelSha256": digest(target_pixels), "dimensions": a.size}


if __name__ == "__main__":
    print(json.dumps(verify(*sys.argv[1:3])))
