/* mldsa-native configuration for the Graak host: the C backend, all three parameter sets in one build, and only the
 * deterministic API (the JavaScript layer supplies the randomness). */
#ifndef MLD_CONFIG_H
#define MLD_CONFIG_H

#ifndef MLD_CONFIG_PARAMETER_SET
#define MLD_CONFIG_PARAMETER_SET 65
#endif

#define MLD_CONFIG_NAMESPACE_PREFIX mldsa
#define MLD_CONFIG_MULTILEVEL_BUILD
#define MLD_CONFIG_NO_RANDOMIZED_API
#define MLD_CONFIG_NO_ASM

/* No memset_s or explicit_bzero on every target (the old Windows CRTs have neither): fg_pqc.c clears through a volatile pointer. */
#define MLD_CONFIG_CUSTOM_ZEROIZE
#define mld_zeroize fg_pqc_zeroize

#endif /* MLD_CONFIG_H */
