import "./types-BvOK8Gds.js";
import { Context } from "@deepseek-ai/cordis";
//#region src/invariant.d.ts
/** Cordis companion plugin name. */
declare const name = "agent-codex-invariant";
/** Invariant registry required by the companion. */
declare const inject: string[];
/** Register the package invariant companion. */
declare const apply: (ctx: Context) => Promise<() => void>;
//#endregion
export { apply, inject, name };