# Hardware Images

This directory contains hardware device images for the Meshtastic device models.

## Image Sources

The SVG and WebP images should be obtained from the following official Meshtastic sources:

### Primary Source: Meshtastic-Android Repository
- Repository: https://github.com/meshtastic/Meshtastic-Android
- Location: `app/src/main/res/drawable/`
- Format: SVG
- These are the official device graphics used in the Meshtastic ecosystem

### Secondary Source: Meshtastic Documentation
- Repository: https://github.com/meshtastic/meshtastic
- Location: `static/img/hardware/`
- Format: WebP, SVG
- Subdirectories:
  - `heltec/` - Heltec device images
  - `rak/` - RAK WisBlock images
  - `seeed/` - Seeed devices (SenseCAP, Xiao, T1000-E, etc.)
  - `elecrow/` - ThinkNode images
  - `muzi/` - Muzi BASE images
  - `station-series/` - Station G1/G2 images
  - `canary-one/` - Canary One images
  - `unPhone/` - unPhone images

## Current Status

The SVG files in this directory are **placeholder images** created for development purposes. 
They should be replaced with the actual device images from the sources listed above.

## Naming Convention

Image filenames follow the naming convention from `device_hardware.json`:
- Lowercase with hyphens or underscores (e.g., `heltec-v3.svg`, `t-deck.svg`, `rak2560.svg`)
- Match the `images` array values from device_hardware.json where available

## Image Formats Supported

The HardwareImg component supports:
- **SVG** - Scalable Vector Graphics (preferred)
- **PNG** - Portable Network Graphics  
- **WebP** - Web Picture format

SVG images are displayed without the dark mode brightness filter, while PNG and WebP images 
use `dark:brightness-5` to improve visibility in dark mode.
