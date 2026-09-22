# LEFT-EYE-Image-Editor

A fully local multi-layer image editor embedded in a ComfyUI node. Imported images are read directly by the browser and are never sent to a third-party service.

## Features

- Multiple image and paint layers with visibility, locking, opacity, blend mode, renaming, reordering, duplication, and deletion
- Move, scale, rotate, brush, eraser, freehand mask, crop, and canvas expansion tools
- Undo and redo history
- Workflow-persistent editable layer state backed by ComfyUI's local input storage
- Composite image, normal mask, inverted mask, transparent RGBA image, layer JSON, and BBOX outputs
- No CDN, telemetry, upload service, or extra Python dependency
- Full-resolution images up to 8192 × 8192, including square 8K; original files are preserved

Large-image previews use a separate 2.5-megapixel display budget and cached fitted images. Duplicates and unmodified mask layers share source pixels. Raster edits copy pixels only when needed to protect undo history. History keeps up to 20 states with a 512 MiB raster budget (at least the latest two states); repeated full 8K pixel edits therefore retain fewer undo steps. This budget is not a limit on total browser memory. Full-resolution edits, fills, decoding and output still require more time and memory than small images.

## Install

Place this directory at:

```text
ComfyUI/custom_nodes/ComfyUI-LEFT-EYE-Image-Editor
```

Restart ComfyUI, add **LEFT-EYE-Image-Editor** from `image/editing`, then click **图像编辑**.

Imported and edited images are stored under ComfyUI's local `input/left-eye-image-editor` directory. Workflows keep compact file references instead of multi-megabyte Base64 images, while older embedded-image workflows remain supported.

## Layer masks

Use a layer's mask button to choose **正向遮罩** (add) or **反向遮罩** (subtract). Conversion creates an independent mask layer and keeps the original material and background. The main preview shows the mask in translucent white; the layer thumbnail shows black and white. **MASK预览** explicitly switches to the combined black-and-white mask.

Positive mask layers combine, and negative mask layers subtract from that result. With only negative layers, subtraction starts from a white canvas. Visibility, opacity, position, scale and rotation affect the exported mask. Converted brush strokes contribute to the mask without coloring the image output. Save preserves editable mask layers and closes the editor.

Masks use the source layer's alpha channel. A transparent cutout produces an object-shaped mask; an opaque photo produces a rectangular mask. This operation does not perform automatic background removal.

After updating this plugin, restart ComfyUI to load the Python mask-output changes, then refresh the browser to load the editor changes. No additional dependencies are required.

## Sharing this node

The release archive contains only `__init__.py`, `nodes.py`, `pyproject.toml`, `README.md`, and the `web/` folder. Extract the top-level `ComfyUI-LEFT-EYE-Image-Editor` folder into `ComfyUI/custom_nodes/`, restart ComfyUI, and refresh the browser. The receiving ComfyUI must already have its normal Pillow, NumPy, and PyTorch dependencies.

Saved workflows reference images in ComfyUI's local `input/left-eye-image-editor/` folder. To move an existing project to another computer, copy that folder too; a fresh workflow can simply upload its images again.
