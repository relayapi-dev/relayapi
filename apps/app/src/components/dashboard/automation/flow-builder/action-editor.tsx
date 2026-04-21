// Action-editor barrel (Plan 2 — Unit B4, Phase O).
//
// The real editor lives under `./action-editor/`. This file exists so
// `import { ActionEditor } from "./action-editor";` keeps working for the
// property-panel dispatcher without forcing it to know about the directory
// layout.

export * from "./action-editor/index";
