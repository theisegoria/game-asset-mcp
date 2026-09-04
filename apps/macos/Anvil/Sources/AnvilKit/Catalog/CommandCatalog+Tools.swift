import Foundation

extension CommandCatalog {
    /// The registry tools, reached through `game-dev tool call <name>`.
    ///
    /// Only the metadata that is *not* machine-readable lives here: title, summary,
    /// spend class, exclusion lane and UI route. Argument schemas are deliberately
    /// absent — MCP `tools/list` publishes the real JSON Schema for every one of these,
    /// so Anvil harvests it at runtime instead of transcribing ~200 fields that would
    /// drift the first time an upstream default changed.
    ///
    /// Cost figures mirror `src/domain/spend.ts`. `documented` means the provider
    /// publishes the rate; `estimated` means it does not, and the ceiling is a refusal
    /// guard rather than an invoice.
    static let toolCommands: [CommandSpec] = [
        tool(
            "preview_asset_prompt",
            title: "Preview a prompt",
            summary: "Show the prompt, negative prompt and directives a spec would produce. Free and local.",
            route: .createPrompt
        ),
        tool(
            "create_game_prop",
            title: "Start a prop from a brief",
            summary: "Turn a brief into reference candidates. Stops before 3D spend so art direction stays human.",
            spend: .paid(cents: 10, confidence: .estimated, basis: "Leonardo, per image."),
            lane: .workspaceWrite,
            route: .createBrief,
            durable: true
        ),
        tool(
            "generate_asset_reference",
            title: "Generate references",
            summary: "Generate reference images for an asset spec.",
            spend: .paid(cents: 10, confidence: .estimated, basis: "Leonardo, per image."),
            lane: .workspaceWrite,
            route: .createReferences,
            durable: true
        ),
        tool(
            "generate_reference_variations",
            title: "Explore variations",
            summary: "Vary an existing reference along one axis, as a child job.",
            spend: .paid(cents: 10, confidence: .estimated, basis: "Leonardo, per image."),
            lane: .workspaceWrite,
            route: .createReferences,
            durable: true
        ),
        tool(
            "select_reference",
            title: "Select a reference",
            summary: "Choose which candidate to reconstruct. Free, and the step that advances the job.",
            route: .createReferences,
            durable: true
        ),
        tool(
            "create_3d_asset",
            title: "Reconstruct in 3D",
            summary: "Reconstruct a mesh from a reference, image or prompt. Asynchronous; provider URLs expire.",
            spend: .paid(cents: 30, confidence: .documented, basis: "Tripo image-to-3D with texture, 30 credits at $0.01."),
            lane: .workspaceWrite,
            route: .create3D,
            durable: true
        ),
        tool(
            "texture_existing_asset",
            title: "Texture a mesh",
            summary: "Generate PBR textures for a mesh you already have, preserving geometry and UVs.",
            spend: .paid(cents: 20, confidence: .documented, basis: "Tripo HD texture."),
            lane: .workspaceWrite,
            route: .create3D,
            durable: true
        ),
        tool(
            "rig_asset",
            title: "Rig an asset",
            summary: "Generate a skeleton and skin weights. Must precede animation.",
            spend: .paid(cents: 25, confidence: .documented, basis: "Tripo auto-rig."),
            lane: .workspaceWrite,
            route: .create3D,
            durable: true
        ),
        tool(
            "animate_asset",
            title: "Animate an asset",
            summary: "Retarget an animation onto a rigged asset. Refuses an unrigged source.",
            spend: .paid(cents: 10, confidence: .documented, basis: "Tripo animation retarget, per animation."),
            lane: .workspaceWrite,
            route: .create3D,
            durable: true
        ),
        tool(
            "retopologize_asset",
            title: "Retopologize",
            summary: "Rebuild an asset's topology, optionally as quads.",
            spend: .paid(cents: 30, confidence: .documented, basis: "Tripo smart retopology v2."),
            lane: .workspaceWrite,
            route: .create3D,
            durable: true
        ),
        tool(
            "generate_sound_effect",
            title: "Generate a sound effect",
            summary: "Generate a game sound effect or ambience loop into the workspace.",
            spend: .paid(cents: 10, confidence: .estimated, basis: "Leonardo, per clip."),
            lane: .workspaceWrite,
            route: .createAudio,
            durable: true
        ),
        tool(
            "get_asset_job",
            title: "Get a job",
            summary: "Read one asset job, refreshing its provider state. Never spends.",
            route: .runs
        ),
        tool(
            "list_asset_jobs",
            title: "List asset jobs",
            summary: "List asset jobs newest first, without contacting the provider.",
            route: .runs
        ),
        tool(
            "download_asset",
            title: "Download an asset",
            summary: "Download a finished asset and extract embedded textures. Free, but writes files.",
            lane: .workspaceWrite,
            route: .create3D,
            durable: true
        ),
        tool(
            "inspect_asset",
            title: "Inspect an asset",
            summary: "Measure geometry, materials, textures and bounds. Free and fully local.",
            route: .mesh
        ),
        tool(
            "extract_pbr_trio",
            title: "Extract PBR planes",
            summary: "Split a material into albedo, normal, roughness, metallic and occlusion planes.",
            lane: .workspaceWrite,
            route: .mesh,
            durable: true
        ),
        tool(
            "normalize_mesh",
            title: "Normalize a mesh",
            summary: "Repair a mesh with Blender so it can be textured and shipped.",
            lane: .workspaceWrite,
            route: .mesh,
            durable: true
        ),
        tool(
            "validate_game_asset",
            title: "Validate an asset",
            summary: "Check an asset against the policy, with every threshold overridable.",
            route: .mesh
        ),
        tool(
            "batch_prepare_meshes",
            title: "Prepare meshes in bulk",
            summary: "Validate, normalize and re-validate up to 500 meshes. Degrades to report-only without Blender.",
            lane: .workspaceWrite,
            route: .mesh,
            durable: true
        ),
        tool(
            "get_spend_report",
            title: "Spend report",
            summary: "Running total, headroom and per-tool breakdown, flagging which figures are estimates.",
            route: .spend
        ),

        // The five harness tools that moved onto the shared registry, so they are
        // reachable over both transports rather than through CLI dispatch alone.
        tool(
            "verify_capture_run",
            title: "Verify a run",
            summary: "Re-check a sealed run bundle's closed roster and canonical manifest.",
            route: .scenarios
        ),
        tool(
            "analyze_capture_run",
            title: "Analyze a capture",
            summary: "Decode a run's raster attachments and report per-channel statistics.",
            route: .visual
        ),
        tool(
            "compare_capture_visuals",
            title: "Compare captures",
            summary: "Diff two runs with per-pixel metrics, semantic regions and a heatmap.",
            lane: .workspaceWrite,
            route: .visual,
            durable: true
        ),
        // Scenario planning and execution reached the registry with their own gate:
        // `run_scenario` starts a process the harness did not write, so MCP confirms it
        // per call rather than relying on launch-time authority alone. Anvil mirrors
        // that by requiring the same three authorities the CLI demands.
        tool(
            "plan_scenario_run",
            title: "Plan a scenario",
            summary: "Resolve a scenario into the process, arguments and authorities a run would need. Runs nothing.",
            route: .scenarios
        ),
        tool(
            "run_scenario",
            title: "Run a scenario",
            summary: "Execute a scenario the project owns and seal the result into a run bundle.",
            lane: .workspaceWrite,
            route: .scenarios,
            durable: true,
            authorities: [.confirm, .allowGPU, .allowPerformance]
        ),
        tool(
            "summarize_run_performance",
            title: "Summarize performance",
            summary: "Aggregate a run's metrics into per-metric distributions.",
            route: .performance
        ),
        tool(
            "compare_run_performance",
            title: "Compare performance",
            summary: "Compare two runs metric by metric, carrying sample counts and deviations.",
            route: .performance
        )
    ]

    private static func tool(
        _ name: String,
        title: String,
        summary: String,
        spend: SpendClass = .free,
        lane: ExclusionLane = .none,
        route: WorkspaceRoute,
        durable: Bool = false,
        authorities: Set<Authority> = []
    ) -> CommandSpec {
        CommandSpec(
            id: "tool.\(name)",
            path: ["tool", "call", name],
            title: title,
            summary: summary,
            arguments: [.flag("request", "Request body", kind: .jsonRequest)],
            transport: .events,
            authorities: spend.isPaid ? authorities.union([.approveSpend]) : authorities,
            spend: spend,
            lane: lane,
            route: route,
            registryTool: name,
            createsDurableJob: durable
        )
    }
}
