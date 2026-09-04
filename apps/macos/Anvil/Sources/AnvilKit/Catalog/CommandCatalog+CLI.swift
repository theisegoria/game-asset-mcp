import Foundation

extension CommandCatalog {
    /// Every command form in the CLI's `HELP` text.
    ///
    /// Hand-declared because nothing machine-readable describes CLI flags:
    /// `capabilities` reports argument *names* for registry tools only, and
    /// `KNOWN_FLAGS` is a single global set with no per-command structure. A parity test
    /// diffs this list against the forms parsed out of `game-dev --help`, so a form
    /// added upstream turns the build red rather than quietly going unsurfaced.
    static let cliCommands: [CommandSpec] = [
        // MARK: - Diagnostics

        CommandSpec(
            id: "capabilities",
            path: ["capabilities"],
            title: "Capabilities",
            summary: "Report the runtime's version, providers, command families and local operations.",
            route: .overview
        ),
        CommandSpec(
            id: "doctor",
            path: ["doctor"],
            title: "Doctor",
            summary: "Check the local toolchain: platform, Node, workspace, credentials, Blender and skills.",
            route: .overview
        ),
        CommandSpec(
            id: "credentials.status",
            path: ["credentials", "status"],
            title: "Credential status",
            summary: "Report which provider credentials are configured. Values are never returned.",
            route: .overview
        ),

        // MARK: - MCP

        CommandSpec(
            id: "mcp.serve",
            path: ["mcp", "serve"],
            title: "Serve over MCP",
            summary: "Serve the local operations to an MCP client on stdio.",
            route: .mcp
        ),
        CommandSpec(
            id: "mcp.config",
            path: ["mcp", "config"],
            title: "MCP client configuration",
            summary: "Print ready-to-paste client configuration with the absolute output directory resolved.",
            arguments: [
                .flag(
                    "client",
                    "Client",
                    kind: .choice(["claude-code", "claude-desktop", "codex", "gemini", "generic"]),
                    required: true
                ),
                .flag(
                    "spend-limit-cents",
                    "Spend ceiling (cents)",
                    kind: .integer(minimum: 1, maximum: nil),
                    help: "Without a ceiling the emitted configuration leaves paid tools disabled."
                )
            ],
            route: .mcp
        ),

        // MARK: - Generic tool escape hatch

        CommandSpec(
            id: "tool.call",
            path: ["tool", "call"],
            title: "Call a tool",
            summary: "Invoke any registry tool by name with a JSON request body.",
            arguments: [
                .positional("name", "Tool"),
                .flag("request", "Request body", kind: .jsonRequest),
                .flag("input", "Inline JSON", kind: .text)
            ],
            transport: .events,
            route: .console
        ),

        // MARK: - Providers (the credentialed, paid path)

        CommandSpec(
            id: "provider.tripo",
            path: ["provider", "tripo"],
            title: "Tripo operation",
            summary: "Run a Tripo 3D operation from a JSON request body.",
            arguments: [
                .positional(
                    "operation",
                    "Operation",
                    kind: .choice(["generate", "retexture", "rig", "retarget", "retopologize"])
                ),
                .flag("request", "Request body", kind: .jsonRequest, required: true),
                .flag("spend-limit-cents", "Spend ceiling (cents)", kind: .integer(minimum: 1, maximum: nil), required: true)
            ],
            transport: .events,
            authorities: [.approveSpend],
            spend: .paid(cents: 30, confidence: .documented, basis: "Highest Tripo operation in this family."),
            lane: .workspaceWrite,
            route: .create3D,
            createsDurableJob: true
        ),
        CommandSpec(
            id: "provider.leonardo",
            path: ["provider", "leonardo"],
            title: "Leonardo operation",
            summary: "Run a Leonardo image or sound operation from a JSON request body.",
            arguments: [
                .positional(
                    "operation",
                    "Operation",
                    kind: .choice(["image-generate", "sound-generate"])
                ),
                .flag("request", "Request body", kind: .jsonRequest, required: true),
                .flag("spend-limit-cents", "Spend ceiling (cents)", kind: .integer(minimum: 1, maximum: nil), required: true)
            ],
            transport: .events,
            authorities: [.approveSpend],
            spend: .paid(cents: 10, confidence: .estimated, basis: "Leonardo publishes no rate; the ceiling is a guard, not an invoice."),
            lane: .workspaceWrite,
            route: .createReferences,
            createsDurableJob: true
        ),

        // MARK: - Jobs

        CommandSpec(
            id: "job.list",
            path: ["job", "list"],
            title: "List jobs",
            summary: "List durable CLI jobs and provider asset jobs together.",
            arguments: [
                .flag("limit", "Limit", kind: .integer(minimum: 1, maximum: 200)),
                .flag("status", "Status", kind: .text)
            ],
            route: .runs
        ),
        CommandSpec(
            id: "job.show",
            path: ["job", "show"],
            title: "Show a job",
            summary: "Show one job's record, with optional full detail.",
            arguments: [
                .positional("jobID", "Job"),
                .flag("detail", "Full detail", kind: .boolean)
            ],
            route: .runs
        ),
        CommandSpec(
            id: "job.follow",
            path: ["job", "follow"],
            title: "Follow a job",
            summary: "Replay a job's persisted events and keep streaming until it settles.",
            arguments: [
                .positional("jobID", "Job"),
                .flag("max-seconds", "Maximum wait", kind: .integer(minimum: 1, maximum: 3600))
            ],
            transport: .events,
            route: .runs
        ),
        CommandSpec(
            id: "job.resume",
            path: ["job", "resume"],
            title: "Resume a job",
            summary: "Retry an interrupted job as a new attempt. Authorities are re-taken, never replayed.",
            arguments: [
                .positional("jobID", "Job"),
                .flag("spend-limit-cents", "Spend ceiling (cents)", kind: .integer(minimum: 1, maximum: nil))
            ],
            transport: .events,
            authorities: [.confirm, .approveSpend],
            spend: .paid(cents: 30, confidence: .estimated, basis: "A resumed job may repeat the original paid call."),
            lane: .workspaceWrite,
            route: .runs,
            createsDurableJob: true
        ),
        CommandSpec(
            id: "job.cancel",
            path: ["job", "cancel"],
            title: "Cancel a job",
            summary: "Mark a job cancelled so it cannot be resumed.",
            arguments: [.positional("jobID", "Job")],
            authorities: [.confirm],
            route: .runs
        ),

        // MARK: - Assets on disk

        CommandSpec(
            id: "asset.inspect",
            path: ["asset", "inspect"],
            title: "Inspect a model",
            summary: "Measure geometry, materials, textures and bounds of a glTF or GLB file.",
            arguments: [.positional("model", "Model", kind: .path)],
            route: .mesh
        ),
        CommandSpec(
            id: "asset.validate",
            path: ["asset", "validate"],
            title: "Validate a model",
            summary: "Check a model against the asset policy and report only what fails.",
            arguments: [
                .positional("model", "Model", kind: .path),
                .flag("request", "Policy overrides", kind: .jsonRequest)
            ],
            route: .mesh
        ),
        CommandSpec(
            id: "asset.normalize",
            path: ["asset", "normalize"],
            title: "Normalize a mesh",
            summary: "Repair a mesh with Blender: unwrap UVs, weld, dissolve degenerates, tidy materials.",
            arguments: [
                .positional("model", "Model", kind: .path),
                .flag("output", "Output path", kind: .path),
                .flag("request", "Options", kind: .jsonRequest)
            ],
            transport: .events,
            lane: .workspaceWrite,
            route: .mesh,
            createsDurableJob: true
        ),
        CommandSpec(
            id: "asset.preview-usdz",
            path: ["asset", "preview-usdz"],
            title: "Build a USDZ preview",
            summary: "Export a Quick Look-able USDZ preview through Blender and usdzip.",
            arguments: [
                .positional("model", "Model", kind: .path),
                .flag("output", "Output path", kind: .path, required: true)
            ],
            transport: .events,
            lane: .workspaceWrite,
            route: .mesh,
            createsDurableJob: true
        ),

        // MARK: - Packages

        CommandSpec(
            id: "package.build",
            path: ["package", "build"],
            title: "Build a package",
            summary: "Package a model with its metadata, provenance and validation into the package store.",
            arguments: [
                .positional("model", "Model", kind: .path),
                .flag("name", "Name", required: true),
                .flag("package-version", "Version"),
                .flag("license", "License (SPDX)"),
                .flag("description", "Description"),
                .flag("category", "Category"),
                .flag("preview", "Preview", kind: .path),
                .flag("request", "Metadata", kind: .jsonRequest),
                .flag(
                    "dry-run",
                    "Preview only",
                    kind: .boolean,
                    help: "Reports the destination a build would use. No package id is assigned, because computing one means doing the write the plan exists to avoid."
                )
            ],
            transport: .events,
            lane: .packageStore,
            route: .library,
            createsDurableJob: true
        ),
        CommandSpec(
            id: "package.show",
            path: ["package", "show"],
            title: "Show a package",
            summary: "Show a package's manifest, files and validation result.",
            arguments: [.positional("package", "Package")],
            route: .library
        ),
        CommandSpec(
            id: "package.verify",
            path: ["package", "verify"],
            title: "Verify a package",
            summary: "Re-hash a package's files and confirm they match its manifest.",
            arguments: [.positional("package", "Package")],
            route: .library
        ),

        // MARK: - Catalog

        CommandSpec(
            id: "catalog.list",
            path: ["catalog", "list"],
            title: "Browse the catalog",
            summary: "List indexed packages, filtered by text, category or validation state.",
            arguments: [
                .flag("query", "Search"),
                .flag("category", "Category"),
                .flag("valid", "Valid only", kind: .boolean),
                .flag("invalid", "Invalid only", kind: .boolean),
                .flag("limit", "Limit", kind: .integer(minimum: 1, maximum: 1000))
            ],
            route: .library
        ),
        CommandSpec(
            id: "catalog.show",
            path: ["catalog", "show"],
            title: "Show a catalog entry",
            summary: "Show one indexed package's catalog record.",
            arguments: [.positional("package", "Package")],
            route: .library
        ),
        CommandSpec(
            id: "catalog.admit",
            path: ["catalog", "admit"],
            title: "Admit into the catalog",
            summary: "Index a built package so it can be searched and vendored.",
            arguments: [
                .positional("package", "Package path", kind: .path),
                .flag("dry-run", "Preview only", kind: .boolean)
            ],
            transport: .events,
            lane: .catalogIndex,
            route: .library,
            createsDurableJob: true
        ),
        CommandSpec(
            id: "catalog.rebuild",
            path: ["catalog", "rebuild"],
            title: "Rebuild the catalog",
            summary: "Re-derive the whole index from the package store. The catalog is derived state.",
            transport: .events,
            authorities: [.confirm],
            lane: .catalogIndex,
            route: .library,
            createsDurableJob: true
        ),

        // MARK: - Vendoring, launching, migrating

        CommandSpec(
            id: "vendor.admit",
            path: ["vendor", "admit"],
            title: "Vendor into a project",
            summary: "Copy a verified package into a game project and record it in the vendor lock.",
            arguments: [
                .positional("package", "Package"),
                .flag("project", "Project", kind: .directory, required: true),
                .flag("destination", "Destination (relative)"),
                .flag("allow-unknown-license", "Allow unknown license", kind: .boolean),
                .flag("allow-invalid", "Allow invalid package", kind: .boolean)
            ],
            transport: .events,
            authorities: [.confirm],
            lane: .packageStore,
            route: .library,
            createsDurableJob: true
        ),
        CommandSpec(
            id: "launch.plan",
            path: ["launch"],
            title: "Open a package",
            summary: "Reveal a package in Finder, preview it in Quick Look, or open it in Blender.",
            arguments: [
                .positional("package", "Package"),
                .flag(
                    "with",
                    "Open with",
                    kind: .choice(["finder", "quicklook", "blender"]),
                    required: true
                )
            ],
            authorities: [.confirm],
            route: .library,
            createsDurableJob: true
        ),
        CommandSpec(
            id: "migrate.legacy",
            path: ["migrate", "legacy"],
            title: "Migrate a legacy workspace",
            summary: "Convert downloaded jobs from an older workspace into canonical packages.",
            arguments: [
                .flag("from", "Legacy output root", kind: .directory, required: true),
                .flag("license", "Default license (SPDX)")
            ],
            transport: .events,
            authorities: [.confirm],
            lane: .packageStore,
            route: .setup,
            createsDurableJob: true
        ),

        // MARK: - Adapters and scenarios

        CommandSpec(
            id: "adapter.templates",
            path: ["adapter", "templates"],
            title: "Adapter templates",
            summary: "List the capture adapter templates that ship with the toolchain.",
            route: .setup
        ),
        CommandSpec(
            id: "adapter.install",
            path: ["adapter", "install"],
            title: "Install an adapter",
            summary: "Write a capture adapter manifest into a project, refusing to overwrite a different one.",
            arguments: [
                .positional("template", "Template"),
                .flag("project", "Project", kind: .directory, required: true)
            ],
            authorities: [.confirm],
            lane: .project("project"),
            route: .setup,
            createsDurableJob: true
        ),
        CommandSpec(
            id: "probe.install",
            path: ["probe", "install"],
            title: "Install the probe SDK",
            summary: "Vendor the probe SDK sources into a project. The harness never compiles them; the game's build does.",
            arguments: [
                .flag("project", "Project", kind: .directory, required: true),
                .flag("destination", "Destination (relative)")
            ],
            authorities: [.confirm],
            lane: .project("project"),
            route: .setup,
            createsDurableJob: true
        ),
        CommandSpec(
            id: "adapter.inspect",
            path: ["adapter", "inspect"],
            title: "Inspect an adapter",
            summary: "Read a project's adapter manifest and report its scenarios and capabilities.",
            arguments: [
                .flag("project", "Project", kind: .directory, required: true),
                .flag("manifest", "Manifest (relative)")
            ],
            route: .setup
        ),
        CommandSpec(
            id: "scenario.list",
            path: ["scenario", "list"],
            title: "List scenarios",
            summary: "List the capture scenarios a project's adapter declares.",
            arguments: [
                .flag("project", "Project", kind: .directory, required: true),
                .flag("manifest", "Manifest (relative)")
            ],
            route: .scenarios
        ),
        CommandSpec(
            id: "scenario.plan",
            path: ["scenario", "plan"],
            title: "Plan a scenario",
            summary: "Resolve a scenario into the exact process, arguments and authorities a run would need.",
            arguments: [
                .positional("scenario", "Scenario"),
                .flag("project", "Project", kind: .directory, required: true),
                .flag("request", "Parameters", kind: .jsonRequest)
            ],
            route: .scenarios
        ),
        CommandSpec(
            id: "scenario.run",
            path: ["scenario", "run"],
            title: "Run a scenario",
            summary: "Execute a planned scenario and seal the result into a run bundle.",
            arguments: [
                .positional("scenario", "Scenario"),
                .flag("project", "Project", kind: .directory, required: true),
                .flag("request", "Parameters", kind: .jsonRequest)
            ],
            transport: .events,
            authorities: [.confirm, .allowGPU, .allowPerformance],
            lane: .project("project"),
            route: .scenarios,
            createsDurableJob: true
        ),
        CommandSpec(
            id: "capture.verify",
            path: ["capture", "verify"],
            title: "Verify a run bundle",
            summary: "Re-check a sealed run's closed artifact roster and canonical manifest.",
            arguments: [.positional("run", "Run")],
            route: .scenarios
        ),

        // MARK: - Visual

        CommandSpec(
            id: "visual.analyze",
            path: ["visual", "analyze"],
            title: "Analyze a capture",
            summary: "Decode every raster attachment in a run and report per-channel statistics.",
            arguments: [.positional("run", "Run")],
            route: .visual
        ),
        CommandSpec(
            id: "visual.compare",
            path: ["visual", "compare"],
            title: "Compare captures",
            summary: "Diff two sealed runs, with per-pixel metrics, semantic regions and a heatmap.",
            arguments: [
                .positional("baseline", "Baseline"),
                .positional("candidate", "Candidate"),
                .flag("threshold", "Threshold", kind: .integer(minimum: 0, maximum: 255)),
                .flag("output", "Output directory", kind: .directory)
            ],
            transport: .events,
            lane: .workspaceWrite,
            route: .visual,
            createsDurableJob: true
        ),

        // MARK: - Performance

        CommandSpec(
            id: "performance.summarize",
            path: ["performance", "summarize"],
            title: "Summarize performance",
            summary: "Aggregate a run's metrics into per-metric distributions.",
            arguments: [.positional("run", "Run")],
            route: .performance
        ),
        CommandSpec(
            id: "performance.compare",
            path: ["performance", "compare"],
            title: "Compare performance",
            summary: "Compare two runs metric by metric at a chosen statistic.",
            arguments: [
                .positional("baseline", "Baseline"),
                .positional("candidate", "Candidate"),
                .flag(
                    "stat",
                    "Statistic",
                    kind: .choice(["min", "max", "mean", "median", "p95", "p99"])
                )
            ],
            route: .performance
        ),
        CommandSpec(
            id: "performance.goal-create",
            path: ["performance", "goal-create"],
            title: "Create an optimization goal",
            summary: "Bind a baseline run to a target metric, direction and iteration budget.",
            arguments: [
                .positional("baseline", "Baseline run"),
                .flag("project", "Project", kind: .directory, required: true),
                .flag("request", "Goal", kind: .jsonRequest, required: true)
            ],
            authorities: [.confirm],
            lane: .project("project"),
            route: .performance,
            createsDurableJob: true
        ),
        CommandSpec(
            id: "performance.goal-evaluate",
            path: ["performance", "goal-evaluate"],
            title: "Evaluate an optimization goal",
            summary: "Score a candidate run against a goal and consume one iteration of its budget.",
            arguments: [
                .positional("goal", "Goal file", kind: .path),
                .positional("candidate", "Candidate run")
            ],
            authorities: [.confirm],
            lane: .project("project"),
            route: .performance,
            createsDurableJob: true
        ),

        // MARK: - Skills

        CommandSpec(
            id: "skill.list",
            path: ["skill", "list"],
            title: "List skills",
            summary: "List the packaged agent skills and their content digests.",
            route: .setup
        ),
        CommandSpec(
            id: "skill.install",
            path: ["skill", "install"],
            title: "Install skills",
            summary: "Copy packaged skills into a Codex skills directory, refusing symlinked targets.",
            arguments: [
                .positional("skill", "Skill"),
                .flag("target", "Target directory", kind: .directory)
            ],
            authorities: [.confirm],
            lane: .skillsRoot,
            route: .setup,
            createsDurableJob: true
        )
    ]
}
