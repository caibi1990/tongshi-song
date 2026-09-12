#!/usr/bin/env python3
"""Generate MP3 audio for all 116 poems using Edge TTS."""

import re
import os
import json
import asyncio
import edge_tts

VOICE = "zh-CN-XiaoxiaoNeural"
RATE = "-15%"  # slightly slower for children
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "public", "audio", "poetry")

def extract_poems(html_path):
    """Extract POEMS array from poetry.html."""
    with open(html_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Find the POEMS array
    match = re.search(r'const POEMS=\[(.*?)\];', content, re.DOTALL)
    if not match:
        raise ValueError("Could not find POEMS array")

    poems_text = match.group(1)

    # Parse each poem object
    poems = []
    for m in re.finditer(
        r'\{id:(\d+),t:"([^"]*)",a:"([^"]*)",d:"([^"]*)",l:\[(.*?)\]\}',
        poems_text
    ):
        pid = int(m.group(1))
        title = m.group(2)
        author = m.group(3)
        dynasty = m.group(4)
        lines_text = m.group(5)
        lines = re.findall(r'"([^"]*)"', lines_text)

        poems.append({
            "id": pid,
            "t": title,
            "a": author,
            "d": dynasty,
            "l": lines,
        })

    return poems


def build_tts_text(poem):
    """Build the TTS text matching the speakPoem() logic."""
    intro = ""
    if poem["t"]:
        intro += poem["t"] + "。"
    if poem["d"]:
        intro += poem["d"] + "朝。"
    if poem["a"]:
        intro += poem["a"] + "。"
    poem_text = "，".join(poem["l"]) + "。"
    return intro + poem_text


async def generate_mp3(poem, output_dir, max_retries=3):
    """Generate a single poem MP3 with retry."""
    pid = poem["id"]
    out_path = os.path.join(output_dir, f"{pid}.mp3")

    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        print(f"  [{pid:3d}/116] skip (exists): {poem['t']}")
        return

    text = build_tts_text(poem)
    for attempt in range(max_retries):
        try:
            communicate = edge_tts.Communicate(text, VOICE, rate=RATE)
            await communicate.save(out_path)
            size_kb = os.path.getsize(out_path) / 1024
            print(f"  [{pid:3d}/116] {poem['t']:12s} → {size_kb:.0f}KB")
            return
        except Exception as e:
            if attempt < max_retries - 1:
                wait = 2 ** (attempt + 1)
                print(f"  [{pid:3d}/116] retry {attempt+1} after {wait}s: {e}")
                await asyncio.sleep(wait)
            else:
                print(f"  [{pid:3d}/116] FAILED: {poem['t']} - {e}")
                # Clean up partial file
                if os.path.exists(out_path):
                    os.remove(out_path)


async def main():
    html_path = os.path.join(os.path.dirname(__file__), "public", "poetry.html")
    poems = extract_poems(html_path)
    print(f"Found {len(poems)} poems")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Generate in batches of 5 to avoid rate limiting
    batch_size = 5
    for i in range(0, len(poems), batch_size):
        batch = poems[i:i + batch_size]
        tasks = [generate_mp3(p, OUTPUT_DIR) for p in batch]
        await asyncio.gather(*tasks)
        if i + batch_size < len(poems):
            await asyncio.sleep(2)  # delay between batches

    print(f"\nDone! Generated {len(poems)} MP3 files in {OUTPUT_DIR}")


if __name__ == "__main__":
    asyncio.run(main())
