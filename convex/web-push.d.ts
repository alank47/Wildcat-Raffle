// web-push ships no types. It is only used inside a "use node" action; a loose
// declaration keeps the Convex typecheck happy without pulling a @types dep into
// this Dropbox-hosted repo (npm installs here are flaky).
declare module "web-push";
