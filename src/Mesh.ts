import * as Gfx from './gfx/GfxTypes';
import { RenderList, renderLists } from './RenderList';
import { RenderPrimitive } from './RenderPrimitive';
import { UniformBuffer } from './UniformBuffer';
import { assertDefined, assert, defined, defaultValue } from './util';

type BufferOrBufferView = Gfx.BufferView | Gfx.Id;
function toBufferView(val: BufferOrBufferView): Gfx.BufferView {
    return (val as Gfx.BufferView).buffer ? val as Gfx.BufferView: { buffer: val as Gfx.Id }
}

export interface MeshDescriptor {
    vertexLayout: Gfx.VertexLayout;
    vertexBuffers: BufferOrBufferView[];
    elementCount: number;

    indexBuffer?: BufferOrBufferView;
    indexType?: Gfx.Type;

    primitiveType?: Gfx.PrimitiveType;
}

export class Mesh {
    vertexLayout: Gfx.VertexLayout;
    vertexBuffers: Gfx.BufferView[];
    elementCount: number;

    indexBuffer?: Gfx.BufferView;
    indexType?: Gfx.Type;

    primitiveType: Gfx.PrimitiveType;

    constructor(desc: MeshDescriptor) {
        this.vertexLayout = desc.vertexLayout;
        this.vertexBuffers = desc.vertexBuffers.map(b => toBufferView(b));
        this.elementCount = desc.elementCount;
        this.primitiveType = defaultValue(desc.primitiveType, Gfx.PrimitiveType.Triangles);
        
        if (desc.indexBuffer) {
            this.indexBuffer = toBufferView(desc.indexBuffer);
            this.indexType = defaultValue(desc.indexType, Gfx.Type.Ushort);
        }
    }
}

export class Material {
    shader: Gfx.Id;
    layout: Gfx.ResourceLayout;
    resources: Gfx.Id;

    constructor(device: Gfx.Renderer, shader: Gfx.Id) {
        this.shader = shader;
        this.layout = device.getResourceLayout(shader);
        this.resources = device.createResourceTable(this.layout);
    }

    setUniformBuffer(device: Gfx.Renderer, name: string, value: Gfx.BufferView | Gfx.Id) {
        const binding = assertDefined(this.layout[name], 'Invalid resource name');
        assert(binding.type === Gfx.BindingType.UniformBuffer, 'Mismatching resource type');
        device.setBuffer(this.resources, binding.index, toBufferView(value));
    }

    setTexture(device: Gfx.Renderer, name: string, value: Gfx.TextureView) {
        const binding = assertDefined(this.layout[name], 'Invalid resource name') as Gfx.TextureResourceBinding;
        assert(binding.type === Gfx.BindingType.Texture, 'Mismatching resource type');
        assert(!defined(binding.count), 'Use Material.setTextureArray');
        device.setTexture(this.resources, binding.index, value as Gfx.TextureView);
    }

    setTextureArray(device: Gfx.Renderer, name: string, value: Gfx.TextureView[]) {
        const binding = assertDefined(this.layout[name], 'Invalid resource name') as Gfx.TextureResourceBinding;
        assert(binding.type === Gfx.BindingType.Texture, 'Mismatching resource type');
        assert(defined(binding.count), 'Use Material.setTextureArray');
        device.setTextures(this.resources, binding.index, value);
    }
}

export class Model {
    pipeline: Gfx.Id;
    vertexTable: Gfx.Id;
    primitive: RenderPrimitive;
    renderList: RenderList;

    intialize(device: Gfx.Renderer, renderList: RenderList, mesh: Mesh, material: Material) {
        this.renderList = renderList;

        // @TODO: Pipeline caching
        this.pipeline = device.createRenderPipeline(material.shader, renderList.renderFormat, mesh.vertexLayout, material.layout);
        
        this.vertexTable = device.createVertexTable(this.pipeline);
        for (let i = 0; i < mesh.vertexBuffers.length; i++) {
            device.setVertexBuffer(this.vertexTable, i, mesh.vertexBuffers[i]);
        }

        this.primitive = {
            renderPipeline: this.pipeline,
            resourceTable: material.resources,
            vertexTable: this.vertexTable,
            
            elementCount: mesh.elementCount,
            type: mesh.primitiveType,

            indexBuffer: mesh.indexBuffer,
            indexType: mesh.indexType,
        }
    }
}