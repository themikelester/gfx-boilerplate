import { mat4, vec3 } from "gl-matrix";
import { intersectAabbTriangle } from "./Intersection";
import { GameObject } from "./World";
import { assert } from "./util";
import { DebugRenderUtils } from "./DebugRender";

export class Obb {
  center: vec3 = vec3.create();
  bases: vec3[] = [vec3.create(), vec3.create(), vec3.create()];
  halfLengths: vec3 = vec3.create();

  setFromMatrix(obb: mat4) {
    mat4.getTranslation(this.center, obb);
    vec3.set(this.bases[0], obb[0], obb[1], obb[2]);
    vec3.set(this.bases[1], obb[4], obb[5], obb[6]);
    vec3.set(this.bases[2], obb[8], obb[9], obb[10]);
    this.halfLengths[0] = vec3.length(this.bases[0]);
    this.halfLengths[1] = vec3.length(this.bases[1]);
    this.halfLengths[2] = vec3.length(this.bases[2]);
    vec3.scale(this.bases[0], this.bases[0], 1.0 / this.halfLengths[0]);
    vec3.scale(this.bases[1], this.bases[1], 1.0 / this.halfLengths[1]);
    vec3.scale(this.bases[2], this.bases[2], 1.0 / this.halfLengths[2]);
    return this;
  }

  toMatrix(obb: mat4) {
    mat4.set(obb, 
      this.halfLengths[0] * this.bases[0][0], this.halfLengths[0] * this.bases[0][1], this.halfLengths[0] * this.bases[0][2], 0,
      this.halfLengths[1] * this.bases[1][0], this.halfLengths[1] * this.bases[1][1], this.halfLengths[1] * this.bases[1][2], 0,
      this.halfLengths[2] * this.bases[2][0], this.halfLengths[2] * this.bases[2][1], this.halfLengths[2] * this.bases[2][2], 0,
      this.center[0], this.center[1], this.center[2], 1 
    );
    return obb;
  }

  /**
   * Construct a matrix that will transform a point into OBB space (no scale)
   * This is the inverse of the OBB's matrix representation, but using unit vectors instead of half extents.
   * @NOTE: In this space, this OBB can be represented as an AABB centered on the origin with equivalent half lengths.
   */
  createWorldToObbMatrix(result: mat4) {
    const dotCU = vec3.dot(this.center, this.bases[0]);
    const dotCV = vec3.dot(this.center, this.bases[1]);
    const dotCW = vec3.dot(this.center, this.bases[2]);

    mat4.set(result,
      this.bases[0][0], this.bases[1][0], this.bases[2][0], 0,
      this.bases[0][1], this.bases[1][1], this.bases[2][1], 0,
      this.bases[0][2], this.bases[1][2], this.bases[2][2], 0,
      -dotCU, -dotCV, -dotCW, 1,
    );

    return result;
  }
}

export interface Aabb {
  center: vec3,
  halfLengths: vec3
}

export interface Line {
  center: vec3,
  extent: vec3
}

export interface Ray {
  origin: vec3,
  dir: vec3,
  length?: number,
}

export interface Quad {
  verts: vec3[]
}

export interface HitResult {
  owner: GameObject;
  pos: vec3;
}

const kHitCacheSize = 8;

const scratchMat4 = mat4.create();
const scratchVec3a = vec3.create();
const scratchVec3b = vec3.create();
const scratchVec3c = vec3.create();
const scratchVec3d = vec3.create();
const scratchAabb: Aabb = {
  center: vec3.create(),
  halfLengths: vec3.create(),
}

export class CollisionSystem {
  attacks: Quad[] = [];
  attackOwners: GameObject[] = [];

  targets: Obb[] = [];
  targetOwners: GameObject[] = [];

  private hitCache: vec3[] = [];

  constructor() {
    for (let i = 0; i < kHitCacheSize; i++) {
      this.hitCache[i] = vec3.create();
    }
  }

  addAttackRegion(quad: Quad, owner: GameObject) {
    this.attacks.push(quad);
    this.attackOwners.push(owner);
  }

  addTargetObb(obb: Obb | mat4, owner: GameObject) {
    if (!(obb instanceof Obb)) {
      obb = new Obb().setFromMatrix(obb);
    }

    const colId = this.targets.length;
    this.targets.push(obb);
    this.targetOwners.push(owner);

    return colId;
  }

  getHitsForTarget(colId: number): HitResult[] {
    const obb = this.targets[colId];
    const hits: HitResult[] = [];
    let hitIdx = 0;
  
    const worldToObbBasis = obb.createWorldToObbMatrix(scratchMat4);

    for (let i = 0; i < this.attacks.length; i++) {
      const quad = this.attacks[i];

      // Transform triangles into OBB space
      const a = vec3.transformMat4(scratchVec3a, quad.verts[0], worldToObbBasis);
      const b = vec3.transformMat4(scratchVec3b, quad.verts[1], worldToObbBasis);
      const c = vec3.transformMat4(scratchVec3c, quad.verts[2], worldToObbBasis);
      const d = vec3.transformMat4(scratchVec3d, quad.verts[3], worldToObbBasis);

      // Re-oriented OBB sitting at the origin
      const aabb = scratchAabb;
      aabb.halfLengths = obb.halfLengths;

      let hit = intersectAabbTriangle(aabb, a, b, c);
      if (!hit) hit = intersectAabbTriangle(aabb, b, c, d);

      if (hit) { 
        assert(hitIdx < kHitCacheSize, 'Too many hits in one frame');
        const hitPos = this.hitCache[hitIdx++]; // @TODO
        hits.push({ owner: this.attackOwners[i], pos: hitPos });
      }
    }

    return hits;
  }

  clear() {  
    this.attacks.length = 0;
    this.targets.length = 0;
    this.attackOwners.length = 0;
    this.targetOwners.length = 0;
  }

  debugRender() {
    const obbs = this.targets.map(t => t.toMatrix(mat4.create()));
    const quads = [];

    for (const attack of this.attacks) {
      quads.push(attack.verts[0], attack.verts[1], attack.verts[2], attack.verts[3]);
    }

    DebugRenderUtils.renderObbs(obbs.slice(0,1));
    DebugRenderUtils.renderQuads(quads);
  }
}