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
import type * as appData from "../appData.js";
import type * as appDataShape from "../appDataShape.js";
import type * as authEvents from "../authEvents.js";
import type * as crons from "../crons.js";
import type * as entraSync from "../entraSync.js";
import type * as identity from "../identity.js";
import type * as identityRules from "../identityRules.js";
import type * as me from "../me.js";
import type * as migrate from "../migrate.js";
import type * as mirror from "../mirror.js";
import type * as psBehavior from "../psBehavior.js";
import type * as psSync from "../psSync.js";
import type * as restrictedPolicy from "../restrictedPolicy.js";
import type * as seed from "../seed.js";
import type * as sisAction from "../sisAction.js";
import type * as sisMerge from "../sisMerge.js";
import type * as sisStats from "../sisStats.js";
import type * as sisSync from "../sisSync.js";
import type * as staffInvites from "../staffInvites.js";
import type * as studentDetail from "../studentDetail.js";
import type * as students from "../students.js";
import type * as syncLog from "../syncLog.js";
import type * as views from "../views.js";
import type * as views_app from "../views_app.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accessRules: typeof accessRules;
  appData: typeof appData;
  appDataShape: typeof appDataShape;
  authEvents: typeof authEvents;
  crons: typeof crons;
  entraSync: typeof entraSync;
  identity: typeof identity;
  identityRules: typeof identityRules;
  me: typeof me;
  migrate: typeof migrate;
  mirror: typeof mirror;
  psBehavior: typeof psBehavior;
  psSync: typeof psSync;
  restrictedPolicy: typeof restrictedPolicy;
  seed: typeof seed;
  sisAction: typeof sisAction;
  sisMerge: typeof sisMerge;
  sisStats: typeof sisStats;
  sisSync: typeof sisSync;
  staffInvites: typeof staffInvites;
  studentDetail: typeof studentDetail;
  students: typeof students;
  syncLog: typeof syncLog;
  views: typeof views;
  views_app: typeof views_app;
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
