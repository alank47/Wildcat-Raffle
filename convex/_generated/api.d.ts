/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accessRules from "../accessRules.js";
import type * as authEvents from "../authEvents.js";
import type * as identity from "../identity.js";
import type * as identityRules from "../identityRules.js";
import type * as me from "../me.js";
import type * as migrate from "../migrate.js";
import type * as mirror from "../mirror.js";
import type * as psSync from "../psSync.js";
import type * as seed from "../seed.js";
import type * as sisMerge from "../sisMerge.js";
import type * as sisStats from "../sisStats.js";
import type * as sisSync from "../sisSync.js";
import type * as studentDetail from "../studentDetail.js";
import type * as students from "../students.js";
import type * as views from "../views.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accessRules: typeof accessRules;
  authEvents: typeof authEvents;
  identity: typeof identity;
  identityRules: typeof identityRules;
  me: typeof me;
  migrate: typeof migrate;
  mirror: typeof mirror;
  psSync: typeof psSync;
  seed: typeof seed;
  sisMerge: typeof sisMerge;
  sisStats: typeof sisStats;
  sisSync: typeof sisSync;
  studentDetail: typeof studentDetail;
  students: typeof students;
  views: typeof views;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
