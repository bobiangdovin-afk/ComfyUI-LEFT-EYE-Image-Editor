import base64
import binascii
import hashlib
import io
import json
import os

import numpy as np
import torch
from PIL import Image, ImageChops, ImageColor, ImageDraw, ImageOps

try:
    import folder_paths
except ImportError:  # Allows the small standalone test suite to import this module.
    folder_paths = None


DEFAULT_SIZE = 512
MAX_CANVAS_SIZE = 8192


def _blank_outputs(width=DEFAULT_SIZE, height=DEFAULT_SIZE):
    composite = Image.new("RGB", (width, height), "white")
    transparent = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    mask = Image.new("L", (width, height), 0)
    return composite, transparent, mask


def _decode_data_url(value, mode, size=None):
    if not isinstance(value, str) or not value.startswith("data:image/") or ";base64," not in value[:64]:
        raise ValueError("Editor state contains an invalid image data URL")
    try:
        raw = base64.b64decode(value.split(";base64,", 1)[1], validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("Editor state contains invalid base64 image data") from error

    with Image.open(io.BytesIO(raw)) as image:
        image.load()
        if size is not None and image.size != size:
            raise ValueError(f"Editor image size {image.size} does not match canvas {size}")
        return image.convert(mode)


def _decode_asset(asset, mode, size=None):
    if folder_paths is None or not isinstance(asset, dict):
        raise ValueError("Editor state contains an unavailable local image reference")
    filename = asset.get("filename")
    subfolder = asset.get("subfolder") or ""
    asset_type = asset.get("type") or "input"
    if not isinstance(filename, str) or not filename or asset_type not in {"input", "output", "temp"}:
        raise ValueError("Editor state contains an invalid local image reference")
    relative = os.path.join(subfolder, filename).replace("\\", "/")
    path = folder_paths.get_annotated_filepath(f"{relative} [{asset_type}]")
    if not os.path.isfile(path):
        raise ValueError(f"Editor image file is missing: {relative}")
    with Image.open(path) as image:
        image.load()
        if size is not None and image.size != size:
            raise ValueError(f"Editor image size {image.size} does not match canvas {size}")
        return image.convert(mode)


def _transform_layer(layer, canvas_size):
    if layer.get("asset"):
        image = _decode_asset(layer["asset"], "RGBA")
    else:
        image = _decode_data_url(layer.get("src"), "RGBA")
    scale_x = float(layer.get("scaleX", 1))
    scale_y = float(layer.get("scaleY", 1))
    if abs(scale_x) < 0.0001 or abs(scale_y) < 0.0001:
        return Image.new("RGBA", canvas_size, (0, 0, 0, 0))

    center_x = float(layer.get("x", canvas_size[0] / 2))
    center_y = float(layer.get("y", canvas_size[1] / 2))
    angle = np.deg2rad(float(layer.get("rotation", 0)))
    cosine = float(np.cos(angle))
    sine = float(np.sin(angle))
    source_width, source_height = image.size
    coefficients = (
        cosine / scale_x,
        sine / scale_x,
        source_width / 2 - center_x * cosine / scale_x - center_y * sine / scale_x,
        -sine / scale_y,
        cosine / scale_y,
        source_height / 2 + center_x * sine / scale_y - center_y * cosine / scale_y,
    )
    transformed = image.transform(
        canvas_size,
        Image.Transform.AFFINE,
        coefficients,
        resample=Image.Resampling.BICUBIC,
    )
    opacity = max(0.0, min(1.0, float(layer.get("opacity", 1))))
    if opacity < 1:
        alpha = transformed.getchannel("A").point(lambda value: round(value * opacity))
        transformed.putalpha(alpha)
    return transformed


def _blend_rgba(backdrop, source, mode):
    if mode == "source-over":
        return Image.alpha_composite(backdrop, source)

    backdrop_array = np.asarray(backdrop, dtype=np.float32) / 255.0
    source_array = np.asarray(source, dtype=np.float32) / 255.0
    backdrop_rgb = backdrop_array[..., :3]
    source_rgb = source_array[..., :3]
    backdrop_alpha = backdrop_array[..., 3:4]
    source_alpha = source_array[..., 3:4]

    if mode == "multiply":
        blended = backdrop_rgb * source_rgb
    elif mode == "screen":
        blended = backdrop_rgb + source_rgb - backdrop_rgb * source_rgb
    elif mode == "overlay":
        blended = np.where(
            backdrop_rgb <= 0.5,
            2 * backdrop_rgb * source_rgb,
            1 - 2 * (1 - backdrop_rgb) * (1 - source_rgb),
        )
    elif mode == "darken":
        blended = np.minimum(backdrop_rgb, source_rgb)
    elif mode == "lighten":
        blended = np.maximum(backdrop_rgb, source_rgb)
    else:
        return Image.alpha_composite(backdrop, source)

    output_alpha = source_alpha + backdrop_alpha * (1 - source_alpha)
    premultiplied = (
        source_rgb * source_alpha * (1 - backdrop_alpha)
        + backdrop_rgb * backdrop_alpha * (1 - source_alpha)
        + blended * source_alpha * backdrop_alpha
    )
    output_rgb = np.divide(
        premultiplied,
        output_alpha,
        out=np.zeros_like(premultiplied),
        where=output_alpha > 0,
    )
    output = np.concatenate((output_rgb, output_alpha), axis=2)
    return Image.fromarray(np.uint8(np.clip(output * 255.0, 0, 255)), "RGBA")


def _compose_layers(state, size):
    transparent = Image.new("RGBA", size, (0, 0, 0, 0))
    mask_sources = {layer.get("maskSourceId") for layer in state.get("layers", []) if layer.get("kind") == "mask"}
    for layer in reversed(state.get("layers") or []):
        if layer.get("kind") == "mask" or (layer.get("kind") == "paint" and layer.get("id") in mask_sources):
            continue
        if layer.get("visible", True) is False or not (layer.get("src") or layer.get("asset")):
            continue
        transformed = _transform_layer(layer, size)
        transparent = _blend_rgba(
            transparent,
            transformed,
            layer.get("blendMode", "source-over"),
        )

    try:
        background = ImageColor.getrgb(state.get("background", "#ffffff"))
    except (TypeError, ValueError):
        background = (255, 255, 255)
    composite = Image.new("RGBA", size, (*background, 255))
    composite = Image.alpha_composite(composite, transparent).convert("RGB")
    return composite, transparent


def _compose_mask(state, size):
    if state.get("maskAsset"):
        mask = _decode_asset(state["maskAsset"], "L", size)
    elif state.get("maskSrc"):
        mask = _decode_data_url(state["maskSrc"], "L", size)
    else:
        mask = Image.new("L", size, 0)

    for stroke in state.get("maskStrokes") or []:
        points = stroke.get("points") or []
        if not points:
            continue
        opacity = max(0.0, min(1.0, float(stroke.get("opacity", 1))))
        overlay = Image.new("L", size, 0)
        draw = ImageDraw.Draw(overlay)
        width = max(1, round(float(stroke.get("size", 28))))
        normalized = [(float(point[0]), float(point[1])) for point in points]
        fill = round(255 * opacity)
        if len(normalized) > 1:
            draw.line(normalized, fill=fill, width=width, joint="curve")
        radius = width / 2
        for x, y in (normalized[0], normalized[-1]):
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)
        if stroke.get("subtract"):
            mask = ImageChops.multiply(mask, ImageOps.invert(overlay))
        else:
            mask = ImageChops.screen(mask, overlay)
    layers = [layer for layer in state.get("layers", []) if layer.get("kind") == "mask" and layer.get("visible", True)]
    positives = [layer for layer in layers if not layer.get("maskInvert")]
    negatives = [layer for layer in layers if layer.get("maskInvert")]
    if negatives and not positives and not (state.get("maskAsset") or state.get("maskSrc") or state.get("maskStrokes")):
        mask = Image.new("L", size, 255)
    for layer in positives + negatives:
        alpha = _transform_layer(layer, size).getchannel("A")
        mask = ImageChops.multiply(mask, ImageOps.invert(alpha)) if layer.get("maskInvert") else ImageChops.screen(mask, alpha)
    return mask


def _image_tensor(image):
    array = np.array(image, dtype=np.float32)
    array /= 255.0
    return torch.from_numpy(array).unsqueeze(0)


def _mask_tensor(mask):
    return _image_tensor(mask)


def _parse_state(editor_state):
    if not editor_state:
        state = {}
    else:
        try:
            state = json.loads(editor_state)
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError("Editor state is not valid JSON") from error

    width = int(state.get("width", DEFAULT_SIZE))
    height = int(state.get("height", DEFAULT_SIZE))
    if not 1 <= width <= MAX_CANVAS_SIZE or not 1 <= height <= MAX_CANVAS_SIZE:
        raise ValueError(f"Canvas dimensions must be between 1 and {MAX_CANVAS_SIZE} pixels")

    outputs = state.get("outputs") or {}
    if outputs:
        size = (width, height)
        composite = _decode_data_url(outputs.get("composite"), "RGB", size)
        transparent = _decode_data_url(outputs.get("transparent"), "RGBA", size)
        mask = _decode_data_url(outputs.get("mask"), "L", size)
    else:
        size = (width, height)
        if state.get("layers"):
            composite, transparent = _compose_layers(state, size)
        else:
            composite, transparent, _ = _blank_outputs(width, height)
        mask = _compose_mask(state, size)

    return state, composite, transparent, mask


class LocalImageEditor:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "editor_state": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": False,
                        "tooltip": "Local editor project data. Use the Open Editor button to change it.",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "MASK", "IMAGE", "STRING", "BBOX")
    RETURN_NAMES = (
        "图像",
        "手绘遮罩",
        "反向遮罩",
        "透明PNG",
        "图层JSON",
        "区域边界",
    )
    FUNCTION = "render"
    CATEGORY = "image/editing"
    DESCRIPTION = "A fully local, workflow-persistent multi-layer image editor."

    @classmethod
    def IS_CHANGED(cls, editor_state=""):
        return hashlib.sha256(editor_state.encode("utf-8")).hexdigest()

    def render(self, editor_state=""):
        state, composite, transparent, mask_image = _parse_state(editor_state)
        mask = _mask_tensor(mask_image)
        bounds = mask_image.getbbox()
        if bounds:
            x0, y0, x1, y1 = bounds
            bbox = (x0, y0, x1 - x0, y1 - y0)
        else:
            bbox = (0, 0, 0, 0)

        return (
            _image_tensor(composite),
            mask,
            1.0 - mask,
            _image_tensor(transparent),
            json.dumps(state, ensure_ascii=False, separators=(",", ":")),
            bbox,
        )


NODE_CLASS_MAPPINGS = {
    "LEFT-EYE-Image-Editor": LocalImageEditor,
    # Keep the former identifier readable for existing workflows.
    "ComfyUI-LEFT-EYE-Image-Editor": LocalImageEditor,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LEFT-EYE-Image-Editor": "LEFT-EYE-Image-Editor",
    "ComfyUI-LEFT-EYE-Image-Editor": "LEFT-EYE-Image-Editor",
}
