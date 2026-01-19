# Hardware Images

This directory contains hardware device images for the Meshtastic device models.

## Current Status

The images in this directory have been downloaded from the official Meshtastic documentation repository. Most images are in WebP format, with some SVG images for specific devices.

## Image Sources

The images were obtained from the following official Meshtastic sources:

### Primary Source: Meshtastic Documentation
- Repository: https://github.com/meshtastic/meshtastic
- Location: `static/img/hardware/`
- Format: WebP, SVG
- Subdirectories:
  - `heltec/` - Heltec device images (Vision Master series, Mesh Node T114, Mesh Pocket)
  - `rak/` - RAK WisBlock images (WisMesh Tap, Tag, Hub/RAK2560)
  - `seeed/` - Seeed devices (SenseCAP Indicator, Xiao S3, T1000-E, Solar Node, Xiao NRF52 Kit)
  - `elecrow/` - ThinkNode images (M1, M2, M5)
  - `muzi/` - Muzi BASE images

### Additional Source: Meshtastic-Android Repository
- Repository: https://github.com/meshtastic/Meshtastic-Android
- Location: `app/src/main/res/drawable/`
- Format: SVG
- These are the official device graphics used in the Meshtastic ecosystem

## Naming Convention

Image filenames follow the naming convention from `device_hardware.json`:
- Lowercase with hyphens or underscores (e.g., `heltec-v3.svg`, `t-deck.svg`, `rak2560.webp`)
- Match the `images` array values from device_hardware.json where available

## Image Formats Supported

The HardwareImg component supports:
- **WebP** - Web Picture format (most images)
- **SVG** - Scalable Vector Graphics  
- **PNG** - Portable Network Graphics (legacy images)

WebP and PNG images use `dark:brightness-5` to improve visibility in dark mode, while SVG images are displayed without the dark mode brightness filter.

## Adding New Images

To add images for new hardware models:
1. Download the image from the meshtastic/meshtastic repository or Meshtastic-Android
2. Place it in both `frontend/public/images/hardware/` and `public/images/hardware/`
3. Use the filename referenced in `device_hardware.json` when available
4. Update the `HARDWARE_PHOTOS` mappings in `meshtastic_support.py` and `frontend/src/types/index.ts`
