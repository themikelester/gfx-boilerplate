import { AvatarController } from "./AvatarController";
import { AvatarRender } from "./AvatarRender";
import { Renderer } from "./gfx/GfxTypes";
import { ResourceManager } from "./resources/ResourceLoading";
import { Clock } from "./Clock";
import { Camera } from "./Camera";
import { Object3D, Matrix4, Vector3 } from "./Object3D";
import { AnimationMixer } from "./Animation";
import { GltfResource, GltfNode } from "./resources/Gltf";
import { assertDefined, defined, defaultValue, assert } from "./util";
import { Skeleton, Bone } from "./Skeleton";
import { AvatarAnim } from "./AvatarAnim";
import { DebugMenu } from "./DebugMenu";
import { NetModuleServer } from "./net/NetModule";
import { NetClientState } from "./net/NetClient";
import { Weapon, WeaponSystem } from "./Weapon";
import { SimStream, SimState, EntityState, World, GameObjectType, GameObject, GameObjectFactory } from "./World";
import { vec3, mat4 } from "gl-matrix";
import { DebugRenderUtils } from "./DebugRender";
import { CollisionSystem, StaticCollisionSystem } from "./Collision";
import { kEmptyCommand, UserCommand } from "./UserCommand";
import { InputAction } from "./Input";
import { EnvironmentSystem } from "./Environment";
import { SideAttackBot } from "./AvatarBot";

interface ServerDependencies {
    debugMenu: DebugMenu;
    resources: ResourceManager;
    clock: Clock;
    world: World;

    collision: CollisionSystem;
    staticCollision: StaticCollisionSystem;
}

interface ClientDependencies {
    debugMenu: DebugMenu;
    resources: ResourceManager;
    clock: Clock;
    weapons: WeaponSystem;
    world: World;

    gfxDevice: Renderer;
    camera: Camera;
    environment: EnvironmentSystem;
}

export interface AvatarClient {
    getUserCommand(simFrame: number): UserCommand;
}

export class Avatar extends Object3D implements GameObject {
    state: EntityState;

    client: Nullable<AvatarClient>;
    local: boolean = false;

    nodes: GltfNode[];
    animationMixer: AnimationMixer;
    skeleton: Skeleton;

    bounds: mat4 = mat4.create();
    collisionId: number;
    weapon: Weapon;
    hitBy: GameObject[] = [];

    get isActive() {
        return this.state && (this.state.flags & AvatarFlags.IsActive) > 0;
    }
}

export enum AvatarFlags {
    IsActive = 1 << 0,
    IsWalking = 1 << 1,
    IsUTurning = 1 << 2,
}

export enum AvatarState {
    None,
    AttackSide,
    AttackVertical,
    AttackThrow,
    Struck
}

const kGltfFilename = 'data/Tn.glb';
const kAvatarCount = 8;
const kBaseObb = mat4.fromValues(
    40, 0, 0, 0,
    0, 110, 0, 0,
    0, 0, 40, 0,
    0, 110, 10, 1
);

const scratchMat4 = mat4.create();
const scratchVec3a = vec3.create();
const scratchVec3b = vec3.create();
const scratchVector3a = new Vector3(scratchVec3a);
const scratchVector3b = new Vector3(scratchVec3b);

export class AvatarSystemClient implements GameObjectFactory {
    public localAvatar: Avatar; // @HACK:

    private avatars: Avatar[] = [];

    private gltf: GltfResource;
    private animation = new AvatarAnim();
    private renderer: AvatarRender = new AvatarRender();

    constructor() {
        for (let i = 0; i < kAvatarCount; i++) {
            this.avatars[i] = new Avatar();
        }
        this.localAvatar = this.avatars[0];
    }

    initialize(game: ClientDependencies) {
        game.world.registerFactory(GameObjectType.Avatar, this);

        // Start loading all necessary resources
        game.resources.load(kGltfFilename, 'gltf', (error, resource) => {
            if (error) { return console.error(`Failed to load resource`, error); }
            this.gltf = resource as GltfResource;
            this.onResourcesLoaded(game);
        });

        this.animation.initialize(this.avatars);
        this.renderer.initialize(this.avatars, game.debugMenu);
    }

    onJoined(clientIndex: number) {
        this.localAvatar = this.avatars[clientIndex];
        this.localAvatar.local = true;
    }

    onResourcesLoaded(game: ClientDependencies) {
        for (const avatar of this.avatars) {
            // Clone all nodes
            avatar.nodes = this.gltf.nodes.map(src => src.clone(false));
            for (let i = 0; i < avatar.nodes.length; i++) {
                const src = this.gltf.nodes[i];
                const node = avatar.nodes[i];
                for (const child of src.children) {
                    const childIdx = this.gltf.nodes.indexOf(child as GltfNode);
                    node.add(avatar.nodes[childIdx]);
                }
            }

            // Assign the loaded scene graph to this Avatar object
            for (const rootNodeId of this.gltf.rootNodeIds.slice(0, 1)) {
                avatar.add(avatar.nodes[rootNodeId]);
            }

            // Create skeletons from the first GLTF skin
            const skin = assertDefined(this.gltf.skins[0]);
            const bones = skin.joints.map(jointId => avatar.nodes[jointId]); // @TODO: Loader should create these as Bones, not Object3Ds
            const ibms = skin.inverseBindMatrices?.map(ibm => new Matrix4().fromArray(ibm));
            avatar.skeleton = new Skeleton(bones as Object3D[] as Bone[], ibms);

            avatar.animationMixer = new AnimationMixer(avatar);
        }

        this.animation.onResourcesLoaded(this.gltf, game.debugMenu);
        this.renderer.onResourcesLoaded(this.gltf, game.gfxDevice);
    }

    update(game: ClientDependencies) {
        for (const avatar of this.avatars) {
            const state = avatar.state;
            if (!state || !avatar.nodes) continue;

            // Attach the weapon
            if (!avatar.weapon) {
                const weaponId = kAvatarCount + avatar.id;
                const weapon = game.world.objects[weaponId] as Weapon;

                avatar.weapon = weapon;
                const joint = assertDefined(avatar.nodes.find(n => n.name === 'j_tn_item_r1'));
                joint.add(avatar.weapon.transform);
            }

            const pos = new Vector3(state.origin);
            avatar.position.copy(pos);
            avatar.lookAt(
                state.origin[0] + state.orientation[0],
                state.origin[1] + state.orientation[1],
                state.origin[2] + state.orientation[2],
            )

            avatar.updateMatrix();
            avatar.updateMatrixWorld();
        }

        this.animation.update(game.clock);
    }

    updateFixed(game: ClientDependencies) {
        // @TODO: Prediction
    }

    render(game: ClientDependencies) {
        this.renderer.render(game.gfxDevice, game.camera, game.environment.getCurrentEnvironment());
    }

    createGameObject(initialState: EntityState) {
        const avatarIdx = initialState.id;
        assert(avatarIdx < kAvatarCount);

        const avatar = this.avatars[avatarIdx];
        avatar.state = initialState;

        return avatar;
    }

    deleteGameObject() {

    }
}

export class AvatarSystemServer implements GameObjectFactory {
    private avatars: Avatar[] = [];
    private controllers: AvatarController[] = [];

    private gltf: GltfResource;
    private animation = new AvatarAnim();

    initialize(game: ServerDependencies) {
        game.world.registerFactory(GameObjectType.Avatar, this);

        const baseline: Partial<EntityState> = { orientation: vec3.fromValues(0, 0, 1) };

        for (let i = 0; i < kAvatarCount; i++) {
            this.avatars[i] = game.world.createGameObject(GameObjectType.Avatar, baseline) as Avatar;
        }

        for (let i = 0; i < kAvatarCount; i++) {
            this.avatars[i].weapon = game.world.createGameObject(GameObjectType.Weapon, { parent: i }) as Weapon;
        }

        // Start loading all necessary resources
        game.resources.load(kGltfFilename, 'gltf', (error, resource) => {
            if (error) { return console.error(`Failed to load resource`, error); }
            this.gltf = resource as GltfResource;
            this.onResourcesLoaded(game);
        });

        this.animation.initialize(this.avatars);

        // Let's add a bot
        this.addAvatar(new SideAttackBot());
    }

    onResourcesLoaded(game: ServerDependencies) {
        for (const avatar of this.avatars) {
            // Clone all nodes
            avatar.nodes = this.gltf.nodes.map(src => src.clone(false));
            for (let i = 0; i < avatar.nodes.length; i++) {
                const src = this.gltf.nodes[i];
                const node = avatar.nodes[i];
                for (const child of src.children) {
                    const childIdx = this.gltf.nodes.indexOf(child as GltfNode);
                    node.add(avatar.nodes[childIdx]);
                }
            }

            // Assign the loaded scene graph to this Avatar object
            for (const rootNodeId of this.gltf.rootNodeIds.slice(0, 1)) {
                avatar.add(avatar.nodes[rootNodeId]);
            }

            // Create skeletons from the first GLTF skin
            const skin = assertDefined(this.gltf.skins[0]);
            const bones = skin.joints.map(jointId => avatar.nodes[jointId]); // @TODO: Loader should create these as Bones, not Object3Ds
            const ibms = skin.inverseBindMatrices?.map(ibm => new Matrix4().fromArray(ibm));
            avatar.skeleton = new Skeleton(bones as Object3D[] as Bone[], ibms);

            // Attach the weapon
            const joint = assertDefined(avatar.nodes.find(n => n.name === 'j_tn_item_r1'));
            joint.add(avatar.weapon.transform);

            avatar.animationMixer = new AnimationMixer(avatar);
        }

        this.animation.onResourcesLoaded(this.gltf, game.debugMenu);
    }

    update(game: ServerDependencies) {
        // const states = game.displaySnapshot.avatars;

        // for (let i = 0; i < kAvatarCount; i++) {
        //     const avatar = this.avatars[i];
        //     const state = states[i];

        //     avatar.active = !!(state.flags & AvatarFlags.IsActive);

        //     const pos = new Vector3(state.pos);
        //     avatar.position.copy(pos);
        //     avatar.lookAt(
        //         state.pos[0] + state.orientation[0],
        //         state.pos[1] + state.orientation[1],
        //         state.pos[2] + state.orientation[2],
        //     )

        //     avatar.updateMatrix();
        //     avatar.updateMatrixWorld();
        // }

        // this.animation.update(states, game.clock.renderDt / 1000.0);
    }

    updateFixed(game: ServerDependencies) {
        for (let i = 0; i < kAvatarCount; i++) {
            const avatar = this.avatars[i];
            const state = avatar.state;

            if (!avatar.isActive) continue;

            const inputCmd = avatar.client!.getUserCommand(game.clock.simFrame);

            // Update core state
            const dtSec = game.clock.simDt / 1000.0;
            this.controllers[i].update(avatar, this.avatars, game.clock.simFrame, dtSec, inputCmd);

            // Sync state changes with GameObject
            const pos = new Vector3(state.origin);
            avatar.position.copy(pos);
            avatar.lookAt(
                state.origin[0] + state.orientation[0],
                state.origin[1] + state.orientation[1],
                state.origin[2] + state.orientation[2],
            )

            avatar.updateMatrix();
            avatar.updateMatrixWorld();
        }

        // Update skeleton joint positions
        this.animation.update(game.clock);

        for (let i = 0; i < kAvatarCount; i++) {
            const avatar = this.avatars[i];
            const state = avatar.state;

            if (!avatar.isActive || !avatar.skeleton) continue;

            const headBone = assertDefined(avatar.skeleton.getBoneByName('j_tn_atama1'));
            const rootBone = assertDefined(avatar.skeleton.getBoneByName('j_tn_kosi1'));
            const leftFoot = assertDefined(avatar.skeleton.getBoneByName('j_tn_asi_l3'));
            const rightFoot = assertDefined(avatar.skeleton.getBoneByName('j_tn_asi_r3'));

            headBone?.getWorldPosition(scratchVector3a);
            rootBone?.getWorldPosition(scratchVector3b);
            const a = scratchVector3a.buffer;
            const b = scratchVector3b.buffer;

            // Check for ground collisions
            const footHeight = Math.min(leftFoot.matrixWorld.elements[13], rightFoot.matrixWorld.elements[13]) - 10.0;
            const groundHeight = game.staticCollision.groundHeight(b, 1000);
            if (footHeight < groundHeight) state.origin[1] += groundHeight - footHeight;

            // Check for wall collisions
            const wallOut = scratchVec3a;
            if (game.staticCollision.wallCheck({ a, b, radius: 60 }, wallOut)) {
                vec3.add(state.origin, state.origin, wallOut);
            }

            // Register bounds with the collision system
            (scratchMat4 as Float32Array).set(avatar.matrixWorld.elements);
            mat4.multiply(avatar.bounds, scratchMat4, kBaseObb);
            avatar.collisionId = game.collision.addTargetObb(avatar.bounds, avatar);

            // And register attacks as well
            if (state.state === AvatarState.AttackSide || state.state === AvatarState.AttackVertical) {
                game.collision.addAttackRegion({ verts: avatar.weapon.attackQuad }, avatar.weapon);
            }
        }
    }

    updateFixedLate({ collision, clock }: { collision: CollisionSystem, clock: Clock }) {
        // Once all the avatar positions have been fully resolved, check for hits
        for (const avatar of this.avatars) {
            if (avatar.isActive && avatar.skeleton) {
                const hits = collision.getHitsForTarget(avatar.collisionId);
                if (hits.length > 0) {
                    if (avatar.state.state !== AvatarState.Struck) {
                        avatar.state.state = AvatarState.Struck;
                        avatar.state.stateStartFrame = clock.simFrame;
                    }

                    for (const hit of hits) {
                        const weapon = hit.owner;

                        // Don't allow consecutive hits by the same weapon
                        const alreadyHit = avatar.hitBy.includes(weapon);
                        if (!alreadyHit) {
                            avatar.hitBy.push(weapon);

                            // TODO: Apply damage, etc.
                        }
                    }
                }
            }
        }
    }

    createGameObject(initialState: EntityState) {
        const avatar = new Avatar();
        avatar.state = initialState;

        const avatarIdx = this.avatars.length;
        this.controllers[avatarIdx] = new AvatarController();
        this.avatars[avatarIdx] = avatar;

        return avatar;
    }

    deleteGameObject() {

    }

    addAvatar(client: AvatarClient) {
        // @TODO: Take over a bot slot?
        const avatarIdx = assertDefined(this.avatars.findIndex(a => !a.isActive), 'Out of avatars');
        this.avatars[avatarIdx].state.flags |= AvatarFlags.IsActive;
        this.avatars[avatarIdx].client = client;
        return avatarIdx;
    }

    removeAvatar(client: AvatarClient) {
        const avatar = assertDefined(this.avatars.find(a => a.client === client));
        avatar.client = null;
        avatar.state.flags &= ~AvatarFlags.IsActive;
    }
}