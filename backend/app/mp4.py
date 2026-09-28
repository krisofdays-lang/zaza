"""Minimal MP4 / MOV box parser + dedupe uniquifier, ported from mp4.ts.

Reads real video metadata (duration, display size, codec, frame rate, audio
presence, rotation) so upload_settings/configure describe the actual bytes
instead of hardcoded values, and rewrites the mvhd/tkhd timestamps so the same
source file uploaded twice hashes differently (defeats server-side dedupe).
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass


@dataclass
class Mp4Probe:
    duration_ms: int
    width: int
    height: int
    codec: str  # "avc1" | "hvc1"
    frame_rate: int
    has_audio: bool
    rotation_angle: int


@dataclass
class _Box:
    type: str
    data_start: int
    data_end: int


def _u32(buf: bytes, o: int) -> int:
    return int.from_bytes(buf[o:o + 4], "big", signed=False)


def _i32(buf: bytes, o: int) -> int:
    return int.from_bytes(buf[o:o + 4], "big", signed=True)


def _u8(buf: bytes, o: int) -> int:
    return buf[o]


def _read_boxes(buf: bytes, start: int, end: int) -> list[_Box]:
    boxes: list[_Box] = []
    offset = start
    while offset + 8 <= end:
        size = _u32(buf, offset)
        box_type = buf[offset + 4:offset + 8].decode("latin1")
        header_size = 8
        if size == 1:
            if offset + 16 > end:
                break
            high = _u32(buf, offset + 8)
            low = _u32(buf, offset + 12)
            size = high * (2 ** 32) + low
            header_size = 16
        elif size == 0:
            size = end - offset
        if size < header_size or offset + size > end:
            break
        boxes.append(_Box(box_type, offset + header_size, offset + size))
        offset += size
    return boxes


def _find(boxes: list[_Box], box_type: str) -> _Box | None:
    for b in boxes:
        if b.type == box_type:
            return b
    return None


def _parse_mvhd(buf: bytes, b: _Box) -> int:
    version = _u8(buf, b.data_start)
    p = b.data_start + 4  # version(1) + flags(3)
    if version == 1:
        p += 16  # creation(8) + modification(8)
        timescale = _u32(buf, p)
        p += 4
        high = _u32(buf, p)
        low = _u32(buf, p + 4)
        duration = high * (2 ** 32) + low
    else:
        p += 8  # creation(4) + modification(4)
        timescale = _u32(buf, p)
        p += 4
        duration = _u32(buf, p)
    if not timescale:
        return 0
    return round((duration / timescale) * 1000)


def _parse_tkhd(buf: bytes, b: _Box) -> tuple[int, int, int]:
    version = _u8(buf, b.data_start)
    base = b.data_start + 4
    times_len = 32 if version == 1 else 20
    matrix_start = base + times_len + 8 + 2 + 2 + 2 + 2
    rotation = 0
    try:
        a = _i32(buf, matrix_start) / 65536
        bb = _i32(buf, matrix_start + 4) / 65536
        deg = round(math.atan2(bb, a) * 180 / math.pi)
        rotation = ((deg % 360) + 360) % 360
    except Exception:
        rotation = 0
    w_start = b.data_end - 8
    width = _u32(buf, w_start) / 65536
    height = _u32(buf, w_start + 4) / 65536
    return round(width), round(height), rotation


def _track_handler(buf: bytes, mdia: _Box) -> str:
    hdlr = _find(_read_boxes(buf, mdia.data_start, mdia.data_end), "hdlr")
    if not hdlr:
        return ""
    return buf[hdlr.data_start + 8:hdlr.data_start + 12].decode("latin1")


def _video_codec(buf: bytes, mdia: _Box) -> str:
    minf = _find(_read_boxes(buf, mdia.data_start, mdia.data_end), "minf")
    if not minf:
        return "avc1"
    stbl = _find(_read_boxes(buf, minf.data_start, minf.data_end), "stbl")
    if not stbl:
        return "avc1"
    stsd = _find(_read_boxes(buf, stbl.data_start, stbl.data_end), "stsd")
    if not stsd:
        return "avc1"
    entries = _read_boxes(buf, stsd.data_start + 8, stsd.data_end)
    box_type = entries[0].type if entries else ""
    return "hvc1" if box_type in ("hvc1", "hev1") else "avc1"


def _video_frame_rate(buf: bytes, mdia: _Box) -> int:
    children = _read_boxes(buf, mdia.data_start, mdia.data_end)
    mdhd = _find(children, "mdhd")
    minf = _find(children, "minf")
    if not mdhd or not minf:
        return 0
    version = _u8(buf, mdhd.data_start)
    p = mdhd.data_start + 4
    if version == 1:
        p += 16
        timescale = _u32(buf, p)
        p += 4
        duration = _u32(buf, p) * (2 ** 32) + _u32(buf, p + 4)
    else:
        p += 8
        timescale = _u32(buf, p)
        p += 4
        duration = _u32(buf, p)
    if not timescale or not duration:
        return 0
    stbl = _find(_read_boxes(buf, minf.data_start, minf.data_end), "stbl")
    if not stbl:
        return 0
    stsz = _find(_read_boxes(buf, stbl.data_start, stbl.data_end), "stsz")
    if not stsz:
        return 0
    sample_count = _u32(buf, stsz.data_start + 8)
    seconds = duration / timescale
    if not sample_count or seconds <= 0:
        return 0
    fps = round(sample_count / seconds)
    return fps if 1 <= fps <= 240 else 0


def uniquify_mp4(buffer: bytes) -> bytes:
    """Make a video's bytes unique WITHOUT changing length or playback, by
    overwriting the mvhd/tkhd creation/modification timestamps with random
    values. Returns a modified copy; the caller's bytes are untouched."""
    try:
        out = bytearray(buffer)
        top = _read_boxes(out, 0, len(out))
        moov = _find(top, "moov")
        if not moov:
            return bytes(out)

        def rand() -> int:
            return random.randint(0, 0x7FFFFFFF)

        def touch_times(b: _Box) -> None:
            version = _u8(out, b.data_start)
            p = b.data_start + 4
            if version == 1:
                out[p:p + 4] = (0).to_bytes(4, "big")
                out[p + 4:p + 8] = rand().to_bytes(4, "big")
                out[p + 8:p + 12] = (0).to_bytes(4, "big")
                out[p + 12:p + 16] = rand().to_bytes(4, "big")
            else:
                out[p:p + 4] = rand().to_bytes(4, "big")
                out[p + 4:p + 8] = rand().to_bytes(4, "big")

        moov_children = _read_boxes(out, moov.data_start, moov.data_end)
        mvhd = _find(moov_children, "mvhd")
        if mvhd:
            touch_times(mvhd)
        for trak in [b for b in moov_children if b.type == "trak"]:
            tkhd = _find(_read_boxes(out, trak.data_start, trak.data_end), "tkhd")
            if tkhd:
                touch_times(tkhd)
        return bytes(out)
    except Exception:
        return bytes(buffer)


def probe_mp4(buffer: bytes) -> Mp4Probe | None:
    try:
        top = _read_boxes(buffer, 0, len(buffer))
        moov = _find(top, "moov")
        if not moov:
            return None

        moov_children = _read_boxes(buffer, moov.data_start, moov.data_end)
        mvhd = _find(moov_children, "mvhd")
        duration_ms = _parse_mvhd(buffer, mvhd) if mvhd else 0

        width = 0
        height = 0
        codec = "avc1"
        frame_rate = 0
        rotation_angle = 0
        has_audio = False

        for trak in [b for b in moov_children if b.type == "trak"]:
            trak_children = _read_boxes(buffer, trak.data_start, trak.data_end)
            mdia = _find(trak_children, "mdia")
            handler = _track_handler(buffer, mdia) if mdia else ""

            if handler == "soun":
                has_audio = True
                continue

            tkhd = _find(trak_children, "tkhd")
            if tkhd:
                w, h, rot = _parse_tkhd(buffer, tkhd)
                if w > 0 and h > 0 and width == 0:
                    width = w
                    height = h
                    rotation_angle = rot
            if mdia and handler in ("vide", ""):
                if frame_rate == 0:
                    frame_rate = _video_frame_rate(buffer, mdia)
                codec = _video_codec(buffer, mdia)

        if not duration_ms and not width:
            return None
        return Mp4Probe(duration_ms, width, height, codec, frame_rate, has_audio, rotation_angle)
    except Exception:
        return None
