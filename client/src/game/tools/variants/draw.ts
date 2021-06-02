import { computed, reactive, watch, watchEffect } from "vue";

import { clampGridLine, getUnitDistance, l2g, l2gz } from "../../../core/conversions";
import { cloneP, GlobalPoint, LocalPoint, subtractP, toGP } from "../../../core/geometry";
import { equalPoints, snapToPoint } from "../../../core/math";
import { InvalidationMode, SyncMode, SyncTo } from "../../../core/models/types";
import { PromptFunction } from "../../../core/plugins/modals/prompt";
import { ctrlOrCmdPressed } from "../../../core/utils";
import { i18n } from "../../../i18n";
import { clientStore } from "../../../store/client";
import { floorStore } from "../../../store/floor";
import { gameStore } from "../../../store/game";
import { settingsStore } from "../../../store/settings";
import { sendShapeSizeUpdate } from "../../api/emits/shape/core";
import { Layer } from "../../layers/variants/layer";
import { Floor, LayerName } from "../../models/floor";
import { ToolFeatures, ToolName } from "../../models/tools";
import { overrideLastOperation } from "../../operations/undo";
import { Shape } from "../../shapes/shape";
import { Circle } from "../../shapes/variants/circle";
import { Line } from "../../shapes/variants/line";
import { Polygon } from "../../shapes/variants/polygon";
import { Rect } from "../../shapes/variants/rect";
import { Text } from "../../shapes/variants/text";
import { openDefaultContextMenu } from "../../ui/contextmenu/state";
import { TriangulationTarget, visionState } from "../../vision/state";
import { Tool } from "../tool";

export enum DrawMode {
    Normal = "normal",
    Reveal = "reveal",
    Hide = "hide",
    Erase = "erase",
}

export enum DrawShape {
    Square = "square",
    Circle = "circle",
    Polygon = "draw-polygon",
    Brush = "paint-brush",
    Text = "font",
}

class DrawTool extends Tool {
    readonly toolName = ToolName.Draw;
    readonly toolTranslation = i18n.global.t("tool.Draw");

    state = reactive({
        selectedMode: DrawMode.Normal,
        selectedShape: DrawShape.Square,

        fillColour: "rgba(0, 0, 0, 1)",
        borderColour: "rgba(255, 255, 255, 0)",

        isClosedPolygon: false,
        brushSize: 5,

        fontSize: 20,
    });
    hasBrushSize = computed(() => [DrawShape.Brush, DrawShape.Polygon].includes(this.state.selectedShape));

    private startPoint?: GlobalPoint;
    private shape?: Shape;
    private brushHelper?: Circle;
    private ruler?: Line;

    private snappedToPoint = false;

    constructor() {
        super();
        watch(
            () => gameStore.state.boardInitialized,
            () => {
                watch(floorStore.currentFloor, (_, oldFloor) => this.onFloorChange(oldFloor!));
                watch(floorStore.currentLayer, (_, oldLayer) => this.onLayerChange(oldLayer!));
            },
        );
        watch(
            () => this.state.selectedMode,
            (newMode, oldMode) => this.onModeChange(newMode, oldMode),
        );
        watchEffect(() => {
            if (this.brushHelper) {
                this.brushHelper.fillColour = this.state.fillColour;
            }
        });
        watchEffect(() => {
            if (this.shape !== undefined && this.active) {
                (this.shape as Polygon).openPolygon = !this.state.isClosedPolygon;
            }
        });
    }

    // Prompt function

    private promptFunction: PromptFunction | undefined;

    setPromptFunction(promptFunction: PromptFunction): void {
        this.promptFunction = promptFunction;
    }

    // HELPERS

    private get helperSize(): number {
        if (this.hasBrushSize.value) return this.state.brushSize / 2;
        return getUnitDistance(settingsStore.unitSize.value) / 8;
    }

    private getLayer(data?: { floor?: Floor; layer?: LayerName }): Layer | undefined {
        if (this.state.selectedMode === DrawMode.Normal)
            return floorStore.getLayer(data?.floor ?? floorStore.currentFloor.value!, data?.layer);
        else if (this.state.selectedMode === DrawMode.Erase) {
            return floorStore.getLayer(floorStore.currentFloor.value!, LayerName.Map);
        }
        return floorStore.getLayer(floorStore.currentFloor.value!, LayerName.Lighting);
    }

    private finaliseShape(): void {
        if (this.shape === undefined) return;
        this.shape.updatePoints();
        if (this.shape.points.length <= 1) {
            let mouse: { x: number; y: number } | undefined = undefined;
            if (this.brushHelper !== undefined) {
                mouse = { x: this.brushHelper.refPoint.x, y: this.brushHelper.refPoint.y };
            }
            this.onDeselect();
            this.onSelect(mouse);
        } else {
            if (this.shape.blocksVision) visionState.recalculateVision(this.shape.floor.id);
            if (this.shape.blocksMovement) visionState.recalculateMovement(this.shape.floor.id);
            if (!this.shape.preventSync) sendShapeSizeUpdate({ shape: this.shape, temporary: false });
        }
        this.active = false;
        const layer = this.getLayer();
        if (layer !== undefined) {
            layer.invalidate(false);
        }

        overrideLastOperation({ type: "shapeadd", shapes: [this.shape.asDict()] });
    }

    // private async showLayerPoints(): Promise<void> {
    //     const layer = this.getLayer()!;
    //     await layer.waitValid();
    //     if (!this.isActiveTool.value) return;
    //     const dL = floorStore.getLayer(floorStore.currentFloor.value!, LayerName.Draw)!;
    //     for (const point of layer.points.keys()) {
    //         const parsedPoint = JSON.parse(point);
    //         dL.ctx.beginPath();
    //         dL.ctx.arc(g2lx(parsedPoint[0]), g2ly(parsedPoint[1]), 5, 0, 2 * Math.PI);
    //         dL.ctx.fill();
    //     }
    // }

    private onModeChange(newValue: string, oldValue: string): void {
        if (this.brushHelper === undefined) return;

        const fowLayer = floorStore.getLayer(floorStore.currentFloor.value!, LayerName.Lighting);
        const normalLayer = floorStore.currentLayer.value;
        const mapLayer = floorStore.getLayer(floorStore.currentFloor.value!, LayerName.Map)!;
        if (fowLayer === undefined || normalLayer === undefined) return;

        this.setupBrush();

        // Removal

        if (oldValue === DrawMode.Normal) {
            normalLayer.removeShape(this.brushHelper, SyncMode.NO_SYNC, true);
        } else if (oldValue === DrawMode.Erase) {
            mapLayer.removeShape(this.brushHelper, SyncMode.NO_SYNC, true);
        } else {
            fowLayer.removeShape(this.brushHelper, SyncMode.NO_SYNC, true);
        }

        // Adding

        if (newValue === DrawMode.Normal) {
            normalLayer.addShape(this.brushHelper, SyncMode.NO_SYNC, InvalidationMode.NORMAL, false);
        } else if (newValue === DrawMode.Erase) {
            mapLayer.addShape(this.brushHelper, SyncMode.NO_SYNC, InvalidationMode.NORMAL, false);
        } else {
            fowLayer.addShape(this.brushHelper, SyncMode.NO_SYNC, InvalidationMode.NORMAL, false);
        }
    }

    private onFloorChange(oldValue: Floor): void {
        if (this.isActiveTool.value) {
            let mouse: { x: number; y: number } | undefined = undefined;
            if (this.brushHelper !== undefined) {
                mouse = { x: this.brushHelper.refPoint.x, y: this.brushHelper.refPoint.y };
            }
            this.onDeselect({ floor: oldValue });
            this.onSelect(mouse);
        }
    }

    private onLayerChange(oldValue: Layer): void {
        if (this.isActiveTool.value) {
            let mouse: { x: number; y: number } | undefined = undefined;
            if (this.brushHelper !== undefined) {
                mouse = { x: this.brushHelper.refPoint.x, y: this.brushHelper.refPoint.y };
            }
            this.onDeselect({ layer: oldValue.name });
            this.onSelect(mouse);
        }
    }

    // STATE HANDLERS

    onSelect(mouse?: { x: number; y: number }): void {
        const layer = this.getLayer();
        if (layer === undefined) return;
        layer.canvas.parentElement!.style.cursor = "none";
        this.brushHelper = new Circle(toGP(mouse?.x ?? -1000, mouse?.y ?? -1000), this.state.brushSize / 2, {
            fillColour: this.state.fillColour,
        });
        this.setupBrush();
        layer.addShape(this.brushHelper, SyncMode.NO_SYNC, InvalidationMode.NORMAL, false); // during mode change the shape is already added
        // if (gameStore.state.isDm) this.showLayerPoints();
    }

    onDeselect(data?: { floor?: Floor; layer?: LayerName }): void {
        const layer = this.getLayer(data);
        if (layer === undefined) return;
        if (this.brushHelper !== undefined) {
            layer.removeShape(this.brushHelper, SyncMode.NO_SYNC, true);
            this.brushHelper = undefined;
        }
        if (this.ruler !== undefined) {
            layer.removeShape(this.ruler, SyncMode.NO_SYNC, true);
            this.ruler = undefined;
        }
        if (this.active && this.shape !== undefined) {
            layer.removeShape(this.shape, SyncMode.FULL_SYNC, true);
            this.shape = undefined;
            this.active = false;
            layer.invalidate(false);
        }
        layer.canvas.parentElement!.style.removeProperty("cursor");
        floorStore.getLayer(floorStore.currentFloor.value!, LayerName.Draw)?.invalidate(true);
    }

    // MOUSE HANDLERS

    async onDown(lp: LocalPoint, event: MouseEvent | TouchEvent): Promise<void> {
        const startPoint = l2g(lp);
        const layer = this.getLayer();
        if (layer === undefined) {
            console.log("No active layer!");
            return;
        }
        if (this.brushHelper === undefined) return;

        if (!this.active) {
            this.startPoint = startPoint;
            this.active = true;
            switch (this.state.selectedShape) {
                case DrawShape.Square: {
                    this.shape = new Rect(cloneP(startPoint), 0, 0, {
                        fillColour: this.state.fillColour,
                        strokeColour: this.state.borderColour,
                    });
                    break;
                }
                case DrawShape.Circle: {
                    this.shape = new Circle(cloneP(startPoint), this.helperSize, {
                        fillColour: this.state.fillColour,
                        strokeColour: this.state.borderColour,
                    });
                    break;
                }
                case DrawShape.Brush: {
                    this.shape = new Polygon(cloneP(startPoint), [], {
                        strokeColour: this.state.fillColour,
                        lineWidth: this.state.brushSize,
                        openPolygon: true,
                    });
                    this.shape.fillColour = this.state.fillColour;
                    break;
                }
                case DrawShape.Polygon: {
                    const fill = this.state.isClosedPolygon ? this.state.fillColour : undefined;
                    const stroke = this.state.isClosedPolygon ? this.state.borderColour : this.state.fillColour;
                    if (clientStore.useSnapping(event) && !this.snappedToPoint) {
                        this.brushHelper.refPoint = toGP(clampGridLine(startPoint.x), clampGridLine(startPoint.y));
                    }
                    this.shape = new Polygon(cloneP(this.brushHelper.refPoint), [], {
                        fillColour: fill,
                        strokeColour: stroke,
                        lineWidth: this.state.brushSize,
                        openPolygon: !this.state.isClosedPolygon,
                    });
                    break;
                }
                case DrawShape.Text: {
                    event.preventDefault();
                    const text = await this.promptFunction!("What should the text say?", "New text");
                    if (text === undefined) {
                        this.active = false;
                        return;
                    }
                    this.shape = new Text(cloneP(this.brushHelper.refPoint), text, this.state.fontSize, {
                        fillColour: this.state.fillColour,
                        strokeColour: this.state.borderColour,
                    });
                    break;
                }
                default:
                    return;
            }

            if (this.state.selectedMode === DrawMode.Erase) {
                this.shape.fillColour = "rgba(0, 0, 0, 1)";
            }
            if (this.state.selectedMode === DrawMode.Hide || this.state.selectedMode === DrawMode.Reveal) {
                this.shape.options.preFogShape = true;
                this.shape.options.skipDraw = true;
                this.shape.fillColour = "rgba(0, 0, 0, 1)";
            }
            if (this.state.selectedMode === DrawMode.Reveal) this.shape.globalCompositeOperation = "source-over";
            else if (this.state.selectedMode === DrawMode.Hide) this.shape.globalCompositeOperation = "destination-out";
            else if (this.state.selectedMode === DrawMode.Erase)
                this.shape.globalCompositeOperation = "destination-out";

            this.shape.addOwner({ user: clientStore.state.username, access: { edit: true } }, SyncTo.UI);
            if (layer.name === LayerName.Lighting && this.state.selectedMode === DrawMode.Normal) {
                this.shape.setBlocksVision(true, SyncTo.UI, false);
                this.shape.setBlocksMovement(true, SyncTo.UI, false);
            }
            layer.addShape(this.shape, SyncMode.FULL_SYNC, InvalidationMode.NO);

            // Push brushhelper to back
            this.pushBrushBack();
        } else if (
            this.shape !== undefined &&
            this.state.selectedShape === DrawShape.Polygon &&
            this.shape instanceof Polygon
        ) {
            // draw tool already active in polygon mode, add a new point to the polygon

            if (clientStore.useSnapping(event) && !this.snappedToPoint)
                this.brushHelper.refPoint = toGP(clampGridLine(startPoint.x), clampGridLine(startPoint.y));
            this.shape._vertices.push(cloneP(this.brushHelper.refPoint));
            this.shape.updatePoints();
        }

        // Start a ruler in polygon mode from the last point
        if (
            this.shape !== undefined &&
            this.state.selectedShape === DrawShape.Polygon &&
            this.shape instanceof Polygon
        ) {
            const lastPoint = this.brushHelper.refPoint;
            if (this.ruler === undefined) {
                this.ruler = new Line(lastPoint, lastPoint, {
                    lineWidth: this.state.brushSize,
                    strokeColour: this.state.fillColour,
                });
                layer.addShape(this.ruler, SyncMode.NO_SYNC, InvalidationMode.NORMAL, false);
            } else {
                this.ruler.refPoint = lastPoint;
                this.ruler.endPoint = lastPoint;
            }
            if (this.shape.blocksVision && this.shape.points.length > 1)
                visionState.insertConstraint(
                    TriangulationTarget.VISION,
                    this.shape,
                    this.shape.points[this.shape.points.length - 2],
                    this.shape.points[this.shape.points.length - 1],
                );
            if (this.shape.blocksMovement && this.shape.points.length > 1)
                visionState.insertConstraint(
                    TriangulationTarget.MOVEMENT,
                    this.shape,
                    this.shape.points[this.shape.points.length - 2],
                    this.shape.points[this.shape.points.length - 1],
                );
            layer.invalidate(false);
            if (!this.shape.preventSync) sendShapeSizeUpdate({ shape: this.shape, temporary: true });
        }

        // Finalize the text shape
        if (this.shape !== undefined && this.state.selectedShape === DrawShape.Text) {
            this.finaliseShape();
        }
    }

    onMove(lp: LocalPoint, event: MouseEvent | TouchEvent): void {
        let endPoint = l2g(lp);
        const layer = this.getLayer();
        if (layer === undefined) {
            console.log("No active layer!");
            return;
        }

        if (clientStore.useSnapping(event))
            [endPoint, this.snappedToPoint] = snapToPoint(this.getLayer()!, endPoint, this.ruler?.refPoint);
        else this.snappedToPoint = false;

        if (this.brushHelper !== undefined) {
            this.brushHelper.r = this.helperSize;
            this.brushHelper.refPoint = endPoint;
            if (!this.active) layer.invalidate(false);
        }

        if (!this.active || this.startPoint === undefined || this.shape === undefined) return;

        switch (this.state.selectedShape) {
            case DrawShape.Square: {
                const rect = this.shape as Rect;
                const newW = Math.abs(endPoint.x - this.startPoint.x);
                const newH = Math.abs(endPoint.y - this.startPoint.y);
                if (newW === rect.w && newH === rect.h) return;
                rect.w = newW;
                rect.h = newH;
                if (endPoint.x < this.startPoint.x || endPoint.y < this.startPoint.y) {
                    this.shape.refPoint = toGP(
                        Math.min(this.startPoint.x, endPoint.x),
                        Math.min(this.startPoint.y, endPoint.y),
                    );
                }
                break;
            }
            case DrawShape.Circle: {
                const circ = this.shape as Circle;
                const newR = Math.abs(subtractP(endPoint, this.startPoint).length());
                if (circ.r === newR) return;
                circ.r = newR;
                break;
            }
            case DrawShape.Brush: {
                const br = this.shape as Polygon;
                if (equalPoints(br.points[br.points.length - 1], [endPoint.x, endPoint.y])) return;
                br._vertices.push(endPoint);
                break;
            }
            case DrawShape.Polygon: {
                this.ruler!.endPoint = endPoint;
                break;
            }
        }

        if (this.state.selectedShape !== DrawShape.Polygon) {
            if (!this.shape.preventSync) sendShapeSizeUpdate({ shape: this.shape, temporary: true });
            if (this.shape.blocksVision) {
                if (
                    visionState
                        .getCDT(TriangulationTarget.VISION, this.shape.floor.id)
                        .tds.getTriagVertices(this.shape.uuid).length > 1
                )
                    visionState.deleteFromTriangulation({
                        target: TriangulationTarget.VISION,
                        shape: this.shape.uuid,
                    });
                visionState.addToTriangulation({ target: TriangulationTarget.VISION, shape: this.shape.uuid });
                visionState.recalculateVision(this.shape.floor.id);
            }
        }
        layer.invalidate(false);
    }

    onUp(lp: LocalPoint, event: MouseEvent | TouchEvent): void {
        if (
            !this.active ||
            this.shape === undefined ||
            (this.shape instanceof Polygon && this.state.selectedShape === DrawShape.Polygon)
        ) {
            return;
        }

        let endPoint = l2g(lp);
        if (clientStore.useSnapping(event))
            [endPoint, this.snappedToPoint] = snapToPoint(this.getLayer()!, endPoint, this.ruler?.refPoint);
        else this.snappedToPoint = false;

        // TODO: handle touch event different than altKey, long press
        if (clientStore.useSnapping(event) && settingsStore.useGrid.value && !this.snappedToPoint) {
            if (this.shape.blocksVision)
                visionState.deleteFromTriangulation({
                    target: TriangulationTarget.VISION,
                    shape: this.shape.uuid,
                });
            this.shape.resizeToGrid(this.shape.getPointIndex(endPoint, l2gz(5)), ctrlOrCmdPressed(event));
            if (this.shape.blocksVision) {
                visionState.addToTriangulation({ target: TriangulationTarget.VISION, shape: this.shape.uuid });
                visionState.recalculateVision(this.shape.floor.id);
            }
            if (this.shape.blocksMovement) {
                visionState.addToTriangulation({ target: TriangulationTarget.MOVEMENT, shape: this.shape.uuid });
                visionState.recalculateMovement(this.shape.floor.id);
            }
        }

        this.finaliseShape();
    }

    onContextMenu(event: MouseEvent): void {
        if (
            this.active &&
            this.shape !== undefined &&
            this.state.selectedShape === DrawShape.Polygon &&
            this.shape instanceof Polygon
        ) {
            const layer = this.getLayer();
            if (layer === undefined) {
                console.log("No active layer!");
                return;
            }
            layer.removeShape(this.ruler!, SyncMode.NO_SYNC, true);
            this.ruler = undefined;
            if (this.state.isClosedPolygon) {
                if (this.shape.blocksVision && this.shape.points.length > 1)
                    visionState.insertConstraint(
                        TriangulationTarget.VISION,
                        this.shape,
                        this.shape.points[0],
                        this.shape.points[this.shape.points.length - 1],
                    );
                if (this.shape.blocksMovement && this.shape.points.length > 1)
                    visionState.insertConstraint(
                        TriangulationTarget.MOVEMENT,
                        this.shape,
                        this.shape.points[0],
                        this.shape.points[this.shape.points.length - 1],
                    );
            }
            this.finaliseShape();
        } else if (!this.active) {
            openDefaultContextMenu(event);
        }
    }

    onKeyUp(event: KeyboardEvent, features: ToolFeatures): void {
        if (event.defaultPrevented) return;
        if (event.key === "Escape" && this.active) {
            let mouse: { x: number; y: number } | undefined = undefined;
            if (this.brushHelper !== undefined) {
                mouse = { x: this.brushHelper.refPoint.x, y: this.brushHelper.refPoint.y };
            }
            this.onDeselect();
            this.onSelect(mouse);
            event.preventDefault();
        }
        super.onKeyUp(event, features);
    }

    // BRUSH

    private setupBrush(): void {
        if (this.brushHelper === undefined) return;
        if (this.state.selectedMode === DrawMode.Reveal || this.state.selectedMode === DrawMode.Hide) {
            this.brushHelper.options.preFogShape = true;
            this.brushHelper.options.skipDraw = true;
            this.brushHelper.fillColour = "rgba(0, 0, 0, 1)";

            if (this.state.selectedMode === DrawMode.Reveal) this.brushHelper.globalCompositeOperation = "source-over";
            else if (this.state.selectedMode === DrawMode.Hide)
                this.brushHelper.globalCompositeOperation = "destination-out";
        } else {
            delete this.brushHelper.options.preFogShape;
            delete this.brushHelper.options.skipDraw;
            this.brushHelper.globalCompositeOperation = "source-over";
            this.brushHelper.fillColour = this.state.fillColour;
        }
        this.brushHelper.r = this.helperSize;
    }

    private pushBrushBack(): void {
        const layer = this.getLayer();
        if (layer === undefined) {
            console.log("No active layer!");
            return;
        }
        const refPoint = this.brushHelper?.refPoint;
        const bs = this.brushHelper?.r;
        if (this.brushHelper !== undefined) layer.removeShape(this.brushHelper, SyncMode.NO_SYNC, true);
        this.brushHelper = new Circle(toGP(-1000, -1000), bs ?? this.state.brushSize / 2, {
            fillColour: this.state.fillColour,
        });
        this.setupBrush();
        layer.addShape(this.brushHelper, SyncMode.NO_SYNC, InvalidationMode.NORMAL, false); // during mode change the shape is already added
        if (refPoint) this.brushHelper.refPoint = refPoint;
    }
}

export const drawTool = new DrawTool();
