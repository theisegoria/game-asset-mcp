# Applications

Native user interfaces live under this directory. They are optional control
surfaces over the same local `game-dev` protocol used by the CLI and skills;
they do not replace the cross-platform core.

| Platform | Product | Status |
| --- | --- | --- |
| macOS 26, Apple silicon | [Game Development Studio](macos/GameDevelopmentStudio/README.md) | SwiftUI + SwiftPM source and a separately packaged binary release |

Run native development and release workflows through the repository-root
scripts so bundle metadata, icons, signing state, and verification stay
consistent. See [Native macOS app](../docs/macos-app.md) for the architectural,
credential, approval, and evidence boundaries.
