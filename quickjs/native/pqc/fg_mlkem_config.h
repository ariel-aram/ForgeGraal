/* mlkem-native configuration for the Graak host: the C backend, all three parameter sets in one build, and only the
 * deterministic API (the JavaScript layer supplies the randomness). */
#ifndef MLK_CONFIG_H
#define MLK_CONFIG_H

#ifndef MLK_CONFIG_PARAMETER_SET
#define MLK_CONFIG_PARAMETER_SET 768
#endif

#define MLK_CONFIG_NAMESPACE_PREFIX mlkem
#define MLK_CONFIG_MULTILEVEL_BUILD
#define MLK_CONFIG_NO_RANDOMIZED_API
#define MLK_CONFIG_NO_ASM

/* No memset_s or explicit_bzero on every target (the old Windows CRTs have neither): fg_pqc.c clears through a volatile pointer. */
#define MLK_CONFIG_CUSTOM_ZEROIZE
#define mlk_zeroize fg_pqc_zeroize

#endif /* MLK_CONFIG_H */
