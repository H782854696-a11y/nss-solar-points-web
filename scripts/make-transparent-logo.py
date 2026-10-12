#!/usr/bin/env python3
"""Make a transparent NSS logo without altering logo pixels or the source file.

Only near-white pixels connected to an image edge are removed.  This preserves
enclosed white negative space in the mark while removing the scanned/exported
outer background.
"""

from collections import deque
from pathlib import Path
from PIL import Image

SOURCE = Path("public/nss-solar-horizontal-logo.png")
OUTPUT = Path("public/nss-solar-horizontal-logo-transparent.png")
# The original export's pale outer anti-aliasing extends noticeably beyond the
# pure-white canvas.  A wider connected-only threshold clears that halo while
# leaving enclosed white details untouched.
MAX_DISTANCE = 80


def is_background(pixel, reference):
    return max(abs(pixel[index] - reference[index]) for index in range(3)) <= MAX_DISTANCE


def main():
    image = Image.open(SOURCE).convert("RGBA")
    width, height = image.size
    pixels = image.load()
    corners = (pixels[0, 0], pixels[width - 1, 0], pixels[0, height - 1], pixels[width - 1, height - 1])
    background = tuple(round(sum(pixel[channel] for pixel in corners) / len(corners)) for channel in range(3))

    queue = deque()
    removed = set()
    for x in range(width):
        queue.extend(((x, 0), (x, height - 1)))
    for y in range(1, height - 1):
        queue.extend(((0, y), (width - 1, y)))

    while queue:
        x, y = queue.popleft()
        if (x, y) in removed or not is_background(pixels[x, y], background):
            continue
        removed.add((x, y))
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height:
                queue.append((nx, ny))

    for x, y in removed:
        red, green, blue, _ = pixels[x, y]
        pixels[x, y] = (red, green, blue, 0)

    image.save(OUTPUT, "PNG", optimize=True)
    print(f"{SOURCE} -> {OUTPUT}; removed {len(removed)} connected background pixels; reference={background}")


if __name__ == "__main__":
    main()
