import { resolveGraphConfig } from "/Users/dmestas/projects/qkb/src/graph/config.js";
const r1 = resolveGraphConfig({ collections: {} });
console.log("DEFAULTS:", JSON.stringify(r1, null, 2));
const r2 = resolveGraphConfig({ collections: {}, graph: { enabled: true } });
console.log("ENABLED:", JSON.stringify(r2, null, 2));
