import { computed, reactive } from "vue";
import type { ComputedRef, DeepReadonly } from "vue";

import { SyncTo } from "../../../core/models/types";
import { clientStore } from "../../../store/client";
import { floorStore } from "../../../store/floor";
import { gameStore } from "../../../store/game";
import { settingsStore } from "../../../store/settings";
import { getGlobalId, getShape } from "../../id";
import type { LocalId } from "../../id";

import { sendShapeAddOwner, sendShapeDeleteOwner, sendShapeUpdateDefaultOwner, sendShapeUpdateOwner } from "./emits";
import { accessToServer, ownerToServer } from "./helpers";
import { DEFAULT_ACCESS, DEFAULT_ACCESS_SYMBOL } from "./models";
import type { ACCESS_KEY } from "./models";
import type { ShapeAccess, ShapeOwner } from "./models";

interface AccessState {
    id: LocalId | undefined;
    defaultAccess: ShapeAccess;
    playerAccess: Map<string, ShapeAccess>;
}

type AccessMap = Map<ACCESS_KEY, ShapeAccess>;

class AccessSystem {
    // If a LocalId is NOT in the access map,
    // it is assumed to have default access settings
    // this is the case for the vast majority of shapes
    // and would thus just waste memory
    private access: Map<LocalId, AccessMap> = new Map();

    // REACTIVE

    private _state: AccessState;
    $: {
        hasEditAccess: ComputedRef<boolean>;
        owners: ComputedRef<string[]>;
    };

    constructor() {
        this._state = reactive({
            id: undefined,
            defaultAccess: DEFAULT_ACCESS,
            playerAccess: new Map(),
        });

        this.$ = {
            hasEditAccess: computed(() => {
                if (this._state.id === undefined) return false;
                if (gameStore.state.isDm) return true;
                if (gameStore.state.isFakePlayer && gameStore.activeTokens.value.has(this._state.id)) return true;
                if (this._state.defaultAccess.edit) return true;
                const username = clientStore.state.username;
                return [...this._state.playerAccess.entries()].some(([u, a]) => u === username && a.edit === true);
            }),
            owners: computed(() => {
                if (this._state.id === undefined) return [];
                return [...this._state.playerAccess.keys()];
            }),
        };
    }

    get state(): DeepReadonly<AccessState> {
        return this._state;
    }

    loadState(id: LocalId): void {
        this._state.id = id;
        this._state.playerAccess.clear();
        for (const [user, access] of this.access.get(id) ?? []) {
            if (user === DEFAULT_ACCESS_SYMBOL) {
                this._state.defaultAccess = { ...access };
            } else {
                this._state.playerAccess.set(user, { ...access });
            }
        }
    }

    dropState(): void {
        this._state.id = undefined;
    }

    // BEHAVIOUR

    // Inform the system about the state of a certain LocalId
    inform(id: LocalId, defaultAccess: ShapeAccess, extraAccess: ShapeOwner[]): void {
        const access: AccessMap = new Map();

        // Default Access
        if (defaultAccess.edit || defaultAccess.movement || defaultAccess.vision) {
            access.set(DEFAULT_ACCESS_SYMBOL, defaultAccess);
            if (this._state.id === id) {
                this._state.defaultAccess = defaultAccess;
            }
        } else {
            access.delete(DEFAULT_ACCESS_SYMBOL);
            if (this._state.id === id) {
                this._state.defaultAccess = defaultAccess;
            }
        }

        // Player Access
        for (const extra of extraAccess) {
            access.set(extra.user, extra.access);
            if (this._state.id === id) {
                this._state.playerAccess.set(extra.user, extra.access);
            }
        }

        // Commit
        if (access.size > 0) {
            this.access.set(id, access);
        }
    }

    getDefault(id: LocalId): DeepReadonly<ShapeAccess> {
        return this.access.get(id)?.get(DEFAULT_ACCESS_SYMBOL) ?? DEFAULT_ACCESS;
    }

    hasAccessTo(
        id: LocalId,
        limitToActiveTokens: boolean,
        options: Partial<{ editAccess: boolean; visionAccess: boolean; movementAccess: boolean }>,
    ): boolean {
        if (gameStore.state.isDm) return true;

        const shape = getShape(id);
        if (shape === undefined) return false;

        if (shape.isToken && limitToActiveTokens) {
            if (!gameStore.activeTokens.value.has(id)) {
                return false;
            }
        }

        if (gameStore.state.isFakePlayer) return true;

        const access = this.access.get(id);
        if (access === undefined) return false;

        const defaultAccess = access.get(DEFAULT_ACCESS_SYMBOL) ?? DEFAULT_ACCESS;

        if (
            ((options.editAccess ?? false) && defaultAccess.edit) ||
            ((options.movementAccess ?? false) && defaultAccess.movement) ||
            ((options.visionAccess ?? false) && defaultAccess.vision)
        ) {
            return true;
        }

        const userAccess = access.get(clientStore.state.username);
        if (userAccess === undefined) return false;

        return (
            (options.editAccess ?? false ? userAccess.edit : true) &&
            (options.movementAccess ?? false ? userAccess.movement : true) &&
            (options.visionAccess ?? false ? userAccess.vision : true)
        );
    }

    getAccess(shapeId: LocalId, user: ACCESS_KEY): DeepReadonly<ShapeAccess> | undefined {
        return this.access.get(shapeId)?.get(user);
    }

    addAccess(shapeId: LocalId, user: string, access: Partial<ShapeAccess>, syncTo: SyncTo): void {
        if (this.access.get(shapeId)?.has(user) === true) {
            console.error("[ACCESS] Attempt to add access for user with access");
            return;
        }

        const userAccess = { ...DEFAULT_ACCESS, ...access };

        const shapeMap: AccessMap = new Map();
        shapeMap.set(user, userAccess);
        this.access.set(shapeId, shapeMap);

        if (syncTo === SyncTo.SERVER) {
            sendShapeAddOwner(
                ownerToServer({
                    access: userAccess,
                    user,
                    shape: shapeId,
                }),
            );
        }

        if (this._state.id === shapeId) {
            this._state.playerAccess.set(user, userAccess);
        }

        // todo: some sort of event register instead of calling these other systems manually ?
        if (userAccess.vision && user === clientStore.state.username) {
            const shape = getShape(shapeId);
            if (shape !== undefined && shape.isToken) {
                gameStore.addOwnedToken(shapeId);
            }
        }

        if (settingsStore.fowLos.value) floorStore.invalidateLightAllFloors();
    }

    updateAccess(shapeId: LocalId, user: ACCESS_KEY, access: Partial<ShapeAccess>, syncTo: SyncTo): void {
        if (user !== DEFAULT_ACCESS_SYMBOL && this.access.get(shapeId)?.has(user) !== true) {
            console.error("[ACCESS] Attempt to update access for user without access");
            return;
        }

        const oldAccess = this.access.get(shapeId)!.get(user) ?? DEFAULT_ACCESS;

        // Check owned-token changes
        if (
            access.vision !== undefined &&
            access.vision !== oldAccess.vision &&
            (user === clientStore.state.username || user === DEFAULT_ACCESS_SYMBOL)
        ) {
            const shape = getShape(shapeId);
            if (shape !== undefined && shape.isToken) {
                if (access.vision) {
                    gameStore.addOwnedToken(shapeId);
                } else {
                    gameStore.removeOwnedToken(shapeId);
                }
            }
        }

        // Commit to state
        const newAccess = { ...oldAccess, ...access };
        this.access.get(shapeId)!.set(user, newAccess);

        if (this._state.id === shapeId) {
            if (user === DEFAULT_ACCESS_SYMBOL) {
                this._state.defaultAccess = newAccess;
            } else {
                this._state.playerAccess.set(user, newAccess);
            }
        }

        if (syncTo === SyncTo.SERVER) {
            if (user === DEFAULT_ACCESS_SYMBOL) {
                sendShapeUpdateDefaultOwner({ ...accessToServer(newAccess), shape: getGlobalId(shapeId) });
            } else {
                sendShapeUpdateOwner(
                    ownerToServer({
                        access: newAccess,
                        user,
                        shape: shapeId,
                    }),
                );
            }
        }

        if (settingsStore.fowLos.value) floorStore.invalidateLightAllFloors();
    }

    removeAccess(shapeId: LocalId, user: string, syncTo: SyncTo): void {
        if (this.access.get(shapeId)?.has(user) !== true) {
            console.error("[ACCESS] Attempt to remove access for user without access");
            return;
        }

        const oldAccess = this.access.get(shapeId)!.get(user)!;
        this.access.get(shapeId)!.delete(user);

        if (syncTo === SyncTo.SERVER) {
            sendShapeDeleteOwner({
                user,
                shape: getGlobalId(shapeId),
            });
        }

        if (this._state.id === shapeId) {
            this._state.playerAccess.delete(user);
        }

        if (oldAccess.vision && user === clientStore.state.username) {
            gameStore.removeOwnedToken(shapeId);
        }

        if (settingsStore.fowLos.value) floorStore.invalidateLightAllFloors();
    }

    getOwners(id: LocalId): DeepReadonly<string[]> {
        return [...(this.access.get(id)?.keys() ?? [])].filter((user) => user !== DEFAULT_ACCESS_SYMBOL) as string[];
    }

    getOwnersFull(id: LocalId): DeepReadonly<ShapeOwner[]> {
        return [...(this.access.get(id)?.entries() ?? [])]
            .filter(([user]) => user !== DEFAULT_ACCESS_SYMBOL)
            .map(([user, access]) => ({
                access,
                user: user as string,
                shape: id,
            }));
    }
}

export const accessSystem = new AccessSystem();
(window as any).accessSystem = accessSystem;
