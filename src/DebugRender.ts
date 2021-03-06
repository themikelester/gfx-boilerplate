import { UniformBuffer, computePackedBufferLayout } from './UniformBuffer';
import * as Gfx from './gfx/GfxTypes';
import { vec3, vec4, mat4, mat3 } from 'gl-matrix';
import { GlobalUniforms } from './GlobalUniforms';
import { defined, assert } from './util';
import { RenderPrimitive } from './RenderPrimitive';
import { renderLists } from './RenderList';

// ----------------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------------
const renderFormatBlending: Gfx.RenderFormat = { blendingEnabled: true, srcBlendFactor: Gfx.BlendFactor.Source, dstBlendFactor: Gfx.BlendFactor.OneMinusSource };
const renderFormatNoBlending: Gfx.RenderFormat = { blendingEnabled: false };

// ----------------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------------
class Primitive {
  shader: Gfx.Id;
  pipeline: Gfx.Id;
  resources: Gfx.Id;
  vertTable: Gfx.Id;
  indexBuffer: Gfx.Id;
  vertexBuffer: Gfx.Id;
  depthState: Gfx.Id;
  uniforms: UniformBuffer;

  indexCount: number;

  count: number = 0;
}

interface PrimitiveDescriptor extends Gfx.ShaderDescriptor {
    vertexLayout: Gfx.VertexLayout;
    resourceLayout: Gfx.ShaderResourceLayout;
}

// ----------------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------------
const kMaxPoints = 32 * 1024;
const kMaxObbs = 32;
const kMaxSpheres = 32;
const kMaxQuads = 32;

const defaultObbColor = vec4.fromValues(1, 0, 0, 1);
const defaultLineColor = vec4.fromValues(0, 1, 0, 1);
const defaultSphereColor = vec4.fromValues(0, 0, 1, 1);

const obbPrim = {} as Primitive;
const frustumPrim = {} as Primitive;
const pointsPrim = {} as Primitive;
const spherePrim = {} as Primitive;
const quadsPrim = {} as Primitive;

export namespace DebugColor {
  export const Red = vec4.fromValues(1, 0, 0, 1);
  export const Green = vec4.fromValues(0, 1, 0, 1);
  export const Blue = vec4.fromValues(0, 0, 1, 1);
  export const Yellow = vec4.fromValues(1, 1, 0, 1);
  export const Purple = vec4.fromValues(1, 0, 1, 1);
  export const Orange = vec4.fromValues(0, 1, 1, 1);
  export const White = vec4.fromValues(1, 1, 1, 1);
  export const Black = vec4.fromValues(0, 0, 0, 1);
}

// ----------------------------------------------------------------------------------
// Scratch
// ----------------------------------------------------------------------------------
const mat3Scratch = mat3.create();
const mat4Scratch = new Float32Array(16);
const vec3Scratch = vec3.create();
const floatScratch = new Float32Array(kMaxPoints * 6);

// ----------------------------------------------------------------------------------
// Shaders
// ----------------------------------------------------------------------------------
const obbVs = `
  precision highp float;

  attribute vec3 a_pos;

  uniform mat3 u_extents;
  uniform vec3 u_center;

  uniform mat4 g_viewProj;

  void main()
  {
    vec3 pos = u_center + u_extents * a_pos;
    gl_Position = g_viewProj * vec4(pos, 1.0);
  }
`;

const frustumVs = `
  precision highp float;

  attribute vec3 a_pos;

  uniform mat4 u_invViewProjRelativeToEye;
  uniform vec3 u_camPosHigh;
  uniform vec3 u_camPosLow;

  uniform mat4 g_viewProjRelativeToEye;
  uniform vec3 g_camPosHigh;
  uniform vec3 g_camPosLow;

  void main()
  {
    // Un-project back to world space
    vec4 worldPosRelativeToEye = u_invViewProjRelativeToEye * vec4(a_pos, 1.0);
    worldPosRelativeToEye /= worldPosRelativeToEye.w;

    // The position is relative to the old eye, transform it to the new eye space
    vec3 camDiffHigh = u_camPosHigh - g_camPosHigh;
    vec3 camDiffLow = u_camPosLow - g_camPosLow;
    worldPosRelativeToEye.xyz += camDiffHigh + camDiffLow;

    gl_Position = g_viewProjRelativeToEye * worldPosRelativeToEye;
  }
`;

const pointsVs = `
  precision highp float;

  attribute vec3 a_pos;
  attribute vec4 a_color;

  uniform mat4 g_viewProj;

  varying lowp vec4 v_color;

  void main()
  {
    v_color = a_color;

    gl_Position = g_viewProj * vec4(a_pos, 1.0);
    gl_PointSize = 4.0;
  }
`;

const vertColorFs = `
  precision mediump float;
  varying lowp vec4 v_color;

  void main()
  {
    gl_FragColor = v_color;
  }
`;

const sphereVs = `
  precision highp float;

  attribute vec3 a_pos;

  // Instanced
  attribute vec3 a_origin;
  attribute float a_radius;
  attribute vec4 a_color;

  uniform mat4 g_viewProj;

  varying lowp vec4 v_color;

  void main()
  {
    v_color = a_color;

    vec3 pos = a_origin + a_radius * a_pos;
    gl_Position = g_viewProj * vec4(pos, 1.0);
  }
`;

const colorFs = `
  precision mediump float;
  uniform lowp vec4 u_color;

  void main()
  {
    gl_FragColor = u_color;
  }
`;

// ----------------------------------------------------------------------------------
// DebugRenderUtils
// ----------------------------------------------------------------------------------
export class DebugRenderUtils {
  static renderer: Gfx.Renderer;
  static globalUniforms: GlobalUniforms;

  static shapes: Record<string, Primitive> = {};
  static depthDisabled: Gfx.Id;

  static setContext(renderer: Gfx.Renderer, globalUniforms: GlobalUniforms) {
    this.renderer = renderer;
    this.globalUniforms = globalUniforms;
  }

  static createShape(shader: PrimitiveDescriptor, maxCount: number, vertices: number[], indices: number[], depthTest: boolean) {
    const prim = {} as Primitive;
    prim.shader = this.renderer.createShader(shader);
    prim.pipeline = this.renderer.createRenderPipeline(prim.shader, renderFormatBlending, shader.vertexLayout, shader.resourceLayout);
    prim.resources = this.renderer.createResourceTable(shader.resourceLayout);
    prim.vertTable = this.renderer.createVertexTable(prim.pipeline);
    prim.depthState = this.depthDisabled;
    prim.indexBuffer = this.renderer.createBuffer('ShapeIndices', Gfx.BufferType.Index, Gfx.Usage.Static, new Uint16Array(indices));
    prim.indexCount = indices.length;
    prim.count = 0;

    // Instance data
    if (shader.vertexLayout.buffers[1]) {
      prim.vertexBuffer = this.renderer.createBuffer('ShapeInstances', Gfx.BufferType.Vertex, Gfx.Usage.Dynamic, 
        maxCount * shader.vertexLayout.buffers[1].stride);
    }

    // Static vertices
    const vertBuffer = this.renderer.createBuffer('QuadVerts', Gfx.BufferType.Vertex, Gfx.Usage.Static, new Float32Array(vertices));
    this.renderer.setVertexBuffer(prim.vertTable, 0, { buffer: vertBuffer });
    this.renderer.setVertexBuffer(prim.vertTable, 1, { buffer: prim.vertexBuffer });

    this.renderer.setBuffer(prim.resources, 0, this.globalUniforms.bufferView);

    return prim;
  }

  /** Lazy initialization so that we don't waste time compiling shaders during production (unless we need to) */
  private static initialize() {
    //    6 - 7   Vertex Layout 
    //   /   /|    
    //  2 - 3 5   Y Z
    //  |   |/    |/
    //  0 - 1     * - X
    const unitCubeVerts = new Float32Array([
      -1, -1, -1,
      1, -1, -1,
      -1, 1, -1,
      1, 1, -1,

      -1, -1, 1,
      1, -1, 1,
      -1, 1, 1,
      1, 1, 1,
    ]);
    const unitCubeVertBuf = this.renderer.createBuffer('ObbVerts', Gfx.BufferType.Vertex, Gfx.Usage.Static, unitCubeVerts);

    const unitCubeIndices = new Uint16Array([
      // Lines
      0, 1, 1, 3, 3, 2, 2, 0, // Front face
      0, 4, 1, 5, 3, 7, 2, 6, // Front to Back edges
      4, 5, 5, 7, 7, 6, 6, 4, // Back face

      // Face triangles (CW)
      0, 2, 1, 1, 2, 3, // Front face
      1, 3, 5, 5, 3, 7, // Right face
      4, 6, 0, 0, 6, 2, // Left face
      2, 6, 3, 3, 6, 7, // Top face
      4, 0, 5, 5, 0, 1, // Bottom face
      5, 7, 4, 4, 7, 6, // Back face
    ]);
    const unitCubeIdxBuf = this.renderer.createBuffer('ObbIndices', Gfx.BufferType.Index, Gfx.Usage.Static, unitCubeIndices);

    const quadIndices: number[] = []
    for (let q = 0; q < kMaxQuads; q++) {
      const i = q * 4;
      quadIndices.push(
        i + 0, i + 1, i + 2,
        i + 2, i + 1, i + 3,
      );
    }
    const quadIdxBuf = this.renderer.createBuffer('QuadIndices', Gfx.BufferType.Index, Gfx.Usage.Static, new Uint16Array(quadIndices));

    const unitCubeVertLayout: Gfx.BufferLayout = { a_pos: { type: Gfx.Type.Float3, offset: 0 } };
    const unitCubeVertBufLayout: Gfx.VertexLayout = { buffers: [{ stride: 4 * 3, layout: unitCubeVertLayout }] };

    const depthTestWrite = this.renderer.createDepthStencilState({ depthTestEnabled: true, depthWriteEnabled: true });
    const depthDisabled = this.renderer.createDepthStencilState({ depthTestEnabled: false, depthWriteEnabled: false });

    // ----------------------------------------------------------------------------------
    // Oriented Bounding Box
    // ----------------------------------------------------------------------------------
    class ObbShader implements Gfx.ShaderDescriptor {
      static uniformLayout: Gfx.BufferLayout = computePackedBufferLayout({
        u_extents: { type: Gfx.Type.Float3x3 },
        u_center: { type: Gfx.Type.Float3 },
        u_color: { type: Gfx.Type.Float4 },
      });

      static resourceLayout = {
        uniforms: { index: 0, type: Gfx.BindingType.UniformBuffer, layout: ObbShader.uniformLayout },
        globalUniforms: { index: 1, type: Gfx.BindingType.UniformBuffer, layout: GlobalUniforms.bufferLayout },
      };

      name = 'Obb';
      vertSource = obbVs;
      fragSource = colorFs;
      resourceLayout = ObbShader.resourceLayout;
    }

    obbPrim.shader = this.renderer.createShader(new ObbShader());
    obbPrim.pipeline = this.renderer.createRenderPipeline(obbPrim.shader, renderFormatNoBlending, unitCubeVertBufLayout, ObbShader.resourceLayout);
    obbPrim.resources = this.renderer.createResourceTable(ObbShader.resourceLayout);
    obbPrim.vertTable = this.renderer.createVertexTable(obbPrim.pipeline);
    obbPrim.depthState = depthTestWrite;
    obbPrim.uniforms = new UniformBuffer('ObbUniforms', this.renderer, ObbShader.uniformLayout);
    obbPrim.indexBuffer = unitCubeIdxBuf;
    obbPrim.count = 0;

    this.renderer.setVertexBuffer(obbPrim.vertTable, 0, { buffer: unitCubeVertBuf });
    this.renderer.setBuffer(obbPrim.resources, 0, obbPrim.uniforms.getBufferView());
    this.renderer.setBuffer(obbPrim.resources, 1, this.globalUniforms.bufferView);

    // ----------------------------------------------------------------------------------
    // Frustum
    // ----------------------------------------------------------------------------------
    // class FrustumShader implements Gfx.ShaderDescriptor {
    //   static uniformLayout: Gfx.BufferLayout = {
    //     u_invViewProjRelativeToEye: { offset: 0, type: Gfx.Type.Float4x4 },
    //     u_camPosHigh: { offset: 64, type: Gfx.Type.Float3 },
    //     u_camPosLow: { offset: 76, type: Gfx.Type.Float3 },
    //     u_color: { offset: 88, type: Gfx.Type.Float4 },
    //   };

    //   static resourceLayout = {
    //     uniforms: { index: 0, type: Gfx.BindingType.UniformBuffer, layout: FrustumShader.uniformLayout },
    //     globalUniforms: { index: 1, type: Gfx.BindingType.UniformBuffer, layout: globalUniforms.getBufferLayout() },
    //   };

    //   name = 'Frustum';
    //   vertSource = frustumVs;
    //   fragSource = colorFs;
    //   resourceLayout = FrustumShader.resourceLayout;
    // }

    // frustumPrim.shader = this.renderer.createShader(new FrustumShader());
    // frustumPrim.pipeline = this.renderer.createRenderPipeline(frustumPrim.shader, renderFormatBlending, unitCubeVertBufLayout, FrustumShader.resourceLayout);
    // frustumPrim.resources = this.renderer.createResourceTable(frustumPrim.pipeline);
    // frustumPrim.depthState = depthTest;
    // frustumPrim.uniforms = new UniformBuffer('FrustumUniforms', this.renderer, FrustumShader.uniformLayout);
    // frustumPrim.indexBuffer = unitCubeIdxBuf;

    // this.renderer.setBuffer(frustumPrim.resources, unitCubeVertBuf);
    // this.renderer.setBuffer(frustumPrim.resources, frustumPrim.uniforms.getBuffer(), 0);
    // this.renderer.setBuffer(frustumPrim.resources, globalUniforms.getBuffer(), 1);

    // ----------------------------------------------------------------------------------
    // Points and Lines
    // ----------------------------------------------------------------------------------
    class PointsShader implements Gfx.ShaderDescriptor {
      static resourceLayout = {
        globalUniforms: { index: 0, type: Gfx.BindingType.UniformBuffer, layout: GlobalUniforms.bufferLayout },
      };

      name = 'Points';
      vertSource = pointsVs;
      fragSource = vertColorFs;
      resourceLayout = PointsShader.resourceLayout;
    }

    const pointsVertLayout: Gfx.VertexLayout = {
      buffers: [{
        stride: 32,
        layout: {
          a_pos: { offset: 0, type: Gfx.Type.Float3 },
          a_color: { offset: 16, type: Gfx.Type.Float4 },
        }
      }]
    }

    pointsPrim.shader = this.renderer.createShader(new PointsShader());
    pointsPrim.pipeline = this.renderer.createRenderPipeline(pointsPrim.shader, renderFormatBlending, pointsVertLayout, PointsShader.resourceLayout);
    pointsPrim.resources = this.renderer.createResourceTable(PointsShader.resourceLayout);
    pointsPrim.vertTable = this.renderer.createVertexTable(pointsPrim.pipeline);
    pointsPrim.depthState = depthDisabled;
    pointsPrim.vertexBuffer = this.renderer.createBuffer('PointsVerts', Gfx.BufferType.Vertex, Gfx.Usage.Dynamic, kMaxPoints * pointsVertLayout.buffers[0].stride);
    pointsPrim.count = 0;

    this.renderer.setVertexBuffer(pointsPrim.vertTable, 0, { buffer: pointsPrim.vertexBuffer });
    this.renderer.setBuffer(pointsPrim.resources, 0, this.globalUniforms.bufferView);

    // ----------------------------------------------------------------------------------
    // Quads
    // ----------------------------------------------------------------------------------
    quadsPrim.shader = this.renderer.createShader(new PointsShader());
    quadsPrim.pipeline = this.renderer.createRenderPipeline(quadsPrim.shader, renderFormatBlending, pointsVertLayout, PointsShader.resourceLayout);
    quadsPrim.resources = this.renderer.createResourceTable(PointsShader.resourceLayout);
    quadsPrim.vertTable = this.renderer.createVertexTable(quadsPrim.pipeline);
    quadsPrim.depthState = depthDisabled;
    quadsPrim.indexBuffer = quadIdxBuf;
    quadsPrim.vertexBuffer = this.renderer.createBuffer('QuadVerts', Gfx.BufferType.Vertex, Gfx.Usage.Dynamic, kMaxQuads * 4 * pointsVertLayout.buffers[0].stride);
    quadsPrim.count = 0;

    this.renderer.setVertexBuffer(quadsPrim.vertTable, 0, { buffer: quadsPrim.vertexBuffer });
    this.renderer.setBuffer(quadsPrim.resources, 0, this.globalUniforms.bufferView);

    // ----------------------------------------------------------------------------------
    // Arrow2D
    // ----------------------------------------------------------------------------------
    const arrowVs = `
      attribute vec2 a_pos;

      // Instanced
      attribute vec3 a_origin;
      attribute vec3 a_dir;
      attribute float a_scale;
      attribute float a_groundAlign;
      attribute vec4 a_color;

      uniform mat4 g_viewProj;
      uniform vec3 g_viewVec;

      varying lowp vec4 v_color;

      void main()
      {
        v_color = a_color;

        // Scale the head and body in model space
        bool tip = a_pos.x == 0.0;
        float headLength = length(a_dir);
        float bodyLength = headLength - 1.5 * a_scale;
        vec2 pos = vec2(a_pos.x * a_scale, a_pos.y * (tip ? headLength : bodyLength));

        vec3 normal = a_groundAlign > 0.0 ? vec3(0, 1, 0) : g_viewVec;

        vec3 up = normalize(a_dir);
        vec3 right = normalize(cross(normal, up));
        vec3 forward = cross(up, right);

        mat3 world = mat3(right, up, forward);
        vec3 worldPos = a_origin + world * vec3(pos.x, pos.y, 0);
        
        gl_Position = g_viewProj * vec4(worldPos, 1.0);
      }
    `;

    const arrowVertLayout: Gfx.VertexLayout = {
      buffers: [
        {
          stride: 8,
          layout: {
            a_pos: { offset: 0, type: Gfx.Type.Float2 }
          }
        }, 
        {
          stride: 52,
          layout: {
            a_origin: { offset: 0, type: Gfx.Type.Float3 },
            a_groundAlign: { offset: 12, type: Gfx.Type.Float },
            a_dir:    { offset: 16, type: Gfx.Type.Float3 },
            a_scale:  { offset: 28, type: Gfx.Type.Float },
            a_color:  { offset: 36, type: Gfx.Type.Float4 },
          },
          stepMode: Gfx.StepMode.Instance
        },
      ]
    };

    const arrowShader: PrimitiveDescriptor = {
      name: 'Arrow',
      vertSource: arrowVs,
      fragSource: vertColorFs,
      vertexLayout: arrowVertLayout,
      resourceLayout: {
        globalUniforms: { index: 0, type: Gfx.BindingType.UniformBuffer, layout: GlobalUniforms.bufferLayout },
      }
    };

    const arrowVerts = [
      -0.5, 0,
      -0.5, 1,
      -1, 1,
       0, 1,
       1, 1,
       0.5, 1,
       0.5, 0,
    ];

    const arrowIndices = [
      0, 6, 1,
      1, 6, 5,
      2, 4, 3
    ];

    this.shapes['Arrow'] = this.createShape(arrowShader, 16, arrowVerts, arrowIndices, false);

    // ----------------------------------------------------------------------------------
    // Sphere
    // ----------------------------------------------------------------------------------
    class SphereShader implements Gfx.ShaderDescriptor {
      static resourceLayout = {
        globalUniforms: { index: 0, type: Gfx.BindingType.UniformBuffer, layout: GlobalUniforms.bufferLayout },
      };

      name = 'Sphere';
      vertSource = sphereVs;
      fragSource = vertColorFs;
      resourceLayout = SphereShader.resourceLayout;
    }
    
    const sphereVertLayout: Gfx.VertexLayout = {
      buffers: [
        {
          stride: 12,
          layout: {
            a_pos: { offset: 0, type: Gfx.Type.Float3 }
          }
        }, 
        {
          stride: 32,
          layout: {
            a_origin: { offset: 0, type: Gfx.Type.Float3 },
            a_radius: { offset: 12, type: Gfx.Type.Float },
            a_color:  { offset: 16, type: Gfx.Type.Float4 },
          },
          stepMode: Gfx.StepMode.Instance
        },
      ]
    }

    spherePrim.shader = this.renderer.createShader(new SphereShader());
    spherePrim.depthState = depthTestWrite;
    spherePrim.resources = this.renderer.createResourceTable(SphereShader.resourceLayout);
    spherePrim.pipeline = this.renderer.createRenderPipeline(spherePrim.shader, renderFormatNoBlending, 
      sphereVertLayout, SphereShader.resourceLayout);
    spherePrim.vertTable = this.renderer.createVertexTable(spherePrim.pipeline);
    spherePrim.vertexBuffer = this.renderer.createBuffer('Spheres', Gfx.BufferType.Vertex, Gfx.Usage.Dynamic, 
      kMaxSpheres * sphereVertLayout.buffers[1].stride);
    spherePrim.indexBuffer = unitCubeIdxBuf;
    spherePrim.count = 0;

    this.renderer.setVertexBuffer(spherePrim.vertTable, 0, { buffer: unitCubeVertBuf });
    this.renderer.setVertexBuffer(spherePrim.vertTable, 1, { buffer: spherePrim.vertexBuffer });
    this.renderer.setBuffer(spherePrim.resources, 0, this.globalUniforms.bufferView);
  }

  static renderObbs(obbs: mat4[], drawFaces: boolean = false, color: vec4 = defaultObbColor) {
    if (!defined(obbPrim.pipeline)) {
      this.initialize();
      return; 
    }

    // @HACK:
    assert(obbs.length <= 1, 'Drawing multiple OBBs not yet supported. (Need to use multiple uniform buffers)');

    obbPrim.uniforms.setVec4('u_color', color);

    for (let obb of obbs) {
      const m = mat3.fromMat4(mat3Scratch, obb);
      obbPrim.uniforms.setFloats('u_extents', m);
      obbPrim.uniforms.setVec3('u_center', mat4.getTranslation(vec3Scratch, obb));
    }

    obbPrim.uniforms.write(this.renderer);

    const prim: RenderPrimitive = {
      renderPipeline: obbPrim.pipeline,
      vertexTable: obbPrim.vertTable,
      depthMode: obbPrim.depthState,
      resourceTable: obbPrim.resources,

      indexType: Gfx.Type.Ushort,
      indexBuffer: { buffer: obbPrim.indexBuffer, byteOffset: drawFaces ? 24 * 2 : 0 },
      type: drawFaces ? Gfx.PrimitiveType.Triangles : Gfx.PrimitiveType.Lines,
      elementCount: drawFaces ? 36 : 24,
    }

    renderLists.debug.push(prim);
  }

  // static renderFrustum(this.renderer: Gfx.Renderer, invViewProjRelativeToEye: Matrix4, camPos: vec3) {
  //   mat4Scratch.set(invViewProjRelativeToEye.m);
  //   frustumPrim.uniforms.setByteArray('u_invViewProjRelativeToEye', new Uint8Array(mat4Scratch.buffer));

  //   encodeVecHighToFloatArray(camPos, frustumPrim.uniforms.getFloatArray('u_camPosHigh'));
  //   encodeVecLowToFloatArray(camPos, frustumPrim.uniforms.getFloatArray('u_camPosLow'));

  //   this.renderer.bindPipeline(frustumPrim.pipeline);
  //   this.renderer.setDepthStencilState(frustumPrim.depthState);

  //   frustumPrim.uniforms.set('u_color', new vec4(1, 1, 1, 1));
  //   frustumPrim.uniforms.write(this.renderer);
  //   this.renderer.bindResources(frustumPrim.resources);
  //   this.renderer.draw(Gfx.PrimitiveType.Lines, frustumPrim.indexBuffer, Gfx.Type.Ushort, 0, 16);

  //   frustumPrim.uniforms.set('u_color', new vec4(0, 0, 1, 0.1));
  //   frustumPrim.uniforms.write(this.renderer);
  //   this.renderer.bindResources(frustumPrim.resources);
  //   this.renderer.draw(Gfx.PrimitiveType.Triangles, frustumPrim.indexBuffer, Gfx.Type.Ushort, 24, 30);
  // }

  // static renderPoints(this.renderer: Gfx.this.renderer, points: vec3[], color: vec4) {
  //   console.assert(points.length < kMaxPoints);

  //   // Encode positions as doubles and write to vertex buffer
  //   for (let i = 0; i < points.length; i++) {
  //     encodeVecHighToFloatArray(points[i], floatScratch, i * 6 + 0);
  //     encodeVecLowToFloatArray(points[i], floatScratch, i * 6 + 3);
  //   }
  //   this.renderer.writeBufferData(pointsPrim.vertexBuffer, 0, floatScratch.subarray(0, points.length * 6));

  //   // Write uniforms
  //   pointsPrim.uniforms.set('u_color', color);
  //   pointsPrim.uniforms.write(this.renderer);

  //   // Render
  //   this.renderer.bindPipeline(pointsPrim.pipeline);
  //   this.renderer.setDepthStencilState(pointsPrim.depthState);

  //   this.renderer.bindResources(pointsPrim.resources);
  //   this.renderer.drawNonIndexed(Gfx.PrimitiveType.Points, 0, points.length);
  // }

  static renderLines(pointPairs: vec3[], color: vec4 = defaultLineColor) {
    if (!defined(obbPrim.pipeline)) {
      this.initialize();
      return; 
    }

    console.assert(pointPairs.length < kMaxPoints);

    // Encode positions and write to vertex buffer
    for (let i = 0; i < pointPairs.length; i++) {
      floatScratch.set(pointPairs[i], i * 8 + 0);
      floatScratch.set(color, i * 8 + 4);
    }
    this.renderer.writeBufferData(pointsPrim.vertexBuffer, pointsPrim.count * 32, 
        floatScratch.subarray(0, pointPairs.length * 8));

    pointsPrim.count += pointPairs.length;
  }

  static renderQuads(quads: vec3[], color: vec4 = defaultLineColor) {
    if (!defined(obbPrim.pipeline)) {
      this.initialize();
      return; 
    }

    console.assert((quads.length * 4) < kMaxPoints);

    // Encode positions and write to vertex buffer
    for (let i = 0; i < quads.length; i++) {
      floatScratch.set(quads[i], i * 8 + 0);
      floatScratch.set(color, i * 8 + 4);
    }
    this.renderer.writeBufferData(quadsPrim.vertexBuffer, quadsPrim.count * 4 * 32, 
        floatScratch.subarray(0, quads.length * 8));

    quadsPrim.count += quads.length / 4;
  }

  static renderSpheres(spheres: vec4[], color: vec4 = defaultSphereColor) {
    if (!defined(obbPrim.pipeline)) {
      this.initialize();
      return; 
    }
    
    console.assert(spheres.length < kMaxSpheres);

    // Encode positions and write to vertex buffer
    for (let i = 0; i < spheres.length; i++) {
      floatScratch.set(spheres[i], i * 8 + 0);
      floatScratch.set(color, i * 8 + 4);
    }

    this.renderer.writeBufferData(spherePrim.vertexBuffer, spherePrim.count * 32, 
        floatScratch.subarray(0, spheres.length * 8));

    spherePrim.count += spheres.length;
  }

  static renderArrows(pos: vec3[], dir: vec3[], width: number, groundAlign = true, color: vec4 = defaultSphereColor) {
    if (!defined(obbPrim.pipeline)) {
      this.initialize();
      return; 
    }

    const shape = this.shapes['Arrow'];
    const arrowCount = pos.length;
    const floatStride = 13;

    // Encode positions and write to vertex buffer
    const scaleArr = [width];
    const groundArr = [groundAlign ? 1.0 : 0.0];
    for (let i = 0; i < arrowCount; i++) {
      floatScratch.set(pos[i],   i * floatStride + 0);
      floatScratch.set(groundArr, i * floatStride + 3);
      floatScratch.set(dir[i],   i * floatStride + 4);
      floatScratch.set(scaleArr, i * floatStride + 7);
      floatScratch.set(color,    i * floatStride + 9);
    }

    this.renderer.writeBufferData(shape.vertexBuffer, shape.count * floatStride * 4, 
      floatScratch.subarray(0, arrowCount * floatStride));

    shape.count += arrowCount;
  }

  static flush() {
    if (pointsPrim.count > 0) {
      const prim: RenderPrimitive = {
        renderPipeline: pointsPrim.pipeline,
        depthMode: pointsPrim.depthState,
        resourceTable: pointsPrim.resources,
        vertexTable: pointsPrim.vertTable,
        type: Gfx.PrimitiveType.Lines,
        elementCount: pointsPrim.count,
      }
      
      renderLists.debug.push(prim);
      
      pointsPrim.count = 0;
    }

    if (spherePrim.count > 0) {
      const prim: RenderPrimitive = {
        renderPipeline: spherePrim.pipeline,
        depthMode: spherePrim.depthState,
        resourceTable: spherePrim.resources,
        vertexTable: spherePrim.vertTable,
        type: Gfx.PrimitiveType.Lines,
        elementCount: 24,
        instanceCount: spherePrim.count,

        indexBuffer: { buffer: spherePrim.indexBuffer },
        indexType: Gfx.Type.Ushort,
      }
      
      renderLists.debug.push(prim);
      
      spherePrim.count = 0;
    } 
    
    if (quadsPrim.count > 0) {
      const prim: RenderPrimitive = {
        renderPipeline: quadsPrim.pipeline,
        depthMode: quadsPrim.depthState,
        resourceTable: quadsPrim.resources,
        vertexTable: quadsPrim.vertTable,
        type: Gfx.PrimitiveType.Triangles,
        elementCount: 6 * quadsPrim.count,

        indexBuffer: { buffer: quadsPrim.indexBuffer },
        indexType: Gfx.Type.Ushort,
      }
      
      renderLists.debug.push(prim);
      
      quadsPrim.count = 0;
    }

    for (const key in this.shapes) {
      const shape = this.shapes[key];
      if (shape.count > 0) {
        const prim: RenderPrimitive = {
          renderPipeline: shape.pipeline,
          depthMode: shape.depthState,
          resourceTable: shape.resources,
          vertexTable: shape.vertTable,
          type: Gfx.PrimitiveType.Triangles,
          elementCount: shape.indexCount,
          instanceCount: shape.count,
  
          indexBuffer: { buffer: shape.indexBuffer },
          indexType: Gfx.Type.Ushort,
        }
        
        renderLists.debug.push(prim);
        
        shape.count = 0;
      }
    }
  }
}