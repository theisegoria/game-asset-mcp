import Foundation

/// What a scenario asks the harness for.
///
/// The API lanes describe *which* graphics API a scenario wants; none of them weakens
/// the `gpu` gate, which remains the thing that authorizes hardware use. Anvil therefore
/// never derives an authority from a capability — it reads the resolved plan's
/// `requiredAuthorizations`. See ``ScenarioPlan``.
public enum ScenarioCapability: String, Sendable, Hashable, Codable, CaseIterable {
    case cpu
    case projectWrite = "project-write"
    case gpu
    case performance
    case metal
    case vulkan
    case webgpu
    case opengl
    /// A software rasterizer is not a GPU. It runs on the CPU authorization path
    /// deliberately: demanding GPU authority for lavapipe would train people to grant
    /// it for runs that never touch a GPU.
    case softwareRaster = "software-raster"

    public var label: String {
        switch self {
        case .cpu: "CPU"
        case .projectWrite: "Writes to the project"
        case .gpu: "GPU"
        case .performance: "Performance timing"
        case .metal: "Metal"
        case .vulkan: "Vulkan"
        case .webgpu: "WebGPU"
        case .opengl: "OpenGL"
        case .softwareRaster: "Software rasterizer"
        }
    }

    /// True for the capabilities that name a graphics API rather than an authority.
    public var isGraphicsLane: Bool {
        switch self {
        case .metal, .vulkan, .webgpu, .opengl, .softwareRaster: true
        case .cpu, .projectWrite, .gpu, .performance: false
        }
    }
}

/// A raster or data attachment inside a capture.
public enum AttachmentKind: String, Sendable, Hashable, Codable, CaseIterable {
    case color
    case depth
    case normal
    case objectID = "object_id"
    case materialID = "material_id"
    case motion
    case overdraw
    case albedo
    case wireframe
    case uvChecker = "uv_checker"
    case mipmapLevel = "mipmap_level"
    case stencil
    case shaderComplexity = "shader_complexity"
    case lightComplexity = "light_complexity"
    case custom

    public var label: String {
        switch self {
        case .color: "Colour"
        case .depth: "Depth"
        case .normal: "Normals"
        case .objectID: "Object IDs"
        case .materialID: "Material IDs"
        case .motion: "Motion"
        case .overdraw: "Overdraw"
        case .albedo: "Albedo"
        case .wireframe: "Wireframe"
        case .uvChecker: "UV checker"
        case .mipmapLevel: "Mip level"
        case .stencil: "Stencil"
        case .shaderComplexity: "Shader cost"
        case .lightComplexity: "Light cost"
        case .custom: "Custom"
        }
    }

    /// What this attachment lets someone rule out. Shown next to the viewer, because a
    /// buffer nobody can interpret is decoration.
    public var diagnosticPurpose: String {
        switch self {
        case .color: "What the frame actually looked like."
        case .depth: "Depth fighting, near and far plane error, and sorting problems."
        case .normal: "Wrong normals, flipped tangents and broken normal maps."
        case .objectID: "Which object each pixel belongs to, and what a diff actually changed."
        case .materialID: "Which material shaded each pixel."
        case .motion: "Motion vectors, and whether temporal effects have the movement they expect."
        case .overdraw: "How many times each pixel was shaded."
        case .albedo: "Separates a texture-binding failure from a lighting one."
        case .wireframe:
            "Separates wrong geometry from wrong shading. Correct silhouettes over a black colour buffer mean the mesh and transforms are fine."
        case .uvChecker:
            "Flipped or mirrored UVs, wrong tiling, a missing second UV set, and inconsistent texel density — none of which a colour render shows."
        case .mipmapLevel: "Which mip was sampled, and where texture streaming picked wrong."
        case .stencil: "Stencil state, and masks that did not apply where expected."
        case .shaderComplexity: "An engine-authored estimate of shading cost."
        case .lightComplexity: "An engine-authored estimate of lighting cost."
        case .custom: "An attachment this build does not interpret."
        }
    }

    /// True when the values are the engine's own heuristic rather than a rendered
    /// quantity. Such an attachment is meaningless without the cost model beside it,
    /// so the viewer must show the attachment's `description`.
    public var isEngineAuthoredHeuristic: Bool {
        self == .shaderComplexity || self == .lightComplexity
    }

    /// Semantic buffers carry identifiers, not colour. Resampling or gamma-correcting
    /// them destroys their meaning, so they are displayed with a categorical palette
    /// and never interpolated.
    public var isSemantic: Bool {
        self == .objectID || self == .materialID
    }

    /// Data buffers whose values are linear. Treating one as sRGB bends the numbers —
    /// the normal-map case the toolchain's own resampler warns about.
    public var isLinearData: Bool {
        switch self {
        case .depth, .normal, .motion, .overdraw, .mipmapLevel, .stencil,
             .shaderComplexity, .lightComplexity:
            true
        case .color, .albedo, .uvChecker, .wireframe, .objectID, .materialID, .custom:
            false
        }
    }
}

/// What the harness concluded the renderer was, *after* applying its own downgrade.
public enum RendererClass: String, Sendable, Hashable, Codable, CaseIterable {
    case hardware
    case software
    /// The default, and a legitimate state rather than a failure: nobody claimed a
    /// renderer, so the honest answer is that it is not known.
    case unknown

    public var label: String {
        switch self {
        case .hardware: "Hardware renderer"
        case .software: "Software rasterizer"
        case .unknown: "Renderer not declared"
        }
    }
}

/// Graphics environment variables a scenario may declare for its own process.
///
/// A hardcoded allowlist, mirroring the harness. `LD_*`, `DYLD_*`, `DISPLAY` and the
/// `GAME_DEV_*` contract names are refused upstream: the first two are loader-injection
/// vectors, and a manifest able to set `GAME_DEV_RUN_DIR` could aim the capture write
/// anywhere.
public enum GraphicsEnvironment {
    public static let allowed: Set<String> = [
        "VK_ICD_FILENAMES", "VK_DRIVER_FILES", "VK_LAYER_PATH", "VK_INSTANCE_LAYERS",
        "LIBGL_ALWAYS_SOFTWARE", "MESA_LOADER_DRIVER_OVERRIDE", "EGL_PLATFORM",
        "MTL_CAPTURE_ENABLED", "MTL_DEBUG_LAYER", "MTL_SHADER_VALIDATION",
        "WGPU_BACKEND", "DRI_PRIME", "RUST_BACKTRACE"
    ]
}
