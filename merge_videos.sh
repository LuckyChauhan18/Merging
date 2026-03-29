#!/bin/bash
# Merge videos from before_video/boat/ into finalvideo/
# Usage: bash merge_videos.sh

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BASE_DIR"

INPUT_DIR="before_video/boat"
OUTPUT_DIR="finalvideo"
OUTPUT_FILE="$OUTPUT_DIR/boat_merged.mp4"

mkdir -p "$OUTPUT_DIR"

# Create concat list in project directory (ffmpeg resolves relative paths from concat file location)
printf "file '%s/boat1.mp4'\nfile '%s/boat2.mp4'\n" "$INPUT_DIR" "$INPUT_DIR" > concat_list.txt

echo "Merging videos from $INPUT_DIR ..."
ffmpeg -y -f concat -safe 0 -i concat_list.txt -c copy "$OUTPUT_FILE" 2>&1

rm -f concat_list.txt

if [ -f "$OUTPUT_FILE" ]; then
    echo "Done! Merged video saved to: $OUTPUT_FILE"
else
    echo "Error: merge failed"
    exit 1
fi
