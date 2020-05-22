import { mat4, vec3 } from "gl-matrix";
import { intersectObbRay, intersectObbTriangle } from "./Intersection";
import { GameObject } from "./World";
import { defined, assert, defaultValue } from "./util";
import { DebugRenderUtils } from "./DebugRender";

export class Obb {
  center: vec3 = vec3.create();
  bases: vec3[] = [vec3.create(), vec3.create(), vec3.create()];
  halfLengths: number[] = [0, 0, 0];

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
}

export interface Aabb {
  center: vec3,
  extents: vec3
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
    
    for (let i = 0; i < this.attacks.length; i++) {
      const quad = this.attacks[i];
      let hit = intersectObbTriangle(obb, quad.verts[0], quad.verts[1], quad.verts[2]);
      if (!hit) hit = intersectObbTriangle(obb, quad.verts[1], quad.verts[2], quad.verts[3]);

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