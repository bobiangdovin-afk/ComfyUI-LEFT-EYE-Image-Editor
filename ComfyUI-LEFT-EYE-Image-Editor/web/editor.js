import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const EXTENSION_NAME = "left-eye.LEFT-EYE-Image-Editor";
const NODE_NAMES = new Set(["LEFT-EYE-Image-Editor", "ComfyUI-LEFT-EYE-Image-Editor"]);
const MAX_HISTORY = 20;
const MAX_IMAGE_PIXELS = 8192 * 8192;
const MAX_RENDER_PIXELS = 2_500_000;
const MAX_HISTORY_BYTES = 512 * 1024 * 1024;
const sharedCanvases = new WeakSet();
const imagePreviews = new WeakMap();

// Keep original pixels for editing/export; reuse a small raster for fitted previews.
function previewSource(source, ctx) {
    if (!(source instanceof HTMLImageElement) || source.width * source.height <= MAX_RENDER_PIXELS) return source;
    const matrix = ctx.getTransform();
    const scale = Math.min(1, Math.sqrt(MAX_RENDER_PIXELS / (source.width * source.height)));
    if (Math.hypot(matrix.a, matrix.b) > scale || Math.hypot(matrix.c, matrix.d) > scale) return source;
    let preview = imagePreviews.get(source);
    if (!preview) {
        preview = makeCanvas(source.width * scale, source.height * scale);
        preview.getContext("2d").drawImage(source, 0, 0, preview.width, preview.height);
        imagePreviews.set(source, preview);
    }
    return preview;
}

function shareCanvas(source) {
    if (source instanceof HTMLCanvasElement) sharedCanvases.add(source);
    return source;
}

const styleUrl = new URL("./editor.css", import.meta.url).href;
if (!document.querySelector(`link[href="${styleUrl}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = styleUrl;
    document.head.appendChild(link);
}

function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function uid() {
    return `layer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Unable to decode image"));
        image.src = src;
    });
}

function assetSource(asset) {
    const params = new URLSearchParams({
        filename: asset.filename,
        type: asset.type || "input",
        subfolder: asset.subfolder || "",
    });
    return api.apiURL(`/view?${params.toString()}`);
}

async function uploadAsset(blob, filename) {
    const form = new FormData();
    form.append("image", blob, filename.replace(/[\\/:*?"<>|]/g, "_") || "image.png");
    form.append("type", "input");
    form.append("subfolder", "left-eye-image-editor");
    const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
    if (!response.ok) throw new Error(`本地图像写入失败 (${response.status})`);
    const uploaded = await response.json();
    const asset = {
        filename: uploaded.name,
        subfolder: uploaded.subfolder || "",
        type: uploaded.type || "input",
    };
    return { asset, src: assetSource(asset) };
}

async function embeddedImageBlob(src) {
    const response = await fetch(src);
    if (!response.ok) throw new Error("无法迁移旧版内嵌图像");
    return response.blob();
}

function makeCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
}

function cloneCanvas(source) {
    const canvas = makeCanvas(source.width, source.height);
    canvas.getContext("2d").drawImage(source, 0, 0);
    return canvas;
}

function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error("无法编码图像"));
                return;
            }
            resolve(blob);
        }, "image/png");
    });
}

function toolButton(icon, label, key) {
    const button = el("button", "lie-tool");
    button.type = "button";
    button.dataset.tool = key;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = `<span aria-hidden="true">${icon}</span><small>${label}</small>`;
    return button;
}

export class EditorModal {
    constructor(node, stateWidget, nodePreview) {
        this.node = node;
        this.stateWidget = stateWidget;
        this.nodePreview = nodePreview;
        this.project = null;
        this.selectedId = null;
        this.tool = "select";
        this.zoom = 1;
        this.brushSize = 28;
        this.brushOpacity = 1;
        this.brushColor = "#ff4d3d";
        this.maskSubtract = false;
        this.shapeFill = false;
        this.pointerAction = null;
        this.viewPan = { x: 0, y: 0 };
        this.cropRect = null;
        this.history = [];
        this.historyIndex = -1;
        this.restoring = false;
        this.persistTimer = null;
        this.previewLoadId = 0;
        this.projectLoadId = 0;
        this.layerRevision = 0;
        this.inlineBaseRevision = -1;
        this.inlineBase = null;
        this.savedState = stateWidget.value || "";
        this.isSaving = false;
    }

    async open(files = [], initialTool = "select") {
        if (this.overlay?.isConnected) return;
        this.showMaskPreview = false;
        this.setInlineMaskActive(false);
        if (!await this.loadProject()) return;
        this.buildUi();
        document.body.appendChild(this.overlay);
        this.bindEvents();
        this.setTool(initialTool);
        this.fitCanvas();
        this.resetHistory();
        if (files.length) await this.addFiles(files);
        this.renderAll();
    }

    async loadProject() {
        const loadId = ++this.projectLoadId;
        let saved = null;
        try {
            saved = this.stateWidget.value ? JSON.parse(this.stateWidget.value) : null;
        } catch (error) {
            console.warn("Local Image Editor: ignored invalid saved state", error);
        }

        const width = clamp(Number(saved?.width) || 1024, 1, 8192);
        const height = clamp(Number(saved?.height) || 1024, 1, 8192);
        const layers = [];
        for (const item of saved?.layers || []) {
            if (!item.src && !item.asset) continue;
            try {
                const asset = item.asset || null;
                const src = asset ? assetSource(asset) : item.src;
                layers.push({
                    id: item.id || uid(),
                    name: item.name || "Layer",
                    visible: item.visible !== false,
                    locked: item.locked === true,
                    opacity: clamp(item.opacity == null ? 1 : Number(item.opacity), 0, 1),
                    blendMode: item.blendMode || "source-over",
                    x: Number.isFinite(Number(item.x)) ? Number(item.x) : width / 2,
                    y: Number.isFinite(Number(item.y)) ? Number(item.y) : height / 2,
                    scaleX: Number(item.scaleX) || 1,
                    scaleY: Number(item.scaleY) || 1,
                    rotation: Number(item.rotation) || 0,
                    kind: item.kind || (/^Paint(?:\s|$)/i.test(item.name || "") ? "paint" : "image"),
                    maskInvert: item.maskInvert === true,
                    maskSourceId: item.maskSourceId || null,
                    canvas: await loadImage(src),
                    src,
                    asset,
                    dirty: false,
                });
            } catch (error) {
                console.warn("Local Image Editor: skipped unreadable layer", error);
            }
        }

        let maskBaseImage = null;
        const maskBaseAsset = saved?.maskAsset || null;
        const maskBaseSrc = maskBaseAsset ? assetSource(maskBaseAsset) : saved?.maskSrc || null;
        if (maskBaseSrc) {
            try {
                maskBaseImage = await loadImage(maskBaseSrc);
            } catch (error) {
                console.warn("Local Image Editor: ignored unreadable mask", error);
            }
        }

        const project = {
            version: 1,
            width,
            height,
            background: saved?.background || "#ffffff",
            layers,
            maskCanvas: null,
            maskBaseImage,
            maskBaseSrc,
            maskBaseAsset,
            maskStrokes: Array.isArray(saved?.maskStrokes) ? saved.maskStrokes : [],
            maskNeedsFlatten: false,
        };
        if (loadId !== this.projectLoadId) return false;
        this.project = project;
        this.selectedId = saved?.selectedId && layers.some((layer) => layer.id === saved.selectedId)
            ? saved.selectedId
            : layers[0]?.id || null;
        this.invalidateNodeBase();
        return true;
    }

    drawMask(target, displayWidth, displayHeight, color = "#ffffff", includeLayers = true) {
        const context = target.getContext("2d");
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, target.width, target.height);
        context.globalAlpha = 1;
        context.globalCompositeOperation = "source-over";
        const maskSource = this.project.maskCanvas || this.project.maskBaseImage;
        if (maskSource) {
            context.drawImage(maskSource, 0, 0, displayWidth, displayHeight);
            // Mask files are black/white with an opaque alpha channel. Use
            // luminance as alpha so black pixels do not tint the preview.
            const pixels = context.getImageData(0, 0, displayWidth, displayHeight);
            for (let index = 0; index < pixels.data.length; index += 4) {
                const luminance = Math.max(pixels.data[index], pixels.data[index + 1], pixels.data[index + 2]);
                pixels.data[index] = 255;
                pixels.data[index + 1] = 255;
                pixels.data[index + 2] = 255;
                pixels.data[index + 3] = Math.round(pixels.data[index + 3] * luminance / 255);
            }
            context.putImageData(pixels, 0, 0);
            context.globalCompositeOperation = "source-in";
            context.fillStyle = color;
            context.fillRect(0, 0, displayWidth, displayHeight);
            context.globalCompositeOperation = "source-over";
        }
        const scaleX = displayWidth / this.project.width;
        const scaleY = displayHeight / this.project.height;
        context.save();
        context.scale(scaleX, scaleY);
        for (const stroke of this.project.maskStrokes) {
            const points = Array.isArray(stroke.points) ? stroke.points : [];
            if (!points.length) continue;
            context.globalCompositeOperation = stroke.subtract ? "destination-out" : "source-over";
            context.globalAlpha = clamp(Number(stroke.opacity ?? 1), 0, 1);
            context.strokeStyle = color;
            context.fillStyle = color;
            context.lineWidth = Number(stroke.size) || 28;
            context.lineCap = "round";
            context.lineJoin = "round";
            context.beginPath();
            context.moveTo(points[0][0], points[0][1]);
            for (let index = 1; index < points.length; index += 1) context.lineTo(points[index][0], points[index][1]);
            context.stroke();
            const last = points[points.length - 1];
            context.beginPath();
            context.arc(last[0], last[1], (Number(stroke.size) || 28) / 2, 0, Math.PI * 2);
            context.fill();
        }
        context.restore();
        context.globalAlpha = 1;
        context.globalCompositeOperation = "source-over";
        if (includeLayers) this.drawMaskLayers(target, displayWidth, displayHeight, color);
    }

    drawMaskOnly(target, displayWidth, displayHeight) {
        this.drawMask(target, displayWidth, displayHeight, "#ffffff");
        const context = target.getContext("2d");
        context.globalCompositeOperation = "destination-over";
        context.fillStyle = "#000000";
        context.fillRect(0, 0, displayWidth, displayHeight);
        context.globalCompositeOperation = "source-over";
    }

    maskLayers() {
        return this.project.layers.filter((layer) => layer.kind === "mask" && layer.visible);
    }

    drawMaskLayers(target, width, height, color) {
        const layers = this.maskLayers();
        if (!layers.length) return;
        const ctx = target.getContext("2d");
        const positives = layers.filter((layer) => !layer.maskInvert);
        const negatives = layers.filter((layer) => layer.maskInvert);
        if (!positives.length && !this.project.maskCanvas && !this.project.maskBaseImage && !this.project.maskStrokes.length) {
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, width, height);
        }
        if (!this.maskLayerScratch || this.maskLayerScratch.width !== width || this.maskLayerScratch.height !== height) {
            this.maskLayerScratch = makeCanvas(width, height);
        }
        const scratch = this.maskLayerScratch;
        const sc = scratch.getContext("2d");
        for (const layer of [...positives, ...negatives]) {
            sc.clearRect(0, 0, width, height);
            sc.save();
            sc.scale(width / this.project.width, height / this.project.height);
            sc.translate(layer.x, layer.y);
            sc.rotate(layer.rotation * Math.PI / 180);
            sc.scale(layer.scaleX, layer.scaleY);
            sc.drawImage(previewSource(layer.canvas, sc), -layer.canvas.width / 2, -layer.canvas.height / 2, layer.canvas.width, layer.canvas.height);
            sc.restore();
            sc.globalCompositeOperation = "source-in";
            sc.fillStyle = color;
            sc.fillRect(0, 0, width, height);
            sc.globalCompositeOperation = "source-over";
            ctx.globalAlpha = layer.opacity;
            ctx.globalCompositeOperation = layer.maskInvert ? "destination-out" : "source-over";
            ctx.drawImage(scratch, 0, 0);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
    }

    buildUi() {
        this.overlay = el("div", "lie-overlay");
        this.overlay.innerHTML = `
                <section class="lie-window" role="dialog" aria-modal="true" aria-label="LEFT-EYE-Image-Editor">
                <header class="lie-header">
                    <button class="lie-command-button lie-back" type="button" title="返回 ComfyUI">&#8592; 返回</button>
                    <div class="lie-title"><strong>图片编辑</strong><span>本地 / 离线</span></div>
                    <div class="lie-history-controls"></div>
                    <div class="lie-document-info"></div>
                    <div class="lie-save-controls"></div>
                    <button class="lie-icon-button lie-close" type="button" title="关闭" aria-label="关闭">&#10005;</button>
                </header>
                <div class="lie-commandbar">
                    <div class="lie-file-controls"></div>
                    <div class="lie-context-controls"></div>
                    <div class="lie-zoom-controls"></div>
                </div>
                <div class="lie-body">
                    <aside class="lie-toolbar" aria-label="Tools"></aside>
                    <main class="lie-workspace"><div class="lie-canvas-stage"><canvas class="lie-canvas"></canvas></div></main>
                    <aside class="lie-sidebar">
                        <section class="lie-panel lie-inspector"></section>
                        <section class="lie-panel lie-layers-panel">
                            <div class="lie-panel-heading"><strong>图层</strong><span class="lie-layer-count"></span></div>
                            <div class="lie-layer-actions"></div>
                            <div class="lie-layer-list"></div>
                        </section>
                    </aside>
                </div>
                <footer class="lie-statusbar"><span class="lie-status"></span><span class="lie-status-mode">已同步</span></footer>
            </section>`;

        this.canvas = this.overlay.querySelector(".lie-canvas");
        this.workspace = this.overlay.querySelector(".lie-workspace");
        this.stage = this.overlay.querySelector(".lie-canvas-stage");
        this.layerList = this.overlay.querySelector(".lie-layer-list");
        this.inspector = this.overlay.querySelector(".lie-inspector");
        this.contextControls = this.overlay.querySelector(".lie-context-controls");
        this.status = this.overlay.querySelector(".lie-status");
        this.statusMode = this.overlay.querySelector(".lie-status-mode");
        this.documentInfo = this.overlay.querySelector(".lie-document-info");

        const fileControls = this.overlay.querySelector(".lie-file-controls");
        this.rectangleButton = this.commandButton("&#9633;", "矩形", "矩形工具");
        this.arrowButton = this.commandButton("&#8594;", "箭头", "箭头工具");
        this.fillButton = this.commandButton("&#9683;", "填充", "填充工具");
        fileControls.append(this.rectangleButton, this.arrowButton, this.fillButton);

        const history = this.overlay.querySelector(".lie-history-controls");
        this.undoButton = this.iconButton("&#8630;", "撤销 (Ctrl+Z)");
        this.redoButton = this.iconButton("&#8631;", "重做 (Ctrl+Y)");
        this.clearPaintButton = this.commandButton("&#10006;", "清除", "清除所有画笔痕迹");
        this.clearPaintButton.classList.add("lie-clear-command");
        history.append(this.undoButton, this.redoButton, this.clearPaintButton);

        const saveControls = this.overlay.querySelector(".lie-save-controls");
        this.resetButton = this.commandButton("&#8634;", "还原", "恢复到打开编辑器时的状态");
        this.saveButton = this.commandButton("&#10003;", "保存", "保存到工作流");
        this.saveButton.classList.add("lie-primary-command");
        saveControls.append(this.resetButton, this.saveButton);

        const zoomControls = this.overlay.querySelector(".lie-zoom-controls");
        this.zoomOutButton = this.iconButton("&#8722;", "Zoom out");
        this.zoomLabel = el("button", "lie-zoom-label", "100%");
        this.zoomLabel.type = "button";
        this.zoomLabel.title = "Fit canvas";
        this.zoomInButton = this.iconButton("＋", "Zoom in");
        zoomControls.append(this.zoomOutButton, this.zoomLabel, this.zoomInButton);

        const toolbar = this.overlay.querySelector(".lie-toolbar");
        toolbar.append(
            toolButton("＋", "添加素材", "material"),
            toolButton("&#8987;", "裁剪", "crop"),
            toolButton("&#10530;", "扩图", "expand"),
            toolButton("&#10021;", "移动", "select"),
            toolButton("&#9998;", "画笔", "brush"),
            toolButton("&#9641;", "橡皮", "eraser"),
        );

        const layerActions = this.overlay.querySelector(".lie-layer-actions");
        this.addLayerButton = this.iconButton("＋", "Add paint layer");
        this.duplicateButton = this.iconButton("&#10697;", "Duplicate selected layer");
        this.convertMaskButton = this.iconButton("◈", "转换为遮罩");
        this.maskPreviewButton = this.commandButton("◧", "MASK预览", "查看合并的黑白遮罩");
        this.maskPreviewButton.addEventListener("click", () => {
            this.showMaskPreview = !this.showMaskPreview;
            this.maskPreviewButton.classList.toggle("is-active", this.showMaskPreview);
            this.renderCanvas();
        });
        this.deleteButton = this.iconButton("&#128465;", "Delete selected layer");
        layerActions.append(this.addLayerButton, this.duplicateButton, this.convertMaskButton, this.deleteButton);
        layerActions.append(this.maskPreviewButton);

        this.fileInput = el("input");
        this.fileInput.type = "file";
        this.fileInput.accept = "image/png,image/jpeg,image/webp,image/bmp";
        this.fileInput.multiple = true;
        this.fileInput.hidden = true;
        this.overlay.appendChild(this.fileInput);
    }

    commandButton(icon, label, title) {
        const button = el("button", "lie-command-button");
        button.type = "button";
        button.title = title;
        button.innerHTML = `<span aria-hidden="true">${icon}</span>${label}`;
        return button;
    }

    iconButton(icon, title) {
        const button = el("button", "lie-icon-button");
        button.type = "button";
        button.title = title;
        button.setAttribute("aria-label", title);
        button.innerHTML = icon;
        return button;
    }

    bindEvents() {
        this.overlay.querySelector(".lie-close").addEventListener("click", () => this.close(false));
        this.overlay.querySelector(".lie-back").addEventListener("click", () => this.close(false));
        this.fileInput.addEventListener("change", async () => {
            await this.addFiles([...this.fileInput.files]);
            this.fileInput.value = "";
        });
        this.rectangleButton.addEventListener("click", () => this.setTool("rectangle"));
        this.arrowButton.addEventListener("click", () => this.setTool("arrow"));
        this.fillButton.addEventListener("click", () => this.setTool("fill"));
        this.undoButton.addEventListener("click", () => this.undo());
        this.redoButton.addEventListener("click", () => this.redo());
        this.clearPaintButton.addEventListener("click", () => this.clearPaintStrokes());
        this.resetButton.addEventListener("click", async () => {
            if (this.initialSnapshot) {
                this.historyIndex = 0;
                await this.restoreSnapshot(this.initialSnapshot);
                this.history = [this.memorySnapshot()];
                this.toast("Project restored");
            }
        });
        this.saveButton.addEventListener("click", async () => {
            if (this.isSaving) return;
            this.isSaving = true;
            this.saveButton.disabled = true;
            this.saveButton.lastChild.textContent = "保存中";
            try {
                await this.persistNow();
                this.close(false);
            } catch (error) {
                console.error("Local Image Editor: save failed", error);
                this.toast(`保存失败：${error.message}`, true);
            } finally {
                this.isSaving = false;
                this.saveButton.disabled = false;
                this.saveButton.lastChild.textContent = "保存";
            }
        });
        this.zoomOutButton.addEventListener("click", () => this.setZoom(this.zoom / 1.2));
        this.zoomInButton.addEventListener("click", () => this.setZoom(this.zoom * 1.2));
        this.zoomLabel.addEventListener("click", () => this.fitCanvas());
        this.addLayerButton.addEventListener("click", () => this.addPaintLayer());
        this.duplicateButton.addEventListener("click", () => this.duplicateSelected());
        this.deleteButton.addEventListener("click", () => this.deleteSelected());
        this.convertMaskButton.addEventListener("click", () => this.showMaskConversionMenu(this.convertMaskButton, this.selectedLayer()));

        for (const button of this.overlay.querySelectorAll(".lie-tool")) {
            button.addEventListener("click", () => {
                const action = button.dataset.tool;
                if (action === "material") this.fileInput.click();
                else if (action === "expand") this.showCanvasSizeDialog();
                else this.setTool(action);
            });
        }

        this.canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
        this.canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
        this.canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
        this.canvas.addEventListener("pointercancel", (event) => this.pointerUp(event));
        this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
        this.workspace.addEventListener("wheel", (event) => {
            event.preventDefault();
            this.setZoom(this.zoom * Math.exp(-event.deltaY * 0.0015));
        }, { passive: false });
        this.workspace.addEventListener("dragover", (event) => {
            if ([...event.dataTransfer.items].some((item) => item.type.startsWith("image/"))) {
                event.preventDefault();
                this.workspace.classList.add("is-dropping");
            }
        });
        this.workspace.addEventListener("dragleave", () => this.workspace.classList.remove("is-dropping"));
        this.workspace.addEventListener("drop", async (event) => {
            event.preventDefault();
            this.workspace.classList.remove("is-dropping");
            await this.addFiles([...event.dataTransfer.files].filter((file) => file.type.startsWith("image/")));
        });

        this.keyHandler = (event) => this.keyDown(event);
        window.addEventListener("keydown", this.keyHandler, true);
        this.setTool("select");
    }

    keyDown(event) {
        if (!this.overlay?.isConnected) return;
        const editingText = ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName);
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
            event.preventDefault();
            event.shiftKey ? this.redo() : this.undo();
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
            event.preventDefault();
            this.redo();
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            if (this.cropRect) {
                this.cropRect = null;
                this.renderAll();
            } else {
                this.close(false);
            }
            return;
        }
        if (editingText) return;
        const tools = { v: "select", b: "brush", e: "eraser", r: "rectangle", a: "arrow", f: "fill", c: "crop" };
        if (tools[event.key.toLowerCase()]) this.setTool(tools[event.key.toLowerCase()]);
        if ((event.key === "Delete" || event.key === "Backspace") && this.selectedId) this.deleteSelected();
        if (event.key === "Enter" && this.tool === "crop" && this.cropRect) this.applyCrop();
    }

    close(save = false) {
        if (save) this.persistNow();
        clearTimeout(this.persistTimer);
        window.removeEventListener("keydown", this.keyHandler, true);
        this.overlay.remove();
    }

    selectedLayer() {
        return this.project.layers.find((layer) => layer.id === this.selectedId) || null;
    }

    ensureEditableLayer(layer) {
        if (!layer || (layer.canvas instanceof HTMLCanvasElement && !sharedCanvases.has(layer.canvas))) return layer;
        layer.canvas = cloneCanvas(layer.canvas);
        layer.src = null;
        layer.asset = null;
        layer.dirty = true;
        return layer;
    }

    async addFiles(files) {
        const added = await this.importLayers(files);
        if (added) {
            this.commit();
            this.fitCanvas();
            this.toast(`${added} image${added === 1 ? "" : "s"} imported locally`);
        }
    }

    async importDirect(files) {
        this.setInlineMaskActive(false);
        const file = files.find((item) => item.type.startsWith("image/"));
        if (!file) return;
        this.projectLoadId += 1;
        const previousProject = this.project;
        const previousSelectedId = this.selectedId;
        this.project = { version: 2, width: 1024, height: 1024, background: "#ffffff", layers: [], maskCanvas: null, maskBaseImage: null, maskBaseSrc: null, maskBaseAsset: null, maskStrokes: [], maskNeedsFlatten: false };
        this.selectedId = null;
        const added = await this.importLayers([file]);
        if (added) {
            this.history = [];
            this.initialSnapshot = null;
            this.project.maskCanvas = null;
            this.project.maskBaseImage = null;
            this.project.maskBaseSrc = null;
            this.project.maskBaseAsset = null;
            this.project.maskStrokes = [];
            this.project.maskNeedsFlatten = false;
            this.invalidateNodeBase();
            await this.persistNow();
        } else {
            this.project = previousProject;
            this.selectedId = previousSelectedId;
        }
    }

    async toggleInlineMask() {
        const active = !this.nodePreview.wrap.classList.contains("is-mask-active");
        if (!active) {
            this.setInlineMaskActive(false);
            return;
        }
        if (!this.project || this.overlay?.isConnected) {
            if (!await this.loadProject()) return;
        }
        this.setInlineMaskActive(true);
        this.renderNodePreview();
    }

    setInlineMaskActive(active) {
        this.nodePreview.wrap.classList.toggle("is-mask-active", active);
        this.nodePreview.maskButton.classList.toggle("is-active", active);
        this.nodePreview.maskButton.setAttribute("aria-pressed", String(active));
    }

    inlineCanvasPoint(event) {
        const rect = this.nodePreview.canvas.getBoundingClientRect();
        return {
            x: clamp((event.clientX - rect.left) * this.project.width / rect.width, 0, this.project.width),
            y: clamp((event.clientY - rect.top) * this.project.height / rect.height, 0, this.project.height),
        };
    }

    inlineMaskDown(event) {
        if (event.button !== 0 || !this.project || !this.nodePreview.wrap.classList.contains("is-mask-active")) return;
        event.preventDefault();
        event.stopPropagation();
        const point = this.inlineCanvasPoint(event);
        const stroke = this.beginMaskStroke(point, event.altKey);
        this.inlineMaskAction = { last: point, subtract: event.altKey, stroke };
        this.nodePreview.canvas.setPointerCapture(event.pointerId);
        this.paintMask(point, point, event.altKey);
        this.renderInlineMaskPreview();
    }

    inlineMaskMove(event) {
        if (!this.inlineMaskAction) return;
        event.preventDefault();
        event.stopPropagation();
        const point = this.inlineCanvasPoint(event);
        this.paintMask(this.inlineMaskAction.last, point, event.altKey || this.inlineMaskAction.subtract);
        this.appendMaskStroke(this.inlineMaskAction.stroke, point);
        this.inlineMaskAction.last = point;
        this.renderInlineMaskPreview();
    }

    inlineMaskUp(event) {
        if (!this.inlineMaskAction) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.nodePreview.canvas.hasPointerCapture(event.pointerId)) {
            this.nodePreview.canvas.releasePointerCapture(event.pointerId);
        }
        this.inlineMaskAction = null;
        this.schedulePersist();
    }

    beginMaskStroke(point, subtract) {
        const stroke = {
            size: this.brushSize,
            opacity: this.brushOpacity,
            subtract: Boolean(subtract),
            points: [[Math.round(point.x * 10) / 10, Math.round(point.y * 10) / 10]],
        };
        this.project.maskStrokes.push(stroke);
        return stroke;
    }

    appendMaskStroke(stroke, point) {
        const previous = stroke.points[stroke.points.length - 1];
        if (!previous || Math.hypot(point.x - previous[0], point.y - previous[1]) >= 1) {
            stroke.points.push([Math.round(point.x * 10) / 10, Math.round(point.y * 10) / 10]);
        }
    }

    async rebuildMaskCanvas() {
        this.project.maskCanvas = null;
        if (this.project.maskBaseSrc && !this.project.maskBaseImage) {
            try {
                this.project.maskBaseImage = await loadImage(this.project.maskBaseSrc);
            } catch (error) {
                console.warn("Local Image Editor: unable to restore legacy mask", error);
            }
        }
    }

    async undoInlineMask() {
        if (!this.project || !this.project.maskStrokes.length) return;
        this.project.maskStrokes.pop();
        await this.rebuildMaskCanvas();
        this.renderInlineMaskPreview();
        this.schedulePersist();
    }

    async resetInlineMask() {
        if (!this.project) return;
        this.project.maskBaseSrc = null;
        this.project.maskBaseImage = null;
        this.project.maskBaseAsset = null;
        this.project.maskStrokes = [];
        this.project.maskCanvas = null;
        this.project.maskNeedsFlatten = false;
        this.project.layers = this.project.layers.filter((layer) => layer.kind !== "mask");
        this.selectedId = this.project.layers[0]?.id || null;
        this.invalidateNodeBase();
        this.renderInlineMaskPreview();
        this.schedulePersist();
    }

    async importLayers(files) {
        const validFiles = files.filter((file) => file.type.startsWith("image/"));
        if (!validFiles.length) return 0;
        let added = 0;
        for (const file of validFiles) {
            try {
                const { asset, src } = await uploadAsset(file, file.name);
                const image = await loadImage(src);
                if (image.naturalWidth > 8192 || image.naturalHeight > 8192 || image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS) {
                    throw new Error(`图像为 ${image.naturalWidth} × ${image.naturalHeight}，支持最大 8192 × 8192（8K）`);
                }
                if (!this.project.layers.length && added === 0) {
                    this.resizeProject(image.naturalWidth, image.naturalHeight, "center", false);
                }
                const layer = {
                    id: uid(),
                    name: file.name.replace(/\.[^.]+$/, "") || "Image",
                    visible: true,
                    locked: false,
                    opacity: 1,
                    blendMode: "source-over",
                    x: this.project.width / 2,
                    y: this.project.height / 2,
                    scaleX: 1,
                    scaleY: 1,
                    rotation: 0,
                    kind: "image",
                    canvas: image,
                    src,
                    asset,
                    dirty: false,
                };
                this.project.layers.unshift(layer);
                this.selectedId = layer.id;
                added += 1;
            } catch (error) {
                if (this.overlay?.isConnected) this.toast(`${file.name}: ${error.message}`, true);
                else this.nodePreview.size.textContent = `上传失败：${error.message}`;
            }
        }
        return added;
    }

    addPaintLayer(shouldCommit = true) {
        const layer = {
            id: uid(),
            name: `Paint ${this.project.layers.length + 1}`,
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: "source-over",
            x: this.project.width / 2,
            y: this.project.height / 2,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
            kind: "paint",
            canvas: makeCanvas(this.project.width, this.project.height),
            src: null,
            asset: null,
            dirty: true,
        };
        this.project.layers.unshift(layer);
        this.selectedId = layer.id;
        if (shouldCommit) this.commit();
        return layer;
    }

    clearPaintStrokes() {
        const paintLayers = this.project.layers.filter((layer) => layer.kind === "paint" || /^Paint(?:\s|$)/i.test(layer.name));
        if (!paintLayers.length) {
            this.toast("没有可清除的画笔痕迹");
            return;
        }
        this.project.layers = this.project.layers.filter((layer) => !paintLayers.includes(layer));
        if (!this.project.layers.some((layer) => layer.id === this.selectedId)) {
            this.selectedId = this.project.layers[0]?.id || null;
        }
        this.commit();
        this.toast("已清除所有画笔痕迹");
    }

    showMaskConversionMenu(anchor, layer) {
        this.maskMenu?.remove();
        if (!layer) {
            this.toast("请先选择一个图层", true);
            return;
        }
        const menu = el("div", "lie-mask-menu");
        menu.innerHTML = "<strong>转换为遮罩</strong>";
        const positive = el("button", "lie-mask-choice", "正向遮罩");
        const negative = el("button", "lie-mask-choice", "反向遮罩");
        menu.append(positive, negative);
        const rect = anchor.getBoundingClientRect();
        menu.style.left = `${Math.max(8, rect.left - 146)}px`;
        menu.style.top = `${rect.bottom + 6}px`;
        this.overlay.appendChild(menu);
        this.maskMenu = menu;
        positive.addEventListener("click", () => {
            this.convertLayerToMask(layer, false);
            menu.remove();
            this.maskMenu = null;
        });
        negative.addEventListener("click", () => {
            this.convertLayerToMask(layer, true);
            menu.remove();
            this.maskMenu = null;
        });
    }

    convertLayerToMask(layer, invert) {
        if (!layer || layer.locked) {
            this.toast("请先选择并解锁图层", true);
            return;
        }
        let maskLayer = layer.kind === "mask" ? layer : this.project.layers.find((item) => item.kind === "mask" && item.maskSourceId === layer.id);
        if (!maskLayer) {
            maskLayer = {
                ...layer, id: uid(), name: `MASK · ${layer.name}`, kind: "mask",
                maskSourceId: layer.id, visible: true, locked: false,
                canvas: shareCanvas(layer.canvas),
            };
            this.project.layers.splice(this.project.layers.indexOf(layer), 0, maskLayer);
        }
        maskLayer.maskInvert = Boolean(invert);
        this.selectedId = maskLayer.id;
        this.commit();
        this.toast(invert ? "已生成反向遮罩" : "已生成正向遮罩");
    }

    duplicateSelected() {
        const source = this.selectedLayer();
        if (!source) return;
        const copy = { ...source, id: uid(), name: `${source.name} copy`, x: source.x + 20, y: source.y + 20, canvas: shareCanvas(source.canvas) };
        this.project.layers.splice(this.project.layers.indexOf(source), 0, copy);
        this.selectedId = copy.id;
        this.commit();
    }

    deleteSelected() {
        if (this.selectedLayer()?.locked) return;
        const index = this.project.layers.findIndex((layer) => layer.id === this.selectedId);
        if (index < 0) return;
        this.project.layers.splice(index, 1);
        this.selectedId = this.project.layers[Math.min(index, this.project.layers.length - 1)]?.id || null;
        this.commit();
    }

    setTool(tool) {
        this.tool = tool;
        this.pointerAction = null;
        if (tool !== "crop") this.cropRect = null;
        for (const button of this.overlay.querySelectorAll(".lie-tool")) {
            button.classList.toggle("is-active", button.dataset.tool === tool);
        }
        this.rectangleButton?.classList.toggle("is-active", tool === "rectangle");
        this.arrowButton?.classList.toggle("is-active", tool === "arrow");
        this.fillButton?.classList.toggle("is-active", tool === "fill");
        this.canvas.dataset.tool = tool;
        this.renderContextControls();
        this.renderAll();
    }

    renderContextControls() {
        this.contextControls.replaceChildren();
        if (["brush", "eraser", "mask", "rectangle", "arrow"].includes(this.tool)) {
            const size = this.rangeControl("大小", 1, 300, this.brushSize, 1, (value) => {
                this.brushSize = Number(value);
            });
            const opacity = this.rangeControl("透明度", 0.05, 1, this.brushOpacity, 0.05, (value) => {
                this.brushOpacity = Number(value);
            });
            this.contextControls.append(size, opacity);
        }
        if (["brush", "rectangle", "arrow", "fill"].includes(this.tool)) {
            const color = el("label", "lie-color-control");
            color.innerHTML = `<span>颜色</span><input type="color" value="${this.brushColor}">`;
            color.querySelector("input").addEventListener("input", (event) => this.brushColor = event.target.value);
            this.contextControls.appendChild(color);
            const palette = el("div", "lie-palette");
            for (const swatch of ["#ffffff", "#ffb52e", "#ff4d3d", "#37c978", "#2cc9ff", "#5c7cff", "#a85cff", "#111111"]) {
                const button = el("button", "lie-swatch");
                button.type = "button";
                button.title = swatch;
                button.style.background = swatch;
                button.addEventListener("click", () => {
                    this.brushColor = swatch;
                    color.querySelector("input").value = swatch;
                });
                palette.appendChild(button);
            }
            this.contextControls.appendChild(palette);
        }
        if (this.tool === "rectangle") {
            const toggle = el("label", "lie-toggle");
            toggle.innerHTML = `<input type="checkbox" ${this.shapeFill ? "checked" : ""}><span>填充</span>`;
            toggle.querySelector("input").addEventListener("change", (event) => this.shapeFill = event.target.checked);
            this.contextControls.appendChild(toggle);
        }
        if (this.tool === "mask") {
            const toggle = el("label", "lie-toggle");
            toggle.innerHTML = `<input type="checkbox" ${this.maskSubtract ? "checked" : ""}><span>减去</span>`;
            toggle.querySelector("input").addEventListener("change", (event) => this.maskSubtract = event.target.checked);
            this.contextControls.appendChild(toggle);
        }
        if (this.tool === "crop") {
            const apply = this.commandButton("&#10003;", "Apply Crop", "Crop to the drawn rectangle");
            apply.disabled = !this.cropRect;
            apply.addEventListener("click", () => this.applyCrop());
            const cancel = this.commandButton("&#10005;", "Cancel", "Clear crop rectangle");
            cancel.addEventListener("click", () => {
                this.cropRect = null;
                this.renderAll();
                this.renderContextControls();
            });
            this.contextControls.append(apply, cancel);
        }
    }

    rangeControl(label, min, max, value, step, callback) {
        const control = el("label", "lie-range-control");
        control.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}"><output>${Math.round(value * (max === 1 ? 100 : 1))}${max === 1 ? "%" : ""}</output>`;
        const input = control.querySelector("input");
        input.addEventListener("input", () => {
            callback(input.value);
            control.querySelector("output").textContent = max === 1 ? `${Math.round(input.value * 100)}%` : input.value;
        });
        return control;
    }

    setZoom(zoom) {
        this.zoom = clamp(zoom, 0.05, 8);
        this.applyCanvasSize();
    }

    fitCanvas() {
        const rect = this.workspace.getBoundingClientRect();
        const availableWidth = Math.max(100, rect.width - 96);
        const availableHeight = Math.max(100, rect.height - 96);
        this.zoom = clamp(Math.min(availableWidth / this.project.width, availableHeight / this.project.height, 1), 0.05, 1);
        this.applyCanvasSize();
    }

    applyCanvasSize() {
        const displayWidth = Math.max(1, Math.round(this.project.width * this.zoom));
        const displayHeight = Math.max(1, Math.round(this.project.height * this.zoom));
        const backingScale = Math.min(1, Math.sqrt(MAX_RENDER_PIXELS / (displayWidth * displayHeight)));
        const backingWidth = Math.max(1, Math.round(displayWidth * backingScale));
        const backingHeight = Math.max(1, Math.round(displayHeight * backingScale));
        if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
        if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;
        this.canvas.style.width = `${displayWidth}px`;
        this.canvas.style.height = `${displayHeight}px`;
        this.stage.style.width = this.canvas.style.width;
        this.stage.style.height = this.canvas.style.height;
        this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
        this.renderCanvas();
    }

    renderAll() {
        this.applyCanvasSize();
        this.renderLayersPanel();
        this.renderInspector();
        this.documentInfo.textContent = `${this.project.width} × ${this.project.height}px`;
        this.status.textContent = `${this.project.layers.length} layer${this.project.layers.length === 1 ? "" : "s"} · ${this.tool}`;
        this.undoButton.disabled = this.historyIndex <= 0;
        this.redoButton.disabled = this.historyIndex >= this.history.length - 1;
        const hasPaint = this.project.layers.some((layer) => layer.kind === "paint" || /^Paint(?:\s|$)/i.test(layer.name));
        this.clearPaintButton.disabled = !hasPaint;
        this.convertMaskButton.disabled = !this.selectedLayer() || this.selectedLayer().locked;
        this.deleteButton.disabled = !this.selectedLayer() || this.selectedLayer().locked;
    }

    renderCanvas() {
        const ctx = this.canvas.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (this.showMaskPreview) {
            this.drawMaskOnly(this.canvas, this.canvas.width, this.canvas.height);
            return;
        }
        const scaleX = this.canvas.width / this.project.width;
        const scaleY = this.canvas.height / this.project.height;
        ctx.save();
        ctx.scale(scaleX, scaleY);
        this.drawLayers(ctx);
        ctx.restore();

        this.drawMaskOverlay(this.canvas, false);

        ctx.save();
        ctx.scale(scaleX, scaleY);
        if (this.tool === "select") this.drawTransformBox(ctx);
        if (this.cropRect) this.drawCropOverlay(ctx);
        ctx.restore();
    }

    drawLayers(ctx) {
        const maskSources = new Set(this.project.layers.filter((layer) => layer.kind === "mask").map((layer) => layer.maskSourceId));
        for (const layer of [...this.project.layers].reverse()) {
            if (!layer.visible || layer.kind === "mask" || (layer.kind === "paint" && maskSources.has(layer.id))) continue;
            ctx.save();
            ctx.globalAlpha = layer.opacity;
            ctx.globalCompositeOperation = layer.blendMode;
            ctx.translate(layer.x, layer.y);
            ctx.rotate(layer.rotation * Math.PI / 180);
            ctx.scale(layer.scaleX, layer.scaleY);
            ctx.drawImage(previewSource(layer.canvas, ctx), -layer.canvas.width / 2, -layer.canvas.height / 2, layer.canvas.width, layer.canvas.height);
            ctx.restore();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
    }

    drawMaskOverlay(target, inline) {
        const ctx = target.getContext("2d");
        if (!this.previewMask || this.previewMask.width !== target.width || this.previewMask.height !== target.height) {
            this.previewMask = makeCanvas(target.width, target.height);
        }
        this.drawMask(this.previewMask, target.width, target.height, inline && !this.maskLayers().length ? "#ff4d3d" : "#ffffff");
        ctx.save();
        ctx.globalAlpha = inline && !this.maskLayers().length ? 0.84 : 0.65;
        ctx.drawImage(this.previewMask, 0, 0);
        ctx.restore();
    }

    layerCorners(layer) {
        const halfWidth = layer.canvas.width * layer.scaleX / 2;
        const halfHeight = layer.canvas.height * layer.scaleY / 2;
        const angle = layer.rotation * Math.PI / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return [
            [-halfWidth, -halfHeight], [halfWidth, -halfHeight],
            [halfWidth, halfHeight], [-halfWidth, halfHeight],
        ].map(([x, y]) => ({ x: layer.x + x * cos - y * sin, y: layer.y + x * sin + y * cos }));
    }

    drawTransformBox(ctx) {
        const layer = this.selectedLayer();
        if (!layer || !layer.visible) return;
        const points = this.layerCorners(layer);
        ctx.save();
        ctx.strokeStyle = "#2cc9ff";
        ctx.fillStyle = "#ffffff";
        ctx.lineWidth = Math.max(1, 1.5 / this.zoom);
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
        ctx.closePath();
        ctx.stroke();
        const radius = clamp(6 / this.zoom, 4, 18);
        for (const point of points) {
            ctx.beginPath();
            ctx.rect(point.x - radius, point.y - radius, radius * 2, radius * 2);
            ctx.fill();
            ctx.stroke();
        }
        const top = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        const center = { x: layer.x, y: layer.y };
        const dx = top.x - center.x;
        const dy = top.y - center.y;
        const distance = Math.hypot(dx, dy) || 1;
        const rotate = { x: top.x + dx / distance * 30 / this.zoom, y: top.y + dy / distance * 30 / this.zoom };
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(rotate.x, rotate.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(rotate.x, rotate.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    drawCropOverlay(ctx) {
        const rect = this.normalizedCrop();
        if (!rect) return;
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,.52)";
        ctx.beginPath();
        ctx.rect(0, 0, this.project.width, this.project.height);
        ctx.rect(rect.x, rect.y, rect.width, rect.height);
        ctx.fill("evenodd");
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = Math.max(1, 1.5 / this.zoom);
        ctx.setLineDash([8 / this.zoom, 6 / this.zoom]);
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        ctx.restore();
    }

    renderLayersPanel() {
        this.layerList.replaceChildren();
        this.overlay.querySelector(".lie-layer-count").textContent = this.project.layers.length;
        for (const [index, layer] of this.project.layers.entries()) {
            const row = el("div", `lie-layer-row${layer.id === this.selectedId ? " is-selected" : ""}`);
            row.dataset.id = layer.id;
            row.draggable = !layer.locked;
            row.addEventListener("dragstart", (event) => {
                event.dataTransfer.setData("application/x-left-eye-layer", layer.id);
            });
            row.addEventListener("dragover", (event) => {
                if ([...event.dataTransfer.types].includes("application/x-left-eye-layer")) event.preventDefault();
            });
            row.addEventListener("drop", (event) => {
                const sourceId = event.dataTransfer.getData("application/x-left-eye-layer");
                const from = this.project.layers.findIndex((item) => item.id === sourceId);
                if (from < 0 || from === index || this.project.layers[from].locked) return;
                event.preventDefault();
                event.stopPropagation();
                this.project.layers.splice(index, 0, this.project.layers.splice(from, 1)[0]);
                this.commit();
            });
            const visibility = this.iconButton(layer.visible ? "&#9673;" : "&#9675;", layer.visible ? "Hide layer" : "Show layer");
            const thumbnail = el("canvas", "lie-layer-thumb");
            thumbnail.width = 52;
            thumbnail.height = 40;
            if (layer.kind === "mask") {
                this.drawMaskThumbnail(thumbnail, layer);
            } else {
                this.drawThumbnail(thumbnail, layer.canvas);
            }
            const name = el("input", "lie-layer-name");
            name.value = layer.name;
            name.title = "Rename layer";
            const lock = this.iconButton(layer.locked ? "&#128274;" : "&#128275;", layer.locked ? "Unlock layer" : "Lock layer");
            const up = this.iconButton("&#8593;", "Move layer up");
            const down = this.iconButton("&#8595;", "Move layer down");
            up.disabled = layer.locked || index === 0;
            down.disabled = layer.locked || index === this.project.layers.length - 1;
            const details = el("div", "lie-layer-details");
            details.append(name, el("small", "lie-layer-kind", layer.kind === "mask" ? (layer.maskInvert ? "反向遮罩 · 扣除" : "正向遮罩 · 添加") : layer.kind === "paint" ? "画笔" : "素材"));
            const convert = this.iconButton("◈", "转换此图层为遮罩");
            convert.disabled = layer.locked;
            convert.addEventListener("click", () => this.showMaskConversionMenu(convert, layer));
            const remove = this.iconButton("×", "删除此图层");
            remove.disabled = layer.locked;
            remove.addEventListener("click", () => { this.selectedId = layer.id; this.deleteSelected(); });
            row.append(visibility, thumbnail, details, lock, convert, remove, up, down);
            row.addEventListener("pointerdown", (event) => {
                if (!event.target.closest("button,input")) {
                    this.selectedId = layer.id;
                    this.renderAll();
                }
            });
            thumbnail.addEventListener("click", () => {
                this.selectedId = layer.id;
                this.renderAll();
            });
            visibility.addEventListener("click", () => {
                layer.visible = !layer.visible;
                this.commit();
            });
            lock.addEventListener("click", () => {
                layer.locked = !layer.locked;
                this.commit();
            });
            name.disabled = layer.locked;
            name.addEventListener("change", () => {
                layer.name = name.value.trim() || "Layer";
                this.commit();
            });
            up.addEventListener("click", () => {
                this.project.layers.splice(index - 1, 0, this.project.layers.splice(index, 1)[0]);
                this.commit();
            });
            down.addEventListener("click", () => {
                this.project.layers.splice(index + 1, 0, this.project.layers.splice(index, 1)[0]);
                this.commit();
            });
            this.layerList.appendChild(row);
        }
        if (!this.project.layers.length) {
            const empty = el("div", "lie-empty-layers", "暂无图层");
            this.layerList.appendChild(empty);
        }
        const selected = this.selectedLayer();
        if (selected) {
            const opacity = this.rangeControl("透明度", 0, 1, selected.opacity, 0.01, (value) => {
                selected.opacity = Number(value);
                this.renderCanvas();
            });
            opacity.querySelector("input").disabled = selected.locked;
            opacity.querySelector("input").addEventListener("change", () => this.commit());
            this.layerList.appendChild(opacity);
        }
    }

    drawThumbnail(target, source) {
        const ctx = target.getContext("2d");
        ctx.clearRect(0, 0, target.width, target.height);
        const scale = Math.min(target.width / source.width, target.height / source.height);
        const width = source.width * scale;
        const height = source.height * scale;
        ctx.drawImage(source, (target.width - width) / 2, (target.height - height) / 2, width, height);
    }

    drawMaskThumbnail(target, layer) {
        this.drawThumbnail(target, layer.canvas);
        const ctx = target.getContext("2d");
        ctx.globalCompositeOperation = "source-in";
        ctx.fillStyle = layer.maskInvert ? "#000000" : "#ffffff";
        ctx.fillRect(0, 0, target.width, target.height);
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = layer.maskInvert ? "#ffffff" : "#000000";
        ctx.fillRect(0, 0, target.width, target.height);
        ctx.globalCompositeOperation = "source-over";
    }

    renderInspector() {
        this.inspector.replaceChildren();
        const heading = el("div", "lie-panel-heading");
        heading.innerHTML = "<strong>变换</strong>";
        this.inspector.appendChild(heading);
        const layer = this.selectedLayer();
        if (!layer) {
            this.inspector.appendChild(el("div", "lie-empty-inspector", "未选择图层"));
            return;
        }
        const grid = el("div", "lie-property-grid");
        grid.append(
            this.numberControl("X", layer.x, (value) => layer.x = value),
            this.numberControl("Y", layer.y, (value) => layer.y = value),
            this.numberControl("Scale X", layer.scaleX, (value) => layer.scaleX = Math.max(0.01, value), 0.01),
            this.numberControl("Scale Y", layer.scaleY, (value) => layer.scaleY = Math.max(0.01, value), 0.01),
            this.numberControl("Rotate", layer.rotation, (value) => layer.rotation = value, 0.1),
        );
        this.inspector.appendChild(grid);

        const opacity = this.rangeControl("图层透明度", 0, 1, layer.opacity, 0.01, (value) => {
            layer.opacity = Number(value);
            this.renderCanvas();
        });
        opacity.querySelector("input").addEventListener("change", () => this.commit());
        const blend = el("label", "lie-select-control");
        blend.innerHTML = `<span>混合模式</span><select>
            <option value="source-over">正常</option><option value="multiply">正片叠底</option>
            <option value="screen">滤色</option><option value="overlay">叠加</option>
            <option value="darken">变暗</option><option value="lighten">变亮</option>
        </select>`;
        blend.querySelector("select").value = layer.blendMode;
        blend.querySelector("select").addEventListener("change", (event) => {
            layer.blendMode = event.target.value;
            this.commit();
        });
        this.inspector.append(opacity, blend);
        if (layer.kind === "mask") {
            const choices = el("div", "lie-layer-actions");
            for (const [label, invert] of [["正向遮罩", false], ["反向遮罩", true]]) {
                const button = el("button", "lie-mask-choice", label);
                button.disabled = layer.locked;
                button.addEventListener("click", () => this.convertLayerToMask(layer, invert));
                choices.appendChild(button);
            }
            this.inspector.appendChild(choices);
        }
        for (const input of this.inspector.querySelectorAll("input,select")) input.disabled = layer.locked;
    }

    numberControl(label, value, setter, step = 1) {
        const control = el("label", "lie-number-control");
        control.innerHTML = `<span>${label}</span><input type="number" step="${step}" value="${Number(value.toFixed(2))}">`;
        const input = control.querySelector("input");
        input.addEventListener("change", () => {
            const parsed = Number(input.value);
            if (Number.isFinite(parsed)) {
                setter(parsed);
                this.commit();
            }
        });
        return control;
    }

    canvasPoint(event) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) * this.project.width / rect.width,
            y: (event.clientY - rect.top) * this.project.height / rect.height,
        };
    }

    localPoint(layer, point) {
        const angle = -layer.rotation * Math.PI / 180;
        const dx = point.x - layer.x;
        const dy = point.y - layer.y;
        return {
            x: (dx * Math.cos(angle) - dy * Math.sin(angle)) / layer.scaleX + layer.canvas.width / 2,
            y: (dx * Math.sin(angle) + dy * Math.cos(angle)) / layer.scaleY + layer.canvas.height / 2,
        };
    }

    hitLayer(point) {
        for (const layer of this.project.layers) {
            if (!layer.visible) continue;
            const local = this.localPoint(layer, point);
            if (local.x < 0 || local.y < 0 || local.x >= layer.canvas.width || local.y >= layer.canvas.height) continue;
            if (layer.canvas instanceof HTMLImageElement) return layer;
            try {
                if (layer.canvas.getContext("2d").getImageData(Math.floor(local.x), Math.floor(local.y), 1, 1).data[3] > 2) return layer;
            } catch (error) {
                return layer;
            }
        }
        return null;
    }

    transformHandle(point, layer) {
        const threshold = 13 / this.zoom;
        const corners = this.layerCorners(layer);
        for (const corner of corners) {
            if (Math.hypot(point.x - corner.x, point.y - corner.y) <= threshold) return "scale";
        }
        const top = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
        const dx = top.x - layer.x;
        const dy = top.y - layer.y;
        const distance = Math.hypot(dx, dy) || 1;
        const rotate = { x: top.x + dx / distance * 30 / this.zoom, y: top.y + dy / distance * 30 / this.zoom };
        return Math.hypot(point.x - rotate.x, point.y - rotate.y) <= threshold ? "rotate" : null;
    }

    pointerDown(event) {
        if (event.button === 1) {
            event.preventDefault();
            this.pointerAction = {
                type: "pan",
                clientX: event.clientX,
                clientY: event.clientY,
                scrollLeft: this.workspace.scrollLeft,
                scrollTop: this.workspace.scrollTop,
            };
            this.canvas.setPointerCapture(event.pointerId);
            this.workspace.classList.add("is-panning");
            return;
        }
        if (event.button !== 0) return;
        if (this.showMaskPreview) return;
        const point = this.canvasPoint(event);
        this.canvas.setPointerCapture(event.pointerId);
        if (this.tool === "select") {
            let layer = this.selectedLayer();
            const handle = layer && !layer.locked ? this.transformHandle(point, layer) : null;
            if (!handle) {
                const hit = this.hitLayer(point);
                if (hit) {
                    this.selectedId = hit.id;
                    layer = hit;
                }
            }
            if (!layer || layer.locked || (!handle && !this.hitLayer(point))) {
                this.selectedId = layer?.id || null;
                this.renderAll();
                return;
            }
            const distance = Math.max(1, Math.hypot(point.x - layer.x, point.y - layer.y));
            this.pointerAction = {
                type: handle || "move", start: point,
                x: layer.x, y: layer.y, scaleX: layer.scaleX, scaleY: layer.scaleY,
                distance, angle: Math.atan2(point.y - layer.y, point.x - layer.x), rotation: layer.rotation,
            };
        } else if (["brush", "eraser"].includes(this.tool)) {
            let layer = this.selectedLayer();
            if (this.tool === "brush" && layer?.kind !== "mask" && layer?.src && !layer.dirty) {
                layer = this.addPaintLayer(false);
            }
            if (!layer || layer.locked) {
                this.toast(layer?.locked ? "Unlock the selected layer to paint" : "Add or select a layer first", true);
                return;
            }
            this.ensureEditableLayer(layer);
            const local = this.localPoint(layer, point);
            this.pointerAction = { type: "paint", last: local };
            this.paintLayer(layer, local, local);
        } else if (this.tool === "mask") {
            const subtract = event.altKey || this.maskSubtract;
            this.pointerAction = { type: "mask", last: point, stroke: this.beginMaskStroke(point, subtract) };
            this.paintMask(point, point, subtract);
        } else if (["rectangle", "arrow"].includes(this.tool)) {
            const layer = this.selectedLayer();
            if (!layer || layer.locked) {
                this.toast(layer?.locked ? "Unlock the selected layer to draw" : "Add or select a layer first", true);
                return;
            }
            this.ensureEditableLayer(layer);
            const local = this.localPoint(layer, point);
            const base = makeCanvas(layer.canvas.width, layer.canvas.height);
            base.getContext("2d").drawImage(layer.canvas, 0, 0);
            this.pointerAction = { type: "shape", start: local, last: local, base };
            this.drawShape(layer, this.pointerAction);
        } else if (this.tool === "fill") {
            const layer = this.selectedLayer();
            if (!layer || layer.locked) {
                this.toast(layer?.locked ? "Unlock the selected layer to fill" : "Add or select a layer first", true);
                return;
            }
            this.ensureEditableLayer(layer);
            const local = this.localPoint(layer, point);
            if (this.floodFill(layer.canvas, Math.floor(local.x), Math.floor(local.y))) this.commit();
        } else if (this.tool === "crop") {
            this.cropRect = { x0: point.x, y0: point.y, x1: point.x, y1: point.y };
            this.pointerAction = { type: "crop" };
            this.renderContextControls();
        }
        this.renderCanvas();
    }

    pointerMove(event) {
        if (!this.pointerAction) return;
        if (this.pointerAction.type === "pan") {
            const action = this.pointerAction;
            this.workspace.scrollLeft = action.scrollLeft - (event.clientX - action.clientX);
            this.workspace.scrollTop = action.scrollTop - (event.clientY - action.clientY);
            return;
        }
        const point = this.canvasPoint(event);
        const action = this.pointerAction;
        const layer = this.selectedLayer();
        if (action.type === "move" && layer) {
            layer.x = action.x + point.x - action.start.x;
            layer.y = action.y + point.y - action.start.y;
        } else if (action.type === "scale" && layer) {
            const factor = Math.max(0.01, Math.hypot(point.x - layer.x, point.y - layer.y) / action.distance);
            layer.scaleX = Math.max(0.01, action.scaleX * factor);
            layer.scaleY = Math.max(0.01, action.scaleY * factor);
        } else if (action.type === "rotate" && layer) {
            const angle = Math.atan2(point.y - layer.y, point.x - layer.x);
            layer.rotation = action.rotation + (angle - action.angle) * 180 / Math.PI;
        } else if (action.type === "paint" && layer) {
            const local = this.localPoint(layer, point);
            this.paintLayer(layer, action.last, local);
            action.last = local;
        } else if (action.type === "mask") {
            this.paintMask(action.last, point, event.altKey || this.maskSubtract);
            this.appendMaskStroke(action.stroke, point);
            action.last = point;
        } else if (action.type === "shape" && layer) {
            action.last = this.localPoint(layer, point);
            this.drawShape(layer, action);
        } else if (action.type === "crop") {
            this.cropRect.x1 = clamp(point.x, 0, this.project.width);
            this.cropRect.y1 = clamp(point.y, 0, this.project.height);
            this.renderContextControls();
        }
        this.renderCanvas();
    }

    pointerUp(event) {
        if (!this.pointerAction) return;
        if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
        if (this.pointerAction.type === "pan") {
            this.pointerAction = null;
            this.workspace.classList.remove("is-panning");
            return;
        }
        const changed = this.pointerAction.type !== "crop";
        this.pointerAction = null;
        if (changed) this.commit();
        else this.renderAll();
    }

    stroke(ctx, from, to, size, color, opacity, composite) {
        ctx.save();
        ctx.globalCompositeOperation = composite;
        ctx.globalAlpha = opacity;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = size;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    paintLayer(layer, from, to) {
        this.ensureEditableLayer(layer);
        layer.dirty = true;
        const scale = Math.max(0.01, (Math.abs(layer.scaleX) + Math.abs(layer.scaleY)) / 2);
        this.stroke(
            layer.canvas.getContext("2d"), from, to, this.brushSize / scale,
            this.brushColor, this.brushOpacity,
            this.tool === "eraser" ? "destination-out" : "source-over",
        );
    }

    paintMask(from, to, subtract) {
        // Mask painting is stored as lightweight vector strokes and rendered at display size.
    }

    drawShape(layer, action) {
        layer.dirty = true;
        const context = layer.canvas.getContext("2d");
        context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        context.drawImage(action.base, 0, 0);
        context.save();
        context.globalAlpha = this.brushOpacity;
        context.strokeStyle = this.brushColor;
        context.fillStyle = this.brushColor;
        context.lineWidth = Math.max(1, this.brushSize / Math.max(0.01, (Math.abs(layer.scaleX) + Math.abs(layer.scaleY)) / 2));
        context.lineCap = "round";
        context.lineJoin = "round";
        const x = Math.min(action.start.x, action.last.x);
        const y = Math.min(action.start.y, action.last.y);
        const width = Math.abs(action.last.x - action.start.x);
        const height = Math.abs(action.last.y - action.start.y);
        if (this.tool === "rectangle") {
            this.shapeFill ? context.fillRect(x, y, width, height) : context.strokeRect(x, y, width, height);
        } else {
            const dx = action.last.x - action.start.x;
            const dy = action.last.y - action.start.y;
            const angle = Math.atan2(dy, dx);
            const head = Math.max(context.lineWidth * 2.5, 14);
            context.beginPath();
            context.moveTo(action.start.x, action.start.y);
            context.lineTo(action.last.x, action.last.y);
            context.stroke();
            context.beginPath();
            context.moveTo(action.last.x, action.last.y);
            context.lineTo(action.last.x - head * Math.cos(angle - Math.PI / 6), action.last.y - head * Math.sin(angle - Math.PI / 6));
            context.lineTo(action.last.x - head * Math.cos(angle + Math.PI / 6), action.last.y - head * Math.sin(angle + Math.PI / 6));
            context.closePath();
            context.fill();
        }
        context.restore();
    }

    floodFill(canvas, startX, startY) {
        if (startX < 0 || startY < 0 || startX >= canvas.width || startY >= canvas.height) return false;
        const context = canvas.getContext("2d");
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const data = image.data;
        const start = (startY * canvas.width + startX) * 4;
        const target = [data[start], data[start + 1], data[start + 2], data[start + 3]];
        const hex = this.brushColor.slice(1);
        const fill = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), Math.round(this.brushOpacity * 255)];
        if (target.every((value, index) => Math.abs(value - fill[index]) <= 8)) return false;
        const matches = (pixel) => Math.abs(data[pixel] - target[0]) <= 8 && Math.abs(data[pixel + 1] - target[1]) <= 8 && Math.abs(data[pixel + 2] - target[2]) <= 8 && Math.abs(data[pixel + 3] - target[3]) <= 8;
        const stack = [startX, startY];
        while (stack.length) {
            const y = stack.pop();
            let x = stack.pop();
            let pixel = (y * canvas.width + x) * 4;
            while (x >= 0 && matches(pixel)) {
                x -= 1;
                pixel -= 4;
            }
            x += 1;
            pixel += 4;
            let spanUp = false;
            let spanDown = false;
            while (x < canvas.width && matches(pixel)) {
                data[pixel] = fill[0];
                data[pixel + 1] = fill[1];
                data[pixel + 2] = fill[2];
                data[pixel + 3] = fill[3];
                if (y > 0) {
                    const up = pixel - canvas.width * 4;
                    if (matches(up) && !spanUp) {
                        stack.push(x, y - 1);
                        spanUp = true;
                    } else if (!matches(up)) {
                        spanUp = false;
                    }
                }
                if (y < canvas.height - 1) {
                    const down = pixel + canvas.width * 4;
                    if (matches(down) && !spanDown) {
                        stack.push(x, y + 1);
                        spanDown = true;
                    } else if (!matches(down)) {
                        spanDown = false;
                    }
                }
                x += 1;
                pixel += 4;
            }
        }
        context.putImageData(image, 0, 0);
        const layer = this.project.layers.find((item) => item.canvas === canvas);
        if (layer) layer.dirty = true;
        return true;
    }

    normalizedCrop() {
        if (!this.cropRect) return null;
        const x = clamp(Math.round(Math.min(this.cropRect.x0, this.cropRect.x1)), 0, this.project.width - 1);
        const y = clamp(Math.round(Math.min(this.cropRect.y0, this.cropRect.y1)), 0, this.project.height - 1);
        const right = clamp(Math.round(Math.max(this.cropRect.x0, this.cropRect.x1)), x + 1, this.project.width);
        const bottom = clamp(Math.round(Math.max(this.cropRect.y0, this.cropRect.y1)), y + 1, this.project.height);
        return { x, y, width: right - x, height: bottom - y };
    }

    applyCrop() {
        const rect = this.normalizedCrop();
        if (!rect || rect.width < 2 || rect.height < 2) return;
        for (const layer of this.project.layers) {
            layer.x -= rect.x;
            layer.y -= rect.y;
        }
        const hasMask = this.project.maskCanvas || this.project.maskBaseImage || this.project.maskStrokes.length;
        if (hasMask) {
            const currentMask = makeCanvas(this.project.width, this.project.height);
            this.drawMask(currentMask, currentMask.width, currentMask.height, "#ffffff", false);
            const mask = makeCanvas(rect.width, rect.height);
            mask.getContext("2d").drawImage(currentMask, -rect.x, -rect.y);
            this.project.maskCanvas = mask;
        } else {
            this.project.maskCanvas = null;
        }
        this.project.maskBaseSrc = null;
        this.project.maskBaseAsset = null;
        this.project.maskStrokes = [];
        this.project.maskNeedsFlatten = Boolean(hasMask);
        this.project.width = rect.width;
        this.project.height = rect.height;
        this.cropRect = null;
        this.setTool("select");
        this.commit();
        this.fitCanvas();
    }

    showCanvasSizeDialog() {
        const dialog = el("div", "lie-dialog-backdrop");
        dialog.innerHTML = `
            <form class="lie-dialog">
                <header><strong>Canvas Size</strong><button type="button" class="lie-dialog-close" aria-label="Close">&#10005;</button></header>
                <div class="lie-dialog-grid">
                    <label>Width <input name="width" type="number" min="1" max="8192" value="${this.project.width}"></label>
                    <label>Height <input name="height" type="number" min="1" max="8192" value="${this.project.height}"></label>
                </div>
                <fieldset><legend>Anchor</legend><div class="lie-anchor-grid"></div></fieldset>
                <footer><button type="button" class="lie-cancel">Cancel</button><button type="submit" class="lie-primary">Apply</button></footer>
            </form>`;
        const anchorGrid = dialog.querySelector(".lie-anchor-grid");
        let anchor = "center";
        for (const value of ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]) {
            const button = el("button", `lie-anchor${value === anchor ? " is-active" : ""}`);
            button.type = "button";
            button.title = value;
            button.addEventListener("click", () => {
                anchor = value;
                anchorGrid.querySelectorAll("button").forEach((item) => item.classList.toggle("is-active", item === button));
            });
            anchorGrid.appendChild(button);
        }
        const close = () => dialog.remove();
        dialog.querySelector(".lie-dialog-close").addEventListener("click", close);
        dialog.querySelector(".lie-cancel").addEventListener("click", close);
        dialog.querySelector("form").addEventListener("submit", (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const width = clamp(Math.round(Number(data.get("width"))), 1, 8192);
            const height = clamp(Math.round(Number(data.get("height"))), 1, 8192);
            if (width * height > MAX_IMAGE_PIXELS) {
                this.toast("画布最大支持 8192 × 8192（8K）", true);
                return;
            }
            this.resizeProject(width, height, anchor, true);
            close();
        });
        this.overlay.querySelector(".lie-window").appendChild(dialog);
    }

    resizeProject(width, height, anchor, shouldCommit) {
        const oldWidth = this.project.width;
        const oldHeight = this.project.height;
        const dx = width - oldWidth;
        const dy = height - oldHeight;
        const horizontal = anchor.includes("left") ? 0 : anchor.includes("right") ? dx : dx / 2;
        const vertical = anchor.includes("top") ? 0 : anchor.includes("bottom") ? dy : dy / 2;
        for (const layer of this.project.layers) {
            layer.x += horizontal;
            layer.y += vertical;
        }
        const hasMask = this.project.maskCanvas || this.project.maskBaseImage || this.project.maskStrokes.length;
        if (hasMask) {
            const currentMask = makeCanvas(oldWidth, oldHeight);
            this.drawMask(currentMask, oldWidth, oldHeight, "#ffffff", false);
            const mask = makeCanvas(width, height);
            mask.getContext("2d").drawImage(currentMask, horizontal, vertical);
            this.project.maskCanvas = mask;
        } else {
            this.project.maskCanvas = null;
        }
        this.project.maskBaseSrc = null;
        this.project.maskBaseAsset = null;
        this.project.maskStrokes = [];
        this.project.maskNeedsFlatten = Boolean(hasMask);
        this.project.width = width;
        this.project.height = height;
        if (shouldCommit) {
            this.commit();
            this.fitCanvas();
        }
    }

    memorySnapshot() {
        return {
            version: 1,
            width: this.project.width,
            height: this.project.height,
            background: this.project.background,
            selectedId: this.selectedId,
            maskCanvas: this.project.maskNeedsFlatten ? cloneCanvas(this.project.maskCanvas) : null,
            maskBaseSrc: this.project.maskBaseSrc,
            maskBaseAsset: this.project.maskBaseAsset,
            maskStrokes: structuredClone(this.project.maskStrokes),
            maskNeedsFlatten: Boolean(this.project.maskNeedsFlatten),
            layers: this.project.layers.map((layer) => ({
                id: layer.id, name: layer.name, kind: layer.kind, visible: layer.visible, locked: layer.locked,
                maskInvert: layer.maskInvert, maskSourceId: layer.maskSourceId,
                opacity: layer.opacity, blendMode: layer.blendMode, x: layer.x, y: layer.y,
                scaleX: layer.scaleX, scaleY: layer.scaleY, rotation: layer.rotation,
                src: layer.src, asset: layer.asset, dirty: layer.dirty,
                canvas: layer.dirty || !layer.src ? shareCanvas(layer.canvas) : null,
            })),
        };
    }

    async serializedProject() {
        const layers = [];
        for (const layer of this.project.layers) {
            if (layer.dirty || !layer.src) {
                const blob = await canvasBlob(layer.canvas);
                const uploaded = await uploadAsset(blob, `edited-${Date.now()}-${layer.id}.png`);
                layer.src = uploaded.src;
                layer.asset = uploaded.asset;
                layer.dirty = false;
            } else if (!layer.asset && layer.src.startsWith("data:image/")) {
                const blob = await embeddedImageBlob(layer.src);
                const extension = blob.type === "image/jpeg" ? "jpg" : blob.type.split("/")[1] || "png";
                const uploaded = await uploadAsset(blob, `migrated-${Date.now()}-${layer.id}.${extension}`);
                layer.src = uploaded.src;
                layer.asset = uploaded.asset;
            }
            layers.push({
                id: layer.id, name: layer.name, kind: layer.kind, visible: layer.visible, locked: layer.locked,
                maskInvert: layer.maskInvert, maskSourceId: layer.maskSourceId,
                opacity: layer.opacity, blendMode: layer.blendMode, x: layer.x, y: layer.y,
                scaleX: layer.scaleX, scaleY: layer.scaleY, rotation: layer.rotation,
                src: layer.asset ? undefined : layer.src,
                asset: layer.asset || undefined,
            });
        }
        if (this.project.maskNeedsFlatten) {
            const flattened = makeCanvas(this.project.width, this.project.height);
            this.drawMask(flattened, flattened.width, flattened.height, "#ffffff", false);
            const ctx = flattened.getContext("2d");
            ctx.globalCompositeOperation = "destination-over";
            ctx.fillStyle = "#000000";
            ctx.fillRect(0, 0, flattened.width, flattened.height);
            const blob = await canvasBlob(flattened);
            const uploaded = await uploadAsset(blob, `mask-${Date.now()}.png`);
            this.project.maskBaseSrc = uploaded.src;
            this.project.maskBaseAsset = uploaded.asset;
            this.project.maskBaseImage = await loadImage(uploaded.src);
            this.project.maskCanvas = null;
            this.project.maskStrokes = [];
            this.project.maskNeedsFlatten = false;
        } else if (!this.project.maskBaseAsset && this.project.maskBaseSrc?.startsWith("data:image/")) {
            const blob = await embeddedImageBlob(this.project.maskBaseSrc);
            const uploaded = await uploadAsset(blob, `migrated-mask-${Date.now()}.png`);
            this.project.maskBaseSrc = uploaded.src;
            this.project.maskBaseAsset = uploaded.asset;
        }
        const state = {
            version: 2,
            width: this.project.width,
            height: this.project.height,
            background: this.project.background,
            selectedId: this.selectedId,
            maskStrokes: this.project.maskStrokes,
            layers,
        };
        if (this.project.maskBaseAsset) state.maskAsset = this.project.maskBaseAsset;
        else if (this.project.maskBaseSrc) state.maskSrc = this.project.maskBaseSrc;
        return JSON.stringify(state);
    }

    resetHistory() {
        this.initialSnapshot = this.memorySnapshot();
        this.history = [this.initialSnapshot];
        this.historyIndex = 0;
    }

    commit() {
        if (this.restoring) return;
        this.invalidateNodeBase();
        this.history.splice(this.historyIndex + 1);
        this.history.push(this.memorySnapshot());
        if (this.history.length > MAX_HISTORY) this.history.shift();
        // Count unique raster versions, not shared references in metadata-only edits.
        const historyBytes = () => {
            const canvases = new Set();
            for (const snapshot of this.history) {
                if (snapshot.maskCanvas) canvases.add(snapshot.maskCanvas);
                for (const layer of snapshot.layers) if (layer.canvas) canvases.add(layer.canvas);
            }
            return [...canvases].reduce((bytes, canvas) => bytes + canvas.width * canvas.height * 4, 0);
        };
        while (this.history.length > 2 && historyBytes() > MAX_HISTORY_BYTES) this.history.shift();
        this.historyIndex = this.history.length - 1;
        if (this.statusMode) this.statusMode.textContent = "未保存";
        this.renderAll();
    }

    async restoreSnapshot(snapshot) {
        this.restoring = true;
        const layers = [];
        for (const layer of snapshot.layers) {
            const canvas = layer.canvas ? shareCanvas(layer.canvas) : await loadImage(layer.src);
            layers.push({ ...layer, canvas });
        }
        this.project = {
            version: snapshot.version,
            width: snapshot.width,
            height: snapshot.height,
            background: snapshot.background,
            maskCanvas: snapshot.maskCanvas ? cloneCanvas(snapshot.maskCanvas) : null,
            maskBaseImage: snapshot.maskBaseSrc ? await loadImage(snapshot.maskBaseSrc) : null,
            maskBaseSrc: snapshot.maskBaseSrc,
            maskBaseAsset: snapshot.maskBaseAsset,
            maskStrokes: structuredClone(snapshot.maskStrokes),
            maskNeedsFlatten: snapshot.maskNeedsFlatten,
            layers,
        };
        this.selectedId = snapshot.selectedId;
        this.invalidateNodeBase();
        this.restoring = false;
        this.renderAll();
        if (this.statusMode) this.statusMode.textContent = "未保存";
    }

    async undo() {
        if (this.historyIndex <= 0 || this.restoring) return;
        this.historyIndex -= 1;
        await this.restoreSnapshot(this.history[this.historyIndex]);
    }

    async redo() {
        if (this.historyIndex >= this.history.length - 1 || this.restoring) return;
        this.historyIndex += 1;
        await this.restoreSnapshot(this.history[this.historyIndex]);
    }

    renderNodePreview() {
        if (!this.project) return;
        this.nodePreview.placeholder.hidden = true;
        this.nodePreview.wrap.classList.add("has-image");
        this.nodePreview.size.textContent = `${this.project.width} × ${this.project.height}`;
        this.nodePreview.updateLayout(this.project.width, this.project.height);
        this.renderInlineMaskPreview();
    }

    renderInlineMaskPreview() {
        if (!this.project) return;
        const canvas = this.nodePreview.canvas;
        let displayWidth = Math.max(1, Math.round(this.nodePreview.displayWidth || 388));
        let displayHeight = Math.max(1, Math.round(this.nodePreview.displayHeight || displayWidth * this.project.height / this.project.width));
        const backingScale = Math.min(1, Math.sqrt(MAX_RENDER_PIXELS / (displayWidth * displayHeight)));
        displayWidth = Math.max(1, Math.floor(displayWidth * backingScale));
        displayHeight = Math.max(1, Math.floor(displayHeight * backingScale));
        if (canvas.width !== displayWidth) canvas.width = displayWidth;
        if (canvas.height !== displayHeight) canvas.height = displayHeight;
        const context = canvas.getContext("2d");
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
        if (!this.inlineBase || this.inlineBase.width !== canvas.width || this.inlineBase.height !== canvas.height) {
            this.inlineBase = makeCanvas(canvas.width, canvas.height);
            this.inlineBaseRevision = -1;
        }
        if (this.inlineBaseRevision !== this.layerRevision) {
            const baseContext = this.inlineBase.getContext("2d");
            baseContext.setTransform(1, 0, 0, 1, 0, 0);
            baseContext.clearRect(0, 0, this.inlineBase.width, this.inlineBase.height);
            baseContext.globalAlpha = 1;
            baseContext.globalCompositeOperation = "source-over";
            baseContext.fillStyle = this.project.background;
            baseContext.fillRect(0, 0, this.inlineBase.width, this.inlineBase.height);
            baseContext.save();
            baseContext.scale(this.inlineBase.width / this.project.width, this.inlineBase.height / this.project.height);
            this.drawLayers(baseContext);
            baseContext.restore();
            this.inlineBaseRevision = this.layerRevision;
        }
        context.globalAlpha = 1;
        context.globalCompositeOperation = "source-over";
        context.drawImage(this.inlineBase, 0, 0);
        this.drawMaskOverlay(canvas, true);
        this.nodePreview.maskUndoButton.disabled = this.project.maskStrokes.length === 0;
        this.nodePreview.maskResetButton.disabled = !(this.project.maskCanvas || this.project.maskBaseImage || this.project.maskStrokes.length || this.maskLayers().length);
    }

    invalidateNodeBase() {
        this.layerRevision += 1;
        this.inlineBaseRevision = -1;
    }

    async refreshNodePreview() {
        const loadId = ++this.previewLoadId;
        if (!await this.loadProject()) return;
        if (loadId !== this.previewLoadId) return;
        if (this.project.layers.length) this.renderNodePreview();
        else {
            this.nodePreview.wrap.classList.remove("has-image", "is-mask-active");
            this.nodePreview.placeholder.hidden = false;
            this.nodePreview.size.textContent = `${this.project.width} × ${this.project.height}`;
            this.nodePreview.updateLayout(this.project.width, this.project.height, false);
        }
    }

    schedulePersist() {
        clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistNow().catch((error) => console.error("Local Image Editor: save failed", error));
        }, 900);
    }

    async persistNow() {
        clearTimeout(this.persistTimer);
        if (!this.project) return;
        const serialized = await this.serializedProject();
        this.stateWidget.value = serialized;
        this.savedState = serialized;
        this.renderNodePreview();
        this.node.setDirtyCanvas(true, true);
        if (this.statusMode) this.statusMode.textContent = "已保存";
    }

    toast(message, error = false) {
        this.status.textContent = message;
        this.status.classList.toggle("is-error", error);
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            if (!this.status) return;
            this.status.classList.remove("is-error");
            this.status.textContent = `${this.project.layers.length} layer${this.project.layers.length === 1 ? "" : "s"} · ${this.tool}`;
        }, 2800);
    }
}

function buildNodeWidget(node, stateWidget) {
    stateWidget.type = "converted-widget:local-image-editor-state";
    stateWidget.computeSize = () => [0, -4];
    stateWidget.serializeValue = () => stateWidget.value || "";

    const container = el("div", "lie-node-widget");
    container.dataset.storageMode = "comfy-input-v2";
    const uploadButton = el("button", "lie-node-upload", "上传图像");
    uploadButton.type = "button";
    const previewWrap = el("div", "lie-node-preview");
    const preview = el("canvas", "lie-node-preview-canvas");
    preview.setAttribute("aria-label", "图像与遮罩预览");
    const placeholder = el("div", "lie-node-placeholder", "尚未载入图像");
    previewWrap.append(preview, placeholder);
    const controls = el("div", "lie-node-controls");
    const maskButton = el("button", "lie-node-mask", "遮罩画笔");
    maskButton.type = "button";
    maskButton.setAttribute("aria-pressed", "false");
    const openButton = el("button", "lie-node-open", "图像编辑");
    openButton.type = "button";
    controls.append(maskButton, openButton);
    const maskActions = el("div", "lie-node-mask-actions");
    const maskUndoButton = el("button", "lie-node-mask-undo", "↶ 撤销");
    maskUndoButton.type = "button";
    maskUndoButton.title = "撤销上一步遮罩";
    const maskResetButton = el("button", "lie-node-mask-reset", "↻ 还原");
    maskResetButton.type = "button";
    maskResetButton.title = "清除全部遮罩";
    maskActions.append(maskUndoButton, maskResetButton);
    const footer = el("div", "lie-node-footer");
    footer.innerHTML = "<span class=\"lie-node-size\">1024 × 1024</span>";
    previewWrap.append(controls, maskActions);
    container.append(uploadButton, previewWrap, footer);

    const fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.hidden = true;
    container.appendChild(fileInput);

    let widgetHeight = 238;
    let domWidget = null;
    const updateLayout = (width, height, hasImage = true) => {
        const contentWidth = Math.max(180, (node.size?.[0] || 420) - 32);
        const previewHeight = hasImage ? Math.round(contentWidth * height / width) : 160;
        const nextWidgetHeight = previewHeight + 73;
        const nextNodeHeight = nextWidgetHeight + 92;
        previewWrap.style.aspectRatio = hasImage ? `${width} / ${height}` : "auto";
        previewWrap.style.height = hasImage ? "auto" : `${previewHeight}px`;
        container.style.height = `${nextWidgetHeight}px`;
        nodePreview.displayWidth = contentWidth;
        nodePreview.displayHeight = previewHeight;
        widgetHeight = nextWidgetHeight;
        if (domWidget) {
            domWidget.options.getMinHeight = () => widgetHeight;
            domWidget.options.getMaxHeight = () => widgetHeight;
        }
        const layoutKey = `${Math.round(node.size?.[0] || 420)}:${width}:${height}:${hasImage}`;
        if (node.__lieLayoutKey !== layoutKey) {
            node.__lieLayoutKey = layoutKey;
            node.setSize([node.size?.[0] || 420, nextNodeHeight]);
        }
    };
    const nodePreview = {
        canvas: preview,
        wrap: previewWrap,
        placeholder,
        maskButton,
        maskUndoButton,
        maskResetButton,
        size: footer.querySelector(".lie-node-size"),
        updateLayout,
    };
    const editor = new EditorModal(node, stateWidget, nodePreview);
    node.localImageEditor = editor;
    const open = (files = [], tool = "select") => editor.open(files, tool);
    openButton.addEventListener("click", () => open([], "select"));
    maskButton.addEventListener("click", (event) => {
        event.stopPropagation();
        editor.toggleInlineMask();
    });
    maskUndoButton.addEventListener("click", (event) => {
        event.stopPropagation();
        editor.undoInlineMask();
    });
    maskResetButton.addEventListener("click", (event) => {
        event.stopPropagation();
        editor.resetInlineMask();
    });
    preview.addEventListener("pointerdown", (event) => editor.inlineMaskDown(event));
    preview.addEventListener("pointermove", (event) => editor.inlineMaskMove(event));
    preview.addEventListener("pointerup", (event) => editor.inlineMaskUp(event));
    preview.addEventListener("pointercancel", (event) => editor.inlineMaskUp(event));
    uploadButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
        await editor.importDirect([...fileInput.files]);
        fileInput.value = "";
    });
    container.addEventListener("dragover", (event) => {
        if ([...event.dataTransfer.items].some((item) => item.type.startsWith("image/"))) {
            event.preventDefault();
            container.classList.add("is-dropping");
        }
    });
    container.addEventListener("dragleave", () => container.classList.remove("is-dropping"));
    container.addEventListener("drop", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        container.classList.remove("is-dropping");
        const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/"));
        if (files.length) await editor.importDirect(files);
    });

    const refreshPreview = () => editor.refreshNodePreview().catch((error) => {
        console.warn("Local Image Editor: unable to load node preview", error);
    });
    node.refreshLocalEditorPreview = refreshPreview;
    domWidget = node.addDOMWidget("local_editor", "local-image-editor", container, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => widgetHeight,
        getMaxHeight: () => widgetHeight,
    });
    node.setSize([420, 330]);
    refreshPreview();
}

app.registerExtension({
    name: EXTENSION_NAME,
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_NAMES.has(nodeData.name)) return;
        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalCreated?.apply(this, arguments);
            const stateWidget = this.widgets?.find((widget) => widget.name === "editor_state");
            if (stateWidget) buildNodeWidget(this, stateWidget);
            return result;
        };
        const originalConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = originalConfigure?.apply(this, arguments);
            setTimeout(() => this.refreshLocalEditorPreview?.(), 0);
            return result;
        };
        const originalRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (this.localImageEditor?.overlay?.isConnected) this.localImageEditor.close();
            return originalRemoved?.apply(this, arguments);
        };
    },
});
