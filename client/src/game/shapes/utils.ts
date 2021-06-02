import { subtractP, toGP, Vector } from "../../core/geometry";
import { SyncMode, InvalidationMode } from "../../core/models/types";
import { baseAdjust, uuidv4 } from "../../core/utils";
import { clientStore } from "../../store/client";
import { floorStore } from "../../store/floor";
import { gameStore } from "../../store/game";
import { sendRemoveShapes } from "../api/emits/shape/core";
import { addGroupMembers, createNewGroupForShapes, generateNewBadge, hasGroup } from "../groups";
import { selectionState } from "../layers/selection";
import { LayerName } from "../models/floor";
import {
    ServerShape,
    ServerRect,
    ServerCircle,
    ServerCircularToken,
    ServerLine,
    ServerPolygon,
    ServerText,
    ServerAsset,
    ServerToggleComposite,
    ServerTracker,
    ServerAura,
    ServerShapeOwner,
} from "../models/shapes";
import { addOperation } from "../operations/undo";
import { TriangulationTarget, VisibilityMode, visionState } from "../vision/state";

import { Shape } from "./shape";
import { Asset } from "./variants/asset";
import { Circle } from "./variants/circle";
import { CircularToken } from "./variants/circularToken";
import { Line } from "./variants/line";
import { Polygon } from "./variants/polygon";
import { Rect } from "./variants/rect";
import { Text } from "./variants/text";
import { ToggleComposite } from "./variants/toggleComposite";

// eslint-disable-next-line
export function createShapeFromDict(shape: ServerShape): Shape | undefined {
    let sh: Shape;

    // A fromJSON and toJSON on Shape would be cleaner but ts does not allow for static abstracts so yeah.

    if (shape.group !== undefined && shape.group !== null) {
        const group = hasGroup(shape.group);
        if (group === undefined) {
            console.log("Missing group info detected");
        } else {
            addGroupMembers(shape.group, [{ uuid: shape.uuid, badge: shape.badge }], false);
        }
    }

    // Shape Type specifics

    const refPoint = toGP(shape.x, shape.y);
    if (shape.type_ === "rect") {
        const rect = shape as ServerRect;
        sh = new Rect(refPoint, rect.width, rect.height, {
            fillColour: rect.fill_colour,
            strokeColour: rect.stroke_colour,
            uuid: rect.uuid,
        });
    } else if (shape.type_ === "circle") {
        const circ = shape as ServerCircle;
        sh = new Circle(refPoint, circ.radius, {
            fillColour: circ.fill_colour,
            strokeColour: circ.stroke_colour,
            uuid: circ.uuid,
        });
    } else if (shape.type_ === "circulartoken") {
        const token = shape as ServerCircularToken;
        sh = new CircularToken(refPoint, token.radius, token.text, token.font, {
            fillColour: token.fill_colour,
            strokeColour: token.stroke_colour,
            uuid: token.uuid,
        });
    } else if (shape.type_ === "line") {
        const line = shape as ServerLine;
        sh = new Line(refPoint, toGP(line.x2, line.y2), {
            lineWidth: line.line_width,
            strokeColour: line.stroke_colour,
            uuid: line.uuid,
        });
    } else if (shape.type_ === "polygon") {
        const polygon = shape as ServerPolygon;
        sh = new Polygon(
            refPoint,
            polygon.vertices.map((v) => toGP(v)),
            {
                fillColour: polygon.fill_colour,
                strokeColour: polygon.stroke_colour,
                lineWidth: polygon.line_width,
                openPolygon: polygon.open_polygon,
                uuid: polygon.uuid,
            },
        );
    } else if (shape.type_ === "text") {
        const text = shape as ServerText;
        sh = new Text(refPoint, text.text, text.font_size, {
            fillColour: text.fill_colour,
            strokeColour: text.stroke_colour,
            uuid: text.uuid,
        });
    } else if (shape.type_ === "assetrect") {
        const asset = shape as ServerAsset;
        const img = new Image(asset.width, asset.height);
        if (asset.src.startsWith("http")) img.src = baseAdjust(new URL(asset.src).pathname);
        else img.src = baseAdjust(asset.src);
        sh = new Asset(img, refPoint, asset.width, asset.height, { uuid: asset.uuid });
        img.onload = () => {
            floorStore.getLayer(floorStore.getFloor({ name: shape.floor })!, shape.layer)!.invalidate(true);
        };
    } else if (shape.type_ === "togglecomposite") {
        const toggleComposite = shape as ServerToggleComposite;

        sh = new ToggleComposite(refPoint, toggleComposite.active_variant, toggleComposite.variants, {
            uuid: toggleComposite.uuid,
        });
        gameStore.addOwnedToken(sh.uuid);
    } else {
        return undefined;
    }
    sh.fromDict(shape);
    return sh;
}

export function copyShapes(): void {
    if (!selectionState.hasSelection) return;
    const clipboard: ServerShape[] = [];
    for (const shape of selectionState.get({ includeComposites: true })) {
        if (!shape.ownedBy(false, { editAccess: true })) continue;
        if (shape.groupId === undefined) {
            createNewGroupForShapes([shape.uuid]);
        }
        clipboard.push(shape.asDict());
    }
    gameStore.setClipboard(clipboard);
    gameStore.setClipboardPosition(clientStore.screenCenter);
}

export function pasteShapes(targetLayer?: LayerName): readonly Shape[] {
    const layer = floorStore.getLayer(floorStore.currentFloor.value!, targetLayer);
    if (!layer) return [];
    const gameState = gameStore.state;
    if (gameState.clipboard.length === 0) return [];

    selectionState.clear(false);

    gameStore.setClipboardPosition(clientStore.screenCenter);
    let offset = subtractP(clientStore.screenCenter, gameState.clipboardPosition);
    // Check against 200 as that is the squared length of a vector with size 10, 10
    if (offset.squaredLength() < 200) {
        offset = new Vector(10, 10);
    }

    const shapeMap: Map<string, string> = new Map();
    const composites: ServerToggleComposite[] = [];
    const serverShapes: ServerShape[] = [];

    for (const clip of gameState.clipboard) {
        const newShape: ServerShape = Object.assign({}, clip, { auras: [], labels: [], owners: [], trackers: [] });
        newShape.uuid = uuidv4();
        newShape.x = clip.x + offset.x;
        newShape.y = clip.y + offset.y;

        shapeMap.set(clip.uuid, newShape.uuid);

        if (clip.type_ === "polygon") {
            (newShape as ServerPolygon).vertices = (clip as ServerPolygon).vertices.map((p) => [
                p[0] + offset.x,
                p[1] + offset.y,
            ]);
        }

        // Trackers
        newShape.trackers = [];
        for (const tracker of clip.trackers) {
            const newTracker: ServerTracker = {
                ...tracker,
                uuid: uuidv4(),
            };
            newShape.trackers.push(newTracker);
        }

        // Auras
        newShape.auras = [];
        for (const aura of clip.auras) {
            const newAura: ServerAura = {
                ...aura,
                uuid: uuidv4(),
            };
            newShape.auras.push(newAura);
        }

        // Owners
        newShape.owners = [];
        for (const owner of clip.owners) {
            const newOwner: ServerShapeOwner = {
                ...owner,
                shape: newShape.uuid,
            };
            newShape.owners.push(newOwner);
        }

        // Badge
        if (clip.group !== undefined) {
            // We do not need to explicitly join the group as that will be done by createShape below
            // The shape is not yet added to the layerManager at this point anyway
            newShape.badge = generateNewBadge(clip.group);
        }
        if (clip.type_ === "togglecomposite") {
            composites.push(newShape as ServerToggleComposite);
        } else {
            serverShapes.push(newShape);
        }
    }

    for (const composite of composites) {
        composite.active_variant = shapeMap.get(composite.active_variant)!;
        composite.variants = composite.variants.map((v) => ({ ...v, uuid: shapeMap.get(v.uuid)! }));
        serverShapes.push(composite); // make sure it's added after the regular shapes
    }

    // Finalize
    for (const serverShape of serverShapes) {
        const shape = createShapeFromDict(serverShape);
        if (shape === undefined) continue;

        layer.addShape(shape, SyncMode.FULL_SYNC, InvalidationMode.WITH_LIGHT);
        if (!(shape.options.skipDraw ?? false)) selectionState.push(shape);
    }

    layer.invalidate(false);
    return selectionState.get({ includeComposites: false });
}

export function deleteShapes(shapes: readonly Shape[], sync: SyncMode): void {
    const removed: string[] = [];
    const recalculateIterative = visionState.state.mode === VisibilityMode.TRIANGLE_ITERATIVE;
    let recalculateVision = false;
    let recalculateMovement = false;
    for (let i = shapes.length - 1; i >= 0; i--) {
        const sel = shapes[i];
        if (sync !== SyncMode.NO_SYNC && !sel.ownedBy(false, { editAccess: true })) continue;
        removed.push(sel.uuid);
        if (sel.blocksVision) recalculateVision = true;
        if (sel.blocksMovement) recalculateMovement = true;
        sel.layer.removeShape(sel, SyncMode.NO_SYNC, recalculateIterative);
    }
    if (sync !== SyncMode.NO_SYNC) sendRemoveShapes({ uuids: removed, temporary: sync === SyncMode.TEMP_SYNC });
    if (!recalculateIterative) {
        if (recalculateMovement)
            visionState.recalculate({ target: TriangulationTarget.MOVEMENT, floor: floorStore.state.floorIndex });
        if (recalculateVision)
            visionState.recalculate({ target: TriangulationTarget.VISION, floor: floorStore.state.floorIndex });
        floorStore.invalidateVisibleFloors();
    }

    if (sync === SyncMode.FULL_SYNC) {
        addOperation({ type: "shaperemove", shapes: shapes.map((s) => s.asDict()) });
    }
}
