import * as Gfx from '../gfx/GfxTypes';
import { assert, defaultValue, defined, assertDefined } from '../util';
import * as GlTf from './Gltf.d';
import { vec3, vec4, quat, mat4 } from 'gl-matrix';
import { Resource, ResourceLoader, ResourceStatus, ResourceLoadingContext } from './Resource';

// --------------------------------------------------------------------------------
// GLB (Binary GLTF decoding)
// --------------------------------------------------------------------------------
const BINARY_HEADER_MAGIC = 'glTF';
const BINARY_HEADER_LENGTH = 12;
const BINARY_CHUNK_TYPES = { JSON: 0x4e4f534a, BIN: 0x004e4942 };

// @TODO: This should be shared with the whole engine
let textDecoder = new TextDecoder();
function decodeText(array: ArrayBufferView): string {
    return textDecoder.decode(array);
}

class GLTFBinaryData {
    json: string;
    binaryChunk: Uint8Array;

    constructor(data: ArrayBuffer) {
        const headerView = new DataView(data, 0, BINARY_HEADER_LENGTH);
        const chunkView = new DataView(data, BINARY_HEADER_LENGTH);

        const header = {
            magic: decodeText(new Uint8Array(data, 0, 4)),
            version: headerView.getUint32(4, true),
            length: headerView.getUint32(8, true),
        };

        if (header.magic !== BINARY_HEADER_MAGIC) {
            throw new Error('Unsupported glTF-Binary header.');
        } else if (header.version < 2.0) {
            throw new Error('Unsupported legacy binary file detected.');
        }

        let chunkIndex = 0;
        while (chunkIndex < chunkView.byteLength) {
            const chunkLength = chunkView.getUint32(chunkIndex, true);
            chunkIndex += 4;
            const chunkType = chunkView.getUint32(chunkIndex, true);
            chunkIndex += 4;

            switch (chunkType) {
                case BINARY_CHUNK_TYPES.JSON:
                    {
                        const contentArray = new Uint8Array(data, BINARY_HEADER_LENGTH + chunkIndex, chunkLength);
                        this.json = decodeText(contentArray);
                    }
                    break;

                case BINARY_CHUNK_TYPES.BIN:
                    {
                        const byteOffset = BINARY_HEADER_LENGTH + chunkIndex;
                        this.binaryChunk = new Uint8Array(data, byteOffset, chunkLength);
                    }
                    break;

                default:
                    {
                        console.warn('Skipping unexpected glTF-Binary chunk type:', chunkType);
                    }
                    break;
            }

            chunkIndex += chunkLength;
        }

        assert(!!this.json, 'glTF-Binary: JSON content not found.');
    }
}

// --------------------------------------------------------------------------------
// GLTF Asset
// --------------------------------------------------------------------------------
export class GltfAsset {
    public gltf: GlTf.GlTf;

    private bufferData: Uint8Array[];

    constructor(gltf: GlTf.GlTf, bufferData: Uint8Array[]) {
        this.gltf = gltf;
        this.bufferData = bufferData;
    }

    /**
     * Fetch the data for a buffer view. Pass in the `bufferView` property of an
     * `Accessor`.
     * NOTE: To avoid any unnessary copies, the data is returned as a `Uint8Array` instead of an `ArrayBuffer`.
     */
    bufferViewData(index: GlTf.GlTfId): Uint8Array {
        if (!this.gltf.bufferViews) {
            throw new Error('No buffer views found.');
        }
        const bufferView = this.gltf.bufferViews[index];
        const bufferData = assertDefined(this.bufferData[bufferView.buffer], `No data for buffer ${bufferView.buffer}`);
        const byteLength = bufferView.byteLength || 0;
        const byteOffset = bufferView.byteOffset || 0;

        // For GLB files, the 'base buffer' is the whole GLB file, including the json part.
        // Therefore we have to consider bufferData's offset within its buffer it as well.
        // For non-GLB files it will be 0.
        const baseBuffer = bufferData.buffer;
        const baseBufferByteOffset = bufferData.byteOffset;

        return new Uint8Array(baseBuffer, baseBufferByteOffset + byteOffset, byteLength);
    }

    /**
     * Fetch the data associated with the accessor. Equivalent to `bufferViewData` for most accessors; special cases:
     * - `accessor.bufferView` is undefined: create a buffer initialized with zeroes.
     * - `accessor.sparse` is defined: Copy underlying buffer view and apply values from `sparse`.
     */
    accessorData(index: GlTf.GlTfId): Uint8Array {
        if (!this.gltf.accessors) {
            /* istanbul ignore next */
            throw new Error('No accessors views found.');
        }
        const acc = this.gltf.accessors[index];
        const elementsPerType = GLTF_ELEMENTS_PER_TYPE[acc.type];
        let data;
        if (acc.bufferView !== undefined) {
            data = this.bufferViewData(acc.bufferView);
        } else {
            const byteSize = GLTF_COMPONENT_TYPE_ARRAYS[acc.componentType].BYTES_PER_ELEMENT * elementsPerType * acc.count;
            data = new Uint8Array(byteSize);
        }

        if (acc.sparse) {
            // parse sparse data
            const { count, indices, values } = acc.sparse;
            let typedArray = GLTF_COMPONENT_TYPE_ARRAYS[indices.componentType];
            let bufferViewData = this.bufferViewData(indices.bufferView);
            const indexData = new typedArray(
                bufferViewData.buffer,
                bufferViewData.byteOffset + (indices.byteOffset || 0),
                count,
            );

            typedArray = GLTF_COMPONENT_TYPE_ARRAYS[acc.componentType];
            bufferViewData = this.bufferViewData(values.bufferView);
            const valueData = new typedArray(
                this.bufferViewData(values.bufferView).buffer,
                bufferViewData.byteOffset + (values.byteOffset || 0),
                count * elementsPerType,
            );

            // copy base data and change it
            if (acc.bufferView) {
                // no copy necessary if no bufferView since data was created above
                data = new Uint8Array(data);
            }

            const typedData = new GLTF_COMPONENT_TYPE_ARRAYS[acc.componentType](data.buffer);
            for (let i = 0; i < count; i++) {
                for (let j = 0; j < elementsPerType; j++) {
                    typedData[elementsPerType * indexData[i] + j] = valueData[elementsPerType * i + j];
                }
            }
        }

        return data;
    }
}



// --------------------------------------------------------------------------------
// GLTF Loader
// --------------------------------------------------------------------------------
export type TranslationSampler = Sampler<vec3>;
export type RotationSampler = Sampler<vec4>;
export type ScaleSampler = Sampler<vec3>;
export type WeightsSampler = Sampler<number>;
export interface Sampler<T> {
    nodeId: number;
    times: number[];
    values: T[];
}

export interface GltfAnimation {
    name: string;
    maxTime: number;
    scales: ScaleSampler[];
    rotations: RotationSampler[];
    translations: TranslationSampler[];
    weights: WeightsSampler[];
}

interface GltfBufferView {
    id: Gfx.Id;
    type: Gfx.BufferType;
    name: string;
}

interface GltfPrimitive {
    vertexLayout: Gfx.VertexLayout,
    elementCount: number;
    type: Gfx.PrimitiveType;

    indexBuffer?: GltfBufferView;
    indexType?: Gfx.Type

    depthMode?: Gfx.Id;
    cullMode?: Gfx.CullMode;
    material: GltfMaterial,
}

interface GltfMesh {
    name: string;
    id: number;
    primitives: GltfPrimitive[];
}

export interface GltfNode {
    name?: string;

    scale: vec3;
    rotation: quat;
    translation: vec3;
    transform?: mat4;
    morphWeight: number;

    mesh?: GltfMesh;
    children?: number[];
}

interface GltfMaterial {
    renderFormat: Gfx.RenderFormat;
    cullMode: Gfx.CullMode;
    textures: { [name: string]: GltfTexture };
}

interface GltfTexture {
    promise?: Promise<void>,
    desc: Gfx.TextureDescriptor,
    name: string,
    id: Gfx.Id;
    index: number;
}

function translateAccessorToType(type: string, componentType: number): Gfx.Type {
    let gfxType: Gfx.Type;

    switch (componentType) {
        case 5120:
            gfxType = Gfx.Type.Char;
            break;
        case 5121:
            gfxType = Gfx.Type.Uchar;
            break;
        case 5122:
            gfxType = Gfx.Type.Short;
            break;
        case 5123:
            gfxType = Gfx.Type.Ushort;
            break;
        case 5125:
            gfxType = Gfx.Type.Uint;
            break;
        case 5126:
            gfxType = Gfx.Type.Float;
            break;
        default:
            throw new Error('Invalid GLTF component type');
    }

    switch (type) {
        case 'SCALAR':
            gfxType += 0;
            break;
        case 'VEC2':
            gfxType += 1;
            break;
        case 'VEC3':
            gfxType += 2;
            break;
        case 'VEC4':
            gfxType += 3;
            break;
        case 'MAT2':
            throw new Error('2x2 Matrice not yet supported');
        case 'MAT3':
            gfxType = Gfx.Type.Float3x3;
            break;
        case 'MAT4':
            gfxType = Gfx.Type.Float4x4;
            break;
    }

    return gfxType;
}

function translateModeToPrimitiveType(mode: number): Gfx.PrimitiveType {
    switch (mode) {
        case 0:
            return Gfx.PrimitiveType.Points;
        case 1:
            return Gfx.PrimitiveType.Lines;
        case 2:
            return Gfx.PrimitiveType.LineLoop;
        case 3:
            return Gfx.PrimitiveType.LineStrip;
        case 4:
            return Gfx.PrimitiveType.Triangles;
        case 5:
            return Gfx.PrimitiveType.TriangleStrip;
        case 6:
            return Gfx.PrimitiveType.TriangleFan;
        default:
            throw new Error('Invalid GLTF primitive mode');
    }
}

function toFloatArray(byteArray: Uint8Array) {
    return new Float32Array(byteArray.buffer, byteArray.byteOffset, byteArray.byteLength / 4);
}

/** Spec: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#accessor-element-size */
const GLTF_COMPONENT_TYPE_ARRAYS: { [index: number]: any } = {
    5120: Int8Array,
    5121: Uint8Array,
    5122: Int16Array,
    5123: Uint16Array,
    5125: Uint32Array,
    5126: Float32Array,
};

/** Spec: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#accessor-element-size */
const GLTF_ELEMENTS_PER_TYPE: { [index: string]: number } = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
};

// Remap GLTF vertex attribute names to our own
const GLTF_VERTEX_ATTRIBUTES: { [index: string]: string } = {
    POSITION: 'a_pos',
    NORMAL: 'a_normal',
    TANGENT: 'a_tangent',
    JOINTS_0: 'a_joints',
    WEIGHTS_0: 'a_weights',
    COLOR_0: 'a_color',
    TEXCOORD_0: 'a_uv0',
    TEXCOORD_1: 'a_uv1',
    MORPH0_POSITION: 'a_posMorph0',
};

const GLTF_ATTRIBUTE_DEFINES: { [index: string]: string } = {
    NORMAL: 'HAS_NORMALS 1',
    TANGENT: 'HAS_TANGENT 1',
    JOINTS_0: 'HAS_JOINT_SET0 1',
    WEIGHTS_0: 'HAS_WEIGHT_SET0 1',
    COLOR_0: 'HAS_COLOR0 1',
    TEXCOORD_0: 'HAS_UV_SET0 1',
    TEXCOORD_1: 'HAS_UV_SET1 1',
};

// --------------------------------------------------------------------------------
// GLTF parsing helpers
// --------------------------------------------------------------------------------
function loadScene(res: GltfResource, asset: GltfAsset, sceneId: number) {
    const scene = assertDefined(asset.gltf.scenes)[sceneId];

    if (scene.nodes) {
        for (let index of scene.nodes) {
            res.rootNodeIds.push(index);
            const node = assertDefined(asset.gltf.nodes)[index];
            loadNode(res, asset, node);
        }
    }
}

function loadNode(res: GltfResource, asset: GltfAsset, gltfNode: GlTf.Node): GltfNode {
    const scale = defaultValue(gltfNode.scale, [1, 1, 1]);
    const rotation = defaultValue(gltfNode.rotation, [0, 0, 0, 1]);
    const translation = defaultValue(gltfNode.translation, [0, 0, 0]);

    const node: GltfNode = {
        name: gltfNode.name,
        scale: vec3.fromValues(scale[0], scale[1], scale[2]),
        rotation: quat.fromValues(rotation[0], rotation[1], rotation[2], rotation[3]),
        translation: vec3.fromValues(translation[0], translation[1], translation[2]),
        morphWeight: defaultValue(gltfNode.weights, [0])[0],
    }

    if (defined(gltfNode.matrix)) node.transform = mat4.fromValues.apply(null, gltfNode.matrix);
    else node.transform = mat4.fromRotationTranslationScale(mat4.create(), node.rotation, node.translation, node.scale);

    if (defined(gltfNode.mesh)) {
        node.mesh = loadMesh(res, asset, gltfNode.mesh);
    }

    if (defined(gltfNode.children)) {
        node.children = [];
        for (let childIdx = 0; childIdx < gltfNode.children.length; childIdx++) {
            const childId = gltfNode.children[childIdx]
            const child = assertDefined(asset.gltf.nodes)[childId];
            loadNode(res, asset, child);
            node.children.push(childId);
        }
    }

    res.nodes.push(node);
    return node;
}

function loadMesh(res: GltfResource, asset: GltfAsset, id: number) {
    const gltfMesh = assertDefined(asset.gltf.meshes)[id];

    // A Mesh has a transform (from its parent node) that is shared between its primitives
    // A Primitive defines its material as well as draw call parameters
    const primitives = [];
    for (let prim of gltfMesh.primitives) {
        primitives.push(loadPrimitive(res, asset, prim));
    }

    const mesh: GltfMesh = {
        name: gltfMesh.name,
        id,
        primitives,
    }

    res.meshes[id] = mesh;
    return mesh;
}

function loadPrimitive(res: GltfResource, asset: GltfAsset, gltfPrimitive: GlTf.MeshPrimitive): GltfPrimitive {
    const prim = gltfPrimitive;
    const gltf = asset.gltf;

    let material;
    if (defined(gltfPrimitive.material)) {
        material = loadMaterial(res, asset, gltfPrimitive.material);
    } else {
        // @TODO: Default material
        throw new Error('Default material not yet supported');
    }

    const shaderDefines: string[] = [];

    let indexBufferView;
    if (defined(prim.indices)) {
        const acc = assertDefined(gltf.accessors)[prim.indices];
        const viewId = assertDefined(acc.bufferView);
        indexBufferView = loadBufferView(res, asset, viewId, Gfx.BufferType.Index);
    }

    // Fill out the VertexLayout based on the primitive's attributes
    const vertexLayout: Gfx.VertexLayout = { buffers: [] };
    for (let gltfAttribName in prim.attributes) {
        const accessor = assertDefined(gltf.accessors)[prim.attributes[gltfAttribName]];
        const viewIdx = assertDefined(accessor.bufferView, 'Undefined accessor buffers are not yet implemented');
        const view = assertDefined(gltf.bufferViews)[viewIdx];
        let bufferDesc = vertexLayout.buffers[viewIdx];

        loadBufferView(res, asset, viewIdx, Gfx.BufferType.Vertex);

        const attribDefine = GLTF_ATTRIBUTE_DEFINES[gltfAttribName];
        if (defined(attribDefine)) shaderDefines.push(attribDefine);

        if (!defined(bufferDesc)) {
            bufferDesc = vertexLayout.buffers[viewIdx] = {
                stride: defaultValue(view.byteStride, 0), // 0 means tightly packed
                layout: {},
            };
        }

        bufferDesc.layout[GLTF_VERTEX_ATTRIBUTES[gltfAttribName]] = {
            type: translateAccessorToType(accessor.type, accessor.componentType),
            offset: accessor.byteOffset || 0,
        };
    }

    // Also add any attributes from Morph Targets
    if (prim.targets) {
        shaderDefines.push('HAS_MORPH0 1');
        assert(prim.targets.length === 1, 'Only 1 morph target is currently supported');
        const target = prim.targets[0];
        for (let semantic in target) {
            if (semantic === 'POSITION') {
                const accessor = assertDefined(gltf.accessors)[target[semantic]];
                const viewIdx = assertDefined(accessor.bufferView, 'Undefined accessor buffers are not yet implemented');
                const view = assertDefined(gltf.bufferViews)[viewIdx];
                let bufferDesc = vertexLayout.buffers[viewIdx];

                loadBufferView(res, asset, viewIdx, Gfx.BufferType.Vertex);

                if (!defined(bufferDesc)) {
                    bufferDesc = vertexLayout.buffers[viewIdx] = {
                        stride: defaultValue(view.byteStride, 0), // 0 means tightly packed
                        layout: {},
                    };
                }

                bufferDesc.layout[GLTF_VERTEX_ATTRIBUTES[`MORPH0_${semantic}`]] = {
                    type: translateAccessorToType(accessor.type, accessor.componentType),
                    offset: accessor.byteOffset || 0,
                };
            }
        }
    }

    // @TODO: For now, only non-sparse indexed primitives are supported
    const indices = gltf.accessors![assertDefined(prim.indices, 'Only indexed primitives are currently supported')];
    const indicesBufferView = assertDefined(indexBufferView, 'Only indexed primitives are currently supported');

    return {
        elementCount: indices.count,
        type: translateModeToPrimitiveType(defaultValue(prim.mode, 4)),
        indexType: translateAccessorToType(indices.type, indices.componentType),
        indexBufferView: indicesBufferView,
        vertexLayout,
        material,
    };
}

function loadMaterial(res: GltfResource, asset: GltfAsset, id: number) {
    const gltfMaterial = assertDefined(asset.gltf.materials)[id];
    if (defined(res.materials[id])) return res.materials[id];

    const material: GltfMaterial = {
        renderFormat: { blendingEnabled: false }, // @TODO: Parse this
        cullMode: gltfMaterial.doubleSided ? Gfx.CullMode.None : Gfx.CullMode.Back,
        textures: {},
    }

    const defaultPbr = {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 1,
        roughnessFactor: 1,
    };
    const pbr = defaultValue(gltfMaterial.pbrMetallicRoughness, defaultPbr);
    // @TODO: Alpha mode
    // @TODO: Alpha cutoff

    if (pbr.baseColorTexture) {
        const uvIdx = defaultValue(pbr.baseColorTexture.texCoord, 0);
        assert(uvIdx === 0, 'Non-zero UV indices not yet supported');
        const texture = loadImage(res, asset, pbr.baseColorTexture.index);
        material.textures['baseColorTexture'] = texture;
    }

    res.materials[id] = material;
    return material;
}

function loadImage(res: GltfResource, asset: GltfAsset, id: number): GltfTexture {
    if (defined(res.textures[id])) return res.textures[id];

    const gltfImage = assertDefined(asset.gltf.images)[id];
    assertDefined(gltfImage, 'Image loading from a URI is not yet supported');

    const desc: Gfx.TextureDescriptor = {
        type: Gfx.TextureType.Texture2D,
        format: Gfx.TexelFormat.U8x3,
        usage: Gfx.Usage.Static,
    };

    const name = gltfImage.name || `tex${id}`;

    // All browser except Safari support JPG/PNG image decoding on a worker via createImageBitmap
    // Otherwise we'll just send the ArrayBuffer and decode before uploading to the GPU on the main thread
    const buffer = asset.bufferViewData(assertDefined(gltfImage.bufferView));
    let imageDataPromise: Promise<ArrayBuffer | ImageBitmap>;
    if (defined(self.createImageBitmap)) {
        const blob = new Blob([buffer], { type: assertDefined(gltfImage.mimeType) });
        imageDataPromise = createImageBitmap(blob);
    } else {
        imageDataPromise = Promise.resolve(buffer.buffer);
    }

    // Wait for the imageData to be ready before pushing to main thread
    // @NOTE: Make sure we make large data transferrable to avoid costly copies between threads
    res.promises.push(imageDataPromise.then(imageData => {
        res.transferList.push(imageData);
        res.imageData[id] = imageData;
    }));

    const tex = { name, index: id, id: -1, desc };
    res.textures[id] = tex;
    return tex;
}

function loadBufferView(res: GltfResource, asset: GltfAsset, id: number, bufType: Gfx.BufferType): GltfBufferView {
    if (defined(res.bufferViews[id])) return res.bufferViews[id];

    const gltfBufferView = assertDefined(asset.gltf.bufferViews)[id];
    const name = gltfBufferView.name || `buffer${id}`;

    const bufId = -1; // The GPU buffer will be created during loadSync on the main thread

    res.bufferData[id] = new Uint8Array(asset.bufferViewData(id)).buffer;
    res.transferList.push(res.bufferData[id]);

    const buf = { name, type: bufType, id: bufId };
    res.bufferViews[id] = buf;
    return buf;
}

// --------------------------------------------------------------------------------
// Resource interface
// --------------------------------------------------------------------------------
export interface GltfResource extends Resource {
    nodes: GltfNode[];
    meshes: GltfMesh[];
    materials: GltfMaterial[];
    textures: GltfTexture[];
    bufferViews: GltfBufferView[];
    animations: GltfAnimation[];
    rootNodeIds: number[];

    // Transient Data
    promises: Promise<any>[];
    imageData: (ArrayBuffer | ImageBitmap | HTMLImageElement)[];
    bufferData: ArrayBuffer[];
}

export class GltfLoader implements ResourceLoader {
    async loadAsync(resource: GltfResource): Promise<void> {
        const response = await fetch(resource.source.uri);
        if (response.status != 200) throw new Error(`Failed to download GLTF`);

        const buffer = await response.arrayBuffer();
        const data = new GLTFBinaryData(buffer);
        const gltf = JSON.parse(data.json) as GlTf.GlTf;
        const asset = new GltfAsset(gltf, [data.binaryChunk]);

        resource.nodes = [];
        resource.meshes = [];
        resource.materials = [];
        resource.textures = [];
        resource.bufferViews = [];
        resource.animations = [];
        resource.rootNodeIds = [];

        resource.promises = [];
        resource.imageData = [];
        resource.bufferData = [];

        // Load the GLTF file starting with the root scene
        const sceneId = defaultValue(asset.gltf.scene, 0);
        loadScene(resource, asset, sceneId);
        // if (defined(asset.gltf.animations)) {
        //     loadAnimations(asset.gltf.animations);
        // }

        // @TODO: This shouldn't be part of the resource class
        await Promise.all(resource.promises);
        delete resource.promises;

        resource.status = ResourceStatus.LoadingSync
    }

    loadSync(context: ResourceLoadingContext, resource: GltfResource): void {
        // Upload Vertex and Index buffers to the GPU
        for (let idx in resource.bufferData) {
            const bufferView = resource.bufferViews[idx];
            const bufferData = resource.bufferData[idx];
            bufferView.id = context.renderer.createBuffer(bufferView.name, bufferView.type, Gfx.Usage.Static, bufferData);
        }

        // Upload textures to the GPU
        if (defined(self.createImageBitmap)) {
            for (let idx in resource.imageData) {
                const imageData = resource.imageData[idx];
                const tex = resource.textures[idx];
    
                if (imageData instanceof ImageBitmap) {
                    tex.id = context.renderer.createTexture(tex.name, {
                        usage: Gfx.Usage.Static,
                        type: Gfx.TextureType.Texture2D,
                        format: Gfx.TexelFormat.U8x3,
                        maxAnistropy: 16,
                    }, imageData);
    
                    imageData.close();
                }
            }
    
            delete resource.imageData;
            resource.status = ResourceStatus.Loaded;
        } 
        
        else {
            // This browser (Safari) doesn't support createImageBitmap(), which means we have to do JPEG decompression
            // here on the main thread. Use an HtmlImageElement to do this before submitting to WebGL.
            let texLoadedCount = 0;
            for (let idx in resource.imageData) {
                const imageData = resource.imageData[idx];
                const tex = resource.textures[idx];
                if (tex.id !== -1) {
                    texLoadedCount += 1;
                    continue;
                }
    
                if (imageData instanceof ArrayBuffer) {
                    // @TODO: Support other file type (PNG) by using the mimetype from the response
                    var blob = new Blob([imageData], { type: "image/jpeg" });
                    let imageUrl = window.URL.createObjectURL(blob);
    
                    // Create an image element to do async JPEG/PNG decoding
                    resource.imageData[idx] = new Image();
                    (resource.imageData[idx] as HTMLImageElement).src = imageUrl;
    
                    // Continue calling loadSync until the image is loaded and decoded
                    resource.status = ResourceStatus.LoadingSync;
                }
    
                if ((resource.imageData[idx] as HTMLImageElement).complete) {
                    tex.id = context.renderer.createTexture(tex.name, {
                        usage: Gfx.Usage.Static,
                        type: Gfx.TextureType.Texture2D,
                        format: Gfx.TexelFormat.U8x3,
                        maxAnistropy: 16,
                    }, resource.imageData[idx] as HTMLImageElement);
                }
            }

            if (texLoadedCount === resource.textures.length) {
                delete resource.imageData;
                resource.status = ResourceStatus.Loaded;
            }
        }
    }

    unloadSync(context: ResourceLoadingContext, resource: GltfResource) {
    }
}