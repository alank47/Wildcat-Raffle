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
import type * as auditLog from "../auditLog.js";
import type * as auditMigrate from "../auditMigrate.js";
import type * as auditMigrateRead from "../auditMigrateRead.js";
import type * as authEvents from "../authEvents.js";
import type * as bellSchedules from "../bellSchedules.js";
import type * as crons from "../crons.js";
import type * as disciplineAggregates from "../disciplineAggregates.js";
import type * as entraSync from "../entraSync.js";
import type * as hallPassRules from "../hallPassRules.js";
import type * as hallPasses from "../hallPasses.js";
import type * as identity from "../identity.js";
import type * as identityRules from "../identityRules.js";
import type * as legacyData from "../legacyData.js";
import type * as mail from "../mail.js";
import type * as me from "../me.js";
import type * as mealPins from "../mealPins.js";
import type * as migrate from "../migrate.js";
import type * as mirror from "../mirror.js";
import type * as passCard from "../passCard.js";
import type * as psBehavior from "../psBehavior.js";
import type * as psSync from "../psSync.js";
import type * as push from "../push.js";
import type * as pushSend from "../pushSend.js";
import type * as raceRollup from "../raceRollup.js";
import type * as restrictedPolicy from "../restrictedPolicy.js";
import type * as rosterEmail from "../rosterEmail.js";
import type * as scheduleRules from "../scheduleRules.js";
import type * as seed from "../seed.js";
import type * as seedBellSchedules from "../seedBellSchedules.js";
import type * as seedTestRoster from "../seedTestRoster.js";
import type * as sisAction from "../sisAction.js";
import type * as sisMerge from "../sisMerge.js";
import type * as sisStats from "../sisStats.js";
import type * as sisSync from "../sisSync.js";
import type * as staffInvites from "../staffInvites.js";
import type * as studentDetail from "../studentDetail.js";
import type * as studentEmail from "../studentEmail.js";
import type * as studentPortalRules from "../studentPortalRules.js";
import type * as studentProfileRules from "../studentProfileRules.js";
import type * as syncLog from "../syncLog.js";
import type * as tapLocations from "../tapLocations.js";
import type * as tapSlug from "../tapSlug.js";
import type * as tombstones from "../tombstones.js";
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
  auditLog: typeof auditLog;
  auditMigrate: typeof auditMigrate;
  auditMigrateRead: typeof auditMigrateRead;
  authEvents: typeof authEvents;
  bellSchedules: typeof bellSchedules;
  crons: typeof crons;
  disciplineAggregates: typeof disciplineAggregates;
  entraSync: typeof entraSync;
  hallPassRules: typeof hallPassRules;
  hallPasses: typeof hallPasses;
  identity: typeof identity;
  identityRules: typeof identityRules;
  legacyData: typeof legacyData;
  mail: typeof mail;
  me: typeof me;
  mealPins: typeof mealPins;
  migrate: typeof migrate;
  mirror: typeof mirror;
  passCard: typeof passCard;
  psBehavior: typeof psBehavior;
  psSync: typeof psSync;
  push: typeof push;
  pushSend: typeof pushSend;
  raceRollup: typeof raceRollup;
  restrictedPolicy: typeof restrictedPolicy;
  rosterEmail: typeof rosterEmail;
  scheduleRules: typeof scheduleRules;
  seed: typeof seed;
  seedBellSchedules: typeof seedBellSchedules;
  seedTestRoster: typeof seedTestRoster;
  sisAction: typeof sisAction;
  sisMerge: typeof sisMerge;
  sisStats: typeof sisStats;
  sisSync: typeof sisSync;
  staffInvites: typeof staffInvites;
  studentDetail: typeof studentDetail;
  studentEmail: typeof studentEmail;
  studentPortalRules: typeof studentPortalRules;
  studentProfileRules: typeof studentProfileRules;
  syncLog: typeof syncLog;
  tapLocations: typeof tapLocations;
  tapSlug: typeof tapSlug;
  tombstones: typeof tombstones;
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
