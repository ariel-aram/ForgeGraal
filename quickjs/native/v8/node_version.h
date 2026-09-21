#ifndef GRAAK_NODE_VERSION_H_
#define GRAAK_NODE_VERSION_H_

/*
 * The Node.js version a V8 addon sees when it is built against Graak's V8 layer. It claims a
 * mature API generation (Node 12: Maybe/MaybeLocal everywhere, context arguments) rather than the
 * newest one, because that is the surface NAN and most addons already target, and every one of them
 * still compiles against it.
 */
#define NODE_MAJOR_VERSION 12
#define NODE_MINOR_VERSION 22
#define NODE_PATCH_VERSION 12
#define NODE_VERSION_IS_RELEASE 1
#define NODE_MODULE_VERSION 72
#define NODE_VERSION_AT_LEAST(major, minor, patch)                                                       \
    ((major) < NODE_MAJOR_VERSION || ((major) == NODE_MAJOR_VERSION && (minor) < NODE_MINOR_VERSION) ||    \
     ((major) == NODE_MAJOR_VERSION && (minor) == NODE_MINOR_VERSION && (patch) <= NODE_PATCH_VERSION))

#endif
