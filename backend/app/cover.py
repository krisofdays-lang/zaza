"""Reel cover-frame extraction (best-effort).

Mirrors lib/instagram/reel-cover.ts: pull the first frame of the video as a JPEG
via ffmpeg, and sample average / standard-deviation RGB so configure_to_clips can
send genuine quality_hints.colors. If ffmpeg is unavailable we return None and the
caller falls back to the server deriving the cover from extract_cover_frame:"1".
"""

from __future__ import annotations

import logging
import shutil
import struct
import subprocess
from dataclasses import dataclass

from .config import FFMPEG_PATH

log = logging.getLogger("ig.cover")


@dataclass
class CoverColors:
    averages: dict[str, int]
    standard_deviations: dict[str, int]


@dataclass
class CoverFrame:
    jpeg: bytes
    colors: CoverColors


def _sample_colors_from_rgb(rgb: bytes) -> CoverColors:
    """Compute per-channel mean and stddev over raw RGB bytes."""
    n = len(rgb) // 3
    if n == 0:
        return CoverColors(
            averages={"r": 128, "g": 128, "b": 128},
            standard_deviations={"r": 32, "g": 32, "b": 32},
        )
    sums = [0, 0, 0]
    for i in range(0, n * 3, 3):
        sums[0] += rgb[i]
        sums[1] += rgb[i + 1]
        sums[2] += rgb[i + 2]
    means = [s / n for s in sums]
    sq = [0.0, 0.0, 0.0]
    for i in range(0, n * 3, 3):
        sq[0] += (rgb[i] - means[0]) ** 2
        sq[1] += (rgb[i + 1] - means[1]) ** 2
        sq[2] += (rgb[i + 2] - means[2]) ** 2
    devs = [(s / n) ** 0.5 for s in sq]
    return CoverColors(
        averages={"r": round(means[0]), "g": round(means[1]), "b": round(means[2])},
        standard_deviations={"r": round(devs[0]), "g": round(devs[1]), "b": round(devs[2])},
    )


def extract_cover_frame(video: bytes, at_second: float = 0.0) -> CoverFrame | None:
    """Extract a JPEG cover frame + sampled colors. Returns None on any failure."""
    if not shutil.which(FFMPEG_PATH):
        log.info("ffmpeg not found (%s); server will derive the cover", FFMPEG_PATH)
        return None
    try:
        # JPEG for the actual cover upload.
        jpeg = subprocess.run(
            [FFMPEG_PATH, "-ss", str(at_second), "-i", "pipe:0", "-frames:v", "1",
             "-f", "image2", "-vcodec", "mjpeg", "pipe:1"],
            input=video, capture_output=True, timeout=20,
        ).stdout
        if not jpeg:
            return None
        # Downscaled raw RGB for cheap color sampling.
        rgb = subprocess.run(
            [FFMPEG_PATH, "-ss", str(at_second), "-i", "pipe:0", "-frames:v", "1",
             "-vf", "scale=32:32", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
            input=video, capture_output=True, timeout=20,
        ).stdout
        colors = _sample_colors_from_rgb(rgb)
        return CoverFrame(jpeg=jpeg, colors=colors)
    except Exception as err:  # noqa: BLE001 - best-effort
        log.info("cover extraction failed: %s", err)
        return None
